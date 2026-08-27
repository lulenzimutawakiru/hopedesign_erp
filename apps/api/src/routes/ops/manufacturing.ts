import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest } from '../../utils.js';
import * as mfg from '../../services/manufacturing.js';

export const manufacturingOpsRouter = Router();

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

// ---------------------------------------------------------------------------
// 1. Manufacturing command center + OEE
// ---------------------------------------------------------------------------
manufacturingOpsRouter.get('/command', ...runGet('production.kpis.view', (c, ctx) => mfg.mesCommandCenter(c, ctx)));
manufacturingOpsRouter.get('/oee', ...runGet('production.kpis.view', (c, ctx) => mfg.machineOee(c, ctx)));
manufacturingOpsRouter.get('/oee/:machineId', ...runGet('production.kpis.view', (c, ctx, _q, p) => mfg.machineOee(c, ctx, Number(p.machineId))));
const MACHINE_ACTIONS = ['release', 'start', 'setup', 'stop', 'breakdown', 'maintenance_start', 'maintenance_complete', 'changeover', 'quality_hold', 'offline'] as const;
type MachineAction = (typeof MACHINE_ACTIONS)[number];

manufacturingOpsRouter.post('/machines/:id/ops', ...run('production.machines.operate', (c, ctx, b, p) => {
  const action = String(b.action ?? '');
  if (!MACHINE_ACTIONS.includes(action as MachineAction)) throw badRequest(`Unsupported machine action: ${action}`);
  return mfg.machineOps(c, ctx, {
    machineId: Number(p.id),
    action: action as MachineAction,
    reason: b.reason != null ? String(b.reason) : null,
    workOrderId: b.workOrderId != null ? Number(b.workOrderId) : null,
  });
}));

// ---------------------------------------------------------------------------
// 9/10/11/12. MRP, material availability, reservation, issue
// ---------------------------------------------------------------------------
manufacturingOpsRouter.post('/material/check/:workOrderId', ...run('production.work_orders.issue', (c, ctx, _b, p) => mfg.materialAvailability(c, ctx, Number(p.workOrderId))));
manufacturingOpsRouter.post('/material/check/:id/override', ...run('production.work_orders.issue', (c, ctx, b, p) => mfg.overrideAvailability(c, ctx, {
  workOrderId: Number(p.id),
  reason: b.reason != null ? String(b.reason) : 'Supervisor override',
})));
manufacturingOpsRouter.post('/material/reserve/:workOrderId', ...run('production.work_orders.issue', (c, ctx, b, p) => mfg.reserveMaterials(c, ctx, {
  workOrderId: Number(p.workOrderId),
  override: b.override === true,
  reason: b.reason != null ? String(b.reason) : null,
})));
manufacturingOpsRouter.post('/material/issue/:workOrderId', ...run('production.work_orders.issue', (c, ctx, b, p) => mfg.issueMaterialMes(c, ctx, {
  workOrderId: Number(p.workOrderId),
  reservationId: b.reservationId != null ? Number(b.reservationId) : null,
  productId: Number(b.productId),
  batchId: b.batchId != null ? Number(b.batchId) : null,
  quantity: Number(b.quantity),
  fifoConfirmed: b.fifoConfirmed === true,
  overrideReason: b.overrideReason != null ? String(b.overrideReason) : null,
  issueType: b.issueType != null ? String(b.issueType) : undefined,
})));

// ---------------------------------------------------------------------------
// 7/8/13/16/26/27/42. Production board, schedule, load
// ---------------------------------------------------------------------------
manufacturingOpsRouter.get('/board', ...runGet('production.work_orders.view', (c, ctx) => mfg.productionBoard(c, ctx)));
manufacturingOpsRouter.get('/schedule', ...runGet('production.plans.view', (c, ctx, q) => mfg.productionSchedule(c, ctx, q.from != null ? String(q.from) : null, q.to != null ? String(q.to) : null)));
manufacturingOpsRouter.get('/schedule/load', ...runGet('production.plans.view', (c, ctx, q) => mfg.scheduleLoad(c, ctx, q.from != null ? String(q.from) : null, q.to != null ? String(q.to) : null)));

