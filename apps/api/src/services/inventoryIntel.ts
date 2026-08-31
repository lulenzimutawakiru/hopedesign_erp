import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';
import * as inv from './inventory.js';

const n = (v: unknown): number => Number(v ?? 0);
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

/** All inventory state columns exposed as one row per physical stock line. */
export async function stockPositions(client: pg.PoolClient, ctx: Ctx, productId?: number | null) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'i.tenant_id = $1 AND i.company_id = $2';
  if (productId) {
    params.push(productId);
    where += ` AND i.product_id = $${params.length}`;
  }
  const res = await client.query(
    `SELECT i.id, i.product_id, p.code AS product_code, p.name AS product_name,
            p.type AS product_type, p.gsm, i.batch_id, pb.batch_no, pb.expiry_date,
            i.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name, w.type AS warehouse_type,
            i.bin_id, b.code AS bin_code,
            i.quantity AS on_hand_qty, i.reserved_qty,
            i.allocated_qty, i.committed_qty, i.in_transit_qty, i.in_production_qty,
            i.quality_hold_qty, i.quarantine_qty, i.damaged_qty, i.blocked_qty,
            i.expired_qty, i.returned_qty, i.scrapped_qty,
            (i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty) AS available_qty,
            i.avg_cost, (i.quantity * i.avg_cost) AS stock_value
     FROM inventory i
     JOIN products p ON p.id = i.product_id
     JOIN warehouses w ON w.id = i.warehouse_id
     LEFT JOIN warehouse_bins b ON b.id = i.bin_id
     LEFT JOIN product_batches pb ON pb.id = i.batch_id
     WHERE ${where}
     ORDER BY p.code, w.code, b.code`,
    params
  );
  return toCamelRows(res.rows);
}

/** Unified operational screen: value buckets + inventory health metrics. */
export async function commandCenter(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `WITH totals AS (
       SELECT COALESCE(sum(i.quantity * i.avg_cost), 0)::numeric(18,2) AS on_hand_value,
              COALESCE(sum((i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty) * i.avg_cost), 0)::numeric(18,2) AS available_value,
              COALESCE(sum(i.reserved_qty * i.avg_cost), 0)::numeric(18,2) AS reserved_value,
              COALESCE(sum(i.in_transit_qty * i.avg_cost), 0)::numeric(18,2) AS in_transit_value,
              COALESCE(sum(i.quality_hold_qty * i.avg_cost), 0)::numeric(18,2) AS quality_hold_value,
              count(*)::int AS stock_lines,
              count(*) FILTER (WHERE i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty <= 0)::int AS stockout_lines,
              (SELECT count(*)::int FROM (
                 SELECT i2.product_id
                 FROM inventory i2
                 JOIN products p2 ON p2.id = i2.product_id
                 WHERE i2.tenant_id = $1 AND i2.company_id = $2 AND i2.quantity >= 0
                 GROUP BY i2.product_id
                 HAVING COALESCE(sum(i2.quantity - i2.reserved_qty - i2.allocated_qty - i2.blocked_qty - i2.quality_hold_qty), 0) <= COALESCE(max(p2.reorder_point), 0)
               ) low)::int AS low_stock_lines,
              count(DISTINCT pb.id) FILTER (WHERE pb.expiry_date IS NOT NULL AND pb.expiry_date <= now() + interval '30 days')::int AS expiring_batches,
              count(*) FILTER (WHERE i.quantity < 0)::int AS negative_lines
       FROM inventory i
       JOIN products p ON p.id = i.product_id
       LEFT JOIN product_batches pb ON pb.id = i.batch_id
       WHERE i.tenant_id = $1 AND i.company_id = $2
     ),
     health AS (
       SELECT
         (SELECT count(*)::int FROM quality_holds q WHERE q.tenant_id = $1 AND q.company_id = $2 AND q.status = 'HELD') AS quality_holds,
         (SELECT count(*)::int FROM inventory_adjustments a
           WHERE a.tenant_id = $1 AND a.company_id = $2 AND a.created_at >= now() - interval '7 days'
             AND EXISTS (SELECT 1 FROM inventory_adjustment_items ai
                         WHERE ai.adjustment_id = a.id AND abs(ai.variance_qty) > 100)) AS large_variances,
         (SELECT count(*)::int FROM inventory_risk_scores r
           WHERE r.tenant_id = $1 AND r.company_id = $2 AND r.risk_level = 'HIGH'
             AND r.scored_at >= now() - interval '24 hours') AS high_risk_items
     )
     SELECT t.*, h.quality_holds, h.large_variances, h.high_risk_items FROM totals t, health h`,
    [ctx.tenantId, ctx.companyId]
  );
  const core = toCamelRow(res.rows[0]);
  const alerts = await client.query(
    `SELECT id, alert_type, severity, title, message, status, product_id, warehouse_id, created_at
     FROM inventory_alerts WHERE tenant_id = $1 AND company_id = $2 AND status IN ('OPEN','ACKNOWLEDGED')
     ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, created_at DESC LIMIT 25`,
    [ctx.tenantId, ctx.companyId]
  );
  const today = await client.query(
    `SELECT movement_type, count(*)::int AS n,
            COALESCE(sum(abs(quantity)), 0)::numeric AS qty
     FROM inventory_movements
     WHERE tenant_id = $1 AND company_id = $2
       AND created_at >= now() - interval '1 day'
     GROUP BY movement_type
     ORDER BY n DESC`,
    [ctx.tenantId, ctx.companyId]
  );
  const todayTotal = today.rows.reduce((acc: number, r: { n: number }) => acc + Number(r.n), 0);
  return { ...core, today: { total: todayTotal, byType: toCamelRows(today.rows) }, alerts: toCamelRows(alerts.rows) };
}

// ============================================================
// Stock ageing analysis (buckets + dead / slow-moving stock)
// ============================================================
export async function stockAgeing(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `WITH line_age AS (
       SELECT i.id, i.product_id, p.code AS product_code, p.name AS product_name, p.type AS product_type,
              i.warehouse_id, w.code AS warehouse_code, i.bin_id, b.code AS bin_code,
              i.batch_id, pb.batch_no, i.quantity, i.reserved_qty, i.avg_cost,
              (i.quantity * i.avg_cost) AS stock_value,
              COALESCE((
                SELECT MAX(m.created_at) FROM inventory_movements m
                WHERE m.product_id = i.product_id
                  AND m.warehouse_id IS NOT DISTINCT FROM i.warehouse_id
                  AND m.bin_id IS NOT DISTINCT FROM i.bin_id
                  AND m.movement_type IN ('RECEIPT','TRANSFER_IN','PRODUCTION_OUTPUT','RETURN_IN','PUT_AWAY')
              ), pb.received_at, i.created_at) AS last_inbound_at,
              (SELECT MAX(m2.created_at) FROM inventory_movements m2
                WHERE m2.product_id = i.product_id
                  AND m2.warehouse_id IS NOT DISTINCT FROM i.warehouse_id
                  AND m2.bin_id IS NOT DISTINCT FROM i.bin_id) AS last_movement_at
       FROM inventory i
       JOIN products p ON p.id = i.product_id
       JOIN warehouses w ON w.id = i.warehouse_id
       LEFT JOIN warehouse_bins b ON b.id = i.bin_id
       LEFT JOIN product_batches pb ON pb.id = i.batch_id
       WHERE i.tenant_id = $1 AND i.company_id = $2 AND i.quantity > 0
     ),
     buckets AS (
       SELECT
         CASE
           WHEN last_inbound_at >= now() - interval '30 days' THEN '0-30d'
           WHEN last_inbound_at >= now() - interval '60 days' THEN '31-60d'
           WHEN last_inbound_at >= now() - interval '90 days' THEN '61-90d'
           WHEN last_inbound_at >= now() - interval '180 days' THEN '91-180d'
           ELSE '180d+'
         END AS bucket,
         count(*)::int AS lines,
         count(DISTINCT product_id)::int AS products,
         COALESCE(sum(quantity), 0)::numeric AS qty,
         COALESCE(sum(stock_value), 0)::numeric(18,2) AS value
       FROM line_age
       GROUP BY 1
     )
     SELECT bucket, lines, products, qty, value FROM buckets`,
    [ctx.tenantId, ctx.companyId]
  );
  const bucketOrder = ['0-30d', '31-60d', '61-90d', '91-180d', '180d+'];
  const buckets = toCamelRows(res.rows).sort(
    (a: Record<string, unknown>, b: Record<string, unknown>) => bucketOrder.indexOf(String(a.bucket)) - bucketOrder.indexOf(String(b.bucket))
  );
  const deadStock = await client.query(
    `SELECT i.id, i.product_id, p.code AS product_code, p.name AS product_name, p.type AS product_type,
            w.code AS warehouse_code, b.code AS bin_code, pb.batch_no,
            i.quantity, i.reserved_qty, i.avg_cost, (i.quantity * i.avg_cost) AS stock_value,
            TO_CHAR((SELECT MAX(m.created_at) FROM inventory_movements m
                     WHERE m.product_id = i.product_id
                       AND m.warehouse_id IS NOT DISTINCT FROM i.warehouse_id
                       AND m.bin_id IS NOT DISTINCT FROM i.bin_id), 'YYYY-MM-DD') AS last_movement_at
     FROM inventory i
     JOIN products p ON p.id = i.product_id
     JOIN warehouses w ON w.id = i.warehouse_id
     LEFT JOIN warehouse_bins b ON b.id = i.bin_id
     LEFT JOIN product_batches pb ON pb.id = i.batch_id
     WHERE i.tenant_id = $1 AND i.company_id = $2 AND i.quantity > 0
       AND NOT EXISTS (
         SELECT 1 FROM inventory_movements m
         WHERE m.product_id = i.product_id
           AND m.warehouse_id IS NOT DISTINCT FROM i.warehouse_id
           AND m.bin_id IS NOT DISTINCT FROM i.bin_id
           AND m.created_at >= now() - interval '180 days'
       )
     ORDER BY (SELECT MAX(m.created_at) FROM inventory_movements m
               WHERE m.product_id = i.product_id
                 AND m.warehouse_id IS NOT DISTINCT FROM i.warehouse_id
                 AND m.bin_id IS NOT DISTINCT FROM i.bin_id) ASC NULLS FIRST
     LIMIT 100`,
    [ctx.tenantId, ctx.companyId]
  );
  const totalValue = buckets.reduce((acc: number, x: Record<string, unknown>) => acc + Number(x.value), 0);
  const totalQty = buckets.reduce((acc: number, x: Record<string, unknown>) => acc + Number(x.qty), 0);
  return {
    buckets,
    totalValue,
    totalQty,
    deadStock: toCamelRows(deadStock.rows),
    generatedAt: new Date().toISOString(),
  };
}

