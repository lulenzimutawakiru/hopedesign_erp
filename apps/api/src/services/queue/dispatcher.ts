import { Queue, type JobSchedulerTemplateOptions, type RepeatOptions } from 'bullmq';
import { QUEUE_PREFIX, bullConnection, isQueueEnabled } from './connection.js';
import { QUEUE_NAME, SCHEDULED_TASKS, SCHEDULED_TASK_IDS } from './queues.js';

/**
 * Registers the periodic tasks with BullMQ as job schedulers.
 *
 * BullMQ's scheduler replaces the old `setInterval` loop: instead of a timer
 * living inside a web process, the schedule itself is stored in Redis and the
 * worker picks up each occurrence. That means the schedule is durable (it
 * survives restarts and redeploys), it is defined exactly once no matter how
 * many API replicas exist, and a missed occurrence is not silently skipped just
 * because the process that owned the timer was busy or restarting.
 *
 * This module deliberately imports only the connection and the task registry so
 * it stays cheap to import; it must never pull in the background services
 * themselves.
 */

/** Failed ticks are kept briefly so an operator can inspect them. */
const FAILED_JOB_HISTORY = 100;

/**
 * Transient failures (a dropped database connection, a lock timeout) are retried
 * once after a short backoff rather than waiting a whole interval - the main
 * latency win over the previous timer implementation.
 */
const ATTEMPTS = 2;
const BACKOFF_DELAY_MS = 5_000;

export interface SchedulerSpec {
  id: string;
  repeat: Omit<RepeatOptions, 'key'>;
  template: { name: string; opts: JobSchedulerTemplateOptions };
}

/**
 * Pure description of what will be registered. Kept separate from the Redis
 * calls so the schedule can be asserted in tests without a broker.
 */
export function schedulerSpecs(): SchedulerSpec[] {
  return SCHEDULED_TASKS.map((task) => ({
    id: task.id,
    repeat: {
      every: task.everyMs,
      ...(task.offsetMs === undefined ? {} : { offset: task.offsetMs }),
    },
    template: {
      name: task.id,
      opts: {
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
        removeOnComplete: true,
        removeOnFail: { count: FAILED_JOB_HISTORY },
      },
    },
  }));
}

let queue: Queue | null = null;

/**
 * The shared BullMQ queue handle, or `null` when no broker is configured.
 * Created lazily so module import never opens a socket.
 */
export function taskQueue(): Queue | null {
  if (!isQueueEnabled()) return null;
  if (queue) return queue;

  const connection = bullConnection();
  if (!connection) return null;

  queue = new Queue(QUEUE_NAME, { connection, prefix: QUEUE_PREFIX });
  // A queue failure must never crash the API process; BullMQ emits `error` on
  // every reconnect attempt and an unhandled emitter error is fatal in Node.
  queue.on('error', (err: Error) => {
    console.error('[queue] connection error', err.message);
  });
  return queue;
}

/**
 * Create or update every job scheduler. Idempotent: BullMQ upserts by id, so
 * running this on every boot is safe and keeps interval changes in code as the
 * source of truth.
 */
export async function installScheduledTasks(): Promise<string[]> {
  const target = taskQueue();
  if (!target) return [];

  const installed: string[] = [];
  for (const spec of schedulerSpecs()) {
    await target.upsertJobScheduler(spec.id, spec.repeat, spec.template);
    installed.push(spec.id);
  }
  return installed;
}

/** Remove job schedulers. Pass no ids to remove every task the ERP owns. */
export async function removeScheduledTasks(ids: readonly string[] = SCHEDULED_TASK_IDS): Promise<number> {
  const target = taskQueue();
  if (!target) return 0;

  let removed = 0;
  for (const id of ids) {
    if (await target.removeJobScheduler(id)) removed += 1;
  }
  return removed;
}

export interface QueueSnapshot {
  counts: Record<string, number>;
  schedulers: { id: string; every?: number; pattern?: string; next?: number }[];
}

/** Counts and registered schedules, for boot logs and diagnostics. */
export async function queueSnapshot(): Promise<QueueSnapshot | null> {
  const target = taskQueue();
  if (!target) return null;

  const [counts, schedulers] = await Promise.all([
    target.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
    target.getJobSchedulers(),
  ]);

  return {
    counts,
    schedulers: schedulers.map((entry) => ({
      id: entry.key,
      ...(entry.every === undefined ? {} : { every: entry.every }),
      ...(entry.pattern === undefined ? {} : { pattern: entry.pattern }),
      ...(entry.next === undefined ? {} : { next: entry.next }),
    })),
  };
}

/** Close the producer connection. Safe to call when the queue is disabled. */
export async function closeTaskQueue(): Promise<void> {
  const target = queue;
  queue = null;
  if (target) await target.close();
}