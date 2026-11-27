import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

export async function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

export async function listFiles(root) {
  const base = resolve(root);
  const output = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Backup refuses symbolic links: ${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) output.push({ path: relative(base, absolute).split('\\').join('/'), size: (await stat(absolute)).size, sha256: await sha256File(absolute) });
    }
  }
  await walk(base);
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

export async function verifyManifest(backupDir) {
  const root = resolve(backupDir);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'ashkanboard-backup' || manifest.version !== 1 || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported or invalid backup manifest.');
  }
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').includes('..') || file.path.includes(':')) throw new Error('Unsafe path in backup manifest.');
    const path = resolve(root, file.path);
    if (!path.startsWith(`${root}/`)) throw new Error('Unsafe path in backup manifest.');
    const actual = await sha256File(path);
    if (actual !== file.sha256) throw new Error(`Checksum mismatch: ${file.path}`);
    if ((await stat(path)).size !== file.size) throw new Error(`File size mismatch: ${file.path}`);
  }
  return manifest;
}
