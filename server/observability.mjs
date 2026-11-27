import { timingSafeEqual } from 'node:crypto';

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function createRateLimiter({ windowMs = 60_000, maxRequests = 120, maxKeys = 10_000, now = Date.now } = {}) {
  for (const [name, value] of Object.entries({ windowMs, maxRequests, maxKeys })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  }
  const clients = new Map();
  let lastPrune = 0;
  return {
    allow(key) {
      const current = now();
      if (current - lastPrune >= windowMs) {
        for (const [clientKey, entry] of clients) {
          if (current - entry.start >= windowMs) clients.delete(clientKey);
        }
        lastPrune = current;
      }
      const normalizedKey = String(key || 'unknown').slice(0, 200);
      let entry = clients.get(normalizedKey);
      if (!entry || current - entry.start >= windowMs) {
        if (clients.size >= maxKeys && !clients.has(normalizedKey)) {
          const oldestKey = clients.keys().next().value;
          if (oldestKey !== undefined) clients.delete(oldestKey);
        }
        entry = { start: current, count: 0 };
        clients.set(normalizedKey, entry);
      }
      entry.count += 1;
      return entry.count <= maxRequests;
    },
    get size() { return clients.size; },
  };
}

export function createMetrics({ buckets = DEFAULT_BUCKETS } = {}) {
  const requests = new Map();
  const durations = new Map();
  let inFlight = 0;
  const keyFor = (method, status) => {
    const candidate = String(method).toUpperCase();
    const safeMethod = /^[A-Z]{1,12}$/.test(candidate) ? candidate : 'OTHER';
    return `${safeMethod}|${Math.floor(status / 100)}xx`;
  };
  return {
    begin() { inFlight += 1; },
    finish(method, status, durationMs) {
      inFlight = Math.max(0, inFlight - 1);
      const key = keyFor(method, status);
      requests.set(key, (requests.get(key) || 0) + 1);
      const seconds = Math.max(0, durationMs / 1000);
      let histogram = durations.get(key);
      if (!histogram) {
        histogram = { count: 0, sum: 0, buckets: new Array(buckets.length).fill(0) };
        durations.set(key, histogram);
      }
      histogram.count += 1;
      histogram.sum += seconds;
      buckets.forEach((bound, index) => { if (seconds <= bound) histogram.buckets[index] += 1; });
    },
    render(cache = null) {
      const lines = [
        '# HELP ashkan_http_requests_total Completed HTTP requests.',
        '# TYPE ashkan_http_requests_total counter',
      ];
      for (const [key, count] of requests) {
        const [method, statusClass] = key.split('|');
        lines.push(`ashkan_http_requests_total{method="${method}",status_class="${statusClass}"} ${count}`);
      }
      lines.push('# HELP ashkan_http_request_duration_seconds HTTP request duration.', '# TYPE ashkan_http_request_duration_seconds histogram');
      for (const [key, histogram] of durations) {
        const [method, statusClass] = key.split('|');
        buckets.forEach((bound, index) => lines.push(`ashkan_http_request_duration_seconds_bucket{method="${method}",status_class="${statusClass}",le="${bound}"} ${histogram.buckets[index]}`));
        lines.push(`ashkan_http_request_duration_seconds_bucket{method="${method}",status_class="${statusClass}",le="+Inf"} ${histogram.count}`);
        lines.push(`ashkan_http_request_duration_seconds_sum{method="${method}",status_class="${statusClass}"} ${histogram.sum}`);
        lines.push(`ashkan_http_request_duration_seconds_count{method="${method}",status_class="${statusClass}"} ${histogram.count}`);
      }
      lines.push('# HELP ashkan_http_requests_in_flight Current requests being handled.', '# TYPE ashkan_http_requests_in_flight gauge', `ashkan_http_requests_in_flight ${inFlight}`);
      lines.push('# HELP ashkan_process_uptime_seconds Process uptime in seconds.', '# TYPE ashkan_process_uptime_seconds gauge', `ashkan_process_uptime_seconds ${process.uptime()}`);
      lines.push('# HELP ashkan_process_resident_memory_bytes Resident memory in bytes.', '# TYPE ashkan_process_resident_memory_bytes gauge', `ashkan_process_resident_memory_bytes ${process.memoryUsage().rss}`);
      if (cache) {
        const cacheCounters = ['hitsRedis', 'hitsMemory', 'misses', 'loads', 'loadErrors', 'coalesced', 'redisCommands', 'redisErrors', 'circuitOpens', 'invalidations'];
        lines.push('# HELP ashkan_cache_operations_total Cache operations by outcome.', '# TYPE ashkan_cache_operations_total counter');
        for (const name of cacheCounters) lines.push(`ashkan_cache_operations_total{operation=\"${name}\"} ${Number(cache[name] || 0)}`);
        lines.push('# HELP ashkan_cache_entries Current process-local cache entries.', '# TYPE ashkan_cache_entries gauge', `ashkan_cache_entries ${Number(cache.entries || 0)}`);
        lines.push('# HELP ashkan_cache_inflight_loads Concurrent cache loader operations.', '# TYPE ashkan_cache_inflight_loads gauge', `ashkan_cache_inflight_loads ${Number(cache.inFlightLoads || 0)}`);
        lines.push('# HELP ashkan_redis_circuit_open Redis circuit breaker open state.', '# TYPE ashkan_redis_circuit_open gauge', `ashkan_redis_circuit_open ${cache.redisCircuit === 'open' ? 1 : 0}`);
      }
      return `${lines.join('\n')}\n`;
    },
  };
}

export function safeTokenEqual(expected, supplied) {
  if (!expected || !supplied) return false;
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(supplied));
  return left.length === right.length && timingSafeEqual(left, right);
}
