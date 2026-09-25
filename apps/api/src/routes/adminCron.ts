import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { asyncHandler, badRequest, notFound, parsePagination, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from '../services/audit.js';
import { nextRunAtFor, runCronJobById, toCronJobRow } from '../services/cronJobs.js';

export const adminCronRouter = Router();

type QueryFn = (client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;
const runGet = (permission: string | string[], fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

// ---------------------------------------------------------------------------
// Cron job administration
// ---------------------------------------------------------------------------

// GET /api/admin/cron/jobs — list jobs with their most recent run
adminCronRouter.get(
  '/jobs',
  ...runGet('system.cron.view', async (c, ctx, q) => {
    const { pageSize, offset } = parsePagination(q);
    const { rows } = await c.query(
      `SELECT j.*, r.status AS run_status, r.finished_at AS run_finished_at,
              r.error AS run_error, r.duration_ms AS run_duration_ms
         FROM cron_jobs j
         LEFT JOIN LATERAL (
           SELECT status, finished_at, error, duration_ms
             FROM cron_job_runs
            WHERE job_id = j.id
            ORDER BY id DESC
            LIMIT 1
         ) r ON true
        WHERE j.tenant_id = $1
        ORDER BY j.code
        LIMIT $2 OFFSET $3`,
      [ctx.tenantId, pageSize, offset]
    );
    const total = await c.query('SELECT count(*)::int AS n FROM cron_jobs WHERE tenant_id = $1', [ctx.tenantId]);
    return { items: toCamelRows(rows as Record<string, unknown>[]).map(presentJob), total: Number(total.rows[0].n) };
  })
);

// GET /api/admin/cron/jobs/:id/runs — run history for one job
adminCronRouter.get(
  '/jobs/:id/runs',
  ...runGet('system.cron.view', async (c, ctx, q, params) => {
    const id = Number(params.id);
    const job = await c.query('SELECT id FROM cron_jobs WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
    if (job.rows.length === 0) throw notFound('Cron job not found');
    const { pageSize, offset } = parsePagination(q);
    const { rows } = await c.query(
      `SELECT * FROM cron_job_runs
        WHERE job_id = $1 AND tenant_id = $2
        ORDER BY id DESC
        LIMIT $3 OFFSET $4`,
      [id, ctx.tenantId, pageSize, offset]
    );
    const total = await c.query(
      'SELECT count(*)::int AS n FROM cron_job_runs WHERE job_id = $1 AND tenant_id = $2',
      [id, ctx.tenantId]
    );
    return { items: toCamelRows(rows as Record<string, unknown>[]), total: Number(total.rows[0].n) };
  })
);

// POST /api/admin/cron/jobs/:id/run — trigger a job immediately
adminCronRouter.post(
  '/jobs/:id/run',
  requirePermission('system.cron.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const job = await tx(async (c) => {
      const r = await c.query('SELECT id, code, name FROM cron_jobs WHERE id = $1 AND tenant_id = $2', [id, req.ctx.tenantId]);
      if (r.rows.length === 0) throw notFound('Cron job not found');
      return r.rows[0] as { id: number; code: string; name: string };
    }, req.ctx);
    const outcome = await runCronJobById(id);
    if (!outcome.ok) throw new Error(outcome.error || 'Cron job run failed');
    await tx(async (c) => {
      await logAudit(c, req.ctx, {
        action: 'run_manual',
        resource: 'cron.job',
        recordId: id,
        recordCode: job.code,
        metadata: { manual: true, jobType: job.name },
      });
    }, req.ctx);
    res.json({ data: { ok: true, jobId: id, code: job.code } });
  })
);

// PATCH /api/admin/cron/jobs/:id — enable/disable or update scheduling
adminCronRouter.patch(
  '/jobs/:id',
  requirePermission('system.cron.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const out = await tx(async (c) => {
      const cur = await c.query('SELECT * FROM cron_jobs WHERE id = $1 AND tenant_id = $2', [id, ctxTenantId(req.ctx)]);
      if (cur.rows.length === 0) throw notFound('Cron job not found');
      const j = cur.rows[0] as Record<string, unknown>;
      const b = (req.body ?? {}) as Record<string, unknown>;
      const enabled = b.enabled !== undefined ? b.enabled === true || b.enabled === 'true' || b.enabled === 1 || b.enabled === '1' : Boolean(j.enabled);
      const name = b.name !== undefined ? String(b.name).trim() : String(j.name);
      const description = b.description !== undefined ? String(b.description) : j.description === null ? null : String(j.description);
      const scheduleType = b.scheduleType !== undefined ? String(b.scheduleType).toUpperCase() : String(j.schedule_type);
      if (!SCHEDULE_TYPES.includes(scheduleType)) {
        throw badRequest(`scheduleType must be one of ${SCHEDULE_TYPES.join(', ')}`);
      }
      const prevTimezone = String(j.timezone ?? DEFAULT_TIMEZONE);
      const timezone = b.timezone !== undefined ? String(b.timezone).trim() : prevTimezone;
      if (!isKnownTimezone(timezone)) throw badRequest(`Unknown time zone: ${timezone}`);
      // run_time is stored on the server clock, and the containers run in UTC
      // (see 0186). This route is the time-zone boundary: it reads and writes
      // the wall clock the administrator actually sees, in the job's own zone.
      // A field absent from the body keeps its stored value; an explicit null
      // clears it. That lets a client post the whole schedule it wants without
      // having to know which fields the chosen schedule type ignores.
      const clears = (v: unknown) => v === null || v === '';
      const statedTime = b.runTime === undefined
        ? j.run_time === null || j.run_time === undefined
          ? null
          : utcTimeToLocal(String(j.run_time).slice(0, 5), prevTimezone)
        : clears(b.runTime)
          ? null
          : String(b.runTime).slice(0, 5);
      if (statedTime !== null && !TIME_OF_DAY.test(statedTime)) {
        throw badRequest('runTime must be HH:MM (24-hour)');
      }
      if (statedTime === null && TIME_BASED_SCHEDULES.includes(scheduleType)) {
        throw badRequest('runTime is required for a daily, weekly or monthly schedule');
      }
      const runTime = statedTime === null ? null : localTimeToUtc(statedTime, timezone);
      const dayOfWeek = b.dayOfWeek === undefined
        ? j.day_of_week === null || j.day_of_week === undefined ? null : Number(j.day_of_week)
        : clears(b.dayOfWeek) ? null : Number(b.dayOfWeek);
      const dayOfMonth = b.dayOfMonth === undefined
        ? j.day_of_month === null || j.day_of_month === undefined ? null : Number(j.day_of_month)
        : clears(b.dayOfMonth) ? null : Number(b.dayOfMonth);
      const intervalMinutes = b.intervalMinutes === undefined
        ? j.interval_minutes === null ? null : Number(j.interval_minutes)
        : clears(b.intervalMinutes) ? null : Number(b.intervalMinutes);
      if (dayOfWeek !== null && (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7)) {
        throw badRequest('dayOfWeek must be 1-7, where 1 is Monday');
      }
      if (dayOfMonth !== null && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)) {
        throw badRequest('dayOfMonth must be 1-31');
      }
      if (intervalMinutes !== null && (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0)) {
        throw badRequest('intervalMinutes must be greater than zero');
      }
      if (scheduleType === 'WEEKLY' && dayOfWeek === null) {
        throw badRequest('A weekly job needs dayOfWeek (1 = Monday .. 7 = Sunday)');
      }
      if (scheduleType === 'MONTHLY' && dayOfMonth === null) {
        throw badRequest('A monthly job needs dayOfMonth (1-31)');
      }
      // Only the fields that the chosen schedule actually reads are stored, so
      // a job cannot carry a day-of-week that its schedule type ignores.
      const keptDayOfWeek = scheduleType === 'WEEKLY' ? dayOfWeek : null;
      const keptDayOfMonth = scheduleType === 'MONTHLY' ? dayOfMonth : null;
      const keptInterval = scheduleType === 'INTERVAL' ? intervalMinutes : null;
      const params = b.params !== undefined && typeof b.params === 'object' ? b.params : j.params;
      const pinnedNextRun = b.nextRunAt === undefined || b.nextRunAt === null ? null : String(b.nextRunAt);
      let nextRunAt = pinnedNextRun ?? (j.next_run_at === null ? null : String(j.next_run_at));
      if (pinnedNextRun === null) {
        const stale = nextRunAt === null || new Date(nextRunAt).getTime() <= Date.now();
        const rescheduled = b.scheduleType !== undefined || b.runTime !== undefined || b.timezone !== undefined
          || b.dayOfWeek !== undefined || b.dayOfMonth !== undefined || b.intervalMinutes !== undefined;
        // Reschedule when the schedule moved, and skip the catch-up burst when a
        // stale job is switched back on (the same choice reports make on enable).
        if (rescheduled || (enabled && !Boolean(j.enabled) && stale)) {
          nextRunAt = nextRunAtFor(
            toCronJobRow({
              id,
              tenant_id: ctxTenantId(req.ctx),
              code: j.code,
              job_type: j.job_type,
              schedule_type: scheduleType,
              run_time: runTime,
              day_of_week: keptDayOfWeek,
              day_of_month: keptDayOfMonth,
              interval_minutes: keptInterval,
              params,
              timezone,
            }),
            new Date()
          ).toISOString();
        }
      }
      await c.query(
        `UPDATE cron_jobs
            SET name = $1, description = $2, enabled = $3, schedule_type = $4,
                run_time = $5, interval_minutes = $6, params = $7::jsonb,
                next_run_at = $8, day_of_week = $9, day_of_month = $10,
                timezone = $11, updated_at = now()
          WHERE id = $12 AND tenant_id = $13`,
        [name, description, enabled, scheduleType, runTime, keptInterval, JSON.stringify(params ?? {}),
         nextRunAt, keptDayOfWeek, keptDayOfMonth, timezone, id, ctxTenantId(req.ctx)]
      );
      const up = await c.query('SELECT * FROM cron_jobs WHERE id = $1', [id]);
      await logAudit(c, req.ctx, {
        action: 'update',
        resource: 'cron.job',
        recordId: id,
        recordCode: String(j.code),
        metadata: { changed: Object.keys(b) },
      });
      return presentJob(toCamelRow(up.rows[0] as Record<string, unknown>));
    }, req.ctx);
    res.json({ data: out });
  })
);