// ============================================================
// ATP / CTP ? what can be promised vs produced
// ============================================================
export async function atpCtp(client: pg.PoolClient, ctx: Ctx, productId: number) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const p = await client.query(
    `SELECT id, code, name, type, reorder_point, safety_stock, lead_time_days
     FROM products WHERE id = $1 AND company_id = $2 AND tenant_id = $3`,
    [productId, companyId, ctx.tenantId]
  );
  if (p.rows.length === 0) throw notFound('Product not found');
  const product = toCamelRow(p.rows[0]);
  const stock = await client.query(
    `SELECT COALESCE(sum(i.quantity),0)::numeric AS on_hand,
            COALESCE(sum(i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty),0)::numeric AS available,
            COALESCE(sum(i.reserved_qty + i.allocated_qty + i.committed_qty),0)::numeric AS committed
     FROM inventory i
     WHERE i.product_id = $1 AND i.tenant_id = $2 AND i.company_id = $3`,
    [productId, ctx.tenantId, companyId]
  );
  const onHand = Number(stock.rows[0].on_hand);
  const available = Number(stock.rows[0].available);
  const committed = Number(stock.rows[0].committed);
  const po = await client.query(
    `SELECT COALESCE(sum(poi.quantity - poi.received_qty),0)::numeric AS qty, count(DISTINCT po.id)::int AS n
     FROM purchase_order_items poi
     JOIN purchase_orders po ON po.id = poi.order_id
     WHERE poi.product_id = $1 AND po.tenant_id = $2 AND po.company_id = $3
       AND po.status IN ('APPROVED','SUBMITTED','PARTIALLY_RECEIVED')`,
    [productId, ctx.tenantId, companyId]
  );
  const incomingPo = Number(po.rows[0].qty);
  const so = await client.query(
    `SELECT COALESCE(sum(soi.quantity - soi.allocated_qty - soi.dispatched_qty),0)::numeric AS qty, count(DISTINCT so.id)::int AS n
     FROM sales_order_items soi
     JOIN sales_orders so ON so.id = soi.order_id
     WHERE soi.product_id = $1 AND so.tenant_id = $2 AND so.company_id = $3
       AND so.status IN ('APPROVED','ALLOCATED','PARTIALLY_DISPATCHED')`,
    [productId, ctx.tenantId, companyId]
  );
  const openDemand = Number(so.rows[0].qty);
  const wo = await client.query(
    `SELECT COALESCE(sum(wo.quantity - wo.produced_qty),0)::numeric AS qty, count(DISTINCT wo.id)::int AS n
     FROM work_orders wo
     WHERE wo.product_id = $1 AND wo.tenant_id = $2 AND wo.company_id = $3
       AND wo.status IN ('APPROVED','RELEASED','IN_PROGRESS')`,
    [productId, ctx.tenantId, companyId]
  );
  const plannedProduction = Number(wo.rows[0].qty);
  const atp = Math.max(0, available + incomingPo + plannedProduction);
  const ctp = Math.max(0, atp + plannedProduction);
  return {
    product: { id: Number(product.id), code: product.code, name: product.name, type: product.type },
    onHand, available, committed,
    incomingPurchaseOrders: incomingPo, openPoCount: Number(po.rows[0].n),
    openSalesDemand: openDemand, openSoCount: Number(so.rows[0].n),
    plannedProduction, openWoCount: Number(wo.rows[0].n),
    atp, ctp,
    atpBreakdown: [
      { label: 'On-hand available', qty: available },
      { label: 'Incoming purchase orders', qty: incomingPo },
      { label: 'Planned production', qty: plannedProduction },
    ],
    ctpBreakdown: [
      { label: 'ATP', qty: atp },
      { label: 'Schedulable production', qty: plannedProduction },
    ],
    canFulfillCurrentDemand: atp >= openDemand,
  };
}

// ============================================================
// FIFO / FEFO batch suggestions
// ============================================================
export async function fifoSuggestions(
  client: pg.PoolClient,
  ctx: Ctx,
  productId: number,
  qty?: number | null,
  method: 'FIFO' | 'FEFO' = 'FIFO'
) {
  const requested: number | null = qty != null && Number(qty) > 0 ? Number(qty) : null;
  const orderBy = method === 'FEFO'
    ? `ORDER BY COALESCE(pb.expiry_date, 'infinity'::date), pb.received_at NULLS LAST, i.id`
    : `ORDER BY pb.received_at NULLS FIRST, i.id`;
  const res = await client.query(
    `SELECT i.id, i.batch_id, pb.batch_no, pb.lot_no,
            TO_CHAR(pb.received_at, 'YYYY-MM-DD') AS received_at,
            TO_CHAR(pb.expiry_date, 'YYYY-MM-DD') AS expiry_date,
            i.warehouse_id, w.code AS warehouse_code, i.bin_id, b.code AS bin_code,
            (i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty) AS available_qty,
            i.avg_cost
     FROM inventory i
     JOIN warehouses w ON w.id = i.warehouse_id
     LEFT JOIN warehouse_bins b ON b.id = i.bin_id
     LEFT JOIN product_batches pb ON pb.id = i.batch_id
     WHERE i.tenant_id = $1 AND i.company_id = $2 AND i.product_id = $3
       AND (i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty) > 0
     ${orderBy}`,
    [ctx.tenantId, ctx.companyId, productId]
  );
  const lines = toCamelRows(res.rows);
  let remaining: number = requested ?? Number.MAX_SAFE_INTEGER;
  const suggestedPlan: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(line.availableQty));
    suggestedPlan.push({ ...line, suggestedQty: take });
    remaining -= take;
  }
  return {
    method,
    requestedQty: requested,
    lines,
    suggestedPlan,
    fullyCovered: remaining <= 0,
    shortfall: requested != null ? Math.max(0, remaining) : 0,
  };
}

