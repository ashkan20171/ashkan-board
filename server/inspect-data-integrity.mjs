import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getPostgresPool } from './store.mjs';
import { buildDataIntegrityReport, DOMAIN_SPECS, inspectAttachmentFiles } from './data-integrity.mjs';

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. No database was inspected.');
  const pool = await getPostgresPool();
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const legacyCheck = await client.query("SELECT to_regclass('ashkan_app_state') IS NOT NULL AS present");
      const legacyTablePresent = Boolean(legacyCheck.rows[0]?.present);
      let legacyState = null;
      if (legacyTablePresent) {
        const legacy = await client.query('SELECT state FROM ashkan_app_state WHERE id=1');
        legacyState = legacy.rows[0]?.state || null;
      }
      const relationalByDomain = {};
      for (const spec of DOMAIN_SPECS) {
        const result = await client.query(`SELECT * FROM ${spec.table}`);
        relationalByDomain[spec.key] = result.rows;
      }
      const fkResult = await client.query(`SELECT conname AS name, conrelid::regclass::text AS table, convalidated AS validated
        FROM pg_constraint WHERE contype='f' AND connamespace=current_schema()::regnamespace ORDER BY conrelid::regclass::text,conname`);
      const orphanResult = await client.query(`
        SELECT 'memberships.user' AS check_name, COUNT(*)::int AS count FROM workspace_memberships m LEFT JOIN users u ON u.id=m.user_id WHERE u.id IS NULL
        UNION ALL SELECT 'memberships.workspace', COUNT(*)::int FROM workspace_memberships m LEFT JOIN workspaces w ON w.id=m.workspace_id WHERE w.id IS NULL
        UNION ALL SELECT 'tickets.workspace', COUNT(*)::int FROM tickets t LEFT JOIN workspaces w ON w.id=t.workspace_id WHERE w.id IS NULL
        UNION ALL SELECT 'tickets.creator', COUNT(*)::int FROM tickets t LEFT JOIN users u ON u.id=t.created_by WHERE u.id IS NULL
        UNION ALL SELECT 'comments.ticket_workspace', COUNT(*)::int FROM ticket_comments c LEFT JOIN tickets t ON t.id=c.ticket_id AND t.workspace_id=c.workspace_id WHERE t.id IS NULL
        UNION ALL SELECT 'comments.author', COUNT(*)::int FROM ticket_comments c LEFT JOIN users u ON u.id=c.author_id WHERE u.id IS NULL
        UNION ALL SELECT 'attachments.ticket_workspace', COUNT(*)::int FROM ticket_attachments a LEFT JOIN tickets t ON t.id=a.ticket_id AND t.workspace_id=a.workspace_id WHERE t.id IS NULL
        UNION ALL SELECT 'attachments.uploader', COUNT(*)::int FROM ticket_attachments a LEFT JOIN users u ON u.id=a.uploaded_by WHERE u.id IS NULL
        UNION ALL SELECT 'notifications.recipient', COUNT(*)::int FROM workspace_notifications n LEFT JOIN users u ON u.id=n.user_id WHERE u.id IS NULL
        UNION ALL SELECT 'notifications.workspace', COUNT(*)::int FROM workspace_notifications n LEFT JOIN workspaces w ON w.id=n.workspace_id WHERE w.id IS NULL
        UNION ALL SELECT 'imports.workspace', COUNT(*)::int FROM ticket_import_batches b LEFT JOIN workspaces w ON w.id=b.workspace_id WHERE w.id IS NULL
        UNION ALL SELECT 'imports.actor', COUNT(*)::int FROM ticket_import_batches b LEFT JOIN users u ON u.id=b.imported_by WHERE u.id IS NULL
      `);
      const attachmentRows = await client.query('SELECT id,storage_name,size_bytes,content_sha256 FROM ticket_attachments ORDER BY id');
      const attachmentReport = await inspectAttachmentFiles(attachmentRows.rows, resolve(process.env.UPLOAD_DIR || './data/uploads'));
      await client.query('COMMIT');
      const report = buildDataIntegrityReport({ legacyState, relationalByDomain, foreignKeys: fkResult.rows, orphanChecks: orphanResult.rows.map((row) => ({ name: row.check_name, count: Number(row.count) })), attachmentReport, legacyTablePresent });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (process.argv.includes('--strict') && report.summary.status !== 'verified') process.exitCode = 2;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) run().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
