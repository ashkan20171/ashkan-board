import { getPostgresPool } from './store.mjs';

if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is required. No database was inspected.\n');
  process.exitCode = 1;
} else {
  const pool = await getPostgresPool();
  const tables = [
    'users', 'workspaces', 'workspace_memberships', 'tickets', 'auth_refresh_tokens',
    'password_reset_tokens', 'workspace_invitations', 'workspace_audit_logs',
    'workspace_notifications', 'ticket_comments', 'ticket_attachments',
    'workspace_presence', 'ticket_import_batches',
  ];
  try {
    const migrationRows = await pool.query('SELECT version, applied_at FROM schema_migrations ORDER BY version');
    const tableRows = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema=current_schema() AND table_name = ANY($1::text[])`, [tables],
    );
    const present = new Set(tableRows.rows.map((row) => row.table_name));
    const missing = tables.filter((table) => !present.has(table));
    if (missing.length) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(), migrationsApplied: migrationRows.rowCount, tablesExpected: tables.length, tablesFound: tables.length - missing.length, missingTables: missing }, null, 2)}\n`);
      process.exitCode = 1;
    } else {
    const counts = {};
    for (const table of tables) {
      const result = await pool.query(`SELECT COUNT(*)::bigint AS count FROM ${table}`);
      counts[table] = Number(result.rows[0].count);
    }
    const constraints = await pool.query(
      `SELECT conrelid::regclass::text AS table_name, contype
       FROM pg_constraint WHERE connamespace=current_schema()::regnamespace
         AND contype IN ('f','p','u','c')`,
    );
    const checks = await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM tickets t LEFT JOIN workspaces w ON w.id=t.workspace_id WHERE w.id IS NULL) AS orphan_tickets,
        (SELECT COUNT(*)::int FROM workspace_memberships m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN workspaces w ON w.id=m.workspace_id WHERE u.id IS NULL OR w.id IS NULL) AS orphan_memberships,
        (SELECT COUNT(*)::int FROM ticket_import_batches b LEFT JOIN users u ON u.id=b.imported_by LEFT JOIN workspaces w ON w.id=b.workspace_id WHERE u.id IS NULL OR w.id IS NULL) AS orphan_import_batches`,
    );
    const integrity = checks.rows[0];
    const report = {
      status: missing.length || Object.values(integrity).some((value) => Number(value) > 0) ? 'failed' : 'ok',
      checkedAt: new Date().toISOString(),
      migrationsApplied: migrationRows.rowCount,
      tablesExpected: tables.length,
      tablesFound: tables.length - missing.length,
      missingTables: missing,
      relationalRowCounts: counts,
      relationalConstraintsFound: constraints.rowCount,
      integrity,
      note: 'JSONB aggregate parity is intentionally not treated as a pass/fail condition because migrated normalized tables are authoritative for their domains.',
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'ok') process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}
