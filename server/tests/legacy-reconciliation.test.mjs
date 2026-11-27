import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReconciliationReport } from '../reconcile-legacy.mjs';

const emptyDomains = () => Object.fromEntries([
  'users', 'workspaces', 'memberships', 'tickets', 'refreshTokens', 'passwordResets',
  'invitations', 'auditLogs', 'notifications', 'comments', 'attachments', 'presence', 'importBatches',
].map((key) => [key, []]));

test('legacy reconciliation confirms matching identities across all normalized domains', () => {
  const state = {
    ...emptyDomains(),
    users: [{ id: 'u1' }], workspaces: [{ id: 'w1' }],
    memberships: [{ workspaceId: 'w1', userId: 'u1' }],
    presence: [{ workspaceId: 'w1', userId: 'u1' }],
  };
  const relational = emptyDomains();
  relational.users = [{ id: 'u1' }];
  relational.workspaces = [{ id: 'w1' }];
  relational.memberships = [{ workspace_id: 'w1', user_id: 'u1' }];
  relational.presence = [{ workspace_id: 'w1', user_id: 'u1' }];
  const report = buildReconciliationReport(state, relational);
  assert.equal(report.summary.status, 'key-parity-confirmed');
  assert.equal(report.summary.domainsWithDifferences, 0);
  assert.equal(report.mode, 'read-only');
});

test('legacy reconciliation reports missing, extra, and duplicate identities without mutating inputs', () => {
  const state = { users: [{ id: 'u1' }, { id: 'u1' }, { id: 'u2' }] };
  const relational = emptyDomains();
  relational.users = [{ id: 'u1' }, { id: 'u3' }];
  const before = structuredClone(state);
  const report = buildReconciliationReport(state, relational);
  assert.equal(report.summary.status, 'differences-found');
  assert.equal(report.domains.users.missingInRelational, 1);
  assert.equal(report.domains.users.missingInLegacy, 1);
  assert.equal(report.domains.users.duplicateLegacyKeys, 1);
  assert.deepEqual(state, before);
});

test('legacy reconciliation handles composite keys and invalid legacy shapes', () => {
  const state = { memberships: [{ workspaceId: 'w1', userId: 'u1' }, { workspaceId: null, userId: 'u2' }], tickets: 'invalid' };
  const relational = emptyDomains();
  relational.memberships = [{ workspace_id: 'w1', user_id: 'u1' }];
  const report = buildReconciliationReport(state, relational);
  assert.equal(report.domains.memberships.invalidLegacyRows, 1);
  assert.equal(report.domains.memberships.keyParity, 'mismatch');
  assert.equal(report.domains.tickets.keyParity, 'invalid-legacy-shape');
});

test('missing legacy snapshot is never reported as successful parity', () => {
  const report = buildReconciliationReport(null, emptyDomains(), { legacyTablePresent: false });
  assert.equal(report.summary.status, 'legacy-table-missing');
  assert.equal(report.legacySnapshotPresent, false);
});

test('missing legacy domain arrays are flagged instead of treated as empty parity', () => {
  const report = buildReconciliationReport({ users: [] }, emptyDomains());
  assert.equal(report.domains.workspaces.keyParity, 'missing-legacy-domain');
  assert.equal(report.summary.status, 'differences-found');
});
