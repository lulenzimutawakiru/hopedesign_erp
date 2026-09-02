import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { api, auth, loginAs, db } from './helpers.js';

// Reset mutable seed rows after each test so the suite is repeatable in isolation.
const RESET_SQL = [
  `UPDATE production_alerts SET status='OPEN', acknowledged_by=NULL, acknowledged_at=NULL, resolved_by=NULL, resolved_at=NULL WHERE id = 12`,
  `UPDATE production_shift_handovers SET status='PENDING', acknowledged_at=NULL, acknowledged_by=NULL, to_operator_id=NULL WHERE id = 1`,
];

afterEach(async () => {
  for (const sql of RESET_SQL) {
    await db(sql);
  }
});

// Deterministic BOB-80 opening balance for the material-shortage scenario:
// exactly 40 in RAW-MAT, nothing anywhere else (residue rows from other runs
// would otherwise inflate on-hand and flip the check to PASS).
beforeAll(async () => {
  await db(
    `UPDATE inventory SET quantity = 0, reserved_qty = 0
       WHERE product_id = (SELECT id FROM products WHERE code = 'BOB-80')
         AND NOT (warehouse_id = (SELECT id FROM warehouses WHERE code = 'RAW-MAT') AND batch_id IS NULL)`
  );
  await db(
    `UPDATE inventory SET quantity = 40, reserved_qty = 0
       WHERE product_id = (SELECT id FROM products WHERE code = 'BOB-80')
         AND warehouse_id = (SELECT id FROM warehouses WHERE code = 'RAW-MAT') AND batch_id IS NULL`
  );
});

const asNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

