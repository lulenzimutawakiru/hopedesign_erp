import { Router } from 'express';
import { query, tx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import {
  asyncHandler,
  badRequest,
  notFound,
  forbidden,
  toCamelRow,
  toCamelRows,
  parsePagination,
  camelToSnake,
} from '../utils.js';
import { logAudit } from '../services/audit.js';
import { ANALYTICS_SOURCES, buildWhere, columnsOf } from '../services/reportCore.js';

/** Routers: analyticsRouter mounts at /api/analytics; reportAnalyticsRouter
 *  is mounted inside routes/reports.ts to expose /api/reports/kpis,
 *  /api/reports/dashboards, /api/reports/custom and /api/reports/sources. */
export const analyticsRouter = Router();
export const reportAnalyticsRouter = Router();

const AGGREGATIONS = new Set(['SUM', 'COUNT', 'AVG', 'MAX', 'MIN']);
const FREQUENCIES = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL']);
const DIRECTIONS = new Set(['HIGHER_BETTER', 'LOWER_BETTER']);
const WIDGET_TYPES = new Set(['KPI', 'CHART', 'TABLE', 'REPORT', 'TREND']);
const VISUALIZATIONS = new Set(['table', 'bar', 'line', 'pie', 'kpi']);

const num = (v: unknown, d = 0): number =>
  v === null || v === undefined || v === '' ? d : Number(v);

/** Company scope condition; users without a company see the whole tenant. */
function companyScope(req: import('express').Request, alias: string): string {
  return req.auth?.company_id ? `${alias}.company_id = ${req.auth.company_id}` : '1=1';
}

/** Permission gate shared by every analytics endpoint (wildcard-aware). */
function assertReportAccess(req: import('express').Request, permission: string): void {
  const perms = req.auth?.permissions ?? [];
  if (!perms.includes(permission) && !perms.includes('reports.*') && !perms.includes('system.admin.all')) {
    throw forbidden(`Missing permission: ${permission}`);
  }
}

/** Whitelisted aggregation guard - user input never reaches SQL directly. */
function safeAgg(agg: unknown): string {
  const a = String(agg ?? 'SUM').toUpperCase();
  return AGGREGATIONS.has(a) ? a : 'SUM';
}

/** Half-open [start, end) period bounds for KPI measurement. */
function periodBounds(raw: unknown): { start: string; end: string } {
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  const now = new Date();
  const nowMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const addDays = (iso: string, days: number): string => {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const addMonths = (iso: string, months: number): string => {
    const [y, m] = iso.split('-').map(Number);
    const d = new Date(y, m - 1 + months, 1);
    return d.toISOString().slice(0, 10);
  };
  if (s.includes('..')) {
    const [a, b] = s.split('..');
    return { start: (a || nowMonth).trim(), end: (b || addMonths(nowMonth, 1)).trim() };
  }
  if (/^\d{4}-\d{2}$/.test(s)) return { start: `${s}-01`, end: addMonths(`${s}-01`, 1) };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { start: s, end: addDays(s, 1) };
  return { start: nowMonth, end: addMonths(nowMonth, 1) };
}

/** KPI status classification from configurable thresholds (% of target). */
function classifyKpi(kpi: Record<string, unknown>, actual: number | null): string {
  if (actual === null || actual === undefined || Number.isNaN(actual)) return 'NO_DATA';
  const target = num(kpi.targetValue, 0);
  if (target <= 0) return 'NO_DATA';
  const direction = String(kpi.direction ?? 'HIGHER_BETTER');
  const warn = num(kpi.warningThreshold, 90);
  const crit = num(kpi.criticalThreshold, 75);
  const pct = (actual / target) * 100;
  if (direction === 'LOWER_BETTER') {
    if (pct <= 100) return 'ON_TARGET';
    if (pct >= crit) return 'CRITICAL';
    if (pct >= warn) return 'WARNING';
    return 'ON_TARGET';
  }
  if (pct >= 100) return 'ON_TARGET';
  if (pct <= crit) return 'CRITICAL';
  if (pct <= warn) return 'WARNING';
  return 'ON_TARGET';
}

async function kpiRow(req: import('express').Request, id: number): Promise<Record<string, unknown>> {
  const res = await query(
    `SELECT * FROM analytics_kpis WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
    [id, req.ctx.tenantId ?? 0],
    req.ctx
  );
  const row = res.rows[0];
  if (!row) throw notFound('KPI not found');
  return toCamelRow(row);
}

async function validateKpiPayload(body: Record<string, unknown>): Promise<void> {
  const key = String(body.key ?? '');
  if (!/^[a-z0-9_]{2,64}$/.test(key)) throw badRequest('Invalid KPI key (lowercase letters, digits, underscores)');
  const ds = String(body.dataSource ?? '');
  if (!ANALYTICS_SOURCES.includes(ds)) throw badRequest('Unsupported KPI data source');
  const cols = await columnsOf(ds);
  const valCol = body.valueColumn ? camelToSnake(String(body.valueColumn)) : null;
  if (valCol && !cols.includes(valCol)) throw badRequest(`Unknown value column: ${valCol}`);
  const periodCol = body.periodColumn ? camelToSnake(String(body.periodColumn)) : null;
  if (periodCol && !cols.includes(periodCol)) throw badRequest(`Unknown period column: ${periodCol}`);
  if (body.aggregation && !AGGREGATIONS.has(String(body.aggregation).toUpperCase())) throw badRequest('Invalid aggregation');
  if (body.frequency && !FREQUENCIES.has(String(body.frequency).toUpperCase())) throw badRequest('Invalid frequency');
  if (body.direction && !DIRECTIONS.has(String(body.direction).toUpperCase())) throw badRequest('Invalid direction');
}
/* ------------------------------------------------------------------ */
/* Dashboard + custom report helpers                                    */
/* ------------------------------------------------------------------ */

interface WidgetInput {
  widgetType: string;
  title: string;
  kpiId: number | null;
  reportName: string | null;
  config: Record<string, unknown>;
  position: Record<string, unknown>;
  size: Record<string, unknown>;
}

/** Validate widget inputs against the whitelist. */
function sanitizeWidgets(raw: unknown): WidgetInput[] {
  if (!Array.isArray(raw)) throw badRequest('widgets must be an array');
  return raw.map((w, i) => {
    const o = (w ?? {}) as Record<string, unknown>;
    const type = String(o.widgetType ?? o.widget_type ?? '').toUpperCase();
    if (!WIDGET_TYPES.has(type)) throw badRequest(`widgets[${i}]: invalid widget type`);
    const title = String(o.title ?? '').trim();
    if (!title || title.length > 120) throw badRequest(`widgets[${i}]: title is required (max 120)`);
    const kpiRaw = o.kpiId === undefined || o.kpiId === null || o.kpiId === '' ? null : Number(o.kpiId);
    const reportRaw = o.reportName === undefined || o.reportName === null || o.reportName === ''
      ? null
      : String(o.reportName).trim().toLowerCase();
    return {
      widgetType: type,
      title,
      kpiId: kpiRaw !== null && Number.isFinite(kpiRaw) ? kpiRaw : null,
      reportName: reportRaw && reportRaw.length <= 100 ? reportRaw : null,
      config: o.config && typeof o.config === 'object' && !Array.isArray(o.config)
        ? (o.config as Record<string, unknown>)
        : {},
      position: o.position && typeof o.position === 'object' && !Array.isArray(o.position)
        ? (o.position as Record<string, unknown>)
        : {},
      size: o.size && typeof o.size === 'object' && !Array.isArray(o.size)
        ? (o.size as Record<string, unknown>)
        : {},
    };
  });
}

/** Full-replace the widget set of a dashboard inside the current tx. */
async function replaceWidgets(
  client: import('pg').PoolClient,
  ctx: import('../db.js').Ctx,
  dashboardId: number,
  widgets: WidgetInput[]
): Promise<void> {
  await client.query('DELETE FROM analytics_dashboard_widgets WHERE dashboard_id = $1', [dashboardId]);
  for (const w of widgets) {
    await client.query(
      `INSERT INTO analytics_dashboard_widgets
         (tenant_id, dashboard_id, widget_type, title, kpi_id, report_name, config, position, size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        ctx.tenantId ?? 0,
        dashboardId,
        w.widgetType,
        w.title,
        w.kpiId,
        w.reportName,
        JSON.stringify(w.config),
        JSON.stringify(w.position),
        JSON.stringify(w.size),
      ]
    );
  }
}

/** Load a dashboard row + widgets (throws 404 when missing/archived). */
async function dashboardRow(
  client: import('pg').PoolClient,
  ctx: import('../db.js').Ctx,
  id: number
): Promise<Record<string, unknown>> {
  const r = await client.query(
    `SELECT * FROM analytics_dashboards WHERE id = $1 AND tenant_id = $2 AND is_archived = false`,
    [id, ctx.tenantId ?? 0]
  );
  const row = r.rows[0];
  if (!row) throw notFound('Dashboard not found');
  const w = await client.query(
    `SELECT id, widget_type, title, kpi_id, report_name, config, position, size
     FROM analytics_dashboard_widgets WHERE dashboard_id = $1 ORDER BY id`,
    [id]
  );
  return {
    ...toCamelRow(row as Record<string, unknown>),
    widgets: toCamelRows(w.rows as Record<string, unknown>[]),
  };
}

/** Validate + normalize a custom report definition. */
async function sanitizeCustomConfig(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = String(body.name ?? '').trim();
  if (!name || name.length > 150) throw badRequest('Report name is required (max 150)');
  const ds = String(body.dataSource ?? '');
  if (!ANALYTICS_SOURCES.includes(ds)) throw badRequest('Unsupported custom report data source');
  const cols = await columnsOf(ds);
  const viz = String(body.visualization ?? 'table').toLowerCase();
  if (!VISUALIZATIONS.has(viz)) throw badRequest('Invalid visualization');
  const cfg = (body.config ?? {}) as Record<string, unknown>;
  const pick = (v: unknown): string[] =>
    Array.isArray(v)
      ? [...new Set(v.map((c) => camelToSnake(String(c))).filter((c) => cols.includes(c)))].slice(0, 25)
      : [];
  const columns = pick(cfg.columns);
  if (columns.length === 0) throw badRequest('At least one visible column is required');
  const groupBy = pick(cfg.groupBy);
  const sortRaw = (cfg.sort ?? {}) as Record<string, unknown>;
  const sortCol = sortRaw.column ? camelToSnake(String(sortRaw.column)) : null;
  const sort = sortCol && cols.includes(sortCol)
    ? { column: sortCol, direction: String(sortRaw.direction ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc' }
    : null;
  const limit = Math.min(500, Math.max(1, Number(cfg.limit) || 100));
  return {
    name,
    description: String(body.description ?? '').trim(),
    dataSource: ds,
    visualization: viz,
    config: { columns, groupBy, sort, limit },
  };
}

/** Load a custom report row (throws 404 when missing/archived). */
async function customReportRow(
  client: import('pg').PoolClient,
  ctx: import('../db.js').Ctx,
  id: number
): Promise<Record<string, unknown>> {
  const r = await client.query(
    `SELECT * FROM custom_reports WHERE id = $1 AND tenant_id = $2 AND is_archived = false`,
    [id, ctx.tenantId ?? 0]
  );
  const row = r.rows[0];
  if (!row) throw notFound('Custom report not found');
  return toCamelRow(row as Record<string, unknown>);
}
/* ================================================================== */
/* /api/analytics/* — live, database-driven analytics aggregates        */
/* ================================================================== */

analyticsRouter.get(
  '/executive',
  requirePermission('reports.executive.view'),
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const scope = (alias: string): string => companyScope(req, alias);
    const safe = async (sql: string, params: unknown[] = [], fallback: Record<string, unknown> = {}) => {
      try {
        const r = await query(sql, params, ctx);
        return r.rows[0] ?? fallback;
      } catch {
        return fallback;
      }
    };
    const stock = await safe(
      `SELECT COALESCE(sum(stock_value),0)::numeric(18,2) AS value, count(*)::int AS lines
       FROM v_inventory_summary v WHERE ${scope('v')}`
    );
    const lowStock = await safe(
      `SELECT count(*)::int AS count FROM inventory i
       JOIN products p ON p.id = i.product_id
       WHERE i.quantity <= COALESCE(p.reorder_point,0) AND i.quantity > 0 AND i.company_id = $1`,
      [req.auth!.company_id ?? -1],
      { count: 0 }
    );
    const ar = await safe(
      `SELECT COALESCE(sum(balance),0)::numeric(18,2) AS outstanding,
              count(*) FILTER (WHERE is_overdue)::int AS overdue
       FROM v_ar_aging v WHERE ${scope('v')}`
    );
    const ap = await safe(
      `SELECT COALESCE(sum(balance),0)::numeric(18,2) AS outstanding,
              count(*) FILTER (WHERE is_overdue)::int AS overdue
       FROM v_ap_aging v WHERE ${scope('v')}`
    );
    const month = await safe(
      `SELECT COALESCE(sum(revenue),0)::numeric(18,2) AS revenue, COALESCE(sum(invoice_count),0)::int AS invoices
       FROM v_sales_by_month v WHERE ${scope('v')} AND month = date_trunc('month', now())`
    );
    const prev = await safe(
      `SELECT COALESCE(sum(revenue),0)::numeric(18,2) AS revenue
       FROM v_sales_by_month v WHERE ${scope('v')} AND month = date_trunc('month', now() - interval '1 month')`
    );
    const yieldM = await safe(
      `SELECT COALESCE(sum(produced),0)::numeric(18,2) AS produced,
              COALESCE(sum(scrapped),0)::numeric(18,2) AS scrapped,
              COALESCE(sum(waste),0)::numeric(18,2) AS waste,
              CASE WHEN sum(produced) > 0 THEN round(sum(produced) / (sum(produced) + sum(scrapped) + sum(waste)) * 100, 2) END AS yield_pct
       FROM v_production_yield_by_month v WHERE ${scope('v')} AND month = date_trunc('month', now())`
    );
    const wos = await safe(
      `SELECT count(*) FILTER (WHERE status IN ('RELEASED','IN_PROGRESS','ON_HOLD'))::int AS in_progress,
              count(*) FILTER (WHERE status IN ('COMPLETED','CLOSED'))::int AS completed
       FROM work_orders wo WHERE ${scope('wo')}`
    );
    const qr = await safe(
      `SELECT count(*)::int AS count FROM qr_scans q WHERE ${scope('q')}`
    );
    const payroll = await safe(
      `SELECT COALESCE(sum(gross_total),0)::numeric(18,2) AS gross
       FROM v_payroll_summary v WHERE ${scope('v')}
         AND payment_date >= date_trunc('month', now())
         AND v.payroll_status IN ('APPROVED','POSTED','PAID','COMPLETED')`
    );
    const trial = await safe(`SELECT COALESCE(sum(net_balance),0)::numeric(18,2) AS total FROM v_trial_balance`);
    const deliveries = await safe(
      `SELECT count(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
              count(*) FILTER (WHERE status <> 'CANCELLED')::int AS total,
              count(*) FILTER (WHERE status IN ('DISPATCHED','IN_TRANSIT'))::int AS outstanding
       FROM delivery_notes d WHERE ${scope('d')}`
    );

    const rev = num(month.revenue);
    const prevRev = num(prev.revenue);
    const delivered = num(deliveries.delivered);
    const totalDeliveries = num(deliveries.total);
    res.json({
      data: {
        financial: {
          trialBalance: num(trial.total),
          receivables: num(ar.outstanding),
          payables: num(ap.outstanding),
          monthGrossPayroll: num(payroll.gross),
        },
        commercial: {
          monthRevenue: rev,
          monthInvoices: num(month.invoices),
          revenueGrowthPct: prevRev > 0 ? Math.round(((rev - prevRev) / prevRev) * 1000) / 10 : null,
        },
        manufacturing: {
          monthYieldPct: yieldM.yield_pct === null || yieldM.yield_pct === undefined ? null : num(yieldM.yield_pct),
          monthProduced: num(yieldM.produced),
          workOrdersInProgress: num(wos.in_progress),
          workOrdersCompleted: num(wos.completed),
        },
        inventory: {
          stockValue: num(stock.value),
          stockLines: num(stock.lines),
          lowStock: num(lowStock.count),
        },
        traceability: { qrScans: num(qr.count) },
        logistics: {
          deliveriesDelivered: delivered,
          deliveriesOutstanding: num(deliveries.outstanding),
          deliveryRatePct: totalDeliveries > 0 ? Math.round((delivered / totalDeliveries) * 1000) / 10 : null,
        },
      },
    });
  })
);

analyticsRouter.get(
  '/finance',
  requirePermission('reports.finance.view'),
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const scope = (alias: string): string => companyScope(req, alias);
    const safe = async (sql: string, params: unknown[] = [], fallback: Record<string, unknown> = {}) => {
      try {
        const r = await query(sql, params, ctx);
        return r.rows[0] ?? fallback;
      } catch {
        return fallback;
      }
    };
    const [trial, ar, ap, month, payroll, arBuckets, apBuckets] = await Promise.all([
      safe(`SELECT COALESCE(sum(net_balance),0)::numeric(18,2) AS total FROM v_trial_balance`),
      safe(
        `SELECT COALESCE(sum(balance),0)::numeric(18,2) AS outstanding,
                count(*) FILTER (WHERE is_overdue)::int AS overdue
         FROM v_ar_aging v WHERE ${scope('v')}`
      ),
      safe(
        `SELECT COALESCE(sum(balance),0)::numeric(18,2) AS outstanding,
                count(*) FILTER (WHERE is_overdue)::int AS overdue
         FROM v_ap_aging v WHERE ${scope('v')}`
      ),
      safe(
        `SELECT COALESCE(sum(revenue),0)::numeric(18,2) AS revenue, COALESCE(sum(invoice_count),0)::int AS invoices
         FROM v_sales_by_month v WHERE ${scope('v')} AND month = date_trunc('month', now())`
      ),
      safe(
        `SELECT COALESCE(sum(gross_total),0)::numeric(18,2) AS gross
         FROM v_payroll_summary v WHERE ${scope('v')}
           AND payment_date >= date_trunc('month', now())
           AND v.payroll_status IN ('APPROVED','POSTED','PAID','COMPLETED')`
      ),
      (async () => {
        const r = await query(
          `SELECT bucket, COALESCE(sum(balance),0)::numeric(18,2) AS balance
           FROM v_ar_aging v WHERE ${scope('v')} GROUP BY bucket ORDER BY bucket`,
          [],
          ctx
        );
        return r.rows;
      })(),
      (async () => {
        const r = await query(
          `SELECT bucket, COALESCE(sum(balance),0)::numeric(18,2) AS balance
           FROM v_ap_aging v WHERE ${scope('v')} GROUP BY bucket ORDER BY bucket`,
          [],
          ctx
        );
        return r.rows;
      })(),
    ]);
    res.json({
      data: {
        trialBalance: num(trial.total),
        receivables: {
          outstanding: num(ar.outstanding),
          overdueAccounts: num(ar.overdue),
          buckets: toCamelRows(arBuckets as Record<string, unknown>[]),
        },
        payables: {
          outstanding: num(ap.outstanding),
          overdueSuppliers: num(ap.overdue),
          buckets: toCamelRows(apBuckets as Record<string, unknown>[]),
        },
        monthRevenue: num(month.revenue),
        monthInvoices: num(month.invoices),
        monthGrossPayroll: num(payroll.gross),
      },
    });
  })
);