// ============================================================
// Traceability graph ? supplier ? PO ? GRN ? batch ? production
// ? finished goods ? handling units ? delivery ? customer
// ============================================================
export async function traceabilityGraph(client: pg.PoolClient, ctx: Ctx, batchId: number) {
  const b = await client.query(
    `SELECT pb.id, pb.product_id, p.code AS product_code, p.name AS product_name,
            pb.batch_no, pb.lot_no, pb.supplier_id, s.name AS supplier_name,
            pb.received_at, TO_CHAR(pb.expiry_date, 'YYYY-MM-DD') AS expiry_date,
            pb.quantity, pb.status
     FROM product_batches pb
     JOIN products p ON p.id = pb.product_id
     LEFT JOIN suppliers s ON s.id = pb.supplier_id
     WHERE pb.id = $1 AND pb.tenant_id = $2 AND pb.company_id = $3`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  if (b.rows.length === 0) throw notFound('Batch not found');
  const batch = toCamelRow(b.rows[0]);
  const upstream = await client.query(
    `SELECT im.id, im.movement_type, im.quantity, im.unit_cost, im.created_at,
            im.reference_type, im.reference_id, im.reference_code,
            w.code AS warehouse_code, bl.code AS bin_code
     FROM inventory_movements im
     LEFT JOIN warehouses w ON w.id = im.to_warehouse_id
     LEFT JOIN warehouse_bins bl ON bl.id = im.to_bin_id
     WHERE im.batch_id = $1 AND im.tenant_id = $2 AND im.company_id = $3
       AND im.movement_type IN ('RECEIPT','PUT_AWAY','TRANSFER_IN','RETURN_IN','ADJUSTMENT')
     ORDER BY im.created_at`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  const downstream = await client.query(
    `SELECT im.id, im.movement_type, im.quantity, im.unit_cost, im.created_at,
            im.reference_type, im.reference_id, im.reference_code, im.work_order_id,
            im.reason, w.code AS warehouse_code, bl.code AS bin_code
     FROM inventory_movements im
     LEFT JOIN warehouses w ON w.id = im.to_warehouse_id
     LEFT JOIN warehouse_bins bl ON bl.id = im.to_bin_id
     WHERE im.batch_id = $1 AND im.tenant_id = $2 AND im.company_id = $3
       AND im.movement_type IN ('ISSUE','TRANSFER_OUT','PRODUCTION_ISSUE','PRODUCTION_OUTPUT',
                                'DISPTACH','DELIVERY','CONSUMPTION','SCRAP','PICK')
     ORDER BY im.created_at`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  const workOrders = await client.query(
    `SELECT DISTINCT wo.id, wo.wo_no, wo.product_id, p.code AS output_code, p.name AS output_name,
            wo.quantity, wo.produced_qty, wo.status, wo.machine_id, m.code AS machine_code,
            TO_CHAR(wo.completed_at, 'YYYY-MM-DD HH24:MI') AS completed_at
     FROM inventory_movements im
     JOIN work_orders wo ON wo.id = im.work_order_id
     JOIN products p ON p.id = wo.product_id
     LEFT JOIN machines m ON m.id = wo.machine_id
     WHERE im.batch_id = $1 AND im.tenant_id = $2 AND im.company_id = $3`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  const customers = await client.query(
    `SELECT DISTINCT so.id AS sales_order_id, so.order_no, c.id AS customer_id, c.name AS customer_name,
            TO_CHAR(so.delivery_date, 'YYYY-MM-DD') AS delivery_date, so.status
     FROM inventory_movements im
     JOIN sales_orders so ON im.reference_type = 'sales_orders' AND im.reference_id = so.id
     JOIN customers c ON c.id = so.customer_id
     WHERE im.batch_id = $1 AND im.tenant_id = $2 AND im.company_id = $3`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  const events = await client.query(
    `SELECT te.id, te.event_type, te.action, te.biz_step, te.disposition, te.epc_list, te.kdes,
            te.source_type, te.source_id, te.source_code, te.event_time, te.device,
            u.email AS recorded_by_email
     FROM traceability_events te
     LEFT JOIN users u ON u.id = te.recorded_by
     WHERE te.batch_id = $1 AND te.tenant_id = $2 AND te.company_id = $3
     ORDER BY te.event_time`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  return {
    batch,
    upstream: toCamelRows(upstream.rows),
    downstream: toCamelRows(downstream.rows),
    workOrders: toCamelRows(workOrders.rows),
    customers: toCamelRows(customers.rows),
    events: toCamelRows(events.rows),
  };
}

// ============================================================
// Record an EPCIS-aligned traceability event
// ============================================================
export async function recordTraceabilityEvent(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    bizStep: string;
    action?: string;
    productId?: number | null;
    batchId?: number | null;
    warehouseId?: number | null;
    binId?: number | null;
    handlingUnitId?: number | null;
    epcList?: string[];
    kdes?: Record<string, unknown>;
    sourceType?: string | null;
    sourceId?: number | null;
    sourceCode?: string | null;
    eventType?: string;
    disposition?: string | null;
  }
) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const res = await client.query(
    `SELECT record_traceability_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) AS event_id`,
    [
      companyId, ctx.tenantId, input.bizStep, input.action ?? 'OBSERVE',
      input.productId ?? null, input.batchId ?? null, input.warehouseId ?? null,
      input.binId ?? null, input.handlingUnitId ?? null,
      JSON.stringify(input.epcList ?? []), JSON.stringify(input.kdes ?? {}),
      input.sourceType ?? null, input.sourceId ?? null, input.sourceCode ?? null,
      ctx.userId ?? null, ctx.device ?? null, input.eventType ?? 'OBJECT_EVENT',
      input.disposition ?? null, ctx.branchId ?? null,
    ]
  );
  const eventId = Number(res.rows[0].event_id);
  await logAudit(client, ctx, {
    action: 'record_traceability_event', resource: 'traceability_events', recordId: eventId,
    recordCode: input.sourceCode ?? undefined,
    newValues: { bizStep: input.bizStep, batchId: input.batchId ?? null },
  });
  return { eventId };
}

// ============================================================
// Batch lifecycle ? where did it come from, where did it go
// ============================================================
export async function batchLifecycle(client: pg.PoolClient, ctx: Ctx, batchId: number) {
  const b = await client.query(
    `SELECT pb.id, pb.product_id, p.code AS product_code, p.name AS product_name,
            pb.batch_no, pb.lot_no, pb.supplier_id, s.name AS supplier_name,
            pb.received_at, TO_CHAR(pb.expiry_date, 'YYYY-MM-DD') AS expiry_date,
            pb.quantity AS batch_quantity, pb.status AS batch_status,
            COALESCE(sum(i.quantity),0)::numeric AS on_hand,
            COALESCE(sum(i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty),0)::numeric AS available
     FROM product_batches pb
     JOIN products p ON p.id = pb.product_id
     LEFT JOIN suppliers s ON s.id = pb.supplier_id
     LEFT JOIN inventory i ON i.batch_id = pb.id
     WHERE pb.id = $1 AND pb.tenant_id = $2 AND pb.company_id = $3
     GROUP BY pb.id, p.id, s.id`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  if (b.rows.length === 0) throw notFound('Batch not found');
  const batch = toCamelRow(b.rows[0]);
  const locations = await client.query(
    `SELECT i.id, i.warehouse_id, w.code AS warehouse_code, i.bin_id, bl.code AS bin_code,
            i.quantity, i.reserved_qty, i.allocated_qty, i.quality_hold_qty, i.quarantine_qty,
            i.damaged_qty, i.blocked_qty
     FROM inventory i
     JOIN warehouses w ON w.id = i.warehouse_id
     LEFT JOIN warehouse_bins bl ON bl.id = i.bin_id
     WHERE i.batch_id = $1 AND i.tenant_id = $2 AND i.company_id = $3
     ORDER BY w.code, bl.code`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  const movements = await client.query(
    `SELECT im.id, im.movement_type, im.quantity, im.unit_cost, im.created_at, im.reference_type,
            im.reference_id, im.reference_code, im.work_order_id, im.reason,
            w.code AS warehouse_code, bl.code AS bin_code
     FROM inventory_movements im
     LEFT JOIN warehouses w ON w.id = im.warehouse_id
     LEFT JOIN warehouse_bins bl ON bl.id = im.bin_id
     WHERE im.batch_id = $1 AND im.tenant_id = $2 AND im.company_id = $3
     ORDER BY im.created_at DESC LIMIT 200`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  const sales = await client.query(
    `SELECT DISTINCT so.id AS sales_order_id, so.order_no, c.name AS customer_name,
            TO_CHAR(so.delivery_date, 'YYYY-MM-DD') AS delivery_date, so.status
     FROM inventory_movements im
     JOIN sales_orders so ON im.reference_type = 'sales_orders' AND im.reference_id = so.id
     JOIN customers c ON c.id = so.customer_id
     WHERE im.batch_id = $1 AND im.tenant_id = $2 AND im.company_id = $3`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  const holds = await client.query(
    `SELECT qh.id, qh.hold_no, qh.quantity, qh.released_qty, qh.status, qh.disposition,
            qh.reason, qh.warehouse_id, qh.bin_id, qh.created_at
     FROM quality_holds qh
     WHERE qh.batch_id = $1 AND qh.tenant_id = $2 AND qh.company_id = $3
     ORDER BY qh.created_at DESC`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  const recalls = await client.query(
    `SELECT rb.id, rb.recall_id, rb.batch_id, rb.quantity_affected, rb.quantity_on_hand,
            rb.quantity_in_transit, rb.quantity_with_customers, rb.status
     FROM recall_batches rb
     WHERE rb.batch_id = $1 AND rb.tenant_id = $2 AND rb.company_id = $3`,
    [batchId, ctx.tenantId, ctx.companyId]
  );
  return {
    batch,
    locations: toCamelRows(locations.rows),
    movements: toCamelRows(movements.rows),
    salesOrders: toCamelRows(sales.rows),
    qualityHolds: toCamelRows(holds.rows),
    recalls: toCamelRows(recalls.rows),
  };
}

// ============================================================
// Smart put-away - recommend the best bin for incoming stock
// ============================================================
const PRODUCT_WAREHOUSE_TYPES: Record<string, string[]> = {
  JUMBO_ROLL: ['RAW_MATERIAL'],
  PAPER_BOBBIN: ['RAW_MATERIAL'],
  REAM: ['FINISHED_GOODS'],
  SHEET: ['FINISHED_GOODS'],
  FINISHED_GOODS: ['FINISHED_GOODS'],
  PACKAGING: ['PACKAGING', 'GENERAL'],
  CONSUMABLE: ['CONSUMABLES', 'GENERAL'],
  SPARE_PART: ['SPARE_PARTS', 'GENERAL'],
  SECURITY_ITEM: ['SECURE'],
};

export async function putawayRecommendations(
  client: pg.PoolClient,
  ctx: Ctx,
  productId: number,
  qty?: number | null
) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const p = await client.query(
    `SELECT id, code, name, type, gsm, product_family, batch_controlled, storage_requirements, hazard_class
     FROM products WHERE id = $1 AND company_id = $2 AND tenant_id = $3`,
    [productId, companyId, ctx.tenantId]
  );
  if (p.rows.length === 0) throw notFound('Product not found');
  const product = toCamelRow(p.rows[0]);
  const incoming = qty != null && Number(qty) > 0 ? Number(qty) : null;
  const whTypes = PRODUCT_WAREHOUSE_TYPES[String(product.type)] ?? ['GENERAL'];

  const bins = await client.query(
    `SELECT b.id, b.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name, b.code AS bin_code,
            z.code AS zone_code, r.code AS rack_code, s.code AS shelf_code,
            COALESCE(b.capacity_qty, 0)::numeric AS capacity_qty, b.picking_priority,
            COALESCE(b.is_blocked, false) AS is_blocked, b.temperature_alert,
            COALESCE(sum(i.quantity), 0)::numeric AS used_qty, count(i.id)::int AS stock_lines
     FROM warehouse_bins b
     JOIN warehouses w ON w.id = b.warehouse_id
     LEFT JOIN warehouse_shelves s ON s.id = b.shelf_id
     LEFT JOIN warehouse_racks r ON r.id = s.rack_id
     LEFT JOIN warehouse_zones z ON z.id = r.zone_id
     LEFT JOIN inventory i ON i.bin_id = b.id AND i.tenant_id = $1 AND i.company_id = $2
     WHERE w.tenant_id = $1 AND w.company_id = $2 AND w.type = ANY($3)
       AND COALESCE(b.is_blocked, false) = false
       AND COALESCE(r.is_blocked, false) = false
       AND COALESCE(s.is_blocked, false) = false
       AND COALESCE(z.is_blocked, false) = false
     GROUP BY b.id, w.code, w.name, z.code, r.code, s.code
     ORDER BY b.picking_priority ASC, b.code`,
    [ctx.tenantId, companyId, whTypes]
  );
  const candidates = toCamelRows(bins.rows).map((b: any) => {
    const capacity = Number(b.capacityQty ?? 0);
    const used = Number(b.usedQty ?? 0);
    let score = 0;
    const reasons: string[] = [];
    if (b.zoneCode && String(product.productFamily ?? '').toLowerCase().includes(String(b.zoneCode).toLowerCase())) {
      score += 3;
      reasons.push('Same product family zone');
    }
    if (capacity > 0 && used < capacity) {
      score += 3;
      reasons.push('Available capacity');
    }
    if (Number(b.pickingPriority) <= 20) {
      score += 2;
      reasons.push('Near dispatch / high picking priority');
    }
    if (String(product.batchControlled) === 'true') {
      score += 1;
      reasons.push('FIFO compatible');
    }
    if (b.temperatureAlert) {
      score -= 2;
      reasons.push('Temperature alert on location');
    }
    return {
      warehouseId: Number(b.warehouseId), warehouseCode: b.warehouseCode,
      binId: Number(b.id), binCode: b.binCode,
      zoneCode: b.zoneCode ?? null, rackCode: b.rackCode ?? null, shelfCode: b.shelfCode ?? null,
      capacity: capacity || null, usedQty: used,
      availableQty: Math.max(0, capacity - used),
      pickingPriority: Number(b.pickingPriority),
      score, reasons,
    };
  });
  candidates.sort((a: any, b: any) => b.score - a.score || a.pickingPriority - b.pickingPriority);
  const warehouses = await client.query(
    `SELECT w.id, w.code, w.name, w.type, COALESCE(w.capacity_qty, 0)::numeric AS capacity_qty,
            COALESCE(sum(i.quantity), 0)::numeric AS used_qty
     FROM warehouses w
     LEFT JOIN inventory i ON i.warehouse_id = w.id AND i.tenant_id = $1 AND i.company_id = $2
     WHERE w.tenant_id = $1 AND w.company_id = $2 AND w.type = ANY($3)
     GROUP BY w.id ORDER BY w.code`,
    [ctx.tenantId, companyId, whTypes]
  );
  return {
    product: { id: Number(product.id), code: product.code, name: product.name, type: product.type },
    incomingQty: incoming,
    recommended: candidates.slice(0, 5),
    warehouses: toCamelRows(warehouses.rows).map((w: any) => ({
      id: Number(w.id), code: w.code, name: w.name, type: w.type,
      capacity: Number(w.capacityQty ?? 0), usedQty: Number(w.usedQty ?? 0),
      utilizationPct: Number(w.capacityQty) > 0 ? Math.round((Number(w.usedQty) / Number(w.capacityQty)) * 1000) / 10 : null,
    })),
  };
}

// ============================================================
// Cycle counting - auto-schedule counts by ABC class / frequency
// ============================================================
export async function cycleCountSchedule(client: pg.PoolClient, ctx: Ctx, warehouseId?: number | null) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const wh = warehouseId ?? null;
  const res = await client.query(
    `SELECT DISTINCT i.product_id, p.code AS product_code, p.name AS product_name,
            p.abc_class, p.cycle_count_frequency_days, i.warehouse_id, w.code AS warehouse_code
     FROM inventory i
     JOIN products p ON p.id = i.product_id
     JOIN warehouses w ON w.id = i.warehouse_id
     WHERE i.tenant_id = $1 AND i.company_id = $2
       AND ($3::bigint IS NULL OR i.warehouse_id = $3)
     ORDER BY p.code, w.code`,
    [ctx.tenantId, companyId, wh]
  );
  const products = toCamelRows(res.rows);
  if (products.length === 0) return { countId: null, countNo: null, lines: 0, warehouseId: wh };
  const noRes = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, 'COUNT']);
  const countNo = String(noRes.rows[0].code);
  const ins = await client.query(
    `INSERT INTO stock_counts
       (company_id, tenant_id, branch_id, count_no, count_type, warehouse_id, scheduled_date, due_date, is_blind, status, created_by)
     VALUES ($1,$2,$3,$4,'CYCLE',$5,CURRENT_DATE,CURRENT_DATE + 3,true,'DRAFT',$6)
     RETURNING id`,
    [companyId, ctx.tenantId, ctx.branchId ?? null, countNo, wh, ctx.userId ?? null]
  );
  const countId = Number(ins.rows[0].id);
  let lines = 0;
  for (const prod of products) {
    const whId = Number(prod.warehouseId);
    const freq = prod.cycleCountFrequencyDays != null ? Number(prod.cycleCountFrequencyDays)
      : prod.abcClass === 'A' ? 7 : prod.abcClass === 'B' ? 30 : 90;
    if (freq <= 0) continue;
    const stock = await client.query(
      `SELECT batch_id, bin_id, COALESCE(sum(quantity),0)::numeric AS qty
       FROM inventory
       WHERE product_id = $1 AND warehouse_id = $2 AND tenant_id = $3 AND company_id = $4
       GROUP BY batch_id, bin_id`,
      [Number(prod.productId), whId, ctx.tenantId, companyId]
    );
    for (const row of stock.rows) {
      await client.query(
        `INSERT INTO stock_count_lines
           (count_id, company_id, tenant_id, product_id, batch_id, warehouse_id, bin_id, system_qty, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')`,
        [countId, companyId, ctx.tenantId, Number(prod.productId), row.batch_id, whId, row.bin_id, Number(row.qty)]
      );
      lines += 1;
    }
  }
  await logAudit(client, ctx, {
    action: 'schedule_cycle_count', resource: 'stock_counts', recordId: countId,
    recordCode: countNo, newValues: { countType: 'CYCLE', warehouseId: wh, lines },
  });
  return { countId, countNo, lines, warehouseId: wh };
}

// ============================================================
// Cycle counting - blind-first entry workflow
// ============================================================
export async function enterCountLine(
  client: pg.PoolClient, ctx: Ctx, countId: number, lineId: number, countedQty: number
) {
  const c = await client.query(
    `SELECT id, is_blind, status FROM stock_counts WHERE id = $1 AND tenant_id = $2`,
    [countId, ctx.tenantId]
  );
  if (c.rows.length === 0) throw notFound('Count not found');
  const count = toCamelRow(c.rows[0]);
  const line = await client.query(
    `SELECT * FROM stock_count_lines WHERE id = $1 AND count_id = $2 AND tenant_id = $3`,
    [lineId, countId, ctx.tenantId]
  );
  if (line.rows.length === 0) throw notFound('Count line not found');
  const qty = Number(countedQty);
  if (!Number.isFinite(qty) || qty < 0) throw badRequest('Counted quantity must be a non-negative number');
  const variance = qty - Number(line.rows[0].system_qty);
  const status = Math.abs(variance) < 1e-9 ? 'MATCH' : 'VARIANCE';
  await client.query(
    `UPDATE stock_count_lines
     SET counted_qty = $1, variance_qty = $2, status = $3, counted_by = $4, counted_at = now(), updated_at = now()
     WHERE id = $5`,
    [qty, variance, status, ctx.userId ?? null, lineId]
  );
  const next = count.status === 'DRAFT' ? 'FIRST_COUNT' : count.status;
  await client.query(
    `UPDATE stock_counts SET status = $1, counted_by = $2 WHERE id = $3`,
    [next, ctx.userId ?? null, countId]
  );
  await logAudit(client, ctx, {
    action: 'enter_count_line', resource: 'stock_count_lines', recordId: lineId,
    oldValues: { countedQty: Number(line.rows[0].counted_qty ?? 0) },
    newValues: { countedQty: qty, varianceQty: variance, status },
  });
  const out = toCamelRow((await client.query(`SELECT * FROM stock_count_lines WHERE id = $1`, [lineId])).rows[0]);
  if (!count.isBlind) return { line: out, varianceQty: variance, status };
  const { systemQty, ...visible } = out;
  return { line: visible, varianceQty: variance, status, blind: true };
}

export async function reviewCountLine(
  client: pg.PoolClient, ctx: Ctx, countId: number, lineId: number, secondCountQty: number, note?: string | null
) {
  const line = await client.query(
    `SELECT * FROM stock_count_lines WHERE id = $1 AND count_id = $2 AND tenant_id = $3`,
    [lineId, countId, ctx.tenantId]
  );
  if (line.rows.length === 0) throw notFound('Count line not found');
  const qty = Number(secondCountQty);
  if (!Number.isFinite(qty) || qty < 0) throw badRequest('Second count must be a non-negative number');
  const variance = qty - Number(line.rows[0].system_qty);
  const status = Math.abs(variance) < 1e-9 ? 'MATCH' : 'REVIEWED';
  await client.query(
    `UPDATE stock_count_lines
     SET second_count_qty = $1, variance_qty = $2, status = $3, note = COALESCE($4, note),
         reviewed_by = $5, reviewed_at = now(), updated_at = now()
     WHERE id = $6`,
    [qty, variance, status, note ?? null, ctx.userId ?? null, lineId]
  );
  await client.query(
    `UPDATE stock_counts SET status = 'PENDING_REVIEW'
     WHERE id = $1 AND status IN ('FIRST_COUNT','SECOND_COUNT','IN_PROGRESS')`,
    [countId]
  );
  return toCamelRow((await client.query(`SELECT * FROM stock_count_lines WHERE id = $1`, [lineId])).rows[0]);
}

export async function approveCount(client: pg.PoolClient, ctx: Ctx, countId: number) {
  const c = await client.query(
    `UPDATE stock_counts SET status = 'APPROVED', approved_by = $1, approved_at = now()
     WHERE id = $2 AND tenant_id = $3
       AND status IN ('PENDING_REVIEW','FIRST_COUNT','SECOND_COUNT','IN_PROGRESS','DRAFT')
     RETURNING id, count_no`,
    [ctx.userId ?? null, countId, ctx.tenantId]
  );
  if (c.rows.length === 0) throw badRequest('Count is not in a reviewable state');
  await logAudit(client, ctx, {
    action: 'approve_count', resource: 'stock_counts', recordId: countId,
    recordCode: String(c.rows[0].count_no), newValues: { status: 'APPROVED' },
  });
  return { id: countId, status: 'APPROVED' };
}

export async function postCount(client: pg.PoolClient, ctx: Ctx, countId: number) {
  const c = await client.query(
    `SELECT * FROM stock_counts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [countId, ctx.tenantId]
  );
  if (c.rows.length === 0) throw notFound('Count not found');
  const count = toCamelRow(c.rows[0]);
  if (count.status !== 'APPROVED') throw badRequest(`Count must be APPROVED before posting (current: ${count.status})`);
  const lines = await client.query(
    `SELECT * FROM stock_count_lines WHERE count_id = $1 AND abs(variance_qty) > 1e-9`,
    [countId]
  );
  let adjustmentId: number | null = null;
  let adjustmentNo: string | null = null;
  if (lines.rows.length > 0) {
    const created = await inv.createAdjustment(client, ctx, {
      adjustmentType: 'CYCLE_COUNT',
      reason: `Cycle count ${count.countNo}`,
      items: lines.rows.map((l: any) => ({
        productId: Number(l.product_id), warehouseId: Number(l.warehouse_id),
        binId: l.bin_id != null ? Number(l.bin_id) : null,
        varianceQty: Number(l.variance_qty),
        reason: l.note ?? 'Cycle count variance',
      })),
    });
    adjustmentId = created.adjustmentId;
    adjustmentNo = created.adjustmentNo;
    await client.query(`UPDATE inventory_adjustments SET status = 'APPROVED' WHERE id = $1`, [adjustmentId]);
    await inv.postAdjustment(client, ctx, adjustmentId);
  }
  await client.query(
    `UPDATE stock_counts SET status = 'POSTED', posted_by = $1, posted_at = now() WHERE id = $2`,
    [ctx.userId ?? null, countId]
  );
  await client.query(
    `UPDATE stock_count_lines SET status = 'ADJUSTED', updated_at = now() WHERE count_id = $1`,
    [countId]
  );
  const bins = await client.query(
    `SELECT DISTINCT bin_id FROM stock_count_lines WHERE count_id = $1 AND bin_id IS NOT NULL`,
    [countId]
  );
  for (const b of bins.rows) {
    await client.query(`UPDATE warehouse_bins SET last_counted_at = now() WHERE id = $1`, [b.bin_id]);
  }
  await logAudit(client, ctx, {
    action: 'post_count', resource: 'stock_counts', recordId: countId,
    recordCode: String(count.countNo ?? ''),
    newValues: { status: 'POSTED', adjustmentId, adjustmentNo, varianceLines: lines.rows.length },
  });
  return { countId, status: 'POSTED', adjustmentId, adjustmentNo, varianceLines: lines.rows.length };
}

// ============================================================
// ABC / XYZ classification
// ============================================================
export async function abcXyzSnapshot(client: pg.PoolClient, ctx: Ctx) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const usage = await client.query(
    `SELECT im.product_id,
            COALESCE(sum(im.quantity * im.unit_cost) FILTER (WHERE im.created_at >= now() - interval '365 days'),0)::numeric AS annual_usage_value
     FROM inventory_movements im
     WHERE im.tenant_id = $1 AND im.company_id = $2
       AND im.movement_type IN ('ISSUE','PICK','DISPTACH','DELIVERY','PRODUCTION_ISSUE','SCRAP')
     GROUP BY im.product_id`,
    [ctx.tenantId, companyId]
  );
  const monthly = await client.query(
    `SELECT im.product_id, to_char(im.created_at, 'YYYY-MM') AS month,
            COALESCE(sum(im.quantity),0)::numeric AS qty
     FROM inventory_movements im
     WHERE im.tenant_id = $1 AND im.company_id = $2
       AND im.movement_type IN ('ISSUE','PICK','DISPTACH','DELIVERY','PRODUCTION_ISSUE')
       AND im.created_at >= date_trunc('month', now()) - interval '5 months'
     GROUP BY im.product_id, to_char(im.created_at, 'YYYY-MM')`,
    [ctx.tenantId, companyId]
  );
  const monthlyByProduct = new Map<number, Map<string, number>>();
  for (const r of monthly.rows) {
    const pid = Number(r.product_id);
    if (!monthlyByProduct.has(pid)) monthlyByProduct.set(pid, new Map());
    monthlyByProduct.get(pid)!.set(String(r.month), Number(r.qty));
  }
  const labels: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    labels.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const usageRows = toCamelRows(usage.rows).map((r: any) => {
    const values = labels.map((m) => monthlyByProduct.get(Number(r.productId))?.get(m) ?? 0);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 99;
    const xyzClass = cv < 0.2 ? 'X' : cv < 0.4 ? 'Y' : 'Z';
    return { productId: Number(r.productId), annualUsageValue: Number(r.annualUsageValue ?? 0), cv, xyzClass };
  });
  const totalValue = usageRows.reduce((s, r) => s + r.annualUsageValue, 0);
  const sorted = [...usageRows].sort((a, b) => b.annualUsageValue - a.annualUsageValue);
  const abcMap = new Map<number, string>();
  let cumulative = 0;
  for (const r of sorted) {
    cumulative += r.annualUsageValue;
    const pct = totalValue > 0 ? cumulative / totalValue : 1;
    abcMap.set(r.productId, pct < 0.8 ? 'A' : pct < 0.95 ? 'B' : 'C');
  }
  const snapshotDate = new Date().toISOString().slice(0, 10);
  let upserted = 0;
  for (const r of usageRows) {
    const abcClass = abcMap.get(r.productId) ?? 'C';
    await client.query(
      `INSERT INTO inventory_abc_xyz_snapshots
         (company_id, tenant_id, snapshot_date, product_id, abc_class, xyz_class, annual_usage_value, demand_variability)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id, snapshot_date, product_id) DO UPDATE
       SET abc_class = EXCLUDED.abc_class, xyz_class = EXCLUDED.xyz_class,
           annual_usage_value = EXCLUDED.annual_usage_value, demand_variability = EXCLUDED.demand_variability`,
      [companyId, ctx.tenantId, snapshotDate, r.productId, abcClass, r.xyzClass, r.annualUsageValue, Math.round(r.cv * 1000) / 1000]
    );
    await client.query(
      `UPDATE products SET abc_class = $1, xyz_class = $2 WHERE id = $3 AND company_id = $4 AND tenant_id = $5`,
      [abcClass, r.xyzClass, r.productId, companyId, ctx.tenantId]
    );
    upserted += 1;
  }
  await logAudit(client, ctx, {
    action: 'refresh_abc_xyz', resource: 'inventory_abc_xyz_snapshots', recordId: null,
    newValues: { snapshotDate, products: upserted, totalValue },
  });
  return {
    snapshotDate, products: upserted, totalValue,
    classifications: usageRows.map((r) => ({ ...r, abcClass: abcMap.get(r.productId) ?? 'C' })),
  };
}

// ============================================================
// Inventory valuation snapshot
// ============================================================
export async function valuationSnapshot(client: pg.PoolClient, ctx: Ctx) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const rows = await client.query(
    `SELECT i.product_id, p.code AS product_code, p.name AS product_name,
            COALESCE(sum(i.quantity),0)::numeric AS qty,
            COALESCE(sum(i.quantity * i.avg_cost),0)::numeric AS value,
            CASE WHEN sum(i.quantity) > 0 THEN sum(i.quantity * i.avg_cost) / NULLIF(sum(i.quantity),0) ELSE 0 END::numeric AS avg_cost
     FROM inventory i
     JOIN products p ON p.id = i.product_id
     WHERE i.tenant_id = $1 AND i.company_id = $2
     GROUP BY i.product_id, p.code, p.name
     ORDER BY value DESC`,
    [ctx.tenantId, companyId]
  );
  const items = toCamelRows(rows.rows);
  const totalValue = items.reduce((s, r: any) => s + Number(r.value ?? 0), 0);
  const totalQty = items.reduce((s, r: any) => s + Number(r.qty ?? 0), 0);
  const ins = await client.query(
    `INSERT INTO inventory_valuations
       (company_id, tenant_id, branch_id, valuation_date, valuation_method, total_value, total_qty, currency, snapshot, created_by)
     VALUES ($1,$2,$3,CURRENT_DATE,'WEIGHTED_AVERAGE',$4,$5,'UGX',$6,$7)
     RETURNING id`,
    [companyId, ctx.tenantId, ctx.branchId ?? null, totalValue, totalQty, JSON.stringify(items), ctx.userId ?? null]
  );
  const valuationId = Number(ins.rows[0].id);
  await logAudit(client, ctx, {
    action: 'create_valuation', resource: 'inventory_valuations', recordId: valuationId,
    newValues: { valuationDate: new Date().toISOString().slice(0, 10), totalValue, totalQty },
  });
  return toCamelRow((await client.query(`SELECT * FROM inventory_valuations WHERE id = $1`, [valuationId])).rows[0]);
}

// ============================================================
// Landed cost allocation - spread costs onto inventory
// ============================================================
export async function landedCostAllocation(client: pg.PoolClient, ctx: Ctx, landedCostId: number) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const lc = await client.query(
    `SELECT * FROM landed_costs WHERE id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE`,
    [landedCostId, ctx.tenantId, companyId]
  );
  if (lc.rows.length === 0) throw notFound('Landed cost not found');
  const cost = toCamelRow(lc.rows[0]);
  if (cost.status !== 'APPROVED') throw badRequest(`Landed cost must be APPROVED before allocation (current: ${cost.status})`);
  const lines = await client.query(
    `SELECT lcl.id, lcl.product_id, lcl.batch_id, lcl.amount, p.weight_per_unit,
            COALESCE(sum(i.quantity),0)::numeric AS stock_qty,
            COALESCE(sum(i.quantity * i.avg_cost),0)::numeric AS stock_value
     FROM landed_cost_lines lcl
     JOIN products p ON p.id = lcl.product_id
     LEFT JOIN inventory i ON i.product_id = lcl.product_id AND i.batch_id IS NOT DISTINCT FROM lcl.batch_id
       AND i.tenant_id = $2 AND i.company_id = $3
     WHERE lcl.landed_cost_id = $1 AND lcl.tenant_id = $2 AND lcl.company_id = $3
     GROUP BY lcl.id, p.weight_per_unit`,
    [landedCostId, ctx.tenantId, companyId]
  );
  const rows = toCamelRows(lines.rows);
  const method = String(cost.allocationMethod ?? 'QUANTITY');
  const weights = rows.map((r: any) => {
    if (method === 'QUANTITY') return Math.max(0, Number(r.stockQty ?? 0));
    if (method === 'WEIGHT') return Math.max(0, Number(r.stockQty ?? 0) * Number(r.weightPerUnit ?? 0));
    if (method === 'VALUE') return Math.max(0, Number(r.stockValue ?? 0));
    if (method === 'VOLUME') return Math.max(0, Number(r.stockQty ?? 0));
    return Math.max(0, Number(r.amount ?? 0));
  });
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (weightSum <= 0) throw badRequest('No allocatable quantity/value for landed cost lines');
  const totalCost = Number(cost.totalCost ?? 0);
  const allocations = rows.map((r: any, idx: number) => {
    const allocated = method === 'MANUAL' ? Number(r.amount ?? 0) : (totalCost * weights[idx]) / weightSum;
    return { productId: Number(r.productId), batchId: r.batchId != null ? Number(r.batchId) : null, allocated };
  });
  for (const a of allocations) {
    const invRows = await client.query(
      `SELECT id, quantity, avg_cost FROM inventory
       WHERE product_id = $1 AND batch_id IS NOT DISTINCT FROM $2 AND tenant_id = $3 AND company_id = $4`,
      [a.productId, a.batchId, ctx.tenantId, companyId]
    );
    const totalQty = invRows.rows.reduce((s, r) => s + Number(r.quantity), 0);
    if (totalQty <= 0) continue;
    const perUnit = a.allocated / totalQty;
    for (const ir of invRows.rows) {
      await client.query(
        `UPDATE inventory SET avg_cost = avg_cost + $1, updated_at = now() WHERE id = $2`,
        [perUnit, ir.id]
      );
    }
    if (a.batchId != null) {
      await client.query(
        `UPDATE product_batches SET unit_cost = unit_cost + $1 WHERE id = $2`,
        [perUnit, a.batchId]
      );
    }
  }
  await client.query(`UPDATE landed_costs SET status = 'POSTED' WHERE id = $1`, [landedCostId]);
  await logAudit(client, ctx, {
    action: 'allocate_landed_cost', resource: 'landed_costs', recordId: landedCostId,
    recordCode: String(cost.landedCostNo ?? ''),
    newValues: { method, totalCost, lines: allocations.length },
  });
  return { landedCostId, method, totalCost, allocations };
}

// ============================================================
// Reorder recommendations
// ============================================================
export async function reorderRecommendations(client: pg.PoolClient, ctx: Ctx) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const usage = await client.query(
    `SELECT im.product_id,
            COALESCE(sum(im.quantity) FILTER (WHERE im.created_at >= now() - interval '30 days'),0)::numeric AS monthly_issue,
            count(*) FILTER (WHERE im.created_at >= now() - interval '30 days')::int AS issue_events
     FROM inventory_movements im
     WHERE im.tenant_id = $1 AND im.company_id = $2
       AND im.movement_type IN ('ISSUE','PICK','DISPTACH','DELIVERY')
     GROUP BY im.product_id`,
    [ctx.tenantId, companyId]
  );
  const usageMap = new Map<number, { monthly: number; events: number }>();
  for (const r of usage.rows) {
    usageMap.set(Number(r.product_id), { monthly: Number(r.monthly_issue), events: Number(r.issue_events) });
  }
  const stock = await client.query(
    `SELECT i.product_id, p.code, p.name, p.type, p.safety_stock, p.reorder_point, p.lead_time_days,
            COALESCE(sum(i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty),0)::numeric AS available
     FROM inventory i
     JOIN products p ON p.id = i.product_id
     WHERE i.tenant_id = $1 AND i.company_id = $2
     GROUP BY i.product_id, p.code, p.name, p.type, p.safety_stock, p.reorder_point, p.lead_time_days`,
    [ctx.tenantId, companyId]
  );
  const recommendations: Array<Record<string, unknown>> = [];
  let upserted = 0;
  for (const r of stock.rows) {
    const available = Number(r.available);
    const reorderPoint = Number(r.reorder_point ?? 0);
    if (available >= reorderPoint) continue;
    const u = usageMap.get(Number(r.product_id)) ?? { monthly: 0, events: 0 };
    const demandForecast = u.monthly;
    const safety = Number(r.safety_stock ?? 0);
    const leadDays = Number(r.lead_time_days ?? 0);
    const recommendedQty = Math.max(0, Math.ceil(safety + (leadDays / 30) * demandForecast));
    const suggestedOrderType = r.type === 'FINISHED_GOODS' || r.type === 'REAM' ? 'PRODUCTION' : 'PURCHASE';
    const existing = await client.query(
      `SELECT id FROM reorder_recommendations
       WHERE product_id = $1 AND status = 'OPEN' AND tenant_id = $2 AND company_id = $3
       ORDER BY created_at DESC LIMIT 1`,
      [Number(r.product_id), ctx.tenantId, companyId]
    );
    if (existing.rows.length > 0) {
      await client.query(
        `UPDATE reorder_recommendations
         SET recommended_qty = $1, current_available = $2, demand_forecast = $3, safety_stock = $4,
             lead_time_days = $5, suggested_order_type = $6, basis = $7
         WHERE id = $8`,
        [recommendedQty, available, demandForecast, safety, leadDays, suggestedOrderType, 'Reorder point breach', existing.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO reorder_recommendations
           (company_id, tenant_id, product_id, recommended_qty, current_available, demand_forecast,
            safety_stock, lead_time_days, basis, suggested_order_type, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Reorder point breach',$9,'OPEN',$10)`,
        [companyId, ctx.tenantId, Number(r.product_id), recommendedQty, available, demandForecast,
         safety, leadDays, suggestedOrderType, ctx.userId ?? null]
      );
    }
    upserted += 1;
    recommendations.push({
      productId: Number(r.product_id), productCode: r.code, productName: r.name,
      available, reorderPoint, safetyStock: safety, leadTimeDays: leadDays,
      demandForecast, monthlyIssues: u.events, recommendedQty, suggestedOrderType,
    });
  }
  await logAudit(client, ctx, {
    action: 'refresh_reorder_recommendations', resource: 'reorder_recommendations', recordId: null,
    newValues: { recommendations: upserted },
  });
  return { count: upserted, recommendations };
}

// ============================================================
// Demand forecasting (moving average)
// ============================================================
export async function forecastProducts(client: pg.PoolClient, ctx: Ctx, horizonDays = 30) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const horizon = Math.max(1, Math.min(365, Number(horizonDays) || 30));
  const daily = await client.query(
    `SELECT im.product_id, p.code, p.name,
            COALESCE(sum(im.quantity) FILTER (WHERE im.created_at >= now() - interval '90 days'),0)::numeric AS qty_90d
     FROM inventory_movements im
     JOIN products p ON p.id = im.product_id
     WHERE im.tenant_id = $1 AND im.company_id = $2
       AND im.movement_type IN ('ISSUE','PICK','DISPTACH','DELIVERY','PRODUCTION_ISSUE')
     GROUP BY im.product_id, p.code, p.name`,
    [ctx.tenantId, companyId]
  );
  const stock = await client.query(
    `SELECT i.product_id,
            COALESCE(sum(i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty),0)::numeric AS available
     FROM inventory i
     WHERE i.tenant_id = $1 AND i.company_id = $2
     GROUP BY i.product_id`,
    [ctx.tenantId, companyId]
  );
  const availableMap = new Map<number, number>();
  for (const r of stock.rows) availableMap.set(Number(r.product_id), Number(r.available));
  const forecasts: Array<Record<string, unknown>> = [];
  for (const r of daily.rows) {
    const productId = Number(r.product_id);
    const avgDaily = Number(r.qty_90d) / 90;
    if (avgDaily <= 0) continue;
    const forecastQty = avgDaily * horizon;
    const available = availableMap.get(productId) ?? 0;
    const stockoutInDays = avgDaily > 0 ? Math.max(0, Math.floor(available / avgDaily)) : null;
    const ins = await client.query(
      `INSERT INTO inventory_forecasts
         (company_id, tenant_id, product_id, forecast_date, horizon_days, method, forecast_qty,
          confidence, stockout_in_days, assumptions, model_params, status, created_by)
       VALUES ($1,$2,$3,CURRENT_DATE,$4,'MOVING_AVERAGE',$5,0.7,$6,$7,'{}'::jsonb,'ACTIVE',$8)
       RETURNING id`,
      [companyId, ctx.tenantId, productId, horizon, Math.round(forecastQty * 100) / 100, stockoutInDays,
       JSON.stringify({ avgDailyIssue: Math.round(avgDaily * 1000) / 1000, windowDays: 90, basis: '90-day moving average of issue movements' }),
       ctx.userId ?? null]
    );
    forecasts.push({
      forecastId: Number(ins.rows[0].id), productId, productCode: r.code, productName: r.name,
      forecastQty: Math.round(forecastQty * 100) / 100, avgDailyIssue: Math.round(avgDaily * 1000) / 1000,
      available, stockoutInDays, confidence: 0.7,
    });
  }
  await logAudit(client, ctx, {
    action: 'refresh_forecasts', resource: 'inventory_forecasts', recordId: null,
    newValues: { horizonDays: horizon, forecasts: forecasts.length },
  });
  return { horizonDays: horizon, count: forecasts.length, forecasts };
}

// ============================================================
// Inventory risk score - fraud / shrinkage signals
// ============================================================
export async function riskScore(client: pg.PoolClient, ctx: Ctx) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const events = await client.query(
    `SELECT im.product_id,
            count(*) FILTER (WHERE im.movement_type = 'ADJUSTMENT')::int AS manual_adjustments,
            count(*) FILTER (WHERE im.movement_type = 'ADJUSTMENT'
              AND (EXTRACT(HOUR FROM im.created_at) < 6 OR EXTRACT(HOUR FROM im.created_at) >= 22))::int AS after_hours,
            count(*) FILTER (WHERE im.movement_type = 'ADJUSTMENT' AND im.quantity < 0)::int AS negative_variances
     FROM inventory_movements im
     WHERE im.tenant_id = $1 AND im.company_id = $2
       AND im.created_at >= now() - interval '30 days'
     GROUP BY im.product_id`,
    [ctx.tenantId, companyId]
  );
  const scored = toCamelRows(events.rows).map((r: any) => {
    const manualAdjustments = Number(r.manualAdjustments ?? 0);
    const afterHoursAdjustments = Number(r.afterHours ?? 0);
    const negativeVarianceEvents = Number(r.negativeVariances ?? 0);
    const score = manualAdjustments * 2 + afterHoursAdjustments * 3 + negativeVarianceEvents * 5;
    const riskLevel = score > 15 ? 'HIGH' : score > 6 ? 'MEDIUM' : 'LOW';
    return {
      productId: Number(r.productId), score, riskLevel,
      factors: { manualAdjustments, afterHoursAdjustments, negativeVarianceEvents },
    };
  });
  for (const s of scored) {
    await client.query(
      `INSERT INTO inventory_risk_scores (company_id, tenant_id, product_id, risk_level, score, factors)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [companyId, ctx.tenantId, s.productId, s.riskLevel, s.score, JSON.stringify(s.factors)]
    );
  }
  const summary = await client.query(
    `SELECT risk_level, count(*)::int AS n FROM inventory_risk_scores
     WHERE tenant_id = $1 AND company_id = $2 AND scored_at >= now() - interval '24 hours'
     GROUP BY risk_level ORDER BY risk_level`,
    [ctx.tenantId, companyId]
  );
  await logAudit(client, ctx, {
    action: 'refresh_risk_scores', resource: 'inventory_risk_scores', recordId: null,
    newValues: { scored: scored.length },
  });
  return { scoredAt: new Date().toISOString(), summary: toCamelRows(summary.rows), scores: scored };
}

// ============================================================
// Master data quality score
// ============================================================
export async function dataQualityScore(client: pg.PoolClient, ctx: Ctx) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const [pRes, cRes, iRes, bRes, sRes] = await Promise.all([
    client.query(`SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND company_id = $2`, [ctx.tenantId, companyId]),
    client.query(`SELECT count(*)::int AS n FROM uom_conversions WHERE tenant_id = $1 AND company_id = $2`, [ctx.tenantId, companyId]),
    client.query(`SELECT count(*)::int AS n FROM inventory WHERE tenant_id = $1 AND company_id = $2`, [ctx.tenantId, companyId]),
    client.query(`SELECT count(*)::int AS n FROM product_batches WHERE tenant_id = $1 AND company_id = $2`, [ctx.tenantId, companyId]),
    client.query(`SELECT count(*)::int AS n FROM serial_numbers WHERE tenant_id = $1 AND company_id = $2`, [ctx.tenantId, companyId]),
  ]);
  const population = {
    products: Number(pRes.rows[0].n),
    conversions: Number(cRes.rows[0].n),
    inventoryLines: Number(iRes.rows[0].n),
    batches: Number(bRes.rows[0].n),
    serials: Number(sRes.rows[0].n),
  };
  const issues: Array<{ code: string; label: string; count: number; population: number }> = [];
  const addIssue = async (code: string, label: string, populationKey: keyof typeof population, sql: string, params: unknown[]) => {
    const res = await client.query(sql, params);
    const count = Number(res.rows[0].n ?? 0);
    if (count > 0) issues.push({ code, label, count, population: population[populationKey] });
  };
  await addIssue('DUPLICATE_SKU', 'Duplicate SKU assigned to multiple items', 'products',
    `SELECT count(*)::int AS n FROM (SELECT sku FROM products WHERE tenant_id = $1 AND company_id = $2
       AND sku IS NOT NULL AND sku <> '' GROUP BY sku HAVING count(*) > 1) d`,
    [ctx.tenantId, companyId]);
  await addIssue('DUPLICATE_BARCODE', 'Duplicate barcode assigned to multiple items', 'products',
    `SELECT count(*)::int AS n FROM (SELECT barcode FROM products WHERE tenant_id = $1 AND company_id = $2
       AND barcode IS NOT NULL AND barcode <> '' GROUP BY barcode HAVING count(*) > 1) d`,
    [ctx.tenantId, companyId]);
  await addIssue('MISSING_UOM', 'Items missing base unit of measure', 'products',
    `SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND company_id = $2
       AND unit_id IS NULL AND status = 'ACTIVE'`,
    [ctx.tenantId, companyId]);
  await addIssue('MISSING_CATEGORY', 'Items missing category', 'products',
    `SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND company_id = $2
       AND category_id IS NULL AND status = 'ACTIVE'`,
    [ctx.tenantId, companyId]);
  await addIssue('INVALID_CONVERSION', 'Invalid unit conversions', 'conversions',
    `SELECT count(*)::int AS n FROM uom_conversions WHERE tenant_id = $1 AND company_id = $2
       AND from_unit_id = to_unit_id`,
    [ctx.tenantId, companyId]);
  await addIssue('NEGATIVE_INVENTORY', 'Stock lines with negative quantities', 'inventoryLines',
    `SELECT count(*)::int AS n FROM inventory WHERE tenant_id = $1 AND company_id = $2 AND quantity < 0`,
    [ctx.tenantId, companyId]);
  await addIssue('INVALID_AVG_COST', 'Stock lines with negative average cost', 'inventoryLines',
    `SELECT count(*)::int AS n FROM inventory WHERE tenant_id = $1 AND company_id = $2 AND avg_cost < 0`,
    [ctx.tenantId, companyId]);
  await addIssue('BATCH_MISSING_SUPPLIER', 'Batches missing supplier', 'batches',
    `SELECT count(*)::int AS n FROM product_batches WHERE tenant_id = $1 AND company_id = $2
       AND supplier_id IS NULL`,
    [ctx.tenantId, companyId]);
  await addIssue('DUPLICATE_SERIAL', 'Duplicate serial numbers', 'serials',
    `SELECT count(*)::int AS n FROM (SELECT serial_no FROM serial_numbers WHERE tenant_id = $1 AND company_id = $2
       GROUP BY serial_no HAVING count(*) > 1) d`,
    [ctx.tenantId, companyId]);
  await addIssue('INVALID_EXPIRY', 'Batches with expiry before receipt date', 'batches',
    `SELECT count(*)::int AS n FROM product_batches WHERE tenant_id = $1 AND company_id = $2
       AND expiry_date IS NOT NULL AND received_at IS NOT NULL AND expiry_date < received_at::date`,
    [ctx.tenantId, companyId]);
  const total = population.products + population.conversions + population.inventoryLines + population.batches + population.serials;
  const violations = issues.reduce((s, i) => s + i.count, 0);
  const score = total === 0 ? 100 : Math.max(0, Math.round(((total - violations) / total) * 1000) / 10);
  return { score, totalChecked: total, violations, issues, population, scoredAt: new Date().toISOString() };
}

// ============================================================
// Recall engine: identify affected batches and trace impact
// ============================================================
export async function recallEngine(client: pg.PoolClient, ctx: Ctx, productId?: number | null, batchId?: number | null) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const params: unknown[] = [ctx.tenantId, companyId];
  let where = 'b.tenant_id = $1 AND b.company_id = $2';
  if (productId) { params.push(productId); where += ` AND b.product_id = $${params.length}`; }
  if (batchId) { params.push(batchId); where += ` AND b.id = $${params.length}`; }
  const affected = await client.query(
    `SELECT b.id AS batch_id, b.batch_no, b.product_id, p.code AS product_code, p.name AS product_name,
            b.supplier_id, s.name AS supplier_name, b.received_at, b.expiry_date,
            COALESCE(sum(i.quantity),0)::numeric AS on_hand_qty,
            COALESCE(sum(i.in_transit_qty),0)::numeric AS in_transit_qty,
            COALESCE(sum(i.in_production_qty),0)::numeric AS wip_qty,
            COALESCE(sum(i.quality_hold_qty),0)::numeric AS quality_hold_qty,
            count(DISTINCT i.warehouse_id)::int AS warehouse_count
     FROM product_batches b
     JOIN products p ON p.id = b.product_id
     LEFT JOIN suppliers s ON s.id = b.supplier_id
     LEFT JOIN inventory i ON i.batch_id = b.id AND i.tenant_id = b.tenant_id AND i.company_id = b.company_id
     WHERE ${where}
     GROUP BY b.id, p.code, p.name, s.name
     ORDER BY b.batch_no`,
    params
  );
  const shipped = await client.query(
    `SELECT batch_id, COALESCE(sum(quantity),0)::numeric AS with_customers_qty
     FROM inventory_movements
     WHERE tenant_id = $1 AND company_id = $2 AND batch_id IS NOT NULL
       AND movement_type IN ('DISPTACH','DELIVERY')
     GROUP BY batch_id`,
    [ctx.tenantId, companyId]
  );
  const shippedMap = new Map<number, number>();
  for (const r of shipped.rows) shippedMap.set(Number(r.batch_id), Number(r.with_customers_qty));
  const events = await client.query(
    `SELECT im.batch_id, im.movement_type, im.quantity, im.reference_type, im.reference_code,
            im.reason, im.created_at, u.username AS user_name
     FROM inventory_movements im
     LEFT JOIN users u ON u.id = im.created_by
     WHERE im.tenant_id = $1 AND im.company_id = $2 AND im.batch_id IS NOT NULL
       AND im.created_at >= now() - interval '180 days'
     ORDER BY im.created_at DESC`,
    [ctx.tenantId, companyId]
  );
  const eventMap = new Map<number, Array<Record<string, unknown>>>();
  for (const r of events.rows) {
    const bid = Number(r.batch_id);
    if (!eventMap.has(bid)) eventMap.set(bid, []);
    eventMap.get(bid)!.push({ movementType: r.movement_type, quantity: Number(r.quantity), referenceType: r.reference_type, referenceCode: r.reference_code, reason: r.reason, at: r.created_at, user: r.user_name });
  }
  const batches = toCamelRows(affected.rows).map((r: any) => ({
    ...r,
    withCustomersQty: shippedMap.get(r.batchId) ?? 0,
    recentMovements: eventMap.get(r.batchId) ?? [],
  }));
  return { batches, totalAffected: batches.length, generatedAt: new Date().toISOString() };
}

export async function createRecall(
  client: pg.PoolClient, ctx: Ctx,
  input: { productId?: number | null; batchId?: number | null; reason: string; severity?: string; title?: string; quarantineAll?: boolean }
) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  if (!input.reason?.trim()) throw badRequest('Recall reason is required');
  const noRes = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, 'RECALL']);
  const recallNo = String(noRes.rows[0].code);
  const ins = await client.query(
    `INSERT INTO recalls (company_id, tenant_id, branch_id, recall_no, product_id, batch_id, reason,
                          severity, status, title, quarantine_all, issued_by, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$10,$11,$11)
     RETURNING id`,
    [companyId, ctx.tenantId, ctx.branchId ?? null, recallNo, input.productId ?? null, input.batchId ?? null,
     input.reason, input.severity ?? 'MAJOR', input.title ?? null, input.quarantineAll ?? false, ctx.userId ?? null]
  );
  const recallId = Number(ins.rows[0].id);
  const engine = await recallEngine(client, ctx, input.productId ?? null, input.batchId ?? null);
  let linked = 0;
  for (const b of engine.batches) {
    await client.query(
      `INSERT INTO recall_batches (recall_id, company_id, tenant_id, batch_id, quantity_affected,
        quantity_on_hand, quantity_in_transit, quantity_with_customers, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'IDENTIFIED')`,
      [recallId, companyId, ctx.tenantId, b.batchId, b.onHandQty + b.inTransitQty + b.withCustomersQty,
       b.onHandQty, b.inTransitQty, b.withCustomersQty]
    );
    linked += 1;
    if (input.quarantineAll) {
      await client.query(`UPDATE recall_batches SET status = 'QUARANTINED' WHERE recall_id = $1 AND batch_id = $2`, [recallId, b.batchId]);
      await client.query(`UPDATE product_batches SET status = 'QUARANTINE' WHERE id = $1`, [b.batchId]);
      await client.query(
        `SELECT record_traceability_event($1,$2,'RECALL','OBSERVE',$3,$4,NULL,NULL,NULL,'[]'::jsonb,$5,$6,$7,$8,$9,$10,'OBJECT_EVENT',NULL,$11)`,
        [companyId, ctx.tenantId, b.productId, b.batchId, JSON.stringify({ recallNo }), 'recall', recallId, recallNo,
         ctx.userId ?? null, ctx.device ?? null, ctx.branchId ?? null]
      );
    }
  }
  await logAudit(client, ctx, {
    action: 'create_recall', resource: 'recalls', recordId: recallId, recordCode: recallNo,
    newValues: { reason: input.reason, severity: input.severity ?? 'MAJOR', quarantineAll: input.quarantineAll ?? false, linkedBatches: linked },
  });
  return { recallId, recallNo, status: 'ACTIVE', quarantineAll: input.quarantineAll ?? false, linkedBatches: linked, batches: engine.batches };
}

// ============================================================
// Quality hold release / disposition
// ============================================================
export async function qualityHoldRelease(
  client: pg.PoolClient, ctx: Ctx, holdId: number,
  releaseQty?: number | null, disposition = 'APPROVED'
) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const allowed = ['APPROVED', 'REJECTED', 'SCRAP', 'RETURN_TO_SUPPLIER'];
  if (!allowed.includes(disposition)) throw badRequest('Invalid disposition');
  const hold = await client.query(
    `SELECT * FROM quality_holds WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [holdId, ctx.tenantId, companyId]
  );
  if (hold.rows.length === 0) throw notFound('Quality hold not found');
  const h = hold.rows[0];
  if (h.status === 'RELEASED' || h.status === 'REJECTED') throw badRequest(`Hold already ${h.status}`);
  const holdQty = Number(h.quantity);
  const alreadyReleased = Number(h.released_qty ?? 0);
  const qty = releaseQty != null && releaseQty > 0 ? Math.min(releaseQty, holdQty - alreadyReleased) : holdQty - alreadyReleased;
  if (qty <= 0) throw badRequest('Nothing left to release');
  const newReleased = alreadyReleased + qty;
  const closed = newReleased >= holdQty;
  const rejected = disposition === 'REJECTED' || disposition === 'SCRAP' || disposition === 'RETURN_TO_SUPPLIER';
  const newStatus = closed ? (rejected ? 'REJECTED' : 'RELEASED') : 'PARTIALLY_RELEASED';
  await client.query(
    `UPDATE quality_holds SET released_qty = $1, status = $2, disposition = $3, released_by = $4, released_at = now()
     WHERE id = $5`,
    [newReleased, newStatus, disposition, ctx.userId ?? null, holdId]
  );
  await client.query(
    `SELECT record_traceability_event($1,$2,'QUALITY_RELEASE','OBSERVE',$3,$4,$5,$6,NULL,'[]'::jsonb,$7,$8,$9,$10,$11,$12,'OBJECT_EVENT',$13,$14)`,
    [companyId, ctx.tenantId, h.product_id, h.batch_id, h.warehouse_id, h.bin_id,
     JSON.stringify({ holdNo: h.hold_no, releasedQty: qty }), 'quality_hold', holdId, h.hold_no,
     ctx.userId ?? null, ctx.device ?? null, disposition, ctx.branchId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'quality_hold_release', resource: 'quality_holds', recordId: holdId, recordCode: h.hold_no,
    oldValues: { status: h.status, released_qty: alreadyReleased },
    newValues: { status: newStatus, released_qty: newReleased, disposition },
  });
  return { holdId, holdNo: h.hold_no, releasedQty: newReleased, quantity: holdQty, status: newStatus, disposition };
}

// ============================================================
// KPI dashboard
// ============================================================
const round2 = (v: number | null): number | null => (v == null ? null : Math.round(v * 100) / 100);
const round4 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10000) / 10000);
const pct = (v: number | null): number | null => (v == null ? null : Math.round(v * 1000) / 10);

