import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPostgresPool } from './store.mjs';

export async function inspectChecksumBackfill(rows, uploadDir) {
  const root = resolve(uploadDir); const eligible = []; const missing = []; const mismatched = []; const unsafe = [];
  for (const row of rows) {
    if (row.content_sha256) continue;
    const name = String(row.storage_name || '');
    if (!name || basename(name) !== name || name === '.' || name === '..' || /[\\/\0]/.test(name)) { unsafe.push(row.id); continue; }
    try {
      const info = await lstat(join(root, name));
      if (!info.isFile()) { unsafe.push(row.id); continue; }
      const bytes = await readFile(join(root, name));
      if (bytes.length !== Number(row.size_bytes)) { mismatched.push(row.id); continue; }
      eligible.push({ id: row.id, storageName: name, sha256: createHash('sha256').update(bytes).digest('hex') });
    } catch (error) { if (error.code === 'ENOENT') missing.push(row.id); else throw error; }
  }
  return { eligible, missing, mismatched, unsafe };
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const apply = process.argv.includes('--apply'); const pool = await getPostgresPool();
  try {
    const client = await pool.connect();
    try {
      await client.query(apply ? 'BEGIN' : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await client.query(`SELECT id,storage_name,size_bytes,content_sha256 FROM ticket_attachments WHERE content_sha256 IS NULL ORDER BY id${apply ? ' FOR UPDATE' : ''}`);
      const report = await inspectChecksumBackfill(result.rows, resolve(process.env.UPLOAD_DIR || './data/uploads'));
      const blocked = report.missing.length || report.mismatched.length || report.unsafe.length;
      if (apply && !blocked) for (const item of report.eligible) await client.query('UPDATE ticket_attachments SET content_sha256=$1 WHERE id=$2 AND content_sha256 IS NULL', [item.sha256, item.id]);
      await client.query(apply && !blocked ? 'COMMIT' : 'ROLLBACK');
      process.stdout.write(`${JSON.stringify({ mode: apply ? (blocked ? 'apply-blocked' : 'apply') : 'dry-run', scanned: result.rowCount, updated: apply && !blocked ? report.eligible.length : 0, eligible: report.eligible.length, missingFiles: report.missing.length, sizeMismatches: report.mismatched.length, unsafeNames: report.unsafe.length, samples: { missing: report.missing.slice(0,10), sizeMismatches: report.mismatched.slice(0,10), unsafe: report.unsafe.slice(0,10) } }, null, 2)}\n`);
      if (report.missing.length || report.mismatched.length || report.unsafe.length) process.exitCode = 2;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) run().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
