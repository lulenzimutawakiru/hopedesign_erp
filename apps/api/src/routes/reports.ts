import { Router } from 'express';
import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import { query, tx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { asyncHandler, badRequest, notFound, forbidden, toCamelRow, parsePagination } from '../utils.js';
import { logAudit } from '../services/audit.js';
import {
  applyExcelBrandHeader,
  companyContactLines,
  companyRegLines,
  documentVerifyUrl,
  formatDocDateTime,
  issueDocumentToken,
  loadCompanyProfile,
  renderBrandedHtml,
  reportFingerprint,
} from '../services/branding.js';
import { renderTablePdf } from '../services/brandedExport.js';
import {
  REPORTS,
  buildWhere,
  columnsOf,
  reportDef,
  sanitizeFilters,
  summableColumns,
} from '../services/reportCore.js';
import {
  computeNextRun,
  runDueReportSchedules,
  runScheduleRecord,
  toScheduleRow,
} from '../services/reportScheduler.js';
import { reportAnalyticsRouter } from './analytics.js';

export const reportsRouter = Router();
reportsRouter.use(reportAnalyticsRouter);
function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const issuerName = (req: { auth?: { email?: string; first_name?: string; last_name?: string } | null }): string => {
  const email = req.auth?.email ?? 'unknown';
  const name = [req.auth?.first_name, req.auth?.last_name].filter(Boolean).join(' ');
  return name || email;
};


/** Report-specific permission gate shared by every report endpoint. */
function assertReportAccess(req: import('express').Request, def: { permission: string }): void {
  const perms = req.auth!.permissions;
  const ok = perms.includes(def.permission) || perms.includes('reports.*') || perms.includes('system.admin.all');
  if (!ok) throw forbidden(`Missing permission: ${def.permission}`);
}


reportsRouter.get(
  '/:name/summary',
  requirePermission('reports.dashboards.view'),
  asyncHandler(async (req, res) => {
    const def = reportDef(String(req.params.name).toLowerCase());
    if (!def) throw notFound('Report not found');
    assertReportAccess(req, def);
    const cols = await columnsOf(def.table);
    const filters = await sanitizeFilters(def, req.query);
    const companyId = cols.includes('company_id') ? (req.ctx.companyId ?? req.auth!.company_id) : null;
    const { where, params } = buildWhere(cols, filters, companyId);
    const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sums = summableColumns(cols);
    const sumSql = sums.map((c, i) => `COALESCE(sum("${c}"),0)::numeric(18,2) AS "s${i}"`).join(', ');
    const dateCol = cols.find((c) => /_at$|_date$|^month$|^period/.test(c)) ?? null;
    const rangeSql = dateCol ? `, min("${dateCol}") AS min_dt, max("${dateCol}") AS max_dt` : '';
    const resq = await query(
      `SELECT count(*)::int AS total${sumSql ? ', ' + sumSql : ''}${rangeSql} FROM ${def.table} ${wsql}`,
      params,
      req.ctx
    );
    const row = resq.rows[0] ?? {};
    const sumsOut = sums.map((c, i) => {
      const v = row[`s${i}`];
      return { column: c, value: v === null || v === undefined ? null : Number(v) };
    });
    res.json({
      data: {
        total: Number(row.total ?? 0),
        sums: sumsOut,
        dateRange: dateCol ? { column: dateCol, min: row.min_dt ?? null, max: row.max_dt ?? null } : null,
      },
    });
  })
);

reportsRouter.get(
  '/saved-views',
  requirePermission('reports.saved.view'),
  asyncHandler(async (req, res) => {
    const { pageSize, offset } = parsePagination(req.query);
    const reportName = req.query.report ? String(req.query.report).toLowerCase() : null;
    const params: unknown[] = [req.ctx.tenantId ?? -1, req.auth!.id, pageSize, offset];
    const reportFilter = reportName ? ' AND report_name = $5' : '';
    if (reportName) params.push(reportName);
    const r = await query(
      `SELECT id, name, report_name, filters, sort, is_default, created_at, updated_at
       FROM report_saved_views
       WHERE tenant_id = $1 AND user_id = $2 AND is_archived = false${reportFilter}
       ORDER BY updated_at DESC LIMIT $3 OFFSET $4`,
      params,
      req.ctx
    );
    res.json({ data: r.rows.map((row) => toCamelRow(row as unknown as Record<string, unknown>)) });
  })
);

reportsRouter.post(
  '/saved-views',
  requirePermission('reports.saved.create'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? '').trim();
    if (!name) throw badRequest('View name is required');
    const def = reportDef(String(body.report_name ?? ''));
    if (!def) throw badRequest('Unknown report');
    const filters = await sanitizeFilters(def, body.filters);
    const sort = body.sort && typeof body.sort === 'object' && !Array.isArray(body.sort) ? (body.sort as Record<string, unknown>) : {};
    const isDefault = body.is_default === true || body.is_default === 'true';
    const out = await tx(async (client) => {
      if (isDefault) {
        await client.query(
          `UPDATE report_saved_views SET is_default = false WHERE tenant_id = $1 AND user_id = $2 AND report_name = $3`,
          [req.ctx.tenantId ?? -1, req.auth!.id, def.name]
        );
      }
      const r = await client.query(
        `INSERT INTO report_saved_views (tenant_id, company_id, user_id, name, report_name, filters, sort, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, name, report_name, filters, sort, is_default, created_at, updated_at`,
        [req.ctx.tenantId ?? -1, req.ctx.companyId ?? null, req.auth!.id, name, def.name, JSON.stringify(filters), JSON.stringify(sort), isDefault]
      );
      await logAudit(client, req.ctx, {
        action: 'create',
        resource: 'report.saved_view',
        recordId: Number(r.rows[0].id),
        recordCode: name,
        newValues: { report: def.name, filters },
      });
      return toCamelRow(r.rows[0] as unknown as Record<string, unknown>);
    }, req.ctx);
    res.json({ data: out });
  })
);

