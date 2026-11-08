import pg from 'pg';
import { config } from './config.js';
import { correlationId } from './utils.js';

const { Pool } = pg;

const isTestEnv = config.env === 'test';

export const pool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  user: config.postgres.appUser,
  password: config.postgres.appPassword,
  database: config.postgres.database,
  // SEC-007: verify the server certificate by default. The previous
  // `rejectUnauthorized: false` disabled TLS authentication entirely on
  // managed endpoints; now verification only relaxes on an explicit opt-out.
  ssl: config.postgres.ssl ? { rejectUnauthorized: config.postgres.rejectUnauthorized } : undefined,
  max: isTestEnv ? 10 : 20,
  min: 0,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  query_timeout: 30_000,
  application_name: 'hopedesign-erp',
  keepAlive: true,
  keepAliveInitialDelayMillis: 5_000,
  maxLifetimeSeconds: 60 * 30,
});

pool.on('connect', (client) => {
  client.on('error', (err) => {
    console.error('[db] client error', err.message);
  });
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

export interface Ctx {
  tenantId?: number | null;
  companyId?: number | null;
  branchId?: number | null;
  userId?: number | null;
  correlationId?: string;
  ip?: string | null;
  userAgent?: string | null;
  device?: string | null;
  /**
   * ABAC resource attributes resolved by a handler for the current request.
   * `applyContext` ignores this field; it exists so services can publish the
   * facts a policy needs without a second, parallel context type.
   */
  resourceAttributes?: Record<string, unknown>;
}

const applyContext = async (client: pg.PoolClient | pg.Client, ctx: Ctx) => {
  const tenant = ctx.tenantId ?? null;
  const company = ctx.companyId ?? null;
  const branch = ctx.branchId ?? null;
  const user = ctx.userId ?? null;
  // Perf: collapse five separate GUC-setting round-trips into one. `set_app_context`
  // and the four `set_config` calls are transaction-local GUC writes that commute,
  // so a single SELECT (one wire round-trip) applies them all; `is_local => true`
  // keeps them scoped to the surrounding transaction exactly as before.
  await client.query(
    `SELECT set_app_context($1,$2,$3,$4),
            set_config('app.correlation_id', $5, true),
            set_config('app.ip', $6, true),
            set_config('app.user_agent', $7, true),
            set_config('app.device', $8, true)`,
    [
      tenant,
      company,
      branch,
      user,
      ctx.correlationId ?? correlationId(),
      ctx.ip ?? '',
      ctx.userAgent ?? '',
      ctx.device ?? '',
    ]
  );
};

const rollbackQuietly = async (client: pg.PoolClient | pg.Client) => {
  try {
    await client.query('ROLLBACK');
  } catch {
    // If the transaction was never started or already failed, keep the original
    // error intact and avoid masking it with a secondary rollback failure.
  }
};

const withTransaction = async <T>(
  action: (client: pg.PoolClient, ctx: Ctx) => Promise<T>,
  ctx: Ctx = {}
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyContext(client, ctx);
    const result = await action(client, ctx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await rollbackQuietly(client);
    throw err;
  } finally {
    client.release();
  }
};

/** Run a single query inside a transaction with app context applied. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  ctx: Ctx = {}
): Promise<pg.QueryResult<T>> {
  return withTransaction(async (client) => client.query<T>(text, params), ctx);
}

/** Run a callback inside a transaction with app context applied. */
export async function tx<T>(
  fn: (client: pg.PoolClient, ctx: Ctx) => Promise<T>,
  ctx: Ctx = {}
): Promise<T> {
  return withTransaction(fn, ctx);
}

/** Run a callback on a fresh pooled connection in its own transaction with
 *  app context applied. Use for fire-and-forget background work such as event
 *  notification mirroring: the caller's pooled client is never shared, so the
 *  work cannot run on a connection whose transaction-local context was reset
 *  by the caller's COMMIT, and a failure cannot abort the caller's transaction
 *  or poison a pooled connection for the next request. */
export async function detach<T>(
  fn: (client: pg.PoolClient, ctx: Ctx) => Promise<T>,
  ctx: Ctx = {}
): Promise<T> {
  return withTransaction(fn, ctx);
}

export async function pingDb(): Promise<void> {
  await query('SELECT 1');
}
