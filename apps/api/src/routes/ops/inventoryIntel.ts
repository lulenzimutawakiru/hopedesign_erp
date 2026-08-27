import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, notFound, toCamelRow, toCamelRows } from '../../utils.js';
import * as intel from '../../services/inventoryIntel.js';

export const inventoryIntelRouter = Router();

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

const numQ = (q: Record<string, unknown>, key: string): number | null =>
  q[key] != null && q[key] !== '' ? Number(q[key]) : null;

// ---- Command center & stock intelligence ----
inventoryIntelRouter.get('/command-center', ...runGet('inventory.stock.view', (c, ctx) => intel.commandCenter(c, ctx)));
inventoryIntelRouter.get('/stock-positions', ...runGet('inventory.stock.view', (c, ctx, q) => intel.stockPositions(c, ctx, numQ(q, 'productId'))));
inventoryIntelRouter.get('/atp-ctp/:productId', ...runGet('inventory.stock.view', (c, ctx, _q, p) => intel.atpCtp(c, ctx, Number(p.productId))));
inventoryIntelRouter.get('/fifo-suggestions', ...runGet('inventory.stock.view', (c, ctx, q) => intel.fifoSuggestions(c, ctx, Number(q.productId), numQ(q, 'qty'), q.method === 'FEFO' ? 'FEFO' : 'FIFO')));
inventoryIntelRouter.get('/putaway-recommendations', ...runGet('inventory.stock.view', (c, ctx, q) => intel.putawayRecommendations(c, ctx, Number(q.productId), numQ(q, 'qty'))));
inventoryIntelRouter.get('/kpis', ...runGet('inventory.stock.view', (c, ctx) => intel.kpis(c, ctx)));
inventoryIntelRouter.get('/data-quality', ...runGet('inventory.stock.view', (c, ctx) => intel.dataQualityScore(c, ctx)));

// ---- Traceability & recalls ----
inventoryIntelRouter.get('/traceability/batch/:id', ...runGet('inventory.traceability.view', (c, ctx, _q, p) => intel.traceabilityGraph(c, ctx, Number(p.id))));
inventoryIntelRouter.get('/batch-lifecycle/:id', ...runGet('inventory.traceability.view', (c, ctx, _q, p) => intel.batchLifecycle(c, ctx, Number(p.id))));
inventoryIntelRouter.get('/recalls/engine', ...runGet('inventory.recalls.view', (c, ctx, q) => intel.recallEngine(c, ctx, numQ(q, 'productId'), numQ(q, 'batchId'))));
inventoryIntelRouter.post('/recalls', ...run('inventory.recalls.create', (c, ctx, b) => intel.createRecall(c, ctx, b)));

// ---- Quality holds ----
inventoryIntelRouter.post('/quality-holds/:id/release', ...run('inventory.quality_holds.release', (c, ctx, b, p) => intel.qualityHoldRelease(c, ctx, Number(p.id), b.releaseQty != null ? Number(b.releaseQty) : null, b.disposition != null ? String(b.disposition) : 'APPROVED')));

