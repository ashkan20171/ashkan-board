import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);

test('phase 64 adds configurable webhook delivery retention and cleanup worker', async () => {
  const migration = await readFile(new URL('./migrations/030_webhook_delivery_retention.sql', root), 'utf8');
  const repo = await readFile(new URL('./normalized-repository.mjs', root), 'utf8');
  const app = await readFile(new URL('./app.mjs', root), 'utf8');
  const client = await readFile(new URL('../src/api/client.js', root), 'utf8');
  const ui = await readFile(new URL('../src/App.jsx', root), 'utf8');
  assert.match(migration, /delivery_retention_days/);
  assert.match(migration, /delivery_retention_days_check/);
  assert.match(repo, /purgeExpiredNormalizedWebhookDeliveries/);
  assert.match(repo, /make_interval\(days/);
  assert.match(app, /retention-policy/);
  assert.match(app, /webhook\.delivery\.retention_purged/);
  assert.match(app, /WEBHOOK_RETENTION_BATCH_SIZE/);
  assert.match(app, /retention-stats/);
  assert.match(app, /purge-retention/);
  assert.match(app, /retention_manual_purged/);
  assert.match(repo, /getNormalizedWebhookRetentionStats/);
  assert.match(repo, /webhookId = null/);
  assert.match(client, /updateWebhookRetentionPolicy/);
  assert.match(ui, /updateWebhookRetention/);
  assert.match(ui, /deliveryRetentionDays/);
});
