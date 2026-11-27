import { randomUUID } from 'node:crypto';

export function scimAuthConfigured() {
  return Boolean(process.env.SCIM_BEARER_TOKEN && process.env.SCIM_BEARER_TOKEN.length >= 32);
}

export function scimTokenValid(value) {
  const expected = String(process.env.SCIM_BEARER_TOKEN || '');
  const supplied = String(value || '');
  return Boolean(expected && supplied && supplied === expected);
}

function userResource(row, baseUrl) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: row.externalId,
    externalId: row.externalId,
    userName: row.email,
    active: row.active,
    displayName: row.name,
    name: { formatted: row.name },
    emails: [{ value: row.email, type: 'work', primary: true }],
    meta: { resourceType: 'User', version: `W/\"${row.version}\"`, lastModified: new Date(row.updatedAt).toISOString(), location: `${baseUrl}/Users/${row.externalId}` },
  };
}

function groupResource(row, baseUrl) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: row.externalId,
    externalId: row.externalId,
    displayName: row.displayName,
    members: row.members.map((member) => ({ value: member.externalId, display: member.displayName })),
    meta: { resourceType: 'Group', version: `W/\"${row.version}\"`, lastModified: new Date(row.updatedAt).toISOString(), location: `${baseUrl}/Groups/${row.externalId}` },
  };
}

export async function scimListUsers(client, { filter, startIndex = 1, count = 100, baseUrl }) {
  const params = []; let where = '';
  if (filter) {
    const match = String(filter).match(/^userName\s+eq\s+\"([^\"]+)\"$/i);
    if (match) { params.push(match[1].toLowerCase()); where = `WHERE LOWER(u.email)=$${params.length}`; }
  }
  const total = await client.query(`SELECT COUNT(*)::int AS count FROM scim_users s JOIN users u ON u.id=s.user_id ${where}`, params);
  params.push(Math.max(0, Number(count) || 100)); params.push(Math.max(0, Number(startIndex) - 1));
  const rows = await client.query(`SELECT s.external_id AS "externalId", s.active, s.version, s.updated_at AS "updatedAt", u.email, u.name FROM scim_users s JOIN users u ON u.id=s.user_id ${where} ORDER BY u.email LIMIT $${params.length-1} OFFSET $${params.length}`, params);
  return { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: total.rows[0].count, startIndex: Number(startIndex), itemsPerPage: rows.rowCount, Resources: rows.rows.map((row) => userResource(row, baseUrl)) };
}

export async function scimGetUser(client, externalId, baseUrl) {
  const result = await client.query(`SELECT s.external_id AS "externalId", s.active, s.version, s.updated_at AS "updatedAt", u.email, u.name FROM scim_users s JOIN users u ON u.id=s.user_id WHERE s.external_id=$1`, [externalId]);
  return result.rows[0] ? userResource(result.rows[0], baseUrl) : null;
}

export async function scimCreateUser(client, { externalId, email, name, active = true, passwordHash, baseUrl }) {
  const existing = await client.query(`SELECT s.external_id AS "externalId", s.active, s.version, s.updated_at AS "updatedAt", u.email, u.name FROM scim_users s JOIN users u ON u.id=s.user_id WHERE s.external_id=$1`, [externalId]);
  if (existing.rowCount) return { resource: userResource(existing.rows[0], baseUrl), created: false };
  const byEmail = await client.query('SELECT id,email,name FROM users WHERE LOWER(email)=LOWER($1)', [email]);
  let user = byEmail.rows[0];
  if (!user) { user = { id: randomUUID(), email: email.toLowerCase(), name }; await client.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [user.id,user.email,user.name,passwordHash]); }
  const inserted = await client.query(`INSERT INTO scim_users(id,user_id,external_id,active) VALUES($1,$2,$3,$4) RETURNING external_id AS "externalId",active,version,updated_at AS "updatedAt"`, [randomUUID(),user.id,externalId,Boolean(active)]);
  const row = { ...inserted.rows[0], email: user.email, name: user.name };
  return { resource: userResource(row, baseUrl), created: true, userId: user.id };
}

export async function scimPatchUser(client, externalId, operations, baseUrl) {
  const found = await client.query('SELECT user_id FROM scim_users WHERE external_id=$1 FOR UPDATE', [externalId]);
  if (!found.rowCount) return null;
  let name; let active;
  for (const op of operations || []) for (const path of [op.path || '']) {
    const value = op.value;
    const normalized = String(path).toLowerCase();
    if (normalized === 'active' || (!path && typeof value === 'object' && value && 'active' in value)) active = path ? Boolean(value) : Boolean(value.active);
    if (normalized === 'displayname' || normalized === 'name.formatted' || (!path && typeof value === 'object' && value && value.displayName)) name = path ? String(value) : String(value.displayName);
  }
  if (name !== undefined) await client.query('UPDATE users SET name=$2 WHERE id=$1', [found.rows[0].user_id,name]);
  const updated = await client.query(`UPDATE scim_users SET active=COALESCE($2,active), version=version+1, updated_at=now() WHERE external_id=$1 RETURNING external_id AS "externalId",active,version,updated_at AS "updatedAt"`, [externalId, active]);
  const user = await client.query('SELECT email,name FROM users WHERE id=$1',[found.rows[0].user_id]);
  return userResource({...updated.rows[0],...user.rows[0]},baseUrl);
}

