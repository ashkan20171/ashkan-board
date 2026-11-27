import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

test('phase 59 adds automatic webhook retry worker and retry locking', async () => {
  const migration = await readFile(new URL('../migrations/027_webhook_automatic_retries.sql', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  const repo = await readFile(new URL('../normalized-repository.mjs', import.meta.url), 'utf8');
  assert.match(migration, /retry_locked_at TIMESTAMPTZ/);
  assert.match(migration, /workspace_webhook_deliveries_due_idx/);
  assert.match(repo, /claimNormalizedWebhookRetries/);
  assert.match(repo, /FOR UPDATE OF d SKIP LOCKED/);
  assert.match(app, /processDueWebhookRetries/);
  assert.match(app, /WEBHOOK_RETRY_INTERVAL_MS/);
  assert.match(app, /x-ashkan-retry/);
});
