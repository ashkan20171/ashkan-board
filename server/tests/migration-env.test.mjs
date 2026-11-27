import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const migrateSource = await readFile(resolve(root, 'server/migrate.mjs'), 'utf8');
const readme = await readFile(resolve(root, 'README.md'), 'utf8');

test('migration runner loads a project-root .env before validating DATABASE_URL', () => {
  assert.match(migrateSource, /loadEnvFile\(envFile\)/);
  assert.match(migrateSource, /DATABASE_URL is required to run migrations/);
});

test('migration documentation explains the Windows .env setup', () => {
  assert.match(readme, /npm run db:migrate/);
  assert.match(readme, /DATABASE_URL=postgresql:\/\/ashkan:change-me@localhost:5432\/ashkan_board/);
});