export async function kpis(client: pg.PoolClient, ctx: Ctx) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const stock = await client.query(
    `SELECT count(*)::int AS stock_lines,
            count(*) FILTER (WHERE i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty <= 0)::int AS stockout_lines,
            COALESCE(sum(i.quantity * i.avg_cost),0)::numeric AS inventory_value
     FROM inventory i
     WHERE i.tenant_id = $1 AND i.company_id = $2`,
    [ctx.tenantId, companyId]
  );
  const issued = await client.query(
    `SELECT COALESCE(sum(total_cost) FILTER (WHERE movement_type IN ('ISSUE','PICK','DISPTACH','DELIVERY')),0)::numeric AS cogs_30d,
            COALESCE(sum(abs(total_cost)) FILTER (WHERE movement_type = 'ADJUSTMENT'),0)::numeric AS adjustment_value,
            count(*) FILTER (WHERE movement_type = 'PICK')::int AS pick_movements,
            count(*) FILTER (WHERE movement_type = 'ADJUSTMENT')::int AS adjustments
     FROM inventory_movements
     WHERE tenant_id = $1 AND company_id = $2 AND created_at >= now() - interval '30 days'`,
    [ctx.tenantId, companyId]
  );
  const counted = await client.query(
    `SELECT count(*)::int AS counted_lines,
            count(*) FILTER (WHERE variance_qty = 0)::int AS exact_lines
     FROM stock_count_lines
     WHERE tenant_id = $1 AND company_id = $2
       AND status IN ('MATCH','REVIEWED','ADJUSTED')`,
    [ctx.tenantId, companyId]
  );
  const bins = await client.query(
    `SELECT count(*)::int AS total_bins, count(DISTINCT i.bin_id)::int AS used_bins
     FROM warehouse_bins b
     LEFT JOIN inventory i ON i.bin_id = b.id AND i.tenant_id = $1 AND i.company_id = $2
     WHERE b.warehouse_id IN (SELECT id FROM warehouses WHERE tenant_id = $1 AND company_id = $2)`,
    [ctx.tenantId, companyId]
  );
  const productsWithStock = await client.query(
    `SELECT count(DISTINCT product_id)::int AS n FROM inventory WHERE tenant_id = $1 AND company_id = $2 AND quantity > 0`,
    [ctx.tenantId, companyId]
  );
  const dead = await client.query(
    `SELECT count(DISTINCT p.id)::int AS n
     FROM products p
     JOIN inventory i ON i.product_id = p.id AND i.tenant_id = $1 AND i.company_id = $2
     WHERE p.tenant_id = $1 AND p.company_id = $2 AND i.quantity > 0
       AND NOT EXISTS (
         SELECT 1 FROM inventory_movements im
         WHERE im.product_id = p.id AND im.tenant_id = $1 AND im.company_id = $2
           AND im.movement_type IN ('ISSUE','PICK','DISPTACH','DELIVERY')
           AND im.created_at >= now() - interval '180 days'
       )`,
    [ctx.tenantId, companyId]
  );
  const totalStockLines = Number(stock.rows[0].stock_lines);
  const stockoutRate = totalStockLines ? Number(stock.rows[0].stockout_lines) / totalStockLines : null;
  const inventoryValue = Number(stock.rows[0].inventory_value);
  const cogs30d = Number(issued.rows[0].cogs_30d);
  const turnover = inventoryValue > 0 ? (cogs30d / inventoryValue) * 12 : null;
  const dio = turnover && turnover > 0 ? 365 / turnover : null;
  const accuracy = counted.rows[0].counted_lines ? Number(counted.rows[0].exact_lines) / Number(counted.rows[0].counted_lines) : null;
  const utilization = bins.rows[0].total_bins ? Number(bins.rows[0].used_bins) / Number(bins.rows[0].total_bins) : null;
  const shrinkagePct = inventoryValue > 0 ? Number(issued.rows[0].adjustment_value) / inventoryValue : null;
  const productsWithStockN = Number(productsWithStock.rows[0].n);
  const deadStockPct = productsWithStockN > 0 ? Number(dead.rows[0].n) / productsWithStockN : null;
  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      inventoryAccuracyPct: pct(accuracy),
      cycleCountAccuracyPct: pct(accuracy),
      inventoryTurnover: round2(turnover),
      daysInventoryOutstanding: dio != null ? Math.round(dio) : null,
      stockoutRatePct: pct(stockoutRate),
      fillRatePct: null,
      receivingAccuracyPct: null,
      pickingAccuracyPct: null,
      putawayAccuracyPct: null,
      shrinkagePct: pct(shrinkagePct),
      deadStockPct: pct(deadStockPct),
      warehouseUtilizationPct: pct(utilization),
      slowMovingPct: null,
      excessStockPct: null,
    },
    raw: {
      stockLines: totalStockLines,
      stockoutLines: Number(stock.rows[0].stockout_lines),
      inventoryValue: round2(inventoryValue),
      cogs30d: round2(cogs30d),
      adjustmentValue: round2(Number(issued.rows[0].adjustment_value)),
      adjustments: Number(issued.rows[0].adjustments),
      pickMovements: Number(issued.rows[0].pick_movements),
      countedLines: Number(counted.rows[0].counted_lines),
      exactLines: Number(counted.rows[0].exact_lines),
      totalBins: Number(bins.rows[0].total_bins),
      usedBins: Number(bins.rows[0].used_bins),
      deadStockItems: Number(dead.rows[0].n),
      productsWithStock: productsWithStockN,
    },
  };
}