analyticsRouter.get(
  '/sales',
  requirePermission('reports.sales.view'),
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const scope = (alias: string): string => companyScope(req, alias);
    const seriesRes = await query(
      `SELECT to_char(month, 'YYYY-MM') AS period,
              COALESCE(sum(revenue),0)::numeric(18,2) AS revenue,
              COALESCE(sum(invoice_count),0)::int AS invoices
       FROM v_sales_by_month v
       WHERE ${scope('v')} AND month >= date_trunc('month', now()) - interval '5 months'
       GROUP BY month ORDER BY month`,
      [],
      ctx
    );
    const monthRes = await query(
      `SELECT COALESCE(sum(revenue),0)::numeric(18,2) AS revenue, COALESCE(sum(invoice_count),0)::int AS invoices
       FROM v_sales_by_month v WHERE ${scope('v')} AND month = date_trunc('month', now())`,
      [],
      ctx
    );
    const prevRes = await query(
      `SELECT COALESCE(sum(revenue),0)::numeric(18,2) AS revenue
       FROM v_sales_by_month v WHERE ${scope('v')} AND month = date_trunc('month', now() - interval '1 month')`,
      [],
      ctx
    );
    const rev = num(monthRes.rows[0]?.revenue);
    const prevRev = num(prevRes.rows[0]?.revenue);
    res.json({
      data: {
        series: toCamelRows(seriesRes.rows as Record<string, unknown>[]),
        currentMonth: {
          revenue: rev,
          invoices: num(monthRes.rows[0]?.invoices),
          growthPct: prevRev > 0 ? Math.round(((rev - prevRev) / prevRev) * 1000) / 10 : null,
        },
      },
    });
  })
);

