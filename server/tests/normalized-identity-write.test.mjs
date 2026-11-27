import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNormalizedAccount, updateNormalizedUser, createNormalizedWorkspace,
  addNormalizedMembership, updateNormalizedMembershipRole,
  removeNormalizedMembership, insertNormalizedAudit,
} from '../normalized-repository.mjs';

test('normalized account creation writes user, workspace, and owner membership with parameterized SQL', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => { calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values }); return { rows: [], rowCount: 1 }; } };
  const user = { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', name: 'Owner', passwordHash: 'hashed', createdAt: '2026-01-01T00:00:00.000Z' };
  const workspace = { id: '00000000-0000-4000-8000-000000000002', name: 'Owner workspace', description: 'Demo', createdAt: user.createdAt };
  const membership = { userId: user.id, workspaceId: workspace.id, role: 'owner', joinedAt: user.createdAt };
  const result = await createNormalizedAccount(client, { user, workspace, membership });
  assert.equal(calls.length, 7);
  assert.match(calls[0].sql, /^INSERT INTO users/);
  assert.match(calls[1].sql, /^INSERT INTO workspaces/);
  assert.match(calls[2].sql, /^INSERT INTO workspace_roles/);
  assert.match(calls[6].sql, /^INSERT INTO workspace_memberships/);
  assert.equal(calls[6].values[2], 'owner');
  assert.equal(result.user.id, user.id);
  assert.equal(result.workspace.role, 'owner');
});

test('normalized identity and membership mutations preserve owner protections and audit writes', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
    if (sql.includes('UPDATE users')) return { rows: [{ id: 'u1', email: 'u@example.com', name: 'Updated', created_at: new Date('2026-01-01T00:00:00Z') }], rowCount: 1 };
    if (sql.includes('INSERT INTO workspace_memberships')) return { rows: [{ workspace_id: 'w1', user_id: 'u2', role: 'member', joined_at: new Date('2026-01-01T00:00:00Z') }], rowCount: 1 };
    if (sql.includes('UPDATE workspace_memberships')) return { rows: [{ workspace_id: 'w1', user_id: 'u2', role: 'admin', joined_at: new Date('2026-01-01T00:00:00Z') }], rowCount: 1 };
    if (sql.includes('DELETE FROM workspace_memberships')) return { rows: [{ user_id: 'u2' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const updated = await updateNormalizedUser(client, 'u1', { name: 'Updated' });
  assert.equal(updated.name, 'Updated');
  const created = await createNormalizedWorkspace(client, { id: 'w2', name: 'Workspace', description: '', createdAt: '2026-01-01T00:00:00Z' }, 'u1');
  assert.equal(created.role, 'owner');
  const added = await addNormalizedMembership(client, { workspaceId: 'w1', userId: 'u2', role: 'member' });
  assert.equal(added.role, 'member');
  const changed = await updateNormalizedMembershipRole(client, 'w1', 'u2', 'admin');
  assert.equal(changed.role, 'admin');
  assert.match(calls.find((call) => call.sql.includes('UPDATE workspace_memberships')).sql, /role <> 'owner'/);
  assert.equal(await removeNormalizedMembership(client, 'w1', 'u2'), true);
  assert.match(calls.find((call) => call.sql.includes('DELETE FROM workspace_memberships')).sql, /role <> 'owner'/);
  await insertNormalizedAudit(client, { id: 'a1', workspaceId: 'w1', actorId: 'u1', action: 'member.added', entityType: 'membership', entityId: 'u2', metadata: { role: 'member' } });
  const audit = calls.find((call) => call.sql.startsWith('INSERT INTO workspace_audit_logs'));
  assert.equal(audit.values[5], 'u2');
  assert.deepEqual(JSON.parse(audit.values[6]), { role: 'member' });
});

test('normalized audit history reads a bounded workspace-scoped timeline', async () => {
  const { listNormalizedAudit } = await import('../normalized-repository.mjs');
  let captured;
  const client = { query: async (sql, values) => {
    captured = { sql: sql.replace(/\s+/g, ' ').trim(), values };
    return { rows: [{ id: 'a1', workspace_id: 'w1', actor_id: 'u1', action: 'member.added', entity_type: 'membership', entity_id: 'u2', metadata: { role: 'member' }, created_at: new Date('2026-01-01T00:00:00Z') }] };
  } };
  const events = await listNormalizedAudit(client, 'w1', 900);
  assert.equal(captured.values[0], 'w1');
  assert.equal(captured.values[1], 500);
  assert.match(captured.sql, /ORDER BY created_at DESC/);
  assert.equal(events[0].workspaceId, 'w1');
  assert.equal(events[0].metadata.role, 'member');
});

test('normalized password reset invalidates older tokens and consumes a token atomically', async () => {
  const { createNormalizedPasswordReset, consumeNormalizedPasswordReset } = await import('../normalized-repository.mjs');
  const calls = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
    if (sql.includes('SELECT id,user_id FROM password_reset_tokens')) return { rows: [{ id: 'pr1', user_id: 'u1' }], rowCount: 1 };
    if (sql.includes('UPDATE users SET password_hash')) return { rows: [{ id: 'u1' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  await createNormalizedPasswordReset(client, { id: 'pr2', userId: 'u1', tokenHash: 'hash-2', createdAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-01-01T00:15:00Z') });
  assert.match(calls[0].sql, /DELETE FROM password_reset_tokens WHERE user_id=\$1/);
  assert.equal(await consumeNormalizedPasswordReset(client, 'hash-2', 'new-password-hash', new Date('2026-01-01T00:05:00Z')), 'u1');
  assert.match(calls.find((call) => call.sql.includes('FOR UPDATE')).sql, /FOR UPDATE/);
  assert.ok(calls.some((call) => call.sql.includes('SET used_at')));
  assert.ok(calls.some((call) => call.sql.includes('UPDATE auth_refresh_tokens SET revoked_at')));
});
