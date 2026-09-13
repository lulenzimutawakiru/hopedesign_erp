import { WORKER_LOCKS } from '../singleFlight.js';

/**
 * The single queue every periodic task flows through.
 *
 * One queue (rather than one per task) keeps Redis key count and the number of
 * blocking connections small, which matters on the 1 vCPU production box. Tasks
 * stay isolated from each other because BullMQ only honours one concurrency
 * slot per job name here - the handlers are fast and coalescing, so serialising
 * them costs nothing and avoids piling parallel load on Postgres.
 */
export const QUEUE_NAME = 'hopedesign-scheduled-tasks';

/** Redis key the worker refreshes to prove it is alive and consuming. */
export const WORKER_HEARTBEAT_KEY = 'hopedesign:worker:heartbeat';

/** Heartbeat expiry. Three missed beats (interval below) marks the worker stale. */
export const WORKER_HEARTBEAT_TTL_SECONDS = 90;

/** How often the worker rewrites the heartbeat key. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;

export interface ScheduledTask {
  /** Job name, job-scheduler id, and handler key - one identifier for all three. */
  id: string;
  label: string;
  /** Repeat interval in milliseconds. */
  everyMs: number;
  /**
   * Shift the schedule off the wall-clock multiple of `everyMs`. Two tasks on
   * the same interval would otherwise fire in the same millisecond and hand the
   * box a burst of concurrent database work.
   */
  offsetMs?: number;
  /**
   * Postgres advisory-lock key from `WORKER_LOCKS`.
   *
   * BullMQ already guarantees a single delivery per job, so this is defence in
   * depth: it also covers the API's fallback timers and any second worker
   * started by accident, both of which would otherwise duplicate the work.
   */
  lock: number;
}

/**
 * Every periodic task the worker runs. This list is the single source of truth:
 * the dispatcher registers one job scheduler per entry, and the worker resolves
 * the matching handler from `TASK_HANDLERS` by the same `id`.
 */
export const SCHEDULED_TASKS: readonly ScheduledTask[] = [
  {
    id: 'report-scheduler',
    label: 'Report schedules',
    everyMs: 60_000,
    lock: WORKER_LOCKS.REPORT_SCHEDULER,
  },
  {
    id: 'cron-jobs',
    label: 'Cron jobs',
    everyMs: 60_000,
    // Shares the 60s cadence with the report scheduler; half a period of offset
    // keeps the two from waking up together.
    offsetMs: 30_000,
    lock: WORKER_LOCKS.CRON_JOBS,
  },
  {
    id: 'hikvision-queue',
    label: 'Hikvision event queue',
    everyMs: 10_000,
    lock: WORKER_LOCKS.HIKVISION_QUEUE,
  },
  {
    id: 'efris-worker',
    label: 'EFRIS fiscalization queue',
    everyMs: 20_000,
    lock: WORKER_LOCKS.EFRIS_WORKER,
  },
  {
    id: 'notification-dispatch',
    label: 'Notification delivery',
    everyMs: 15_000,
    lock: WORKER_LOCKS.NOTIFICATION_DISPATCH,
  },
];

export const SCHEDULED_TASK_IDS: readonly string[] = SCHEDULED_TASKS.map((task) => task.id);

export function getScheduledTask(id: string): ScheduledTask | undefined {
  return SCHEDULED_TASKS.find((task) => task.id === id);
}