analyticsRouter.get(
  '/manufacturing',
  requirePermission('reports.production.view'),
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const scope = (alias: string): string => companyScope(req, alias);
    const seriesRes = await query(
      `SELECT to_char(month, 'YYYY-MM') AS period,
              COALESCE(sum(produced),0)::numeric(18,2) AS produced,
              COALESCE(sum(scrapped),0)::numeric(18,2) AS scrapped,
              COALESCE(sum(waste),0)::numeric(18,2) AS waste,
              round(COALESCE(sum(produced) / NULLIF(sum(produced) + sum(scrapped) + sum(waste), 0) * 100, 0), 2) AS yield_pct
       FROM v_production_yield_by_month v
       WHERE ${scope('v')} AND month >= date_trunc('month', now()) - interval '5 months'
       GROUP BY month ORDER BY month`,
      [],
      ctx
    );
    const woRes = await query(
      `SELECT status, count(*)::int AS count FROM work_orders wo
       WHERE ${scope('wo')} GROUP BY status ORDER BY status`,
      [],
      ctx
    );
    const machinesRes = await query(
      `SELECT machine_code, machine_name, count(*)::int AS work_orders,
              COALESCE(sum(produced_qty),0)::numeric(18,2) AS produced,
              round(COALESCE(avg(efficiency_percent),0),2) AS avg_efficiency
       FROM v_work_order_summary v
       WHERE ${scope('v')} AND machine_name IS NOT NULL AND machine_name <> ''
       GROUP BY machine_code, machine_name
       ORDER BY produced DESC LIMIT 10`,
      [],
      ctx
    );
    const inProgress = woRes.rows.filter((r) => ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'].includes(r.status))
      .reduce((s, r) => s + Number(r.count), 0);
    const completed = woRes.rows.filter((r) => ['COMPLETED', 'CLOSED'].includes(r.status))
      .reduce((s, r) => s + Number(r.count), 0);
    res.json({
      data: {
        yieldSeries: toCamelRows(seriesRes.rows as Record<string, unknown>[]),
        workOrders: { inProgress, completed, byStatus: toCamelRows(woRes.rows as Record<string, unknown>[]) },
        topMachines: toCamelRows(machinesRes.rows as Record<string, unknown>[]),
      },
    });
  })
);

