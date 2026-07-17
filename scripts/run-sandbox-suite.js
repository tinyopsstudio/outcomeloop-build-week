import { spawn } from 'node:child_process';

const child = spawn(process.execPath, [
  '--test',
  'test/agent-sandbox.test.js',
  'test/verifier-sandbox.test.js',
], {
  env: { ...process.env, OUTCOMELOOP_TEST_SANDBOX: '1' },
  stdio: 'inherit',
});
child.once('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
