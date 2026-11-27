import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const compositeKey = (first, second) => first === undefined || first === null || first === '' || second === undefined || second === null || second === '' ? null : `${String(first)}:${String(second)}`;

const DOMAIN_SPECS = [
  { key: 'users', table: 'users', keyOf: (r) => r.id, fromLegacy: (r) => ({ id:r.id,email:r.email,name:r.name,passwordHash:r.passwordHash,createdAt:r.createdAt }), fromDb: (r) => ({ id:r.id,email:r.email,name:r.name,passwordHash:r.password_hash,createdAt:r.created_at }) },
  { key: 'workspaces', table: 'workspaces', keyOf: (r) => r.id, fromLegacy: (r) => ({ id:r.id,name:r.name,description:r.description ?? '',createdAt:r.createdAt }), fromDb: (r) => ({ id:r.id,name:r.name,description:r.description ?? '',createdAt:r.created_at }) },
  { key: 'memberships', table: 'workspace_memberships', keyOf: (r) => compositeKey(r.workspaceId ?? r.workspace_id, r.userId ?? r.user_id), fromLegacy: (r) => ({ workspaceId:r.workspaceId,userId:r.userId,role:r.role }), fromDb: (r) => ({ workspaceId:r.workspace_id,userId:r.user_id,role:r.role }) },
  { key: 'tickets', table: 'tickets', keyOf: (r) => r.id, fromLegacy: (r) => ({ ...r }), fromDb: (r) => ({ ...(r.extra && typeof r.extra === 'object' ? r.extra : {}),id:r.id,workspaceId:r.workspace_id,title:r.title,description:r.description,status:r.status,priority:r.priority,createdBy:r.created_by,createdAt:r.created_at,updatedAt:r.updated_at }) },
  { key: 'refreshTokens', table: 'auth_refresh_tokens', keyOf: (r) => r.id, fromLegacy: (r) => ({ id:r.id,userId:r.userId,familyId:r.familyId,tokenHash:r.tokenHash,createdAt:r.createdAt,expiresAt:r.expiresAt,revokedAt:r.revokedAt ?? null }), fromDb: (r) => ({ id:r.id,userId:r.user_id,familyId:r.family_id,tokenHash:r.token_hash,createdAt:r.created_at,expiresAt:r.expires_at,revokedAt:r.revoked_at }) },
  { key: 'passwordResets', table: 'password_reset_tokens', keyOf: (r) => r.id, fromLegacy: (r) => ({ id:r.id,userId:r.userId,tokenHash:r.tokenHash,createdAt:r.createdAt,expiresAt:r.expiresAt,usedAt:r.usedAt ?? null }), fromDb: (r) => ({ id:r.id,userId:r.user_id,tokenHash:r.token_hash,createdAt:r.created_at,expiresAt:r.expires_at,usedAt:r.used_at }) },
  { key: 'invitations', table: 'workspace_invitations', keyOf: (r) => r.id, fromLegacy: (r) => ({ id:r.id,workspaceId:r.workspaceId,email:r.email,role:r.role,tokenHash:r.tokenHash,invitedBy:r.invitedBy,createdAt:r.createdAt,expiresAt:r.expiresAt,acceptedAt:r.acceptedAt ?? null,revokedAt:r.revokedAt ?? null }), fromDb: (r) => ({ id:r.id,workspaceId:r.workspace_id,email:r.email,role:r.role,tokenHash:r.token_hash,invitedBy:r.invited_by,createdAt:r.created_at,expiresAt:r.expires_at,acceptedAt:r.accepted_at,revokedAt:r.revoked_at }) },
  { key: 'auditLogs', table: 'workspace_audit_logs', keyOf: (r) => r.id, fromLegacy: (r) => ({ id:r.id,workspaceId:r.workspaceId,actorId:r.actorId ?? null,action:r.action,entityType:r.entityType,entityId:String(r.entityId),metadata:r.metadata ?? {},createdAt:r.createdAt }), fromDb: (r) => ({ id:r.id,workspaceId:r.workspace_id,actorId:r.actor_id,action:r.action,entityType:r.entity_type,entityId:String(r.entity_id),metadata:r.metadata ?? {},createdAt:r.created_at }) },
  { key: 'notifications', table: 'workspace_notifications', keyOf: (r) => r.id, fromLegacy: (r) => ({ id:r.id,workspaceId:r.workspaceId,userId:r.userId,actorId:r.actorId ?? null,type:r.type,title:r.title,message:r.message ?? '',entityId:r.entityId ?? null,createdAt:r.createdAt,readAt:r.readAt ?? null }), fromDb: (r) => ({ id:r.id,workspaceId:r.workspace_id,userId:r.user_id,actorId:r.actor_id,type:r.notification_type,title:r.title,message:r.message ?? '',entityId:r.entity_id,createdAt:r.created_at,readAt:r.read_at }) },
  { key: 'comments', table: 'ticket_comments', keyOf: (r) => r.id, fromLegacy: (r) => ({ id:r.id,workspaceId:r.workspaceId,ticketId:r.ticketId,authorId:r.authorId,body:r.body,mentions:r.mentions ?? [],createdAt:r.createdAt }), fromDb: (r) => ({ id:r.id,workspaceId:r.workspace_id,ticketId:r.ticket_id,authorId:r.author_id,body:r.body,mentions:r.mentions ?? [],createdAt:r.created_at }) },
  { key: 'attachments', table: 'ticket_attachments', keyOf: (r) => r.id, fromLegacy: (r) => ({ id:r.id,workspaceId:r.workspaceId,ticketId:r.ticketId,uploadedBy:r.uploadedBy,name:r.name,mimeType:r.mimeType,size:Number(r.size),storageName:r.storageName,createdAt:r.createdAt,contentSha256:r.contentSha256 ?? null }), fromDb: (r) => ({ id:r.id,workspaceId:r.workspace_id,ticketId:r.ticket_id,uploadedBy:r.uploaded_by,name:r.name,mimeType:r.mime_type,size:Number(r.size_bytes),storageName:r.storage_name,createdAt:r.created_at,contentSha256:r.content_sha256 ?? null }) },
  { key: 'presence', table: 'workspace_presence', keyOf: (r) => compositeKey(r.workspaceId ?? r.workspace_id, r.userId ?? r.user_id), fromLegacy: (r) => ({ workspaceId:r.workspaceId,userId:r.userId,lastSeenAt:r.lastSeenAt }), fromDb: (r) => ({ workspaceId:r.workspace_id,userId:r.user_id,lastSeenAt:r.last_seen_at }), volatile: true },
  { key: 'importBatches', table: 'ticket_import_batches', keyOf: (r) => r.id, fromLegacy: (r) => ({ id:r.id,workspaceId:r.workspaceId,batchKey:r.batchKey,importedCount:Number(r.importedCount),importedBy:r.importedBy,createdAt:r.createdAt }), fromDb: (r) => ({ id:r.id,workspaceId:r.workspace_id,batchKey:r.batch_key,importedCount:Number(r.imported_count),importedBy:r.imported_by,createdAt:r.created_at }) },
];