reportsRouter.patch(
  '/saved-views/:id',
  requirePermission('reports.saved.update'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const out = await tx(async (client) => {
      const prev = await client.query(
        `SELECT id, name, report_name, filters, sort, is_default FROM report_saved_views
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND is_archived = false`,
        [id, req.ctx.tenantId ?? -1, req.auth!.id]
      );
      if (prev.rows.length === 0) throw notFound('Saved view not found');
      const def = reportDef(String(body.report_name ?? prev.rows[0].report_name));
      if (!def) throw badRequest('Unknown report');
      const name = body.name !== undefined ? String(body.name).trim() : String(prev.rows[0].name);
      if (!name) throw badRequest('View name is required');
      const filters = body.filters !== undefined ? await sanitizeFilters(def, body.filters) : (prev.rows[0].filters ?? {});
      const sort = body.sort !== undefined && body.sort && typeof body.sort === 'object' && !Array.isArray(body.sort)
        ? (body.sort as Record<string, unknown>)
        : (prev.rows[0].sort ?? {});
      const isDefault = body.is_default !== undefined ? body.is_default === true || body.is_default === 'true' : !!prev.rows[0].is_default;
      if (isDefault) {
        await client.query(
          `UPDATE report_saved_views SET is_default = false WHERE tenant_id = $1 AND user_id = $2 AND report_name = $3 AND id <> $4`,
          [req.ctx.tenantId ?? -1, req.auth!.id, def.name, id]
        );
      }
      const r = await client.query(
        `UPDATE report_saved_views SET name=$1, report_name=$2, filters=$3, sort=$4, is_default=$5, updated_at=now()
         WHERE id=$6 AND tenant_id=$7 AND user_id=$8 AND is_archived=false
         RETURNING id, name, report_name, filters, sort, is_default, created_at, updated_at`,
        [name, def.name, JSON.stringify(filters), JSON.stringify(sort), isDefault, id, req.ctx.tenantId ?? -1, req.auth!.id]
      );
      await logAudit(client, req.ctx, {
        action: 'update',
        resource: 'report.saved_view',
        recordId: id,
        recordCode: name,
        oldValues: { name: prev.rows[0].name, filters: prev.rows[0].filters },
        newValues: { name, filters },
      });
      return toCamelRow(r.rows[0] as unknown as Record<string, unknown>);
    }, req.ctx);
    res.json({ data: out });
  })
);