analyticsRouter.get(
  '/inventory',
  requirePermission('reports.inventory.view'),
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const scope = (alias: string): string => companyScope(req, alias);
    const totalsRes = await query(
      `SELECT COALESCE(sum(stock_value),0)::numeric(18,2) AS value,
              count(*)::int AS lines,
              count(DISTINCT warehouse_id)::int AS warehouses,
              count(DISTINCT product_id)::int AS products
       FROM v_inventory_summary v WHERE ${scope('v')}`,
      [],
      ctx
    );
    const byWarehouseRes = await query(
      `SELECT warehouse_code, warehouse_name, count(*)::int AS lines,
              COALESCE(sum(stock_value),0)::numeric(18,2) AS stock_value
       FROM v_inventory_summary v
       WHERE ${scope('v')} AND warehouse_name IS NOT NULL
       GROUP BY warehouse_code, warehouse_name
       ORDER BY stock_value DESC LIMIT 20`,
      [],
      ctx
    );
    const lowStockRes = await query(
      `SELECT p.code AS product_code, p.name AS product_name,
              i.quantity, COALESCE(p.reorder_point,0) AS reorder_point
       FROM inventory i JOIN products p ON p.id = i.product_id
       WHERE i.quantity <= COALESCE(p.reorder_point,0) AND i.quantity > 0 AND i.company_id = $1
       ORDER BY i.quantity ASC LIMIT 25`,
      [req.auth!.company_id ?? -1],
      ctx
    );
    res.json({
      data: {
        totals: toCamelRow(totalsRes.rows[0] as Record<string, unknown>),
        byWarehouse: toCamelRows(byWarehouseRes.rows as Record<string, unknown>[]),
        lowStock: toCamelRows(lowStockRes.rows as Record<string, unknown>[]),
      },
    });
  })
);