export async function scimDeleteUser(client, externalId) {
  const result = await client.query('DELETE FROM scim_users WHERE external_id=$1 RETURNING user_id', [externalId]);
  if (!result.rowCount) return false;
  await client.query('DELETE FROM workspace_memberships WHERE user_id=$1', [result.rows[0].user_id]);
  await client.query('UPDATE users SET name=name WHERE id=$1', [result.rows[0].user_id]);
  return true;
}

export async function scimListGroups(client, { startIndex = 1, count = 100, baseUrl }) {
  const total = await client.query('SELECT COUNT(*)::int AS count FROM scim_groups');
  const rows = await client.query(`SELECT g.external_id AS "externalId",g.display_name AS "displayName",g.version,g.updated_at AS "updatedAt", COALESCE(json_agg(json_build_object('externalId',su.external_id,'displayName',u.name)) FILTER (WHERE su.external_id IS NOT NULL),'[]') AS members FROM scim_groups g LEFT JOIN scim_group_memberships gm ON gm.group_id=g.id LEFT JOIN scim_users su ON su.user_id=gm.user_id LEFT JOIN users u ON u.id=gm.user_id GROUP BY g.id ORDER BY g.display_name LIMIT $1 OFFSET $2`, [Math.max(0,Number(count)||100),Math.max(0,Number(startIndex)-1)]);
  return { schemas:['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults:total.rows[0].count,startIndex:Number(startIndex),itemsPerPage:rows.rowCount,Resources:rows.rows.map((r)=>groupResource(r,baseUrl)) };
}

export async function scimGetGroup(client, externalId, baseUrl) {
  const rows = await client.query(`SELECT g.external_id AS "externalId",g.display_name AS "displayName",g.version,g.updated_at AS "updatedAt", COALESCE(json_agg(json_build_object('externalId',su.external_id,'displayName',u.name)) FILTER (WHERE su.external_id IS NOT NULL),'[]') AS members FROM scim_groups g LEFT JOIN scim_group_memberships gm ON gm.group_id=g.id LEFT JOIN scim_users su ON su.user_id=gm.user_id LEFT JOIN users u ON u.id=gm.user_id WHERE g.external_id=$1 GROUP BY g.id`,[externalId]);
  return rows.rows[0] ? groupResource(rows.rows[0],baseUrl) : null;
}

export async function scimCreateGroup(client,{externalId,displayName,members=[],baseUrl}) {
  const existing=await client.query('SELECT id FROM scim_groups WHERE external_id=$1',[externalId]);
  if(existing.rowCount) return scimGetGroup(client,externalId,baseUrl);
  const workspace=await client.query('SELECT id FROM workspaces WHERE id=$1',[displayName]);
  const workspaceId=workspace.rowCount?workspace.rows[0].id:randomUUID();
  if(!workspace.rowCount) await client.query('INSERT INTO workspaces(id,name) VALUES($1,$2)',[workspaceId,displayName]);
  const id=randomUUID(); await client.query('INSERT INTO scim_groups(id,workspace_id,external_id,display_name) VALUES($1,$2,$3,$4)',[id,workspaceId,externalId,displayName]);
  let firstUserId=null;
  for(const member of members){ const su=await client.query('SELECT user_id FROM scim_users WHERE external_id=$1',[member.value]); if(su.rowCount){ firstUserId ||= su.rows[0].user_id; await client.query('INSERT INTO scim_group_memberships(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,su.rows[0].user_id]); await client.query('INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT (workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role',[workspaceId,su.rows[0].user_id,firstUserId===su.rows[0].user_id?'owner':'member']); } }
  return scimGetGroup(client,externalId,baseUrl);
}

export async function scimPatchGroup(client, externalId, operations, baseUrl) {
  const found = await client.query('SELECT id FROM scim_groups WHERE external_id=$1 FOR UPDATE',[externalId]);
  if (!found.rowCount) return null;
  const groupId=found.rows[0].id;
  for (const op of operations || []) {
    const kind=String(op.op||'').toLowerCase();
    const path=String(op.path||'').toLowerCase();
    const values=Array.isArray(op.value) ? op.value : (op.value ? [op.value] : []);
    if (path === 'displayname') {
      const value=values[0];
      await client.query('UPDATE scim_groups SET display_name=$2,version=version+1,updated_at=now() WHERE id=$1',[groupId,String(value)]);
      continue;
    }
    if (path === 'members' || !path) {
      if (kind === 'replace') await client.query('DELETE FROM scim_group_memberships WHERE group_id=$1',[groupId]);
      for (const member of values) {
        const su=await client.query('SELECT user_id FROM scim_users WHERE external_id=$1',[member.value]);
        if (!su.rowCount) continue;
        if (kind === 'remove') await client.query('DELETE FROM scim_group_memberships WHERE group_id=$1 AND user_id=$2',[groupId,su.rows[0].user_id]);
        else await client.query('INSERT INTO scim_group_memberships(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[groupId,su.rows[0].user_id]);
      }
      await client.query('UPDATE scim_groups SET version=version+1,updated_at=now() WHERE id=$1',[groupId]);
    }
  }
  return scimGetGroup(client,externalId,baseUrl);
}

export async function scimDeleteGroup(client, externalId) {
  const result=await client.query('DELETE FROM scim_groups WHERE external_id=$1 RETURNING workspace_id',[externalId]);
  if(!result.rowCount) return false;
  await client.query('DELETE FROM workspace_memberships WHERE workspace_id=$1',[result.rows[0].workspace_id]);
  await client.query('DELETE FROM workspaces WHERE id=$1',[result.rows[0].workspace_id]);
  return true;
}
