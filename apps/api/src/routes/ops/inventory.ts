import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, notFound } from '../../utils.js';
import { logAudit } from '../../services/audit.js';
import { startWorkflow } from '../../services/workflow.js';
import * as inv from '../../services/inventory.js';
import * as wh from '../../services/warehouse.js';

export const inventoryOpsRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string | string[], fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;

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

/** Submit an inventory document for workflow approval (mirrors crudFactory submit). */
const submitDoc = (table: string, label: string, codeCol: string, entityType: string) => async (c: pg.PoolClient, ctx: Ctx, _b: any, p: Record<string, string>) => {
  const id = Number(p.id);
  const before = await c.query(`SELECT t.* FROM ${table} t WHERE t.id = $1 AND t.tenant_id = $2`, [id, ctx.tenantId]);
  if (before.rows.length === 0) throw notFound(`${label} not found`);
  await c.query(`UPDATE ${table} SET status = 'SUBMITTED' WHERE id = $1`, [id]);
  await logAudit(c, ctx, {
    action: 'submit', resource: table, recordId: id,
    recordCode: String(before.rows[0][codeCol] ?? ''), newValues: { status: 'SUBMITTED' },
  });
  await startWorkflow(c, ctx, {
    entityType, entityId: id,
    entityCode: String(before.rows[0][codeCol] ?? ''),
    amount: before.rows[0].total != null ? Number(before.rows[0].total) : undefined,
  });
  return { id, status: 'SUBMITTED' };
};

