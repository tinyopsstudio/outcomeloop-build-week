import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareAgentSandbox } from '../src/agent-sandbox.js';
import { spawnCapture } from '../src/process.js';

test('agent sandbox isolates Codex state, credentials, and inherited secrets', async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-agent-codex-'));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-agent-state-'));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-agent-workspace-'));
  await writeFile(path.join(codexHome, 'auth.json'), '{"test":"credential"}\n', { mode: 0o600 });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  process.env.OUTCOMELOOP_TEST_SECRET = 'must-not-be-in-profile';
  try {
    const sandbox = await prepareAgentSandbox({ stateDir, workspace, sandbox: 'workspace-write' });
    const content = await readFile(sandbox.configPath, 'utf8');
    assert.match(content, /":minimal" = "read"/);
    assert.equal(content.includes('":root" = "read"'), false);
    assert.equal(content.includes(`${JSON.stringify(workspace)} = "write"`), true);
    assert.equal(content.includes(`${JSON.stringify(stateDir)} = "deny"`), true);
    assert.match(content, /\.outcomeloop\/identity" = "deny"/);
    assert.match(content, /enabled = false/);
    assert.match(content, /inherit = "none"/);
    assert.equal(content.includes('must-not-be-in-profile'), false);
    assert.equal(await readFile(path.join(sandbox.codexHome, 'auth.json'), 'utf8'), '{"test":"credential"}\n');
    assert.equal((await stat(path.join(sandbox.codexHome, 'auth.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(sandbox.configPath)).mode & 0o777, 0o600);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    delete process.env.OUTCOMELOOP_TEST_SECRET;
  }
});

test('real agent sandbox permits workspace writes but denies controller files and network', {
  skip: process.env.OUTCOMELOOP_TEST_SANDBOX !== '1',
}, async () => {
  const sourceCodexHome = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-agent-source-'));
  const stateDir = await mkdtemp(path.join(os.homedir(), '.outcomeloop-agent-state-'));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-agent-workspace-'));
  const stateFile = path.join(stateDir, 'state.json');
  const marker = path.join(workspace, 'sandbox-workspace-write');
  const probe = path.join(workspace, 'probe.mjs');
  const previousCodexHome = process.env.CODEX_HOME;
  await writeFile(path.join(sourceCodexHome, 'auth.json'), '{"secret":"credential"}\n', { mode: 0o600 });
  await writeFile(stateFile, '{"secret":"controller"}\n', { mode: 0o600 });
  await writeFile(probe, `import { readFile, writeFile } from 'node:fs/promises';
const readable = {};
for (const [name, file] of [['config', process.argv[2]], ['auth', process.argv[3]], ['state', process.argv[4]]]) {
  try { await readFile(file); readable[name] = true; } catch { readable[name] = false; }
}
let networkAccessible = true;
let workspaceWritable = true;
try { await fetch('https://example.com', { signal: AbortSignal.timeout(1000) }); } catch { networkAccessible = false; }
try { await writeFile(process.argv[5], 'allowed'); } catch { workspaceWritable = false; }
process.stdout.write(JSON.stringify({ readable, networkAccessible, workspaceWritable }));
`);

  process.env.CODEX_HOME = sourceCodexHome;
  try {
    const sandbox = await prepareAgentSandbox({ stateDir, workspace, sandbox: 'workspace-write' });
    const result = await spawnCapture('codex', [
      'sandbox', '-P', 'outcomeloop-agent', '-C', workspace, '--',
      process.execPath, probe, sandbox.configPath, path.join(sandbox.codexHome, 'auth.json'), stateFile, marker,
    ], {
      cwd: workspace,
      env: { ...process.env, CODEX_HOME: sandbox.codexHome },
      timeoutMs: 10_000,
      maxOutput: 100_000,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      readable: { config: false, auth: false, state: false },
      networkAccessible: false,
      workspaceWritable: true,
    });
    await access(marker);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(sourceCodexHome, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
