import 'dotenv/config';
import http from 'node:http';
import os from 'node:os';
import IORedis from 'ioredis';
import { Worker, type Job } from 'bullmq';
import { QUEUE_PREFIX, bullConnection, controlClientOptions, describeQueueConnection, isQueueEnabled } from './services/queue/connection.js';
import {
  QUEUE_NAME,
  SCHEDULED_TASK_IDS,
  SCHEDULED_TASKS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
  getScheduledTask,
} from './services/queue/queues.js';
import { TASK_HANDLERS } from './services/queue/jobs.js';
import { installScheduledTasks, queueSnapshot } from './services/queue/dispatcher.js';
import { tryAcquireWorkerLock } from './services/singleFlight.js';
import { pool } from './db.js';

/**
 * Background worker process.
 *
 * This is the piece that replaces the `setInterval` timers that used to live in
 * the Express process. It runs as its own container, consumes the BullMQ queue,
 * and is the only thing that executes periodic work - so an API restart or a
 * blue/green rollout no longer interrupts a tick, and the API replicas no longer
 * each burn CPU re-checking the same schedules.
 *
 * Run directly with: node apps/api/dist/worker.js
 */

/**
 * Handlers include report generation and cron fan-out, which can outlast the
 * 30s BullMQ default. A job whose lock expires while it is still running is
 * treated as stalled and re-delivered, so the lock has to sit comfortably above
 * the slowest realistic tick.
 */
const LOCK_DURATION_MS = 180_000;
const MAX_STALLED_COUNT = 2;

/**
 * Two slots so a slow 60s report tick cannot starve the 10s Hikvision drain.
 * The per-task advisory locks still serialise each task against itself.
 */
const CONCURRENCY = 2;

const HEALTH_HOST = process.env.WORKER_HEALTH_HOST || '0.0.0.0';
const HEALTH_PORT = Number.parseInt(process.env.WORKER_HEALTH_PORT || '4100', 10);

interface RunRecord {
  at: string;
  ms: number;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  counts?: Record<string, number>;
}

const startedAt = new Date().toISOString();
const taskState = new Map<string, RunRecord>();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Keep only the counters the handlers actually return, so job payloads stay tiny. */
function summarise(result: unknown): Record<string, number> | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const source = result as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const key of ['processed', 'ok', 'failed']) {
    const value = source[key];
    if (typeof value === 'number') counts[key] = value;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

/**
 * Execute one scheduled task.
 *
 * `tryAcquireWorkerLock` is belt-and-braces on top of BullMQ's own delivery
 * guarantee: it also fences off the API's in-process fallback timers, should
 * anyone ever run them alongside this worker.
 */
async function runTask(job: Job): Promise<Record<string, unknown>> {
  const task = getScheduledTask(job.name);
  const handler = TASK_HANDLERS[job.name];
  if (!task || !handler) {
    throw new Error(`no handler registered for task "${job.name}"`);
  }

  const startedTick = Date.now();
  const release = await tryAcquireWorkerLock(task.lock);
  if (!release) {
    taskState.set(task.id, { at: new Date().toISOString(), ms: 0, ok: true, skipped: true });
    return { task: task.id, skipped: true, reason: 'advisory lock held elsewhere' };
  }

  try {
    const result = await handler();
    const ms = Date.now() - startedTick;
    const counts = summarise(result);
    taskState.set(task.id, { at: new Date().toISOString(), ms, ok: true, counts });
    console.log(`[worker] ${task.id} ok in ${ms}ms${counts ? ' ' + JSON.stringify(counts) : ''}`);
    return { task: task.id, ms, ...(counts ?? {}) };
  } catch (err) {
    const ms = Date.now() - startedTick;
    taskState.set(task.id, { at: new Date().toISOString(), ms, ok: false, error: errorMessage(err) });
    // Rethrow so BullMQ records the failure, applies the retry policy and keeps
    // the tick visible in the failed set.
    throw err;
  } finally {
    await release();
  }
}

function heartbeatPayload(): string {
  return JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    queue: QUEUE_NAME,
    startedAt,
    lastBeatAt: new Date().toISOString(),
    tasks: Object.fromEntries(taskState),
  });
}

/**
 * Resolve once the control client reports `ready`, or reject after `timeoutMs`.
 *
 * ioredis opens its socket asynchronously and `controlClientOptions()` disables
 * the offline queue. Together those mean a command issued immediately after
 * construction is rejected outright - "Stream isn't writeable and
 * enableOfflineQueue options is false" - instead of being buffered until the
 * handshake completes. The readiness probe therefore has to wait for `ready`
 * rather than race it.
 *
 * Deliberately not fatal on an `error` event: ioredis emits one per failed
 * reconnect attempt, so treating the first as fatal would turn a momentary blip
 * during boot into a restart loop. The timeout is the real gate.
 */
