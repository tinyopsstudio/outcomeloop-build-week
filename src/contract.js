import path from 'node:path';
import os from 'node:os';
import { access, realpath } from 'node:fs/promises';
import { canonicalJson, readJson, sha256 } from './io.js';

export const DEFAULT_GATES = [
  'captcha',
  'kyc_or_identity',
  'legal_signature',
  'public_identity_exposure',
  'transaction_over_limit',
];

const CONTRACT_FIELDS = new Set([
  'version', 'objective', 'workspace', 'model', 'sandbox', 'maxIterations',
  'maxRuntimeMinutes', 'constraints', 'allowedGates', 'protectedPaths',
  'loadExecPolicyRules', 'completion', 'stateDir',
]);
const COMPLETION_FIELDS = new Set(['command', 'successExitCode', 'timeoutMs']);
const SCRIPT_INTERPRETERS = new Set([
  'node', 'node.exe', 'python', 'python3', 'python.exe', 'ruby', 'ruby.exe',
  'bash', 'sh', 'zsh', 'deno', 'deno.exe', 'bun', 'bun.exe',
]);
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '-p', '--print']);
const EXTERNAL_CODE_FLAGS = new Set([
  '-m', '-r', '--require', '--import', '--loader', '--experimental-loader',
]);
const OPTIONS_WITH_VALUES = new Set([
  '--conditions', '--diagnostic-dir', '--input-type', '--title', '--unhandled-rejections',
]);
const SAFE_DIRECT_EXECUTABLES = new Set([
  'true', 'true.exe', 'false', 'false.exe', 'test', 'test.exe', '[', 'cmp', 'cmp.exe', 'diff', 'diff.exe',
]);
const EXECUTION_WRAPPERS = new Set([
  'env', 'env.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'pnpm', 'pnpm.cmd',
  'yarn', 'yarn.cmd', 'corepack', 'corepack.exe', 'make', 'gmake', 'just',
  'cargo', 'go', 'pytest', 'tox', 'uv', 'rake', 'gradle', 'gradlew',
  'mvn', 'mvnw', 'java', 'java.exe', 'dotnet', 'xcrun',
]);

function assert(condition, message) {
  if (!condition) throw new Error(`invalid_contract:${message}`);
}

function rejectUnknownFields(value, allowed, scope) {
  for (const key of Object.keys(value)) assert(allowed.has(key), `unknown_${scope}_field:${key}`);
}

