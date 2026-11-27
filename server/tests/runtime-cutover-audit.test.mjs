import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('runtime cutover keeps the legacy aggregate behind normalized-mode guards', async () => {
  const source = await readFile(resolve('server/app.mjs'), 'utf8');
  assert.match(source, /const normalizedPersistence = \(\) =>/);
  assert.ok((source.match(/normalizedPersistence\(\)/g) || []).length >= 10);
});

test('normalized runtime does not silently rebuild relational state from the legacy aggregate', async () => {
  const source = await readFile(resolve('server/store.mjs'), 'utf8');
  assert.match(source, /if \(process\.env\.PERSISTENCE_MODE !== 'normalized'\) await syncNormalizedState/);
});
