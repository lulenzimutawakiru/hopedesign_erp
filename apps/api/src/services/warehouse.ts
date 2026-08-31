import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { postMove } from './inventory.js';
import { createGoodsReceipt } from './procurement.js';
import { allocateOrder, dispatchOrder } from './sales.js';
import { issueMaterial } from './production.js';
import { logAudit } from './audit.js';

export async function workQueue(client: pg.PoolClient, ctx: Ctx) {
  const inbound = await client.query(
    `SELECT count(*)::int AS docs,
            COALESCE(sum(poi.quantity - poi.received_qty), 0)::numeric AS units
     FROM purchase_orders po
     JOIN purchase_order_items poi ON poi.order_id = po.id
     WHERE po.tenant_id = $1 AND po.company_id = $2
       AND po.status IN ('APPROVED', 'PARTIALLY_RECEIVED')
       AND poi.quantity > poi.received_qty`,
    [ctx.tenantId, ctx.companyId]
  );
  const outbound = await client.query(
    `SELECT count(DISTINCT so.id)::int AS docs,
            COALESCE(sum(soi.quantity - soi.dispatched_qty), 0)::numeric AS units
     FROM sales_orders so
     JOIN sales_order_items soi ON soi.order_id = so.id
     WHERE so.tenant_id = $1 AND so.company_id = $2
       AND so.status IN ('APPROVED', 'ALLOCATED', 'PARTIALLY_DISPATCHED')
       AND soi.quantity > soi.dispatched_qty`,
    [ctx.tenantId, ctx.companyId]
  );
  const production = await client.query(
    `SELECT count(DISTINCT wo.id)::int AS docs,
            COALESCE(sum(wm.required_qty - wm.issued_qty), 0)::numeric AS units
     FROM work_orders wo
     JOIN work_order_materials wm ON wm.work_order_id = wo.id
     WHERE wo.tenant_id = $1 AND wo.company_id = $2
       AND wo.status IN ('RELEASED', 'IN_PROGRESS', 'ON_HOLD')
       AND wm.required_qty > wm.issued_qty`,
    [ctx.tenantId, ctx.companyId]
  );
  const reserved = await client.query(
    `SELECT count(*)::int AS lines, COALESCE(sum(quantity), 0)::numeric AS units
     FROM inventory_reservations
     WHERE tenant_id = $1 AND company_id = $2 AND status = 'ACTIVE'`,
    [ctx.tenantId, ctx.companyId]
  );
  const low = await client.query(
    `SELECT count(*)::int AS n
     FROM (
       SELECT i.product_id
       FROM inventory i JOIN products p ON p.id = i.product_id
       WHERE i.tenant_id = $1 AND i.company_id = $2 AND i.quantity >= 0
       GROUP BY i.product_id
       HAVING COALESCE(sum(i.quantity), 0) <= COALESCE(max(p.reorder_point), 0)
     ) low`,
    [ctx.tenantId, ctx.companyId]
  );
  return {
    inbound: toCamelRow(inbound.rows[0]),
    outbound: toCamelRow(outbound.rows[0]),
    production: toCamelRow(production.rows[0]),
    reserved: toCamelRow(reserved.rows[0]),
    lowStock: Number(low.rows[0].n),
  };
}