analyticsRouter.get(
  '/logistics',
  requirePermission('reports.logistics.view'),
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const scope = (alias: string): string => companyScope(req, alias);
    const [deliveriesRes, tripsRes, fleetRes] = await Promise.all([
      query(
        `SELECT status, count(*)::int AS count FROM delivery_notes d
         WHERE ${scope('d')} GROUP BY status ORDER BY status`,
        [],
        ctx
      ),
      query(
        `SELECT status, count(*)::int AS count FROM trips t
         WHERE ${scope('t')} GROUP BY status ORDER BY status`,
        [],
        ctx
      ),
      query(
        `SELECT status, count(*)::int AS count FROM vehicles v
         WHERE ${scope('v')} GROUP BY status ORDER BY status`,
        [],
        ctx
      ),
    ]);
    const rows = deliveriesRes.rows as Array<{ status: string; count: string }>;
    const delivered = rows.filter((r) => r.status === 'DELIVERED').reduce((s, r) => s + Number(r.count), 0);
    const total = rows.filter((r) => r.status !== 'CANCELLED').reduce((s, r) => s + Number(r.count), 0);
    res.json({
      data: {
        deliveries: {
          byStatus: toCamelRows(deliveriesRes.rows as Record<string, unknown>[]),
          delivered,
          total,
          deliveryRatePct: total > 0 ? Math.round((delivered / total) * 1000) / 10 : null,
        },
        trips: toCamelRows(tripsRes.rows as Record<string, unknown>[]),
        fleet: toCamelRows(fleetRes.rows as Record<string, unknown>[]),
      },
    });
  })
);
/* ================================================================== */
/* /api/reports/kpis — configurable KPI management engine              */
/* ================================================================== */

reportAnalyticsRouter.get(
  '/sources',
  requirePermission('reports.builder.view'),
  asyncHandler(async (req, res) => {
    const out: Array<{ name: string; columns: string[] }> = [];
    for (const s of ANALYTICS_SOURCES) {
      out.push({ name: s, columns: await columnsOf(s) });
    }
    res.json({ data: out });
  })
);

reportAnalyticsRouter.get(
  '/kpis',
  requirePermission('reports.kpis.view'),
  asyncHandler(async (req, res) => {
    const company = req.auth!.company_id ?? null;
    const r = await query(
      `SELECT k.*, m.actual_value AS latest_value, m.status AS latest_status, m.measured_at AS latest_measured_at
       FROM analytics_kpis k
       LEFT JOIN LATERAL (
         SELECT actual_value, status, measured_at FROM analytics_kpi_measurements
         WHERE kpi_id = k.id ORDER BY measured_at DESC LIMIT 1
       ) m ON true
       WHERE k.tenant_id = $1 AND k.is_active = true
         AND ($2::bigint IS NULL OR k.company_id IS NULL OR k.company_id = $2)
       ORDER BY k.name`,
      [req.ctx.tenantId ?? 0, company],
      req.ctx
    );
    res.json({ data: toCamelRows(r.rows as Record<string, unknown>[]) });
  })
);

