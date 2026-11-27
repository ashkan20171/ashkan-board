import test from 'node:test';
import assert from 'node:assert/strict';
import { oidcConfigured, oidcPublicConfig } from '../oidc.mjs';

test('OIDC is disabled when provider credentials are absent', () => {
  const keys = ['OIDC_ISSUER','OIDC_CLIENT_ID','OIDC_CLIENT_SECRET','OIDC_REDIRECT_URI'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  assert.equal(oidcConfigured(), false);
  assert.deepEqual(oidcPublicConfig(), { configured: false, issuer: null, scopes: 'openid profile email', loginEnabled: false });
  for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
});

test('OIDC public config exposes no client secret', () => {
  const previous = { OIDC_ISSUER: process.env.OIDC_ISSUER, OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID, OIDC_CLIENT_SECRET: process.env.OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI: process.env.OIDC_REDIRECT_URI };
  Object.assign(process.env, { OIDC_ISSUER: 'https://id.example.test', OIDC_CLIENT_ID: 'public-client', OIDC_CLIENT_SECRET: 'super-secret', OIDC_REDIRECT_URI: 'https://app.example.test/api/auth/oidc/callback' });
  const config = oidcPublicConfig();
  assert.equal(config.loginEnabled, true);
  assert.equal(config.issuer, 'https://id.example.test');
  assert.equal('clientSecret' in config, false);
  for (const [key,value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});