// ---------------------------------------------------------------------------
// 24/25. Shift management + handover
// ---------------------------------------------------------------------------
manufacturingOpsRouter.post('/shifts/handover', ...run('production.work_orders.update', (c, ctx, b) => mfg.createShiftHandover(c, ctx, {
  workOrderId: b.workOrderId != null ? Number(b.workOrderId) : null,
  machineId: b.machineId != null ? Number(b.machineId) : null,
  fromShiftCode: String(b.fromShiftCode),
  toShiftCode: b.toShiftCode != null ? String(b.toShiftCode) : null,
  shiftDate: b.shiftDate != null ? String(b.shiftDate) : null,
  producedQty: b.producedQty != null ? Number(b.producedQty) : null,
  outstandingQty: b.outstandingQty != null ? Number(b.outstandingQty) : null,
  machineStatus: b.machineStatus != null ? String(b.machineStatus) : null,
  issues: b.issues != null ? String(b.issues) : null,
  materialStatus: b.materialStatus != null ? String(b.materialStatus) : null,
  qualityStatus: b.qualityStatus != null ? String(b.qualityStatus) : null,
  handoverNotes: b.handoverNotes != null ? String(b.handoverNotes) : null,
})));
manufacturingOpsRouter.post('/shifts/handover/:id/ack', ...run('production.work_orders.update', (c, ctx, _b, p) => mfg.acknowledgeShiftHandover(c, ctx, Number(p.id))));
manufacturingOpsRouter.get('/shifts/handovers', ...runGet('production.work_orders.view', (c, ctx, q) => mfg.listShiftHandovers(c, ctx, q.openOnly === 'true')));

// ---------------------------------------------------------------------------
// 17/18/44. Batches, traceability, electronic batch record
// ---------------------------------------------------------------------------
manufacturingOpsRouter.get('/trace/:batchId', ...runGet('production.work_orders.view', (c, ctx, _q, p) => mfg.traceability(c, ctx, Number(p.batchId))));
manufacturingOpsRouter.get('/batches/:batchId/ebr', ...runGet('production.work_orders.view', (c, ctx, _q, p) => mfg.batchEbr(c, ctx, Number(p.batchId))));

