import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getPostgresPool } from './store.mjs';

const DOMAINS = [
  { key: 'users', table: 'users', select: 'id', legacyKey: (row) => row?.id },
  { key: 'workspaces', table: 'workspaces', select: 'id', legacyKey: (row) => row?.id },
  { key: 'memberships', table: 'workspace_memberships', select: 'workspace_id, user_id', legacyKey: (row) => [row?.workspaceId, row?.userId] },
  { key: 'tickets', table: 'tickets', select: 'id', legacyKey: (row) => row?.id },
  { key: 'refreshTokens', table: 'auth_refresh_tokens', select: 'id', legacyKey: (row) => row?.id },
  { key: 'passwordResets', table: 'password_reset_tokens', select: 'id', legacyKey: (row) => row?.id },
  { key: 'invitations', table: 'workspace_invitations', select: 'id', legacyKey: (row) => row?.id },
  { key: 'auditLogs', table: 'workspace_audit_logs', select: 'id', legacyKey: (row) => row?.id },
  { key: 'notifications', table: 'workspace_notifications', select: 'id', legacyKey: (row) => row?.id },
  { key: 'comments', table: 'ticket_comments', select: 'id', legacyKey: (row) => row?.id },
  { key: 'attachments', table: 'ticket_attachments', select: 'id', legacyKey: (row) => row?.id },
  { key: 'presence', table: 'workspace_presence', select: 'workspace_id, user_id', legacyKey: (row) => [row?.workspaceId, row?.userId] },
  { key: 'importBatches', table: 'ticket_import_batches', select: 'id', legacyKey: (row) => row?.id },
];

function keyOf(value) {
  if (Array.isArray(value)) {
    if (value.some((part) => part === undefined || part === null || part === '')) return null;
    return JSON.stringify(value.map(String));
  }
  return value === undefined || value === null || value === '' ? null : String(value);
}

function summarizeDomain(domain, legacyRows, relationalRows) {
  const legacyKeys = (Array.isArray(legacyRows) ? legacyRows : []).map((row) => keyOf(domain.legacyKey(row)));
  const validLegacyKeys = legacyKeys.filter(Boolean);
  const relationalKeys = relationalRows.map((row) => keyOf(domain.table === 'workspace_memberships' || domain.table === 'workspace_presence'
    ? [row.workspace_id, row.user_id]
    : row.id)).filter(Boolean);
  const legacySet = new Set(validLegacyKeys);
  const relationalSet = new Set(relationalKeys);
  const duplicateLegacyKeys = validLegacyKeys.filter((key, index) => validLegacyKeys.indexOf(key) !== index);
  const duplicateRelationalKeys = relationalKeys.filter((key, index) => relationalKeys.indexOf(key) !== index);
  const missingInRelational = [...legacySet].filter((key) => !relationalSet.has(key));
  const missingInLegacy = [...relationalSet].filter((key) => !legacySet.has(key));
  const invalidLegacyRows = legacyKeys.filter((key) => !key).length;
  const matches = missingInRelational.length === 0 && missingInLegacy.length === 0
    && duplicateLegacyKeys.length === 0 && duplicateRelationalKeys.length === 0 && invalidLegacyRows === 0;
  return {
    legacyCount: Array.isArray(legacyRows) ? legacyRows.length : 0,
    relationalCount: relationalRows.length,
    missingInRelational: missingInRelational.length,
    missingInLegacy: missingInLegacy.length,
    duplicateLegacyKeys: [...new Set(duplicateLegacyKeys)].length,
    duplicateRelationalKeys: [...new Set(duplicateRelationalKeys)].length,
    invalidLegacyRows,
    keyParity: matches ? 'match' : 'mismatch',
    samples: {
      missingInRelational: missingInRelational.slice(0, 10),
      missingInLegacy: missingInLegacy.slice(0, 10),
    },
  };
}

export function buildReconciliationReport(legacyState, relationalByDomain, { legacyTablePresent = true } = {}) {
  const domains = {};
  for (const domain of DOMAINS) {
    const raw = legacyState?.[domain.key];
    const legacyRows = Array.isArray(raw) ? raw : [];
    const result = summarizeDomain(domain, legacyRows, relationalByDomain[domain.key] || []);
    if (raw === undefined) {
      result.keyParity = 'missing-legacy-domain';
      result.invalidLegacyRows = 1;
    } else if (!Array.isArray(raw)) {
      result.keyParity = 'invalid-legacy-shape';
      result.invalidLegacyRows = 1;
    }
    domains[domain.key] = result;
  }
  const mismatchCount = Object.values(domains).filter((item) => item.keyParity !== 'match').length;
  return {
    generatedAt: new Date().toISOString(),
    mode: 'read-only',
    legacyTablePresent,
    legacySnapshotPresent: Boolean(legacyState),
    domains,
    summary: {
      domainsChecked: DOMAINS.length,
      domainsMatching: DOMAINS.length - mismatchCount,
      domainsWithDifferences: mismatchCount,
      status: !legacyTablePresent ? 'legacy-table-missing'
        : !legacyState ? 'legacy-snapshot-missing'
          : mismatchCount ? 'differences-found' : 'key-parity-confirmed',
    },
    limitations: [
      'This report compares record identity keys and counts, not every field value.',
      'Attachment file bytes are not stored in PostgreSQL and are not validated by this report.',
      'Presence is ephemeral; differences may reflect users becoming online or offline during the legacy period.',
      'A matching key set does not prove that historical business fields or external files are identical.',
      'No data is inserted, updated, deleted, or migrated by this command.',
    ],
  };
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. No database was inspected.');
  const pool = await getPostgresPool();
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const tableCheck = await client.query("SELECT to_regclass('ashkan_app_state') IS NOT NULL AS present");
      const legacyTablePresent = Boolean(tableCheck.rows[0]?.present);
      let legacyState = null;
      if (legacyTablePresent) {
        const snapshot = await client.query('SELECT state FROM ashkan_app_state WHERE id = 1');
        legacyState = snapshot.rows[0]?.state || null;
      }
      const relationalByDomain = {};
      for (const domain of DOMAINS) {
        const result = await client.query(`SELECT ${domain.select} FROM ${domain.table}`);
        relationalByDomain[domain.key] = result.rows;
      }
      await client.query('COMMIT');
      const report = buildReconciliationReport(legacyState, relationalByDomain, { legacyTablePresent });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (process.argv.includes('--strict') && report.summary.status !== 'key-parity-confirmed') process.exitCode = 2;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
