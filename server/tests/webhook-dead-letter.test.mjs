import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);

test('phase 65 adds webhook dead-letter queue management', async () => {
  const repo = await readFile(new URL('./normalized-repository.mjs', root), 'utf8');
  const app = await readFile(new URL('./app.mjs', root), 'utf8');
  const client = await readFile(new URL('../src/api/client.js', root), 'utf8');
  const ui = await readFile(new URL('../src/App.jsx', root), 'utf8');
  assert.match(repo, /listNormalizedWebhookDeadLetters/);
  assert.match(repo, /requeueNormalizedWebhookDeadLetter/);
  assert.match(repo, /discardNormalizedWebhookDeadLetter/);
  assert.match(repo, /dead_lettered=true/);
  assert.match(repo, /next_retry_at=now\(\)/);
  assert.match(app, /dead-letter/);
  assert.match(app, /requeue-dead-letter/);
  assert.match(app, /discard-dead-letter/);
  assert.match(client, /listWebhookDeadLetters/);
  assert.match(client, /requeueWebhookDeadLetter/);
  assert.match(client, /discardWebhookDeadLetter/);
  assert.match(ui, /requeueDeadLetter/);
  assert.match(ui, /discardDeadLetter/);
  assert.match(ui, /Dead-Letter/);
});
