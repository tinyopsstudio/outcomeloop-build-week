import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTrustedPublicKey, verifyReceiptIntegrity } from '../src/receipt.js';
import { runOutcomeLoop, runVerifier } from '../src/runner.js';

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-data', 'runner');

async function contract(overrides = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-run-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-state-'));
  return {
    version: 1,
    objective: 'Produce a verified result',
    workspace,
    model: 'gpt-5.6-terra',
    sandbox: 'workspace-write',
    maxIterations: 4,
    maxRuntimeMinutes: 5,
    constraints: ['Do not edit the verifier.'],
    allowedGates: ['captcha'],
    protectedPaths: [],
    loadExecPolicyRules: true,
    completion: { command: ['true'], successExitCode: 0, timeoutMs: 1_000 },
    stateDir,
    hash: 'a'.repeat(64),
    ...overrides,
  };
}

async function protectedFixtureDir() {
  await mkdir(TEST_ROOT, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(TEST_ROOT, 'case-'));
}

test('runner resumes until external verifier passes and seals receipt', async () => {
  const config = await contract();
  let turns = 0;
  let checks = 0;
  const result = await runOutcomeLoop(config, {
    runCodexTurn: async ({ sessionId }) => {
      turns += 1;
      return {
        code: 0,
        durationMs: 5,
        sessionId: sessionId || 'session-verified',
        eventTypes: ['thread.started', 'turn.completed'],
        report: {
          status: turns === 1 ? 'claimed_complete' : 'progress',
          summary: 'Work performed.',
          next_action: 'Continue.',
          evidence: [],
        },
      };
    },
    runVerifier: async () => {
      checks += 1;
      return {
        command: ['true'],
        exitCode: checks < 3 ? 1 : 0,
        expectedExitCode: 0,
        passed: checks >= 3,
        timedOut: false,
        durationMs: 2,
        outputHash: String(checks).padStart(64, '0'),
        output: checks < 3 ? 'still failing' : 'passed',
      };
    },
  });

  assert.equal(result.state.status, 'verified');
  assert.equal(result.state.iteration, 2);
  assert.equal(turns, 2);
  assert.equal(result.receipt.codexSessionId, 'session-verified');
  assert.equal(verifyReceiptIntegrity(result.receipt, (await loadTrustedPublicKey()).publicKey), true);
});

test('runner rejects verifier mutation before checking completion', async () => {
  const config = await contract();
  const verifierPath = path.join(await protectedFixtureDir(), 'verify.js');
  await writeFile(verifierPath, 'process.exit(1);\n');
  config.protectedPaths = [verifierPath];
  let verifierRuns = 0;
  const result = await runOutcomeLoop(config, {
    runCodexTurn: async () => {
      await writeFile(verifierPath, 'process.exit(0);\n');
      return {
        code: 0,
        durationMs: 2,
        sessionId: 'session-integrity',
        eventTypes: [],
        report: { status: 'claimed_complete', summary: 'Done.', next_action: 'None.', evidence: [] },
      };
    },
    runVerifier: async () => {
      verifierRuns += 1;
      return { passed: true };
    },
  });
  assert.equal(result.state.status, 'integrity_violation');
  assert.equal(verifierRuns, 1);
});

test('runner records deleted protected files as integrity violations', async () => {
  const config = await contract();
  const verifierPath = path.join(await protectedFixtureDir(), 'verify.js');
  await writeFile(verifierPath, 'process.exit(1);\n');
  config.protectedPaths = [verifierPath];
  let verifierRuns = 0;
  const result = await runOutcomeLoop(config, {
    runCodexTurn: async () => {
      await unlink(verifierPath);
      return {
        code: 0,
        durationMs: 2,
        sessionId: 'session-delete',
        eventTypes: [],
        report: { status: 'claimed_complete', summary: 'Done.', next_action: 'None.', evidence: [] },
      };
    },
    runVerifier: async () => {
      verifierRuns += 1;
      return { passed: true };
    },
  });
  assert.equal(result.state.status, 'integrity_violation');
  assert.equal(verifierRuns, 1);
});

