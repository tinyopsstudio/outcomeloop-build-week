import { spawn } from 'node:child_process';
import { formatVerifierStatus } from './verifier-protocol.js';

async function readStatusKey() {
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk.toString('utf8');
    if (value.length > 256) throw new Error('verifier_status_key_too_large');
  }
  const key = value.trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('verifier_status_key_invalid');
  return key;
}

const [, , workspace, command, ...args] = process.argv;
const key = await readStatusKey();
let status;

if (!workspace || !command) {
  status = { code: null, signal: null, launchError: 'verifier_command_missing' };
} else {
  const environment = { ...process.env };
  delete environment.CODEX_HOME;
  const child = spawn(command, args, {
    cwd: workspace,
    env: environment,
    detached: false,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  status = await new Promise((resolve) => {
    let launchError = null;
    child.once('error', (error) => { launchError = error.message; });
    child.once('close', (code, signal) => resolve({ code, signal: signal || null, launchError }));
  });
}

process.stderr.write(`\n${formatVerifierStatus(status, key)}\n`);
