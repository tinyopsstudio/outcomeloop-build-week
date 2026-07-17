import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signPayload,
  verify as verifyPayload,
} from 'node:crypto';
import { chmod, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, sha256 } from './io.js';
import { spawnCapture } from './process.js';

const IDENTITY_DIR = path.join(os.homedir(), '.outcomeloop', 'identity');
const PRIVATE_KEY_PATH = path.join(IDENTITY_DIR, 'ed25519-private.pem');
const PUBLIC_KEY_PATH = path.join(IDENTITY_DIR, 'ed25519-public.pem');

async function publishCompleteFile(filePath, content, mode) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode, flag: 'wx' });
  try {
    await link(temporaryPath, filePath);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  await chmod(filePath, mode);
  return readFile(filePath, 'utf8');
}

function asPublicKey(key) {
  return key?.type === 'public' ? key : createPublicKey(key);
}

function keyId(publicKey) {
  const der = asPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  return sha256(der);
}

export async function loadSigningIdentity({ create = true } = {}) {
  await mkdir(IDENTITY_DIR, { recursive: true, mode: 0o700 });
  await chmod(IDENTITY_DIR, 0o700);

  let privateKeyPem;
  try {
    privateKeyPem = await readFile(PRIVATE_KEY_PATH, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    const pair = generateKeyPairSync('ed25519');
    const generated = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    privateKeyPem = await publishCompleteFile(PRIVATE_KEY_PATH, generated, 0o600);
  }
  await chmod(PRIVATE_KEY_PATH, 0o600);

  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const publishedPublicKey = await publishCompleteFile(PUBLIC_KEY_PATH, publicKeyPem, 0o644);
  if (publishedPublicKey !== publicKeyPem) throw new Error('signing_identity_public_key_mismatch');
  return { privateKey, publicKey, publicKeyPem, keyId: keyId(publicKey) };
}

export async function loadTrustedPublicKey() {
  let publicKeyPem;
  try {
    publicKeyPem = await readFile(PUBLIC_KEY_PATH, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    publicKeyPem = (await loadSigningIdentity({ create: false })).publicKeyPem;
  }
  const publicKey = createPublicKey(publicKeyPem);
  return { publicKey, publicKeyPem, keyId: keyId(publicKey) };
}

async function gitValue(workspace, args) {
  try {
    const disabledHooksPath = path.join(IDENTITY_DIR, `disabled-git-hooks-${process.pid}-${randomUUID()}`);
    const result = await spawnCapture('git', [
      '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${disabledHooksPath}`,
      ...args,
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeoutMs: 10_000,
      maxOutput: 200_000,
    });
    return result.code === 0 ? result.stdout.trim() : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function workspaceSnapshot(workspace) {
  const head = await gitValue(workspace, ['rev-parse', 'HEAD']);
  const status = await gitValue(workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
  return {
    gitHead: head,
    statusHash: status === null ? null : sha256(status),
    dirtyEntries: status ? status.split(/\r?\n/).filter(Boolean).length : 0,
  };
}

export function sealReceipt(value, identity) {
  if (!identity?.privateKey || !identity?.publicKey) throw new Error('signing_identity_required');
  const payload = { ...value };
  delete payload.receiptHash;
  delete payload.seal;
  const receiptHash = sha256(canonicalJson(payload));
  const signed = { ...payload, receiptHash };
  const signature = signPayload(null, Buffer.from(canonicalJson(signed)), identity.privateKey).toString('base64');
  return {
    ...signed,
    seal: {
      algorithm: 'Ed25519',
      keyId: identity.keyId,
      signature,
    },
  };
}

export function verifyReceiptIntegrity(receipt, trustedPublicKey) {
  if (!receipt || typeof receipt !== 'object' || !receipt.receiptHash || !receipt.seal || !trustedPublicKey) return false;
  if (receipt.seal.algorithm !== 'Ed25519') return false;
  let publicKey;
  try {
    publicKey = asPublicKey(trustedPublicKey.publicKey || trustedPublicKey);
  } catch {
    return false;
  }
  if (receipt.seal.keyId !== keyId(publicKey)) return false;
  const payload = { ...receipt };
  delete payload.receiptHash;
  delete payload.seal;
  if (sha256(canonicalJson(payload)) !== receipt.receiptHash) return false;
  const signed = { ...payload, receiptHash: receipt.receiptHash };
  try {
    return verifyPayload(
      null,
      Buffer.from(canonicalJson(signed)),
      publicKey,
      Buffer.from(receipt.seal.signature, 'base64'),
    );
  } catch {
    return false;
  }
}
