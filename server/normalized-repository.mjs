import { randomUUID } from 'node:crypto';

const iso = (value) => value ? new Date(value) : null;
const json = (value) => JSON.stringify(value ?? {});

async function insertRows(client, sql, rows, values) {
  for (const row of rows || []) await client.query(sql, values(row));
}

/**
 * Rebuilds the normalized relational projection within the caller's transaction.
 * The aggregate JSONB record remains authoritative until the repository cut-over phase.
 */
export async function syncNormalizedState(client, state) {
  const tables = [
    'workspace_presence', 'ticket_attachments', 'ticket_comments', 'ticket_import_batches',
    'workspace_notifications', 'workspace_audit_logs', 'workspace_invitations',
    'password_reset_tokens', 'auth_refresh_tokens', 'tickets', 'workspace_memberships',
    'workspaces', 'users',
  ];
  for (const table of tables) await client.query(`DELETE FROM ${table}`);

  await insertRows(client,
    'INSERT INTO users(id,email,name,password_hash,created_at) VALUES($1,$2,$3,$4,$5)',
    state.users, (r) => [r.id, r.email, r.name, r.passwordHash, iso(r.createdAt)]);
  await insertRows(client,
    'INSERT INTO workspaces(id,name,description,created_at) VALUES($1,$2,$3,$4)',
    state.workspaces, (r) => [r.id, r.name, r.description || '', iso(r.createdAt)]);
  for (const workspace of state.workspaces || []) await seedNormalizedWorkspaceRoles(client, workspace.id);
  await insertRows(client,
    'INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)',
    state.memberships, (r) => [r.workspaceId, r.userId, r.role]);
  await insertRows(client,
    'INSERT INTO tickets(id,workspace_id,title,description,status,priority,created_by,created_at,updated_at,extra) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',
    state.tickets, (r) => {
      const { id, workspaceId, title, description, status, priority, createdBy, createdAt, updatedAt, ...extra } = r;
      return [id, workspaceId, title, description || '', status, priority, createdBy, iso(createdAt), iso(updatedAt), json(extra)];
    });
  await insertRows(client,
    'INSERT INTO auth_refresh_tokens(id,user_id,family_id,token_hash,created_at,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    state.refreshTokens, (r) => [r.id, r.userId, r.familyId, r.tokenHash, iso(r.createdAt), iso(r.expiresAt), iso(r.revokedAt)]);
  await insertRows(client,
    'INSERT INTO password_reset_tokens(id,user_id,token_hash,created_at,expires_at,used_at) VALUES($1,$2,$3,$4,$5,$6)',
    state.passwordResets, (r) => [r.id, r.userId, r.tokenHash, iso(r.createdAt), iso(r.expiresAt), iso(r.usedAt)]);
  await insertRows(client,
    'INSERT INTO workspace_invitations(id,workspace_id,email,role,token_hash,invited_by,created_at,expires_at,accepted_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    state.invitations, (r) => [r.id, r.workspaceId, r.email, r.role, r.tokenHash, r.invitedBy, iso(r.createdAt), iso(r.expiresAt), iso(r.acceptedAt), iso(r.revokedAt)]);
  await insertRows(client,
    'INSERT INTO workspace_audit_logs(id,workspace_id,actor_id,action,entity_type,entity_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
    state.auditLogs, (r) => [r.id, r.workspaceId, r.actorId || null, r.action, r.entityType, String(r.entityId), json(r.metadata), iso(r.createdAt)]);
  await insertRows(client,
    'INSERT INTO workspace_notifications(id,workspace_id,user_id,actor_id,notification_type,title,message,entity_id,created_at,read_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    state.notifications, (r) => [r.id, r.workspaceId, r.userId, r.actorId || null, r.type, r.title, r.message || '', r.entityId || null, iso(r.createdAt), iso(r.readAt)]);
  await insertRows(client,
    'INSERT INTO ticket_import_batches(id,workspace_id,batch_key,imported_count,imported_by,created_at) VALUES($1,$2,$3,$4,$5,$6)',
    state.importBatches, (r) => [r.id, r.workspaceId, r.batchKey, r.importedCount, r.importedBy, iso(r.createdAt)]);
  await insertRows(client,
    'INSERT INTO ticket_comments(id,workspace_id,ticket_id,author_id,body,mentions,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    state.comments, (r) => [r.id, r.workspaceId, r.ticketId, r.authorId, r.body, r.mentions || [], iso(r.createdAt)]);
  await insertRows(client,
    'INSERT INTO ticket_attachments(id,workspace_id,ticket_id,uploaded_by,name,mime_type,size_bytes,storage_name,created_at,content_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    state.attachments, (r) => [r.id, r.workspaceId, r.ticketId, r.uploadedBy, r.name, r.mimeType, r.size, r.storageName, iso(r.createdAt), r.contentSha256 || null]);
  await insertRows(client,
    'INSERT INTO workspace_presence(workspace_id,user_id,last_seen_at) VALUES($1,$2,$3)',
    state.presence, (r) => [r.workspaceId, r.userId, iso(r.lastSeenAt)]);
}



/** Look up an idempotency batch without reading the compatibility aggregate. */
export async function findNormalizedImportBatch(client, workspaceId, batchKey) {
  const result = await client.query(
    'SELECT id,workspace_id,batch_key,imported_count,imported_by,created_at FROM ticket_import_batches WHERE workspace_id=$1 AND batch_key=$2',
    [workspaceId, batchKey],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id, workspaceId: row.workspace_id, batchKey: row.batch_key,
    importedCount: Number(row.imported_count), importedBy: row.imported_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  } : null;
}

/**
 * Commit an import batch atomically. The unique (workspace_id,batch_key) key is
 * the concurrency guard: concurrent requests can only create one batch.
 */
export async function commitNormalizedTicketImport(client, { workspaceId, batchKey, importedBy, tickets, batchId = randomUUID(), auditId = randomUUID(), now = new Date() }) {
  const createdAt = iso(now);
  const insertedBatch = await client.query(
    `INSERT INTO ticket_import_batches(id,workspace_id,batch_key,imported_count,imported_by,created_at)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,batch_key) DO NOTHING RETURNING id`,
    [batchId, workspaceId, batchKey, tickets.length, importedBy, createdAt],
  );
  if (!insertedBatch.rowCount) {
    const existing = await findNormalizedImportBatch(client, workspaceId, batchKey);
    return { duplicate: true, batchId: existing?.id || null, imported: 0, tickets: [] };
  }

  const created = [];
  for (const item of tickets) {
    const ticket = {
      id: randomUUID(), workspaceId, title: item.title, description: item.description || '',
      status: item.status, priority: item.priority, type: item.type, dueDate: item.dueDate,
      tags: item.tags || [], createdBy: importedBy, createdAt: now.toISOString(), updatedAt: null,
    };
    await createNormalizedTicket(client, ticket);
    created.push(ticket);
  }
  await insertNormalizedAudit(client, {
    id: auditId, workspaceId, actorId: importedBy, action: 'tickets.imported',
    entityType: 'import_batch', entityId: batchId, metadata: { count: created.length }, createdAt: now,
  });
  return { duplicate: false, batchId, imported: created.length, tickets: created };
}

const sortableColumns = {
  createdAt: 'created_at', updatedAt: 'updated_at', title: 'title',
  status: 'status', priority: 'priority',
};

function ticketFromRow(row) {
  const extra = row.extra && typeof row.extra === 'object' ? row.extra : {};
  return {
    ...extra,
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description || '',
    status: row.status,
    priority: row.priority,
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at ? (row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at) : null,
  };
}

/** Reads a bounded, filtered ticket page directly from relational PostgreSQL tables. */
export async function listNormalizedTickets(client, workspaceId, options = {}) {
  const page = Math.max(1, Math.min(1_000_000, Number.parseInt(options.page, 10) || 1));
  const pageSize = Math.max(1, Math.min(100, Number.parseInt(options.pageSize, 10) || 25));
  const where = ['workspace_id = $1'];
  const values = [workspaceId];
  const add = (clause, value) => { values.push(value); where.push(clause.replace('?', `$${values.length}`)); };
  if (['backlog','todo','in-progress','qa','done'].includes(options.status)) add('status = ?', options.status);
  if (['High','Medium','Low'].includes(options.priority)) add('priority = ?', options.priority);
  const search = String(options.search || '').trim().slice(0, 120);
  if (search) { values.push(`%${search}%`, `%${search}%`); where.push(`(title ILIKE $${values.length - 1} OR description ILIKE $${values.length})`); }
  const whereSql = where.join(' AND ');
  const sortColumn = sortableColumns[options.sort] || 'created_at';
  const direction = String(options.direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const countResult = await client.query(`SELECT COUNT(*)::int AS total FROM tickets WHERE ${whereSql}`, values);
  const total = Number(countResult.rows[0]?.total || 0);
  const offset = (page - 1) * pageSize;
  const pageValues = [...values, pageSize, offset];
  const result = await client.query(
    `SELECT id, workspace_id, title, description, status, priority, created_by, created_at, updated_at, extra
     FROM tickets WHERE ${whereSql} ORDER BY ${sortColumn} ${direction} NULLS LAST, id ASC
     LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues,
  );
  return { tickets: result.rows.map(ticketFromRow), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasNext: offset + result.rows.length < total, hasPrevious: page > 1 } };
}

const ticketFields = ['type','dueDate','assigneeId','projectId','tests','tags','comments','estimateHours','timeSpentHours','dependsOn','recurrence'];
function normalizedExtra(input = {}) {
  const extra = {};
  for (const key of ticketFields) if (input[key] !== undefined) extra[key] = input[key];
  return extra;
}

export async function createNormalizedTicket(client, ticket) {
  const { id, workspaceId, title, description, status, priority, createdBy, createdAt, updatedAt, ...rest } = ticket;
  await client.query(
    `INSERT INTO tickets(id,workspace_id,title,description,status,priority,created_by,created_at,updated_at,extra)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [id, workspaceId, title, description || '', status, priority, createdBy, iso(createdAt), iso(updatedAt), json(rest)],
  );
  return ticket;
}

export async function updateNormalizedTicket(client, workspaceId, ticketId, input, now = new Date()) {
  const existingResult = await client.query(
    `SELECT id,workspace_id,title,description,status,priority,created_by,created_at,updated_at,extra
     FROM tickets WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [ticketId, workspaceId],
  );
  if (!existingResult.rows[0]) return null;
  const current = ticketFromRow(existingResult.rows[0]);
  if (input.title !== undefined) current.title = input.title;
  if (input.description !== undefined) current.description = input.description;
  if (input.status !== undefined) current.status = input.status;
  if (input.priority !== undefined) current.priority = input.priority;
  for (const key of ticketFields) if (input[key] !== undefined) current[key] = input[key];
  current.updatedAt = now.toISOString();
  const { id, workspaceId: ws, title, description, status, priority, createdBy, createdAt, updatedAt, ...rest } = current;
  await client.query(
    `UPDATE tickets SET title=$1,description=$2,status=$3,priority=$4,updated_at=$5,extra=$6::jsonb
     WHERE id=$7 AND workspace_id=$8`,
    [title, description || '', status, priority, iso(updatedAt), json(rest), id, ws],
  );
  return current;
}

export async function deleteNormalizedTicket(client, workspaceId, ticketId) {
  const result = await client.query('DELETE FROM tickets WHERE id=$1 AND workspace_id=$2 RETURNING id', [ticketId, workspaceId]);
  return Boolean(result.rowCount);
}

export async function findNormalizedUserById(client, userId) {
  const result = await client.query('SELECT id,email,name,created_at FROM users WHERE id=$1', [userId]);
  return result.rows[0] ? { id: result.rows[0].id, email: result.rows[0].email, name: result.rows[0].name, createdAt: result.rows[0].created_at } : null;
}

export async function findNormalizedUserByEmail(client, email) {
  const result = await client.query('SELECT id,email,name,password_hash,created_at FROM users WHERE email=$1', [email]);
  return result.rows[0] ? { id: result.rows[0].id, email: result.rows[0].email, name: result.rows[0].name, passwordHash: result.rows[0].password_hash, createdAt: result.rows[0].created_at } : null;
}

export async function listNormalizedWorkspacesForUser(client, userId) {
  const result = await client.query(`SELECT w.id,w.name,w.description,w.created_at,m.role
    FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id
    WHERE m.user_id=$1 ORDER BY w.created_at ASC,w.id ASC`, [userId]);
  return result.rows.map((row) => ({ id: row.id, name: row.name, description: row.description || '', createdAt: row.created_at, role: row.role }));
}

export async function findNormalizedMembership(client, userId, workspaceId) {
  const result = await client.query(`SELECT m.workspace_id,m.user_id,m.role,m.joined_at,COALESCE(r.permissions,'[]'::jsonb) AS permissions
    FROM workspace_memberships m LEFT JOIN workspace_roles r ON r.workspace_id=m.workspace_id AND r.role_key=m.role
    WHERE m.user_id=$1 AND m.workspace_id=$2`, [userId, workspaceId]);
  const row = result.rows[0];
  return row ? { userId: row.user_id, workspaceId: row.workspace_id, role: row.role, joinedAt: row.joined_at, permissions: Array.isArray(row.permissions) ? row.permissions : [] } : null;
}

export async function seedNormalizedWorkspaceRoles(client, workspaceId) {
  const defaults = [
    ['owner','Owner',['read','create','update','delete','members','roles','audit']],
    ['admin','Administrator',['read','create','update','delete','members','audit']],
    ['member','Member',['read','create','update']],
    ['viewer','Viewer',['read']],
  ];
  for (const [key,name,permissions] of defaults) await client.query(
    `INSERT INTO workspace_roles(id,workspace_id,role_key,display_name,permissions,is_system) VALUES(gen_random_uuid(),$1,$2,$3,$4::jsonb,true) ON CONFLICT(workspace_id,role_key) DO NOTHING`,
    [workspaceId,key,name,JSON.stringify(permissions)],
  );
}

export async function listNormalizedRoles(client, workspaceId) {
  const result = await client.query(`SELECT id,workspace_id,role_key,display_name,permissions,is_system,created_at FROM workspace_roles WHERE workspace_id=$1 ORDER BY is_system DESC,display_name`, [workspaceId]);
  return result.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, key: row.role_key, name: row.display_name, permissions: Array.isArray(row.permissions) ? row.permissions : [], isSystem: row.is_system, createdAt: row.created_at }));
}

export async function createNormalizedRole(client, { workspaceId, key, name, permissions }) {
  const result = await client.query(`INSERT INTO workspace_roles(id,workspace_id,role_key,display_name,permissions,is_system) VALUES(gen_random_uuid(),$1,$2,$3,$4::jsonb,false) RETURNING id,workspace_id,role_key,display_name,permissions,is_system,created_at`, [workspaceId,key,name,JSON.stringify(permissions)]);
  const row=result.rows[0];
  return { id: row.id, workspaceId: row.workspace_id, key: row.role_key, name: row.display_name, permissions: row.permissions, isSystem: row.is_system, createdAt: row.created_at };
}

export async function updateNormalizedRole(client, workspaceId, key, { name, permissions }) {
  const result = await client.query(`UPDATE workspace_roles SET display_name=COALESCE($3,display_name),permissions=COALESCE($4::jsonb,permissions) WHERE workspace_id=$1 AND role_key=$2 AND is_system=false RETURNING id,workspace_id,role_key,display_name,permissions,is_system,created_at`, [workspaceId,key,name ?? null,permissions ? JSON.stringify(permissions) : null]);
  const row=result.rows[0];
  return row ? { id: row.id, workspaceId: row.workspace_id, key: row.role_key, name: row.display_name, permissions: row.permissions, isSystem: row.is_system, createdAt: row.created_at } : null;
}

export async function deleteNormalizedRole(client, workspaceId, key) {
  const result = await client.query(`DELETE FROM workspace_roles WHERE workspace_id=$1 AND role_key=$2 AND is_system=false RETURNING role_key`, [workspaceId,key]);
  return Boolean(result.rowCount);
}


export async function listNormalizedMembers(client, workspaceId) {
  const result = await client.query(`SELECT m.user_id,m.workspace_id,m.role,m.joined_at,u.id,u.email,u.name,u.created_at,COALESCE(r.permissions,'[]'::jsonb) AS permissions
    FROM workspace_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN workspace_roles r ON r.workspace_id=m.workspace_id AND r.role_key=m.role
    WHERE m.workspace_id=$1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.name ASC`, [workspaceId]);
  return result.rows.map((row) => ({ userId: row.user_id, workspaceId: row.workspace_id, role: row.role, joinedAt: row.joined_at, permissions: Array.isArray(row.permissions) ? row.permissions : [],
    user: { id: row.id, email: row.email, name: row.name, createdAt: row.created_at } }));
}

export async function findNormalizedWorkspace(client, workspaceId) {
  const result = await client.query('SELECT id,name,description,created_at FROM workspaces WHERE id=$1', [workspaceId]);
  const row = result.rows[0];
  return row ? { id: row.id, name: row.name, description: row.description || '', createdAt: row.created_at } : null;
}

const publicUser = (row) => row ? ({ id: row.id, email: row.email, name: row.name, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at }) : null;

export async function createNormalizedAccount(client, { user, workspace, membership }) {
  await client.query('INSERT INTO users(id,email,name,password_hash,created_at) VALUES($1,$2,$3,$4,$5)', [user.id, user.email, user.name, user.passwordHash, iso(user.createdAt)]);
  await client.query('INSERT INTO workspaces(id,name,description,created_at) VALUES($1,$2,$3,$4)', [workspace.id, workspace.name, workspace.description || '', iso(workspace.createdAt)]);
  await seedNormalizedWorkspaceRoles(client, workspace.id)
  await client.query('INSERT INTO workspace_memberships(workspace_id,user_id,role,joined_at) VALUES($1,$2,$3,$4)', [membership.workspaceId, membership.userId, membership.role, iso(membership.joinedAt)]);
  return { user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt }, workspace: { ...workspace, role: membership.role } };
}

export async function updateNormalizedUser(client, userId, { name }) {
  const result = await client.query('UPDATE users SET name=$1 WHERE id=$2 RETURNING id,email,name,created_at', [name, userId]);
  return publicUser(result.rows[0]);
}

export async function createNormalizedWorkspace(client, workspace, ownerId) {
  await client.query('INSERT INTO workspaces(id,name,description,created_at) VALUES($1,$2,$3,$4)', [workspace.id, workspace.name, workspace.description || '', iso(workspace.createdAt)]);
  await client.query('INSERT INTO workspace_memberships(workspace_id,user_id,role,joined_at) VALUES($1,$2,$3,$4)', [workspace.id, ownerId, 'owner', iso(workspace.createdAt)]);
  return { ...workspace, role: 'owner' };
}

export async function addNormalizedMembership(client, { workspaceId, userId, role, joinedAt = new Date().toISOString() }) {
  const result = await client.query('INSERT INTO workspace_memberships(workspace_id,user_id,role,joined_at) VALUES($1,$2,$3,$4) ON CONFLICT (workspace_id,user_id) DO NOTHING RETURNING workspace_id,user_id,role,joined_at', [workspaceId, userId, role, iso(joinedAt)]);
  const row = result.rows[0];
  return row ? { workspaceId: row.workspace_id, userId: row.user_id, role: row.role, joinedAt: row.joined_at } : null;
}

export async function updateNormalizedMembershipRole(client, workspaceId, userId, role) {
  const result = await client.query("UPDATE workspace_memberships SET role=$1 WHERE workspace_id=$2 AND user_id=$3 AND role <> 'owner' RETURNING workspace_id,user_id,role,joined_at", [role, workspaceId, userId]);
  const row = result.rows[0];
  return row ? { workspaceId: row.workspace_id, userId: row.user_id, role: row.role, joinedAt: row.joined_at } : null;
}

export async function removeNormalizedMembership(client, workspaceId, userId) {
  const result = await client.query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role <> 'owner' RETURNING user_id", [workspaceId, userId]);
  return Boolean(result.rowCount);
}

export async function insertNormalizedAudit(client, { id, workspaceId, actorId, action, entityType, entityId, metadata = {}, createdAt = new Date().toISOString() }) {
  await client.query('INSERT INTO workspace_audit_logs(id,workspace_id,actor_id,action,entity_type,entity_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [id, workspaceId, actorId, action, entityType, String(entityId), json(metadata), iso(createdAt)]);
}

export async function listNormalizedAudit(client, workspaceId, options = {}) {
  const normalizedOptions = typeof options === 'number' ? { limit: options } : (options || {});
  const { limit = 200, actorId = '', action = '', entityType = '', from = '', to = '' } = normalizedOptions;
  const boundedLimit = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 200));
  const values = [workspaceId];
  const where = ['workspace_id=$1'];
  const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
  if (actorId) add('actor_id=?', actorId);
  if (action) add('action=?', action);
  if (entityType) add('entity_type=?', entityType);
  if (from) add('created_at>=?::timestamptz', from);
  if (to) add('created_at<=?::timestamptz', to);
  values.push(boundedLimit);
  const result = await client.query(`SELECT id,workspace_id,actor_id,action,entity_type,entity_id,metadata,created_at
    FROM workspace_audit_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT $${values.length}`, values);
  return result.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, actorId: row.actor_id, action: row.action, entityType: row.entity_type, entityId: row.entity_id, metadata: row.metadata || {}, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at }));
}

export async function createNormalizedPasswordReset(client, { id, userId, tokenHash, createdAt, expiresAt }) {
  await client.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [userId]);
  await client.query('INSERT INTO password_reset_tokens(id,user_id,token_hash,created_at,expires_at,used_at) VALUES($1,$2,$3,$4,$5,NULL)', [id, userId, tokenHash, iso(createdAt), iso(expiresAt)]);
}

export async function consumeNormalizedPasswordReset(client, tokenHash, passwordHash, now = new Date()) {
  const token = await client.query('SELECT id,user_id FROM password_reset_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>$2 FOR UPDATE', [tokenHash, now]);
  const row = token.rows[0];
  if (!row) return null;
  const updated = await client.query('UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id', [passwordHash, row.user_id]);
  if (!updated.rowCount) return null;
  await client.query('UPDATE password_reset_tokens SET used_at=$1 WHERE id=$2', [now, row.id]);
  await client.query('UPDATE auth_refresh_tokens SET revoked_at=COALESCE(revoked_at,$2) WHERE user_id=$1 AND revoked_at IS NULL', [row.user_id, now]);
  return row.user_id;
}


/** Persist a refresh-token record in the relational session store. */
export async function createNormalizedRefreshToken(client, record) {
  await client.query(
    `INSERT INTO auth_refresh_tokens(id,user_id,family_id,token_hash,created_at,expires_at,revoked_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [record.id, record.userId, record.familyId, record.tokenHash, iso(record.createdAt), iso(record.expiresAt), iso(record.revokedAt)],
  );
}

/** Rotate a refresh token under row lock; reuse revokes the entire token family. */
export async function rotateNormalizedRefreshToken(client, tokenHash, createSession, now = new Date()) {
  const selected = await client.query(
    `SELECT id,user_id,family_id,expires_at,revoked_at
     FROM auth_refresh_tokens WHERE token_hash=$1 FOR UPDATE`, [tokenHash],
  );
  const token = selected.rows[0];
  if (!token) return null;
  if (token.revoked_at || new Date(token.expires_at) <= now) {
    await client.query('UPDATE auth_refresh_tokens SET revoked_at=COALESCE(revoked_at,$2) WHERE family_id=$1', [token.family_id, now]);
    return null;
  }
  const userResult = await client.query('SELECT id,email,name,created_at FROM users WHERE id=$1', [token.user_id]);
  const row = userResult.rows[0];
  if (!row) {
    await client.query('UPDATE auth_refresh_tokens SET revoked_at=COALESCE(revoked_at,$2) WHERE family_id=$1', [token.family_id, now]);
    return null;
  }
  const user = { id: row.id, email: row.email, name: row.name, createdAt: row.created_at };
  const session = createSession(user, token.family_id);
  await client.query('UPDATE auth_refresh_tokens SET revoked_at=$1 WHERE id=$2', [now, token.id]);
  await createNormalizedRefreshToken(client, session.refreshRecord);
  return { user, accessToken: session.accessToken, refreshToken: session.refreshToken };
}

export async function revokeNormalizedRefreshFamily(client, tokenHash, now = new Date()) {
  const result = await client.query('UPDATE auth_refresh_tokens SET revoked_at=COALESCE(revoked_at,$2) WHERE family_id=(SELECT family_id FROM auth_refresh_tokens WHERE token_hash=$1) RETURNING id', [tokenHash, now]);
  return result.rowCount > 0;
}

export async function revokeNormalizedUserSessions(client, userId, now = new Date()) {
  const result = await client.query('UPDATE auth_refresh_tokens SET revoked_at=COALESCE(revoked_at,$2) WHERE user_id=$1 AND revoked_at IS NULL RETURNING id', [userId, now]);
  return result.rowCount;
}

export async function revokeNormalizedSessionFamily(client, userId, familyId, now = new Date()) {
  const result = await client.query('UPDATE auth_refresh_tokens SET revoked_at=COALESCE(revoked_at,$3) WHERE user_id=$1 AND family_id=$2 AND revoked_at IS NULL RETURNING id', [userId, familyId, now]);
  return result.rowCount;
}

export async function createNormalizedInvitation(client, invitation) {
  // Serialize invitations for the same workspace/email pair to avoid concurrent active duplicates.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [invitation.workspaceId, invitation.email.toLowerCase()]);
  await client.query(
    `UPDATE workspace_invitations SET revoked_at=$3
     WHERE workspace_id=$1 AND lower(email)=lower($2) AND accepted_at IS NULL AND revoked_at IS NULL`,
    [invitation.workspaceId, invitation.email, invitation.createdAt],
  );
  await client.query(
    `INSERT INTO workspace_invitations(id,workspace_id,email,role,token_hash,invited_by,created_at,expires_at,accepted_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)`,
    [invitation.id, invitation.workspaceId, invitation.email, invitation.role, invitation.tokenHash, invitation.invitedBy, iso(invitation.createdAt), iso(invitation.expiresAt)],
  );
  await insertNormalizedAudit(client, { id: invitation.auditId, workspaceId: invitation.workspaceId, actorId: invitation.invitedBy, action: 'member.invited', entityType: 'invitation', entityId: invitation.email, metadata: { role: invitation.role }, createdAt: invitation.createdAt });
}

/** Accept only a live invitation for the authenticated email; membership and audit commit atomically. */
export async function acceptNormalizedInvitation(client, { tokenHash, userId, email, now = new Date(), auditId }) {
  const result = await client.query(
    `SELECT id,workspace_id,email,role,expires_at,accepted_at,revoked_at
     FROM workspace_invitations WHERE token_hash=$1 FOR UPDATE`, [tokenHash],
  );
  const invite = result.rows[0];
  if (!invite || invite.accepted_at || invite.revoked_at || new Date(invite.expires_at) <= now || invite.email.toLowerCase() !== email.toLowerCase()) return null;
  const membershipResult = await client.query(
    `INSERT INTO workspace_memberships(workspace_id,user_id,role,joined_at)
     VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,user_id) DO NOTHING
     RETURNING workspace_id,user_id,role,joined_at`,
    [invite.workspace_id, userId, invite.role, now],
  );
  await client.query('UPDATE workspace_invitations SET accepted_at=$1 WHERE id=$2', [now, invite.id]);
  const inserted = membershipResult.rows[0];
  if (inserted) {
    await insertNormalizedAudit(client, { id: auditId, workspaceId: invite.workspace_id, actorId: userId, action: 'member.invitation_accepted', entityType: 'membership', entityId: userId, metadata: { role: invite.role }, createdAt: now });
  }
  const finalRole = inserted?.role || (await client.query('SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [invite.workspace_id, userId])).rows[0]?.role || invite.role;
  return { workspaceId: invite.workspace_id, role: finalRole, alreadyMember: !inserted };
}


const isoValue = (value) => value instanceof Date ? value.toISOString() : value;

export async function findNormalizedTicket(client, workspaceId, ticketId) {
  const result = await client.query('SELECT id,workspace_id,title FROM tickets WHERE workspace_id=$1 AND id=$2', [workspaceId, ticketId]);
  const row = result.rows[0];
  return row ? { id: row.id, workspaceId: row.workspace_id, title: row.title } : null;
}

export async function listNormalizedComments(client, workspaceId, ticketId) {
  const result = await client.query(`SELECT c.id,c.workspace_id,c.ticket_id,c.author_id,c.body,c.mentions,c.created_at,u.id AS user_id,u.email AS user_email,u.name AS user_name,u.created_at AS user_created_at
    FROM ticket_comments c JOIN users u ON u.id=c.author_id
    WHERE c.workspace_id=$1 AND c.ticket_id=$2 ORDER BY c.created_at ASC,c.id ASC`, [workspaceId, ticketId]);
  return result.rows.map((r) => ({ id:r.id, workspaceId:r.workspace_id, ticketId:r.ticket_id, authorId:r.author_id, body:r.body, mentions:r.mentions || [], createdAt:isoValue(r.created_at), author:{ id:r.user_id,email:r.user_email,name:r.user_name,createdAt:isoValue(r.user_created_at) } }));
}

export async function createNormalizedComment(client, { comment, recipients = [], notificationFactory, auditId, ticketTitle }) {
  await client.query('INSERT INTO ticket_comments(id,workspace_id,ticket_id,author_id,body,mentions,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [comment.id,comment.workspaceId,comment.ticketId,comment.authorId,comment.body,comment.mentions || [],iso(comment.createdAt)]);
  await insertNormalizedAudit(client, { id:auditId,workspaceId:comment.workspaceId,actorId:comment.authorId,action:'comment.created',entityType:'comment',entityId:comment.id,metadata:{ticketId:comment.ticketId,title:ticketTitle},createdAt:comment.createdAt });
  for (const recipientId of recipients) {
    const notification = notificationFactory(recipientId);
    if (await notificationPreferenceAllows(client, notification.workspaceId, notification.userId, notification.type)) {
      await client.query('INSERT INTO workspace_notifications(id,workspace_id,user_id,actor_id,notification_type,title,message,entity_id,created_at,read_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)', [notification.id,notification.workspaceId,notification.userId,notification.actorId,notification.type,notification.title,notification.message,notification.entityId,iso(notification.createdAt)]);
    }
  }
}

export async function deleteNormalizedComment(client, { workspaceId, ticketId, commentId, auditId, actorId }) {
  const result = await client.query('DELETE FROM ticket_comments WHERE workspace_id=$1 AND ticket_id=$2 AND id=$3 RETURNING id', [workspaceId,ticketId,commentId]);
  if (!result.rowCount) return false;
  await insertNormalizedAudit(client, { id:auditId,workspaceId,actorId,action:'comment.deleted',entityType:'comment',entityId:commentId,metadata:{ticketId} });
  return true;
}

export async function getNormalizedNotificationPreferences(client, workspaceId, userId) {
  const result = await client.query(`SELECT workspace_id,user_id,notifications_enabled,mention_enabled,ticket_updates_enabled,comments_enabled,system_enabled,updated_at
    FROM workspace_notification_preferences WHERE workspace_id=$1 AND user_id=$2`, [workspaceId,userId]);
  const row = result.rows[0];
  return row ? { workspaceId:row.workspace_id,userId:row.user_id,notificationsEnabled:row.notifications_enabled,mentionEnabled:row.mention_enabled,ticketUpdatesEnabled:row.ticket_updates_enabled,commentsEnabled:row.comments_enabled,systemEnabled:row.system_enabled,updatedAt:isoValue(row.updated_at) } : { workspaceId,userId,notificationsEnabled:true,mentionEnabled:true,ticketUpdatesEnabled:true,commentsEnabled:true,systemEnabled:true };
}

export async function upsertNormalizedNotificationPreferences(client, workspaceId, userId, input = {}) {
  const current = await getNormalizedNotificationPreferences(client, workspaceId, userId);
  const next = {
    notificationsEnabled: input.notificationsEnabled === undefined ? current.notificationsEnabled : Boolean(input.notificationsEnabled),
    mentionEnabled: input.mentionEnabled === undefined ? current.mentionEnabled : Boolean(input.mentionEnabled),
    ticketUpdatesEnabled: input.ticketUpdatesEnabled === undefined ? current.ticketUpdatesEnabled : Boolean(input.ticketUpdatesEnabled),
    commentsEnabled: input.commentsEnabled === undefined ? current.commentsEnabled : Boolean(input.commentsEnabled),
    systemEnabled: input.systemEnabled === undefined ? current.systemEnabled : Boolean(input.systemEnabled)
  };
  const result = await client.query(`INSERT INTO workspace_notification_preferences(workspace_id,user_id,notifications_enabled,mention_enabled,ticket_updates_enabled,comments_enabled,system_enabled,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,now())
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET notifications_enabled=EXCLUDED.notifications_enabled,mention_enabled=EXCLUDED.mention_enabled,ticket_updates_enabled=EXCLUDED.ticket_updates_enabled,comments_enabled=EXCLUDED.comments_enabled,system_enabled=EXCLUDED.system_enabled,updated_at=now()
    RETURNING workspace_id,user_id,notifications_enabled,mention_enabled,ticket_updates_enabled,comments_enabled,system_enabled,updated_at`, [workspaceId,userId,next.notificationsEnabled,next.mentionEnabled,next.ticketUpdatesEnabled,next.commentsEnabled,next.systemEnabled]);
  const row = result.rows[0];
  return { workspaceId:row.workspace_id,userId:row.user_id,notificationsEnabled:row.notifications_enabled,mentionEnabled:row.mention_enabled,ticketUpdatesEnabled:row.ticket_updates_enabled,commentsEnabled:row.comments_enabled,systemEnabled:row.system_enabled,updatedAt:isoValue(row.updated_at) };
}

export async function notificationPreferenceAllows(client, workspaceId, userId, type) {
  const prefs = await getNormalizedNotificationPreferences(client, workspaceId, userId);
  if (!prefs.notificationsEnabled) return false;
  const normalized = String(type || '').toLowerCase();
  if (normalized.includes('mention')) return prefs.mentionEnabled;
  if (normalized.includes('comment')) return prefs.commentsEnabled;
  if (normalized.startsWith('ticket.') || normalized.includes('ticket')) return prefs.ticketUpdatesEnabled;
  return prefs.systemEnabled;
}

export async function listNormalizedNotifications(client, workspaceId, userId, limit = 100) {
  const bounded = Math.max(1,Math.min(100,Number.parseInt(limit,10)||100));
  const result = await client.query(`SELECT id,workspace_id,user_id,actor_id,notification_type,title,message,entity_id,created_at,read_at
    FROM workspace_notifications WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3`, [workspaceId,userId,bounded]);
  const count = await client.query('SELECT COUNT(*)::int AS unread_count FROM workspace_notifications WHERE workspace_id=$1 AND user_id=$2 AND read_at IS NULL', [workspaceId,userId]);
  return { notifications:result.rows.map((r)=>({id:r.id,workspaceId:r.workspace_id,userId:r.user_id,actorId:r.actor_id,type:r.notification_type,title:r.title,message:r.message,entityId:r.entity_id,createdAt:isoValue(r.created_at),readAt:isoValue(r.read_at)})), unreadCount:Number(count.rows[0]?.unread_count||0) };
}

export async function markNormalizedNotificationRead(client, workspaceId, userId, notificationId = null) {
  const result = notificationId === null
    ? await client.query('UPDATE workspace_notifications SET read_at=COALESCE(read_at,now()) WHERE workspace_id=$1 AND user_id=$2 AND read_at IS NULL', [workspaceId,userId])
    : await client.query('UPDATE workspace_notifications SET read_at=COALESCE(read_at,now()) WHERE workspace_id=$1 AND user_id=$2 AND id=$3 RETURNING id', [workspaceId,userId,notificationId]);
  return notificationId === null ? result.rowCount : Boolean(result.rowCount);
}

export async function upsertNormalizedPresence(client, workspaceId, userId, now = new Date()) {
  await client.query('INSERT INTO workspace_presence(workspace_id,user_id,last_seen_at) VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at', [workspaceId,userId,now]);
}

export async function listNormalizedPresence(client, workspaceId, now = new Date()) {
  const result = await client.query(`SELECT p.last_seen_at,u.id,u.email,u.name,u.created_at FROM workspace_presence p JOIN users u ON u.id=p.user_id
    WHERE p.workspace_id=$1 AND p.last_seen_at>$2 ORDER BY p.last_seen_at DESC`, [workspaceId,new Date(now.getTime()-60_000)]);
  return result.rows.map((r)=>({user:{id:r.id,email:r.email,name:r.name,createdAt:isoValue(r.created_at)},lastSeenAt:isoValue(r.last_seen_at)}));
}

export async function listNormalizedAttachments(client, workspaceId, ticketId) {
  const result = await client.query('SELECT id,workspace_id,ticket_id,uploaded_by,name,mime_type,size_bytes,storage_name,created_at FROM ticket_attachments WHERE workspace_id=$1 AND ticket_id=$2 ORDER BY created_at ASC,id ASC', [workspaceId,ticketId]);
  return result.rows.map((r)=>({id:r.id,workspaceId:r.workspace_id,ticketId:r.ticket_id,uploadedBy:r.uploaded_by,name:r.name,mimeType:r.mime_type,size:Number(r.size_bytes),storageName:r.storage_name,createdAt:isoValue(r.created_at)}));
}

export async function createNormalizedAttachment(client, { attachment, auditId }) {
  await client.query('INSERT INTO ticket_attachments(id,workspace_id,ticket_id,uploaded_by,name,mime_type,size_bytes,storage_name,created_at,content_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [attachment.id,attachment.workspaceId,attachment.ticketId,attachment.uploadedBy,attachment.name,attachment.mimeType,attachment.size,attachment.storageName,iso(attachment.createdAt),attachment.contentSha256 || null]);
  await insertNormalizedAudit(client,{id:auditId,workspaceId:attachment.workspaceId,actorId:attachment.uploadedBy,action:'attachment.uploaded',entityType:'attachment',entityId:attachment.id,metadata:{ticketId:attachment.ticketId,name:attachment.name}});
}

export async function deleteNormalizedAttachment(client, { workspaceId, ticketId, attachmentId, auditId, actorId }) {
  const result = await client.query('DELETE FROM ticket_attachments WHERE workspace_id=$1 AND ticket_id=$2 AND id=$3 RETURNING storage_name,name', [workspaceId,ticketId,attachmentId]);
  if (!result.rows[0]) return null;
  await insertNormalizedAudit(client,{id:auditId,workspaceId,actorId,action:'attachment.deleted',entityType:'attachment',entityId:attachmentId,metadata:{ticketId,name:result.rows[0].name}});
  return result.rows[0];
}

/** Creates workspace-wide notifications for every other current member. */
export async function notifyNormalizedWorkspace(client, { workspaceId, actorId, type, title, message = '', entityId = null, createdAt = new Date().toISOString() }) {
  const members = await client.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id<>$2', [workspaceId,actorId]);
  for (const member of members.rows) {
    if (!(await notificationPreferenceAllows(client, workspaceId, member.user_id, type))) continue;
    await client.query('INSERT INTO workspace_notifications(id,workspace_id,user_id,actor_id,notification_type,title,message,entity_id,created_at,read_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)', [randomUUID(),workspaceId,member.user_id,actorId,type,String(title).slice(0,160),String(message).slice(0,500),entityId,iso(createdAt)]);
  }
  return members.rowCount;
}

/** Build a portable workspace snapshot without credentials or storage internals. */
export async function exportNormalizedWorkspace(client, workspaceId) {
  const workspaceResult = await client.query(
    'SELECT id,name,description,created_at FROM workspaces WHERE id=$1', [workspaceId],
  );
  const workspace = workspaceResult.rows[0];
  if (!workspace) return null;
  const [members, tickets, comments, notifications, audit, importBatches, attachments] = await Promise.all([
    client.query(`SELECT u.id,u.email,u.name,m.role,m.joined_at FROM workspace_memberships m
      JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.joined_at,u.name`, [workspaceId]),
    client.query(`SELECT id,workspace_id,title,description,status,priority,created_by,created_at,updated_at,extra
      FROM tickets WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId]),
    client.query(`SELECT id,workspace_id,ticket_id,author_id,body,mentions,created_at FROM ticket_comments
      WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId]),
    client.query(`SELECT id,workspace_id,user_id,actor_id,notification_type,title,message,entity_id,created_at,read_at
      FROM workspace_notifications WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId]),
    client.query(`SELECT id,workspace_id,actor_id,action,entity_type,entity_id,metadata,created_at
      FROM workspace_audit_logs WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId]),
    client.query(`SELECT id,workspace_id,batch_key,imported_count,imported_by,created_at FROM ticket_import_batches
      WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId]),
    client.query(`SELECT id,workspace_id,ticket_id,uploaded_by,name,mime_type,size_bytes,created_at
      FROM ticket_attachments WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId]),
  ]);
  const toIso = (value) => value instanceof Date ? value.toISOString() : value;
  const mapDates = (rows, fields) => rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, fields.includes(key) ? toIso(value) : value])));
  return {
    format: 'ashkanboard-workspace-export', version: 1, exportedAt: new Date().toISOString(),
    workspace: { id: workspace.id, name: workspace.name, description: workspace.description, createdAt: toIso(workspace.created_at) },
    members: mapDates(members.rows, ['joined_at']),
    tickets: tickets.rows.map((row) => ({ ...row.extra, id: row.id, workspaceId: row.workspace_id, title: row.title, description: row.description, status: row.status, priority: row.priority, createdBy: row.created_by, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at) })),
    comments: mapDates(comments.rows, ['created_at']),
    notifications: mapDates(notifications.rows, ['created_at', 'read_at']),
    auditEvents: mapDates(audit.rows, ['created_at']),
    importBatches: mapDates(importBatches.rows, ['created_at']),
    attachments: attachments.rows.map(({ size_bytes, storage_name: _storageName, ...row }) => ({ id: row.id, workspaceId: row.workspace_id, ticketId: row.ticket_id, uploadedBy: row.uploaded_by, name: row.name, mimeType: row.mime_type, sizeBytes: Number(size_bytes), createdAt: toIso(row.created_at) })),
    exclusions: ['password hashes', 'refresh tokens', 'password reset tokens', 'invitation token hashes', 'attachment storage names and file bytes', 'online presence'],
  };
}



export async function listNormalizedRoleMappings(client, workspaceId) {
  const result = await client.query(`SELECT id,workspace_id,source,claim,match_value,role_key,priority,enabled,created_at FROM workspace_role_mappings WHERE workspace_id=$1 ORDER BY priority ASC, created_at ASC`, [workspaceId]);
  return result.rows;
}
export async function createNormalizedRoleMapping(client, { workspaceId, source, claim, matchValue, roleKey, priority=100, enabled=true }) {
  const result = await client.query(`INSERT INTO workspace_role_mappings(id,workspace_id,source,claim,match_value,role_key,priority,enabled) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7) RETURNING id,workspace_id,source,claim,match_value,role_key,priority,enabled,created_at`, [workspaceId,source,claim,matchValue,roleKey,priority,enabled]);
  return result.rows[0];
}
export async function updateNormalizedRoleMapping(client, id, { source, claim, matchValue, roleKey, priority, enabled }) {
  const result = await client.query(`UPDATE workspace_role_mappings SET source=COALESCE($2,source),claim=COALESCE($3,claim),match_value=COALESCE($4,match_value),role_key=COALESCE($5,role_key),priority=COALESCE($6,priority),enabled=COALESCE($7,enabled) WHERE id=$1 RETURNING id,workspace_id,source,claim,match_value,role_key,priority,enabled,created_at`, [id,source ?? null,claim ?? null,matchValue ?? null,roleKey ?? null,priority ?? null,enabled ?? null]);
  return result.rows[0] || null;
}
export async function deleteNormalizedRoleMapping(client, id) {
  const result = await client.query('DELETE FROM workspace_role_mappings WHERE id=$1 RETURNING id', [id]);
  return Boolean(result.rowCount);
}
export async function applyNormalizedRoleMappings(client, { workspaceId, userId, source, claims }) {
  const mappings = await listNormalizedRoleMappings(client, workspaceId);
  for (const mapping of mappings.filter((item) => item.enabled && item.source === source)) {
    const raw = claims?.[mapping.claim];
    const values = Array.isArray(raw) ? raw.map(String) : [raw == null ? '' : String(raw)];
    if (!values.some((value) => value === mapping.match_value)) continue;
    const role = await client.query('SELECT role_key FROM workspace_roles WHERE workspace_id=$1 AND role_key=$2', [workspaceId, mapping.role_key]);
    if (!role.rowCount) continue;
    await client.query('UPDATE workspace_memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2 AND role <> $3', [workspaceId,userId,mapping.role_key]);
    return mapping.role_key;
  }
  return null;
}

export async function getNormalizedSecuritySettings(client, userId) {
  const result = await client.query('SELECT totp_secret_enc AS "totpSecretEnc", totp_enabled AS "totpEnabled" FROM users WHERE id=$1', [userId]);
  return result.rows[0] || null;
}
export async function setNormalizedTotpSecret(client, userId, encryptedSecret) {
  const result = await client.query('UPDATE users SET totp_secret_enc=$2, totp_enabled=false WHERE id=$1 RETURNING id', [userId, encryptedSecret]);
  return Boolean(result.rowCount);
}
export async function enableNormalizedTotp(client, userId) {
  const result = await client.query('UPDATE users SET totp_enabled=true WHERE id=$1 AND totp_secret_enc IS NOT NULL RETURNING id', [userId]);
  return Boolean(result.rowCount);
}
export async function disableNormalizedTotp(client, userId) {
  const result = await client.query('UPDATE users SET totp_enabled=false, totp_secret_enc=NULL WHERE id=$1 RETURNING id', [userId]);
  return Boolean(result.rowCount);
}
export async function insertNormalizedSecurityEvent(client, { id, userId = null, eventType, ipAddress = null, userAgent = null, metadata = {}, createdAt = new Date().toISOString() }) {
  await client.query('INSERT INTO security_events(id,user_id,event_type,ip_address,user_agent,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [id,userId,eventType,ipAddress,userAgent,metadata,createdAt]);
}
export async function listNormalizedSecurityEvents(client, userId, limit = 100) {
  const result = await client.query('SELECT id, event_type AS "eventType", ip_address AS "ipAddress", user_agent AS "userAgent", metadata, created_at AS "createdAt" FROM security_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2',[userId,limit]);
  return result.rows;
}
export async function listNormalizedUserSessions(client, userId) {
  const result = await client.query(`
    SELECT family_id AS "familyId",
           MIN(created_at) AS "createdAt",
           MAX(expires_at) AS "expiresAt",
           BOOL_AND(revoked_at IS NOT NULL) AS "revoked",
           MAX(revoked_at) AS "revokedAt",
           COUNT(*)::int AS "tokenCount"
    FROM auth_refresh_tokens
    WHERE user_id=$1
    GROUP BY family_id
    ORDER BY MIN(created_at) DESC
    LIMIT 50`, [userId]);
  return result.rows;
}

export async function findOidcIdentity(client, issuer, subject) {
  const result = await client.query(`SELECT o.user_id, o.issuer, o.subject, u.id,u.email,u.name,u.created_at FROM oidc_identities o JOIN users u ON u.id=o.user_id WHERE o.issuer=$1 AND o.subject=$2`, [issuer, subject]);
  const row = result.rows[0];
  return row ? { userId: row.user_id, issuer: row.issuer, subject: row.subject, user: { id: row.id, email: row.email, name: row.name, createdAt: row.created_at } } : null;
}
export async function linkOidcIdentity(client, { id, userId, issuer, subject, email, now = new Date() }) {
  await client.query(`INSERT INTO oidc_identities(id,user_id,issuer,subject,email_at_link,created_at,last_login_at) VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (issuer,subject) DO UPDATE SET user_id=EXCLUDED.user_id,email_at_link=EXCLUDED.email_at_link,last_login_at=EXCLUDED.last_login_at`, [id, userId, issuer, subject, email, now]);
  return findOidcIdentity(client, issuer, subject);
}
export async function touchOidcIdentity(client, issuer, subject, now = new Date()) {
  await client.query('UPDATE oidc_identities SET last_login_at=$3 WHERE issuer=$1 AND subject=$2', [issuer, subject, now]);
}

export async function listNormalizedWebhooks(client, workspaceId) {
  const result = await client.query(`SELECT id,workspace_id AS "workspaceId",name,endpoint_url AS "endpointUrl",events,enabled,max_attempts AS "maxAttempts",retry_delay_seconds AS "retryDelaySeconds",last_status AS "lastStatus",last_delivered_at AS "lastDeliveredAt",failure_count AS "failureCount",circuit_breaker_enabled AS "circuitBreakerEnabled",failure_threshold AS "failureThreshold",circuit_opened_at AS "circuitOpenedAt",disabled_reason AS "disabledReason",circuit_recovery_seconds AS "circuitRecoverySeconds",circuit_recovery_count AS "circuitRecoveryCount",delivery_retention_days AS "deliveryRetentionDays",created_by AS "createdBy",created_at AS "createdAt",updated_at AS "updatedAt" FROM workspace_webhooks WHERE workspace_id=$1 ORDER BY created_at DESC`, [workspaceId]);
  return result.rows;
}
export async function createNormalizedWebhook(client, { workspaceId, name, endpointUrl, secretHash, secretEnc, events, createdBy }) {
  const result = await client.query(`INSERT INTO workspace_webhooks(id,workspace_id,name,endpoint_url,secret_hash,secret_enc,events,enabled,created_by) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5::jsonb,true,$6) RETURNING id,workspace_id AS "workspaceId",name,endpoint_url AS "endpointUrl",events,enabled,last_status AS "lastStatus",last_delivered_at AS "lastDeliveredAt",failure_count AS "failureCount",created_by AS "createdBy",created_at AS "createdAt",updated_at AS "updatedAt"`, [workspaceId,name,endpointUrl,secretHash,secretEnc,JSON.stringify(events),createdBy]);
  return result.rows[0];
}
export async function updateNormalizedWebhook(client, id, { name, endpointUrl, events, enabled }) {
  const result = await client.query(`UPDATE workspace_webhooks SET name=COALESCE($2,name),endpoint_url=COALESCE($3,endpoint_url),events=COALESCE($4::jsonb,events),enabled=COALESCE($5,enabled),updated_at=now() WHERE id=$1 RETURNING id,workspace_id AS "workspaceId",name,endpoint_url AS "endpointUrl",events,enabled,last_status AS "lastStatus",last_delivered_at AS "lastDeliveredAt",failure_count AS "failureCount",created_by AS "createdBy",created_at AS "createdAt",updated_at AS "updatedAt"`, [id,name ?? null,endpointUrl ?? null,events ? JSON.stringify(events) : null,enabled ?? null]);
  return result.rows[0] || null;
}
export async function updateNormalizedWebhookCircuitPolicy(client, id, { circuitBreakerEnabled, failureThreshold, circuitRecoverySeconds }) {
  const result = await client.query(`UPDATE workspace_webhooks SET circuit_breaker_enabled=COALESCE($2,circuit_breaker_enabled),failure_threshold=COALESCE($3,failure_threshold),circuit_recovery_seconds=COALESCE($4,circuit_recovery_seconds),updated_at=now() WHERE id=$1 RETURNING id,circuit_breaker_enabled AS \"circuitBreakerEnabled\",failure_threshold AS \"failureThreshold\",circuit_recovery_seconds AS \"circuitRecoverySeconds\",circuit_opened_at AS \"circuitOpenedAt\",disabled_reason AS \"disabledReason\",circuit_recovery_count AS \"circuitRecoveryCount\"`, [id, circuitBreakerEnabled ?? null, failureThreshold ?? null, circuitRecoverySeconds ?? null]);
  return result.rows[0] || null;
}

export async function recoverDueNormalizedWebhookCircuits(client, { limit = 25 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const result = await client.query(`
    WITH candidates AS (
      SELECT id
      FROM workspace_webhooks
      WHERE circuit_breaker_enabled=true
        AND enabled=false
        AND disabled_reason='circuit-breaker'
        AND circuit_opened_at IS NOT NULL
        AND circuit_opened_at <= now() - make_interval(secs => GREATEST(circuit_recovery_seconds, 30))
      ORDER BY circuit_opened_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE workspace_webhooks w
    SET enabled=true,failure_count=0,circuit_opened_at=NULL,disabled_reason=NULL,circuit_recovery_count=circuit_recovery_count+1,updated_at=now()
    FROM candidates c
    WHERE w.id=c.id
    RETURNING w.id,w.workspace_id AS "workspaceId",w.circuit_recovery_count AS "circuitRecoveryCount"`, [safeLimit]);
  return result.rows;
}

export async function recoverNormalizedWebhookCircuit(client, id) {
  const result = await client.query(`UPDATE workspace_webhooks SET enabled=true,failure_count=0,circuit_opened_at=NULL,disabled_reason=NULL,circuit_recovery_count=circuit_recovery_count+1,updated_at=now() WHERE id=$1 AND disabled_reason='circuit-breaker' RETURNING id,enabled,failure_count AS \"failureCount\",circuit_opened_at AS \"circuitOpenedAt\",disabled_reason AS \"disabledReason\",circuit_recovery_count AS \"circuitRecoveryCount\"`, [id]);
  return result.rows[0] || null;
}

export async function updateNormalizedWebhookRetentionPolicy(client, id, { deliveryRetentionDays }) {
  const result = await client.query(`UPDATE workspace_webhooks SET delivery_retention_days=COALESCE($2,delivery_retention_days),updated_at=now() WHERE id=$1 RETURNING id,delivery_retention_days AS "deliveryRetentionDays"`, [id, deliveryRetentionDays ?? null]);
  return result.rows[0] || null;
}

export async function purgeExpiredNormalizedWebhookDeliveries(client, { limit = 500, webhookId = null } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 5000);
  const result = await client.query(`WITH candidates AS (
    SELECT d.id FROM workspace_webhook_deliveries d
    JOIN workspace_webhooks w ON w.id=d.webhook_id
    WHERE d.created_at < now() - make_interval(days => GREATEST(w.delivery_retention_days, 1))
      AND ($2::uuid IS NULL OR d.webhook_id=$2::uuid)
    ORDER BY d.created_at ASC LIMIT $1 FOR UPDATE OF d SKIP LOCKED
  ) DELETE FROM workspace_webhook_deliveries d USING candidates c WHERE d.id=c.id RETURNING d.id,d.webhook_id AS "webhookId"`, [safeLimit, webhookId || null]);
  return result.rows;
}

export async function getNormalizedWebhookRetentionPreview(client, webhookId) {
  const result = await client.query(`SELECT w.delivery_retention_days AS "deliveryRetentionDays", COUNT(d.id)::int AS "expiredCount", MIN(d.created_at) AS "oldestExpiredAt", MAX(d.created_at) AS "newestExpiredAt" FROM workspace_webhooks w LEFT JOIN workspace_webhook_deliveries d ON d.webhook_id=w.id AND d.created_at < now() - make_interval(days => GREATEST(w.delivery_retention_days, 1)) WHERE w.id=$1 GROUP BY w.id,w.delivery_retention_days`, [webhookId]);
  return result.rows[0] || null;
}

export async function getNormalizedWebhookRetentionPolicyImpact(client, webhookId, nextRetentionDays) {
  const safeDays = Number(nextRetentionDays);
  if (!Number.isInteger(safeDays) || safeDays < 1 || safeDays > 3650) return null;
  const result = await client.query(`SELECT w.delivery_retention_days AS "currentRetentionDays", $2::int AS "nextRetentionDays", COUNT(d.id) FILTER (WHERE d.created_at < now() - make_interval(days => GREATEST(w.delivery_retention_days, 1)))::int AS "currentExpiredCount", COUNT(d.id) FILTER (WHERE d.created_at < now() - make_interval(days => $2::int))::int AS "nextExpiredCount", COUNT(d.id) FILTER (WHERE d.created_at >= now() - make_interval(days => GREATEST(w.delivery_retention_days, 1)) AND d.created_at < now() - make_interval(days => $2::int))::int AS "newlyExpiredCount" FROM workspace_webhooks w LEFT JOIN workspace_webhook_deliveries d ON d.webhook_id=w.id WHERE w.id=$1 GROUP BY w.id,w.delivery_retention_days`, [webhookId, safeDays]);
  return result.rows[0] || null;
}

export async function getNormalizedWebhookRetentionStats(client, webhookId) {
  const result = await client.query(`SELECT w.delivery_retention_days AS "deliveryRetentionDays", COUNT(d.id)::int AS "deliveryCount", MIN(d.created_at) AS "oldestDeliveryAt", MIN(d.created_at) + make_interval(days => GREATEST(w.delivery_retention_days,1)) AS "nextExpiryAt" FROM workspace_webhooks w LEFT JOIN workspace_webhook_deliveries d ON d.webhook_id=w.id WHERE w.id=$1 GROUP BY w.id,w.delivery_retention_days`, [webhookId]);
  return result.rows[0] || null;
}

export async function updateNormalizedWebhookRetryPolicy(client, id, { maxAttempts, retryDelaySeconds }) {
  const result = await client.query(`UPDATE workspace_webhooks SET max_attempts=COALESCE($2,max_attempts),retry_delay_seconds=COALESCE($3,retry_delay_seconds),updated_at=now() WHERE id=$1 RETURNING id,max_attempts AS "maxAttempts",retry_delay_seconds AS "retryDelaySeconds"`, [id, maxAttempts ?? null, retryDelaySeconds ?? null]);
  return result.rows[0] || null;
}

export async function deleteNormalizedWebhook(client, id) {
  const result = await client.query('DELETE FROM workspace_webhooks WHERE id=$1 RETURNING id',[id]);
  return Boolean(result.rowCount);
}
export async function getNormalizedWebhookSecret(client, id) {
  const result = await client.query('SELECT secret_enc AS \"secretEnc\", secret_version AS \"secretVersion\" FROM workspace_webhooks WHERE id=$1',[id]);
  return result.rows[0] || null;
}
export async function rotateNormalizedWebhookSecret(client, id, { secretHash, secretEnc }) {
  const result = await client.query('UPDATE workspace_webhooks SET secret_hash=$2, secret_enc=$3::jsonb, secret_version=secret_version+1, secret_rotated_at=now(), updated_at=now() WHERE id=$1 RETURNING id,secret_version AS \"secretVersion\",secret_rotated_at AS \"secretRotatedAt\"',[id,secretHash,secretEnc]);
  return result.rows[0] || null;
}
export async function recordNormalizedWebhookDelivery(client, id, { status, delivered }) {
  await client.query(`UPDATE workspace_webhooks SET last_status=$2,last_delivered_at=CASE WHEN $3 THEN now() ELSE last_delivered_at END,failure_count=CASE WHEN $3 THEN 0 ELSE failure_count+1 END,enabled=CASE WHEN $3 THEN enabled WHEN circuit_breaker_enabled AND failure_count+1 >= failure_threshold THEN false ELSE enabled END,circuit_opened_at=CASE WHEN $3 THEN NULL WHEN circuit_breaker_enabled AND failure_count+1 >= failure_threshold THEN now() ELSE circuit_opened_at END,disabled_reason=CASE WHEN $3 THEN NULL WHEN circuit_breaker_enabled AND failure_count+1 >= failure_threshold THEN 'circuit-breaker' ELSE disabled_reason END,updated_at=now() WHERE id=$1`,[id,status ?? null,delivered]);
}

export async function recordNormalizedWebhookDeliveryAttempt(client, { id = randomUUID(), webhookId, eventType, status = null, delivered = false, attempt = 1, errorMessage = null, payload = null, deadLettered = false, nextRetryAt = null }) {
  await client.query(`INSERT INTO workspace_webhook_deliveries(id,webhook_id,event_type,status,delivered,attempt,error_message,payload,dead_lettered,next_retry_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`, [id, webhookId, eventType, status, delivered, attempt, errorMessage ? String(errorMessage).slice(0, 500) : null, payload ? JSON.stringify(payload) : null, deadLettered, nextRetryAt]);
}

export async function claimNormalizedWebhookRetries(client, { batchSize = 10, staleAfterSeconds = 300 } = {}) {
  const safeBatch = Math.min(Math.max(Number(batchSize) || 10, 1), 50);
  const stale = Math.min(Math.max(Number(staleAfterSeconds) || 300, 30), 3600);
  const result = await client.query(`
    WITH candidates AS (
      SELECT d.id
      FROM workspace_webhook_deliveries d
      JOIN workspace_webhooks w ON w.id=d.webhook_id
      WHERE d.delivered=false
        AND d.dead_lettered=false
        AND d.next_retry_at IS NOT NULL
        AND d.next_retry_at <= now()
        AND w.enabled=true
        AND (d.retry_locked_at IS NULL OR d.retry_locked_at < now() - make_interval(secs => $2))
      ORDER BY d.next_retry_at ASC, d.created_at ASC
      LIMIT $1
      FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE workspace_webhook_deliveries d
    SET retry_locked_at=now()
    FROM candidates c
    WHERE d.id=c.id
    RETURNING d.id,d.webhook_id AS "webhookId",d.event_type AS "eventType",d.attempt,d.payload,d.next_retry_at AS "nextRetryAt"`, [safeBatch, stale]);
  return result.rows;
}

export async function clearNormalizedWebhookRetryLock(client, deliveryId) {
  await client.query('UPDATE workspace_webhook_deliveries SET retry_locked_at=NULL WHERE id=$1', [deliveryId]);
}

export async function getNormalizedWebhookDelivery(client, webhookId, deliveryId) {
  const result = await client.query(`SELECT id,webhook_id AS "webhookId",event_type AS "eventType",status,delivered,attempt,error_message AS "errorMessage",payload,dead_lettered AS "deadLettered",next_retry_at AS "nextRetryAt",created_at AS "createdAt" FROM workspace_webhook_deliveries WHERE id=$1 AND webhook_id=$2`, [deliveryId, webhookId]);
  return result.rows[0] || null;
}

export async function getNormalizedWebhookDeliverySummary(client, webhookId) {
  const result = await client.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE delivered)::int AS delivered, COUNT(*) FILTER (WHERE NOT delivered)::int AS failed, COUNT(*) FILTER (WHERE status >= 200 AND status < 300)::int AS successful_status, COUNT(*) FILTER (WHERE status >= 400)::int AS error_status, MAX(created_at) AS "lastAttemptAt" FROM workspace_webhook_deliveries WHERE webhook_id=$1`, [webhookId]);
  const row = result.rows[0] || {};
  const total = Number(row.total || 0);
  return { total, delivered: Number(row.delivered || 0), failed: Number(row.failed || 0), successfulStatus: Number(row.successful_status || 0), errorStatus: Number(row.error_status || 0), lastAttemptAt: row.lastAttemptAt || null, successRate: total ? Math.round((Number(row.delivered || 0) / total) * 10000) / 100 : 0 };
}

export async function listNormalizedWebhookDeadLetters(client, webhookId, limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const result = await client.query(`SELECT id,webhook_id AS "webhookId",event_type AS "eventType",status,delivered,attempt,error_message AS "errorMessage",payload,dead_lettered AS "deadLettered",next_retry_at AS "nextRetryAt",created_at AS "createdAt" FROM workspace_webhook_deliveries WHERE webhook_id=$1 AND dead_lettered=true ORDER BY created_at DESC LIMIT $2`, [webhookId, safeLimit]);
  return result.rows;
}

export async function requeueNormalizedWebhookDeadLetter(client, webhookId, deliveryId) {
  const result = await client.query(`UPDATE workspace_webhook_deliveries SET dead_lettered=false,next_retry_at=now(),retry_locked_at=NULL WHERE id=$1 AND webhook_id=$2 AND dead_lettered=true RETURNING id,webhook_id AS "webhookId",event_type AS "eventType",attempt,dead_lettered AS "deadLettered",next_retry_at AS "nextRetryAt"`, [deliveryId, webhookId]);
  return result.rows[0] || null;
}

export async function discardNormalizedWebhookDeadLetter(client, webhookId, deliveryId) {
  const result = await client.query('DELETE FROM workspace_webhook_deliveries WHERE id=$1 AND webhook_id=$2 AND dead_lettered=true RETURNING id', [deliveryId, webhookId]);
  return result.rows[0] || null;
}

export async function discardNormalizedWebhookDeadLetters(client, webhookId, limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const result = await client.query(`WITH candidates AS (SELECT id FROM workspace_webhook_deliveries WHERE webhook_id=$1 AND dead_lettered=true ORDER BY created_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED) DELETE FROM workspace_webhook_deliveries d USING candidates c WHERE d.id=c.id RETURNING d.id`, [webhookId, safeLimit]);
  return result.rows;
}

export async function requeueNormalizedWebhookDeadLetters(client, webhookId, limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const result = await client.query(`WITH candidates AS (SELECT id FROM workspace_webhook_deliveries WHERE webhook_id=$1 AND dead_lettered=true ORDER BY created_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED) UPDATE workspace_webhook_deliveries d SET dead_lettered=false,next_retry_at=now(),retry_locked_at=NULL FROM candidates c WHERE d.id=c.id RETURNING d.id,d.webhook_id AS "webhookId",d.event_type AS "eventType",d.attempt,d.dead_lettered AS "deadLettered",d.next_retry_at AS "nextRetryAt"`, [webhookId, safeLimit]);
  return result.rows;
}

export async function searchNormalizedWebhookDeliveries(client, webhookId, { status = null, delivered = null, deadLettered = null, eventType = null, from = null, to = null, limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const params = [webhookId];
  const conditions = ['d.webhook_id=$1'];
  const add = (value, sql) => { params.push(value); conditions.push(sql.replace('?', `$${params.length}`)); };
  if (status) add(String(status).slice(0, 40), 'd.status=?');
  if (delivered !== null && delivered !== undefined) add(Boolean(delivered), 'd.delivered=?');
  if (deadLettered !== null && deadLettered !== undefined) add(Boolean(deadLettered), 'd.dead_lettered=?');
  if (eventType) add(String(eventType).slice(0, 120), 'd.event_type=?');
  if (from) add(from, 'd.created_at>=?::timestamptz');
  if (to) add(to, 'd.created_at<=?::timestamptz');
  const countResult = await client.query(`SELECT COUNT(*)::int AS count FROM workspace_webhook_deliveries d WHERE ${conditions.join(' AND ')}`, params);
  params.push(safeLimit, safeOffset);
  const result = await client.query(`SELECT d.id,d.webhook_id AS "webhookId",d.event_type AS "eventType",d.status,d.delivered,d.attempt,d.error_message AS "errorMessage",d.payload,d.dead_lettered AS "deadLettered",d.next_retry_at AS "nextRetryAt",d.created_at AS "createdAt" FROM workspace_webhook_deliveries d WHERE ${conditions.join(' AND ')} ORDER BY d.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params);
  return { deliveries: result.rows, total: countResult.rows[0]?.count || 0, limit: safeLimit, offset: safeOffset };
}

export async function listNormalizedWebhookDeliveries(client, webhookId, limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const result = await client.query(`SELECT id,webhook_id AS "webhookId",event_type AS "eventType",status,delivered,attempt,error_message AS "errorMessage",payload,dead_lettered AS "deadLettered",next_retry_at AS "nextRetryAt",created_at AS "createdAt" FROM workspace_webhook_deliveries WHERE webhook_id=$1 ORDER BY created_at DESC LIMIT $2`, [webhookId, safeLimit]);
  return result.rows;
}
