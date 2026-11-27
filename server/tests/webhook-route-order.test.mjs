import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('phase 67 routes webhook action PATCH handlers before generic PATCH', async () => {
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  const retention = app.indexOf("url.searchParams.get('action') === 'retention-policy'");
  const generic = app.indexOf("if (req.method === 'PATCH' && webhookId) {");
  assert.ok(retention >= 0);
  assert.ok(generic >= 0);
  assert.ok(retention < generic);
  assert.match(app, /retention-stats/);
  assert.match(app, /purge-retention/);
});