function ctxTenantId(ctx: Ctx): number {
  return ctx.tenantId ?? 0;
}

// ---------------------------------------------------------------------------
// Schedule configuration helpers
// ---------------------------------------------------------------------------

const SCHEDULE_TYPES = ['DAILY', 'WEEKLY', 'MONTHLY', 'INTERVAL', 'ONCE'];
/** Schedules that read run_time; INTERVAL counts forward from the last run. */
const TIME_BASED_SCHEDULES = ['DAILY', 'WEEKLY', 'MONTHLY', 'ONCE'];
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_TIMEZONE = 'Africa/Kampala';

/** A bad zone name makes Intl throw, so this swallows that and answers no. */
function isKnownTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(tz, f);
  }
  return f;
}

/**
 * Offset of `tz` from UTC, in minutes, at the instant `at`. Derived from Intl
 * rather than a date library so a new zone costs nothing to support.
 */
function zoneOffsetMinutes(tz: string, at: Date): number {
  const parts = zoneFormatter(tz).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second')
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** UTC instant used to resolve an offset; the date only matters in DST zones. */
function todayAt(hh: number, mm: number): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm);
}

/** Stored server-clock run_time -> the wall clock the administrator sees. */
function utcTimeToLocal(hhmm: string, tz: string): string {
  const [hh, mm] = hhmm.split(':').map(Number);
  const at = new Date(todayAt(hh, mm));
  const shifted = new Date(at.getTime() + zoneOffsetMinutes(tz, at) * 60_000);
  return `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
}

/**
 * Wall clock the administrator typed -> the server-clock value to store.
 * Two passes, because the offset being applied depends on the instant.
 */
function localTimeToUtc(hhmm: string, tz: string): string {
  const [hh, mm] = hhmm.split(':').map(Number);
  const naive = todayAt(hh, mm);
  let at = new Date(naive);
  for (let i = 0; i < 2; i++) at = new Date(naive - zoneOffsetMinutes(tz, at) * 60_000);
  return `${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())}`;
}

/**
 * Serialise a camelCase cron row for the admin UI, restating run_time in the
 * job's own zone. Storage stays on the server clock (see the TIME CONTRACT in
 * services/cronJobs.ts); the conversions here and in PATCH round-trip, so no
 * existing row changes meaning.
 */
function presentJob(row: Record<string, unknown>): Record<string, unknown> {
  const tz = String(row.timezone ?? DEFAULT_TIMEZONE);
  const raw = row.runTime;
  if (raw === null || raw === undefined) return row;
  const stored = String(raw).slice(0, 5);
  if (!TIME_OF_DAY.test(stored)) return row;
  const zone = isKnownTimezone(tz) ? tz : DEFAULT_TIMEZONE;
  return { ...row, runTime: utcTimeToLocal(stored, zone) };
}
