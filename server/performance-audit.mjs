import { getPostgresPool, closePostgresPool } from './store.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const expectedIndexes = [
  'tickets_workspace_created_id_idx',
  'tickets_workspace_updated_id_idx',
  'tickets_workspace_status_created_id_idx',
  'tickets_workspace_priority_created_id_idx',
  'tickets_title_trgm_idx',
  'tickets_description_trgm_idx',
  'workspace_notifications_unread_user_created_idx',
];

export function summarizeTableStats(rows = []) {
  return rows.map((row) => ({
    table: row.relname,
    liveRows: Number(row.n_live_tup || 0),
    deadRows: Number(row.n_dead_tup || 0),
    sequentialScans: Number(row.seq_scan || 0),
    indexScans: Number(row.idx_scan || 0),
  }));
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = await getPostgresPool();
  try {
    const [indexResult, statsResult, workspaceResult, extensionResult] = await Promise.all([
      pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()"),
      pool.query("SELECT relname,n_live_tup,n_dead_tup,seq_scan,idx_scan FROM pg_stat_user_tables WHERE relname IN ('tickets','workspace_notifications','ticket_comments','ticket_attachments') ORDER BY relname"),
      pool.query('SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1'),
      pool.query("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm') AS enabled"),
    ]);
    const installed = new Set(indexResult.rows.map((row) => row.indexname));
    const missingIndexes = expectedIndexes.filter((name) => !installed.has(name));
    const plans = {};
    if (workspaceResult.rows[0]?.id) {
      const workspaceId = workspaceResult.rows[0].id;
      const [pagePlan, searchPlan, unreadPlan] = await Promise.all([
        pool.query('EXPLAIN (FORMAT JSON) SELECT id,title,status,priority,created_at FROM tickets WHERE workspace_id=$1 ORDER BY created_at DESC,id ASC LIMIT 25', [workspaceId]),
        pool.query("EXPLAIN (FORMAT JSON) SELECT id,title FROM tickets WHERE workspace_id=$1 AND (title ILIKE $2 OR description ILIKE $2) ORDER BY created_at DESC,id ASC LIMIT 25", [workspaceId, '%performance%']),
        pool.query('EXPLAIN (FORMAT JSON) SELECT id,title,created_at FROM workspace_notifications WHERE workspace_id=$1 AND user_id=(SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 LIMIT 1) AND read_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 25', [workspaceId]),
      ]);
      plans.ticketPage = pagePlan.rows[0]?.['QUERY PLAN']?.[0]?.Plan || null;
      plans.ticketSearch = searchPlan.rows[0]?.['QUERY PLAN']?.[0]?.Plan || null;
      plans.unreadNotifications = unreadPlan.rows[0]?.['QUERY PLAN']?.[0]?.Plan || null;
    }
    const report = {
      generatedAt: new Date().toISOString(),
      status: missingIndexes.length || !extensionResult.rows[0]?.enabled ? 'needs-attention' : 'ok',
      pgTrgmEnabled: Boolean(extensionResult.rows[0]?.enabled),
      expectedIndexCount: expectedIndexes.length,
      missingIndexes,
      tables: summarizeTableStats(statsResult.rows),
      plans,
      note: 'EXPLAIN plans are estimates only; this audit does not run EXPLAIN ANALYZE or modify application data. Review plans against production-sized data and run ANALYZE after migration.',
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'ok') process.exitCode = 2;
  } finally {
    await closePostgresPool();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(async (error) => {
    process.stderr.write(`Performance audit failed: ${error.message}\n`);
    try { await closePostgresPool(); } catch {}
    process.exitCode = 1;
  });
}
