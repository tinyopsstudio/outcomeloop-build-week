import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { appendJsonLine, bound, canonicalJson, readJson, redact, sha256, writeJsonAtomic } from './io.js';
import { buildInitialPrompt, buildResumePrompt, runCodexTurn } from './codex.js';
import {
  loadSigningIdentity,
  loadTrustedPublicKey,
  sealReceipt,
  verifyReceiptIntegrity,
  workspaceSnapshot,
} from './receipt.js';
import { protectedSnapshot } from './integrity.js';
import { pathContains } from './contract.js';
import { executeVerifierSandboxed } from './verifier-sandbox.js';

function pathsFor(contract) {
  return {
    state: path.join(contract.stateDir, 'state.json'),
    events: path.join(contract.stateDir, 'events.jsonl'),
    receipt: path.join(contract.stateDir, 'receipt.json'),
    handoff: path.join(contract.stateDir, 'owner-gate.json'),
    lock: path.join(contract.stateDir, 'run.lock'),
  };
}

async function withRunLock(lockPath, callback) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  let handle;
  for (let attempt = 0; attempt < 3 && !handle; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try {
        owner = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch {
        throw new Error(`contract_already_running:${lockPath}`);
      }
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (killError) {
        alive = killError.code !== 'ESRCH';
      }
      if (alive) throw new Error(`contract_already_running:${lockPath}`);
      const stalePath = `${lockPath}.stale-${token}`;
      try {
        await rename(lockPath, stalePath);
        await unlink(stalePath);
      } catch (renameError) {
        if (renameError.code !== 'ENOENT') throw renameError;
      }
    }
  }
  if (!handle) throw new Error(`contract_lock_unavailable:${lockPath}`);
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`);
  try {
    return await callback();
  } finally {
    await handle.close();
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8'));
      if (current.token === token) await unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function emit(paths, type, payload = {}) {
  await appendJsonLine(paths.events, { at: new Date().toISOString(), type, ...payload });
}

async function loadOrCreateState(contract, paths, initialProtection) {
  try {
    const state = await readJson(paths.state);
    if (state.contractHash !== contract.hash) throw new Error('contract_changed_after_run_started');
    state.elapsedMs = Number.isFinite(state.elapsedMs) ? Math.max(0, state.elapsedMs) : 0;
    state.elapsedBaseMs = state.elapsedMs;
    state.activeStartedAtMs = state.status === 'running' ? Date.now() : null;
    delete state.startedAtMs;
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const now = new Date().toISOString();
  const state = {
    version: 1,
    objective: bound(contract.objective, 4_000),
    status: 'running',
    contractHash: contract.hash,
    model: contract.model,
    workspace: contract.workspace,
    sessionId: null,
    iteration: 0,
    maxIterations: contract.maxIterations,
    createdAt: now,
    updatedAt: now,
    elapsedMs: 0,
    elapsedBaseMs: 0,
    activeStartedAtMs: Date.now(),
    latestAgentReport: null,
    latestVerifier: null,
    protectedFiles: initialProtection,
  };
  await writeJsonAtomic(paths.state, state);
  await emit(paths, 'run_started', { model: contract.model, objective: bound(contract.objective, 4_000) });
  return state;
}

function elapsedNow(state, now = Date.now()) {
  const base = Number.isFinite(state.elapsedBaseMs) ? state.elapsedBaseMs : (state.elapsedMs || 0);
  return state.activeStartedAtMs === null || state.activeStartedAtMs === undefined
    ? Math.max(0, state.elapsedMs || base)
    : Math.max(0, base + now - state.activeStartedAtMs);
}

function pauseClock(state) {
  state.elapsedMs = elapsedNow(state);
  state.elapsedBaseMs = state.elapsedMs;
  state.activeStartedAtMs = null;
}

function resumeClock(state) {
  if (state.activeStartedAtMs !== null && state.activeStartedAtMs !== undefined) return;
  state.elapsedBaseMs = Math.max(0, state.elapsedMs || 0);
  state.activeStartedAtMs = Date.now();
}

async function persist(paths, state) {
  state.updatedAt = new Date().toISOString();
  state.elapsedMs = elapsedNow(state);
  await writeJsonAtomic(paths.state, state);
}

async function stopWith(paths, state, status, eventType, payload = {}) {
  state.status = status;
  pauseClock(state);
  await emit(paths, eventType, payload);
  await persist(paths, state);
  return { state, paths };
}

async function checkProtection(contract, paths, state, iteration, phase) {
  let snapshot;
  try {
    snapshot = await protectedSnapshot(contract.protectedPaths);
  } catch (error) {
    return {
      result: await stopWith(paths, state, 'integrity_violation', 'integrity_violation', {
        iteration,
        phase,
        expectedFingerprint: state.protectedFiles.fingerprint,
        actualFingerprint: null,
        error: bound(error.message, 1_200),
      }),
    };
  }
  if (snapshot.fingerprint !== state.protectedFiles.fingerprint) {
    return {
      result: await stopWith(paths, state, 'integrity_violation', 'integrity_violation', {
        iteration,
        phase,
        expectedFingerprint: state.protectedFiles.fingerprint,
        actualFingerprint: snapshot.fingerprint,
      }),
    };
  }
  return { snapshot };
}

export async function runVerifier(contract, options = {}) {
  const result = await (options.executeVerifier || executeVerifierSandboxed)(contract, {
    codexCommand: options.codexCommand,
    timeoutMs: Math.max(1, Math.min(contract.completion.timeoutMs, options.timeoutMs ?? contract.completion.timeoutMs)),
    maxOutput: 1_000_000,
  });
  const rawOutput = result.output ?? `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
  const exitCode = Number.isInteger(result.code) ? result.code : null;
  const signal = typeof result.signal === 'string' ? result.signal : null;
  return {
    commandHash: sha256(canonicalJson(contract.completion.command)),
    exitCode,
    expectedExitCode: contract.completion.successExitCode,
    passed: !result.timedOut && signal === null && exitCode === contract.completion.successExitCode,
    signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    outputHash: sha256(rawOutput),
    output: bound(rawOutput, 16_000),
  };
}