reportsRouter.delete(
  '/saved-views/:id',
  requirePermission('reports.saved.delete'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await tx(async (client) => {
      const r = await client.query(
        `UPDATE report_saved_views SET is_archived = true, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND is_archived = false RETURNING id, name`,
        [id, req.ctx.tenantId ?? -1, req.auth!.id]
      );
      if (r.rows.length === 0) throw notFound('Saved view not found');
      await logAudit(client, req.ctx, {
        action: 'archive',
        resource: 'report.saved_view',
        recordId: id,
        recordCode: String(r.rows[0].name),
      });
    }, req.ctx);
    res.json({ data: { ok: true } });
  })
);

reportsRouter.get(
  '/schedules',
  requirePermission('reports.saved.schedule'),
  asyncHandler(async (req, res) => {
    const { pageSize, offset } = parsePagination(req.query);
    const companyId = req.ctx.companyId ?? req.auth!.company_id ?? null;
    const r = await query(
      `SELECT id, name, report_name, filters, frequency, run_time, day_of_week, day_of_month,
              recipients, enabled, next_run_at, last_run_at, last_status, created_at, updated_at
       FROM report_schedules
       WHERE tenant_id = $1 AND is_archived = false AND ($2::bigint IS NULL OR company_id = $2)
       ORDER BY next_run_at LIMIT $3 OFFSET $4`,
      [req.ctx.tenantId ?? -1, companyId, pageSize, offset],
      req.ctx
    );
    res.json({ data: r.rows.map((row) => toScheduleRow(row as unknown as Record<string, unknown>)) });
  })
);

