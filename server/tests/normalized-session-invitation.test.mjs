import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNormalizedRefreshToken, rotateNormalizedRefreshToken,
  revokeNormalizedRefreshFamily, createNormalizedInvitation,
  acceptNormalizedInvitation,
} from '../normalized-repository.mjs';

const token = (id, familyId = 'family-1') => ({
  id, userId: 'user-1', familyId, tokenHash: `hash-${id}`,
  createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', revokedAt: null,
});

test('normalized refresh token creation writes only a token hash and relational foreign key', async () => {
  let captured;
  const client = { query: async (sql, values) => { captured = { sql: sql.replace(/\\s+/g, ' ').trim(), values }; return { rowCount: 1, rows: [] }; } };
  await createNormalizedRefreshToken(client, token('rt-1'));
  assert.match(captured.sql, /^INSERT INTO auth_refresh_tokens/);
  assert.equal(captured.values[3], 'hash-rt-1');
  assert.equal(captured.values[1], 'user-1');
});

test('refresh rotation locks the prior token, revokes it, and persists its replacement in the same transaction scope', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql: sql.replace(/\\s+/g, ' ').trim(), values });
    if (sql.includes('SELECT id,user_id,family_id,expires_at,revoked_at')) return { rows: [{ id: 'rt-old', user_id: 'user-1', family_id: 'family-1', expires_at: new Date('2027-01-01'), revoked_at: null }] };
    if (sql.includes('SELECT id,email,name,created_at FROM users')) return { rows: [{ id: 'user-1', email: 'u@example.com', name: 'User', created_at: new Date('2026-01-01') }] };
    return { rows: [], rowCount: 1 };
  } };
  const next = token('rt-new');
  const result = await rotateNormalizedRefreshToken(client, 'hash-old', (user, familyId) => ({ accessToken: `access-${user.id}`, refreshToken: 'new-plain-token', refreshRecord: { ...next, familyId } }), new Date('2026-02-01'));
  assert.equal(result.user.id, 'user-1');
  assert.equal(result.refreshToken, 'new-plain-token');
  assert.ok(calls.some((call) => call.sql.includes('FOR UPDATE')));
  assert.ok(calls.some((call) => call.sql.startsWith('UPDATE auth_refresh_tokens SET revoked_at')));
  assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO auth_refresh_tokens')));
});

test('reuse of revoked or expired refresh token revokes its entire family', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql: sql.replace(/\\s+/g, ' ').trim(), values });
    return sql.includes('SELECT id,user_id,family_id,expires_at,revoked_at')
      ? { rows: [{ id: 'rt-old', user_id: 'user-1', family_id: 'family-1', expires_at: new Date('2027-01-01'), revoked_at: new Date('2026-01-02') }] }
      : { rows: [], rowCount: 1 };
  } };
  const result = await rotateNormalizedRefreshToken(client, 'hash-old', () => assert.fail('must not create a replacement'), new Date('2026-02-01'));
  assert.equal(result, null);
  assert.ok(calls.some((call) => call.sql.includes('WHERE family_id=$1')));
});

test('invitation creation expires previous pending invite and stores a hashed token with audit', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => { calls.push({ sql: sql.replace(/\\s+/g, ' ').trim(), values }); return { rows: [], rowCount: 1 }; } };
  await createNormalizedInvitation(client, { id: 'inv-1', workspaceId: 'ws-1', email: 'member@example.com', role: 'viewer', tokenHash: 'hashed-token', invitedBy: 'user-1', createdAt: new Date('2026-02-01'), expiresAt: new Date('2026-02-08'), auditId: 'audit-1' });
  assert.ok(calls.some((call) => call.sql.includes('UPDATE workspace_invitations SET revoked_at')));
  assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO workspace_invitations')));
  assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO workspace_audit_logs')));
  assert.equal(calls.find((call) => call.sql.startsWith('INSERT INTO workspace_invitations')).values[4], 'hashed-token');
});

test('invitation acceptance verifies email and expiration, then inserts membership and audit atomically', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql: sql.replace(/\\s+/g, ' ').trim(), values });
    if (sql.includes('SELECT id,workspace_id,email,role,expires_at,accepted_at')) return { rows: [{ id: 'inv-1', workspace_id: 'ws-1', email: 'member@example.com', role: 'viewer', expires_at: new Date('2027-01-01'), accepted_at: null, revoked_at: null }] };
    if (sql.startsWith('INSERT INTO workspace_memberships')) return { rows: [{ workspace_id: 'ws-1', user_id: 'user-2', role: 'viewer', joined_at: new Date('2026-02-01') }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const result = await acceptNormalizedInvitation(client, { tokenHash: 'hashed-token', userId: 'user-2', email: 'MEMBER@example.com', now: new Date('2026-02-01'), auditId: 'audit-2' });
  assert.equal(result.workspaceId, 'ws-1');
  assert.equal(result.role, 'viewer');
  assert.ok(calls.some((call) => call.sql.includes('FOR UPDATE')));
  assert.ok(calls.some((call) => call.sql.startsWith('UPDATE workspace_invitations SET accepted_at')));
  assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO workspace_audit_logs')));
});

 test('invalid invitation email is rejected without creating membership', async () => {
  let membershipWrites = 0;
  const client = { query: async (sql) => { if (sql.startsWith('INSERT INTO workspace_memberships')) membershipWrites += 1; return sql.includes('SELECT id,workspace_id,email,role,expires_at,accepted_at') ? { rows: [{ id: 'inv-1', workspace_id: 'ws-1', email: 'other@example.com', role: 'member', expires_at: new Date('2027-01-01'), accepted_at: null, revoked_at: null }] } : { rows: [], rowCount: 1 }; } };
  const result = await acceptNormalizedInvitation(client, { tokenHash: 'hash', userId: 'user-2', email: 'wrong@example.com', now: new Date('2026-02-01'), auditId: 'audit' });
  assert.equal(result, null);
  assert.equal(membershipWrites, 0);
});


test('logout revokes all refresh tokens in the matching family without affecting other families', async () => {
  let captured;
  const client = { query: async (sql, values) => { captured = { sql: sql.replace(/\s+/g, ' ').trim(), values }; return { rowCount: 2, rows: [{ id: 'rt-a' }, { id: 'rt-b' }] }; } };
  const { revokeNormalizedRefreshFamily } = await import('../normalized-repository.mjs');
  assert.equal(await revokeNormalizedRefreshFamily(client, 'token-hash', new Date('2026-02-01')), true);
  assert.match(captured.sql, /WHERE family_id=\(SELECT family_id FROM auth_refresh_tokens WHERE token_hash=\$1\)/);
  assert.equal(captured.values[0], 'token-hash');
});