// ============================================================
// Warehouse map (zones -> racks -> shelves -> bins)
// ============================================================
export async function warehouseMap(client: pg.PoolClient, ctx: Ctx, warehouseId: number) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const wh = await client.query(
    `SELECT w.*, COALESCE(sum(i.quantity),0)::numeric AS used_qty,
            count(DISTINCT i.bin_id)::int AS used_bins
     FROM warehouses w
     LEFT JOIN inventory i ON i.warehouse_id = w.id AND i.tenant_id = $2 AND i.company_id = $3
     WHERE w.id = $1 AND w.tenant_id = $2 AND w.company_id = $3
     GROUP BY w.id`,
    [warehouseId, ctx.tenantId, companyId]
  );
  if (wh.rows.length === 0) throw notFound('Warehouse not found');
  const zones = await client.query(
    `SELECT z.id, z.code, z.name, z.type, z.temp_min_c, z.temp_max_c, z.hazard_class, z.is_blocked,
            z.capacity_qty, z.description
     FROM warehouse_zones z WHERE z.warehouse_id = $1 ORDER BY z.code`,
    [warehouseId]
  );
  const racks = await client.query(
    `SELECT r.id, r.zone_id, r.code, r.aisle_code, r.is_blocked
     FROM warehouse_racks r
     WHERE r.zone_id IN (SELECT id FROM warehouse_zones WHERE warehouse_id = $1)
     ORDER BY r.code`,
    [warehouseId]
  );
  const shelves = await client.query(
    `SELECT s.id, s.rack_id, s.code, s.is_blocked
     FROM warehouse_shelves s
     WHERE s.rack_id IN (
       SELECT r.id FROM warehouse_racks r
       JOIN warehouse_zones z ON z.id = r.zone_id
       WHERE z.warehouse_id = $1)
     ORDER BY s.code`,
    [warehouseId]
  );
  const bins = await client.query(
    `SELECT b.id, b.warehouse_id, b.shelf_id, b.code, b.name, b.barcode, b.is_secure, b.capacity_qty,
            b.picking_priority, b.is_blocked, b.blocked_reason, b.last_counted_at, b.temperature_alert,
            COALESCE(sum(i.quantity),0)::numeric AS qty,
            COALESCE(sum(i.quantity * i.avg_cost),0)::numeric AS value,
            count(DISTINCT i.product_id)::int AS product_count
     FROM warehouse_bins b
     LEFT JOIN inventory i ON i.bin_id = b.id AND i.tenant_id = $1 AND i.company_id = $2
     WHERE b.warehouse_id = $3
     GROUP BY b.id
     ORDER BY b.code`,
    [ctx.tenantId, companyId, warehouseId]
  );
  const zoneMap = new Map<number, any>();
  for (const z of zones.rows) zoneMap.set(Number(z.id), { ...z, racks: [] });
  const rackMap = new Map<number, any>();
  for (const r of racks.rows) {
    const node = { ...r, shelves: [] };
    rackMap.set(Number(r.id), node);
    const z = zoneMap.get(Number(r.zone_id));
    if (z) z.racks.push(node);
  }
  const shelfMap = new Map<number, any>();
  for (const s of shelves.rows) {
    const node = { ...s, bins: [] };
    shelfMap.set(Number(s.id), node);
    const r = rackMap.get(Number(s.rack_id));
    if (r) r.shelves.push(node);
  }
  for (const b of bins.rows) {
    const s = shelfMap.get(Number(b.shelf_id));
    if (s) s.bins.push({ ...b });
  }
  const zoneList = [...zoneMap.values()].map((z: any) => {
    const allBins = z.racks.flatMap((r: any) => r.shelves.flatMap((s: any) => s.bins));
    const capacity = allBins.reduce((s: number, b: any) => s + Number(b.capacity_qty ?? 0), 0);
    const used = allBins.reduce((s: number, b: any) => s + Number(b.qty ?? 0), 0);
    const blocked = allBins.filter((b: any) => b.is_blocked).length;
    return {
      ...z,
      binCount: allBins.length,
      blockedBins: blocked,
      capacityQty: capacity,
      usedQty: used,
      utilizationPct: capacity > 0 ? Math.round((used / capacity) * 1000) / 10 : null,
    };
  });
  const w = wh.rows[0];
  const capacity = Number(w.capacity_qty ?? 0);
  const usedQty = Number(w.used_qty ?? 0);
  return {
    warehouse: toCamelRow(w),
    utilizationPct: capacity > 0 ? Math.round((usedQty / capacity) * 1000) / 10 : null,
    zones: zoneList,
  };
}

