import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('phase 72 adds safe webhook delivery search filters and pagination', async () => {
  const repo = await readFile(new URL('../normalized-repository.mjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  const client = await readFile(new URL('../../src/api/client.js', import.meta.url), 'utf8');
  assert.match(repo, /searchNormalizedWebhookDeliveries/);
  assert.match(repo, /COUNT\(\*\)::int/);
  assert.match(repo, /LIMIT.*OFFSET/);
  assert.match(app, /delivery-search/);
  assert.match(app, /Invalid delivery search pagination/);
  assert.match(client, /webhookDeliverySearch/);
});
