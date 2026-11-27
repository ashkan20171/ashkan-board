import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheDiagnostics, getCachedWorkspaceTickets, invalidateWorkspaceTicketCache, resetCacheForTests } from '../cache.mjs';

test('ticket cache reuses values for identical workspace query keys', async () => {
  delete process.env.REDIS_URL;
  resetCacheForTests();
  let loads = 0;
  const loader = async () => ({ tickets: [{ id: String(++loads) }], pagination: { total: 1 } });
  const first = await getCachedWorkspaceTickets('workspace-a', { page: 1, pageSize: 25 }, loader);
  const second = await getCachedWorkspaceTickets('workspace-a', { page: 1, pageSize: 25 }, loader);
  assert.deepEqual(second, first);
  assert.equal(loads, 1);
  assert.equal(cacheDiagnostics().mode, 'process-memory');
});

test('ticket cache invalidation advances workspace generation and reloads data', async () => {
  delete process.env.REDIS_URL;
  resetCacheForTests();
  let loads = 0;
  const loader = async () => ({ version: ++loads });
  const options = { page: 1 };
  assert.deepEqual(await getCachedWorkspaceTickets('workspace-b', options, loader), { version: 1 });
  await invalidateWorkspaceTicketCache('workspace-b');
  assert.deepEqual(await getCachedWorkspaceTickets('workspace-b', options, loader), { version: 2 });
  assert.equal(loads, 2);
});

test('cache keys isolate workspaces and query options', async () => {
  delete process.env.REDIS_URL;
  resetCacheForTests();
  let loads = 0;
  const loader = async () => ++loads;
  await getCachedWorkspaceTickets('workspace-a', { page: 1 }, loader);
  await getCachedWorkspaceTickets('workspace-a', { page: 2 }, loader);
  await getCachedWorkspaceTickets('workspace-c', { page: 1 }, loader);
  assert.equal(loads, 3);
});


test('API routes cache normalized ticket reads and invalidate on writes/imports', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  assert.match(source, /getCachedWorkspaceTickets\(workspaceId, options/);
  assert.match(source, /getCachedWorkspaceTickets\(workspaceId, ticketOptions/);
  assert.ok((source.match(/invalidateWorkspaceTicketCache\(workspaceId\)/g) || []).length >= 4);
});

test('cache coalesces concurrent misses into a single loader operation', async () => {
  delete process.env.REDIS_URL;
  resetCacheForTests();
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loader = async () => { loads += 1; await gate; return { items: [1, 2, 3] }; };
  const first = getCachedWorkspaceTickets('workspace-concurrent', { page: 1 }, loader);
  const second = getCachedWorkspaceTickets('workspace-concurrent', { page: 1 }, loader);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(loads, 1);
  assert.equal(cacheDiagnostics().coalesced, 1);
  assert.equal(cacheDiagnostics().loads, 1);
});

test('Redis circuit breaker opens after repeated connection failures and cache falls back', async () => {
  const previous = {
    url: process.env.REDIS_URL,
    threshold: process.env.REDIS_CIRCUIT_FAILURE_THRESHOLD,
    timeout: process.env.REDIS_TIMEOUT_MS,
  };
  process.env.REDIS_URL = 'redis://127.0.0.1:1/0';
  process.env.REDIS_CIRCUIT_FAILURE_THRESHOLD = '1';
  process.env.REDIS_TIMEOUT_MS = '250';
  resetCacheForTests();
  try {
    let loads = 0;
    const value = await getCachedWorkspaceTickets('workspace-fallback', { page: 1 }, async () => ({ loaded: ++loads }));
    assert.deepEqual(value, { loaded: 1 });
    await getCachedWorkspaceTickets('workspace-fallback-2', { page: 1 }, async () => ({ loaded: ++loads }));
    const diagnostics = cacheDiagnostics();
    assert.equal(diagnostics.redisCircuit, 'open');
    assert.equal(diagnostics.redisErrors, 3);
    assert.equal(diagnostics.circuitOpens, 1);
    assert.equal((await getCachedWorkspaceTickets('workspace-fallback', { page: 1 }, async () => ({ loaded: ++loads }))).loaded, 1);
    assert.equal(loads, 2);
  } finally {
    if (previous.url === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previous.url;
    if (previous.threshold === undefined) delete process.env.REDIS_CIRCUIT_FAILURE_THRESHOLD; else process.env.REDIS_CIRCUIT_FAILURE_THRESHOLD = previous.threshold;
    if (previous.timeout === undefined) delete process.env.REDIS_TIMEOUT_MS; else process.env.REDIS_TIMEOUT_MS = previous.timeout;
    resetCacheForTests();
  }
});