function waitForReady(client: IORedis, timeoutMs = 15_000): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      reject(new Error(`redis not ready after ${timeoutMs}ms (status: ${client.status})`));
    }, timeoutMs);

    client.once('ready', onReady);
  });
}
async function main(): Promise<void> {
  if (!isQueueEnabled()) {
    console.error('[worker] no queue configured - refusing to start idle');
    console.error('[worker] set REDIS_URL (or REDIS_HOST/REDIS_PORT) and restart');
    process.exit(1);
  }

  const missing = SCHEDULED_TASK_IDS.filter((id) => !TASK_HANDLERS[id]);
  if (missing.length > 0) {
    console.error(`[worker] tasks without a handler: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log(`[worker] starting ${JSON.stringify({ node: process.version, pid: process.pid, queue: QUEUE_NAME, connection: describeQueueConnection() })}`);

  // Control connection for the liveness heartbeat. `controlClientOptions()`
  // disables the offline queue, so a command rejects immediately instead of
  // buffering when Redis is unreachable and the health endpoint reports the
  // outage rather than hanging.
  const controlOptions = controlClientOptions();
  if (!controlOptions) {
    console.error('[worker] queue configuration disappeared during boot');
    process.exit(1);
  }
  const control = new IORedis(controlOptions);
  control.on('error', (err: Error) => console.error('[worker] redis error', err.message));

  await waitForReady(control);
  await control.ping();
  console.log('[worker] redis reachable');

  const connection = bullConnection();
  if (!connection) {
    console.error('[worker] queue connection became unavailable');
    process.exit(1);
  }

  const installed = await installScheduledTasks();
  console.log(`[worker] schedulers registered: ${installed.join(', ')}`);

  const worker = new Worker(QUEUE_NAME, runTask, {
    connection,
    prefix: QUEUE_PREFIX,
    concurrency: CONCURRENCY,
    lockDuration: LOCK_DURATION_MS,
    maxStalledCount: MAX_STALLED_COUNT,
  });

  worker.on('failed', (job, err) => {
    console.error(`[worker] ${job?.name ?? 'unknown'} failed (attempt ${job?.attemptsMade ?? 0})`, err.message);
  });
  worker.on('error', (err) => console.error('[worker] error', err.message));
  worker.on('stalled', (jobId) => console.warn(`[worker] job stalled: ${jobId}`));

  await worker.waitUntilReady();
  console.log(`[worker] consuming "${QUEUE_NAME}" (concurrency ${CONCURRENCY})`);

  const snapshot = await queueSnapshot();
  if (snapshot) console.log(`[worker] queue state ${JSON.stringify(snapshot.counts)}`);

  const beat = async (): Promise<void> => {
    try {
      await control.set(WORKER_HEARTBEAT_KEY, heartbeatPayload(), 'EX', WORKER_HEARTBEAT_TTL_SECONDS);
    } catch (err) {
      console.error('[worker] heartbeat failed', errorMessage(err));
    }
  };
  await beat();
  const beatTimer = setInterval(() => void beat(), WORKER_HEARTBEAT_INTERVAL_MS);
  beatTimer.unref();

  const health = http.createServer((req, res) => {
    if (req.url !== '/health' && req.url !== '/') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const healthy = control.status === 'ready' && worker.isRunning();
    const body = JSON.stringify({
      status: healthy ? 'ok' : 'degraded',
      redis: control.status,
      consuming: worker.isRunning(),
      startedAt,
      tasks: Object.fromEntries(taskState),
    });
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(body);
  });
  health.listen(HEALTH_PORT, HEALTH_HOST, () => {
    console.log(`[worker] health on http://${HEALTH_HOST}:${HEALTH_PORT}/health`);
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} received - draining`);

    // Stop accepting new occurrences, then let the in-flight tick finish.
    clearInterval(beatTimer);
    try {
      await worker.close();
      await control.del(WORKER_HEARTBEAT_KEY);
    } catch (err) {
      console.error('[worker] shutdown warning', errorMessage(err));
    }
    health.close();

    const { closeTaskQueue } = await import('./services/queue/dispatcher.js');
    await closeTaskQueue().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A worker that has lost its invariants should restart, not limp along.
  process.on('unhandledRejection', (reason) => {
    console.error('[worker] unhandled rejection', errorMessage(reason));
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    console.error('[worker] uncaught exception', err);
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  console.error('[worker] failed to start', err);
  process.exit(1);
});