import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContract } from '../src/contract.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = path.join(root, '.demo', 'resume-live');
const workspace = path.join(demoRoot, 'workspace');
const verifierDir = path.join(demoRoot, 'verifier');

await rm(demoRoot, { recursive: true, force: true });
await mkdir(workspace, { recursive: true });
await mkdir(verifierDir, { recursive: true });

await writeFile(path.join(demoRoot, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');
await writeFile(path.join(workspace, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');

await writeFile(path.join(verifierDir, 'verify.js'), `import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const readJson = async (file) => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
let proposal;
try {
  proposal = await readJson('../workspace/proposal.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.error('proposal.json missing; create exactly {"service":"OutcomeLoop","protocolVersion":1}');
  process.exit(2);
}
assert.deepEqual(proposal, { service: 'OutcomeLoop', protocolVersion: 1 });

let challenge;
try {
  challenge = await readJson('../workspace/challenge.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  challenge = { id: 'acceptance-1', nonce: randomBytes(18).toString('hex') };
  await writeFile(new URL('../workspace/challenge.json', import.meta.url), JSON.stringify(challenge, null, 2) + '\\n');
  console.error('acceptance challenge issued in challenge.json; create response.json with id and sha256(nonce + ":OutcomeLoop")');
  process.exit(7);
}

const response = await readJson('../workspace/response.json');
const expectedDigest = createHash('sha256').update(challenge.nonce + ':OutcomeLoop').digest('hex');
assert.deepEqual(response, { id: challenge.id, digest: expectedDigest });

let confirmation;
try {
  confirmation = await readJson('../workspace/confirmation.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  confirmation = { id: 'confirmation-1', nonce: randomBytes(18).toString('hex') };
  await writeFile(new URL('../workspace/confirmation.json', import.meta.url), JSON.stringify(confirmation, null, 2) + '\\n');
  console.error('confirmation issued in confirmation.json; create final.json with id and sha256(nonce + ":OutcomeLoop-final") as ack');
  process.exit(8);
}

const final = await readJson('../workspace/final.json');
const expectedAck = createHash('sha256').update(confirmation.nonce + ':OutcomeLoop-final').digest('hex');
assert.deepEqual(final, { id: confirmation.id, ack: expectedAck });
console.log('external acceptance handshake verified');
`, 'utf8');

const contract = {
  version: 1,
  objective: 'Complete the external acceptance handshake. Create proposal.json with exactly {"service":"OutcomeLoop","protocolVersion":1}. The external verifier may later issue challenge.json and confirmation.json; respond by creating response.json and final.json exactly as their instructions require. Do not invent either external file and do not access or run the verifier yourself.',
  workspace: './workspace',
  model: 'gpt-5.6-terra',
  sandbox: 'workspace-write',
  maxIterations: 5,
  maxRuntimeMinutes: 10,
  constraints: [
    'Do not access, run, edit, replace, or bypass the external verifier.',
    'Never invent challenge.json or confirmation.json; only respond after the external system creates them.',
    'Write only proposal.json, response.json, or final.json in the workspace.',
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
