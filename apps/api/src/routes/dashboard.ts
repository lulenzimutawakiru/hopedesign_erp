import { Router } from 'express';
import { query } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { asyncHandler } from '../utils.js';

export const dashboardRouter = Router();

/** Company scope condition (views carry company_id; user without a company sees all in tenant). */
function companyScope(req: import('express').Request, alias: string): string {
  return req.auth!.company_id ? `${alias}.company_id = ${req.auth!.company_id}` : '1=1';
}

dashboardRouter.get(
  '/executive',
  requirePermission('reports.executive.view'),
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const company = req.auth!.company_id;

    const stockValue = await query(
      `SELECT COALESCE(sum(stock_value),0)::numeric(18,2) AS value,
              count(*)::int AS lines,
              count(DISTINCT product_id)::int AS products
       FROM v_inventory_summary v WHERE ${companyScope(req, 'v')}`,
      [], ctx
    );

    const ar = await query(
      `SELECT COALESCE(sum(balance),0)::numeric(18,2) AS outstanding,
              count(*) FILTER (WHERE is_overdue)::int AS overdue
       FROM v_ar_aging v WHERE ${companyScope(req, 'v')}`,
      [], ctx
    );

    const ap = await query(
      `SELECT COALESCE(sum(balance),0)::numeric(18,2) AS outstanding,
              count(*) FILTER (WHERE is_overdue)::int AS overdue
       FROM v_ap_aging v WHERE ${companyScope(req, 'v')}`,
      [], ctx
    );

    const sales = await query(
      `SELECT COALESCE(sum(revenue),0)::numeric(18,2) AS revenue, sum(invoice_count)::int AS invoices
       FROM v_sales_by_month v WHERE ${companyScope(req, 'v')}
         AND month = date_trunc('month', now())`,
      [], ctx
    );

    const yieldM = await query(
      `SELECT COALESCE(sum(produced),0)::numeric(18,2) AS produced,
              COALESCE(sum(scrapped),0)::numeric(18,2) AS scrapped,
              COALESCE(sum(waste),0)::numeric(18,2) AS waste,
              CASE WHEN sum(produced) > 0 THEN round(sum(produced) / (sum(produced) + sum(scrapped) + sum(waste)) * 100, 2) END AS yield_pct
       FROM v_production_yield_by_month v WHERE ${companyScope(req, 'v')}
         AND month = date_trunc('month', now())`,
      [], ctx
    );

    const workOrders = await query(
      `SELECT count(*) FILTER (WHERE status IN ('RELEASED','IN_PROGRESS','ON_HOLD'))::int AS in_progress,
              count(*) FILTER (WHERE status IN ('COMPLETED','CLOSED'))::int AS completed,
              count(*)::int AS total
       FROM work_orders wo WHERE ${companyScope(req, 'wo')}`,
      [], ctx
    );

    const pendingApprovals = await query(
      `SELECT count(*)::int AS count FROM approval_tasks t
       JOIN workflow_instances i ON i.id = t.instance_id
       WHERE t.status = 'PENDING' AND i.tenant_id = $1 AND ($2::bigint IS NULL OR i.company_id = $2)`,
      [req.auth!.tenant_id, company], ctx
    );

    const lowStock = await query(
      `SELECT count(*)::int AS count FROM (
         SELECT i2.product_id
         FROM inventory i2
         JOIN products p2 ON p2.id = i2.product_id
         WHERE i2.quantity >= 0 AND i2.company_id = $1
         GROUP BY i2.product_id
         HAVING COALESCE(sum(i2.quantity), 0) <= COALESCE(max(p2.reorder_point), 0)
       ) low`,
      [company ?? -1], ctx
    ).catch(() => ({ rows: [{ count: 0 }] }));

    const master = await query(
      `SELECT
         (SELECT count(*)::int FROM customers c WHERE ${companyScope(req, 'c')}) AS customers,
         (SELECT count(*)::int FROM products p WHERE ${companyScope(req, 'p')} AND p.status = 'ACTIVE') AS products,
         (SELECT count(*)::int FROM sales_orders so WHERE ${companyScope(req, 'so')} AND so.status NOT IN ('CANCELLED','COMPLETED')) AS open_orders,
         (SELECT count(*)::int FROM sales_quotations q WHERE ${companyScope(req, 'q')} AND q.status IN ('DRAFT','SUBMITTED','APPROVED')) AS open_quotes,
         (SELECT count(*)::int FROM suppliers s WHERE ${companyScope(req, 's')}) AS suppliers`,
      [], ctx
    );

    res.json({
      data: {
        stockValue: Number(stockValue.rows[0].value),
        stockLines: Number(stockValue.rows[0].lines),
        stockProducts: Number(stockValue.rows[0].products),
        lowStockCount: Number(lowStock.rows[0].count),
        accountsReceivable: Number(ar.rows[0].outstanding),
        arOverdue: Number(ar.rows[0].overdue),
        accountsPayable: Number(ap.rows[0].outstanding),
        apOverdue: Number(ap.rows[0].overdue),
        monthRevenue: Number(sales.rows[0].revenue),
        monthInvoices: Number(sales.rows[0].invoices),
        monthProduced: Number(yieldM.rows[0].produced),
        monthScrapped: Number(yieldM.rows[0].scrapped),
        monthWaste: Number(yieldM.rows[0].waste),
        monthYieldPct: yieldM.rows[0].yield_pct != null ? Number(yieldM.rows[0].yield_pct) : null,
        workOrdersInProgress: Number(workOrders.rows[0].in_progress),
        workOrdersCompleted: Number(workOrders.rows[0].completed),
        workOrdersTotal: Number(workOrders.rows[0].total),
        pendingApprovals: Number(pendingApprovals.rows[0].count),
        customers: Number(master.rows[0].customers),
        products: Number(master.rows[0].products),
        openOrders: Number(master.rows[0].open_orders),
        openQuotes: Number(master.rows[0].open_quotes),
        suppliers: Number(master.rows[0].suppliers),
      },
    });
  })
);

