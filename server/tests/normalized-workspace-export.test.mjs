import test from 'node:test';
import assert from 'node:assert/strict';
import { exportNormalizedWorkspace } from '../normalized-repository.mjs';

test('workspace export is scoped and excludes credential and attachment storage secrets', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql: sql.replace(/\\s+/g, ' ').trim(), values });
    if (sql.includes('FROM workspaces WHERE')) return { rows: [{ id: 'w-1', name: 'Ops', description: 'Team', created_at: new Date('2026-01-01T00:00:00Z') }] };
    if (sql.includes('FROM workspace_memberships')) return { rows: [{ id: 'u-1', email: 'a@example.com', name: 'A', role: 'owner', joined_at: new Date('2026-01-02T00:00:00Z') }] };
    if (sql.includes('FROM tickets WHERE')) return { rows: [{ id: 't-1', workspace_id: 'w-1', title: 'Task', description: '', status: 'todo', priority: 'Medium', created_by: 'u-1', created_at: new Date('2026-01-03T00:00:00Z'), updated_at: null, extra: { tags: ['ops'] } }] };
    if (sql.includes('FROM ticket_attachments')) return { rows: [{ id: 'a-1', workspace_id: 'w-1', ticket_id: 't-1', uploaded_by: 'u-1', name: 'spec.pdf', mime_type: 'application/pdf', size_bytes: '12', storage_name: 'secret.bin', created_at: new Date('2026-01-04T00:00:00Z') }] };
    return { rows: [] };
  } };
  const result = await exportNormalizedWorkspace(client, 'w-1');
  assert.equal(result.format, 'ashkanboard-workspace-export');
  assert.equal(result.tickets[0].tags[0], 'ops');
  assert.equal(result.attachments[0].sizeBytes, 12);
  assert.equal('storage_name' in result.attachments[0], false);
  assert.ok(result.exclusions.includes('password hashes'));
  assert.equal(calls.length, 8);
  assert.ok(calls.every((call) => call.values[0] === 'w-1'));
});

test('workspace export returns null for an unknown workspace', async () => {
  const client = { query: async () => ({ rows: [] }) };
  assert.equal(await exportNormalizedWorkspace(client, 'missing'), null);
});