describe('Manufacturing Execution System (MES) API', () => {
  it('command center exposes today production, alerts, orders and OEE factors', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/ops/manufacturing/command').set(auth(token));
    expect(res.status).toBe(200);
    const data = res.body.data;

    const today = data.today;
    expect(today).toBeDefined();
    expect(asNum(today.planned)).toBeGreaterThan(0);
    expect(asNum(today.produced)).toBeGreaterThan(0);
    expect(asNum(today.produced)).toBeLessThanOrEqual(asNum(today.planned));
    expect(asNum(today.achievement)).toBeGreaterThan(0);
    expect(asNum(today.achievement)).toBeLessThanOrEqual(100);
    expect(asNum(today.machinesRunning)).toBeGreaterThan(0);
    expect(asNum(today.machinesTotal)).toBeGreaterThanOrEqual(10);
    expect(asNum(today.machinesDown)).toBeGreaterThanOrEqual(1);
    expect(asNum(today.downtimeHours)).toBeGreaterThanOrEqual(4);
    expect(asNum(today.materialAvailability)).toBeGreaterThan(0);
    expect(asNum(today.qualityPassRate)).toBeGreaterThan(0);
    expect(asNum(today.oee)).toBeGreaterThan(0);
    expect(asNum(today.oee)).toBeLessThan(100);

    expect(asNum(data.oeeFactors.availability)).toBeGreaterThan(0);
    expect(asNum(data.oeeFactors.performance)).toBeGreaterThan(0);
    expect(asNum(data.oeeFactors.quality)).toBeGreaterThan(0);

    expect(asNum(data.orders.active)).toBeGreaterThanOrEqual(7);
    expect(asNum(data.orders.inProgress)).toBeGreaterThanOrEqual(2);
    expect(asNum(data.orders.awaitingPutaway)).toBeGreaterThanOrEqual(1);
    expect(asNum(data.alerts.materialShortages)).toBeGreaterThanOrEqual(1);
    expect(asNum(data.alerts.machinesDown)).toBeGreaterThanOrEqual(1);
    expect(asNum(data.alerts.qualityHolds)).toBeGreaterThanOrEqual(1);

    expect(Array.isArray(data.activeOrders)).toBe(true);
    const first = data.activeOrders[0];
    expect(first.woNo).toBeTruthy();
    expect(first.status).toBeTruthy();
    expect(asNum(first.completionPct)).toBeGreaterThanOrEqual(0);
    expect(first.productCode).toBeTruthy();
    expect(first.machineCode).toBeTruthy();

    expect(Array.isArray(data.downMachines)).toBe(true);
    expect(data.downMachines.some((m: any) => m.code === 'FSS104-B' && m.machineState === 'MAINTENANCE')).toBe(true);
  });

  it('OEE endpoint returns per-machine factors with drilldowns', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/ops/manufacturing/oee').set(auth(token));
    expect(res.status).toBe(200);
    const rows = res.body.data;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const fss104 = rows.find((r: any) => r.machineCode === 'FSS104');
    expect(fss104).toBeDefined();
    expect(asNum(fss104.availabilityPct)).toBeGreaterThan(0);
    expect(asNum(fss104.performancePct)).toBeGreaterThan(0);
    expect(asNum(fss104.qualityPct)).toBeGreaterThan(0);
    expect(asNum(fss104.oeePct)).toBeGreaterThan(0);
    expect(asNum(fss104.oeePct)).toBeLessThan(100);
    expect(Array.isArray(fss104.downtimeDrilldown)).toBe(true);
    expect(Array.isArray(fss104.wasteDrilldown)).toBe(true);
  });

  it('schedule and capacity load expose the plan and overload flags', async () => {
    const { token } = await loginAs('admin');
    const sched = await api.get('/api/ops/manufacturing/schedule').set(auth(token));
    expect(sched.status).toBe(200);
    expect(Array.isArray(sched.body.data)).toBe(true);
    expect(sched.body.data.length).toBeGreaterThanOrEqual(4);
    const row = sched.body.data[0];
    expect(row.scheduleNo).toBeTruthy();
    expect(asNum(row.workOrderId)).toBeGreaterThan(0);
    expect(row.machineCode).toBeTruthy();
    expect(row.plannedStart).toBeTruthy();
    expect(row.plannedEnd).toBeTruthy();
    expect(row.status).toBeTruthy();

    const load = await api.get('/api/ops/manufacturing/schedule/load').set(auth(token));
    expect(load.status).toBe(200);
    expect(Array.isArray(load.body.data.capacity)).toBe(true);
    expect(load.body.data.capacity.length).toBeGreaterThanOrEqual(10);
    const cap = load.body.data.capacity[0];
    expect(cap.machineCode).toBeTruthy();
    expect(typeof asNum(cap.availableHours)).toBe('number');
    expect(typeof asNum(cap.scheduledHours)).toBe('number');
    expect(typeof asNum(cap.remainingHours)).toBe('number');
    expect(typeof asNum(cap.scheduledLoadHours)).toBe('number');
    expect(typeof cap.overloaded).toBe('boolean');
    expect(Array.isArray(load.body.data.entries)).toBe(true);
  });

  it('production board groups orders by lifecycle stage', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/ops/manufacturing/board').set(auth(token));
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(Array.isArray(data.stages)).toBe(true);
    expect(data.stages).toContain('PLANNED');
    expect(data.stages).toContain('READY');
    expect(data.stages).toContain('MATERIALS_READY');
    expect(data.stages).toContain('IN_PRODUCTION');
    expect(data.stages).toContain('QUALITY');
    expect(data.stages).toContain('COMPLETED');
    expect(data.byStage).toBeDefined();
    for (const stage of data.stages) {
      expect(Array.isArray(data.byStage[stage])).toBe(true);
    }
    expect(data.byStage.IN_PRODUCTION.some((o: any) => o.woNo === 'MO-2026-001245')).toBe(true);
    expect(data.byStage.COMPLETED.length).toBeGreaterThan(0);
  });

  it('analytics and KPIs provide plan vs actual and management metrics', async () => {
    const { token } = await loginAs('admin');
    const analytics = await api.get('/api/ops/manufacturing/analytics').set(auth(token));
    expect(analytics.status).toBe(200);
    const a = analytics.body.data;
    expect(a.period).toBeDefined();
    expect(Array.isArray(a.planVsActual)).toBe(true);
    expect(a.planVsActual.length).toBeGreaterThan(0);
    const pva = a.planVsActual[0];
    expect(asNum(pva.plannedQty)).toBeGreaterThan(0);
    expect(typeof asNum(pva.producedQty)).toBe('number');
    expect(Array.isArray(a.byMachine)).toBe(true);
    expect(Array.isArray(a.byShift)).toBe(true);
    expect(Array.isArray(a.byOperator)).toBe(true);
    expect(Array.isArray(a.byProduct)).toBe(true);
    expect(Array.isArray(a.oee)).toBe(true);
    expect(a.oee.length).toBeGreaterThanOrEqual(10);

    const kpis = await api.get('/api/ops/manufacturing/kpis').set(auth(token));
    expect(kpis.status).toBe(200);
    const k = kpis.body.data;
    expect(asNum(k.productionAchievementPct)).toBeGreaterThan(0);
    expect(asNum(k.oee)).toBeGreaterThan(0);
    expect(asNum(k.oee)).toBeLessThan(100);
    expect(typeof asNum(k.yieldPct)).toBe('number');
    expect(typeof asNum(k.firstPassYieldPct)).toBe('number');
    expect(typeof asNum(k.machineUtilizationPct)).toBe('number');
    expect(typeof asNum(k.scheduleAdherencePct)).toBe('number');
    expect(typeof asNum(k.productionCostVariance)).toBe('number');
    expect(typeof asNum(k.materialUsageVariancePct)).toBe('number');
    expect(typeof asNum(k.reworkPct)).toBe('number');
    expect(typeof asNum(k.qualityRejectionPct)).toBe('number');
    expect(asNum(k.summary.orders)).toBeGreaterThanOrEqual(7);
    expect(asNum(k.summary.plannedQty)).toBeGreaterThan(0);
    expect(asNum(k.summary.producedQty)).toBeGreaterThan(0);
  });

  it('traceability links batch to order, materials, quality and events', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/ops/manufacturing/trace/1').set(auth(token));
    expect(res.status).toBe(200);
    const t = res.body.data;
    expect(t.batch).toBeDefined();
    expect(t.batch.batchNo).toBe('NTX-A4-20260826-001');
    expect(Number(t.batch.workOrderId)).toBe(1245);
    expect(Array.isArray(t.rawMaterials)).toBe(true);
    expect(Array.isArray(t.quality)).toBe(true);
    expect(Array.isArray(t.outputs)).toBe(true);
    expect(Array.isArray(t.events)).toBe(true);
  });

  it('electronic batch record includes BOM, quality, outputs and event history', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/ops/manufacturing/batches/3/ebr').set(auth(token));
    expect(res.status).toBe(200);
    const e = res.body.data;
    expect(e.ebr).toBeDefined();
    expect(e.ebr.batchNo).toBe('NTX-A4-20260826-003');
    expect(Number(e.ebr.workOrderId)).toBe(1180);
    expect(Array.isArray(e.billOfMaterials)).toBe(true);
    expect(Array.isArray(e.qualityResults)).toBe(true);
    expect(e.qualityResults.length).toBeGreaterThan(0);
    expect(Array.isArray(e.productionOutputs)).toBe(true);
    expect(e.productionOutputs.length).toBeGreaterThan(0);
    expect(Array.isArray(e.eventHistory)).toBe(true);
    expect(e.eventHistory.length).toBeGreaterThan(0);
  });

  it('alerts can be listed, acknowledged and resolved', async () => {
    const { token } = await loginAs('admin');
    const list = await api.get('/api/ops/manufacturing/alerts?openOnly=true').set(auth(token));
    expect(list.status).toBe(200);
    const alerts = list.body.data;
    expect(Array.isArray(alerts)).toBe(true);
    const shortage = alerts.find((al: any) => Number(al.id) === 12);
    expect(shortage).toBeDefined();
    expect(shortage.alertType).toBe('MATERIAL_SHORTAGE');
    expect(shortage.status).toBe('OPEN');
    expect(shortage.severity).toBe('CRITICAL');
    expect(shortage.title).toBeTruthy();

    const ack = await api.post('/api/ops/manufacturing/alerts/12/ack').set(auth(token));
    expect(ack.status).toBe(200);
    expect(ack.body.data.id).toBe(12);
    expect(ack.body.data.status).toBe('ACKNOWLEDGED');

    const resolve = await api.post('/api/ops/manufacturing/alerts/12/resolve').set(auth(token));
    expect(resolve.status).toBe(200);
    expect(resolve.body.data.id).toBe(12);
    expect(resolve.body.data.status).toBe('RESOLVED');
  });

  it('shift handover can be listed and acknowledged', async () => {
    const { token } = await loginAs('admin');
    const list = await api.get('/api/ops/manufacturing/shifts/handovers?openOnly=true').set(auth(token));
    expect(list.status).toBe(200);
    const rows = list.body.data;
    expect(Array.isArray(rows)).toBe(true);
    const hd = rows.find((h: any) => Number(h.id) === 1);
    expect(hd).toBeDefined();
    expect(hd.handoverNo).toBe('HD-2026-001');
    expect(hd.status).toBe('PENDING');

    const ack = await api.post('/api/ops/manufacturing/shifts/handover/1/ack').set(auth(token));
    expect(ack.status).toBe(200);
    expect(ack.body.data.id).toBe(1);
    expect(ack.body.data.status).toBe('ACKNOWLEDGED');
  });

  it('material availability blocks release when a critical material is short', async () => {
    const { token } = await loginAs('admin');
    const fail = await api.post('/api/ops/manufacturing/material/check/1260').set(auth(token));
    expect(fail.status).toBe(200);
    expect(fail.body.data.status).toBe('FAIL');
    expect(fail.body.data.canRelease).toBe(false);
    expect(fail.body.data.woNo).toBeTruthy();
    const missing = fail.body.data.lines.find((l: any) => !l.available);
    expect(missing).toBeDefined();
    expect(missing.productCode).toBe('BOB-80');
    expect(missing.critical).toBe(true);

    const pass = await api.post('/api/ops/manufacturing/material/check/1290').set(auth(token));
    expect(pass.status).toBe(200);
    expect(pass.body.data.status).toBe('PASS');
    expect(pass.body.data.canRelease).toBe(true);
    expect(pass.body.data.lines.every((l: any) => l.available)).toBe(true);
  });

  it('costing and documents endpoints return production records', async () => {
    const { token } = await loginAs('admin');
    const costing = await api.get('/api/ops/manufacturing/costing').set(auth(token));
    expect(costing.status).toBe(200);
    expect(costing.body.data).toBeDefined();
    expect(Array.isArray(costing.body.data.rows)).toBe(true);
    expect(costing.body.data.rows.length).toBeGreaterThanOrEqual(1);

    const woCost = await api.get('/api/ops/manufacturing/costing/1180').set(auth(token));
    expect(woCost.status).toBe(200);
    const c = woCost.body.data;
    expect(Number(c.workOrderId)).toBe(1180);
    expect(c.woNo).toBeTruthy();
    expect(typeof asNum(c.standardCost)).toBe('number');
    expect(typeof asNum(c.actualCost)).toBe('number');
    expect(typeof asNum(c.variance)).toBe('number');
    expect(typeof asNum(c.costPerUnitStandard)).toBe('number');
    expect(typeof asNum(c.costPerUnitActual)).toBe('number');
    expect(Array.isArray(c.components)).toBe(true);

    const docs = await api.get('/api/ops/manufacturing/documents').set(auth(token));
    expect(docs.status).toBe(200);
    expect(Array.isArray(docs.body.data)).toBe(true);
    expect(docs.body.data.length).toBeGreaterThanOrEqual(8);

    const woDocs = await api.get('/api/ops/manufacturing/documents/1180').set(auth(token));
    expect(woDocs.status).toBe(200);
    expect(Array.isArray(woDocs.body.data)).toBe(true);
  });

  it('AI manufacturing assistant answers with insight and underlying data', async () => {
    const { token } = await loginAs('admin');
    const res = await api
      .get('/api/ops/manufacturing/ai/assistant')
      .query({ q: 'which machine causes the most downtime?' })
      .set(auth(token));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.question).toBeTruthy();
    expect(d.generatedAt).toBeTruthy();
    expect(Array.isArray(d.answers)).toBe(true);
    expect(d.answers.length).toBeGreaterThan(0);
    const answer = d.answers[0];
    expect(answer.question).toBeTruthy();
    expect(typeof answer.insight).toBe('string');
    expect('data' in answer).toBe(true);
  });

  it('enforces RBAC: limited users cannot access restricted MES endpoints', async () => {
    const { token } = await loginAs('qiana.qc');
    // qiana.qc holds only production.work_orders.view
    const board = await api.get('/api/ops/manufacturing/board').set(auth(token));
    expect(board.status).toBe(200);
    const kpis = await api.get('/api/ops/manufacturing/kpis').set(auth(token));
    expect(kpis.status).toBe(403);
    const command = await api.get('/api/ops/manufacturing/command').set(auth(token));
    expect(command.status).toBe(403);
  });
});