/** Role-agnostic work feed. Authenticated users only — data is scoped, not permission-gated as a whole. */
dashboardRouter.get(
  '/work',
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const company = req.auth!.company_id;
    const tenant = req.auth!.tenant_id;
    const safe = async (sql: string, params: unknown[] = []) => {
      try {
        return await query(sql, params, ctx);
      } catch {
        return { rows: [{}] as Record<string, unknown>[] };
      }
    };
    const n = (row: Record<string, unknown> | undefined, key: string) => Number(row?.[key] ?? 0);

    const approvals = await safe(
      `SELECT count(*)::int AS count FROM approval_tasks t
       JOIN workflow_instances i ON i.id = t.instance_id
       WHERE t.status = 'PENDING' AND i.tenant_id = $1 AND ($2::bigint IS NULL OR i.company_id = $2)`,
      [tenant, company]
    );
    const lowStock = await safe(
      `SELECT count(*)::int AS count FROM (
         SELECT i2.product_id
         FROM inventory i2
         JOIN products p2 ON p2.id = i2.product_id
         WHERE i2.quantity >= 0 AND i2.company_id = $1
         GROUP BY i2.product_id
         HAVING COALESCE(sum(i2.quantity), 0) <= COALESCE(max(p2.reorder_point), 0)
       ) low`,
      [company ?? -1]
    );
    const openOrders = await safe(
      `SELECT count(*)::int AS c FROM sales_orders so WHERE ${companyScope(req, 'so')} AND so.status IN ('APPROVED','ALLOCATED','PARTIALLY_DISPATCHED')`
    );
    const draftQuotes = await safe(
      `SELECT count(*)::int AS c FROM sales_quotations q WHERE ${companyScope(req, 'q')} AND q.status IN ('DRAFT','APPROVED')`
    );
    const woHold = await safe(
      `SELECT count(*)::int AS c FROM work_orders wo WHERE ${companyScope(req, 'wo')} AND wo.status IN ('ON_HOLD','RELEASED','IN_PROGRESS')`
    );
    const ncrs = await safe(
      `SELECT count(*)::int AS c FROM ncrs n WHERE ${companyScope(req, 'n')} AND n.status <> 'CLOSED'`
    );
    const secJobs = await safe(
      `SELECT count(*)::int AS c FROM security_jobs s WHERE ${companyScope(req, 's')} AND s.status NOT IN ('DRAFT','DELIVERED','REJECTED','CANCELLED')`
    );
    const qrAnom = await safe(
      `SELECT count(*)::int AS c FROM qr_anomalies a WHERE ${companyScope(req, 'a')} AND a.status IN ('OPEN','INVESTIGATING')`
    );
    const overdueAr = await safe(
      `SELECT count(*)::int AS c, COALESCE(sum(balance),0)::numeric AS amt FROM v_ar_aging v WHERE ${companyScope(req, 'v')} AND is_overdue`
    );
    const stockValue = await safe(
      `SELECT COALESCE(sum(stock_value),0)::numeric AS value FROM v_inventory_summary v WHERE ${companyScope(req, 'v')}`
    );
    const myFollowUps = await safe(
      `SELECT count(*)::int AS c FROM activities a
       WHERE a.tenant_id = $1 AND a.assigned_to = $2 AND a.done = false AND a.due_at IS NOT NULL AND a.due_at < now()`,
      [tenant, req.auth!.id]
    );
    const myComplaints = await safe(
      `SELECT count(*)::int AS c FROM complaints cm
       WHERE cm.tenant_id = $1 AND cm.assigned_to = $2 AND cm.status IN ('OPEN','IN_PROGRESS','ESCALATED')`,
      [tenant, req.auth!.id]
    );

    const exceptions = [
      { code: 'approvals', label: 'Decisions waiting', count: n(approvals.rows[0], 'count'), href: '/inbox', severity: 'high' as const, persona: 'all' },
      { code: 'followups', label: 'Overdue follow-ups', count: n(myFollowUps.rows[0], 'c'), href: '/work', severity: 'high' as const, persona: 'commercial' },
      { code: 'complaints', label: 'Complaints on you', count: n(myComplaints.rows[0], 'c'), href: '/crm/complaints', severity: 'high' as const, persona: 'commercial' },
      { code: 'low_stock', label: 'Below reorder point', count: n(lowStock.rows[0], 'count'), href: '/inventory/stock', severity: 'high' as const, persona: 'warehouse' },
      { code: 'orders', label: 'Orders to fulfil', count: n(openOrders.rows[0], 'c'), href: '/sales/orders', severity: 'medium' as const, persona: 'commercial' },
      { code: 'quotes', label: 'Quotes to convert', count: n(draftQuotes.rows[0], 'c'), href: '/sales/quotations', severity: 'medium' as const, persona: 'commercial' },
      { code: 'plant', label: 'Live work orders', count: n(woHold.rows[0], 'c'), href: '/plant', severity: 'medium' as const, persona: 'plant' },
      { code: 'ncr', label: 'Open NCRs', count: n(ncrs.rows[0], 'c'), href: '/records/quality/ncrs', severity: 'high' as const, persona: 'quality' },
      { code: 'secure', label: 'Active secure jobs', count: n(secJobs.rows[0], 'c'), href: '/security-jobs', severity: 'high' as const, persona: 'security' },
      { code: 'qr', label: 'QR anomalies', count: n(qrAnom.rows[0], 'c'), href: '/qr/scan', severity: 'critical' as const, persona: 'security' },
      { code: 'ar', label: 'Overdue receivables', count: n(overdueAr.rows[0], 'c'), href: '/sales/invoices', severity: 'high' as const, persona: 'finance' },
    ].filter((e) => e.count > 0);

    res.json({
      data: {
        asOf: new Date().toISOString(),
        stockValue: Number(stockValue.rows[0]?.value ?? 0),
        overdueArAmount: Number(overdueAr.rows[0]?.amt ?? 0),
        exceptionCount: exceptions.reduce((s, e) => s + e.count, 0),
        exceptions,
      },
    });
  })
);