// Read models for the warehouse workspace
inventoryOpsRouter.get('/stock', ...runGet('inventory.stock.view', (c, ctx, q) => inv.listStock(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  warehouseId: q.warehouseId != null && q.warehouseId !== '' ? Number(q.warehouseId) : null,
  lowStock: q.lowStock === '1' || q.lowStock === 'true',
  expiring: q.expiring === '1' || q.expiring === 'true',
  productTypes: q.productType != null && q.productType !== '' ? String(q.productType).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
inventoryOpsRouter.get('/stock/summary', ...runGet('inventory.stock.view', (c, ctx) => inv.stockSummary(c, ctx)));
inventoryOpsRouter.get('/warehouses', ...runGet('inventory.warehouses.view', (c, ctx) => inv.warehouseBoard(c, ctx)));
inventoryOpsRouter.get('/products/:id/stock', ...runGet('inventory.stock.view', (c, ctx, _q, p) => inv.productStock(c, ctx, Number(p.id))));
inventoryOpsRouter.get('/movements', ...runGet('inventory.movements.view', (c, ctx, q) => inv.listMovements(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  warehouseId: q.warehouseId != null && q.warehouseId !== '' ? Number(q.warehouseId) : null,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
inventoryOpsRouter.get('/adjustments/:id', ...runGet('inventory.adjustments.view', (c, ctx, _q, p) => inv.getAdjustment(c, ctx, Number(p.id))));
inventoryOpsRouter.get('/transfers/:id', ...runGet('inventory.transfers.view', (c, ctx, _q, p) => inv.getTransfer(c, ctx, Number(p.id))));

// Stock movements (scan-driven postings from the mobile/desktop scanner)
inventoryOpsRouter.post('/moves', ...run('inventory.movements.create', (c, ctx, b) => inv.postMove(c, ctx, b as inv.MoveInput)));

// Reservations
inventoryOpsRouter.post('/reservations', ...run('inventory.reservations.create', (c, ctx, b) => inv.reserve(c, ctx, {
  product: Number(b.product),
  batch: b.batch != null ? Number(b.batch) : null,
  warehouse: b.warehouse != null ? Number(b.warehouse) : null,
  qty: Number(b.qty),
  refType: String(b.refType),
  refId: Number(b.refId),
})));
inventoryOpsRouter.post('/reservations/:id/release', ...run('inventory.reservations.release', (c, _ctx, _b, p) => inv.release(c, Number(p.id))));

// Stock adjustments (draft -> submit -> workflow approval -> post)
inventoryOpsRouter.post('/adjustments', ...run('inventory.adjustments.create', (c, ctx, b) => inv.createAdjustment(c, ctx, b)));
inventoryOpsRouter.post('/adjustments/:id/submit', ...run('inventory.adjustments.submit', submitDoc('inventory_adjustments', 'Stock Adjustment', 'adjustment_no', 'inventory.adjustments')));
inventoryOpsRouter.post('/adjustments/:id/post', ...run('inventory.adjustments.post', (c, ctx, _b, p) => inv.postAdjustment(c, ctx, Number(p.id))));

// Stock transfers (draft -> submit -> workflow approval -> complete)
inventoryOpsRouter.post('/transfers', ...run('inventory.transfers.create', (c, ctx, b) => inv.createTransfer(c, ctx, b)));
inventoryOpsRouter.post('/transfers/:id/submit', ...run('inventory.transfers.submit', submitDoc('inventory_transfers', 'Stock Transfer', 'transfer_no', 'inventory.transfers')));
inventoryOpsRouter.post('/transfers/:id/complete', ...run('inventory.transfers.complete', (c, ctx, _b, p) => inv.completeTransfer(c, ctx, Number(p.id))));

// Warehouse operations — inbound (procurement), outbound (sales), production issue
inventoryOpsRouter.get('/work', ...runGet('inventory.stock.view', (c, ctx) => wh.workQueue(c, ctx)));
inventoryOpsRouter.get('/demand', ...runGet('inventory.stock.view', (c, ctx) => wh.demandBoard(c, ctx)));
inventoryOpsRouter.get('/reservations', ...runGet('inventory.reservations.view', (c, ctx) => wh.listReservations(c, ctx)));
inventoryOpsRouter.get('/bins', ...runGet('inventory.warehouses.view', (c, ctx, q) => wh.listBins(c, ctx, q.warehouseId != null && q.warehouseId !== '' ? Number(q.warehouseId) : null)));

inventoryOpsRouter.get('/inbound', ...runGet(['inventory.stock.view', 'procurement.goods_receipts.view'], (c, ctx) => wh.inboundQueue(c, ctx)));
inventoryOpsRouter.get('/inbound/po/:id', ...runGet(['inventory.stock.view', 'procurement.orders.view'], (c, ctx, _q, p) => wh.getPoForReceive(c, ctx, Number(p.id))));
inventoryOpsRouter.post('/inbound/receive', ...run(['inventory.movements.create', 'procurement.goods_receipts.create'], (c, ctx, b) => wh.receivePurchaseOrder(c, ctx, {
  poId: Number(b.poId),
  deliveryRef: b.deliveryRef != null ? String(b.deliveryRef) : null,
  notes: b.notes != null ? String(b.notes) : null,
  items: b.items ?? [],
})));
inventoryOpsRouter.post('/putaway', ...run('inventory.movements.create', (c, ctx, b) => wh.putaway(c, ctx, {
  productId: Number(b.productId),
  quantity: Number(b.quantity),
  fromWarehouseId: Number(b.fromWarehouseId),
  toWarehouseId: Number(b.toWarehouseId),
  fromBinId: b.fromBinId != null ? Number(b.fromBinId) : null,
  toBinId: b.toBinId != null ? Number(b.toBinId) : null,
  batchId: b.batchId != null ? Number(b.batchId) : null,
  reason: b.reason != null ? String(b.reason) : null,
})));

inventoryOpsRouter.get('/outbound', ...runGet(['inventory.stock.view', 'sales.orders.view'], (c, ctx) => wh.outboundQueue(c, ctx)));
inventoryOpsRouter.get('/outbound/orders/:id', ...runGet(['inventory.stock.view', 'sales.orders.view'], (c, ctx, _q, p) => wh.getOrderForPick(c, ctx, Number(p.id))));
inventoryOpsRouter.post('/outbound/allocate/:id', ...run(['inventory.reservations.create', 'sales.orders.allocate'], (c, ctx, _b, p) => wh.allocateSalesOrder(c, ctx, Number(p.id))));
inventoryOpsRouter.post('/outbound/dispatch', ...run(['inventory.movements.create', 'sales.orders.dispatch'], (c, ctx, b) => wh.pickAndDispatch(c, ctx, {
  orderId: Number(b.orderId),
  items: b.items ?? [],
  notes: b.notes != null ? String(b.notes) : null,
})));

inventoryOpsRouter.get('/production-issue', ...runGet(['inventory.stock.view', 'production.work_orders.view'], (c, ctx) => wh.productionQueue(c, ctx)));
inventoryOpsRouter.post('/production-issue', ...run(['inventory.movements.create', 'production.work_orders.issue'], (c, ctx, b) => wh.issueToWorkOrder(c, ctx, {
  workOrderId: Number(b.workOrderId),
  materialId: Number(b.materialId),
  quantity: Number(b.quantity),
  warehouseId: b.warehouseId != null ? Number(b.warehouseId) : null,
  batchId: b.batchId != null ? Number(b.batchId) : null,
  binId: b.binId != null ? Number(b.binId) : null,
})));
