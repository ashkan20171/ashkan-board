import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics, createRateLimiter, safeTokenEqual } from '../observability.mjs';

test('rate limiter enforces a fixed window and bounds its client map', () => {
  let now = 1_000;
  const limiter = createRateLimiter({ windowMs: 100, maxRequests: 2, maxKeys: 2, now: () => now });
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
  limiter.allow('b');
  limiter.allow('c');
  assert.ok(limiter.size <= 2);
  now += 101;
  assert.equal(limiter.allow('a'), true);
});

test('metrics expose bounded-cardinality request counters and duration histograms', () => {
  const metrics = createMetrics({ buckets: [0.1, 1] });
  metrics.begin();
  metrics.finish('GET', 200, 50);
  metrics.begin();
  metrics.finish('POST', 429, 1_500);
  const output = metrics.render();
  assert.match(output, /ashkan_http_requests_total\{method="GET",status_class="2xx"\} 1/);
  assert.match(output, /ashkan_http_request_duration_seconds_bucket\{method="POST",status_class="4xx",le="\+Inf"\} 1/);
  assert.match(output, /ashkan_http_requests_in_flight 0/);
  assert.doesNotMatch(output, /\/api\/workspaces|user@example/);
});

test('metrics token comparison rejects absent and mismatched tokens', () => {
  assert.equal(safeTokenEqual('secret', 'secret'), true);
  assert.equal(safeTokenEqual('secret', 'other'), false);
  assert.equal(safeTokenEqual('secret', undefined), false);
});

test('rate limiter rejects invalid configuration instead of silently disabling limits', () => {
  assert.throws(() => createRateLimiter({ maxRequests: 0 }), /positive integer/);
});

test('Prometheus metrics include bounded cache and Redis circuit telemetry', () => {
  const metrics = createMetrics();
  const output = metrics.render({ hitsRedis: 2, hitsMemory: 3, misses: 4, entries: 5, inFlightLoads: 1, redisCircuit: 'open', redisErrors: 6 });
  assert.match(output, /ashkan_cache_operations_total\{operation="hitsRedis"\} 2/);
  assert.match(output, /ashkan_cache_entries 5/);
  assert.match(output, /ashkan_cache_inflight_loads 1/);
  assert.match(output, /ashkan_redis_circuit_open 1/);
});
