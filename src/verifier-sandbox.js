import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bound } from './io.js';
import { spawnCapture } from './process.js';
import { extractVerifierStatus } from './verifier-protocol.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER_PATH = path.join(ROOT, 'verifier-launcher.js');
const PROTOCOL_PATH = path.join(ROOT, 'verifier-protocol.js');
const PROFILE_NAME = 'outcomeloop-verifier';

function toml(value) {
  return JSON.stringify(String(value));
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

async function resolveExecutable(command, workspace, environment) {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const candidate = path.isAbsolute(command) ? command : path.resolve(workspace, command);
    await access(candidate, constants.X_OK);
    return candidate;
  }
  const pathValue = environment.PATH || '';
  const extensions = process.platform === 'win32' && !path.extname(command)
    ? (environment.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch (error) {
        if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
      }
    }
  }
  throw new Error(`verifier_executable_not_found:${command}`);
}

function runtimePrefix(filePath) {
  const normalized = path.resolve(filePath);
  for (const prefix of ['/opt/homebrew', '/usr/local', '/nix/store', '/System/Library/OpenSSL']) {
    if (normalized === prefix || normalized.startsWith(`${prefix}${path.sep}`)) return prefix;
  }
  const home = os.homedir();
  for (const relative of ['.nvm', '.asdf', '.local/share/mise', '.volta']) {
    const prefix = path.join(home, relative);
    if (normalized.startsWith(`${prefix}${path.sep}`)) return prefix;
  }
  const executableDirectory = path.dirname(normalized);
  if (['bin', 'scripts'].includes(path.basename(executableDirectory).toLowerCase())) {
    return path.dirname(executableDirectory);
  }
  return normalized;
}

function safeEnvironment({ codexHome, verifierHome, tempDir }) {
  const environment = {};
  for (const name of [
    'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  ]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  environment.CODEX_HOME = codexHome;
  environment.HOME = verifierHome;
  environment.USERPROFILE = verifierHome;
  environment.TMPDIR = tempDir;
  environment.TMP = tempDir;
  environment.TEMP = tempDir;
  environment.NO_COLOR = '1';
  return environment;
}

async function prepareSandbox(contract) {
  const root = path.join(contract.stateDir, 'verifier-sandbox');
  const codexHome = path.join(root, 'codex');
  const verifierHome = path.join(root, 'home');
  const tempDir = path.join(root, 'tmp');
  const controlDir = path.join(root, 'control');
  await Promise.all([codexHome, verifierHome, tempDir, controlDir].map((directory) => (
    mkdir(directory, { recursive: true, mode: 0o700 }).then(() => chmod(directory, 0o700))
  )));

  const environment = safeEnvironment({ codexHome, verifierHome, tempDir });
  const executable = await resolveExecutable(contract.completion.command[0], contract.workspace, environment);
  const readPaths = new Set([
    ...contract.protectedPaths,
    LAUNCHER_PATH,
    PROTOCOL_PATH,
    runtimePrefix(process.execPath),
    executable,
    runtimePrefix(await realpath(executable)),
  ]);
  for (const prefix of ['/opt/homebrew', '/usr/local', '/nix/store', '/System/Library/OpenSSL']) {
    if (await exists(prefix)) readPaths.add(prefix);
  }

  const lines = [
    `default_permissions = ${toml(PROFILE_NAME)}`,
    '',
    `[permissions.${PROFILE_NAME}.filesystem]`,
    '":minimal" = "read"',
    `${toml(contract.stateDir)} = "deny"`,
    `${toml(path.join(os.homedir(), '.outcomeloop', 'identity'))} = "deny"`,
  ];
  for (const readPath of [...readPaths].sort()) lines.push(`${toml(readPath)} = "read"`);
  for (const writePath of [contract.workspace, verifierHome, tempDir].sort()) lines.push(`${toml(writePath)} = "write"`);
  lines.push('', `[permissions.${PROFILE_NAME}.network]`, 'enabled = false', '');

  const configPath = path.join(codexHome, 'config.toml');
  await writeFile(configPath, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  await chmod(configPath, 0o600);
  return { controlDir, environment, executable };
}

export async function executeVerifierSandboxed(contract, options = {}) {
  const { controlDir, environment, executable } = await prepareSandbox(contract);
  const statusKey = randomBytes(32).toString('hex');
  const codexCommand = options.codexCommand || 'codex';
  const result = await spawnCapture(codexCommand, [
    'sandbox', '-P', PROFILE_NAME,
    '-C', controlDir,
    '--', process.execPath, LAUNCHER_PATH, contract.workspace,
    executable, ...contract.completion.command.slice(1),
  ], {
    cwd: controlDir,
    env: environment,
    input: `${statusKey}\n`,
    timeoutMs: options.timeoutMs,
    maxOutput: options.maxOutput ?? 1_000_000,
  });

  const parsed = extractVerifierStatus(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`, statusKey);
  if (result.timedOut) {
    return { ...result, code: 124, signal: result.signal, output: parsed.output };
  }
  if (!parsed.status) {
    throw new Error(`verifier_sandbox_failed:${bound(parsed.output || `exit=${result.code} signal=${result.signal}`, 2_000)}`);
  }
  if (parsed.status.launchError) {
    throw new Error(`verifier_launch_failed:${bound(parsed.status.launchError, 1_000)}`);
  }
  return {
    ...result,
    code: Number.isInteger(parsed.status.code) ? parsed.status.code : null,
    signal: typeof parsed.status.signal === 'string' ? parsed.status.signal : null,
    output: parsed.output,
  };
}
