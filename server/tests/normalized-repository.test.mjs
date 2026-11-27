import test from 'node:test';
import assert from 'node:assert/strict';
import { syncNormalizedState } from '../normalized-repository.mjs';

test('normalized projection clears child tables first and maps core records safely', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => { calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values }); return { rowCount: 1 }; } };
  const state = {
    users: [{ id: 'u1', email: 'user@example.com', name: 'User', passwordHash: 'hash', createdAt: '2026-01-01T00:00:00.000Z' }],
    workspaces: [{ id: 'w1', name: 'Workspace', description: 'Demo', createdAt: '2026-01-01T00:00:00.000Z' }],
    memberships: [{ workspaceId: 'w1', userId: 'u1', role: 'owner' }],
    tickets: [{ id: 't1', workspaceId: 'w1', title: 'Task', description: 'Details', status: 'todo', priority: 'High', createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null, tags: ['backend'] }],
    refreshTokens: [{ id: 'r1', userId: 'u1', familyId: 'f1', tokenHash: 'secret-hash', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-02-01T00:00:00.000Z', revokedAt: null }],
    passwordResets: [], invitations: [], auditLogs: [], notifications: [], importBatches: [], comments: [], attachments: [], presence: [],
  };
  await syncNormalizedState(client, state);
  const deletes = calls.filter((call) => call.sql.startsWith('DELETE FROM')).map((call) => call.sql);
  assert.equal(deletes[0], 'DELETE FROM workspace_presence');
  assert.equal(deletes.at(-1), 'DELETE FROM users');
  const ticketInsert = calls.find((call) => call.sql.startsWith('INSERT INTO tickets'));
  assert.ok(ticketInsert);
  assert.equal(ticketInsert.values[0], 't1');
  assert.deepEqual(JSON.parse(ticketInsert.values[9]), { tags: ['backend'] });
  assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO auth_refresh_tokens')));
});

test('normalized ticket query uses bounded pagination, parameterized filters and safe sorting', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
    if (sql.includes('COUNT(*)')) return { rows: [{ total: 37 }] };
    return { rows: [{ id: 't-1', workspace_id: 'w-1', title: 'Release plan', description: 'Ship safely', status: 'todo', priority: 'High', created_by: 'u-1', created_at: new Date('2026-01-01T00:00:00Z'), updated_at: null, extra: { tags: ['release'], estimateHours: 4 } }] };
  } };
  const { listNormalizedTickets } = await import('../normalized-repository.mjs');
  const result = await listNormalizedTickets(client, 'w-1', { page: '2', pageSize: '10', search: 'release', status: 'todo', priority: 'High', sort: 'title; DROP TABLE tickets', direction: 'asc' });
  assert.equal(result.pagination.total, 37);
  assert.equal(result.pagination.totalPages, 4);
  assert.equal(result.pagination.hasNext, true);
  assert.equal(result.tickets[0].workspaceId, 'w-1');
  assert.deepEqual(result.tickets[0].tags, ['release']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, ['w-1', 'todo', 'High', '%release%', '%release%']);
  assert.match(calls[1].sql, /ORDER BY created_at ASC/);
  assert.deepEqual(calls[1].values.slice(-2), [10, 10]);
  assert.ok(!calls[1].sql.includes('DROP TABLE'));
});