function normalizeVerifier(contract, result = {}) {
  const rawOutput = String(result.output ?? '');
  const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
  const signal = typeof result.signal === 'string' ? result.signal : null;
  const timedOut = Boolean(result.timedOut);
  return {
    commandHash: typeof result.commandHash === 'string'
      ? result.commandHash
      : sha256(canonicalJson(contract.completion.command)),
    exitCode,
    expectedExitCode: contract.completion.successExitCode,
    passed: !timedOut && signal === null && exitCode === contract.completion.successExitCode,
    signal,
    timedOut,
    durationMs: Number.isFinite(result.durationMs) ? Math.max(0, result.durationMs) : 0,
    outputHash: typeof result.outputHash === 'string' && /^[a-f0-9]{64}$/i.test(result.outputHash)
      ? result.outputHash
      : sha256(rawOutput),
    output: bound(rawOutput, 16_000),
  };
}

async function invokeVerifier(contract, options, timeoutMs) {
  const result = await (options.runVerifier || runVerifier)(contract, {
    timeoutMs: Math.min(contract.completion.timeoutMs, timeoutMs),
    codexCommand: options.codexCommand,
  });
  return normalizeVerifier(contract, result);
}

async function sealVerified(contract, paths, state, options) {
  const signingIdentity = options.signingIdentity || await loadSigningIdentity();
  const workspace = await workspaceSnapshot(contract.workspace);
  const receipt = sealReceipt({
    version: 1,
    status: 'verified',
    objective: bound(contract.objective, 4_000),
    contractHash: contract.hash,
    model: contract.model,
    codexSessionId: state.sessionId,
    iterations: state.iteration,
    elapsedMs: elapsedNow(state),
    verifiedAt: new Date().toISOString(),
    verifier: state.latestVerifier,
    protectedFiles: state.protectedFiles,
    workspace,
  }, signingIdentity);
  state.status = 'verified';
  pauseClock(state);
  await writeJsonAtomic(paths.receipt, receipt);
  await emit(paths, 'outcome_verified', { receiptHash: receipt.receiptHash, keyId: receipt.seal.keyId });
  await persist(paths, state);
  return { state, paths, receipt };
}

function safeText(value, limit) {
  return redact(String(value ?? '')).slice(0, limit);
}

function normalizeReport(report, codexResult) {
  const normalized = report && ['progress', 'claimed_complete', 'owner_gate'].includes(report.status)
    ? report
    : {
    status: 'progress',
    summary: codexResult.code === 0 ? 'Codex returned without a structured report.' : `Codex exited with code ${codexResult.code}.`,
    next_action: 'Resume from durable state and continue toward the objective.',
    evidence: [],
    gate: null,
  };
  const gate = normalized.gate && typeof normalized.gate === 'object'
    ? {
      type: safeText(normalized.gate.type, 80),
      reason: safeText(normalized.gate.reason, 800),
      owner_action: safeText(normalized.gate.owner_action, 800),
    }
    : null;
  return {
    status: normalized.status,
    summary: safeText(normalized.summary, 1_200),
    next_action: safeText(normalized.next_action, 1_200),
    evidence: Array.isArray(normalized.evidence)
      ? normalized.evidence.slice(0, 12).map((item) => ({
        claim: safeText(item?.claim, 500),
        source: safeText(item?.source, 500),
      }))
      : [],
    gate,
  };
}

