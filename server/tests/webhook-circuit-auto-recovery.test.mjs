import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('phase 62 adds automatic webhook circuit recovery worker with per-webhook cooldown', async () => {
  const repo = await readFile(new URL('../normalized-repository.mjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  assert.match(repo, /circuit_breaker_enabled=true/);
  assert.match(repo, /disabled_reason='circuit-breaker'/);
  assert.match(repo, /circuit_recovery_seconds/);
  assert.match(repo, /FOR UPDATE SKIP LOCKED/);
  assert.match(app, /WEBHOOK_CIRCUIT_RECOVERY_WORKER_ENABLED/);
  assert.match(app, /WEBHOOK_CIRCUIT_RECOVERY_BATCH_SIZE/);
  assert.match(app, /webhook\.circuit\.auto_recovered/);
});
