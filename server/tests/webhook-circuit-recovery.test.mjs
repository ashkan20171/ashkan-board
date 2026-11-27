import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('phase 61 adds webhook circuit recovery controls', async () => {
  const migration = await readFile(new URL('../migrations/029_webhook_circuit_recovery.sql', import.meta.url), 'utf8');
  const repo = await readFile(new URL('../normalized-repository.mjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  const client = await readFile(new URL('../../src/api/client.js', import.meta.url), 'utf8');
  assert.match(migration, /circuit_recovery_seconds/);
  assert.match(repo, /recoverNormalizedWebhookCircuit/);
  assert.match(repo, /recoverDueNormalizedWebhookCircuits/);
  assert.match(repo, /circuit_opened_at <= now\(\)/);
  assert.match(app, /recover-circuit/);
  assert.match(app, /processDueWebhookCircuitRecovery/);
  assert.match(app, /WEBHOOK_CIRCUIT_RECOVERY_INTERVAL_MS/);
  assert.match(client, /recoverWebhookCircuit/);
});