reportAnalyticsRouter.post(
  '/kpis',
  requirePermission('reports.kpis.create'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await validateKpiPayload(body);
    const key = String(body.key).trim();
    const out = await tx(async (client) => {
      const dup = await client.query(
        `SELECT 1 FROM analytics_kpis WHERE tenant_id = $1 AND key = $2 AND is_active = true`,
        [req.ctx.tenantId ?? 0, key]
      );
      if (dup.rows.length > 0) throw badRequest(`KPI key already exists: ${key}`);
      const r = await client.query(
        `INSERT INTO analytics_kpis
           (tenant_id, company_id, created_by, key, name, description, department, owner_id,
            data_source, value_column, aggregation, period_column, unit, frequency, direction,
            target_value, warning_threshold, critical_threshold)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          req.ctx.tenantId ?? 0,
          body.companyId ?? req.ctx.companyId ?? req.auth!.company_id ?? null,
          req.auth!.id,
          key,
          String(body.name ?? key),
          String(body.description ?? '').trim(),
          String(body.department ?? '').trim() || null,
          body.ownerId ? Number(body.ownerId) : null,
          String(body.dataSource),
          body.valueColumn ? camelToSnake(String(body.valueColumn)) : null,
          safeAgg(body.aggregation),
          body.periodColumn ? camelToSnake(String(body.periodColumn)) : null,
          String(body.unit ?? 'number'),
          String(body.frequency ?? 'MONTHLY').toUpperCase(),
          String(body.direction ?? 'HIGHER_BETTER').toUpperCase(),
          body.targetValue === undefined || body.targetValue === null ? null : Number(body.targetValue),
          body.warningThreshold === undefined || body.warningThreshold === null ? null : Number(body.warningThreshold),
          body.criticalThreshold === undefined || body.criticalThreshold === null ? null : Number(body.criticalThreshold),
        ]
      );
      await logAudit(client, req.ctx, {
        action: 'create',
        resource: 'reports.kpi',
        recordId: Number(r.rows[0].id),
        recordCode: key,
        newValues: { key, name: String(body.name ?? key), dataSource: String(body.dataSource) },
      });
      return toCamelRow(r.rows[0] as Record<string, unknown>);
    }, req.ctx);
    res.json({ data: out });
  })
);

reportAnalyticsRouter.get(
  '/kpis/:id',
  requirePermission('reports.kpis.view'),
  asyncHandler(async (req, res) => {
    res.json({ data: await kpiRow(req, Number(req.params.id)) });
  })
);

reportAnalyticsRouter.patch(
  '/kpis/:id',
  requirePermission('reports.kpis.update'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    await validateKpiPayload({ ...(body as Record<string, unknown>), key: body.key ?? 'probe' });
    const out = await tx(async (client) => {
      const prevRes = await client.query(
        `SELECT * FROM analytics_kpis WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
        [id, req.ctx.tenantId ?? 0]
      );
      const prev = prevRes.rows[0] as Record<string, unknown> | undefined;
      if (!prev) throw notFound('KPI not found');
      const r = await client.query(
        `UPDATE analytics_kpis SET
           name = COALESCE($3, name),
           description = COALESCE($4, description),
           department = COALESCE($5, department),
           value_column = COALESCE($6, value_column),
           aggregation = COALESCE($7, aggregation),
           period_column = COALESCE($8, period_column),
           unit = COALESCE($9, unit),
           frequency = COALESCE($10, frequency),
           direction = COALESCE($11, direction),
           target_value = $12,
           warning_threshold = $13,
           critical_threshold = $14,
           updated_by = $15, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [
          id,
          req.ctx.tenantId ?? 0,
          body.name !== undefined ? String(body.name) : null,
          body.description !== undefined ? String(body.description).trim() : null,
          body.department !== undefined ? (String(body.department).trim() || null) : null,
          body.valueColumn !== undefined ? camelToSnake(String(body.valueColumn)) : null,
          body.aggregation !== undefined ? safeAgg(body.aggregation) : null,
          body.periodColumn !== undefined ? camelToSnake(String(body.periodColumn)) : null,
          body.unit !== undefined ? String(body.unit) : null,
          body.frequency !== undefined ? String(body.frequency).toUpperCase() : null,
          body.direction !== undefined ? String(body.direction).toUpperCase() : null,
          body.targetValue === undefined || body.targetValue === null ? null : Number(body.targetValue),
          body.warningThreshold === undefined || body.warningThreshold === null ? null : Number(body.warningThreshold),
          body.criticalThreshold === undefined || body.criticalThreshold === null ? null : Number(body.criticalThreshold),
          req.auth!.id,
        ]
      );
      await logAudit(client, req.ctx, {
        action: 'update',
        resource: 'reports.kpi',
        recordId: id,
        recordCode: String(prev.key ?? id),
        oldValues: { name: prev.name, targetValue: prev.target_value },
        newValues: { name: r.rows[0].name, targetValue: r.rows[0].target_value },
      });
      return toCamelRow(r.rows[0] as Record<string, unknown>);
    }, req.ctx);
    res.json({ data: out });
  })
);

reportAnalyticsRouter.delete(
  '/kpis/:id',
  requirePermission('reports.kpis.delete'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await tx(async (client) => {
      const r = await client.query(
        `UPDATE analytics_kpis SET is_active = false, updated_by = $3, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND is_active = true RETURNING id, key`,
        [id, req.ctx.tenantId ?? 0, req.auth!.id]
      );
      if (r.rows.length === 0) throw notFound('KPI not found');
      await logAudit(client, req.ctx, {
        action: 'archive',
        resource: 'reports.kpi',
        recordId: id,
        recordCode: String(r.rows[0].key),
      });
    }, req.ctx);
    res.json({ data: { id } });
  })
);

/** Compute + store one KPI measurement from live data. */
reportAnalyticsRouter.post(
  '/kpis/:id/measure',
  requirePermission('reports.kpis.measure'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const kpi = await kpiRow(req, id);
    const cols = await columnsOf(String(kpi.dataSource));
    const valueCol = kpi.valueColumn ? String(kpi.valueColumn) : null;
    if (!valueCol || !cols.includes(valueCol)) throw badRequest('KPI has no valid value column');
    const agg = safeAgg(kpi.aggregation);
    const periodCol = kpi.periodColumn && cols.includes(String(kpi.periodColumn)) ? String(kpi.periodColumn) : null;
    const { start, end } = periodBounds(req.body?.period);
    const params: unknown[] = [req.ctx.tenantId ?? 0];
    const where = [`tenant_id = $1`];
    const hasCompany = cols.includes('company_id');
    let companyId: number | null = null;
    if (hasCompany) {
      const cid = req.body?.companyId ?? kpi.companyId ?? req.auth!.company_id ?? null;
      if (cid) {
        companyId = Number(cid);
        params.push(companyId);
        where.push(`company_id = $${params.length}`);
      }
    }
    if (periodCol) {
      params.push(start, end);
      where.push(`${periodCol} >= $${params.length - 1}::date`, `${periodCol} < $${params.length}::date`);
    }
    const sql = `SELECT ${agg}("${valueCol}") AS actual_value, count(*)::int AS row_count
                 FROM ${kpi.dataSource} WHERE ${where.join(' AND ')}`;
    const out = await tx(async (client) => {
      const res = await client.query(sql, params);
      const row = res.rows[0] ?? {};
      const actual = row.actual_value === null || row.actual_value === undefined ? null : Number(row.actual_value);
      const status = classifyKpi(kpi, actual);
      const ins = await client.query(
        `INSERT INTO analytics_kpi_measurements
           (tenant_id, kpi_id, company_id, period_start, period_end, actual_value, row_count, status, measured_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.ctx.tenantId ?? 0, id, companyId, start, end, actual, Number(row.row_count ?? 0), status, req.auth!.id]
      );
      await logAudit(client, req.ctx, {
        action: 'measure',
        resource: 'reports.kpi',
        recordId: id,
        recordCode: String(kpi.key ?? id),
        newValues: { period: `${start}..${end}`, actualValue: actual, status },
      });
      return {
        measurement: toCamelRow(ins.rows[0] as Record<string, unknown>),
        kpi: { ...kpi, actualValue: actual, status },
      };
    }, req.ctx);
    res.json({ data: out });
  })
);