dashboardRouter.get(
  '/my-work',
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const userId = req.auth!.id;
    const tenant = req.auth!.tenant_id;
    const company = req.auth!.company_id;
    const safe = async (sql: string, params: unknown[] = []) => {
      try { return await query(sql, params, ctx); } catch { return { rows: [] as Record<string, unknown>[] }; }
    };
    const tasks = await safe(
      `SELECT id, title, status, due_at, created_at, entity_type, entity_id, priority
       FROM user_tasks
       WHERE tenant_id = $1 AND user_id = $2 AND status NOT IN ('DONE','CANCELLED')
       ORDER BY id DESC LIMIT 20`,
      [tenant, userId]
    );
    const approvals = await safe(
      `SELECT t.id AS task_id, i.entity_type, i.entity_id, i.entity_code, t.step_name AS step_label, t.status, t.created_at, t.due_at
       FROM approval_tasks t JOIN workflow_instances i ON i.id = t.instance_id
       WHERE t.status = 'PENDING' AND i.tenant_id = $1
         AND (t.approver_user_id = $2 OR EXISTS (
           SELECT 1 FROM user_roles ur WHERE ur.user_id = $2 AND ur.role_id = t.approver_role_id
         ))
       ORDER BY t.id DESC LIMIT 20`,
      [tenant, userId]
    );
    const wos = await safe(
      `SELECT wo.id, wo.wo_no, wo.status, wo.quantity, wo.produced_qty, p.name AS product_name, m.code AS machine_code
       FROM work_orders wo
       LEFT JOIN products p ON p.id = wo.product_id
       LEFT JOIN machines m ON m.id = wo.machine_id
       WHERE wo.tenant_id = $1 AND ($2::bigint IS NULL OR wo.company_id = $2)
         AND wo.status IN ('RELEASED','IN_PROGRESS','ON_HOLD')
         AND wo.operator_id = $3
       ORDER BY wo.id DESC LIMIT 20`,
      [tenant, company, userId]
    );
    const leads = await safe(
      `SELECT l.id, l.lead_no, l.company_name, l.first_name, l.last_name, l.status, l.value,
              COALESCE((l.attributes->>'score')::int, 0) AS score
       FROM leads l
       WHERE l.tenant_id = $1 AND ($2::bigint IS NULL OR l.company_id = $2)
         AND l.status IN ('NEW','CONTACTED','QUALIFIED')
         AND (l.assigned_to = $3 OR l.owner_user_id = $3)
       ORDER BY l.id DESC LIMIT 12`,
      [tenant, company, userId]
    );
    const opps = await safe(
      `SELECT o.id, o.name, o.stage, o.status, o.amount, o.probability, c.name AS customer_name
       FROM opportunities o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.tenant_id = $1 AND ($2::bigint IS NULL OR o.company_id = $2)
         AND o.status IN ('OPEN','ON_HOLD') AND o.owner_user_id = $3
       ORDER BY o.probability DESC, o.amount DESC LIMIT 12`,
      [tenant, company, userId]
    );
    const activities = await safe(
      `SELECT id, entity_type, entity_id, activity_type, subject, due_at, done,
              (due_at IS NOT NULL AND due_at < now()) AS overdue
       FROM activities
       WHERE tenant_id = $1 AND ($2::bigint IS NULL OR company_id = $2)
         AND done = false AND assigned_to = $3
       ORDER BY due_at NULLS LAST, id DESC LIMIT 20`,
      [tenant, company, userId]
    );
    const complaints = await safe(
      `SELECT cm.id, cm.complaint_no, cm.subject, cm.priority, cm.status, c.name AS customer_name
       FROM complaints cm JOIN customers c ON c.id = cm.customer_id
       WHERE cm.tenant_id = $1 AND ($2::bigint IS NULL OR cm.company_id = $2)
         AND cm.status IN ('OPEN','IN_PROGRESS','ESCALATED') AND cm.assigned_to = $3
       ORDER BY cm.id DESC LIMIT 12`,
      [tenant, company, userId]
    );
    const unread = await safe(
      `SELECT count(*)::int AS c FROM notifications n
       WHERE n.tenant_id = $1 AND n.user_id = $2 AND n.read_at IS NULL`,
      [tenant, userId]
    );
    res.json({
      data: {
        tasks: tasks.rows,
        approvals: approvals.rows,
        workOrders: wos.rows,
        leads: leads.rows,
        opportunities: opps.rows,
        activities: activities.rows,
        complaints: complaints.rows,
        counts: {
          tasks: tasks.rows.length,
          approvals: approvals.rows.length,
          workOrders: wos.rows.length,
          leads: leads.rows.length,
          opportunities: opps.rows.length,
          activities: activities.rows.length,
          complaints: complaints.rows.length,
          unread: Number(unread.rows[0]?.c ?? 0),
          overdue: activities.rows.filter((r) => r.overdue === true || r.overdue === 't').length,
        },
      },
    });
  })
);

