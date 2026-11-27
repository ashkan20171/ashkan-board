import test from 'node:test';
import assert from 'node:assert/strict';
import { commitNormalizedTicketImport, findNormalizedImportBatch } from '../normalized-repository.mjs';

const sampleTickets = [
  { title: 'Imported one', description: 'First', status: 'todo', priority: 'High', tags: ['ops'] },
  { title: 'Imported two', description: 'Second', status: 'backlog', priority: 'Medium', tags: [] },
];

test('normalized ticket import writes batch, tickets and audit through relational SQL', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql: normalized, values });
    if (normalized.startsWith('INSERT INTO ticket_import_batches')) return { rows: [{ id: 'batch-1' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const result = await commitNormalizedTicketImport(client, {
    workspaceId: 'workspace-1', batchKey: 'external-export-2026', importedBy: 'user-1',
    tickets: sampleTickets, batchId: 'batch-1', auditId: 'audit-1', now: new Date('2026-11-19T10:00:00Z'),
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.imported, 2);
  assert.equal(result.tickets[0].createdBy, 'user-1');
  assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO ticket_import_batches')));
  assert.equal(calls.filter((call) => call.sql.startsWith('INSERT INTO tickets')).length, 2);
  assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO workspace_audit_logs')));
  assert.ok(calls.find((call) => call.sql.startsWith('INSERT INTO ticket_import_batches')).sql.includes('ON CONFLICT(workspace_id,batch_key) DO NOTHING'));
});

test('normalized ticket import returns existing batch on idempotency conflict without creating tickets', async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim(); calls.push({ sql: normalized, values });
    if (normalized.startsWith('INSERT INTO ticket_import_batches')) return { rows: [], rowCount: 0 };
    if (normalized.startsWith('SELECT id,workspace_id,batch_key')) return { rows: [{ id: 'batch-existing', workspace_id: 'workspace-1', batch_key: 'external-export-2026', imported_count: 2, imported_by: 'user-1', created_at: new Date('2026-11-19T10:00:00Z') }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const result = await commitNormalizedTicketImport(client, {
    workspaceId: 'workspace-1', batchKey: 'external-export-2026', importedBy: 'user-1', tickets: sampleTickets,
  });
  assert.deepEqual(result, { duplicate: true, batchId: 'batch-existing', imported: 0, tickets: [] });
  assert.equal(calls.filter((call) => call.sql.startsWith('INSERT INTO tickets')).length, 0);
  assert.equal(calls.filter((call) => call.sql.startsWith('INSERT INTO workspace_audit_logs')).length, 0);
});

test('normalized import batch lookup is workspace-scoped', async () => {
  let captured;
  const client = { query: async (sql, values) => { captured = { sql: sql.replace(/\s+/g, ' ').trim(), values }; return { rows: [], rowCount: 0 }; } };
  assert.equal(await findNormalizedImportBatch(client, 'workspace-2', 'batch-key'), null);
  assert.match(captured.sql, /WHERE workspace_id=\$1 AND batch_key=\$2/);
  assert.deepEqual(captured.values, ['workspace-2', 'batch-key']);
});
