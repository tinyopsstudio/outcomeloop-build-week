import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  '.codex-plugin/plugin.json',
  'skills/outcome-loop/SKILL.md',
  'skills/outcome-loop/agents/openai.yaml',
  'schemas/outcomeloop.schema.json',
  'schemas/turn.schema.json',
  'src/cli.js',
  'src/agent-sandbox.js',
  'src/verifier-launcher.js',
  'src/verifier-protocol.js',
  'src/verifier-sandbox.js',
  'public/index.html',
  'LICENSE',
];

for (const relativePath of required) await access(path.join(root, relativePath));
const manifest = JSON.parse(await readFile(path.join(root, '.codex-plugin/plugin.json'), 'utf8'));
assert.equal(manifest.name, 'outcomeloop');
assert.equal(manifest.author.name, 'TinyOps Studio LLC');
for (const schema of ['schemas/outcomeloop.schema.json', 'schemas/turn.schema.json']) {
  JSON.parse(await readFile(path.join(root, schema), 'utf8'));
}
const searchable = await Promise.all(required.map((file) => readFile(path.join(root, file), 'utf8')));
assert.equal(searchable.some((text) => text.includes('[TODO')), false);
assert.notEqual((await stat(path.join(root, 'src/cli.js'))).mode & 0o111, 0, 'src/cli.js must be executable');
const demoData = await readFile(path.join(root, 'public', 'demo-data.json'), 'utf8');
assert.equal(demoData.includes(os.homedir()), false, 'public demo data must not expose the local home path');
assert.equal(demoData.includes(root), false, 'public demo data must not expose the local project path');
process.stdout.write(`project checks passed (${required.length} required files)\n`);
