import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bound } from './io.js';
import { spawnCapture } from './process.js';
import { prepareAgentSandbox } from './agent-sandbox.js';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const TURN_SCHEMA = path.resolve(SOURCE_DIR, '../schemas/turn.schema.json');

function visit(value, callback) {
  if (!value || typeof value !== 'object') return;
  callback(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  for (const item of Object.values(value)) visit(item, callback);
}

export function parseCodexJsonl(stdout) {
  let sessionId = null;
  let report = null;
  const eventTypes = [];
  const diagnostics = [];

  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event.type === 'string') eventTypes.push(event.type);
    visit(event, (node) => {
      const candidateId = node.thread_id || node.threadId || node.session_id || node.sessionId;
      if (!sessionId && typeof candidateId === 'string') sessionId = candidateId;

      const candidates = [node.text, node.content, node.output_text, node.final_output];
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && typeof parsed.status === 'string') report = parsed;
        } catch {
          // Most event text is not the structured final report.
        }
      }
      if ((node.type === 'error' || event.type === 'turn.failed') && typeof node.message === 'string') {
        diagnostics.push(bound(node.message, 2_000));
      }
    });
  }

  return { sessionId, report, eventTypes, diagnostics: [...new Set(diagnostics)].slice(0, 8) };
}

export function buildInitialPrompt(contract, state = null) {
  const preflight = state?.latestVerifier
    ? `\n\nExternal verifier preflight:\nexit=${state.latestVerifier.exitCode ?? 'unknown'} expected=${contract.completion.successExitCode}\n${bound(state.latestVerifier.output || 'No verifier output.', 6_000)}`
    : '';
  return `You are the execution engine inside OutcomeLoop. Work on the objective until tangible progress is made.\n\nObjective:\n${contract.objective}\n\nNon-negotiable constraints:\n${contract.constraints.map((item) => `- ${item}`).join('\n') || '- None supplied'}${preflight}\n\nThe external verifier is authoritative. Do not edit, bypass, weaken, mock, or replace it. Do not claim completion based only on your own assessment. Perform the highest-leverage safe action now, verify your work locally where possible, and return the required JSON report. Set gate to null unless status is owner_gate. Use owner_gate only when the next unavoidable action exactly matches one allowed gate: ${contract.allowedGates.join(', ') || 'none'}.`;
}

export function buildResumePrompt(contract, state) {
  const verifier = state.latestVerifier;
  const report = state.latestAgentReport;
  return `OutcomeLoop checked the external completion contract and it still fails. Resume the same objective and continue working; a status summary is not completion.\n\nObjective:\n${contract.objective}\n\nPrevious agent report:\n${bound(JSON.stringify(report || {}), 4_000)}\n\nVerifier result:\nexit=${verifier?.exitCode ?? 'unknown'} expected=${contract.completion.successExitCode}\n${bound(verifier?.output || 'No verifier output.', 6_000)}\n\nPerform the next concrete action. Preserve the constraints and return the required JSON report. Set gate to null unless status is owner_gate. Use owner_gate only when the next unavoidable action exactly matches one allowed gate: ${contract.allowedGates.join(', ') || 'none'}.`;
}

export function buildCodexArgs({ contract, sessionId, prompt }) {
  const common = [
    '--json',
    '--model',
    contract.model,
    '--output-schema',
    TURN_SCHEMA,
    '--skip-git-repo-check',
  ];
  if (!contract.loadExecPolicyRules) common.push('--ignore-rules');
  const invocation = [
    'exec',
    '--strict-config',
    '--cd', contract.workspace,
  ];
  return sessionId
    ? [...invocation, 'resume', ...common, sessionId, prompt]
    : [...invocation, ...common, prompt];
}

export async function runCodexTurn({ contract, sessionId, prompt, codexCommand = 'codex', timeoutMs }) {
  const sandbox = await prepareAgentSandbox(contract);
  const args = buildCodexArgs({ contract, sessionId, prompt });

  const result = await spawnCapture(codexCommand, args, {
    cwd: contract.workspace,
    timeoutMs: Math.max(1, Math.floor(timeoutMs ?? Math.min(contract.maxRuntimeMinutes * 60_000, 3_600_000))),
    maxOutput: 4_000_000,
    env: { ...process.env, CODEX_HOME: sandbox.codexHome, NO_COLOR: '1' },
  });
  const parsed = parseCodexJsonl(result.stdout);
  const stderr = bound(result.stderr, 8_000);
  const diagnostics = [...parsed.diagnostics];
  if (result.code !== 0 && stderr.trim()) diagnostics.push(stderr);
  if (result.timedOut) diagnostics.push('codex_turn_timed_out');
  return {
    ...result,
    ...parsed,
    diagnostics: [...new Set(diagnostics)].slice(0, 8),
    stdout: undefined,
    stderr,
  };
}
