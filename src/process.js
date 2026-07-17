import { spawn } from 'node:child_process';

const ACTIVE_TREES = new Map();
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
let shutdownHandlersInstalled = false;
let shuttingDown = false;

function signalProcessGroup(pid, signal) {
  if (!pid || process.platform === 'win32') return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function processGroupAlive(pid) {
  return signalProcessGroup(pid, 0);
}

async function killWindowsTree(pid) {
  if (!pid) return;
  await new Promise((resolve) => {
    const treeKiller = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    treeKiller.once('error', resolve);
    treeKiller.once('close', resolve);
  });
}

async function terminateTree(pid, graceMs = 100) {
  if (!pid) return;
  if (process.platform === 'win32') {
    await killWindowsTree(pid);
    return;
  }
  if (!processGroupAlive(pid)) return;
  signalProcessGroup(pid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (processGroupAlive(pid)) signalProcessGroup(pid, 'SIGKILL');
}

function removeShutdownHandlers() {
  if (!shutdownHandlersInstalled || ACTIVE_TREES.size) return;
  for (const signal of SHUTDOWN_SIGNALS) process.removeListener(signal, handleShutdownSignal);
  shutdownHandlersInstalled = false;
}

function handleShutdownSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const terminate of ACTIVE_TREES.values()) terminate('SIGTERM');
  setTimeout(() => {
    for (const terminate of ACTIVE_TREES.values()) terminate('SIGKILL');
    process.exit(SIGNAL_EXIT_CODES[signal] || 1);
  }, 100);
}

function registerProcessTree(pid) {
  if (!pid) return () => {};
  const terminate = process.platform === 'win32'
    ? () => { void killWindowsTree(pid); }
    : (signal) => { signalProcessGroup(pid, signal); };
  ACTIVE_TREES.set(pid, terminate);
  if (!shutdownHandlersInstalled) {
    for (const signal of SHUTDOWN_SIGNALS) process.on(signal, handleShutdownSignal);
    shutdownHandlersInstalled = true;
  }
  return () => {
    ACTIVE_TREES.delete(pid);
    removeShutdownHandlers();
  };
}

export async function spawnCapture(command, args, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutput = options.maxOutput ?? 2_000_000;
  const useProcessGroup = process.platform !== 'win32';

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: useProcessGroup,
      shell: false,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const unregister = registerProcessTree(child.pid);

    let stdout = '';
    let stderr = '';
    let overflow = false;
    let timedOut = false;
    let spawnError = null;
    let cleanupPromise = null;

    const collect = (target, chunk) => {
      const next = target + chunk.toString('utf8');
      if (next.length <= maxOutput) return next;
      overflow = true;
      return next.slice(0, maxOutput);
    };

    child.stdout.on('data', (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = collect(stderr, chunk);
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    if (options.input !== undefined) {
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') spawnError ||= error;
      });
      child.stdin.end(options.input);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      cleanupPromise = terminateTree(child.pid);
    }, timeoutMs);

    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      try {
        if (cleanupPromise) await cleanupPromise;
        await terminateTree(child.pid);
      } finally {
        unregister();
      }
      if (spawnError) {
        reject(spawnError);
        return;
      }
      resolve({
        command,
        args,
        code: timedOut ? 124 : code,
        signal: signal || null,
        stdout,
        stderr,
        overflow,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
