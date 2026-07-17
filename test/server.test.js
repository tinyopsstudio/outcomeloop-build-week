import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { protectedSnapshot } from '../src/integrity.js';
import { writeJsonAtomic } from '../src/io.js';
import { loadSigningIdentity, sealReceipt } from '../src/receipt.js';
import { createDashboardServer } from '../src/server.js';

test('dashboard integrity validates signature, contract hash, and current protected files', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-server-'));
  const protectedDir = await mkdtemp(path.join(os.homedir(), '.outcomeloop-dashboard-test-'));
  const protectedFile = path.join(protectedDir, 'verify.js');
  await writeFile(protectedFile, 'baseline\n');
  const protectedFiles = await protectedSnapshot([protectedFile]);
  const identity = await loadSigningIdentity();
  const contract = { hash: 'a'.repeat(64), protectedPaths: [protectedFile] };
  const receipt = sealReceipt({
    version: 1,
    status: 'verified',
    contractHash: contract.hash,
    protectedFiles,
  }, identity);
  await writeJsonAtomic(path.join(stateDir, 'receipt.json'), receipt);

  const server = createDashboardServer({ stateDir, contract, trustedPublicKey: identity.publicKey });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    const initial = await fetch(`http://127.0.0.1:${port}/api/integrity`).then((response) => response.json());
    assert.deepEqual(initial, {
      integrity: true,
      receiptSignature: true,
      protectedFiles: true,
      contractHash: true,
    });

    await writeFile(protectedFile, 'changed\n');
    const changed = await fetch(`http://127.0.0.1:${port}/api/integrity`).then((response) => response.json());
    assert.equal(changed.receiptSignature, true);
    assert.equal(changed.protectedFiles, false);
    assert.equal(changed.integrity, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('dashboard loads the trusted key after a receipt appears', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-server-lazy-'));
  const protectedDir = await mkdtemp(path.join(os.homedir(), '.outcomeloop-dashboard-test-'));
  const protectedFile = path.join(protectedDir, 'verify.js');
  await writeFile(protectedFile, 'baseline\n');
  const protectedFiles = await protectedSnapshot([protectedFile]);
  const identity = await loadSigningIdentity();
  const contract = { hash: 'b'.repeat(64), protectedPaths: [protectedFile] };
  const receipt = sealReceipt({
    version: 1,
    status: 'verified',
    contractHash: contract.hash,
    protectedFiles,
  }, identity);
  let keyLoads = 0;
  const server = createDashboardServer({
    stateDir,
    contract,
    loadPublicKey: async () => {
      keyLoads += 1;
      return { publicKey: identity.publicKey };
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    const before = await fetch(`http://127.0.0.1:${port}/api/integrity`);
    assert.equal(before.status, 404);
    assert.equal(keyLoads, 0);

    await writeJsonAtomic(path.join(stateDir, 'receipt.json'), receipt);
    const after = await fetch(`http://127.0.0.1:${port}/api/integrity`).then((response) => response.json());
    assert.equal(after.integrity, true);
    assert.equal(keyLoads, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
