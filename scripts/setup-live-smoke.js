import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContract } from '../src/contract.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = path.join(root, '.demo', 'live-smoke');
const workspace = path.join(demoRoot, 'workspace');
const verifierDir = path.join(demoRoot, 'verifier');

await rm(demoRoot, { recursive: true, force: true });
await mkdir(workspace, { recursive: true });
await mkdir(verifierDir, { recursive: true });

await writeFile(path.join(workspace, 'order.js'), `export function shippingDecision(order) {
  if (!order || typeof order !== 'object') return { status: 'manual_review', reason: 'invalid_order' };
  if (order.paymentStatus !== 'failed') return { status: 'ready_to_ship', reason: 'payment_cleared' };
  return { status: 'hold', reason: 'payment_failed' };
}
`, 'utf8');

await writeFile(path.join(verifierDir, 'verify.js'), `import assert from 'node:assert/strict';
import { shippingDecision } from '../workspace/order.js';

assert.deepEqual(
  shippingDecision({ id: 'ord_paid', paymentStatus: 'paid' }),
  { status: 'ready_to_ship', reason: 'payment_cleared' },
);
assert.deepEqual(
  shippingDecision({ id: 'ord_pending', paymentStatus: 'pending' }),
  { status: 'hold', reason: 'payment_pending' },
);
assert.deepEqual(
  shippingDecision({ id: 'ord_failed', paymentStatus: 'failed' }),
  { status: 'hold', reason: 'payment_failed' },
);
assert.deepEqual(
  shippingDecision(null),
  { status: 'manual_review', reason: 'invalid_order' },
);
console.log('checkout invariant verified');
`, 'utf8');

await writeFile(path.join(demoRoot, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');
await writeFile(path.join(workspace, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');

const contract = {
  version: 1,
  objective: 'Repair order.js so pending payments remain on hold while paid and failed orders preserve their expected behavior. Do not edit verify.js. Run the verifier and make the smallest correct change.',
  workspace: './workspace',
  model: 'gpt-5.6-terra',
  sandbox: 'workspace-write',
  maxIterations: 3,
  maxRuntimeMinutes: 10,
  constraints: [
    'Do not edit verify.js or replace its assertions.',
    'Keep the public shippingDecision API stable.',
    'Make the smallest implementation change that satisfies all cases.',
  ],
  allowedGates: [],
  protectedPaths: ['./verifier/verify.js'],
  loadExecPolicyRules: false,
  completion: {
    command: ['node', '../verifier/verify.js'],
    successExitCode: 0,
    timeoutMs: 10_000,
  },
};
const contractPath = path.join(demoRoot, 'outcomeloop.json');
await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
await rm((await loadContract(contractPath)).stateDir, { recursive: true, force: true });
process.stdout.write(`${demoRoot}\n`);