test('integrity violations remain terminal after the protected file is restored', async () => {
  const config = await contract({ maxIterations: 1 });
  const verifierPath = path.join(await protectedFixtureDir(), 'verify.js');
  await writeFile(verifierPath, 'baseline\n');
  config.protectedPaths = [verifierPath];
  const failingVerifier = async () => ({
    commandHash: '1'.repeat(64), exitCode: 1, expectedExitCode: 0, passed: false,
    timedOut: false, durationMs: 1, outputHash: '2'.repeat(64), output: 'not complete',
  });
  const first = await runOutcomeLoop(config, {
    runCodexTurn: async () => {
      await writeFile(verifierPath, 'tampered\n');
      return {
        code: 0, durationMs: 1, sessionId: 'session-terminal', eventTypes: [], diagnostics: [],
        report: { status: 'progress', summary: 'Changed.', next_action: 'Continue.', evidence: [], gate: null },
      };
    },
    runVerifier: failingVerifier,
  });
  assert.equal(first.state.status, 'integrity_violation');

  await writeFile(verifierPath, 'baseline\n');
  let resumedTurns = 0;
  const second = await runOutcomeLoop(config, {
    runCodexTurn: async () => { resumedTurns += 1; },
    runVerifier: failingVerifier,
  });
  assert.equal(second.state.status, 'integrity_violation');
  assert.equal(resumedTurns, 0);
});

test('runner does not accept verifier success after the runtime deadline', async () => {
  const config = await contract({ maxIterations: 1, maxRuntimeMinutes: 0.0001 });
  let verifierRuns = 0;
  const result = await runOutcomeLoop(config, {
    runCodexTurn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        code: 0,
        durationMs: 20,
        sessionId: 'session-deadline',
        eventTypes: [],
        report: { status: 'claimed_complete', summary: 'Done.', next_action: 'None.', evidence: [] },
      };
    },
    runVerifier: async () => {
      verifierRuns += 1;
      return { passed: true };
    },
  });
  assert.equal(result.state.status, 'exhausted');
  assert.equal(verifierRuns, 1);
});

test('runner maps Codex stderr configuration errors to configuration_error', async () => {
  const config = await contract();
  let verifierRuns = 0;
  const result = await runOutcomeLoop(config, {
    runCodexTurn: async () => ({
      code: 1,
      durationMs: 2,
      sessionId: null,
      eventTypes: [],
      diagnostics: ['Failed to read output schema file: No such file or directory'],
      report: null,
    }),
    runVerifier: async () => {
      verifierRuns += 1;
      return { passed: true };
    },
  });
  assert.equal(result.state.status, 'configuration_error');
  assert.equal(verifierRuns, 1);
});

