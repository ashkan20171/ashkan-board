const baseUrl = String(process.env.PERF_BASE_URL || '').replace(/\/$/, '');
const token = process.env.PERF_TOKEN || '';
const workspaceId = process.env.PERF_WORKSPACE_ID || '';
const requests = Math.max(1, Math.min(10_000, Number.parseInt(process.env.PERF_REQUESTS || '100', 10) || 100));
const concurrency = Math.max(1, Math.min(100, Number.parseInt(process.env.PERF_CONCURRENCY || '10', 10) || 10));
const warmup = Math.max(0, Math.min(100, Number.parseInt(process.env.PERF_WARMUP || '5', 10) || 0));
const p95Limit = Number.parseInt(process.env.PERF_P95_LIMIT_MS || '0', 10) || 0;

if (!baseUrl || !token || !workspaceId) {
  throw new Error('Set PERF_BASE_URL, PERF_TOKEN, and PERF_WORKSPACE_ID.');
}

const endpoint = `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/tickets/query?page=1&pageSize=25&sort=createdAt&direction=desc`;
const samples = [];
let failures = 0;
let next = 0;

async function requestOnce(record = true) {
  const started = performance.now();
  try {
    const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (!response.ok) {
      failures += 1;
      await response.body?.cancel();
    } else {
      await response.arrayBuffer();
    }
  } catch {
    failures += 1;
  } finally {
    if (record) samples.push(performance.now() - started);
  }
}

for (let i = 0; i < warmup; i += 1) await requestOnce(false);
const startedAt = performance.now();
await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
  while (next < requests) {
    const current = next;
    next += 1;
    await requestOnce(true);
  }
}));
const elapsedMs = performance.now() - startedAt;
const sorted = [...samples].sort((a, b) => a - b);
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] || 0;
const report = {
  endpoint: '/api/workspaces/:workspaceId/tickets/query?page=1&pageSize=25',
  requests,
  concurrency,
  warmup,
  failures,
  elapsedMs: Math.round(elapsedMs),
  throughputRps: Number((requests / (elapsedMs / 1000)).toFixed(2)),
  latencyMs: {
    min: Number((sorted[0] || 0).toFixed(2)),
    p50: Number(percentile(0.50).toFixed(2)),
    p95: Number(percentile(0.95).toFixed(2)),
    p99: Number(percentile(0.99).toFixed(2)),
    max: Number((sorted.at(-1) || 0).toFixed(2)),
  },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures || (p95Limit && report.latencyMs.p95 > p95Limit)) process.exitCode = 2;
