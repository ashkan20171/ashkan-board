import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('phase 71 adds a safe retention policy impact preview', async () => {
  const repo = await readFile(new URL('../normalized-repository.mjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  const client = await readFile(new URL('../../src/api/client.js', import.meta.url), 'utf8');
  assert.match(repo, /getNormalizedWebhookRetentionPolicyImpact/);
  assert.match(repo, /currentExpiredCount/);
  assert.match(repo, /nextExpiredCount/);
  assert.match(repo, /newlyExpiredCount/);
  assert.match(app, /retention-policy-preview/);
  assert.match(app, /Invalid retention preview days/);
  assert.match(client, /webhookRetentionPolicyPreview/);
});
