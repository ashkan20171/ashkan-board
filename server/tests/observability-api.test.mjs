import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('metrics endpoint is opt-in, token protected, and exports request telemetry', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ashkan-metrics-'));
  process.env.DATA_FILE = join(dir, 'store.json');
  process.env.JWT_SECRET = 'observability-test-secret-at-least-32-characters';
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  process.env.NODE_ENV = 'development';
  process.env.METRICS_ENABLED = 'true';
  process.env.METRICS_TOKEN = 'metrics-test-token-with-at-least-32-characters';
  const { createAppServer } = await import(`../app.mjs?metrics-api=${Date.now()}`);
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
    delete process.env.METRICS_ENABLED;
    delete process.env.METRICS_TOKEN;
  });

  const live = await fetch(`${base}/api/health/live`);
  assert.equal(live.status, 200);
  assert.ok(live.headers.get('x-request-id'));
  assert.equal(live.headers.get('x-content-type-options'), 'nosniff');

  const denied = await fetch(`${base}/api/metrics`);
  assert.equal(denied.status, 401);
  const allowed = await fetch(`${base}/api/metrics`, { headers: { authorization: `Bearer ${process.env.METRICS_TOKEN}` } });
  assert.equal(allowed.status, 200);
  assert.match(allowed.headers.get('content-type'), /text\/plain/);
  const metrics = await allowed.text();
  assert.match(metrics, /ashkan_http_requests_total/);
  assert.match(metrics, /ashkan_http_request_duration_seconds/);
  assert.match(metrics, /ashkan_process_resident_memory_bytes/);
  assert.match(metrics, /ashkan_cache_operations_total/);
  assert.match(metrics, /ashkan_redis_circuit_open/);
});