test('timed-out verifier never passes even when success exit code is 124', async () => {
  const config = await contract({
    completion: {
      command: [process.execPath, '-e', 'setTimeout(() => {}, 1000)'],
      successExitCode: 124,
      timeoutMs: 500,
    },
  });
  const result = await runVerifier(config, {
    timeoutMs: 20,
    executeVerifier: async () => ({
      code: 124,
      signal: null,
      timedOut: true,
      durationMs: 20,
      output: 'timed out',
    }),
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.equal(result.passed, false);
});

test('signaled verifier never passes when the configured success code is one', async () => {
  const config = await contract({
    completion: { command: ['false'], successExitCode: 1, timeoutMs: 500 },
  });
  const result = await runVerifier(config, {
    executeVerifier: async () => ({
      code: null,
      signal: 'SIGTERM',
      timedOut: false,
      durationMs: 1,
      output: 'terminated',
    }),
  });
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.passed, false);
});

test('runner redacts every agent-controlled report field before persistence', async () => {
  const config = await contract({ maxIterations: 1 });
  const verifierToken = ['sk', 'verifiersecret123456'].join('-');
  const result = await runOutcomeLoop(config, {
    runCodexTurn: async () => ({
      code: 0,
      durationMs: 2,
      sessionId: 'session-redaction',
      eventTypes: [],
      diagnostics: [],
      report: {
        status: 'owner_gate',
        summary: 'password=hunter2',
        next_action: 'Authorization: Bearer abc123',
        evidence: [{ claim: 'api_key=secretvalue', source: 'password=sourcevalue' }],
        gate: {
          type: 'captcha',
          reason: 'password=reasonvalue',
          owner_action: 'Authorization: Bearer ownervalue',
        },
      },
    }),
    runVerifier: async () => ({
      commandHash: 'd'.repeat(64), exitCode: 1, expectedExitCode: 0, passed: false,
      timedOut: false, durationMs: 1, outputHash: 'e'.repeat(64),
      output: `{"password":"verifiersecret"} ${verifierToken}`,
    }),
  });
  const persisted = `${await readFile(result.paths.state, 'utf8')}\n${await readFile(result.paths.handoff, 'utf8')}`;
  for (const secret of ['hunter2', 'abc123', 'secretvalue', 'sourcevalue', 'reasonvalue', 'ownervalue', 'verifiersecret', verifierToken]) {
    assert.equal(persisted.includes(secret), false);
  }
  assert.match(persisted, /\[REDACTED\]/);
});

test('runner seals an already-satisfied contract before starting Codex', async () => {
  const config = await contract({ maxIterations: 1 });
  let turns = 0;
  const result = await runOutcomeLoop(config, {
    runCodexTurn: async () => { turns += 1; },
    runVerifier: async () => ({
      commandHash: '3'.repeat(64), exitCode: 0, expectedExitCode: 0, passed: true,
      timedOut: false, durationMs: 1, outputHash: '4'.repeat(64), output: 'already complete',
    }),
  });
  assert.equal(result.state.status, 'verified');
  assert.equal(result.state.iteration, 0);
  assert.equal(turns, 0);
  const rerun = await runOutcomeLoop(config, {
    runCodexTurn: async () => { throw new Error('must_not_run'); },
    runVerifier: async () => { throw new Error('must_not_verify'); },
  });
  assert.equal(rerun.state.status, 'verified');
  assert.equal(rerun.receipt.receiptHash, result.receipt.receiptHash);
});

test('runner serializes concurrent invocations for the same contract', async () => {
  const config = await contract({ maxIterations: 1 });
  let releaseTurn;
  let markTurnStarted;
  const turnStarted = new Promise((resolve) => { markTurnStarted = resolve; });
  const turnRelease = new Promise((resolve) => { releaseTurn = resolve; });
  const failingVerifier = async () => ({
    commandHash: '5'.repeat(64), exitCode: 1, expectedExitCode: 0, passed: false,
    timedOut: false, durationMs: 1, outputHash: '6'.repeat(64), output: 'not complete',
  });
  const firstRun = runOutcomeLoop(config, {
    runVerifier: failingVerifier,
    runCodexTurn: async () => {
      markTurnStarted();
      await turnRelease;
      return {
        code: 0, durationMs: 1, sessionId: 'session-lock', eventTypes: [], diagnostics: [],
        report: { status: 'progress', summary: 'Worked.', next_action: 'Continue.', evidence: [], gate: null },
      };
    },
  });
  await turnStarted;
  await assert.rejects(runOutcomeLoop(config, {
    runVerifier: failingVerifier,
    runCodexTurn: async () => { throw new Error('must_not_run'); },
  }), /contract_already_running/);
  releaseTurn();
  assert.equal((await firstRun).state.status, 'exhausted');
});

test('runner seals a verified result when Git is not installed', async () => {
  const config = await contract({ maxIterations: 1 });
  const originalPath = process.env.PATH;
  process.env.PATH = '/definitely/no/git';
  try {
    const result = await runOutcomeLoop(config, {
      runCodexTurn: async () => ({
        code: 0,
        durationMs: 2,
        sessionId: 'session-no-git',
        eventTypes: [],
        diagnostics: [],
        report: { status: 'claimed_complete', summary: 'Done.', next_action: 'None.', evidence: [], gate: null },
      }),
      runVerifier: async () => ({
        commandHash: 'f'.repeat(64), exitCode: 0, expectedExitCode: 0, passed: true,
        timedOut: false, durationMs: 1, outputHash: 'a'.repeat(64), output: 'passed',
      }),
    });
    assert.equal(result.state.status, 'verified');
    assert.equal(verifyReceiptIntegrity(result.receipt, (await loadTrustedPublicKey()).publicKey), true);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('runner pauses only for an allowed owner gate', async () => {
  const config = await contract();
  const result = await runOutcomeLoop(config, {
    runCodexTurn: async () => ({
      code: 0,
      durationMs: 3,
      sessionId: 'session-gate',
      eventTypes: [],
      report: {
        status: 'owner_gate',
        summary: 'A CAPTCHA is unavoidable.',
        next_action: 'Owner clears challenge.',
        evidence: [],
        gate: { type: 'captcha', reason: 'Site challenge', owner_action: 'Complete the CAPTCHA.' },
      },
    }),
    runVerifier: async () => ({
      command: ['false'], exitCode: 1, expectedExitCode: 0, passed: false,
      timedOut: false, durationMs: 1, outputHash: 'b'.repeat(64), output: 'not complete',
    }),
  });
  assert.equal(result.state.status, 'paused_gate');
  assert.equal(result.state.iteration, 1);
});

test('runner retries a corrected Codex configuration without deleting state', async () => {
  const config = await contract({ maxIterations: 1 });
  const failingVerifier = async () => ({
    commandHash: '1'.repeat(64), exitCode: 1, expectedExitCode: 0, passed: false,
    signal: null, timedOut: false, durationMs: 1, outputHash: '2'.repeat(64), output: 'not complete',
  });
  const first = await runOutcomeLoop(config, {
    runVerifier: failingVerifier,
    runCodexTurn: async () => { throw new Error('spawn /bad/path ENOENT'); },
  });
  assert.equal(first.state.status, 'configuration_error');
  assert.equal(first.state.iteration, 0);

  let checks = 0;
  const second = await runOutcomeLoop(config, {
    runCodexTurn: async () => ({
      code: 0, durationMs: 1, sessionId: 'session-recovered', eventTypes: [], diagnostics: [],
      report: { status: 'claimed_complete', summary: 'Done.', next_action: 'Verify.', evidence: [], gate: null },
    }),
    runVerifier: async () => {
      checks += 1;
      return {
        commandHash: '3'.repeat(64), exitCode: checks === 1 ? 1 : 0, expectedExitCode: 0,
        passed: checks > 1, signal: null, timedOut: false, durationMs: 1,
        outputHash: '4'.repeat(64), output: checks === 1 ? 'not complete' : 'passed',
      };
    },
  });
  assert.equal(second.state.status, 'verified');
  assert.equal(second.state.iteration, 1);
  assert.equal(second.receipt.codexSessionId, 'session-recovered');
});

test('gate resume preserves elapsed active time from before the pause', async () => {
  const config = await contract({ maxIterations: 2 });
  const failingVerifier = async () => ({
    commandHash: '5'.repeat(64), exitCode: 1, expectedExitCode: 0, passed: false,
    signal: null, timedOut: false, durationMs: 1, outputHash: '6'.repeat(64), output: 'not complete',
  });
  const first = await runOutcomeLoop(config, {
    runVerifier: failingVerifier,
    runCodexTurn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        code: 0, durationMs: 25, sessionId: 'session-gate-time', eventTypes: [], diagnostics: [],
        report: {
          status: 'owner_gate', summary: 'CAPTCHA required.', next_action: 'Clear it.', evidence: [],
          gate: { type: 'captcha', reason: 'Challenge', owner_action: 'Complete the CAPTCHA.' },
        },
      };
    },
  });
  assert.equal(first.state.status, 'paused_gate');
  assert.equal(first.state.activeStartedAtMs, null);
  const beforePause = first.state.elapsedMs;
  assert.ok(beforePause >= 20);

  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await runOutcomeLoop(config, {
    resumeGate: true,
    runCodexTurn: async () => { throw new Error('must_not_run'); },
    runVerifier: async () => ({
      commandHash: '7'.repeat(64), exitCode: 0, expectedExitCode: 0, passed: true,
      signal: null, timedOut: false, durationMs: 1, outputHash: '8'.repeat(64), output: 'passed',
    }),
  });
  assert.equal(second.state.status, 'verified');
  assert.ok(second.receipt.elapsedMs >= beforePause);
});

test('runner rejects invented gates and continues', async () => {
  const config = await contract({ maxIterations: 2 });
  let turns = 0;
  const result = await runOutcomeLoop(config, {
    runCodexTurn: async () => {
      turns += 1;
      return {
        code: 0,
        durationMs: 2,
        sessionId: 'session-reject',
        eventTypes: [],
        report: {
          status: 'owner_gate',
          summary: 'I would prefer approval.',
          next_action: 'Ask owner.',
          evidence: [],
          gate: { type: 'preference', reason: 'Uncertainty', owner_action: 'Approve routine work.' },
        },
      };
    },
    runVerifier: async () => ({
      command: ['false'], exitCode: 1, expectedExitCode: 0, passed: false,
      timedOut: false, durationMs: 1, outputHash: 'c'.repeat(64), output: 'not complete',
    }),
  });
  assert.equal(result.state.status, 'exhausted');
  assert.equal(turns, 2);
});
