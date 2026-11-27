import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildDataIntegrityReport, inspectAttachmentFiles } from '../data-integrity.mjs';
import { inspectChecksumBackfill } from '../backfill-attachment-checksums.mjs';

const emptyDomains = () => Object.fromEntries([
  'users','workspaces','memberships','tickets','refreshTokens','passwordResets','invitations',
  'auditLogs','notifications','comments','attachments','presence','importBatches',
].map((key) => [key, []]));

test('integrity report detects field-level differences without exposing field values', () => {
  const legacy = { ...emptyDomains(), users: [{ id:'u1',email:'old@example.com',name:'User',passwordHash:'hash',createdAt:'2026-01-01T00:00:00.000Z' }] };
  const relational = emptyDomains();
  relational.users = [{ id:'u1',email:'new@example.com',name:'User',password_hash:'hash',created_at:new Date('2026-01-01T00:00:00.000Z') }];
  const report = buildDataIntegrityReport({ legacyState:legacy, relationalByDomain:relational, foreignKeys:[], orphanChecks:[], legacyTablePresent:true });
  assert.equal(report.domains.users.fieldDifferences, 1);
  assert.deepEqual(report.domains.users.samples.changed[0].fields, ['email']);
  assert.equal(JSON.stringify(report).includes('old@example.com'), false);
  assert.equal(report.summary.status, 'attention-required');
});

test('integrity report excludes volatile presence timestamps but checks identities', () => {
  const legacy = { ...emptyDomains(), presence:[{workspaceId:'w1',userId:'u1',lastSeenAt:'2026-01-01T00:00:00Z'}] };
  const relational = emptyDomains();
  relational.presence = [{workspace_id:'w1',user_id:'u1',last_seen_at:new Date('2026-01-02T00:00:00Z')}];
  const report = buildDataIntegrityReport({ legacyState:legacy, relationalByDomain:relational, legacyTablePresent:true });
  assert.equal(report.domains.presence.fieldDifferences, 0);
  assert.equal(report.domains.presence.volatile, true);
});

test('attachment integrity verifies file size and SHA-256 and finds orphan files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ashkan-integrity-'));
  try {
    const bytes = Buffer.from('sample attachment');
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(root, 'a.bin'), bytes);
    await writeFile(join(root, 'orphan.bin'), 'orphan');
    const report = await inspectAttachmentFiles([{ id:'a1',storage_name:'a.bin',size_bytes:bytes.length,content_sha256:digest }], root);
    assert.equal(report.checkedFiles, 1);
    assert.equal(report.checksumMismatches, 0);
    assert.equal(report.orphanFiles, 1);
    assert.equal(report.missingChecksums, 0);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('attachment integrity reports missing files, wrong hashes, and unsafe storage names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ashkan-integrity-bad-'));
  try {
    await writeFile(join(root, 'bad.bin'), 'bytes');
    const report = await inspectAttachmentFiles([
      { id:'a1',storage_name:'missing.bin',size_bytes:1,content_sha256:null },
      { id:'a2',storage_name:'bad.bin',size_bytes:5,content_sha256:'0'.repeat(64) },
      { id:'a3',storage_name:'../outside',size_bytes:1,content_sha256:null },
    ], root);
    assert.equal(report.missingFiles, 1);
    assert.equal(report.checksumMismatches, 1);
    assert.equal(report.unsafeNames, 1);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('checksum backfill is a dry-run planner and rejects missing or unsafe files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ashkan-checksum-plan-'));
  try {
    await writeFile(join(root, 'good.bin'), 'good');
    const plan = await inspectChecksumBackfill([
      { id:'a1',storage_name:'good.bin',size_bytes:4,content_sha256:null },
      { id:'a2',storage_name:'absent.bin',size_bytes:4,content_sha256:null },
      { id:'a3',storage_name:'../bad',size_bytes:1,content_sha256:null },
    ], root);
    assert.equal(plan.eligible.length, 1);
    assert.equal(plan.missing.length, 1);
    assert.equal(plan.unsafe.length, 1);
    assert.equal(plan.eligible[0].sha256, createHash('sha256').update('good').digest('hex'));
  } finally { await rm(root,{recursive:true,force:true}); }
});


test('integrity summary includes unvalidated foreign keys and orphan references', () => {
  const report = buildDataIntegrityReport({
    legacyState: emptyDomains(), relationalByDomain: emptyDomains(),
    foreignKeys: [{ name:'fk_unvalidated',table:'tickets',validated:false }],
    orphanChecks: [{ name:'comments.ticket_workspace',count:2 }], legacyTablePresent:true,
  });
  assert.equal(report.summary.unvalidatedForeignKeys, 1);
  assert.equal(report.summary.orphanCount, 2);
  assert.equal(report.summary.status, 'attention-required');
});


test('integrity report flags records without stable identity keys', () => {
  const legacy = { ...emptyDomains(), memberships:[{ workspaceId:null,userId:'u1',role:'member' }] };
  const relational = emptyDomains();
  const report = buildDataIntegrityReport({ legacyState:legacy, relationalByDomain:relational, legacyTablePresent:true });
  assert.equal(report.domains.memberships.invalidLegacyKeys, 1);
  assert.equal(report.summary.status, 'attention-required');
});
