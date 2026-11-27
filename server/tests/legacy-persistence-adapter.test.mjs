import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const appPath = resolve('server/app.mjs');
const adapterPath = resolve('server/legacy-persistence.mjs');

test('application routes contain no direct legacy JSONB store calls', async () => {
  const source = await readFile(appPath, 'utf8');
  assert.equal((source.match(/\b(?:readStore|updateStore)\s*\(/g) || []).length, 0);
  assert.match(source, /legacy-persistence\.mjs/);
});

test('legacy persistence adapter fails closed in normalized runtime mode', async () => {
  const source = await readFile(adapterPath, 'utf8');
  assert.match(source, /process\.env\.DATABASE_URL && process\.env\.PERSISTENCE_MODE === 'normalized'/);
  assert.match(source, /Legacy JSONB persistence is unavailable in normalized runtime mode/);
  assert.match(source, /return readStore\(\)/);
  assert.match(source, /return updateStore\(mutator\)/);
});
