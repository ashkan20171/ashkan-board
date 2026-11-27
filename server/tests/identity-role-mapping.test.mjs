import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('..', import.meta.url);
test('identity role mapping migration and runtime APIs are present', async () => {
  const migration = await readFile(new URL('./migrations/020_identity_role_mappings.sql', root), 'utf8');
  const repo = await readFile(new URL('./normalized-repository.mjs', root), 'utf8');
  const app = await readFile(new URL('./app.mjs', root), 'utf8');
  const oidc = await readFile(new URL('./oidc.mjs', root), 'utf8');
  assert.match(migration, /workspace_role_mappings/);
  assert.match(migration, /source TEXT NOT NULL CHECK \(source IN \('oidc','scim'\)\)/);
  assert.match(repo, /applyNormalizedRoleMappings/);
  assert.match(app, /role-mappings/);
  assert.match(oidc, /claims/);
});