reportAnalyticsRouter.get(
  '/kpis/:id/measurements',
  requirePermission('reports.kpis.view'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await kpiRow(req, id);
    const r = await query(
      `SELECT id, period_start, period_end, actual_value, row_count, status, measured_by, measured_at
       FROM analytics_kpi_measurements
       WHERE kpi_id = $1 AND tenant_id = $2
       ORDER BY measured_at DESC LIMIT 60`,
      [id, req.ctx.tenantId ?? 0],
      req.ctx
    );
    res.json({ data: toCamelRows(r.rows as Record<string, unknown>[]) });
  })
);

/* ================================================================== */
/* /api/reports/dashboards — dashboard builder                          */
/* ================================================================== */

reportAnalyticsRouter.get(
  '/dashboards',
  requirePermission('reports.dashboards.view'),
  asyncHandler(async (req, res) => {
    const company = req.auth!.company_id ?? null;
    const r = await query(
      `SELECT d.id, d.name, d.description, d.is_personal, d.is_default, d.layout,
              d.created_by, d.created_at, d.updated_at,
              count(w.id)::int AS widget_count
       FROM analytics_dashboards d
       LEFT JOIN analytics_dashboard_widgets w ON w.dashboard_id = d.id
       WHERE d.tenant_id = $1 AND d.is_archived = false
         AND (d.is_personal = false OR d.created_by = $3)
         AND ($2::bigint IS NULL OR d.company_id IS NULL OR d.company_id = $2)
       GROUP BY d.id ORDER BY d.is_default DESC, d.name`,
      [req.ctx.tenantId ?? 0, company, req.auth!.id],
      req.ctx
    );
    res.json({ data: toCamelRows(r.rows as Record<string, unknown>[]) });
  })
);

reportAnalyticsRouter.post(
  '/dashboards',
  requirePermission('reports.dashboards.create'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 150) throw badRequest('Dashboard name is required (max 150)');
    const widgets = sanitizeWidgets(body.widgets ?? []);
    const layout = body.layout && typeof body.layout === 'object' && !Array.isArray(body.layout)
      ? (body.layout as Record<string, unknown>)
      : {};
    const out = await tx(async (client) => {
      const r = await client.query(
        `INSERT INTO analytics_dashboards
           (tenant_id, company_id, created_by, name, description, is_personal, is_default, layout)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          req.ctx.tenantId ?? 0,
          body.companyId ?? req.ctx.companyId ?? req.auth!.company_id ?? null,
          req.auth!.id,
          name,
          String(body.description ?? '').trim(),
          body.isPersonal === true || body.isPersonal === 'true',
          body.isDefault === true || body.isDefault === 'true',
          JSON.stringify(layout),
        ]
      );
      const dashboardId = Number(r.rows[0].id);
      await replaceWidgets(client, req.ctx, dashboardId, widgets);
      await logAudit(client, req.ctx, {
        action: 'create',
        resource: 'reports.dashboard',
        recordId: dashboardId,
        recordCode: name,
        newValues: { name, widgets: widgets.length },
      });
      return dashboardRow(client, req.ctx, dashboardId);
    }, req.ctx);
    res.json({ data: out });
  })
);

reportAnalyticsRouter.get(
  '/dashboards/:id',
  requirePermission('reports.dashboards.view'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const out = await tx(async (client) => {
      const d = await dashboardRow(client, req.ctx, id);
      if (d.isPersonal && Number(d.createdBy) !== Number(req.auth!.id)) throw forbidden('Dashboard is private');
      const company = req.auth!.company_id == null ? null : Number(req.auth!.company_id);
      if (company !== null && d.companyId !== null && Number(d.companyId) !== company) throw forbidden('Dashboard is outside your company scope');
      return d;
    }, req.ctx);
    res.json({ data: out });
  })
);

reportAnalyticsRouter.patch(
  '/dashboards/:id',
  requirePermission('reports.dashboards.update'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const widgets = body.widgets !== undefined ? sanitizeWidgets(body.widgets) : null;
    const out = await tx(async (client) => {
      const prev = await dashboardRow(client, req.ctx, id);
      if (prev.isPersonal && Number(prev.createdBy) !== Number(req.auth!.id)) throw forbidden('Dashboard is private');
      const name = body.name !== undefined ? String(body.name).trim() : String(prev.name);
      if (!name || name.length > 150) throw badRequest('Dashboard name is required (max 150)');
      const layout = body.layout !== undefined && body.layout && typeof body.layout === 'object' && !Array.isArray(body.layout)
        ? (body.layout as Record<string, unknown>)
        : (prev.layout ?? {});
      await client.query(
        `UPDATE analytics_dashboards SET name=$3, description=$4, layout=$5, is_default=$6, updated_at=now()
         WHERE id=$1 AND tenant_id=$2 RETURNING id`,
        [
          id,
          req.ctx.tenantId ?? 0,
          name,
          body.description !== undefined ? String(body.description).trim() : String(prev.description ?? ''),
          JSON.stringify(layout),
          body.isDefault !== undefined ? body.isDefault === true || body.isDefault === 'true' : !!prev.isDefault,
        ]
      );
      if (widgets) await replaceWidgets(client, req.ctx, id, widgets);
      await logAudit(client, req.ctx, {
        action: 'update',
        resource: 'reports.dashboard',
        recordId: id,
        recordCode: name,
        oldValues: { name: prev.name, widgets: Array.isArray(prev.widgets) ? prev.widgets.length : 0 },
        newValues: { name, widgets: widgets ? widgets.length : undefined },
      });
      return dashboardRow(client, req.ctx, id);
    }, req.ctx);
    res.json({ data: out });
  })
);

reportAnalyticsRouter.delete(
  '/dashboards/:id',
  requirePermission('reports.dashboards.delete'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await tx(async (client) => {
      const prev = await dashboardRow(client, req.ctx, id);
      if (prev.isPersonal && Number(prev.createdBy) !== Number(req.auth!.id)) throw forbidden('Dashboard is private');
      const r = await client.query(
        `UPDATE analytics_dashboards SET is_archived = true, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 RETURNING id, name`,
        [id, req.ctx.tenantId ?? 0]
      );
      await logAudit(client, req.ctx, {
        action: 'archive',
        resource: 'reports.dashboard',
        recordId: id,
        recordCode: String(r.rows[0].name),
      });
    }, req.ctx);
    res.json({ data: { id } });
  })
);

/* ================================================================== */
/* /api/reports/custom — custom report builder                          */
/* ================================================================== */

reportAnalyticsRouter.get(
  '/custom',
  requirePermission('reports.builder.view'),
  asyncHandler(async (req, res) => {
    const company = req.auth!.company_id ?? null;
    const r = await query(
      `SELECT * FROM custom_reports
       WHERE tenant_id = $1 AND is_archived = false
         AND ($2::bigint IS NULL OR company_id IS NULL OR company_id = $2)
       ORDER BY updated_at DESC`,
      [req.ctx.tenantId ?? 0, company],
      req.ctx
    );
    res.json({ data: toCamelRows(r.rows as Record<string, unknown>[]) });
  })
);

reportAnalyticsRouter.post(
  '/custom',
  requirePermission('reports.builder.create'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cfg = await sanitizeCustomConfig(body);
    const out = await tx(async (client) => {
      const r = await client.query(
        `INSERT INTO custom_reports (tenant_id, company_id, created_by, name, description, data_source, config, visualization)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          req.ctx.tenantId ?? 0,
          body.companyId ?? req.ctx.companyId ?? req.auth!.company_id ?? null,
          req.auth!.id,
          cfg.name,
          cfg.description,
          cfg.dataSource,
          JSON.stringify(cfg.config),
          cfg.visualization,
        ]
      );
      await logAudit(client, req.ctx, {
        action: 'create',
        resource: 'reports.custom',
        recordId: Number(r.rows[0].id),
        recordCode: String(cfg.name),
        newValues: { name: cfg.name, dataSource: cfg.dataSource, visualization: cfg.visualization },
      });
      return toCamelRow(r.rows[0] as Record<string, unknown>);
    }, req.ctx);
    res.json({ data: out });
  })
);

