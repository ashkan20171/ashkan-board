import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles, verifyManifest } from '../ops/backup-lib.mjs';

 test('backup manifest verifies database and uploaded file checksums', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ashkan-backup-'));
  try {
    await mkdir(join(root, 'uploads'));
    await writeFile(join(root, 'database.dump'), 'database bytes');
    await writeFile(join(root, 'uploads', 'file.bin'), 'attachment bytes');
    const files = await listFiles(root);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ format: 'ashkanboard-backup', version: 1, database: 'database.dump', uploadsIncluded: true, files }));
    const manifest = await verifyManifest(root);
    assert.equal(manifest.files.length, 2);
    assert.deepEqual(manifest.files.map((file) => file.path), ['database.dump', 'uploads/file.bin']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup verification rejects tampered files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ashkan-backup-tamper-'));
  try {
    await writeFile(join(root, 'database.dump'), 'original');
    const files = await listFiles(root);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ format: 'ashkanboard-backup', version: 1, files }));
    await writeFile(join(root, 'database.dump'), 'tampered');
    await assert.rejects(() => verifyManifest(root), /Checksum mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup verification rejects path traversal entries in a manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ashkan-backup-path-'));
  try {
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ format: 'ashkanboard-backup', version: 1, files: [{ path: '../outside', size: 0, sha256: '0'.repeat(64) }] }));
    await assert.rejects(() => verifyManifest(root), /Unsafe path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
