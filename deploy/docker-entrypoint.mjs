#!/usr/bin/env node
/**
 * Production container boot: wait for Postgres, migrate as owner,
 * set the least-privilege app-role password, optionally seed, then start the API.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  DATABASE_URL,
  POSTGRES_HOST = 'postgres',
  POSTGRES_PORT = '5432',
  POSTGRES_USER = 'hopedesign',
  POSTGRES_PASSWORD = '',
  POSTGRES_DB = 'hopedesign_erp',
  POSTGRES_APP_USER = 'hopedesign_app',
  POSTGRES_APP_PASSWORD = '',
  POSTGRES_SSL,
  SEED_ON_BOOT,
} = process.env;

const ownerUrl =
  DATABASE_URL ||
  `postgres://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`;

const ssl =
  POSTGRES_SSL && !['0', 'false', 'disable'].includes(POSTGRES_SSL.toLowerCase())
    ? { rejectUnauthorized: false }
    : undefined;

function run(cmd, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code ?? signal}`));
    });
  });
}

async function waitForPostgres() {
  const pool = new pg.Pool({ connectionString: ownerUrl, ssl, max: 1, connectionTimeoutMillis: 4000 });
  const deadline = Date.now() + 120_000;
  let last = 'not attempted';
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      await pool.end();
      console.log('[boot] postgres is ready');
      return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      console.log('[boot] waiting for postgres…');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  throw new Error(`postgres did not become ready: ${last}`);
}

async function syncAppRolePassword() {
  if (!POSTGRES_APP_PASSWORD) {
    throw new Error('POSTGRES_APP_PASSWORD is required');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(POSTGRES_APP_USER)) {
    throw new Error('POSTGRES_APP_USER is not a valid identifier');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(POSTGRES_DB)) {
    throw new Error('POSTGRES_DB is not a valid identifier');
  }
  const client = new pg.Client({ connectionString: ownerUrl, ssl });
  await client.connect();
  try {
    await client.query(`ALTER ROLE ${POSTGRES_APP_USER} WITH LOGIN PASSWORD ${client.escapeLiteral(POSTGRES_APP_PASSWORD)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${POSTGRES_APP_USER}`).catch(() => undefined);
    console.log(`[boot] ${POSTGRES_APP_USER} password synced`);
  } finally {
    await client.end();
  }
}

async function main() {
  await waitForPostgres();
  await run(process.execPath, [path.join(root, 'packages/db/src/migrate.js')], { DATABASE_URL: ownerUrl });
  await syncAppRolePassword();
  if (SEED_ON_BOOT === 'true' || SEED_ON_BOOT === '1') {
    console.log('[boot] SEED_ON_BOOT=true — loading seed data');
    await run(process.execPath, [path.join(root, 'packages/db/src/seed.js')], { DATABASE_URL: ownerUrl });
  }

  const api = spawn(process.execPath, [path.join(root, 'apps/api/dist/index.js')], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  const stop = (signal) => {
    if (!api.killed) api.kill(signal);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  api.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main().catch((err) => {
  console.error('[boot] failed', err);
  process.exit(1);
});