// ---------------------------------------------------------------------------
// 19/20/21/22/32/33. Quality, scrap, waste, downtime, rework, subcontract
// ---------------------------------------------------------------------------
manufacturingOpsRouter.post('/quality/hold', ...run('quality.plans.approve', (c, ctx, b) => mfg.qualityHold(c, ctx, {
  productionBatchId: Number(b.productionBatchId),
  reason: String(b.reason),
  heldQty: Number(b.heldQty),
})));
manufacturingOpsRouter.post('/quality/disposition', ...run('quality.plans.approve', (c, ctx, b) => mfg.qualityDisposition(c, ctx, {
  holdId: Number(b.holdId),
  disposition: String(b.disposition),
  quantity: Number(b.quantity),
  reason: b.reason != null ? String(b.reason) : null,
  createRework: b.createRework === true,
})));
manufacturingOpsRouter.post('/scrap', ...run('production.outputs.create', (c, ctx, b) => mfg.recordScrap(c, ctx, {
  workOrderId: Number(b.workOrderId),
  productionBatchId: b.productionBatchId != null ? Number(b.productionBatchId) : null,
  machineId: b.machineId != null ? Number(b.machineId) : null,
  productId: b.productId != null ? Number(b.productId) : null,
  scrapType: b.scrapType != null ? String(b.scrapType) : 'ABNORMAL',
  quantity: Number(b.quantity),
  unitCost: b.unitCost != null ? Number(b.unitCost) : null,
  reason: b.reason != null ? String(b.reason) : null,
})));
manufacturingOpsRouter.post('/waste', ...run('production.outputs.create', (c, ctx, b) => mfg.recordWaste(c, ctx, {
  workOrderId: Number(b.workOrderId),
  productionBatchId: b.productionBatchId != null ? Number(b.productionBatchId) : null,
  machineId: b.machineId != null ? Number(b.machineId) : null,
  wasteType: b.wasteType != null ? String(b.wasteType) : 'NORMAL',
  category: b.category != null ? String(b.category) : 'CUTTING',
  inputQty: b.inputQty != null ? Number(b.inputQty) : null,
  wasteQty: Number(b.wasteQty),
  reason: b.reason != null ? String(b.reason) : null,
})));
manufacturingOpsRouter.post('/downtime', ...run('production.downtime.create', (c, ctx, b) => mfg.recordDowntimeMes(c, ctx, {
  machineId: Number(b.machineId),
  workOrderId: b.workOrderId != null ? Number(b.workOrderId) : null,
  productionBatchId: b.productionBatchId != null ? Number(b.productionBatchId) : null,
  category: String(b.category),
  reason: b.reason != null ? String(b.reason) : null,
  startedAt: b.startedAt != null ? String(b.startedAt) : null,
  endedAt: b.endedAt != null ? String(b.endedAt) : null,
  durationMin: b.durationMin != null ? Number(b.durationMin) : null,
})));
manufacturingOpsRouter.post('/rework', ...run('production.work_orders.create', (c, ctx, b) => mfg.createRework(c, ctx, {
  sourceWorkOrderId: Number(b.sourceWorkOrderId),
  productionBatchId: b.productionBatchId != null ? Number(b.productionBatchId) : null,
  productId: Number(b.productId),
  quantity: Number(b.quantity),
  materialRequired: b.materialRequired != null ? b.materialRequired : undefined,
  reworkCost: b.reworkCost != null ? Number(b.reworkCost) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));
manufacturingOpsRouter.post('/rework/:id/status', ...run('production.work_orders.create', (c, ctx, b, p) => mfg.updateReworkStatus(c, ctx, {
  reworkId: Number(p.id),
  status: String(b.status),
  reworkCost: b.reworkCost != null ? Number(b.reworkCost) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));
manufacturingOpsRouter.post('/subcontract', ...run('production.work_orders.create', (c, ctx, b) => mfg.createSubcontract(c, ctx, {
  workOrderId: Number(b.workOrderId),
  operationId: b.operationId != null ? Number(b.operationId) : null,
  supplierId: Number(b.supplierId),
  productId: Number(b.productId),
  quantity: Number(b.quantity),
  vendorCost: b.vendorCost != null ? Number(b.vendorCost) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));
manufacturingOpsRouter.post('/subcontract/:id/status', ...run('production.work_orders.create', (c, ctx, b, p) => mfg.updateSubcontractStatus(c, ctx, {
  subconId: Number(p.id),
  status: String(b.status),
  quantity: b.quantity != null ? Number(b.quantity) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));

// ---------------------------------------------------------------------------
// 29/45. Costing + documents
// ---------------------------------------------------------------------------
manufacturingOpsRouter.get('/costing', ...runGet('production.costing.view', (c, ctx) => mfg.productionCosting(c, ctx)));
manufacturingOpsRouter.get('/costing/:workOrderId', ...runGet('production.costing.view', (c, ctx, _q, p) => mfg.workOrderCosting(c, ctx, Number(p.workOrderId))));
manufacturingOpsRouter.get('/documents', ...runGet('production.work_orders.print', (c, ctx) => mfg.listProductionDocuments(c, ctx)));
manufacturingOpsRouter.get('/documents/:workOrderId', ...runGet('production.work_orders.print', (c, ctx, _q, p) => mfg.listProductionDocuments(c, ctx, Number(p.workOrderId))));
manufacturingOpsRouter.post('/documents/generate', ...run('production.work_orders.print', (c, ctx, b) => mfg.generateProductionDocuments(c, ctx, {
  workOrderId: Number(b.workOrderId),
  docTypes: Array.isArray(b.docTypes) ? b.docTypes.map((t: unknown) => String(t)) : [String(b.docTypes ?? 'PRODUCTION_ORDER')],
})));

// ---------------------------------------------------------------------------
// 38/39/40/51. Alerts, analytics, KPIs, AI assistant
// ---------------------------------------------------------------------------
manufacturingOpsRouter.get('/alerts', ...runGet('production.kpis.view', (c, ctx, q) => mfg.listProductionAlerts(c, ctx, q.openOnly !== 'false')));
manufacturingOpsRouter.post('/alerts/:id/ack', ...run('production.kpis.view', (c, ctx, _b, p) => mfg.ackProductionAlert(c, ctx, Number(p.id))));
manufacturingOpsRouter.post('/alerts/:id/resolve', ...run('production.kpis.view', (c, ctx, _b, p) => mfg.resolveProductionAlert(c, ctx, Number(p.id))));
manufacturingOpsRouter.get('/analytics', ...runGet('production.analytics.view', (c, ctx, q) => mfg.productionAnalytics(c, ctx, {
  from: q.from != null ? String(q.from) : null,
  to: q.to != null ? String(q.to) : null,
  groupBy: q.groupBy != null ? String(q.groupBy) : 'day',
})));
manufacturingOpsRouter.get('/kpis', ...runGet('production.kpis.view', (c, ctx) => mfg.managementKpis(c, ctx)));
manufacturingOpsRouter.get('/ai/assistant', ...runGet('production.ai.view', (c, ctx, q) => mfg.aiAssistant(c, ctx, q.q != null ? String(q.q) : null)));