// ============================================================
// Handling unit contents (pallet / carton / ream hierarchy)
// ============================================================
export async function handlingUnitContents(client: pg.PoolClient, ctx: Ctx, ref: string | number) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const numeric = /^\d+$/.test(String(ref)) ? Number(ref) : null;
  let res: pg.QueryResult | null = null;
  if (numeric) {
    res = await client.query(
      `SELECT * FROM handling_units WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
      [numeric, ctx.tenantId, companyId]
    );
  }
  if (!res || res.rows.length === 0) {
    res = await client.query(
      `SELECT * FROM handling_units WHERE tenant_id = $1 AND company_id = $2
         AND (hu_no = $3 OR barcode = $3 OR sscc = $3)
       ORDER BY created_at DESC LIMIT 1`,
      [ctx.tenantId, companyId, String(ref)]
    );
  }
  if (!res || res.rows.length === 0) throw notFound('Handling unit not found');
  const hu = res.rows[0];
  const parentChain = [];
  let cur: any = hu;
  while (cur) {
    parentChain.unshift(cur);
    if (!cur.parent_id) break;
    const p = await client.query(
      `SELECT * FROM handling_units WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
      [Number(cur.parent_id), ctx.tenantId, companyId]
    );
    cur = p.rows.length ? p.rows[0] : null;
  }
  const children = await client.query(
    `SELECT * FROM handling_units WHERE parent_id = $1 AND tenant_id = $2 AND company_id = $3 ORDER BY id`,
    [hu.id, ctx.tenantId, companyId]
  );
  const items = await client.query(
    `SELECT hui.id, hui.product_id, p.code AS product_code, p.name AS product_name,
            hui.batch_id, pb.batch_no, hui.serial_id, sn.serial_no, hui.quantity
     FROM handling_unit_items hui
     JOIN products p ON p.id = hui.product_id
     LEFT JOIN product_batches pb ON pb.id = hui.batch_id
     LEFT JOIN serial_numbers sn ON sn.id = hui.serial_id
     WHERE hui.handling_unit_id = $1 AND hui.tenant_id = $2 AND hui.company_id = $3`,
    [hu.id, ctx.tenantId, companyId]
  );
  const events = await client.query(
    `SELECT te.id, te.biz_step, te.action, te.event_type, te.disposition, te.event_time,
            te.source_type, te.source_code, te.kdes, te.epc_list, te.device
     FROM traceability_events te
     WHERE te.handling_unit_id = $1 AND te.tenant_id = $2 AND te.company_id = $3
     ORDER BY te.event_time DESC LIMIT 50`,
    [hu.id, ctx.tenantId, companyId]
  );
  let location: any = null;
  if (hu.warehouse_id) {
    const loc = await client.query(
      `SELECT w.code AS warehouse_code, w.name AS warehouse_name, b.code AS bin_code
       FROM warehouses w
       LEFT JOIN warehouse_bins b ON b.id = $1 AND b.warehouse_id = w.id
       WHERE w.id = $2`,
      [hu.bin_id ?? null, hu.warehouse_id]
    );
    if (loc.rows.length) location = toCamelRow(loc.rows[0]);
  }
  return {
    handlingUnit: toCamelRow(hu),
    parentChain: parentChain.map((r) => toCamelRow(r)),
    children: toCamelRows(children.rows),
    items: toCamelRows(items.rows),
    traceabilityEvents: toCamelRows(events.rows),
    location,
  };
}

