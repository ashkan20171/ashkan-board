export function postgresPoolConfig(overrides = {}) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const max = Number(process.env.PG_POOL_MAX || 10);
  if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error('PG_POOL_MAX must be an integer between 1 and 100.');
  return {
    connectionString: process.env.DATABASE_URL,
    max,
    min: Number(process.env.PG_POOL_MIN || 0),
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 30000),
    query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 30000),
    keepAlive: true,
    application_name: process.env.PG_APPLICATION_NAME || 'ashkan-board-api',
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
    ...overrides,
  };
}

export const requiredProductionPersistenceMode = 'normalized';
