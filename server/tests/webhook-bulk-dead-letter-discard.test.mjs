import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('bulk dead-letter discard is bounded and locked safely', async () => {
  const repo = await readFile(new URL('../normalized-repository.mjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  assert.match(repo, /discardNormalizedWebhookDeadLetters/);
  assert.match(repo, /FOR UPDATE SKIP LOCKED/);
  assert.match(repo, /Math\.min\(Math\.max\(Number\(limit\) \|\| 100, 1\), 500\)/);
  assert.match(app, /url\.searchParams\.get\('action'\) === 'discard-dead-letters'/);
  assert.match(app, /webhook\.dead_letter\.bulk_discarded/);
});
