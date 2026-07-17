import { createHmac, timingSafeEqual } from 'node:crypto';

const MARKER = 'OUTCOMELOOP_VERIFIER_STATUS:';
const MARKER_PATTERN = /^OUTCOMELOOP_VERIFIER_STATUS:([A-Za-z0-9_-]+)\.([a-f0-9]{64})\r?$/gm;

function signature(payload, key) {
  return createHmac('sha256', key).update(payload).digest('hex');
}

export function formatVerifierStatus(status, key) {
  const payload = Buffer.from(JSON.stringify(status)).toString('base64url');
  return `${MARKER}${payload}.${signature(payload, key)}`;
}

export function extractVerifierStatus(text, key) {
  let status = null;
  let validMarker = null;
  for (const match of String(text).matchAll(MARKER_PATTERN)) {
    const expected = Buffer.from(signature(match[1], key));
    const actual = Buffer.from(match[2]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) continue;
    try {
      status = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      validMarker = match[0];
    } catch {
      // A malformed authenticated payload fails closed below.
    }
  }
  return {
    status,
    output: validMarker ? String(text).replace(validMarker, '').trim() : String(text),
  };
}
