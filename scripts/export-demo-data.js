import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContract } from '../src/contract.js';
import { redact } from '../src/io.js';
import { loadTrustedPublicKey, verifyReceiptIntegrity } from '../src/receipt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = await loadContract(path.join(root, '.demo', 'resume-live', 'outcomeloop.json'));
const source = contract.stateDir;
const readJson = async (name) => JSON.parse(await readFile(path.join(source, name), 'utf8'));
const state = await readJson('state.json');
const receipt = await readJson('receipt.json');
const trustedPublicKey = (await loadTrustedPublicKey()).publicKey;
const events = (await readFile(path.join(source, 'events.jsonl'), 'utf8'))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .map(({ diagnostics: _diagnostics, objective: _objective, ...event }) => event);

const privatePaths = [
  [contract.workspace, '[WORKSPACE]'],
  [contract.stateDir, '[STATE]'],
  [root, '[PROJECT]'],
  [os.homedir(), '[HOME]'],
].sort((left, right) => right[0].length - left[0].length);

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  if (typeof value !== 'string') return value;
  let sanitized = redact(value);
  for (const [privatePath, replacement] of privatePaths) {
    sanitized = sanitized.split(privatePath).join(replacement);
  }
  return sanitized;
}

const payload = {
  state: {
    version: state.version,
    objective: state.objective,
    status: state.status,
    model: state.model,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    elapsedMs: state.elapsedMs,
    updatedAt: state.updatedAt,
    latestAgentReport: state.latestAgentReport,
    latestVerifier: state.latestVerifier,
  },
  events,
  receipt: {
    receiptHash: receipt.receiptHash,
    codexSessionId: receipt.codexSessionId,
    iterations: receipt.iterations,
    elapsedMs: receipt.elapsedMs,
    verifiedAt: receipt.verifiedAt,
    verifier: receipt.verifier,
    protectedFiles: receipt.protectedFiles,
    seal: receipt.seal,
  },
  integrity: verifyReceiptIntegrity(receipt, trustedPublicKey),
};

await writeFile(path.join(root, 'public', 'demo-data.json'), `${JSON.stringify(sanitize(payload), null, 2)}\n`, 'utf8');
process.stdout.write(`${path.join(root, 'public', 'demo-data.json')}\n`);
