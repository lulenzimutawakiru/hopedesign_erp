import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  QUEUE_NAME,
  SCHEDULED_TASKS,
  SCHEDULED_TASK_IDS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
  getScheduledTask,
} from '../src/services/queue/queues.js';
import { TASK_HANDLERS } from '../src/services/queue/jobs.js';
import {
  closeTaskQueue,
  installScheduledTasks,
  queueSnapshot,
  removeScheduledTasks,
  schedulerSpecs,
  taskQueue,
} from '../src/services/queue/dispatcher.js';
import {
  QUEUE_PREFIX,
  bullConnection,
  describeQueueConnection,
  isQueueEnabled,
  redisTarget,
} from '../src/services/queue/connection.js';

/**
 * The periodic work used to be `setInterval` timers inside the Express process
 * and is now a BullMQ schedule executed by a separate worker. These tests pin
 * the parts that are easy to break silently: the task registry staying in sync
 * with its handlers, the cadence not drifting, and the Redis configuration
 * handling.
 *
 * No test opens a Redis connection - the disabled-queue cases return before any
 * client is constructed.
 */

const ENV_KEYS = [
  'REDIS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_USERNAME',
  'REDIS_PASSWORD',
  'REDIS_DB',
  'REDIS_TLS',
  'QUEUE_ENABLED',
] as const;

let saved: Map<string, string | undefined>;