reportsRouter.post(
  '/schedules',
  requirePermission('reports.saved.schedule'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const def = reportDef(String(body.report_name ?? ''));
    if (!def) throw badRequest('Unknown report');
    const name = String(body.name ?? '').trim();
    if (!name) throw badRequest('Schedule name is required');
    const frequency = String(body.frequency ?? 'DAILY').toUpperCase();
    if (!['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) throw badRequest('Invalid frequency');
    const runTime = String(body.run_time ?? '08:00').slice(0, 5);
    if (!/^\d{2}:\d{2}$/.test(runTime)) throw badRequest('Invalid run time');
    const dayOfWeek = body.day_of_week === undefined || body.day_of_week === null || body.day_of_week === '' ? null : Number(body.day_of_week);
    const dayOfMonth = body.day_of_month === undefined || body.day_of_month === null || body.day_of_month === '' ? null : Number(body.day_of_month);
    if (dayOfWeek !== null && (dayOfWeek < 1 || dayOfWeek > 7)) throw badRequest('day_of_week must be 1-7');
    if (dayOfMonth !== null && (dayOfMonth < 1 || dayOfMonth > 31)) throw badRequest('day_of_month must be 1-31');
    const filters = await sanitizeFilters(def, body.filters);
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    const nextRun = computeNextRun(frequency, runTime, dayOfWeek, dayOfMonth, new Date()).toISOString();
    const out = await tx(async (client) => {
      const r = await client.query(
        `INSERT INTO report_schedules
          (tenant_id, company_id, created_by, name, report_name, filters, frequency, run_time, day_of_week, day_of_month, recipients, enabled, next_run_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12)
         RETURNING id, name, report_name, filters, frequency, run_time, day_of_week, day_of_month, recipients, enabled, next_run_at, last_run_at, last_status, created_at, updated_at`,
        [req.ctx.tenantId ?? -1, req.ctx.companyId ?? null, req.auth!.id, name, def.name, JSON.stringify(filters), frequency, runTime, dayOfWeek, dayOfMonth, JSON.stringify(recipients), nextRun]
      );
      await logAudit(client, req.ctx, {
        action: 'create',
        resource: 'report.schedule',
        recordId: Number(r.rows[0].id),
        recordCode: name,
        newValues: { report: def.name, frequency, runTime, recipients: recipients.length, nextRun },
      });
      return toScheduleRow(r.rows[0] as unknown as Record<string, unknown>);
    }, req.ctx);
    res.json({ data: out });
  })
);

reportsRouter.patch(
  '/schedules/:id',
  requirePermission('reports.saved.schedule'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const out = await tx(async (client) => {
      const prevRes = await client.query(
        `SELECT * FROM report_schedules WHERE id = $1 AND tenant_id = $2 AND is_archived = false`,
        [id, req.ctx.tenantId ?? -1]
      );
      if (prevRes.rows.length === 0) throw notFound('Schedule not found');
      const prev = prevRes.rows[0] as unknown as Record<string, unknown>;
      const def = reportDef(String(body.report_name ?? prev.report_name));
      if (!def) throw badRequest('Unknown report');
      const name = body.name !== undefined && body.name !== '' ? String(body.name).trim() : String(prev.name);
      const frequency = body.frequency !== undefined ? String(body.frequency).toUpperCase() : String(prev.frequency);
      if (!['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) throw badRequest('Invalid frequency');
      const runTime = body.run_time !== undefined ? String(body.run_time).slice(0, 5) : String(prev.run_time).slice(0, 5);
      if (!/^\d{2}:\d{2}$/.test(runTime)) throw badRequest('Invalid run time');
      const dayOfWeek = body.day_of_week !== undefined && body.day_of_week !== null && body.day_of_week !== ''
        ? Number(body.day_of_week)
        : prev.day_of_week === null ? null : Number(prev.day_of_week);
      const dayOfMonth = body.day_of_month !== undefined && body.day_of_month !== null && body.day_of_month !== ''
        ? Number(body.day_of_month)
        : prev.day_of_month === null ? null : Number(prev.day_of_month);
      const filters = body.filters !== undefined ? await sanitizeFilters(def, body.filters) : (prev.filters ?? {});
      const recipients = body.recipients !== undefined ? (Array.isArray(body.recipients) ? body.recipients : []) : (prev.recipients ?? []);
      const enabled = body.enabled !== undefined ? body.enabled === true || body.enabled === 'true' : !!prev.enabled;
      const nextRun = computeNextRun(frequency, runTime, dayOfWeek, dayOfMonth, new Date()).toISOString();
      const r = await client.query(
        `UPDATE report_schedules SET name=$1, report_name=$2, filters=$3, frequency=$4, run_time=$5,
                day_of_week=$6, day_of_month=$7, recipients=$8, enabled=$9, next_run_at=$10, updated_at=now()
         WHERE id=$11 AND tenant_id=$12 AND is_archived=false
         RETURNING id, name, report_name, filters, frequency, run_time, day_of_week, day_of_month, recipients, enabled, next_run_at, last_run_at, last_status, created_at, updated_at`,
        [name, def.name, JSON.stringify(filters), frequency, runTime, dayOfWeek, dayOfMonth, JSON.stringify(recipients), enabled, nextRun, id, req.ctx.tenantId ?? -1]
      );
      await logAudit(client, req.ctx, {
        action: 'update',
        resource: 'report.schedule',
        recordId: id,
        recordCode: name,
        oldValues: { frequency: prev.frequency, runTime: prev.run_time },
        newValues: { frequency, runTime, enabled },
      });
      return toScheduleRow(r.rows[0] as unknown as Record<string, unknown>);
    }, req.ctx);
    res.json({ data: out });
  })
);

reportsRouter.delete(
  '/schedules/:id',
  requirePermission('reports.saved.schedule'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await tx(async (client) => {
      const r = await client.query(
        `UPDATE report_schedules SET is_archived = true, enabled = false, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND is_archived = false RETURNING id, name`,
        [id, req.ctx.tenantId ?? -1]
      );
      if (r.rows.length === 0) throw notFound('Schedule not found');
      await logAudit(client, req.ctx, {
        action: 'archive',
        resource: 'report.schedule',
        recordId: id,
        recordCode: String(r.rows[0].name),
      });
    }, req.ctx);
    res.json({ data: { ok: true } });
  })
);

reportsRouter.post(
  '/schedules/:id/pause',
  requirePermission('reports.saved.schedule'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await tx(async (client) => {
      const r = await client.query(
        `UPDATE report_schedules SET enabled = false, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND is_archived = false RETURNING id, name`,
        [id, req.ctx.tenantId ?? -1]
      );
      if (r.rows.length === 0) throw notFound('Schedule not found');
      await logAudit(client, req.ctx, { action: 'pause', resource: 'report.schedule', recordId: id, recordCode: String(r.rows[0].name) });
    }, req.ctx);
    res.json({ data: { ok: true } });
  })
);

