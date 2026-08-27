import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils.js';
import * as prod from '../../services/production.js';

export const productionOpsRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

const runGet = (permission: string, fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

// Production plans
productionOpsRouter.post('/plans', ...run('production.plans.create', (c, ctx, b) => prod.createProductionPlan(c, ctx, b)));
productionOpsRouter.post('/plans/:id/submit', ...run('production.plans.submit', (c, ctx, _b, p) => prod.submitProductionPlan(c, ctx, Number(p.id))));

productionOpsRouter.get(
  '/products/:id/setup',
  requirePermission('production.work_orders.create'),
  asyncHandler(async (req, res) => {
    const qty = req.query.quantity != null ? Number(req.query.quantity) : 1;
    const bomId = req.query.bomId != null && req.query.bomId !== '' ? Number(req.query.bomId) : null;
    const routingId = req.query.routingId != null && req.query.routingId !== '' ? Number(req.query.routingId) : null;
    const out = await tx(
      (client) => prod.productSetup(client, req.ctx, Number(req.params.id), qty, bomId, routingId),
      req.ctx
    );
    res.json({ data: out });
  })
);

// Work orders
productionOpsRouter.post('/work-orders', ...run('production.work_orders.create', (c, ctx, b) => prod.createWorkOrder(c, ctx, {
  productId: Number(b.productId),
  quantity: Number(b.quantity),
  bomId: b.bomId != null ? Number(b.bomId) : null,
  routingId: b.routingId != null ? Number(b.routingId) : null,
  machineId: b.machineId != null ? Number(b.machineId) : null,
  operatorId: b.operatorId != null ? Number(b.operatorId) : null,
  priority: b.priority != null ? String(b.priority) : undefined,
  startDate: b.startDate != null ? String(b.startDate) : null,
  dueDate: b.dueDate != null ? String(b.dueDate) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));
productionOpsRouter.post('/work-orders/:id/submit', ...run('production.work_orders.submit', (c, ctx, _b, p) => prod.submitWorkOrder(c, ctx, Number(p.id))));
productionOpsRouter.post('/work-orders/:id/release', ...run('production.work_orders.release', (c, ctx, _b, p) => prod.releaseWorkOrder(c, ctx, Number(p.id))));
productionOpsRouter.post('/work-orders/:id/start', ...run('production.work_orders.start', (c, ctx, _b, p) => prod.startWorkOrder(c, ctx, Number(p.id))));
productionOpsRouter.post('/work-orders/:id/issue-material', ...run('production.work_orders.issue', (c, ctx, b, p) => prod.issueMaterial(c, ctx, { workOrderId: Number(p.id), materialId: Number(b.materialId), quantity: Number(b.quantity) })));
productionOpsRouter.post('/work-orders/:id/output', ...run('production.work_orders.record', (c, ctx, b, p) => prod.recordOutput(c, ctx, { workOrderId: Number(p.id), outputType: b.outputType as prod.OutputType, quantity: Number(b.quantity), unitCost: b.unitCost != null ? Number(b.unitCost) : null, reason: b.reason != null ? String(b.reason) : null })));
productionOpsRouter.post('/work-orders/:id/labour', ...run('production.work_orders.record', (c, ctx, b, p) => prod.recordLabour(c, ctx, { workOrderId: Number(p.id), operatorUserId: Number(b.operatorUserId), hours: Number(b.hours), hourlyRate: b.hourlyRate != null ? Number(b.hourlyRate) : null, notes: b.notes != null ? String(b.notes) : null })));
productionOpsRouter.post('/work-orders/:id/downtime', ...run('production.work_orders.record', (c, ctx, b, p) => prod.recordDowntime(c, ctx, { workOrderId: Number(p.id), machineId: b.machineId != null ? Number(b.machineId) : null, downtimeType: String(b.downtimeType), reason: b.reason != null ? String(b.reason) : null, startedAt: b.startedAt != null ? String(b.startedAt) : null, endedAt: b.endedAt != null ? String(b.endedAt) : null, minutes: b.minutes != null ? Number(b.minutes) : null })));
productionOpsRouter.post('/work-orders/:id/complete', ...run('production.work_orders.complete', (c, ctx, _b, p) => prod.completeWorkOrder(c, ctx, Number(p.id))));
productionOpsRouter.post('/work-orders/:id/close', ...run('production.work_orders.close', (c, ctx, _b, p) => prod.closeWorkOrder(c, ctx, Number(p.id))));
productionOpsRouter.post('/work-orders/:id/hold', ...run('production.work_orders.start', (c, ctx, b, p) => prod.holdWorkOrder(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : null)));

productionOpsRouter.get('/board', ...runGet('production.work_orders.view', (c, ctx) => prod.plantBoard(c, ctx)));
productionOpsRouter.get('/demand', ...runGet('production.work_orders.view', (c, ctx) => prod.salesDemand(c, ctx)));
productionOpsRouter.post('/demand/make', ...run('production.work_orders.create', (c, ctx, b) => prod.makeFromDemand(c, ctx, {
  salesOrderItemId: Number(b.salesOrderItemId),
  quantity: b.quantity != null ? Number(b.quantity) : undefined,
})));
productionOpsRouter.get('/work-orders', ...runGet('production.work_orders.view', (c, ctx, q) => prod.listWorkOrders(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
productionOpsRouter.get('/work-orders/:id', ...runGet('production.work_orders.view', (c, ctx, _q, p) => prod.getWorkOrderDetail(c, ctx, Number(p.id))));
productionOpsRouter.get('/plans', ...runGet('production.plans.view', (c, ctx) => prod.listPlans(c, ctx)));
productionOpsRouter.get('/plans/:id', ...runGet('production.plans.view', (c, ctx, _q, p) => prod.getPlan(c, ctx, Number(p.id))));
productionOpsRouter.post('/plans/:id/explode', ...run('production.work_orders.create', (c, ctx, _b, p) => prod.explodePlan(c, ctx, Number(p.id))));
