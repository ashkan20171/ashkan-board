import { getPostgresPool } from './store.mjs';

if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is required. No database was inspected.\n');
  process.exitCode = 1;
} else {
  const pool = await getPostgresPool();
  try {
    const required = [
      'users', 'workspaces', 'workspace_memberships', 'tickets', 'auth_refresh_tokens',
      'password_reset_tokens', 'workspace_invitations', 'workspace_audit_logs',
      'workspace_notifications', 'ticket_comments', 'ticket_attachments',
      'workspace_presence', 'ticket_import_batches',
    ];
    const [tables, migrations, aggregate] = await Promise.all([
      pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=ANY($1::text[])`, [required]),
      pool.query('SELECT version FROM schema_migrations ORDER BY version'),
      pool.query(`SELECT to_regclass('ashkan_app_state') IS NOT NULL AS present`),
    ]);
    const found = new Set(tables.rows.map((row) => row.table_name));
    const missing = required.filter((name) => !found.has(name));
    let aggregateRows = null;
    if (aggregate.rows[0]?.present) {
      const count = await pool.query('SELECT COUNT(*)::bigint AS count FROM ashkan_app_state');
      aggregateRows = Number(count.rows[0].count);
    }
    const report = {
      checkedAt: new Date().toISOString(),
      persistenceMode: process.env.PERSISTENCE_MODE || 'not-set',
      normalizedRuntimeEnabled: process.env.PERSISTENCE_MODE === 'normalized',
      requiredTables: { expected: required.length, found: found.size, missing },
      migrationsApplied: migrations.rows.map((row) => row.version),
      legacyAggregate: {
        tablePresent: Boolean(aggregate.rows[0]?.present),
        rows: aggregateRows,
        runtimeReadWrite: 'blocked by application guard in normalized mode',
        dropEligible: false,
        reason: 'Retain until historical JSONB-only fields and files are reconciled, exported, and an operator explicitly approves retirement.',
      },
      status: missing.length ? 'failed' : 'review-required',
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (missing.length || process.env.PERSISTENCE_MODE !== 'normalized') process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
