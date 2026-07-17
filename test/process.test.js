import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnCapture } from '../src/process.js';

test('spawnCapture terminates descendant processes when a command times out', async () => {
  const script = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    setTimeout(() => {}, 1000);
  `;
  const startedAt = Date.now();
  const result = await spawnCapture(process.execPath, ['-e', script], { timeoutMs: 30 });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.timedOut, true);
  assert.ok(elapsedMs >= 100, `cleanup resolved too early at ${elapsedMs}ms`);
  assert.ok(elapsedMs < 500, `timeout took ${elapsedMs}ms`);
});

test('spawnCapture preserves a signal instead of inventing an exit code', async () => {
  const result = await spawnCapture(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], { timeoutMs: 1_000 });
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.timedOut, false);
});

test('spawnCapture handles stdin EPIPE when a child exits before reading', async () => {
  const result = await spawnCapture(process.execPath, ['-e', 'process.exit(0)'], {
    input: 'x'.repeat(1_000_000),
    timeoutMs: 1_000,
  });
  assert.equal(result.code, 0);
});

test('spawnCapture removes descendants left behind after a normal parent exit', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-process-'));
  const marker = path.join(directory, 'orphan-ran');
  const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'), 350)`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }).unref()`;
  const result = await spawnCapture(process.execPath, ['-e', parent], { timeoutMs: 1_000 });
  assert.equal(result.code, 0);
  await new Promise((resolve) => setTimeout(resolve, 450));
  await assert.rejects(access(marker), /ENOENT/);
});

test('spawnCapture removes active descendants when the controller is terminated', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-process-'));
  const marker = path.join(directory, 'terminated-child-ran');
  const helper = path.join(directory, 'controller.mjs');
  const moduleUrl = pathToFileURL(path.resolve('src/process.js')).href;
  const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'), 500); setTimeout(() => {}, 2000)`;
  await writeFile(helper, `import { spawnCapture } from ${JSON.stringify(moduleUrl)};\nconst run = spawnCapture(process.execPath, ['-e', ${JSON.stringify(descendant)}], { timeoutMs: 5000 });\nprocess.stdout.write('ready\\n');\nawait run;\n`);

  const controller = spawn(process.execPath, [helper], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    controller.once('error', reject);
    controller.stdout.on('data', (chunk) => {
      if (chunk.toString('utf8').includes('ready')) resolve();
    });
  });
  controller.kill('SIGTERM');
  await new Promise((resolve) => controller.once('close', resolve));
  await new Promise((resolve) => setTimeout(resolve, 600));
  await assert.rejects(access(marker), /ENOENT/);
});
