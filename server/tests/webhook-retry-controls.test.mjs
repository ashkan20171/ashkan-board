import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('phase 58 adds webhook retry controls and dead-letter fields', async () => {
  const migration = await readFile(new URL('../migrations/026_webhook_retry_controls.sql', import.meta.url), 'utf8');
  const repo = await readFile(new URL('../normalized-repository.mjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  assert.match(migration, /max_attempts INTEGER/);
  assert.match(migration, /retry_delay_seconds INTEGER/);
  assert.match(migration, /dead_lettered BOOLEAN/);
  assert.match(repo, /updateNormalizedWebhookRetryPolicy/);
  assert.match(repo, /deadLettered/);
  assert.match(app, /action.*retry-policy/);
});
