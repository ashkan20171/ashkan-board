import test from 'node:test';
import assert from 'node:assert/strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase41-test-secret-please-change-0123456789';
const security = await import('../security.mjs');

test('TOTP generation and verification supports current code', () => {
  const secret = security.generateTotpSecret();
  const code = security.totpCode(secret, 1_700_000_000_000);
  assert.equal(code.length, 6);
  assert.equal(security.verifyTotp(secret, code, 1_700_000_000_000), true);
  assert.equal(security.verifyTotp(secret, '000000', 1_700_000_000_000), false);
});

test('TOTP secret encryption round-trips without exposing plaintext', () => {
  const secret = security.generateTotpSecret();
  const encrypted = security.encryptSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(security.decryptSecret(encrypted), secret);
});

test('MFA challenge is purpose-bound and short-lived', () => {
  const user = { id: '00000000-0000-0000-0000-000000000001', email: 'test@example.com' };
  const token = security.signMfaChallenge(user, 60);
  const claims = security.verifyMfaChallenge(token);
  assert.equal(claims.sub, user.id);
  assert.equal(claims.purpose, 'mfa-challenge');
});
