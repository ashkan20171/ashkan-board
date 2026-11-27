import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);

test('PostgreSQL pool has bounded timeouts and keepalive configuration', async () => {
  const source = await readFile(new URL('./postgres-config.mjs', root), 'utf8');
  assert.match(source, /connectionTimeoutMillis/);
  assert.match(source, /idleTimeoutMillis/);
  assert.match(source, /statement_timeout/);
  assert.match(source, /query_timeout/);
  assert.match(source, /keepAlive: true/);
  assert.match(source, /application_name/);
});

test('migration runner serializes concurrent runs with an advisory lock', async () => {
  const source = await readFile(new URL('./migrate.mjs', root), 'utf8');
  assert.match(source, /pg_try_advisory_lock/);
  assert.match(source, /Another AshkanBoard migration process is already running/);
  assert.match(source, /pg_advisory_unlock/);
  assert.match(source, /lock_timeout/);
});

test('production readiness requires normalized persistence and retired aggregate', async () => {
  const source = await readFile(new URL('./app.mjs', root), 'utf8');
  assert.match(source, /PERSISTENCE_MODE === 'normalized'/);
  assert.match(source, /030_webhook_delivery_retention\.sql/);
  assert.match(source, /ashkan_app_state/);
  assert.match(source, /requiredTableCount/);
});

test('database backup and restore pass connection URLs explicitly to PostgreSQL tools', async () => {
  const backup = await readFile(new URL('./ops/backup.mjs', root), 'utf8');
  const restore = await readFile(new URL('./ops/restore.mjs', root), 'utf8');
  assert.match(backup, /'--dbname', databaseUrl/);
  assert.match(restore, /'--dbname', targetUrl/);
  assert.doesNotMatch(backup, /PGDATABASE:\s*databaseUrl/);
  assert.doesNotMatch(restore, /PGDATABASE:\s*targetUrl/);
});

test('API shutdown imports and closes the PostgreSQL pool safely', async () => {
  const source = await readFile(new URL('./app.mjs', root), 'utf8');
  assert.match(source, /import \{ getPostgresPool, closePostgresPool \} from '\.\/store\.mjs'/);
  assert.match(source, /await closePostgresPool\(\)/);
  assert.match(source, /server\.closeIdleConnections\?\.\(\)/);
});
