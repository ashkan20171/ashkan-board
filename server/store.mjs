import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { syncNormalizedState } from './normalized-repository.mjs';
import { postgresPoolConfig } from './postgres-config.mjs';
const file = resolve(process.env.DATA_FILE || './data/ashkan-board.json');
const empty = { attachments: [], presence: [], users: [], workspaces: [], memberships: [], tickets: [], refreshTokens: [], passwordResets: [], invitations: [], auditLogs: [], notifications: [], importBatches: [], comments: [] };
let queue = Promise.resolve();
let poolPromise;
export async function getPostgresPool() {
  if (!poolPromise) poolPromise = import('pg').then(({ Pool }) => new Pool(postgresPoolConfig()));
  return poolPromise;
}
export async function readStore() {
  if (process.env.DATABASE_URL && process.env.PERSISTENCE_MODE === 'normalized') {
    throw new Error('Legacy JSONB aggregate reads are disabled in normalized persistence mode. Use a normalized repository.');
  }
  if (process.env.DATABASE_URL) {
    const pool = await getPostgresPool();
    const result = await pool.query('SELECT state FROM ashkan_app_state WHERE id = 1');
    return result.rows[0]?.state ? { ...structuredClone(empty), ...result.rows[0].state } : structuredClone(empty);
  }
  try { return { ...structuredClone(empty), ...JSON.parse(await readFile(file, 'utf8')) }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return structuredClone(empty); }
}
export async function updateStore(mutator) {
  if (process.env.DATABASE_URL && process.env.PERSISTENCE_MODE === 'normalized') {
    throw new Error('Legacy JSONB aggregate writes are disabled in normalized persistence mode. Use a normalized repository.');
  }
  const operation = queue.then(async () => {
    if (process.env.DATABASE_URL) {
      const pool = await getPostgresPool(); const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query('SELECT state FROM ashkan_app_state WHERE id = 1 FOR UPDATE');
        const data = { ...structuredClone(empty), ...(result.rows[0]?.state || {}) };
        const value = await mutator(data);
        await client.query('INSERT INTO ashkan_app_state (id, state, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()', [JSON.stringify(data)]);
        // In normalized runtime, relational repositories own migrated domains.
        // Rebuilding every table from the compatibility aggregate would overwrite
        // newer relational writes and is therefore restricted to legacy mode.
        if (process.env.PERSISTENCE_MODE !== 'normalized') await syncNormalizedState(client, data);
        await client.query('COMMIT'); return value;
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const data = await readStore(); const value = await mutator(data); await mkdir(dirname(file), { recursive: true });
    const serialized = JSON.stringify(data, null, 2);
    const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, serialized, { mode: 0o600 });
    try { await rename(temp, file); } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
      // Windows can briefly keep the target JSON file open (for example by an
      // antivirus/indexer). Fall back to a direct write so volatile presence
      // updates do not turn into HTTP 500 responses.
      await writeFile(file, serialized, { mode: 0o600 });
      try { await import('node:fs/promises').then(({ unlink }) => unlink(temp)); } catch {}
    }
    return value;
  });
  queue = operation.catch(() => {}); return operation;
}

export async function closePostgresPool() {
  if (!poolPromise) return;
  const pool = await poolPromise;
  poolPromise = undefined;
  await pool.end();
}