beforeEach(() => {
  saved = new Map();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('scheduled task registry', () => {
  it('has a handler for every task and a task for every handler', () => {
    const missingHandlers = SCHEDULED_TASK_IDS.filter((id) => !TASK_HANDLERS[id]);
    const orphanHandlers = Object.keys(TASK_HANDLERS).filter((id) => !getScheduledTask(id));

    expect(missingHandlers).toEqual([]);
    expect(orphanHandlers).toEqual([]);
  });

  it('uses unique task ids', () => {
    expect(new Set(SCHEDULED_TASK_IDS).size).toBe(SCHEDULED_TASK_IDS.length);
  });

  it('uses a unique advisory lock per task', () => {
    const locks = SCHEDULED_TASKS.map((task) => task.lock);
    expect(new Set(locks).size).toBe(locks.length);
  });

  it('keeps the cadence the in-process timers used', () => {
    // Regression guard: the migration must not have changed how often work runs.
    const cadence = Object.fromEntries(SCHEDULED_TASKS.map((task) => [task.id, task.everyMs]));

    expect(cadence).toEqual({
      'report-scheduler': 60_000,
      'cron-jobs': 60_000,
      'hikvision-queue': 10_000,
      'efris-worker': 20_000,
      'notification-dispatch': 15_000,
    });
  });

  it('offsets tasks that share an interval so they do not fire together', () => {
    const perInterval = new Map<number, string[]>();
    for (const task of SCHEDULED_TASKS) {
      perInterval.set(task.everyMs, [...(perInterval.get(task.everyMs) ?? []), task.id]);
    }

    for (const [, ids] of perInterval) {
      if (ids.length < 2) continue;
      const offsets = ids.map((id) => getScheduledTask(id)?.offsetMs);
      expect(new Set(offsets).size).toBe(offsets.length);
    }
  });

  it('expires the heartbeat only after several missed beats', () => {
    expect(WORKER_HEARTBEAT_TTL_SECONDS * 1000).toBeGreaterThan(WORKER_HEARTBEAT_INTERVAL_MS * 2);
    expect(WORKER_HEARTBEAT_KEY.startsWith(`${QUEUE_PREFIX}:`)).toBe(true);
    expect(QUEUE_NAME).toBeTruthy();
  });
});

describe('scheduler specs', () => {
  it('registers exactly one scheduler per task with the configured interval', () => {
    const specs = schedulerSpecs();

    expect(specs).toHaveLength(SCHEDULED_TASKS.length);
    expect(specs.map((spec) => spec.id)).toEqual([...SCHEDULED_TASK_IDS]);

    for (const spec of specs) {
      expect(spec.repeat.every).toBe(getScheduledTask(spec.id)?.everyMs);
      expect(spec.template.name).toBe(spec.id);
    }
  });

  it('retries a failed tick once and keeps only the recent failures', () => {
    for (const spec of schedulerSpecs()) {
      expect(spec.template.opts.attempts).toBe(2);
      expect(spec.template.opts.backoff).toEqual({ type: 'exponential', delay: 5_000 });
      // Successful ticks are noise and are dropped immediately.
      expect(spec.template.opts.removeOnComplete).toBe(true);
      expect(spec.template.opts.removeOnFail).toEqual({ count: 100 });
    }
  });

  it('omits offset for tasks that do not need one', () => {
    for (const spec of schedulerSpecs()) {
      const offset = getScheduledTask(spec.id)?.offsetMs;
      if (offset === undefined) expect(spec.repeat).not.toHaveProperty('offset');
      else expect(spec.repeat.offset).toBe(offset);
    }
  });
});

describe('redis configuration', () => {
  it('reports the queue disabled when nothing is configured', () => {
    expect(redisTarget()).toBeNull();
    expect(isQueueEnabled()).toBe(false);
    expect(bullConnection()).toBeNull();
    expect(describeQueueConnection()).toContain('disabled');
  });

  it('parses a redis URL including credentials and database index', () => {
    process.env.REDIS_URL = 'redis://:s3cret@redis.internal:6380/4';

    expect(redisTarget()).toMatchObject({
      url: 'redis://:s3cret@redis.internal:6380/4',
      host: 'redis.internal',
      port: 6380,
      password: 's3cret',
      db: 4,
    });
    expect(bullConnection()).toMatchObject({
      url: 'redis://:s3cret@redis.internal:6380/4',
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  });

  it('parses a username and password pair', () => {
    process.env.REDIS_URL = 'redis://erp:secret@redis.internal:6379';
    expect(redisTarget()).toMatchObject({ username: 'erp', password: 'secret' });
  });

  it('enables TLS for rediss URLs', () => {
    process.env.REDIS_URL = 'rediss://redis.internal:6380';
    expect(redisTarget()?.tls).toEqual({ servername: 'redis.internal' });
  });

  it('falls back to discrete host and port variables', () => {
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = '6381';
    process.env.REDIS_PASSWORD = 'pw';

    expect(redisTarget()).toMatchObject({ host: '127.0.0.1', port: 6381, password: 'pw' });
    expect(redisTarget()?.url).toBeUndefined();
    expect(bullConnection()).toMatchObject({
      host: '127.0.0.1',
      port: 6381,
      password: 'pw',
      maxRetriesPerRequest: null,
    });
  });

  it('ignores a URL that is not a redis scheme', () => {
    process.env.REDIS_URL = 'postgres://user:pw@localhost:5432/db';
    expect(redisTarget()).toBeNull();
  });

  it('lets QUEUE_ENABLED=false override a configured broker', () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    process.env.QUEUE_ENABLED = 'false';

    expect(redisTarget()).toBeNull();
    expect(isQueueEnabled()).toBe(false);
  });

  it('never leaks the password into the boot description', () => {
    process.env.REDIS_URL = 'redis://:sup3rs3cret@redis.internal:6380/2';
    const description = describeQueueConnection();

    expect(description).not.toContain('sup3rs3cret');
    expect(description).toContain('redis://redis.internal:6380/2');
    expect(description).toContain('auth');
  });
});

describe('dispatcher without a broker', () => {
  it('degrades to a no-op instead of throwing', async () => {
    // The serverless target has no Redis; the API must still boot and serve.
    expect(taskQueue()).toBeNull();
    await expect(installScheduledTasks()).resolves.toEqual([]);
    await expect(removeScheduledTasks()).resolves.toBe(0);
    await expect(queueSnapshot()).resolves.toBeNull();
    await expect(closeTaskQueue()).resolves.toBeUndefined();
  });
});