function canonical(value, field = '') {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], key)]));
  if (typeof value === 'string' && /(At|_at)$/.test(field)) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return value;
}

function compareDomain(spec, legacyRows, dbRows) {
  const oldRows = Array.isArray(legacyRows) ? legacyRows : [];
  const oldByKey = new Map(); const dbByKey = new Map(); const duplicateLegacy = []; const duplicateDb = [];
  for (const row of oldRows) { const key = spec.keyOf(row); if (!key) continue; if (oldByKey.has(key)) duplicateLegacy.push(key); else oldByKey.set(key, row); }
  for (const row of dbRows) { const key = spec.keyOf(row); if (!key) continue; if (dbByKey.has(key)) duplicateDb.push(key); else dbByKey.set(key, row); }
  const invalidLegacyKeys = oldRows.filter((row) => !spec.keyOf(row)).length;
  const invalidDatabaseKeys = dbRows.filter((row) => !spec.keyOf(row)).length;
  const missingInDatabase = [...oldByKey.keys()].filter((key) => !dbByKey.has(key));
  const missingInLegacy = [...dbByKey.keys()].filter((key) => !oldByKey.has(key));
  const changed = [];
  if (!spec.volatile) {
    for (const [key, oldRow] of oldByKey) {
      const dbRow = dbByKey.get(key); if (!dbRow) continue;
      const a = canonical(spec.fromLegacy(oldRow)); const b = canonical(spec.fromDb(dbRow));
      const fields = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter((field) => JSON.stringify(a?.[field]) !== JSON.stringify(b?.[field]));
      if (fields.length) changed.push({ key, fields: fields.slice(0, 20) });
    }
  }
  return {
    legacyCount: oldRows.length, databaseCount: dbRows.length,
    missingInDatabase: missingInDatabase.length, missingInLegacy: missingInLegacy.length,
    duplicateLegacyKeys: [...new Set(duplicateLegacy)].length, duplicateDatabaseKeys: [...new Set(duplicateDb)].length,
    invalidLegacyKeys, invalidDatabaseKeys, fieldDifferences: changed.length, volatile: Boolean(spec.volatile),
    samples: { missingInDatabase: missingInDatabase.slice(0, 10), missingInLegacy: missingInLegacy.slice(0, 10), changed: changed.slice(0, 10) },
  };
}

