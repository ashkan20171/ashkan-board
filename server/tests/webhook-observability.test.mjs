import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('phase 57 adds webhook delivery observability summary and replay UI controls', async () => {
  const repo = await readFile(new URL('../normalized-repository.mjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  const client = await readFile(new URL('../../src/api/client.js', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(repo, /getNormalizedWebhookDeliverySummary/);
  assert.match(repo, /successRate/);
  assert.match(app, /action.*stats/);
  assert.match(client, /webhookDeliverySummary/);
  assert.match(ui, /Webhook|وب‌هوک/);
  assert.match(ui, /Replay/);
  assert.match(ui, /Success rate|نرخ موفقیت/);
});
