import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);

test('final cutover removes direct legacy calls from app and includes retirement migration', async () => {
  const app = await readFile(new URL('./app.mjs', root), 'utf8');
  const migration = await readFile(new URL('./migrations/014_retire_legacy_aggregate.sql', root), 'utf8');
  assert.equal((app.match(/\b(?:readStore|updateStore)\s*\(/g) || []).length, 0);
  assert.match(app, /legacy-persistence\.mjs/);
  assert.match(migration, /DROP TABLE IF EXISTS ashkan_app_state/i);
});

test('migration runner explicitly tolerates an already-retired legacy aggregate', async () => {
  const source = await readFile(new URL('./migrate.mjs', root), 'utf8');
  assert.match(source, /to_regclass\('ashkan_app_state'\)/);
  assert.match(source, /legacy aggregate has already been retired/);
});