export function pathContains(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function physicalPath(targetPath) {
  const missing = [];
  let cursor = targetPath;
  while (true) {
    try {
      return path.join(await realpath(cursor), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function trustedSystemExecutable(filePath) {
  if (!path.isAbsolute(filePath)) return false;
  const normalized = path.resolve(filePath);
  const roots = process.platform === 'win32'
    ? [process.env.SYSTEMROOT && path.join(process.env.SYSTEMROOT, 'System32')].filter(Boolean)
    : ['/bin', '/sbin', '/usr/bin', '/usr/sbin'];
  return roots.some((root) => pathContains(root, normalized));
}

export function verifierEntrypoint(command) {
  const executable = path.basename(command[0] || '').toLowerCase();
  if (SCRIPT_INTERPRETERS.has(executable)) {
    for (let index = 1; index < command.length; index += 1) {
      const part = command[index];
      if (part === '--') {
        return command[index + 1]
          ? { path: command[index + 1], index: index + 1, requiresProtection: true }
          : { unresolved: true };
      }
      const option = part.split('=', 1)[0];
      if (INLINE_CODE_FLAGS.has(option)) {
        const hasInlineValue = part.includes('=') || Boolean(command[index + 1]);
        return hasInlineValue ? { inline: true } : { unresolved: true };
      }
      if (EXTERNAL_CODE_FLAGS.has(option)) return { unsupported: part };
      if (OPTIONS_WITH_VALUES.has(option) && !part.includes('=')) {
        index += 1;
        continue;
      }
      if (part.startsWith('-')) continue;
      return { path: part, index, requiresProtection: true };
    }
    return { unresolved: true };
  }
  const direct = command[0];
  if (EXECUTION_WRAPPERS.has(executable)) return { unsupported: direct };
  if (path.isAbsolute(direct)) {
    if (trustedSystemExecutable(direct)) {
      return SAFE_DIRECT_EXECUTABLES.has(executable)
        ? { trustedExecutable: true }
        : { unsupported: direct };
    }
    return { path: direct, index: 0, requiresProtection: true };
  }
  if (direct && (direct.startsWith('.') || direct.includes('/') || direct.includes('\\'))) {
    return { path: direct, index: 0, requiresProtection: true };
  }
  return SAFE_DIRECT_EXECUTABLES.has(executable)
    ? { trustedExecutable: true }
    : { unsupported: direct };
}

export async function loadContract(contractPath) {
  const absolutePath = await realpath(path.resolve(contractPath));
  const raw = await readJson(absolutePath);
  const baseDir = path.dirname(absolutePath);

  assert(raw && typeof raw === 'object' && !Array.isArray(raw), 'object_required');
  rejectUnknownFields(raw, CONTRACT_FIELDS, 'contract');
  assert(raw.version === 1, 'version_must_equal_1');
  assert(typeof raw.objective === 'string' && raw.objective.trim(), 'objective_required');
  assert(raw.workspace === undefined || (typeof raw.workspace === 'string' && raw.workspace), 'workspace_invalid');
  assert(raw.model === undefined || (typeof raw.model === 'string' && raw.model), 'model_invalid');
  assert(raw.sandbox === undefined || typeof raw.sandbox === 'string', 'sandbox_invalid');
  assert(raw.maxIterations === undefined || Number.isInteger(raw.maxIterations), 'max_iterations_must_be_integer');
  assert(raw.maxRuntimeMinutes === undefined || typeof raw.maxRuntimeMinutes === 'number', 'max_runtime_must_be_number');
  assert(raw.constraints === undefined || (Array.isArray(raw.constraints) && raw.constraints.every((item) => typeof item === 'string')), 'constraints_invalid');
  assert(raw.allowedGates === undefined || (Array.isArray(raw.allowedGates) && raw.allowedGates.every((item) => typeof item === 'string')), 'allowed_gates_invalid');
  assert(raw.protectedPaths === undefined || (Array.isArray(raw.protectedPaths) && raw.protectedPaths.every((item) => typeof item === 'string' && item)), 'protected_paths_invalid');
  assert(raw.loadExecPolicyRules === undefined || typeof raw.loadExecPolicyRules === 'boolean', 'load_exec_policy_rules_invalid');
  assert(raw.completion && typeof raw.completion === 'object' && !Array.isArray(raw.completion), 'completion_required');
  rejectUnknownFields(raw.completion, COMPLETION_FIELDS, 'completion');
  assert(Array.isArray(raw.completion.command), 'completion_command_required');
  assert(raw.completion.command.length > 0, 'completion_command_empty');
  assert(raw.completion.command.every((part) => typeof part === 'string' && part), 'completion_command_invalid');
  assert(raw.completion.successExitCode === undefined || Number.isInteger(raw.completion.successExitCode), 'success_exit_code_must_be_integer');
  assert(raw.completion.timeoutMs === undefined || Number.isInteger(raw.completion.timeoutMs), 'completion_timeout_must_be_integer');

  const workspace = path.resolve(baseDir, raw.workspace || '.');
  await access(workspace);
  const sandbox = raw.sandbox || 'workspace-write';
  assert(['read-only', 'workspace-write'].includes(sandbox), 'sandbox_must_be_bounded');

  const explicitProtectedPaths = Array.isArray(raw.protectedPaths)
    ? raw.protectedPaths.map((item) => path.resolve(baseDir, item))
    : [];
  const protectedPaths = [...new Set([absolutePath, ...explicitProtectedPaths])];

  assert(raw.stateDir === undefined, 'state_dir_is_controller_managed');
  const stateDir = path.join(os.homedir(), '.outcomeloop', 'runs', sha256(absolutePath).slice(0, 32));
  const physicalWorkspace = await physicalPath(workspace);
  const physicalTempDir = await physicalPath(os.tmpdir());
  const physicalStateDir = await physicalPath(stateDir);
  const physicalExplicitProtectedPaths = await Promise.all(explicitProtectedPaths.map(physicalPath));
  assert(!pathContains(physicalWorkspace, physicalStateDir), 'state_dir_must_be_outside_workspace');
  for (const protectedPath of protectedPaths) {
    const physicalProtectedPath = await physicalPath(protectedPath);
    assert(!pathContains(physicalProtectedPath, physicalStateDir), 'state_dir_overlaps_protected_path');
  }
  if (sandbox === 'workspace-write') {
    for (const physicalProtectedPath of physicalExplicitProtectedPaths) {
      assert(!pathContains(physicalWorkspace, physicalProtectedPath), 'protected_path_inside_writable_workspace');
      assert(!pathContains(physicalTempDir, physicalProtectedPath), 'protected_path_inside_writable_temp');
    }
  }
  const entrypoint = verifierEntrypoint(raw.completion.command);
  assert(!entrypoint.unresolved, 'verifier_entrypoint_unresolved');
  assert(!entrypoint.unsupported, `unsupported_verifier_command:${entrypoint.unsupported || ''}`);
  if (entrypoint.path) {
    const entrypointPath = path.resolve(workspace, entrypoint.path);
    const physicalEntrypoint = await physicalPath(entrypointPath);
    assert(!(sandbox === 'workspace-write' && pathContains(physicalWorkspace, physicalEntrypoint)), 'verifier_entrypoint_inside_writable_workspace');
    if (entrypoint.requiresProtection) {
      assert(physicalExplicitProtectedPaths.some((protectedPath) => pathContains(protectedPath, physicalEntrypoint)), 'verifier_entrypoint_must_be_protected');
    }
  }

  const contract = {
    version: 1,
    objective: raw.objective.trim(),
    workspace,
    model: raw.model || 'gpt-5.6-terra',
    sandbox,
    maxIterations: Number(raw.maxIterations ?? 6),
    maxRuntimeMinutes: Number(raw.maxRuntimeMinutes ?? 60),
    constraints: Array.isArray(raw.constraints) ? raw.constraints.map(String) : [],
    allowedGates: Array.isArray(raw.allowedGates) ? raw.allowedGates.map(String) : DEFAULT_GATES,
    protectedPaths,
    loadExecPolicyRules: raw.loadExecPolicyRules !== false,
    completion: {
      command: raw.completion.command,
      successExitCode: Number(raw.completion.successExitCode ?? 0),
      timeoutMs: Number(raw.completion.timeoutMs ?? 60_000),
    },
    stateDir,
    contractPath: absolutePath,
    contractDir: baseDir,
  };

  assert(Number.isInteger(contract.maxIterations) && contract.maxIterations >= 1 && contract.maxIterations <= 100, 'max_iterations_out_of_range');
  assert(Number.isFinite(contract.maxRuntimeMinutes) && contract.maxRuntimeMinutes > 0 && contract.maxRuntimeMinutes <= 1_440, 'max_runtime_out_of_range');
  assert(Number.isInteger(contract.completion.successExitCode), 'success_exit_code_must_be_integer');
  assert(Number.isInteger(contract.completion.timeoutMs) && contract.completion.timeoutMs >= 100 && contract.completion.timeoutMs <= 3_600_000, 'completion_timeout_out_of_range');

  const hashInput = {
    ...contract,
    contractPath: undefined,
    contractDir: undefined,
    protectedPaths: contract.protectedPaths.map((item) => path.relative(baseDir, item)),
    stateDir: null,
    workspace: path.relative(baseDir, workspace) || '.',
  };
  contract.hash = sha256(canonicalJson(hashInput));
  return contract;
}

export function makeContractTemplate({ objective, workspace = './workspace', command, protectedPaths = null }) {
  const inferredProtectedPaths = protectedPaths || command.filter((part, index) =>
    !part.startsWith('-')
      && (/\.(?:c?js|mjs|py|sh|rb|go)$/i.test(part) || (index === 0 && (part.startsWith('.') || part.includes('/')))),
  );
  return {
    version: 1,
    objective,
    workspace,
    model: 'gpt-5.6-terra',
    sandbox: 'workspace-write',
    maxIterations: 6,
    maxRuntimeMinutes: 60,
    constraints: [
      'Do not weaken or replace the completion verifier.',
      'Preserve unrelated user changes.',
      'Never expose credentials or private data.',
    ],
    allowedGates: DEFAULT_GATES,
    protectedPaths: inferredProtectedPaths,
    loadExecPolicyRules: true,
    completion: {
      command,
      successExitCode: 0,
      timeoutMs: 60_000,
    },
  };
}