dashboardRouter.get(
  '/activity',
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    try {
      const out = await query(
        `SELECT e.id, e.event_type, e.entity_type, e.entity_id, e.entity_code, e.severity, e.created_at,
                u.first_name, u.last_name
         FROM system_events e
         LEFT JOIN users u ON u.id = e.user_id
         WHERE e.tenant_id = $1 AND ($2::bigint IS NULL OR e.company_id = $2)
         ORDER BY e.id DESC LIMIT 40`,
        [req.auth!.tenant_id, req.auth!.company_id],
        ctx
      );
      res.json({ data: out.rows });
    } catch {
      res.json({ data: [] });
    }
  })
);

dashboardRouter.get(
  '/rooms/plant',
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const scope = companyScope(req, 'wo');
    const today = await query(
      `SELECT COALESCE(sum(quantity),0)::numeric AS planned,
              COALESCE(sum(produced_qty),0)::numeric AS produced,
              COALESCE(sum(waste_qty),0)::numeric AS waste,
              COALESCE(sum(scrapped_qty),0)::numeric AS scrap,
              count(*)::int AS orders
       FROM work_orders wo WHERE ${scope} AND wo.status IN ('RELEASED','IN_PROGRESS','ON_HOLD','COMPLETED')
         AND (wo.start_date = CURRENT_DATE OR wo.started_at::date = CURRENT_DATE OR wo.due_date = CURRENT_DATE
              OR wo.status IN ('RELEASED','IN_PROGRESS'))`,
      [], ctx
    ).catch(() => ({ rows: [{ planned: 0, produced: 0, waste: 0, scrap: 0, orders: 0 }] }));
    const machines = await query(
      `SELECT id, code, name, status, type FROM machines WHERE ${companyScope(req, 'machines')} ORDER BY code`,
      [], ctx
    ).catch(() => ({ rows: [] }));
    const live = await query(
      `SELECT wo.id, wo.wo_no, wo.status, wo.quantity, wo.produced_qty, wo.waste_qty, p.name AS product_name, m.code AS machine_code
       FROM work_orders wo
       LEFT JOIN products p ON p.id = wo.product_id
       LEFT JOIN machines m ON m.id = wo.machine_id
       WHERE ${scope} AND wo.status IN ('RELEASED','IN_PROGRESS','ON_HOLD')
       ORDER BY wo.id DESC LIMIT 15`,
      [], ctx
    ).catch(() => ({ rows: [] }));
    const t = today.rows[0] ?? {};
    const planned = Number(t.planned ?? 0);
    const produced = Number(t.produced ?? 0);
    res.json({
      data: {
        planned, produced,
        remaining: Math.max(0, planned - produced),
        waste: Number(t.waste ?? 0),
        scrap: Number(t.scrap ?? 0),
        orders: Number(t.orders ?? 0),
        efficiency: planned > 0 ? Math.round((produced / planned) * 1000) / 10 : 0,
        wastePct: produced > 0 ? Math.round((Number(t.waste ?? 0) / produced) * 1000) / 10 : 0,
        machines: machines.rows,
        live: live.rows,
      },
    });
  })
);

