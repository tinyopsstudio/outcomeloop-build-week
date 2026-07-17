#!/usr/bin/env node

import path from 'node:path';
import { access, mkdir, readFile } from 'node:fs/promises';
import { loadContract, makeContractTemplate, pathContains, verifierEntrypoint } from './contract.js';
import { readJson, writeJsonAtomic } from './io.js';
import { loadTrustedPublicKey, verifyReceiptIntegrity } from './receipt.js';
import { runOutcomeLoop, runVerifier } from './runner.js';
import { serveDashboard } from './server.js';
import { protectedSnapshot } from './integrity.js';

function valueAfter(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function has(args, name) {
  return args.includes(name);
}

function valuesAfter(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing_value:${name}`);
    values.push(value);
    index += 1;
  }
  return values;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function usage() {
  return `OutcomeLoop\n\nCommands:\n  init --objective <text> [--file outcomeloop.json] [--workspace ./workspace] [--protect <path>] -- <verifier> [args...]\n  run [--contract outcomeloop.json] [--codex codex] [--resume-gate]\n  verify [--contract outcomeloop.json] [--codex codex]\n  status [--contract outcomeloop.json]\n  verify-receipt [--contract outcomeloop.json] [--public-key key.pem]\n  serve [--contract outcomeloop.json] [--port 4173]\n\nCompletion is accepted only when the sandboxed verifier exits normally with its configured success code.`;
}

async function init(args) {
  const separator = args.indexOf('--');
  const optionArgs = separator === -1 ? args : args.slice(0, separator);
  const objective = valueAfter(optionArgs, '--objective');
  const filePath = path.resolve(valueAfter(optionArgs, '--file', 'outcomeloop.json'));
  const workspaceValue = valueAfter(optionArgs, '--workspace', './workspace');
  const command = separator === -1 ? [] : args.slice(separator + 1);
  if (!objective || !command.length) throw new Error('init_requires_objective_and_verifier_command');
  try {
    await access(filePath);
    throw new Error(`contract_already_exists:${filePath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const contractDir = path.dirname(filePath);
  const workspacePath = path.resolve(contractDir, workspaceValue);
  await mkdir(workspacePath, { recursive: true });
  const completionCommand = [...command];
  const protectedRoots = [];
  const protectedPaths = [];
  for (const value of valuesAfter(optionArgs, '--protect')) {
    const protectedPath = path.resolve(contractDir, value);
    await access(protectedPath);
    if (pathContains(workspacePath, protectedPath)) {
      throw new Error(`init_protected_path_must_be_outside_workspace:${protectedPath}`);
    }
    protectedRoots.push(protectedPath);
    protectedPaths.push(path.relative(contractDir, protectedPath) || '.');
  }
  const entrypoint = verifierEntrypoint(command);
  if (entrypoint.unresolved) throw new Error('init_verifier_entrypoint_unresolved');
  if (entrypoint.unsupported) throw new Error(`init_unsupported_verifier_command:${entrypoint.unsupported}`);
  if (entrypoint.path && entrypoint.requiresProtection) {
    const { index, path: part } = entrypoint;
    const workspaceCandidate = path.isAbsolute(part) ? part : path.resolve(workspacePath, part);
    const contractCandidate = path.isAbsolute(part) ? part : path.resolve(contractDir, part);
    let verifierPath;
    if (path.isAbsolute(part)) {
      verifierPath = part;
    } else {
      if (await exists(workspaceCandidate)) {
        verifierPath = workspaceCandidate;
      } else {
        verifierPath = contractCandidate;
        completionCommand[index] = path.relative(workspacePath, verifierPath) || '.';
      }
    }
    if (pathContains(workspacePath, verifierPath)) {
      throw new Error(`init_verifier_must_be_outside_workspace:${verifierPath}`);
    }
    if (!protectedRoots.some((root) => pathContains(root, verifierPath))) {
      protectedPaths.push(path.relative(contractDir, verifierPath) || '.');
    }
  }
  const workspace = path.relative(contractDir, workspacePath) || '.';
  await writeJsonAtomic(filePath, makeContractTemplate({
    objective,
    workspace,
    command: completionCommand,
    protectedPaths: [...new Set(protectedPaths)],
  }));
  process.stdout.write(`${filePath}\n`);
}

async function load(args) {
  return loadContract(valueAfter(args, '--contract', 'outcomeloop.json'));
}

async function run(args) {
  const contract = await load(args);
  const result = await runOutcomeLoop(contract, {
    codexCommand: valueAfter(args, '--codex', 'codex'),
    resumeGate: has(args, '--resume-gate'),
  });
  process.stdout.write(`${JSON.stringify({
    status: result.state.status,
    iteration: result.state.iteration,
    sessionId: result.state.sessionId,
    receipt: result.receipt?.receiptHash || null,
    stateFile: result.paths.state,
  }, null, 2)}\n`);
  if (result.state.status === 'verified') return 0;
  if (result.state.status === 'paused_gate') return 3;
  if (result.state.status === 'configuration_error') return 4;
  if (result.state.status === 'integrity_violation') return 5;
  return 2;
}

async function verify(args) {
  const contract = await load(args);
  const result = await runVerifier(contract, { codexCommand: valueAfter(args, '--codex', 'codex') });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.passed ? 0 : 1;
}

async function status(args) {
  const contract = await load(args);
  const state = await readJson(path.join(contract.stateDir, 'state.json'));
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

async function verifyReceipt(args) {
  const contractPath = valueAfter(args, '--contract', 'outcomeloop.json');
  const contract = await loadContract(contractPath);
  const filePath = path.join(contract.stateDir, 'receipt.json');
  const receipt = await readJson(filePath);
  const publicKeyPath = valueAfter(args, '--public-key');
  const trustedPublicKey = publicKeyPath
    ? await readFile(path.resolve(publicKeyPath), 'utf8')
    : (await loadTrustedPublicKey()).publicKey;
  const integrity = verifyReceiptIntegrity(receipt, trustedPublicKey);
  let protectedFiles = false;
  try {
    const currentProtection = await protectedSnapshot(contract.protectedPaths);
    protectedFiles = currentProtection.fingerprint === receipt.protectedFiles?.fingerprint;
  } catch {
    protectedFiles = false;
  }
  const valid = integrity && protectedFiles && receipt.contractHash === contract.hash;
  process.stdout.write(`${JSON.stringify({
    valid,
    receiptIntegrity: integrity,
    protectedFiles,
    receiptHash: receipt.receiptHash || null,
  }, null, 2)}\n`);
  return valid ? 0 : 1;
}

async function serve(args) {
  const contract = await load(args);
  const port = Number(valueAfter(args, '--port', '4173'));
  await serveDashboard({ stateDir: contract.stateDir, port, contract });
  process.stdout.write(`http://127.0.0.1:${port}\n`);
  return new Promise(() => {});
}

async function main() {
  const [, , command = 'help', ...args] = process.argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (command === 'init') return init(args);
  if (command === 'run') return run(args);
  if (command === 'verify') return verify(args);
  if (command === 'status') return status(args);
  if (command === 'verify-receipt') return verifyReceipt(args);
  if (command === 'serve') return serve(args);
  throw new Error(`unknown_command:${command}`);
}

try {
  const code = await main();
  if (Number.isInteger(code)) process.exitCode = code;
} catch (error) {
  process.stderr.write(`OutcomeLoop: ${error.message}\n`);
  process.exitCode = 1;
}