function allowedGate(contract, report) {
  return report.status === 'owner_gate'
    && report.gate
    && contract.allowedGates.includes(report.gate.type);
}

function validateRuntimeBoundary(contract) {
  if (pathContains(contract.workspace, contract.stateDir)) {
    throw new Error('invalid_contract:state_dir_must_be_outside_workspace');
  }
  if (contract.protectedPaths.some((protectedPath) => pathContains(protectedPath, contract.stateDir))) {
    throw new Error('invalid_contract:state_dir_overlaps_protected_path');
  }
  if (contract.sandbox === 'workspace-write' && contract.protectedPaths.some((protectedPath) => (
    protectedPath !== contract.contractPath
      && (pathContains(contract.workspace, protectedPath) || pathContains(os.tmpdir(), protectedPath))
  ))) {
    throw new Error('invalid_contract:protected_path_inside_task_writable_root');
  }
}

export async function runOutcomeLoop(contract, options = {}) {
  validateRuntimeBoundary(contract);
  const paths = pathsFor(contract);
  return withRunLock(paths.lock, () => runOutcomeLoopUnlocked(contract, options, paths));
}

async function runOutcomeLoopUnlocked(contract, options, paths) {
  let initialProtection;
  try {
    initialProtection = await protectedSnapshot(contract.protectedPaths);
  } catch (error) {
    try {
      const existingState = await readJson(paths.state);
      if (existingState.contractHash === contract.hash) {
        return stopWith(paths, existingState, 'integrity_violation', 'integrity_violation', {
          iteration: existingState.iteration,
          phase: 'between_runs',
          expectedFingerprint: existingState.protectedFiles?.fingerprint || null,
          actualFingerprint: null,
          error: bound(error.message, 1_200),
        });
      }
    } catch {
      // No trusted state exists yet, so this is an invalid initial contract.
    }
    throw error;
  }
  const state = await loadOrCreateState(contract, paths, initialProtection);
  if (state.protectedFiles?.fingerprint !== initialProtection.fingerprint) {
    return stopWith(paths, state, 'integrity_violation', 'integrity_violation', {
      iteration: state.iteration,
      phase: 'between_runs',
      expectedFingerprint: state.protectedFiles?.fingerprint || null,
      actualFingerprint: initialProtection.fingerprint,
    });
  }
  if (state.status === 'verified') {
    try {
      const receipt = await readJson(paths.receipt);
      const trustedPublicKey = (await loadTrustedPublicKey()).publicKey;
      const valid = verifyReceiptIntegrity(receipt, trustedPublicKey)
        && receipt.contractHash === contract.hash
        && receipt.protectedFiles?.fingerprint === initialProtection.fingerprint;
      if (valid) return { state, paths, receipt };
    } catch {
      // A verified state without its trusted receipt is an integrity failure.
    }
    return stopWith(paths, state, 'integrity_violation', 'integrity_violation', {
      iteration: state.iteration,
      phase: 'verified_receipt_reload',
      error: 'stored_receipt_invalid_or_missing',
    });
  }
  if (state.status === 'integrity_violation') return { state, paths };
  if (state.status === 'paused_gate' && !options.resumeGate) return { state, paths };
  if (state.status === 'configuration_error') {
    await emit(paths, 'configuration_retry_started', { iteration: state.iteration });
  }
  resumeClock(state);
  state.status = 'running';
  const remainingRuntimeMs = Math.max(0, contract.maxRuntimeMinutes * 60_000 - elapsedNow(state));
  const deadlineMs = Date.now() + remainingRuntimeMs;

  const preflightBudgetMs = Math.floor(deadlineMs - Date.now());
  if (preflightBudgetMs > 0) {
    try {
      state.latestVerifier = await invokeVerifier(contract, options, preflightBudgetMs);
    } catch (error) {
      return stopWith(paths, state, 'configuration_error', 'configuration_error', {
        iteration: state.iteration,
        phase: 'preflight',
        diagnostics: [bound(error.message, 2_000)],
      });
    }
    await emit(paths, 'verifier_preflight_finished', {
      iteration: state.iteration,
      passed: state.latestVerifier.passed,
      exitCode: state.latestVerifier.exitCode,
      durationMs: state.latestVerifier.durationMs,
      outputHash: state.latestVerifier.outputHash,
      output: bound(state.latestVerifier.output || '', 1_200),
    });
    const afterPreflightProtection = await checkProtection(contract, paths, state, state.iteration, 'after_preflight');
    if (afterPreflightProtection.result) return afterPreflightProtection.result;
    if (Date.now() < deadlineMs && state.latestVerifier.passed) {
      return sealVerified(contract, paths, state, options);
    }
    await persist(paths, state);
  }

  while (state.iteration < contract.maxIterations) {
    const turnBudgetMs = Math.floor(deadlineMs - Date.now());
    if (turnBudgetMs <= 0) break;

    state.iteration += 1;
    await persist(paths, state);
    await emit(paths, 'codex_turn_started', { iteration: state.iteration, resumed: Boolean(state.sessionId) });

    const prompt = state.sessionId
      ? buildResumePrompt(contract, state)
      : buildInitialPrompt(contract, state);
    let codexResult;
    try {
      codexResult = await (options.runCodexTurn || runCodexTurn)({
        contract,
        sessionId: state.sessionId,
        prompt,
        codexCommand: options.codexCommand,
        timeoutMs: turnBudgetMs,
      });
    } catch (error) {
      state.iteration = Math.max(0, state.iteration - 1);
      return stopWith(paths, state, 'configuration_error', 'configuration_error', {
        iteration: state.iteration,
        diagnostics: [bound(error.message, 2_000)],
      });
    }
    state.sessionId = codexResult.sessionId ? safeText(codexResult.sessionId, 200) : state.sessionId;
    state.latestAgentReport = normalizeReport(codexResult.report, codexResult);
    await emit(paths, 'codex_turn_finished', {
      iteration: state.iteration,
      exitCode: codexResult.code,
      durationMs: codexResult.durationMs,
      reportStatus: state.latestAgentReport.status,
      reportSummary: bound(state.latestAgentReport.summary || '', 1_200),
      nextAction: bound(state.latestAgentReport.next_action || '', 1_200),
      eventTypes: [...new Set(codexResult.eventTypes || [])].slice(0, 20).map((item) => safeText(item, 120)),
      diagnostics: (codexResult.diagnostics || []).slice(0, 4).map((item) => bound(item, 2_000)),
    });

    const afterTurnProtection = await checkProtection(contract, paths, state, state.iteration, 'after_codex_turn');
    if (afterTurnProtection.result) return afterTurnProtection.result;

    const fatalConfigurationError = (codexResult.diagnostics || []).some((message) =>
      /model.+not supported|invalid_request_error|unknown option|unexpected argument|failed to read output schema|output schema.+(?:invalid|missing)|no such file or directory/i.test(message),
    );
    if (fatalConfigurationError) {
      const attemptedIteration = state.iteration;
      state.iteration = Math.max(0, state.iteration - 1);
      return stopWith(paths, state, 'configuration_error', 'configuration_error', {
        iteration: attemptedIteration,
        diagnostics: codexResult.diagnostics.slice(0, 4).map((item) => bound(item, 2_000)),
      });
    }

    const verifierBudgetMs = Math.floor(deadlineMs - Date.now());
    if (verifierBudgetMs <= 0) break;
    try {
      state.latestVerifier = await invokeVerifier(contract, options, verifierBudgetMs);
    } catch (error) {
      return stopWith(paths, state, 'configuration_error', 'configuration_error', {
        iteration: state.iteration,
        diagnostics: [bound(error.message, 2_000)],
      });
    }
    await emit(paths, 'verifier_finished', {
      iteration: state.iteration,
      passed: state.latestVerifier.passed,
      exitCode: state.latestVerifier.exitCode,
      durationMs: state.latestVerifier.durationMs,
      outputHash: state.latestVerifier.outputHash,
      output: bound(state.latestVerifier.output || '', 1_200),
    });

    const afterVerifierProtection = await checkProtection(contract, paths, state, state.iteration, 'after_verifier');
    if (afterVerifierProtection.result) return afterVerifierProtection.result;

    if (Date.now() >= deadlineMs) break;

    if (state.latestVerifier.passed) {
      return sealVerified(contract, paths, state, options);
    }

    if (state.latestAgentReport.status === 'owner_gate') {
      if (allowedGate(contract, state.latestAgentReport)) {
        state.status = 'paused_gate';
        pauseClock(state);
        await writeJsonAtomic(paths.handoff, {
          version: 1,
          objective: bound(contract.objective, 4_000),
          iteration: state.iteration,
          gate: state.latestAgentReport.gate,
          createdAt: new Date().toISOString(),
        });
        await emit(paths, 'owner_gate_paused', { gate: state.latestAgentReport.gate });
        await persist(paths, state);
        return { state, paths };
      }
      await emit(paths, 'invalid_gate_rejected', { gate: state.latestAgentReport.gate || null });
      state.latestAgentReport = {
        ...state.latestAgentReport,
        status: 'progress',
        summary: 'The requested gate was outside the contract and was rejected.',
      };
    }

    await persist(paths, state);
  }

  state.status = 'exhausted';
  pauseClock(state);
  await emit(paths, 'run_exhausted', {
    iterations: state.iteration,
    elapsedMs: state.elapsedMs,
  });
  await persist(paths, state);
  return { state, paths };
}