dashboardRouter.get(
  '/rooms/warehouse',
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const company = req.auth!.company_id;
    const safe = async (sql: string, params: unknown[] = []) => {
      try { return await query(sql, params, ctx); } catch { return { rows: [{ c: 0 }] }; }
    };
    const received = await safe(`SELECT count(*)::int AS c FROM goods_receipts g WHERE ${companyScope(req, 'g')} AND g.created_at::date = CURRENT_DATE`);
    const dispatched = await safe(`SELECT count(*)::int AS c FROM delivery_notes d WHERE ${companyScope(req, 'd')} AND d.dispatch_date = CURRENT_DATE`);
    const transfers = await safe(`SELECT count(*)::int AS c FROM inventory_transfers t WHERE ${companyScope(req, 't')} AND t.created_at::date = CURRENT_DATE`);
    const alerts = await safe(
      `SELECT count(*)::int AS c FROM inventory i JOIN products p ON p.id = i.product_id
       WHERE i.company_id = $1 AND i.quantity <= COALESCE(p.reorder_point,0)`,
      [company ?? -1]
    );
    const moves = await safe(
      `SELECT count(*)::int AS c FROM inventory_movements m WHERE ${companyScope(req, 'm')} AND m.created_at::date = CURRENT_DATE`
    );
    res.json({
      data: {
        received: Number(received.rows[0]?.c ?? 0),
        dispatched: Number(dispatched.rows[0]?.c ?? 0),
        transfers: Number(transfers.rows[0]?.c ?? 0),
        alerts: Number(alerts.rows[0]?.c ?? 0),
        moves: Number(moves.rows[0]?.c ?? 0),
      },
    });
  })
);

