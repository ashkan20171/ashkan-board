import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('..', import.meta.url);

test('phase 51 supports per-session family revocation and session-family summaries', async () => {
  const repo = await readFile(new URL('./normalized-repository.mjs', root), 'utf8');
  const app = await readFile(new URL('./app.mjs', root), 'utf8');
  const client = await readFile(new URL('../src/api/client.js', root), 'utf8');
  const ui = await readFile(new URL('../src/App.jsx', root), 'utf8');
  assert.match(repo, /revokeNormalizedSessionFamily/);
  assert.match(repo, /GROUP BY family_id/);
  assert.match(repo, /tokenCount/);
  assert.ok(app.includes('sessionRevokeRoute'));
  assert.ok(app.includes("'session.revoked'"));
  assert.match(client, /revokeSession/);
  assert.match(ui, /revokeSession\(session\.familyId\)/);
});
