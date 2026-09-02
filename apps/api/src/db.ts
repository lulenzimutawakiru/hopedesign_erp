import pg from 'pg';
import { config } from './config.js';
import { correlationId } from './utils.js';

const { Pool } = pg;

export const pool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  user: config.postgres.appUser,
  password: config.postgres.appPassword,
  database: config.postgres.database,
  // Supabase/Neon require TLS. rejectUnauthorized is relaxed so hostname/CA
  // mismatches on managed endpoints do not take the API down; tighten to true
  // when the provider's cert chain verifies against the configured host.
  ssl: config.postgres.ssl ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
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
}

const applyContext = async (client: pg.PoolClient | pg.Client, ctx: Ctx) => {
  const tenant = ctx.tenantId ?? null;
  const company = ctx.companyId ?? null;
  const branch = ctx.branchId ?? null;
  const user = ctx.userId ?? null;
  await client.query('SELECT set_app_context($1,$2,$3,$4)', [tenant, company, branch, user]);
  await client.query('SELECT set_config($1,$2,true)', ['app.correlation_id', ctx.correlationId ?? correlationId()]);
  await client.query('SELECT set_config($1,$2,true)', ['app.ip', ctx.ip ?? '']);
  await client.query('SELECT set_config($1,$2,true)', ['app.user_agent', ctx.userAgent ?? '']);
  await client.query('SELECT set_config($1,$2,true)', ['app.device', ctx.device ?? '']);
};

/** Run a single query inside a transaction with app context applied. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  ctx: Ctx = {}
): Promise<pg.QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyContext(client, ctx);
    const result = await client.query<T>(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Run a callback inside a transaction with app context applied. */
export async function tx<T>(
  fn: (client: pg.PoolClient, ctx: Ctx) => Promise<T>,
  ctx: Ctx = {}
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyContext(client, ctx);
    const result = await fn(client, ctx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyContext(client, ctx);
    const result = await fn(client, ctx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function pingDb(): Promise<void> {
  await query('SELECT 1');
}
