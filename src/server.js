import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, readJsonLines } from './io.js';
import { loadTrustedPublicKey, verifyReceiptIntegrity } from './receipt.js';
import { protectedSnapshot } from './integrity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

async function maybeJson(filePath, fallback = null) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function createDashboardServer({
  stateDir,
  trustedPublicKey = null,
  loadPublicKey = loadTrustedPublicKey,
  contract = null,
}) {
  let cachedPublicKey = trustedPublicKey;
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/state') {
        const state = await maybeJson(path.join(stateDir, 'state.json'));
        return send(response, state ? 200 : 404, JSON.stringify(state || { error: 'state_not_found' }));
      }
      if (url.pathname === '/api/events') {
        const events = await readJsonLines(path.join(stateDir, 'events.jsonl'));
        return send(response, 200, JSON.stringify(events));
      }
      if (url.pathname === '/api/receipt') {
        const receipt = await maybeJson(path.join(stateDir, 'receipt.json'));
        return send(response, receipt ? 200 : 404, JSON.stringify(receipt || { error: 'receipt_not_found' }));
      }
      if (url.pathname === '/api/integrity') {
        const receipt = await maybeJson(path.join(stateDir, 'receipt.json'));
        if (receipt && !cachedPublicKey) {
          try {
            const loaded = await loadPublicKey();
            cachedPublicKey = loaded?.publicKey || loaded;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        const receiptSignature = receipt ? verifyReceiptIntegrity(receipt, cachedPublicKey) : false;
        let protectedFiles = false;
        if (receipt && contract) {
          try {
            const currentProtection = await protectedSnapshot(contract.protectedPaths);
            protectedFiles = currentProtection.fingerprint === receipt.protectedFiles?.fingerprint;
          } catch {
            protectedFiles = false;
          }
        }
        const contractHash = Boolean(receipt && contract && receipt.contractHash === contract.hash);
        const integrity = receiptSignature && protectedFiles && contractHash;
        return send(response, receipt ? 200 : 404, JSON.stringify({ integrity, receiptSignature, protectedFiles, contractHash }));
      }

      const relativePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const filePath = path.resolve(PUBLIC_DIR, relativePath);
      if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
        return send(response, 403, JSON.stringify({ error: 'forbidden' }));
      }
      try {
        const content = await readFile(filePath);
        return send(response, 200, content, TYPES[path.extname(filePath)] || 'application/octet-stream');
      } catch (error) {
        if (error.code === 'ENOENT') return send(response, 404, JSON.stringify({ error: 'not_found' }));
        throw error;
      }
    } catch (error) {
      return send(response, 500, JSON.stringify({ error: error.message }));
    }
  });
}

export async function serveDashboard({
  stateDir,
  trustedPublicKey = null,
  loadPublicKey = loadTrustedPublicKey,
  contract = null,
  port = 4173,
  host = '127.0.0.1',
}) {
  const server = createDashboardServer({ stateDir, trustedPublicKey, loadPublicKey, contract });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
