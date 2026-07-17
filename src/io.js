import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SECRET_LABEL = '["\']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["\']?';
const SECRET_PATTERNS = [
  {
    pattern: new RegExp(`(${SECRET_LABEL}\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi'),
    replace: (_match, prefix) => `${prefix}"[REDACTED]"`,
  },
  {
    pattern: new RegExp(`(${SECRET_LABEL}\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\])*'`, 'gi'),
    replace: (_match, prefix) => `${prefix}'[REDACTED]'`,
  },
  {
    pattern: /(["']?authorization["']?\s*[:=]\s*)(?:bearer\s+)?[^"',;}\r\n]+/gi,
    replace: (_match, prefix) => `${prefix}[REDACTED]`,
  },
  {
    pattern: /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)[^"',;}\r\n]+/gi,
    replace: (_match, prefix) => `${prefix}[REDACTED]`,
  },
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replace: '[REDACTED]' },
  { pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g, replace: '[REDACTED]' },
];

export function redact(value) {
  let text = String(value ?? '');
  for (const { pattern, replace } of SECRET_PATTERNS) {
    text = text.replace(pattern, replace);
  }
  return text;
}

export function bound(value, limit = 16_000) {
  const text = redact(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} characters]`;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

export async function appendJsonLine(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function readJsonLines(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