reportsRouter.post(
  '/schedules/:id/resume',
  requirePermission('reports.saved.schedule'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const out = await tx(async (client) => {
      const r = await client.query(
        `SELECT * FROM report_schedules WHERE id = $1 AND tenant_id = $2 AND is_archived = false`,
        [id, req.ctx.tenantId ?? -1]
      );
      if (r.rows.length === 0) throw notFound('Schedule not found');
      const row = r.rows[0] as unknown as Record<string, unknown>;
      const sched = toScheduleRow(row);
      const nextRun = new Date(sched.next_run_at).getTime() <= Date.now()
        ? computeNextRun(sched.frequency, sched.run_time, sched.day_of_week, sched.day_of_month, new Date()).toISOString()
        : sched.next_run_at;
      const u = await client.query(
        `UPDATE report_schedules SET enabled = true, next_run_at = $1, updated_at = now()
         WHERE id = $2 AND tenant_id = $3 AND is_archived = false RETURNING id, name`,
        [nextRun, id, req.ctx.tenantId ?? -1]
      );
      await logAudit(client, req.ctx, { action: 'resume', resource: 'report.schedule', recordId: id, recordCode: String(u.rows[0].name) });
      return toScheduleRow({ ...row, enabled: true, next_run_at: nextRun });
    }, req.ctx);
    res.json({ data: out });
  })
);

reportsRouter.post(
  '/schedules/:id/run-now',
  requirePermission('reports.saved.schedule'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const resq = await query(
      `SELECT * FROM report_schedules WHERE id = $1 AND tenant_id = $2 AND is_archived = false`,
      [id, req.ctx.tenantId ?? -1],
      req.ctx
    );
    if (resq.rows.length === 0) throw notFound('Schedule not found');
    const sched = toScheduleRow(resq.rows[0] as unknown as Record<string, unknown>);
    const outcome = await runScheduleRecord(sched, req.ctx);
    res.json({ data: outcome });
  })
);

reportsRouter.post(
  '/schedules/process',
  requirePermission('reports.saved.schedule'),
  asyncHandler(async (_req, res) => {
    const result = await runDueReportSchedules();
    res.json({ data: result });
  })
);

