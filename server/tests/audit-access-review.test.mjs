import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('..', import.meta.url);

test('phase 50 audit access review supports server-side filters and export client', async () => {
  const repo = await readFile(new URL('./normalized-repository.mjs', root), 'utf8');
  const app = await readFile(new URL('./app.mjs', root), 'utf8');
  const client = await readFile(new URL('../src/api/client.js', root), 'utf8');
  const ui = await readFile(new URL('../src/App.jsx', root), 'utf8');
  assert.match(repo, /actorId = '', action = '', entityType = '', from = '', to = ''/);
  assert.match(repo, /created_at>=\?::timestamptz/);
  assert.match(app, /searchParams/);
  assert.match(app, /entityType: params\.get\('entityType'\)/);
  assert.match(client, /auditLog: \(workspaceId, filters = \{\}\)/);
  assert.match(ui, /exportAuditCsv/);
  assert.match(ui, /Audit & access review/);
});
