import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadContract } from '../src/contract.js';

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-data', 'contract');

async function protectedContractDir() {
  await mkdir(TEST_ROOT, { recursive: true });
  return mkdtemp(path.join(TEST_ROOT, 'case-'));
}

test('loadContract normalizes bounded defaults', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-contract-'));
  const contractPath = path.join(directory, 'outcomeloop.json');
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    objective: 'Make the verifier pass',
    completion: { command: ['node', '-e', 'process.exit(0)'] },
  }));
  const contract = await loadContract(contractPath);
  assert.equal(contract.model, 'gpt-5.6-terra');
  assert.equal(contract.sandbox, 'workspace-write');
  assert.equal(contract.workspace, await realpath(directory));
  assert.equal(contract.hash.length, 64);
  assert.equal(contract.protectedPaths.includes(contract.contractPath), true);
  assert.equal(contract.stateDir.startsWith(directory), false);
});

test('loadContract rejects unbounded sandbox mode', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-contract-'));
  const contractPath = path.join(directory, 'outcomeloop.json');
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    objective: 'Unsafe contract',
    sandbox: 'danger-full-access',
    completion: { command: ['true'] },
  }));
  await assert.rejects(loadContract(contractPath), /sandbox_must_be_bounded/);
});

test('loadContract rejects non-integer verifier exit codes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-contract-'));
  const contractPath = path.join(directory, 'outcomeloop.json');
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    objective: 'Invalid verifier configuration',
    completion: { command: ['true'], successExitCode: 0.5 },
  }));
  await assert.rejects(loadContract(contractPath), /success_exit_code_must_be_integer/);
});

test('loadContract rejects contract-controlled state directories', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-contract-'));
  const contractPath = path.join(directory, 'outcomeloop.json');
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    objective: 'Unsafe controller boundary',
    stateDir: './.outcomeloop',
    completion: { command: ['true'] },
  }));
  await assert.rejects(loadContract(contractPath), /state_dir_is_controller_managed/);
});

test('loadContract rejects protected verifier inputs inside a writable workspace', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-contract-'));
  const contractPath = path.join(directory, 'outcomeloop.json');
  await writeFile(path.join(directory, 'verify.js'), 'process.exit(0);\n');
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    objective: 'Unsafe verifier boundary',
    protectedPaths: ['./verify.js'],
    completion: { command: ['node', 'verify.js'] },
  }));
  await assert.rejects(loadContract(contractPath), /protected_path_inside_writable_workspace/);
});

test('loadContract rejects an unlisted verifier entrypoint inside the writable workspace', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-contract-'));
  const contractPath = path.join(directory, 'outcomeloop.json');
  await writeFile(path.join(directory, 'verify.js'), 'process.exit(0);\n');
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    objective: 'Do not trust a task-writable verifier',
    completion: { command: ['node', 'verify.js'] },
  }));
  await assert.rejects(loadContract(contractPath), /verifier_entrypoint_inside_writable_workspace/);
});

test('loadContract requires an external verifier entrypoint to be protected', async () => {
  const directory = await protectedContractDir();
  const workspace = path.join(directory, 'workspace');
  const verifierPath = path.join(directory, 'verify.js');
  const contractPath = path.join(directory, 'outcomeloop.json');
  await mkdir(workspace);
  await writeFile(verifierPath, 'process.exit(0);\n');
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    objective: 'Require a protected verifier',
    workspace: './workspace',
    completion: { command: ['node', '../verify.js'] },
  }));
  await assert.rejects(loadContract(contractPath), /verifier_entrypoint_must_be_protected/);
});

test('loadContract requires an absolute non-system verifier to be protected', async () => {
  const directory = await protectedContractDir();
  const workspace = path.join(directory, 'workspace');
  const verifierPath = path.join(directory, 'verify');
  const contractPath = path.join(directory, 'outcomeloop.json');
  await mkdir(workspace);
  await writeFile(verifierPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    objective: 'Protect an absolute custom verifier',
    workspace: './workspace',
    completion: { command: [verifierPath] },
  }));
  await assert.rejects(loadContract(contractPath), /verifier_entrypoint_must_be_protected/);
});

test('loadContract rejects package-script and environment wrappers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-contract-'));
  for (const [index, command] of [
    ['npm', 'test'],
    ['/usr/bin/env', 'node', 'verify.js'],
  ].entries()) {
    const contractPath = path.join(directory, `outcomeloop-wrapper-${index}.json`);
    await writeFile(contractPath, JSON.stringify({
      version: 1,
      objective: 'Reject agent-writable verifier wrappers',
      completion: { command },
    }));
    await assert.rejects(loadContract(contractPath), /unsupported_verifier_command/);
  }
});

test('loadContract rejects a missing verifier that Codex could create later', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-contract-'));
  const workspace = path.join(directory, 'workspace');
  const contractPath = path.join(directory, 'outcomeloop.json');
  await mkdir(workspace);
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    objective: 'Reject a future task-authored verifier',
    workspace: './workspace',
    completion: { command: ['node', 'verify.js'] },
  }));
  await assert.rejects(loadContract(contractPath), /verifier_entrypoint_inside_writable_workspace/);
});

test('loadContract rejects absolute and option-prefixed workspace verifiers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-contract-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  const directVerifier = path.join(workspace, 'verify');
  await writeFile(directVerifier, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(workspace, 'verify.js'), 'process.exit(0);\n');
  for (const command of [
    [directVerifier],
    ['node', '--no-warnings', 'verify.js'],
  ]) {
    const contractPath = path.join(directory, `outcomeloop-${command.length}.json`);
    await writeFile(contractPath, JSON.stringify({
      version: 1,
      objective: 'Reject alternate writable verifier syntax',
      workspace: './workspace',
      completion: { command },
    }));
    await assert.rejects(loadContract(contractPath), /verifier_entrypoint_inside_writable_workspace/);
  }
});

test('loadContract rejects unknown fields instead of silently applying defaults', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-contract-'));
  const contractPath = path.join(directory, 'outcomeloop.json');
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    objective: 'Reject misspelled controls',
    loadProjectRules: false,
    completion: { command: ['true'] },
  }));
  await assert.rejects(loadContract(contractPath), /unknown_contract_field:loadProjectRules/);
});

test('loadContract canonicalizes aliases to one state directory and lock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outcomeloop-contract-'));
  const contractPath = path.join(directory, 'outcomeloop.json');
  const aliasPath = path.join(directory, 'contract-alias.json');
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    objective: 'Use one canonical controller',
    completion: { command: ['true'] },
  }));
  await symlink('outcomeloop.json', aliasPath);
  const direct = await loadContract(contractPath);
  const alias = await loadContract(aliasPath);
  assert.equal(alias.contractPath, direct.contractPath);
  assert.equal(alias.stateDir, direct.stateDir);
});

test('loadContract preserves missing protected paths for runner integrity handling', async () => {
  const directory = await protectedContractDir();
  await mkdir(path.join(directory, 'workspace'));
  const verifierPath = path.join(directory, 'verify.js');
  const contractPath = path.join(directory, 'outcomeloop.json');
  await writeFile(verifierPath, 'process.exit(1);\n');
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    objective: 'Record verifier deletion',
    workspace: './workspace',
    protectedPaths: ['./verify.js'],
    completion: { command: ['node', '../verify.js'] },
  }));
  const before = await loadContract(contractPath);
  await unlink(verifierPath);
  const after = await loadContract(contractPath);
  assert.deepEqual(after.protectedPaths, before.protectedPaths);
});