reportAnalyticsRouter.get(
  '/custom/:id',
  requirePermission('reports.builder.view'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const out = await tx(async (client) => customReportRow(client, req.ctx, id), req.ctx);
    res.json({ data: out });
  })
);

reportAnalyticsRouter.patch(
  '/custom/:id',
  requirePermission('reports.builder.update'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cfg = await sanitizeCustomConfig({ ...body, name: body.name ?? 'keep', dataSource: body.dataSource ?? 'keep', visualization: body.visualization ?? 'table' });
    const out = await tx(async (client) => {
      await customReportRow(client, req.ctx, id);
      const r = await client.query(
        `UPDATE custom_reports SET name=$3, description=$4, data_source=$5, config=$6, visualization=$7, updated_at=now()
         WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [
          id,
          req.ctx.tenantId ?? 0,
          cfg.name,
          cfg.description,
          cfg.dataSource,
          JSON.stringify(cfg.config),
          cfg.visualization,
        ]
      );
      await logAudit(client, req.ctx, {
        action: 'update',
        resource: 'reports.custom',
        recordId: id,
        recordCode: String(cfg.name),
        newValues: { name: cfg.name, dataSource: cfg.dataSource, visualization: cfg.visualization },
      });
      return toCamelRow(r.rows[0] as Record<string, unknown>);
    }, req.ctx);
    res.json({ data: out });
  })
);

reportAnalyticsRouter.delete(
  '/custom/:id',
  requirePermission('reports.builder.delete'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await tx(async (client) => {
      const prev = await customReportRow(client, req.ctx, id);
      const r = await client.query(
        `UPDATE custom_reports SET is_archived = true, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [id, req.ctx.tenantId ?? 0]
      );
      await logAudit(client, req.ctx, {
        action: 'archive',
        resource: 'reports.custom',
        recordId: id,
        recordCode: String(prev.name ?? id),
      });
    }, req.ctx);
    res.json({ data: { id } });
  })
);

/** Execute a saved custom report against the live database. */
reportAnalyticsRouter.post(
  '/custom/:id/run',
  requirePermission('reports.builder.run'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const out = await tx(async (client) => {
      const rep = await customReportRow(client, req.ctx, id);
      const ds = String(rep.dataSource);
      const cols = await columnsOf(ds);
      const cfg = (rep.config ?? {}) as Record<string, unknown>;
      const selCols = Array.isArray(cfg.columns) ? (cfg.columns as string[]) : [];
      const groupBy = Array.isArray(cfg.groupBy) ? (cfg.groupBy as string[]) : [];
      const sort = (cfg.sort ?? null) as { column?: string; direction?: string } | null;
      const companyId = cols.includes('company_id') ? (req.ctx.companyId ?? req.auth!.company_id ?? null) : null;
      const filters = body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters)
        ? (body.filters as Record<string, unknown>)
        : {};
      const { where, params } = buildWhere(cols, filters, companyId);
      const selectSql = selCols.length ? selCols.map((c) => `"${c}"`).join(', ') : '*';
      const groupSql = groupBy.length ? ` GROUP BY ${groupBy.map((c) => `"${c}"`).join(', ')}` : '';
      const sortSql = sort && sort.column ? ` ORDER BY "${sort.column}" ${String(sort.direction ?? 'asc').toUpperCase()}` : '';
      const limit = Math.min(Number(cfg.limit) || 100, 500);
      const sql = `SELECT ${selectSql} FROM ${ds}${where.length ? ' WHERE ' + where.join(' AND ') : ''}${groupSql}${sortSql} LIMIT ${limit}`;
      const res = await client.query(sql, params);
      await logAudit(client, req.ctx, {
        action: 'run',
        resource: 'reports.custom',
        recordId: id,
        recordCode: String(rep.name ?? id),
        metadata: { dataSource: ds, rows: res.rows.length, columns: selCols, groupBy },
      });
      return { rows: res.rows as Record<string, unknown>[], count: res.rows.length, columns: selCols };
    }, req.ctx);
    res.json({ data: out });
  })
);