dashboardRouter.get(
  '/rooms/finance',
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const ar = await query(`SELECT COALESCE(sum(balance),0)::numeric AS amt, count(*) FILTER (WHERE is_overdue)::int AS overdue FROM v_ar_aging v WHERE ${companyScope(req, 'v')}`, [], ctx).catch(() => ({ rows: [{ amt: 0, overdue: 0 }] }));
    const ap = await query(`SELECT COALESCE(sum(balance),0)::numeric AS amt FROM v_ap_aging v WHERE ${companyScope(req, 'v')}`, [], ctx).catch(() => ({ rows: [{ amt: 0 }] }));
    const sales = await query(`SELECT COALESCE(sum(revenue),0)::numeric AS revenue FROM v_sales_by_month v WHERE ${companyScope(req, 'v')} AND month = date_trunc('month', now())`, [], ctx).catch(() => ({ rows: [{ revenue: 0 }] }));
    const cash = await query(`SELECT COALESCE(sum(opening_balance),0)::numeric AS amt FROM bank_accounts b WHERE ${companyScope(req, 'b')} AND b.is_active = true`, [], ctx).catch(() => ({ rows: [{ amt: 0 }] }));
    res.json({
      data: {
        revenue: Number(sales.rows[0]?.revenue ?? 0),
        ar: Number(ar.rows[0]?.amt ?? 0),
        arOverdue: Number(ar.rows[0]?.overdue ?? 0),
        ap: Number(ap.rows[0]?.amt ?? 0),
        cash: Number(cash.rows[0]?.amt ?? 0),
      },
    });
  })
);
