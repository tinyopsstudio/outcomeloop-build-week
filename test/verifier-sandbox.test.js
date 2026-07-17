import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadSigningIdentity } from '../src/receipt.js';
import { runVerifier } from '../src/runner.js';
import { extractVerifierStatus, formatVerifierStatus } from '../src/verifier-protocol.js';

test('verifier status accepts only an authenticated launcher result', () => {
  const key = 'a'.repeat(64);
  const valid = formatVerifierStatus({ code: 0, signal: null, launchError: null }, key);
  const forged = formatVerifierStatus({ code: 0, signal: null, launchError: null }, 'b'.repeat(64));
  assert.equal(extractVerifierStatus(`attacker output\n${forged}`, key).status, null);
  assert.deepEqual(extractVerifierStatus(`attacker output\n${forged}\n${valid}`, key).status, {
    code: 0,
    signal: null,
    launchError: null,
  });
});

test('real verifier sandbox denies the signing identity and unrelated writes', {
  skip: process.env.OUTCOMELOOP_TEST_SANDBOX !== '1',
}, async () => {
  await loadSigningIdentity();
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-sandbox-workspace-'));
  const stateDir = await mkdtemp(path.join(os.homedir(), '.outcomeloop-sandbox-state-'));
  const probe = path.join(workspace, 'probe.mjs');
  const privateKey = path.join(os.homedir(), '.outcomeloop', 'identity', 'ed25519-private.pem');
  const forbiddenMarker = path.join(os.homedir(), '.outcomeloop', 'identity', 'sandbox-write-marker');
  await rm(forbiddenMarker, { force: true });
  await writeFile(probe, `import { readFile, writeFile } from 'node:fs/promises';\nlet identityReadable = true;\nlet identityWritable = true;\nlet networkAccessible = true;\nlet workspaceWritable = true;\ntry { await readFile(process.argv[2]); } catch { identityReadable = false; }\ntry { await writeFile(process.argv[3], 'unsafe'); } catch { identityWritable = false; }\ntry { await fetch('https://example.com', { signal: AbortSignal.timeout(1000) }); } catch { networkAccessible = false; }\ntry { await writeFile('sandbox-workspace-write', 'allowed'); } catch { workspaceWritable = false; }\nprocess.stdout.write(JSON.stringify({ identityReadable, identityWritable, networkAccessible, workspaceWritable }));\n`);

  try {
    const result = await runVerifier({
      workspace,
      stateDir,
      protectedPaths: [],
      completion: {
        command: [process.execPath, probe, privateKey, forbiddenMarker],
        successExitCode: 0,
        timeoutMs: 10_000,
      },
    }, { codexCommand: 'codex' });
    assert.equal(result.passed, true, result.output);
    assert.match(result.output, /"identityReadable":false/);
    assert.match(result.output, /"identityWritable":false/);
    assert.match(result.output, /"networkAccessible":false/);
    assert.match(result.output, /"workspaceWritable":true/);
    await assert.rejects(access(forbiddenMarker), /ENOENT/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(forbiddenMarker, { force: true });
  }
});

test('real verifier launcher reports a child signal without accepting its synthetic code', {
  skip: process.env.OUTCOMELOOP_TEST_SANDBOX !== '1' || process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-sandbox-signal-'));
  const stateDir = await mkdtemp(path.join(os.homedir(), '.outcomeloop-sandbox-state-'));
  try {
    const result = await runVerifier({
      workspace,
      stateDir,
      protectedPaths: [],
      completion: {
        command: [process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'],
        successExitCode: 1,
        timeoutMs: 10_000,
      },
    }, { codexCommand: 'codex' });
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(result.passed, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('real verifier sandbox can read a protected multi-file verifier directory', {
  skip: process.env.OUTCOMELOOP_TEST_SANDBOX !== '1',
}, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-sandbox-workspace-'));
  const stateDir = await mkdtemp(path.join(os.homedir(), '.outcomeloop-sandbox-state-'));
  const verifierDirectory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-sandbox-verifier-'));
  const helper = path.join(verifierDirectory, 'helper.mjs');
  const verifier = path.join(verifierDirectory, 'verify.mjs');
  await writeFile(helper, 'export const result = "multi-file verifier passed";\n');
  await writeFile(verifier, "import { result } from './helper.mjs';\nprocess.stdout.write(result);\n");
  try {
    const result = await runVerifier({
      workspace,
      stateDir,
      protectedPaths: [verifierDirectory],
      completion: {
        command: [process.execPath, verifier],
        successExitCode: 0,
        timeoutMs: 10_000,
      },
    }, { codexCommand: 'codex' });
    assert.equal(result.passed, true, result.output);
    assert.match(result.output, /multi-file verifier passed/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(verifierDirectory, { recursive: true, force: true });
  }
});
