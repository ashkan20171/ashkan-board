import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('phase 60 adds webhook circuit breaker controls and syntax-safe async loading', async () => {
  const migration = await readFile(new URL('../migrations/028_webhook_circuit_breaker.sql', import.meta.url), 'utf8');
  const repo = await readFile(new URL('../normalized-repository.mjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(migration, /circuit_breaker_enabled/);
  assert.match(migration, /failure_threshold/);
  assert.match(repo, /updateNormalizedWebhookCircuitPolicy/);
  assert.match(repo, /circuit-breaker/);
  assert.match(app, /action.*circuit-policy/);
  assert.match(ui, /async \(\[memberResult, auditResult, roleResult, mappingResult, webhookResult\]\)/);
});