export async function inboundQueue(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT po.id AS po_id, po.po_no, po.status, po.order_date, po.expected_date,
            s.id AS supplier_id, s.code AS supplier_code, s.name AS supplier_name,
            poi.id AS po_item_id, poi.product_id, p.code AS product_code, p.name AS product_name,
            p.type AS product_type, poi.quantity, poi.received_qty,
            (poi.quantity - poi.received_qty) AS remaining_qty, poi.unit_price
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN purchase_order_items poi ON poi.order_id = po.id
     JOIN products p ON p.id = poi.product_id
     WHERE po.tenant_id = $1 AND po.company_id = $2
       AND po.status IN ('APPROVED', 'PARTIALLY_RECEIVED')
       AND poi.quantity > poi.received_qty
     ORDER BY po.expected_date NULLS LAST, po.id, poi.id`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function receivePurchaseOrder(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    poId: number;
    deliveryRef?: string | null;
    notes?: string | null;
    items: { poItemId: number; productId: number; quantityReceived: number; unitCost?: number; batchNo?: string | null; expiryDate?: string | null }[];
  }
) {
  if (!input.items?.length) throw badRequest('Receive at least one line');
  const out = await createGoodsReceipt(client, ctx, {
    poId: input.poId,
    deliveryRef: input.deliveryRef ?? null,
    notes: input.notes ?? 'Warehouse receive',
    items: input.items,
  });
  return out;
}

export async function outboundQueue(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT so.id AS order_id, so.order_no, so.status, so.order_date, so.requested_date,
            c.id AS customer_id, c.code AS customer_code, c.name AS customer_name,
            soi.id AS order_item_id, soi.product_id, p.code AS product_code, p.name AS product_name,
            soi.quantity, soi.allocated_qty, soi.dispatched_qty,
            (soi.quantity - soi.dispatched_qty) AS remaining_qty,
            COALESCE((
              SELECT sum(i.quantity - i.reserved_qty) FROM inventory i
              WHERE i.product_id = soi.product_id AND i.tenant_id = so.tenant_id AND i.company_id = so.company_id
            ), 0)::numeric AS available_qty
     FROM sales_orders so
     JOIN customers c ON c.id = so.customer_id
     JOIN sales_order_items soi ON soi.order_id = so.id
     JOIN products p ON p.id = soi.product_id
     WHERE so.tenant_id = $1 AND so.company_id = $2
       AND so.status IN ('APPROVED', 'ALLOCATED', 'PARTIALLY_DISPATCHED')
       AND soi.quantity > soi.dispatched_qty
     ORDER BY so.requested_date NULLS LAST, so.id, soi.id`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function allocateSalesOrder(client: pg.PoolClient, ctx: Ctx, orderId: number) {
  return allocateOrder(client, ctx, orderId);
}

export async function pickAndDispatch(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    orderId: number;
    items: { orderItemId: number; quantity: number; batchId?: number | null; qrId?: number | null }[];
    notes?: string | null;
  }
) {
  if (!input.items?.length) throw badRequest('Pick at least one line');
  return dispatchOrder(client, ctx, {
    orderId: input.orderId,
    items: input.items,
    notes: input.notes ?? 'Warehouse pick / dispatch',
  });
}

