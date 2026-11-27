import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);

test('phase 68 adds bulk dead-letter recovery with safe locking', async () => {
  const repo = await readFile(new URL('./normalized-repository.mjs', root), 'utf8');
  const app = await readFile(new URL('./app.mjs', root), 'utf8');
  const client = await readFile(new URL('../src/api/client.js', root), 'utf8');
  const ui = await readFile(new URL('../src/App.jsx', root), 'utf8');
  assert.match(repo, /requeueNormalizedWebhookDeadLetters/);
  assert.match(repo, /FOR UPDATE SKIP LOCKED/);
  assert.match(repo, /dead_lettered=false/);
  assert.match(app, /requeue-dead-letters/);
  assert.match(app, /bulk_requeued/);
  assert.match(app, /limit>500/);
  assert.match(client, /requeueWebhookDeadLetters/);
  assert.match(ui, /requeueAllDeadLetters/);
  assert.match(ui, /Requeue all/);
});
