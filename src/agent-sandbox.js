import { access, chmod, copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PROFILE_POLICY = 'outcomeloop-agent';
const RUNTIME_PATHS = [
  '/opt/homebrew',
  '/usr/local',
  '/nix/store',
  '/System/Library/OpenSSL',
];
const COMMAND_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/Library/Apple/usr/bin',
];

function toml(value) {
  return JSON.stringify(String(value));
}

function runtimePrefix(filePath) {
  const normalized = path.resolve(filePath);
  for (const prefix of RUNTIME_PATHS) {
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

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function environmentTable(agentHome, tempDir, commandPath) {
  const values = {
    PATH: commandPath,
    HOME: agentHome,
    USERPROFILE: agentHome,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    NO_COLOR: '1',
  };
  for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[name]) values[name] = process.env[name];
  }
  return Object.entries(values)
    .map(([key, value]) => `${key} = ${toml(value)}`)
    .join(', ');
}

async function copyCredentials(sourceCodexHome, codexHome) {
  const source = path.join(sourceCodexHome, 'auth.json');
  const destination = path.join(codexHome, 'auth.json');
  if (path.resolve(source) === path.resolve(destination) || await exists(destination) || !await exists(source)) return;

  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await copyFile(source, temporaryPath);
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, destination);
}

export async function prepareAgentSandbox(contract) {
  const sourceCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sandboxRoot = path.join(contract.stateDir, 'agent-sandbox');
  const codexHome = path.join(sandboxRoot, 'codex');
  const agentHome = path.join(sandboxRoot, 'home');
  const tempDir = path.join(sandboxRoot, 'tmp');
  const directories = [codexHome, agentHome, tempDir];
  await Promise.all(directories.map((directory) => (
    mkdir(directory, { recursive: true, mode: 0o700 }).then(() => chmod(directory, 0o700))
  )));
  await copyCredentials(sourceCodexHome, codexHome);

  const workspaceAccess = contract.sandbox === 'workspace-write' ? 'write' : 'read';
  const runtimePaths = [runtimePrefix(process.execPath)];
  for (const candidate of RUNTIME_PATHS) {
    if (await exists(candidate) && !runtimePaths.includes(candidate)) runtimePaths.push(candidate);
  }
  const availableCommandPaths = [path.dirname(process.execPath)];
  for (const candidate of COMMAND_PATHS) {
    if (await exists(candidate) && !availableCommandPaths.includes(candidate)) availableCommandPaths.push(candidate);
  }
  const lines = [
    `default_permissions = ${toml(PROFILE_POLICY)}`,
    'approval_policy = "never"',
    '',
    `[permissions.${PROFILE_POLICY}.filesystem]`,
    '":minimal" = "read"',
    `${toml(contract.stateDir)} = "deny"`,
    `${toml(path.join(os.homedir(), '.outcomeloop', 'identity'))} = "deny"`,
    ...runtimePaths.sort().map((runtimePath) => `${toml(runtimePath)} = "read"`),
    `${toml(contract.workspace)} = ${toml(workspaceAccess)}`,
    `${toml(agentHome)} = "write"`,
    `${toml(tempDir)} = "write"`,
    '',
    `[permissions.${PROFILE_POLICY}.network]`,
    'enabled = false',
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    'ignore_default_excludes = false',
    `set = { ${environmentTable(agentHome, tempDir, availableCommandPaths.join(path.delimiter))} }`,
    '',
  ];

  const configPath = path.join(codexHome, 'config.toml');
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, lines.join('\n'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporaryPath, configPath);
  await chmod(configPath, 0o600);
  return {
    codexHome,
    configPath,
  };
}
