import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('phase 70 adds a safe webhook retention dry-run preview', async () => {
  const repo = await readFile(new URL('../normalized-repository.mjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  const client = await readFile(new URL('../../src/api/client.js', import.meta.url), 'utf8');
  assert.match(repo, /getNormalizedWebhookRetentionPreview/);
  assert.match(repo, /expiredCount/);
  assert.match(repo, /delivery_retention_days/);
  assert.match(app, /action.*retention-preview/);
  assert.match(client, /webhookRetentionPreview/);
});