reportsRouter.get(
  '/deliveries',
  requirePermission('reports.saved.schedule'),
  asyncHandler(async (req, res) => {
    const { pageSize, offset } = parsePagination(req.query);
    const companyId = req.ctx.companyId ?? req.auth!.company_id ?? null;
    const r = await query(
      `SELECT d.id, d.schedule_id, d.report_name, d.filters, d.recipients, d.status, d.row_count, d.error,
              d.started_at, d.finished_at, d.created_at, s.name AS schedule_name, u.email AS created_by_email
       FROM report_deliveries d
       LEFT JOIN report_schedules s ON s.id = d.schedule_id
       LEFT JOIN users u ON u.id = d.created_by
       WHERE d.tenant_id = $1 AND ($2::bigint IS NULL OR d.company_id = $2)
       ORDER BY d.id DESC LIMIT $3 OFFSET $4`,
      [req.ctx.tenantId ?? -1, companyId, pageSize, offset],
      req.ctx
    );
    res.json({ data: r.rows.map((row) => toCamelRow(row as unknown as Record<string, unknown>)) });
  })
);

reportsRouter.post(
  '/deliveries/:id/retry',
  requirePermission('reports.saved.schedule'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const resq = await query(
      `SELECT schedule_id FROM report_deliveries WHERE id = $1 AND tenant_id = $2`,
      [id, req.ctx.tenantId ?? -1],
      req.ctx
    );
    if (resq.rows.length === 0) throw notFound('Delivery not found');
    const scheduleId = resq.rows[0].schedule_id;
    if (scheduleId === null || scheduleId === undefined) throw badRequest('Delivery has no source schedule');
    const schedRes = await query(
      `SELECT * FROM report_schedules WHERE id = $1 AND tenant_id = $2 AND is_archived = false`,
      [scheduleId, req.ctx.tenantId ?? -1],
      req.ctx
    );
    if (schedRes.rows.length === 0) throw badRequest('Source schedule is archived or missing');
    const sched = toScheduleRow(schedRes.rows[0] as unknown as Record<string, unknown>);
    await tx(async (client) => {
      await logAudit(client, req.ctx, { action: 'retry', resource: 'report.delivery', recordId: id, recordCode: String(scheduleId) });
    }, req.ctx);
    const outcome = await runScheduleRecord(sched, req.ctx);
    res.json({ data: outcome });
  })
);

reportsRouter.get(
  '/',
  requirePermission('reports.dashboards.view'),
  asyncHandler(async (_req, res) => {
    const data = await Promise.all(
      REPORTS.map(async (r) => ({
        name: r.name,
        label: r.label,
        permission: r.permission,
        columns: await columnsOf(r.table),
      }))
    );
    res.json({ data });
  })
);

