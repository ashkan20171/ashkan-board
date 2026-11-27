import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { syncNormalizedState } from './normalized-repository.mjs';
import { postgresPoolConfig } from './postgres-config.mjs';

const envFile = resolve(process.cwd(), '.env');
try {
  await access(envFile);
  loadEnvFile(envFile);
  process.stdout.write(`[migrate] Loaded environment from ${envFile}\n`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run migrations. Create a .env file from .env.example or set DATABASE_URL in the shell.');
}
const { Pool } = await import('pg');
const pool = new Pool(postgresPoolConfig({ max: 2 }));
const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');
const lockKey = "hashtextextended('ashkan-board:migrations', 0)";
const client = await pool.connect();

try {
  const lock = await client.query(`SELECT pg_try_advisory_lock(${lockKey}) AS locked`);
  if (!lock.rows[0]?.locked) throw new Error('Another AshkanBoard migration process is already running.');
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET statement_timeout = '120s'");
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');

  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of files) {
    const exists = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [name]);
    if (exists.rowCount) continue;
    const sql = await readFile(resolve(dir, name), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [name]);
      await client.query('COMMIT');
      process.stdout.write(`Applied ${name}\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  // One-time compatibility backfill. Never overwrite normalized runtime rows
  // with a stale aggregate on subsequent migration runs. The legacy aggregate
  // may be absent after the final cutover migration, so detect that state first.
  await client.query('BEGIN');
  try {
    const relationalUsers = await client.query('SELECT COUNT(*)::int AS count FROM users');
    const legacyTable = await client.query("SELECT to_regclass('ashkan_app_state') IS NOT NULL AS present");
    if (!legacyTable.rows[0]?.present) {
      process.stdout.write('Skipped compatibility backfill: legacy aggregate has already been retired\n');
    } else if (Number(relationalUsers.rows[0]?.count || 0) === 0) {
      const snapshot = await client.query('SELECT state FROM ashkan_app_state WHERE id = 1 FOR UPDATE');
      if (snapshot.rows[0]?.state?.users?.length) {
        await syncNormalizedState(client, snapshot.rows[0].state);
        process.stdout.write('Synchronized normalized relational projection from aggregate state\n');
      }
    } else {
      process.stdout.write('Skipped compatibility backfill: normalized identity records already exist\n');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  await client.query(`SELECT pg_advisory_unlock(${lockKey})`);
} finally {
  client.release();
  await pool.end();
}
