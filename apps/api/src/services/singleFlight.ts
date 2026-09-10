import pg from 'pg';
import { pool } from '../db.js';

/**
 * Cross-process single-flight worker guard.
 *
 * The API can be scaled to multiple replicas behind the load balancer. Each
 * replica runs the same in-process periodic workers (report schedules, cron
 * jobs, the Hikvision event queue, notification dispatch). A Postgres
 * session-level advisory lock guarantees that only one replica executes a
 * given worker tick at a time, so work is never duplicated across replicas.
 *
 * The lock is held on a dedicated pooled connection for the duration of the
 * tick and released in `finally`, so a crashed or slow tick can never leak
 * the lock permanently.
 */

/** Stable, distinct lock keys for each worker (must stay unique). */
export const WORKER_LOCKS = {
  /** Reserved for the boot-time schema migrator (see packages/db/src/migrate.js). */
  MIGRATIONS: 88100,
  REPORT_SCHEDULER: 88101,
  CRON_JOBS: 88102,
  HIKVISION_QUEUE: 88103,
  NOTIFICATION_DISPATCH: 88104,
  EFRIS_WORKER: 88105,
} as const;

type Release = () => Promise<void>;

/**
 * Try to acquire the advisory lock for `key`. Returns a release function when
 * this process won the lock, or `null` when another replica already holds it.
 */
export async function tryAcquireWorkerLock(key: number): Promise<Release | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS ok',
      [key]
    );
    if (!rows[0]?.ok) {
      client.release();
      return null;
    }
    return async () => {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [key]);
      } finally {
        client.release();
      }
    };
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * Run `fn` only if this replica wins the advisory lock for `key`.
 * Returns the result of `fn`, or `undefined` when another replica already
 * holds the lock (the tick is skipped this round and picked up on a later
 * interval, which is exactly what we want for periodic workers).
 */
export async function singleFlight<T>(
  key: number,
  fn: () => Promise<T>
): Promise<T | undefined> {
  const release = await tryAcquireWorkerLock(key);
  if (!release) return undefined;
  try {
    return await fn();
  } finally {
    await release();
  }
}
