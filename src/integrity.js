import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256 } from './io.js';

async function collect(targetPath, rootPath, rootIndex, entries) {
  const stat = await lstat(targetPath);
  const relative = path.relative(rootPath, targetPath) || '.';
  if (stat.isSymbolicLink()) {
    const error = new Error(`protected_path_symlink_not_allowed:${targetPath}`);
    error.code = 'OUTCOMELOOP_PROTECTED_SYMLINK';
    throw error;
  }
  if (stat.isDirectory()) {
    entries.push({ root: rootIndex, path: relative, type: 'directory', mode: stat.mode & 0o7777 });
    const children = await readdir(targetPath);
    for (const child of children.sort()) await collect(path.join(targetPath, child), rootPath, rootIndex, entries);
    return;
  }
  if (stat.isFile()) {
    entries.push({
      root: rootIndex,
      path: relative,
      type: 'file',
      mode: stat.mode & 0o7777,
      size: stat.size,
      hash: sha256(await readFile(targetPath)),
    });
    return;
  }
  const error = new Error(`protected_path_type_not_allowed:${targetPath}`);
  error.code = 'OUTCOMELOOP_PROTECTED_TYPE';
  throw error;
}

export async function protectedSnapshot(protectedPaths) {
  const entries = [];
  const roots = [...protectedPaths].sort();
  for (const [rootIndex, targetPath] of roots.entries()) {
    await collect(targetPath, targetPath, rootIndex, entries);
  }
  return {
    fingerprint: sha256(canonicalJson(entries)),
    roots: protectedPaths.length,
    entries: entries.length,
  };
}
