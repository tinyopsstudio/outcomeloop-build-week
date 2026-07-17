import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadContract } from '../src/contract.js';
import { spawnCapture } from '../src/process.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const TEST_ROOT = path.join(ROOT, '.test-data', 'cli');

async function protectedContractDir() {
  await mkdir(TEST_ROOT, { recursive: true });
  return mkdtemp(path.join(TEST_ROOT, 'case-'));
}

async function fakeCodexSandbox(directory) {
  const executable = path.join(directory, 'codex-sandbox-shim.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (args[0] !== 'sandbox' || separator === -1 || !args[separator + 1]) process.exit(2);
const child = spawn(args[separator + 1], args.slice(separator + 2), { stdio: 'inherit' });
child.once('error', (error) => { process.stderr.write(error.message + '\\n'); process.exit(1); });
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`, { mode: 0o755 });
  return executable;
}

test('init stops parsing OutcomeLoop flags at the command separator', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-cli-'));
  const result = await spawnCapture(process.execPath, [
    CLI, 'init', '--objective', 'Parse verifier flags correctly', '--',
    'node', 'verify.js', '--file', 'input.json', '--objective', 'verifier-value',
  ], { cwd: directory, timeoutMs: 5_000 });
  assert.equal(result.code, 0, result.stderr);
  const contract = JSON.parse(await readFile(path.join(directory, 'outcomeloop.json'), 'utf8'));
  assert.deepEqual(contract.completion.command, [
    'node', '../verify.js', '--file', 'input.json', '--objective', 'verifier-value',
  ]);
  assert.equal(contract.workspace, 'workspace');
  assert.deepEqual(contract.protectedPaths, ['verify.js']);
  await assert.rejects(access(path.join(directory, 'input.json')), /ENOENT/);
});

test('verify-receipt defaults to outcomeloop.json', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-cli-'));
  const contractPath = path.join(directory, 'outcomeloop.json');
  const codexShim = await fakeCodexSandbox(directory);
  await writeFile(contractPath, `${JSON.stringify({
    version: 1,
    objective: 'Recognize an already complete contract',
    completion: { command: [process.execPath, '-e', 'process.exit(0)'] },
  }, null, 2)}\n`);
  const run = await spawnCapture(process.execPath, [CLI, 'run', '--codex', codexShim], { cwd: directory, timeoutMs: 10_000 });
  assert.equal(run.code, 0, run.stderr);
  const verification = await spawnCapture(process.execPath, [CLI, 'verify-receipt'], { cwd: directory, timeoutMs: 10_000 });
  assert.equal(verification.code, 0, verification.stderr);
  assert.equal(JSON.parse(verification.stdout).valid, true);
  await rm((await loadContract(contractPath)).stateDir, { recursive: true, force: true });
});

test('init rejects an extensionless verifier inside the writable workspace', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-cli-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'verify'), 'process.exit(0);\n');
  const result = await spawnCapture(process.execPath, [
    CLI, 'init', '--objective', 'Protect extensionless verifier', '--workspace', './workspace', '--',
    'node', 'verify',
  ], { cwd: directory, timeoutMs: 5_000 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /init_verifier_must_be_outside_workspace/);
});

test('init leaves existing workspace artifacts writable for the verifier', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-cli-'));
  const workspace = path.join(directory, 'workspace');
  const verifierDirectory = path.join(directory, 'verifier');
  await mkdir(workspace);
  await mkdir(verifierDirectory);
  await mkdir(path.join(workspace, 'artifacts'));
  await writeFile(path.join(workspace, 'result.js'), 'export default {};\n');
  await writeFile(path.join(verifierDirectory, 'verify.js'), 'process.exit(0);\n');

  const result = await spawnCapture(process.execPath, [
    CLI, 'init', '--objective', 'Inspect writable output artifacts', '--workspace', './workspace', '--',
    'node', '../verifier/verify.js', 'result.js', 'artifacts',
  ], { cwd: directory, timeoutMs: 5_000 });

  assert.equal(result.code, 0, result.stderr);
  const contract = JSON.parse(await readFile(path.join(directory, 'outcomeloop.json'), 'utf8'));
  assert.deepEqual(contract.completion.command, [
    'node', '../verifier/verify.js', 'result.js', 'artifacts',
  ]);
  assert.deepEqual(contract.protectedPaths, ['verifier/verify.js']);
});

test('init protects a multi-file verifier directory on request', async () => {
  const directory = await protectedContractDir();
  const verifierDirectory = path.join(directory, 'verifier');
  await mkdir(verifierDirectory);
  await writeFile(path.join(verifierDirectory, 'verify.js'), "import './helper.js';\n");
  await writeFile(path.join(verifierDirectory, 'helper.js'), 'export default true;\n');
  const result = await spawnCapture(process.execPath, [
    CLI, 'init', '--objective', 'Protect verifier dependencies', '--protect', './verifier', '--',
    'node', '../verifier/verify.js',
  ], { cwd: directory, timeoutMs: 5_000 });
  assert.equal(result.code, 0, result.stderr);
  const contract = JSON.parse(await readFile(path.join(directory, 'outcomeloop.json'), 'utf8'));
  assert.deepEqual(contract.protectedPaths, ['verifier']);
  await loadContract(path.join(directory, 'outcomeloop.json'));
});

test('init rejects package-script verifier wrappers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-cli-'));
  const result = await spawnCapture(process.execPath, [
    CLI, 'init', '--objective', 'Reject mutable package scripts', '--', 'npm', 'test',
  ], { cwd: directory, timeoutMs: 5_000 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /init_unsupported_verifier_command:npm/);
});
