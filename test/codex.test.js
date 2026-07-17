import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexArgs, parseCodexJsonl } from '../src/codex.js';

test('parseCodexJsonl extracts session and structured report', () => {
  const output = [
    JSON.stringify({ type: 'thread.started', thread_id: 'session-123' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({
      status: 'progress',
      summary: 'Changed the implementation.',
      next_action: 'Run the verifier.',
      evidence: [],
    }) } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
  const parsed = parseCodexJsonl(output);
  assert.equal(parsed.sessionId, 'session-123');
  assert.equal(parsed.report.status, 'progress');
  assert.deepEqual(parsed.eventTypes, ['thread.started', 'item.completed', 'turn.completed']);
});

test('parseCodexJsonl ignores non-JSON noise', () => {
  const parsed = parseCodexJsonl('warning\n{"type":"turn.completed"}\n');
  assert.equal(parsed.report, null);
  assert.equal(parsed.sessionId, null);
});

test('parseCodexJsonl preserves bounded error diagnostics', () => {
  const parsed = parseCodexJsonl(`${JSON.stringify({
    type: 'turn.failed',
    error: { message: "The 'gpt-5.6' model is not supported." },
  })}\n`);
  assert.deepEqual(parsed.diagnostics, ["The 'gpt-5.6' model is not supported."]);
});

test('Codex arguments allow standalone non-Git workspaces on initial and resumed turns', () => {
  const contract = {
    model: 'gpt-5.6-terra',
    sandbox: 'workspace-write',
    workspace: '/standalone',
    loadExecPolicyRules: true,
  };
  const initial = buildCodexArgs({ contract, sessionId: null, prompt: 'start' });
  const resumed = buildCodexArgs({ contract, sessionId: 'session-1', prompt: 'continue' });
  assert.equal(initial.includes('--skip-git-repo-check'), true);
  assert.equal(resumed.includes('--skip-git-repo-check'), true);
  assert.equal(initial.includes('--strict-config'), true);
  assert.equal(initial.includes('--ignore-user-config'), false);
  assert.equal(initial.includes('--profile'), false);
  assert.equal(initial.includes('--sandbox'), false);
  assert.ok(resumed.indexOf('--cd') < resumed.indexOf('resume'));
});
