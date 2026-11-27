import { createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const memory = new Map();
const generations = new Map();
const inFlightLoads = new Map();
const MAX_MEMORY_ENTRIES = Math.max(100, Number.parseInt(process.env.CACHE_MEMORY_MAX_ENTRIES || '1000', 10) || 1000);
const DEFAULT_TTL = Math.max(1, Math.min(300, Number.parseInt(process.env.TICKET_CACHE_TTL_SECONDS || '10', 10) || 10));
const redisTimeout = Math.max(250, Math.min(10000, Number.parseInt(process.env.REDIS_TIMEOUT_MS || '1500', 10) || 1500));
const circuitThreshold = Math.max(1, Math.min(20, Number.parseInt(process.env.REDIS_CIRCUIT_FAILURE_THRESHOLD || '3', 10) || 3));
const circuitCooldownMs = Math.max(1000, Math.min(120000, Number.parseInt(process.env.REDIS_CIRCUIT_COOLDOWN_MS || '15000', 10) || 15000));
const stats = { hitsRedis: 0, hitsMemory: 0, misses: 0, loads: 0, loadErrors: 0, coalesced: 0, redisCommands: 0, redisErrors: 0, circuitOpens: 0, invalidations: 0 };
const circuit = { failures: 0, openUntil: 0, probeInFlight: false };

function encodeCommand(parts) {
  return `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(String(part))}\r\n${String(part)}\r\n`).join('')}`;
}

function parseReply(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd < 0) return null;
  const line = buffer.toString('utf8', offset + 1, lineEnd);
  if (type === '+' || type === ':' || type === '-') {
    return { value: type === ':' ? Number(line) : type === '-' ? new Error(line) : line, offset: lineEnd + 2 };
  }
  if (type === '$') {
    const length = Number(line);
    if (length === -1) return { value: null, offset: lineEnd + 2 };
    const end = lineEnd + 2 + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.toString('utf8', lineEnd + 2, end), offset: end + 2 };
  }
  if (type === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, offset: lineEnd + 2 };
    let cursor = lineEnd + 2;
    const values = [];
    for (let index = 0; index < count; index += 1) {
      const item = parseReply(buffer, cursor);
      if (!item) return null;
      values.push(item.value);
      cursor = item.offset;
    }
    return { value: values, offset: cursor };
  }
  throw new Error(`Unsupported Redis response type: ${type}`);
}

async function redisCommand(command) {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;
  const url = new URL(redisUrl);
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://.');
  const commands = [];
  const username = decodeURIComponent(url.username || '');
  const password = decodeURIComponent(url.password || '');
  if (password) commands.push(username ? ['AUTH', username, password] : ['AUTH', password]);
  const database = url.pathname.slice(1);
  if (database && database !== '0') commands.push(['SELECT', database]);
  commands.push(command);
  return new Promise((resolve, reject) => {
    const socket = url.protocol === 'rediss:'
      ? tls.connect({ host: url.hostname, port: Number(url.port || 6380), servername: url.hostname })
      : net.createConnection({ host: url.hostname, port: Number(url.port || 6379) });
    let buffer = Buffer.alloc(0);
    let replies = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(redisTimeout, () => finish(new Error('Redis command timed out.')));
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => socket.write(commands.map(encodeCommand).join('')));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (replies < commands.length) {
        let parsed;
        try { parsed = parseReply(buffer); } catch (error) { finish(error); return; }
        if (!parsed) return;
        buffer = buffer.subarray(parsed.offset);
        replies += 1;
        if (parsed.value instanceof Error) { finish(parsed.value); return; }
        if (replies === commands.length) finish(null, parsed.value);
      }
    });
  });
}

async function guardedRedisCommand(command) {
  if (!process.env.REDIS_URL) return { available: false, value: null };
  const now = Date.now();
  const isProbe = circuit.openUntil > 0;
  if (isProbe && now < circuit.openUntil) return { available: false, value: null };
  if (isProbe && circuit.probeInFlight) return { available: false, value: null };
  if (isProbe) circuit.probeInFlight = true;
  stats.redisCommands += 1;
  try {
    const value = await redisCommand(command);
    circuit.failures = 0;
    circuit.openUntil = 0;
    return { available: true, value };
  } catch {
    stats.redisErrors += 1;
    circuit.failures += 1;
    if (circuit.failures >= circuitThreshold && circuit.openUntil <= Date.now()) {
      circuit.openUntil = Date.now() + circuitCooldownMs;
      stats.circuitOpens += 1;
    }
    return { available: false, value: null };
  } finally {
    if (isProbe) circuit.probeInFlight = false;
  }
}

function memoryGet(key) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) { memory.delete(key); return null; }
  entry.touchedAt = Date.now();
  return entry.value;
}

function memorySet(key, value, ttlSeconds) {
  if (memory.size >= MAX_MEMORY_ENTRIES && !memory.has(key)) {
    const oldest = [...memory.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt).slice(0, Math.max(1, Math.ceil(MAX_MEMORY_ENTRIES * 0.1)));
    for (const [oldKey] of oldest) memory.delete(oldKey);
  }
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000, touchedAt: Date.now() });
}

async function generationFor(workspaceId) {
  const key = `ashkan:ticket-cache:generation:${workspaceId}`;
  const redis = await guardedRedisCommand(['GET', key]);
  if (redis.available) return String(redis.value || '0');
  return String(generations.get(workspaceId) || 0);
}

export async function getCachedWorkspaceTickets(workspaceId, options, loader, ttlSeconds = DEFAULT_TTL) {
  const generation = await generationFor(workspaceId);
  const digest = createHash('sha256').update(JSON.stringify(options || {})).digest('hex');
  const key = `ashkan:ticket-cache:${workspaceId}:${generation}:${digest}`;
  const redis = await guardedRedisCommand(['GET', key]);
  if (redis.available && redis.value) {
    try { stats.hitsRedis += 1; return JSON.parse(redis.value); } catch { /* malformed cache values are treated as misses */ }
  }
  const local = memoryGet(key);
  if (local !== null) { stats.hitsMemory += 1; return local; }
  stats.misses += 1;
  if (inFlightLoads.has(key)) {
    stats.coalesced += 1;
    return inFlightLoads.get(key);
  }
  const loadPromise = (async () => {
    stats.loads += 1;
    let value;
    try { value = await loader(); }
    catch (error) { stats.loadErrors += 1; throw error; }
    const serialized = JSON.stringify(value);
    memorySet(key, value, ttlSeconds);
    const write = await guardedRedisCommand(['SET', key, serialized, 'EX', String(ttlSeconds)]);
    // Redis is optional; a failed write leaves the bounded local cache available.
    void write;
    return value;
  })();
  inFlightLoads.set(key, loadPromise);
  try { return await loadPromise; }
  finally { if (inFlightLoads.get(key) === loadPromise) inFlightLoads.delete(key); }
}

export async function invalidateWorkspaceTicketCache(workspaceId) {
  if (!workspaceId) return;
  generations.set(workspaceId, (generations.get(workspaceId) || 0) + 1);
  stats.invalidations += 1;
  for (const key of memory.keys()) if (key.startsWith(`ashkan:ticket-cache:${workspaceId}:`)) memory.delete(key);
  await guardedRedisCommand(['INCR', `ashkan:ticket-cache:generation:${workspaceId}`]);
}

export function cacheDiagnostics() {
  const circuitState = circuit.openUntil > Date.now() ? 'open' : circuit.openUntil > 0 ? 'half-open' : 'closed';
  return {
    mode: process.env.REDIS_URL ? 'redis-with-memory-fallback' : 'process-memory',
    redisConfigured: Boolean(process.env.REDIS_URL),
    redisCircuit: circuitState,
    entries: memory.size,
    maxEntries: MAX_MEMORY_ENTRIES,
    inFlightLoads: inFlightLoads.size,
    ttlSeconds: DEFAULT_TTL,
    ...stats,
  };
}

export function resetCacheForTests() {
  memory.clear();
  generations.clear();
  inFlightLoads.clear();
  for (const key of Object.keys(stats)) stats[key] = 0;
  circuit.failures = 0;
  circuit.openUntil = 0;
  circuit.probeInFlight = false;
}
