import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);

test('advanced RBAC migration creates workspace roles and removes the fixed role constraint', async () => {
  const source = await readFile(new URL('./migrations/019_advanced_rbac.sql', root), 'utf8');
  assert.match(source, /CREATE TABLE workspace_roles/);
  assert.match(source, /DROP CONSTRAINT IF EXISTS workspace_memberships_role_check/);
  assert.match(source, /ON CONFLICT \(workspace_id, role_key\) DO NOTHING/);
});

test('normalized membership exposes role permissions and repository supports custom roles', async () => {
  const source = await readFile(new URL('./normalized-repository.mjs', root), 'utf8');
  assert.match(source, /COALESCE\(r\.permissions,'\[\]'::jsonb\) AS permissions/);
  assert.match(source, /export async function listNormalizedRoles/);
  assert.match(source, /export async function createNormalizedRole/);
  assert.match(source, /export async function updateNormalizedRole/);
  assert.match(source, /export async function deleteNormalizedRole/);
});

test('API exposes protected workspace role management endpoints', async () => {
  const source = await readFile(new URL('./app.mjs', root), 'utf8');
  assert.ok(source.includes("const rolesRoute = path.match"));
  assert.match(source, /Advanced RBAC requires normalized PostgreSQL persistence/);
});
