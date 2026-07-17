import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { canonicalJson, sha256 } from '../src/io.js';
import { spawnCapture } from '../src/process.js';
import {
  loadSigningIdentity,
  sealReceipt,
  verifyReceiptIntegrity,
  workspaceSnapshot,
} from '../src/receipt.js';

test('Ed25519 seal rejects a forged receipt even when its public hash is recomputed', async () => {
  const identity = await loadSigningIdentity();
  const receipt = sealReceipt({ version: 1, status: 'verified', evidence: 'passed' }, identity);
  assert.equal(verifyReceiptIntegrity(receipt, identity.publicKey), true);

  const forged = { ...receipt, evidence: 'forged' };
  const payload = { ...forged };
  delete payload.receiptHash;
  delete payload.seal;
  forged.receiptHash = sha256(canonicalJson(payload));

  assert.equal(verifyReceiptIntegrity(forged, identity.publicKey), false);
  assert.equal(verifyReceiptIntegrity(receipt, null), false);
});

test('workspace snapshot disables repository-controlled fsmonitor execution', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-receipt-'));
  const marker = path.join(directory, 'fsmonitor-ran');
  const monitor = path.join(directory, 'monitor.mjs');
  await writeFile(path.join(directory, 'tracked.txt'), 'tracked\n');
  await writeFile(monitor, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.stdout.write('token\\n');\n`);
  await chmod(monitor, 0o755);

  for (const args of [
    ['init'],
    ['add', 'tracked.txt'],
    ['config', 'core.fsmonitor', monitor],
  ]) {
    const result = await spawnCapture('git', args, { cwd: directory, timeoutMs: 5_000 });
    assert.equal(result.code, 0, result.stderr);
  }

  const control = await spawnCapture('git', ['status', '--porcelain=v1'], { cwd: directory, timeoutMs: 5_000 });
  assert.equal(control.code, 0, control.stderr);
  await access(marker);
  await rm(marker);

  await workspaceSnapshot(directory);
  await assert.rejects(access(marker), /ENOENT/);
});

test('concurrent processes publish one complete signing identity', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-identity-home-'));
  const moduleUrl = pathToFileURL(path.resolve('src/receipt.js')).href;
  const script = `const receipt = await import(${JSON.stringify(moduleUrl)}); const identity = await receipt.loadSigningIdentity(); process.stdout.write(identity.keyId);`;
  const results = await Promise.all(Array.from({ length: 12 }, () => spawnCapture(process.execPath, [
    '--input-type=module', '-e', script,
  ], {
    env: { ...process.env, HOME: home },
    timeoutMs: 10_000,
  })));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const keyIds = new Set(results.map((result) => result.stdout.trim()));
  assert.equal(keyIds.size, 1);
  assert.match([...keyIds][0], /^[a-f0-9]{64}$/);
  await rm(home, { recursive: true, force: true });
});
