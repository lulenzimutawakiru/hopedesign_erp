import type { ConnectionOptions } from 'bullmq';
import type { RedisOptions as IoRedisOptions } from 'ioredis';

/**
 * Redis connection settings shared by the BullMQ producer (API) and the
 * background worker process.
 *
 * The ERP used to run its periodic background work as `setInterval` timers
 * inside the Express process. That tied background work to the request-serving
 * process: a restart killed in-flight ticks, every replica ran the same timer,
 * and on serverless (where the module is re-imported per request) the timers
 * were effectively meaningless. The work now runs in a dedicated worker process
 * fed by a BullMQ queue on Redis.
 *
 * Everything here is configuration only - no connection is opened at import
 * time, so tests and the Vercel handler can import this module for free.
 */

/** Namespace for every key BullMQ writes, so the ERP never collides with other Redis users. */
export const QUEUE_PREFIX = 'hopedesign';

/** Resolved target, normalised from either a connection URL or discrete variables. */
export interface RedisTarget {
  /** Original URL, when one was supplied. Preferred: ioredis parses it in full. */
  url?: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: { servername: string };
}

function isTruthyFlag(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * `QUEUE_ENABLED=false` is an explicit kill switch: it forces the queue off even
 * when Redis is configured, which puts the API back on its in-process fallback
 * timers. Useful for triage if Redis itself is the problem.
 */
export function isQueueExplicitlyDisabled(): boolean {
  const flag = process.env.QUEUE_ENABLED?.trim().toLowerCase();
  return flag === 'false' || flag === '0' || flag === 'no' || flag === 'off';
}

function targetFromUrl(raw: string): RedisTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') return null;

  const host = url.hostname;
  const target: RedisTarget = {
    url: raw,
    host,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
  };

  // `redis://:secret@host` yields an empty username and a populated password,
  // so an empty username must be omitted rather than sent as "".
  const username = decodeURIComponent(url.username || '');
  const password = decodeURIComponent(url.password || '');
  if (username) target.username = username;
  if (password) target.password = password;

  const db = Number.parseInt(url.pathname.replace(/^\//, '').trim(), 10);
  if (Number.isFinite(db) && db >= 0) target.db = db;

  if (url.protocol === 'rediss:') target.tls = { servername: host };

  return target;
}

function targetFromParts(): RedisTarget | null {
  const host = process.env.REDIS_HOST?.trim();
  if (!host) return null;

  const target: RedisTarget = {
    host,
    port: Number.parseInt(process.env.REDIS_PORT ?? '6379', 10) || 6379,
  };

  const username = process.env.REDIS_USERNAME?.trim();
  const password = process.env.REDIS_PASSWORD;
  if (username) target.username = username;
  if (password) target.password = password;

  const db = Number.parseInt(process.env.REDIS_DB ?? '', 10);
  if (Number.isFinite(db) && db >= 0) target.db = db;

  if (isTruthyFlag(process.env.REDIS_TLS)) target.tls = { servername: host };

  return target;
}

/**
 * Resolve the Redis target, or `null` when the queue is not configured.
 * `REDIS_URL` wins over the discrete `REDIS_HOST`/`REDIS_PORT` variables.
 */
export function redisTarget(): RedisTarget | null {
  if (isQueueExplicitlyDisabled()) return null;

  const url = process.env.REDIS_URL?.trim();
  if (url) {
    const parsed = targetFromUrl(url);
    if (parsed) return parsed;
  }

  return targetFromParts();
}

/**
 * True when a broker is configured, i.e. scheduled work belongs in the worker
 * process rather than in the API's in-process fallback timers.
 */
export function isQueueEnabled(): boolean {
  return redisTarget() !== null;
}

/**
 * Connection options for BullMQ itself.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on the connections it owns,
 * because a blocking command (BRPOPLPUSH/BZPOPMIN) must be allowed to wait
 * indefinitely - a retry cap would make BullMQ tear down the socket mid-wait.
 * `enableReadyCheck: false` lets workers start consuming before the first INFO
 * round trip completes.
 *
 * When a URL is available it is handed to BullMQ verbatim: its connection layer
 * splits `url` off and passes it to ioredis as `new IORedis(url, rest)`, which
 * is the best-tested path and handles `rediss://` TLS, credentials and db index
 * without any re-parsing here.
 */
export function bullConnection(): ConnectionOptions | null {
  const target = redisTarget();
  if (!target) return null;

  if (target.url) {
    return { url: target.url, maxRetriesPerRequest: null, enableReadyCheck: false };
  }

  return {
    host: target.host,
    port: target.port,
    ...(target.username ? { username: target.username } : {}),
    ...(target.password ? { password: target.password } : {}),
    ...(target.db === undefined ? {} : { db: target.db }),
    ...(target.tls ? { tls: target.tls } : {}),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

/**
 * Options for the worker's own control client (heartbeat / liveness).
 *
 * `enableOfflineQueue: false` makes a command reject immediately when Redis is
 * unreachable instead of buffering it, so the health endpoint reports the
 * outage instead of hanging.
 */
export function controlClientOptions(): IoRedisOptions | null {
  const target = redisTarget();
  if (!target) return null;

  return {
    host: target.host,
    port: target.port,
    ...(target.username ? { username: target.username } : {}),
    ...(target.password ? { password: target.password } : {}),
    ...(target.db === undefined ? {} : { db: target.db }),
    ...(target.tls ? { tls: target.tls } : {}),
    enableOfflineQueue: false,
  };
}

/** Redacted one-line description for boot logs. Never includes the password. */
export function describeQueueConnection(): string {
  const target = redisTarget();
  if (!target) return 'disabled (set REDIS_URL or REDIS_HOST to enable)';
  return [
    `redis://${target.host}:${target.port}/${target.db ?? 0}`,
    target.tls ? 'tls' : 'plain',
    target.password ? 'auth' : 'no-auth',
    `prefix=${QUEUE_PREFIX}`,
  ].join(' ');
}