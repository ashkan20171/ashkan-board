import test from 'node:test';
import assert from 'node:assert/strict';
import { scimAuthConfigured, scimTokenValid } from '../scim-repository.mjs';

test('SCIM requires a sufficiently strong bearer token configuration', () => {
  const previous = process.env.SCIM_BEARER_TOKEN;
  delete process.env.SCIM_BEARER_TOKEN;
  assert.equal(scimAuthConfigured(), false);
  assert.equal(scimTokenValid('anything'), false);
  process.env.SCIM_BEARER_TOKEN = 'x'.repeat(32);
  assert.equal(scimAuthConfigured(), true);
  assert.equal(scimTokenValid('x'.repeat(32)), true);
  assert.equal(scimTokenValid('y'.repeat(32)), false);
  if (previous === undefined) delete process.env.SCIM_BEARER_TOKEN; else process.env.SCIM_BEARER_TOKEN = previous;
});