export async function productionQueue(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT wo.id AS work_order_id, wo.wo_no, wo.status, wo.quantity AS wo_qty,
            fp.code AS fg_code, fp.name AS fg_name,
            wm.id AS material_id, wm.product_id, mp.code AS product_code, mp.name AS product_name,
            wm.required_qty, wm.issued_qty,
            (wm.required_qty - wm.issued_qty) AS remaining_qty,
            COALESCE((
              SELECT sum(i.quantity - i.reserved_qty) FROM inventory i
              WHERE i.product_id = wm.product_id AND i.tenant_id = wo.tenant_id AND i.company_id = wo.company_id
            ), 0)::numeric AS available_qty
     FROM work_orders wo
     JOIN products fp ON fp.id = wo.product_id
     JOIN work_order_materials wm ON wm.work_order_id = wo.id
     JOIN products mp ON mp.id = wm.product_id
     WHERE wo.tenant_id = $1 AND wo.company_id = $2
       AND wo.status IN ('RELEASED', 'IN_PROGRESS', 'ON_HOLD')
       AND wm.required_qty > wm.issued_qty
     ORDER BY wo.due_date NULLS LAST, wo.id, wm.id`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function issueToWorkOrder(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { workOrderId: number; materialId: number; quantity: number; warehouseId?: number | null; batchId?: number | null; binId?: number | null }
) {
  return issueMaterial(client, ctx, input);
}

export async function listBins(client: pg.PoolClient, ctx: Ctx, warehouseId?: number | null) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['w.tenant_id = $1', 'w.company_id = $2'];
  if (warehouseId) {
    params.push(warehouseId);
    where.push(`b.warehouse_id = $${params.length}`);
  }
  const res = await client.query(
    `SELECT b.id, b.code, b.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name
     FROM warehouse_bins b
     JOIN warehouses w ON w.id = b.warehouse_id
     WHERE ${where.join(' AND ')}
     ORDER BY w.code, b.code`,
    params
  );
  return toCamelRows(res.rows);
}

export async function putaway(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    productId: number;
    quantity: number;
    fromWarehouseId: number;
    toWarehouseId: number;
    fromBinId?: number | null;
    toBinId?: number | null;
    batchId?: number | null;
    reason?: string | null;
  }
) {
  if (!(input.quantity > 0)) throw badRequest('Putaway quantity must be positive');
  const id = await postMove(client, ctx, {
    movementType: 'TRANSFER_OUT',
    product: input.productId,
    batch: input.batchId ?? null,
    fromWarehouse: input.fromWarehouseId,
    fromBin: input.fromBinId ?? null,
    toWarehouse: input.toWarehouseId,
    toBin: input.toBinId ?? null,
    quantity: input.quantity,
    reason: input.reason ?? 'Put away',
    refType: 'putaway',
    refCode: 'PUTAWAY',
  });
  await logAudit(client, ctx, {
    action: 'putaway',
    resource: 'inventory',
    recordId: id,
    newValues: input as unknown as Record<string, unknown>,
  });
  return { movementId: id };
}

export async function demandBoard(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `WITH on_hand AS (
       SELECT product_id,
              sum(quantity)::numeric AS qty,
              sum(reserved_qty)::numeric AS reserved
       FROM inventory
       WHERE tenant_id = $1 AND company_id = $2
       GROUP BY product_id
     ),
     sales_d AS (
       SELECT soi.product_id, sum(soi.quantity - soi.dispatched_qty)::numeric AS qty
       FROM sales_order_items soi
       JOIN sales_orders so ON so.id = soi.order_id
       WHERE so.tenant_id = $1 AND so.company_id = $2
         AND so.status IN ('APPROVED', 'ALLOCATED', 'PARTIALLY_DISPATCHED')
         AND soi.quantity > soi.dispatched_qty
       GROUP BY soi.product_id
     ),
     wo_d AS (
       SELECT wm.product_id, sum(wm.required_qty - wm.issued_qty)::numeric AS qty
       FROM work_order_materials wm
       JOIN work_orders wo ON wo.id = wm.work_order_id
       WHERE wo.tenant_id = $1 AND wo.company_id = $2
         AND wo.status IN ('RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'APPROVED')
         AND wm.required_qty > wm.issued_qty
       GROUP BY wm.product_id
     ),
     incoming AS (
       SELECT poi.product_id, sum(poi.quantity - poi.received_qty)::numeric AS qty
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.order_id
       WHERE po.tenant_id = $1 AND po.company_id = $2
         AND po.status IN ('APPROVED', 'PARTIALLY_RECEIVED', 'SUBMITTED')
         AND poi.quantity > poi.received_qty
       GROUP BY poi.product_id
     ),
     planned AS (
       SELECT ppi.product_id, sum(ppi.quantity)::numeric AS qty
       FROM production_plan_items ppi
       JOIN production_plans pp ON pp.id = ppi.plan_id
       WHERE pp.tenant_id = $1 AND pp.company_id = $2
         AND pp.status IN ('APPROVED', 'IN_EXECUTION')
       GROUP BY ppi.product_id
     )
     SELECT p.id AS product_id, p.code, p.name, p.type, p.reorder_point, p.safety_stock,
            COALESCE(h.qty, 0) AS on_hand,
            COALESCE(h.reserved, 0) AS reserved,
            (COALESCE(h.qty, 0) - COALESCE(h.reserved, 0)) AS available,
            COALESCE(s.qty, 0) AS sales_demand,
            COALESCE(w.qty, 0) AS production_demand,
            COALESCE(i.qty, 0) AS incoming_po,
            COALESCE(pl.qty, 0) AS planned_output,
            (COALESCE(h.qty, 0) - COALESCE(h.reserved, 0) + COALESCE(i.qty, 0) + COALESCE(pl.qty, 0)
              - COALESCE(s.qty, 0) - COALESCE(w.qty, 0)) AS atp
     FROM products p
     LEFT JOIN on_hand h ON h.product_id = p.id
     LEFT JOIN sales_d s ON s.product_id = p.id
     LEFT JOIN wo_d w ON w.product_id = p.id
     LEFT JOIN incoming i ON i.product_id = p.id
     LEFT JOIN planned pl ON pl.product_id = p.id
     WHERE p.tenant_id = $1 AND p.company_id = $2 AND p.status = 'ACTIVE'
       AND (
         COALESCE(h.qty, 0) > 0 OR COALESCE(s.qty, 0) > 0 OR COALESCE(w.qty, 0) > 0
         OR COALESCE(i.qty, 0) > 0 OR COALESCE(pl.qty, 0) > 0
         OR COALESCE(h.qty, 0) <= COALESCE(p.reorder_point, 0)
       )
     ORDER BY (COALESCE(h.qty, 0) - COALESCE(h.reserved, 0) - COALESCE(s.qty, 0) - COALESCE(w.qty, 0)) ASC, p.code`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function listReservations(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT r.id, r.product_id, p.code AS product_code, p.name AS product_name,
            r.warehouse_id, w.code AS warehouse_code, r.quantity, r.status,
            r.reference_type, r.reference_id, r.created_at, r.expires_at
     FROM inventory_reservations r
     JOIN products p ON p.id = r.product_id
     LEFT JOIN warehouses w ON w.id = r.warehouse_id
     WHERE r.tenant_id = $1 AND r.company_id = $2 AND r.status = 'ACTIVE'
     ORDER BY r.id DESC`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function getPoForReceive(client: pg.PoolClient, ctx: Ctx, poId: number) {
  const po = await client.query(
    `SELECT po.*, s.code AS supplier_code, s.name AS supplier_name
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.id = $1 AND po.tenant_id = $2`,
    [poId, ctx.tenantId]
  );
  if (!po.rows.length) throw notFound('Purchase order not found');
  const items = await client.query(
    `SELECT poi.*, p.code AS product_code, p.name AS product_name,
            (poi.quantity - poi.received_qty) AS remaining_qty
     FROM purchase_order_items poi JOIN products p ON p.id = poi.product_id
     WHERE poi.order_id = $1 ORDER BY poi.id`,
    [poId]
  );
  return { po: toCamelRow(po.rows[0]), items: toCamelRows(items.rows) };
}

export async function getOrderForPick(client: pg.PoolClient, ctx: Ctx, orderId: number) {
  const so = await client.query(
    `SELECT so.*, c.code AS customer_code, c.name AS customer_name
     FROM sales_orders so JOIN customers c ON c.id = so.customer_id
     WHERE so.id = $1 AND so.tenant_id = $2`,
    [orderId, ctx.tenantId]
  );
  if (!so.rows.length) throw notFound('Sales order not found');
  const items = await client.query(
    `SELECT soi.*, p.code AS product_code, p.name AS product_name,
            (soi.quantity - soi.dispatched_qty) AS remaining_qty
     FROM sales_order_items soi JOIN products p ON p.id = soi.product_id
     WHERE soi.order_id = $1 ORDER BY soi.id`,
    [orderId]
  );
  return { order: toCamelRow(so.rows[0]), items: toCamelRows(items.rows) };
}
