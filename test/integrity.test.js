import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { protectedSnapshot } from '../src/integrity.js';

test('protected snapshot changes when an immutable file changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-integrity-'));
  const filePath = path.join(directory, 'verify.js');
  await writeFile(filePath, 'process.exit(1);\n');
  const before = await protectedSnapshot([filePath]);
  await writeFile(filePath, 'process.exit(0);\n');
  const after = await protectedSnapshot([filePath]);
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.equal(before.entries, 1);
});

test('protected snapshot rejects symlinks instead of trusting link text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-integrity-'));
  const targetPath = path.join(directory, 'mutable.js');
  const linkPath = path.join(directory, 'verify.js');
  await writeFile(targetPath, 'process.exit(1);\n');
  await symlink('mutable.js', linkPath);
  await assert.rejects(protectedSnapshot([linkPath]), /protected_path_symlink_not_allowed/);
});

test('protected snapshot changes when executable mode changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-integrity-'));
  const filePath = path.join(directory, 'verify.sh');
  await writeFile(filePath, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  const before = await protectedSnapshot([filePath]);
  await chmod(filePath, 0o755);
  const after = await protectedSnapshot([filePath]);
  assert.notEqual(before.fingerprint, after.fingerprint);
});

test('protected snapshot distinguishes roots with the same basename', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-integrity-'));
  const firstDirectory = path.join(directory, 'first');
  const secondDirectory = path.join(directory, 'second');
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  const first = path.join(firstDirectory, 'verify.js');
  const second = path.join(secondDirectory, 'verify.js');
  await writeFile(first, 'first\n');
  await writeFile(second, 'second\n');
  const before = await protectedSnapshot([first, second]);
  await writeFile(first, 'second\n');
  await writeFile(second, 'first\n');
  const after = await protectedSnapshot([first, second]);
  assert.notEqual(before.fingerprint, after.fingerprint);
});