export function buildDataIntegrityReport({ legacyState, relationalByDomain = {}, foreignKeys = [], orphanChecks = [], attachmentReport = null, legacyTablePresent = true }) {
  const domains = {};
  for (const spec of DOMAIN_SPECS) {
    const raw = legacyState?.[spec.key];
    domains[spec.key] = raw === undefined || !Array.isArray(raw)
      ? { legacyCount: 0, databaseCount: (relationalByDomain[spec.key] || []).length, keyParity: raw === undefined ? 'missing-legacy-domain' : 'invalid-legacy-shape', fieldDifferences: 0, volatile: Boolean(spec.volatile) }
      : compareDomain(spec, raw, relationalByDomain[spec.key] || []);
  }
  const domainIssueCount = Object.values(domains).reduce((sum, item) => sum + Number(item.missingInDatabase || 0) + Number(item.missingInLegacy || 0) + Number(item.duplicateLegacyKeys || 0) + Number(item.duplicateDatabaseKeys || 0) + Number(item.invalidLegacyKeys || 0) + Number(item.invalidDatabaseKeys || 0) + Number(item.fieldDifferences || 0) + (item.keyParity ? 1 : 0), 0);
  const unvalidatedForeignKeys = foreignKeys.filter((item) => !item.validated).map(({ table, name }) => ({ table, name }));
  const orphanCount = orphanChecks.reduce((sum, item) => sum + Number(item.count || 0), 0);
  const attachmentIssues = attachmentReport ? Number(attachmentReport.missingFiles || 0) + Number(attachmentReport.sizeMismatches || 0) + Number(attachmentReport.checksumMismatches || 0) + Number(attachmentReport.missingChecksums || 0) + Number(attachmentReport.unsafeNames || 0) + Number(attachmentReport.orphanFiles || 0) : 0;
  const legacyReady = Boolean(legacyTablePresent && legacyState);
  const issues = domainIssueCount + orphanCount + unvalidatedForeignKeys.length + attachmentIssues;
  return {
    generatedAt: new Date().toISOString(), mode: 'read-only',
    legacy: { tablePresent: legacyTablePresent, snapshotPresent: Boolean(legacyState) },
    domains, foreignKeys: { total: foreignKeys.length, unvalidated: unvalidatedForeignKeys },
    referentialIntegrity: { orphanChecks, orphanCount }, attachmentFiles: attachmentReport,
    summary: { domainsChecked: DOMAIN_SPECS.length, domainsWithDifferences: Object.values(domains).filter((item) => item.fieldDifferences || item.missingInDatabase || item.missingInLegacy || item.invalidLegacyKeys || item.invalidDatabaseKeys || item.keyParity).length, domainIssueCount, orphanCount, unvalidatedForeignKeys: unvalidatedForeignKeys.length, attachmentIssues, issues, status: !legacyReady ? 'legacy-snapshot-unavailable' : issues ? 'attention-required' : 'verified' },
    limitations: [
      'This command is read-only; it does not repair or migrate records.',
      'Presence is ephemeral and its timestamps are not compared because the two stores may have been updated at different times.',
      'Attachment SHA-256 can only be checked when a stored content_sha256 value exists; older files require the explicit checksum backfill command.',
      'A clean report is a point-in-time verification, not a guarantee against later writes or external file loss.',
    ],
  };
}

export async function inspectAttachmentFiles(rows, uploadDir) {
  const root = resolve(uploadDir);
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const referenced = new Set(); const missing = []; const sizeMismatches = []; const checksumMismatches = []; const unsafeNames = []; const noChecksum = []; const hashes = [];
  for (const row of rows) {
    const name = String(row.storage_name || '');
    if (!name || basename(name) !== name || name === '.' || name === '..' || /[\\/\0]/.test(name)) { unsafeNames.push(row.id); continue; }
    referenced.add(name);
    let info;
    try { info = await lstat(join(root, name)); } catch (error) { if (error.code === 'ENOENT') { missing.push(row.id); continue; } throw error; }
    if (!info.isFile()) { unsafeNames.push(row.id); continue; }
    if (info.size !== Number(row.size_bytes)) sizeMismatches.push(row.id);
    const bytes = await readFile(join(root, name));
    const digest = createHash('sha256').update(bytes).digest('hex');
    hashes.push({ attachmentId: row.id, sha256: digest });
    if (row.content_sha256 && digest !== String(row.content_sha256).trim()) checksumMismatches.push(row.id);
    if (!row.content_sha256) noChecksum.push(row.id);
  }
  const orphanFiles = entries.filter((entry) => entry.isFile() && !referenced.has(entry.name)).map((entry) => entry.name);
  return { directoryPresent: entries.length > 0 || (await directoryExists(root)), metadataCount: rows.length, checkedFiles: hashes.length, missingFiles: missing.length, sizeMismatches: sizeMismatches.length, checksumMismatches: checksumMismatches.length, missingChecksums: noChecksum.length, unsafeNames: unsafeNames.length, orphanFiles: orphanFiles.length, samples: { missingFiles: missing.slice(0, 10), sizeMismatches: sizeMismatches.slice(0, 10), checksumMismatches: checksumMismatches.slice(0, 10), missingChecksums: noChecksum.slice(0, 10), unsafeNames: unsafeNames.slice(0, 10), orphanFiles: orphanFiles.slice(0, 10) }, fingerprints: hashes.slice(0, 20) };
}

async function directoryExists(path) { try { const info = await lstat(path); return info.isDirectory(); } catch { return false; } }

export { DOMAIN_SPECS };