// ============================================================
// Inventory alerts
// ============================================================
const ALERT_TYPES = ['STOCKOUT','LOW_STOCK','OVERSTOCK','EXPIRY','QUALITY_HOLD','VARIANCE','SYNC_FAILED',
  'PENDING_APPROVAL','DELAYED_RECEIVING','DELAYED_PUTAWAY','DELAYED_PICKING','CAPACITY',
  'SUSPICIOUS_ADJUSTMENT','DATA_QUALITY'];

export async function alertsList(client: pg.PoolClient, ctx: Ctx, status?: string | null) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const params: unknown[] = [ctx.tenantId, companyId];
  let where = 'a.tenant_id = $1 AND a.company_id = $2';
  if (status) {
    params.push(status);
    where += ` AND a.status = $${params.length}`;
  }
  const res = await client.query(
    `SELECT a.id, a.alert_type, a.severity, a.product_id, p.code AS product_code, p.name AS product_name,
            a.warehouse_id, w.code AS warehouse_code, a.batch_id, pb.batch_no,
            a.title, a.message, a.payload, a.status, a.acknowledged_at, a.resolved_at, a.created_at
     FROM inventory_alerts a
     LEFT JOIN products p ON p.id = a.product_id
     LEFT JOIN warehouses w ON w.id = a.warehouse_id
     LEFT JOIN product_batches pb ON pb.id = a.batch_id
     WHERE ${where}
     ORDER BY a.created_at DESC LIMIT 200`,
    params
  );
  return toCamelRows(res.rows);
}

