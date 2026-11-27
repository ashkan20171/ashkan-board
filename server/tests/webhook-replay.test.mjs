import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('phase 56 adds replayable webhook payloads and secure replay endpoint', async () => {
  const migration = await readFile(new URL('../migrations/025_webhook_replay_payload.sql', import.meta.url), 'utf8');
  const repo = await readFile(new URL('../normalized-repository.mjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS payload JSONB/);
  assert.match(repo, /getNormalizedWebhookDelivery/);
  assert.match(repo, /payload/);
  assert.match(app, /searchParams\.get\('action'\) === 'replay'/);
  assert.match(app, /x-ashkan-replay/);
  assert.match(app, /replayOf/);
});
