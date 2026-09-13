import { runDueReportSchedules } from '../reportScheduler.js';
import { runDueCronJobs } from '../cronJobs.js';
import { processNotificationDeliveries } from '../communication.js';
import { runHikvisionWorkerTick } from '../hikvision/processor.js';
import { runEfrisWorkerTick } from '../efris/processor.js';

/**
 * Task id -> handler. This module pulls in the five background services and
 * nothing else, which is what lets the worker process import its work without
 * dragging in the Express route graph (and with it every router, middleware and
 * boot-time environment gate).
 *
 * The three queue-draining handlers keep their original error behaviour: the
 * Hikvision and EFRIS ticks swallow their own errors because their retry policy
 * lives in SQL (`attempts` / `next_attempt_at`), so a thrown error here would
 * cause BullMQ to retry work the database is already retrying. The report,
 * cron and notification handlers propagate failures for the worker to log.
 */
export type TaskHandler = () => Promise<unknown>;

export const TASK_HANDLERS: Readonly<Record<string, TaskHandler>> = {
  'report-scheduler': runDueReportSchedules,
  'cron-jobs': runDueCronJobs,
  'notification-dispatch': processNotificationDeliveries,
  'hikvision-queue': runHikvisionWorkerTick,
  'efris-worker': runEfrisWorkerTick,
};