export async function alertsCreate(
  client: pg.PoolClient, ctx: Ctx,
  input: { alertType: string; severity?: string; title: string; message?: string; productId?: number | null; warehouseId?: number | null; batchId?: number | null; payload?: Record<string, unknown> }
) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  if (!ALERT_TYPES.includes(input.alertType)) throw badRequest('Invalid alert type');
  if (!input.title?.trim()) throw badRequest('Alert title is required');
  const ins = await client.query(
    `INSERT INTO inventory_alerts (company_id, tenant_id, branch_id, alert_type, severity, product_id,
                                    warehouse_id, batch_id, title, message, payload, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'OPEN')
     RETURNING id, status`,
    [companyId, ctx.tenantId, ctx.branchId ?? null, input.alertType, input.severity ?? 'WARNING',
     input.productId ?? null, input.warehouseId ?? null, input.batchId ?? null, input.title,
     input.message ?? null, JSON.stringify(input.payload ?? {})]
  );
  const alertId = Number(ins.rows[0].id);
  await logAudit(client, ctx, {
    action: 'create_alert', resource: 'inventory_alerts', recordId: alertId,
    newValues: { alertType: input.alertType, severity: input.severity ?? 'WARNING', title: input.title },
  });
  return toCamelRow(ins.rows[0]);
}

export async function alertsAcknowledge(client: pg.PoolClient, ctx: Ctx, id: number) {
  const companyId = ctx.companyId ?? null;
  const res = await client.query(
    `UPDATE inventory_alerts SET status = 'ACKNOWLEDGED', acknowledged_by = $1, acknowledged_at = now()
     WHERE id = $2 AND tenant_id = $3 AND company_id = $4
     RETURNING id, status, acknowledged_at`,
    [ctx.userId ?? null, id, ctx.tenantId, companyId]
  );
  if (res.rows.length === 0) throw notFound('Alert not found');
  await logAudit(client, ctx, { action: 'acknowledge_alert', resource: 'inventory_alerts', recordId: id });
  return toCamelRow(res.rows[0]);
}

export async function alertsResolve(client: pg.PoolClient, ctx: Ctx, id: number) {
  const companyId = ctx.companyId ?? null;
  const res = await client.query(
    `UPDATE inventory_alerts SET status = 'RESOLVED', resolved_by = $1, resolved_at = now()
     WHERE id = $2 AND tenant_id = $3 AND company_id = $4
     RETURNING id, status, resolved_at`,
    [ctx.userId ?? null, id, ctx.tenantId, companyId]
  );
  if (res.rows.length === 0) throw notFound('Alert not found');
  await logAudit(client, ctx, { action: 'resolve_alert', resource: 'inventory_alerts', recordId: id });
  return toCamelRow(res.rows[0]);
}

