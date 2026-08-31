import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { asyncHandler, notFound, parsePagination, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from '../services/audit.js';
import { runCronJobById } from '../services/cronJobs.js';

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
    return { items: toCamelRows(rows as Record<string, unknown>[]), total: Number(total.rows[0].n) };
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
      const runTime = b.runTime !== undefined ? String(b.runTime).slice(0, 5) : j.run_time === null ? null : String(j.run_time);
      const intervalMinutes = b.intervalMinutes !== undefined ? Number(b.intervalMinutes) : j.interval_minutes === null ? null : Number(j.interval_minutes);
      const params = b.params !== undefined && typeof b.params === 'object' ? b.params : j.params;
      const nextRunAt = b.nextRunAt ? String(b.nextRunAt) : j.next_run_at === null ? null : String(j.next_run_at);
      await c.query(
        `UPDATE cron_jobs
            SET name = $1, description = $2, enabled = $3, schedule_type = $4,
                run_time = $5, interval_minutes = $6, params = $7::jsonb,
                next_run_at = $8, updated_at = now()
          WHERE id = $9 AND tenant_id = $10`,
        [name, description, enabled, scheduleType, runTime, intervalMinutes, JSON.stringify(params ?? {}), nextRunAt, id, ctxTenantId(req.ctx)]
      );
      const up = await c.query('SELECT * FROM cron_jobs WHERE id = $1', [id]);
      await logAudit(c, req.ctx, {
        action: 'update',
        resource: 'cron.job',
        recordId: id,
        recordCode: String(j.code),
        metadata: { changed: Object.keys(b) },
      });
      return toCamelRow(up.rows[0] as Record<string, unknown>);
    }, req.ctx);
    res.json({ data: out });
  })
);

function ctxTenantId(ctx: Ctx): number {
  return ctx.tenantId ?? 0;
}