// ---- Cycle counting ----
inventoryIntelRouter.get('/counts', ...runGet('inventory.counts.view', (c, ctx, q) => intel.cycleCountSchedule(c, ctx, numQ(q, 'warehouseId'))));
inventoryIntelRouter.post('/counts', ...run('inventory.counts.create', (c, ctx, b) => intel.cycleCountSchedule(c, ctx, b.warehouseId != null ? Number(b.warehouseId) : null)));
inventoryIntelRouter.get('/counts/:id', ...runGet('inventory.counts.view', async (c, ctx, _q, p) => {
  const countId = Number(p.id);
  const count = await c.query(
    `SELECT sc.*, w.code AS warehouse_code, w.name AS warehouse_name
     FROM stock_counts sc LEFT JOIN warehouses w ON w.id = sc.warehouse_id
     WHERE sc.id = $1 AND sc.tenant_id = $2`,
    [countId, ctx.tenantId]
  );
  if (count.rows.length === 0) throw notFound('Stock count not found');
  const lines = await c.query(
    `SELECT scl.*, p.code AS product_code, p.name AS product_name, p.abc_class,
            u.code AS uom_code
     FROM stock_count_lines scl
     JOIN products p ON p.id = scl.product_id
     LEFT JOIN units_of_measure u ON u.id = p.unit_id
     WHERE scl.count_id = $1 AND scl.tenant_id = $2
     ORDER BY scl.id`,
    [countId, ctx.tenantId]
  );
  return { count: toCamelRow(count.rows[0]), lines: toCamelRows(lines.rows) };
}));
inventoryIntelRouter.post('/counts/:id/enter', ...run('inventory.counts.enter', (c, ctx, b, p) => intel.enterCountLine(c, ctx, Number(p.id), Number(b.lineId), Number(b.countedQty))));
inventoryIntelRouter.post('/counts/:id/review', ...run('inventory.counts.approve', (c, ctx, b, p) => intel.reviewCountLine(c, ctx, Number(p.id), Number(b.lineId), Number(b.secondCountQty), b.note != null ? String(b.note) : null)));
inventoryIntelRouter.post('/counts/:id/approve', ...run('inventory.counts.approve', (c, ctx, _b, p) => intel.approveCount(c, ctx, Number(p.id))));
inventoryIntelRouter.post('/counts/:id/post', ...run('inventory.counts.post', (c, ctx, _b, p) => intel.postCount(c, ctx, Number(p.id))));

// ---- Analysis, planning & valuation snapshots ----
inventoryIntelRouter.get('/abc-xyz', ...runGet('inventory.valuations.view', (c, ctx) => intel.abcXyzSnapshot(c, ctx)));
inventoryIntelRouter.get('/valuations', ...runGet('inventory.valuations.view', (c, ctx) => intel.valuationSnapshot(c, ctx)));
inventoryIntelRouter.get('/reorder', ...runGet('inventory.reorder_recommendations.view', (c, ctx) => intel.reorderRecommendations(c, ctx)));
inventoryIntelRouter.get('/forecasts', ...runGet('inventory.forecasts.view', (c, ctx, q) => intel.forecastProducts(c, ctx, q.horizonDays != null && q.horizonDays !== '' ? Number(q.horizonDays) : 30)));
inventoryIntelRouter.get('/risk', ...runGet('inventory.risk.view', (c, ctx) => intel.riskScore(c, ctx)));
inventoryIntelRouter.post('/landed-costs/:id/allocate', ...run('inventory.valuations.create', (c, ctx, _b, p) => intel.landedCostAllocation(c, ctx, Number(p.id))));

// ---- Warehouse map & handling units ----
inventoryIntelRouter.get('/warehouse-map/:id', ...runGet('inventory.warehouses.view', (c, ctx, _q, p) => intel.warehouseMap(c, ctx, Number(p.id))));
inventoryIntelRouter.get('/handling-units/:ref', ...runGet('inventory.handling_units.view', (c, ctx, _q, p) => intel.handlingUnitContents(c, ctx, p.ref)));

// ---- Alerts & notifications ----
inventoryIntelRouter.get('/alerts', ...runGet('inventory.alerts.view', (c, ctx, q) => intel.alertsList(c, ctx, q.status != null && q.status !== '' ? String(q.status) : null)));
inventoryIntelRouter.post('/alerts', ...run('inventory.alerts.create', (c, ctx, b) => intel.alertsCreate(c, ctx, b)));
inventoryIntelRouter.post('/alerts/:id/acknowledge', ...run('inventory.alerts.acknowledge', (c, ctx, _b, p) => intel.alertsAcknowledge(c, ctx, Number(p.id))));
inventoryIntelRouter.post('/alerts/:id/resolve', ...run('inventory.alerts.resolve', (c, ctx, _b, p) => intel.alertsResolve(c, ctx, Number(p.id))));
