import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, redact, sha256 } from '../src/io.js';

test('redact removes common credential forms', () => {
  const keyLikeValue = ['sk', 'examplevalue123456'].join('-');
  const ghLikeValue = ['ghp', 'abcdefghijklmnopqrst'].join('_');
  const output = redact(`Authorization: Bearer abc123 password=hunter2 api_key=${keyLikeValue} ${ghLikeValue}`);
  for (const secret of ['abc123', 'hunter2', keyLikeValue, ghLikeValue]) assert.equal(output.includes(secret), false);
  assert.match(output, /\[REDACTED\]/);
});

test('redact removes secrets from JSON-formatted diagnostics', () => {
  const output = redact('{"password":"hunter2","Authorization":"Bearer abc123","access_token":"tokenvalue"}');
  for (const secret of ['hunter2', 'abc123', 'tokenvalue']) assert.equal(output.includes(secret), false);
  assert.match(output, /\[REDACTED\]/);
});

test('redact consumes complete quoted secret values containing whitespace', () => {
  const output = redact('{"password":"correct horse battery staple","secret":"alpha beta","api_key":"escaped \\"value\\" tail"}');
  for (const fragment of ['correct', 'horse', 'battery', 'staple', 'alpha', 'beta', 'escaped', 'value', 'tail']) {
    assert.equal(output.includes(fragment), false);
  }
  assert.equal(output, '{"password":"[REDACTED]","secret":"[REDACTED]","api_key":"[REDACTED]"}');
});

test('redact consumes unquoted secret values through the field boundary', () => {
  const output = redact('password=correct horse battery staple\nstatus=failed');
  for (const fragment of ['correct', 'horse', 'battery', 'staple']) assert.equal(output.includes(fragment), false);
  assert.equal(output, 'password=[REDACTED]\nstatus=failed');
});

test('canonical JSON is stable across key order', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(sha256('same'), sha256('same'));
});
