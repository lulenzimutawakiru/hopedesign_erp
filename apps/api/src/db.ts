import pg from 'pg';
import { config } from './config.js';
import { correlationId } from './utils.js';

const { Pool } = pg;

export const pool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  user: config.postgres.user,
  password: config.postgres.password,
  database: config.postgres.database,
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

export async function pingDb(): Promise<void> {
  await query('SELECT 1');
}
