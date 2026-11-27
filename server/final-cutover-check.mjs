import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getPostgresPool } from './store.mjs';

const appPath = resolve(new URL('./app.mjs', import.meta.url).pathname);
const migrationPath = resolve(new URL('./migrations/014_retire_legacy_aggregate.sql', import.meta.url).pathname);
const appSource = await readFile(appPath, 'utf8');
const migrationSource = await readFile(migrationPath, 'utf8');

const directLegacy = appSource.match(/\b(?:readStore|updateStore)\s*\(/g) || [];
const adapterImport = appSource.includes("./legacy-persistence.mjs");
const dropsAggregate = /DROP TABLE IF EXISTS ashkan_app_state/i.test(migrationSource);
const normalizedEnv = process.env.PERSISTENCE_MODE === 'normalized';

const report = {
  checkedAt: new Date().toISOString(),
  application: {
    directLegacyAggregateCallCount: directLegacy.length,
    legacyAdapterIsolated: adapterImport,
  },
  migration: {
    finalRetirementMigrationPresent: dropsAggregate,
    file: 'server/migrations/014_retire_legacy_aggregate.sql',
  },
  persistenceMode: process.env.PERSISTENCE_MODE || 'not-set',
  status: directLegacy.length === 0 && adapterImport && dropsAggregate && normalizedEnv ? 'ready' : 'review-required',
};

if (process.env.DATABASE_URL) {
  const pool = await getPostgresPool();
  try {
    const result = await pool.query("SELECT to_regclass('ashkan_app_state') IS NOT NULL AS present");
    report.database = { connected: true, legacyAggregatePresent: Boolean(result.rows[0]?.present) };
    report.status = report.status === 'ready' && !report.database.legacyAggregatePresent ? 'complete' : (report.status === 'ready' ? 'cutover-migration-pending' : report.status);
  } catch (error) {
    report.database = { connected: false, error: error.message };
    report.status = 'review-required';
  } finally {
    await pool.end();
  }
} else {
  report.database = { connected: false, note: 'No DATABASE_URL; source-level cutover readiness only.' };
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!['ready', 'complete'].includes(report.status)) process.exitCode = 1;
