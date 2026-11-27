import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('..', import.meta.url);

test('phase 53 adds workspace webhook management and delivery controls', async () => {
  const migration = await readFile(new URL('./migrations/022_workspace_webhooks.sql', root), 'utf8');
  const repo = await readFile(new URL('./normalized-repository.mjs', root), 'utf8');
  const app = await readFile(new URL('./app.mjs', root), 'utf8');
  const client = await readFile(new URL('../src/api/client.js', root), 'utf8');
  assert.match(migration, /workspace_webhooks/);
  assert.match(repo, /listNormalizedWebhooks/);
  assert.match(repo, /recordNormalizedWebhookDelivery/);
  assert.ok(app.includes('/webhooks'));
  assert.match(app, /Production requires.*HTTPS|parsed\.protocol/);
  assert.match(app, /webhook\.test/);
  assert.match(client, /createWebhook/);
  assert.match(client, /testWebhook/);
});