reportsRouter.get(
  '/:name',
  requirePermission('reports.dashboards.view'),
  asyncHandler(async (req, res) => {
    const def = reportDef(String(req.params.name).toLowerCase());
    if (!def) throw notFound('Report not found');
    // Re-check the specific report permission (in addition to dashboards.view)
    const perms = req.auth!.permissions;
    const ok = perms.includes(def.permission) || perms.includes('reports.*') || perms.includes('system.admin.all');
    if (!ok) {
      throw forbidden(`Missing permission: ${def.permission}`);
    }

    const cols = await columnsOf(def.table);
    const params: unknown[] = [];
    const where: string[] = [];
    const companyId = cols.includes('company_id') ? (req.auth!.company_id ?? null) : null;
    if (companyId) {
      params.push(companyId);
      where.push(`company_id = $${params.length}`);
    } else if (cols.includes('company_id')) {
      where.push('company_id IS NOT NULL');
    }
    for (const [key, raw] of Object.entries(req.query)) {
      const col = key.replace(/[A-Z]/g, (m: string) => '_' + m.toLowerCase());
      if (['format', 'page', 'pageSize'].includes(col)) continue;
      if (!cols.includes(col)) continue;
      const val = Array.isArray(raw) ? raw[0] : raw;
      if (val === undefined || val === '') continue;
      params.push(val);
      where.push(`${col} = $${params.length}`);
    }
    const { page, pageSize, offset } = (() => {
      const p = Math.max(1, Number(req.query.page) || 1);
      const ps = Math.min(500, Math.max(1, Number(req.query.pageSize) || 100));
      return { page: p, pageSize: ps, offset: (p - 1) * ps };
    })();
    params.push(pageSize, offset);
    const sql = `SELECT * FROM ${def.table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY 1 LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const res2 = await query(sql, params, req.ctx);
    const rows = res2.rows as unknown as Record<string, unknown>[];
    const camelRows = rows.map(toCamelRow);

    const format = String(req.query.format ?? 'json').toLowerCase();
    const audit = async (fmt: string) => {
      try {
        await tx(async (client) => {
          await logAudit(client, req.ctx, {
            action: fmt === 'print' ? 'print' : 'export',
            resource: def.name,
            metadata: { format: fmt, rows: rows.length, report: def.label },
          });
        }, req.ctx);
      } catch (err) {
        console.error('[reports] audit failed', err instanceof Error ? err.message : err);
      }
    };

    if (format === 'csv') {
      await audit('csv');
      const company = await tx(async (client) => loadCompanyProfile(client, req.ctx), req.ctx);
      const fingerprint = reportFingerprint(def.table, cols, rows);
      const issued = new Date().toISOString();
      const out: (string | number | null)[][] = [];
      out.push([company.name]);
      if (company.tagline) out.push([company.tagline]);
      for (const ln of [...companyContactLines(company), ...companyRegLines(company)]) out.push([ln]);
      if (company.footerText) out.push([company.footerText]);
      out.push([]);
      out.push([def.label.toUpperCase()]);
      out.push(['Document No', def.name]);
      out.push([`Issued by ${issuerName(req)} on ${formatDocDateTime(issued)}`]);
      out.push(['Rows', rows.length]);
      out.push(['Classification', 'Internal']);
      out.push([]);
      out.push(cols.map(toCamel));
      for (const row of rows) {
        out.push(cols.map((c) => (row[c] == null ? '' : String(row[c]))));
      }
      out.push([]);
      out.push(['SHA-256 Fingerprint', fingerprint]);
      out.push(['Exported By', issuerName(req)]);
      out.push(['Exported At', formatDocDateTime(issued)]);
      const csv = stringify(out, { header: false });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${def.name}.csv"`);
      return res.send(csv);
    }
    if (format === 'xlsx') {
      await audit('xlsx');
      const company = await tx(async (client) => loadCompanyProfile(client, req.ctx), req.ctx);
      const fingerprint = reportFingerprint(def.table, cols, rows);
      const issued = new Date().toISOString();
      const issuedBy = issuerName(req);
      const wb = new ExcelJS.Workbook();
      wb.creator = company.name;
      wb.company = company.legalName || company.name;
      const ws = wb.addWorksheet(def.label.slice(0, 31), {
        pageSetup: {
          paperSize: 9,
          orientation: cols.length > 8 ? 'landscape' : 'portrait',
          fitToPage: true,
          fitToWidth: 1,
          fitToHeight: 0,
          margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.2, footer: 0.2 },
        },
        headerFooter: {
          oddHeader: `&L${company.name}&C${def.label}`,
          oddFooter: `&L${company.legalName || company.name}${company.tin ? `  TIN ${company.tin}` : ''}&RPage &P of &N`,
        },
      });
      const navy = 'FF0B1F33';
      applyExcelBrandHeader(ws, company, {
        title: def.label,
        docNo: def.name,
        issuedBy,
        issuedAt: issued,
        facts: [['Rows', String(rows.length)]],
        classification: 'Internal',
        columns: Math.max(8, cols.length),
      });
      const hr = ws.addRow(cols.map(toCamel));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 9 };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
      hr.alignment = { vertical: 'middle' };
      rows.forEach((row, i) => {
        const r = ws.addRow(cols.map((c) => (row[c] == null ? '' : row[c])));
        if (i % 2 === 1) r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8F9' } };
      });
      ws.addRow([]);
      ws.addRow(['SHA-256 Fingerprint', fingerprint]);
      ws.addRow(['Exported By', issuedBy]);
      ws.addRow(['Exported At', formatDocDateTime(issued)]);
      cols.forEach((_, i) => {
        ws.getColumn(i + 1).width = 18;
      });
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${def.name}.xlsx"`);
      return res.send(buf);
    }
    if (format === 'pdf') {
      await audit('pdf');
      const company = await tx(async (client) => loadCompanyProfile(client, req.ctx), req.ctx);
      const fingerprint = reportFingerprint(def.table, cols, rows);
      const issuedAt = new Date().toISOString();
      const issuedBy = issuerName(req);
      const token = company.verifyEnabled
        ? issueDocumentToken({
            type: `report.${def.name}`,
            id: 0,
            code: def.name,
            title: def.label,
            fingerprint,
            issuedAt,
            tenantId: req.ctx.tenantId ?? 0,
            companyId: req.ctx.companyId ?? null,
            companyName: company.name,
            issuer: req.auth?.email ?? 'unknown',
            issuerName: issuedBy,
            kind: 'report',
          })
        : '';
      const verifyUrl = token ? documentVerifyUrl(company, token) : '';
      const buf = await renderTablePdf({
        title: def.label,
        subtitle: `${rows.length} row${rows.length === 1 ? '' : 's'}`,
        kicker: 'Management report',
        docNo: def.name,
        company,
        issuedBy,
        issuedAt,
        correlationId: req.ctx.correlationId ?? null,
        facts: [['Rows', String(rows.length)]],
        columns: cols.map((c) => ({ key: c, label: toCamel(c) })),
        rows,
        fingerprint,
        token,
        verifyUrl,
        classification: 'Internal',
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${def.name}.pdf"`);
      return res.send(buf);
    }
    if (format === 'print') {
      await audit('print');
      const company = await tx(async (client) => loadCompanyProfile(client, req.ctx), req.ctx);
      const fingerprint = reportFingerprint(def.table, cols, rows);
      const issuedAt = new Date().toISOString();
      const issuedBy = issuerName(req);
      const token = company.verifyEnabled
        ? issueDocumentToken({
            type: `report.${def.name}`,
            id: 0,
            code: def.name,
            title: def.label,
            fingerprint,
            issuedAt,
            tenantId: req.ctx.tenantId ?? 0,
            companyId: req.ctx.companyId ?? null,
            companyName: company.name,
            issuer: req.auth?.email ?? 'unknown',
            issuerName: issuedBy,
            kind: 'report',
          })
        : '';
      const verifyUrl = token ? documentVerifyUrl(company, token) : '';
      const head = cols.map((c) => `<th>${esc(toCamel(c))}</th>`).join('');
      const body = rows
        .map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c] ?? '')}</td>`).join('')}</tr>`)
        .join('');
      const html = await renderBrandedHtml({
        title: def.label,
        subtitle: `${rows.length} row${rows.length === 1 ? '' : 's'}`,
        kicker: 'Management report',
        company,
        issuedBy,
        issuedAt,
        correlationId: req.ctx.correlationId ?? null,
        docNo: def.name,
        classification: 'Internal',
        facts: [['Rows', String(rows.length)]],
        authenticity: token && verifyUrl ? { fingerprint, token, verifyUrl } : undefined,
        body: `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
    await audit('json');
    const company = await tx(async (client) => loadCompanyProfile(client, req.ctx), req.ctx);
    const fingerprint = reportFingerprint(def.table, cols, rows);
    res.json({
      data: camelRows,
      meta: {
        name: def.name,
        label: def.label,
        total: rows.length,
        company: { name: company.name, legalName: company.legalName, tin: company.tin, vrn: company.vrn, footerText: company.footerText },
        fingerprint,
        issuedBy: issuerName(req),
        issuedAt: new Date().toISOString(),
      },
    });
  })
);
