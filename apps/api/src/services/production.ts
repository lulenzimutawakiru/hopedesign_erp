import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { startWorkflow } from './workflow.js';
import { postMove } from './inventory.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import { generateQr } from './qr.js';
import * as finance from './finance.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

/** Default warehouse by product type (finished goods vs raw vs security). */
export async function warehouseByType(client: pg.PoolClient, ctx: Ctx, productType: string): Promise<number> {
  const code = productType === 'SECURITY_ITEM'
    ? 'SEC-WH'
    : ['JUMBO_ROLL', 'PAPER_BOBBIN', 'PACKAGING', 'CONSUMABLE', 'SPARE_PART'].includes(productType)
      ? 'RAW-MAT'
      : 'FG-WH';
  const res = await client.query(`SELECT id FROM warehouses WHERE company_id = $1 AND code = $2`, [ctx.companyId, code]);
  if (res.rows.length === 0) throw badRequest(`Warehouse ${code} not found`);
  return Number(res.rows[0].id);
}

async function defaultBin(client: pg.PoolClient, ctx: Ctx, warehouseId: number): Promise<number | null> {
  const res = await client.query(
    `SELECT id FROM warehouse_bins WHERE warehouse_id = $1 ORDER BY code LIMIT 1`,
    [warehouseId]
  );
  return res.rows.length ? Number(res.rows[0].id) : null;
}

async function productMeta(client: pg.PoolClient, ctx: Ctx, productId: number) {
  const res = await client.query(
    `SELECT id, code, name, type, unit_id, standard_cost, security_classification
     FROM products WHERE id = $1 AND tenant_id = $2`,
    [productId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest(`Product ${productId} not found`);
  return res.rows[0];
}

async function getWorkOrder(client: pg.PoolClient, ctx: Ctx, workOrderId: number, expectedStatus?: string) {
  const res = await client.query(
    `SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [workOrderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Work order not found');
  const wo = res.rows[0];
  if (expectedStatus && String(wo.status) !== expectedStatus) {
    throw badRequest(`Work order must be ${expectedStatus} (current: ${wo.status})`);
  }
  return wo;
}

// ---------------------------------------------------------------------------
// Production plans
// ---------------------------------------------------------------------------

export interface PlanItemInput {
  productId: number;
  quantity: number;
  dueDate?: string | null;
}

/** Create a production plan (DRAFT). */
export async function createProductionPlan(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    planDate?: string;
    periodStart?: string | null;
    periodEnd?: string | null;
    facilityId?: number | null;
    notes?: string | null;
    items: PlanItemInput[];
  }
) {
  const companyId = ctx.companyId;
  if (!companyId) throw badRequest('Company context required');
  if (input.items.length === 0) throw badRequest('At least one plan item is required');
  const planNo = await nextDoc(client, ctx, 'PLAN');
  const ins = await client.query(
    `INSERT INTO production_plans
       (company_id, tenant_id, branch_id, facility_id, plan_no, plan_date, period_start, period_end, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10) RETURNING id`,
    [
      companyId, ctx.tenantId, ctx.branchId ?? null, input.facilityId ?? null, planNo,
      input.planDate ?? new Date().toISOString().slice(0, 10),
      input.periodStart ?? null, input.periodEnd ?? null, input.notes ?? null, ctx.userId ?? null,
    ]
  );
  const planId = Number(ins.rows[0].id);
  for (const item of input.items) {
    const product = await productMeta(client, ctx, item.productId);
    const qty = Number(item.quantity);
    if (qty <= 0) throw badRequest('Plan item quantity must be positive');
    await client.query(
      `INSERT INTO production_plan_items (plan_id, product_id, quantity, unit_id, due_date)
       VALUES ($1,$2,$3,$4,$5)`,
      [planId, item.productId, qty, product.unit_id ?? null, item.dueDate ?? null]
    );
  }
  await emitEvent(client, ctx, {
    eventType: 'production.plan_created',
    entityType: 'production_plans',
    entityId: planId,
    entityCode: planNo,
    payload: { items: input.items.length },
  });
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'production_plans',
    recordId: planId,
    recordCode: planNo,
    newValues: { items: input.items.length },
  });
  return { planId, planNo };
}

export async function submitProductionPlan(client: pg.PoolClient, ctx: Ctx, planId: number) {
  const plan = (await client.query(
    `SELECT * FROM production_plans WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [planId, ctx.tenantId]
  )).rows[0];
  if (!plan) throw notFound('Production plan not found');
  if (String(plan.status) !== 'DRAFT') throw badRequest(`Plan must be DRAFT (current: ${plan.status})`);
  await client.query(`UPDATE production_plans SET status = 'SUBMITTED' WHERE id = $1`, [planId]);
  await startWorkflow(client, ctx, {
    entityType: 'production.plans',
    entityId: planId,
    entityCode: String(plan.plan_no),
  });
  return { planId, planNo: plan.plan_no };
}

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------

export interface WorkOrderInput {
  productId: number;
  quantity: number;
  bomId?: number | null;
  routingId?: number | null;
  planId?: number | null;
  planItemId?: number | null;
  salesOrderId?: number | null;
  salesOrderItemId?: number | null;
  machineId?: number | null;
  operatorId?: number | null;
  priority?: string;
  startDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
}

/** Create a work order from the product BOM + routing (DRAFT). */
export async function createWorkOrder(client: pg.PoolClient, ctx: Ctx, input: WorkOrderInput) {
  const companyId = ctx.companyId;
  if (!companyId) throw badRequest('Company context required');
  const qty = Number(input.quantity);
  if (qty <= 0) throw badRequest('Work order quantity must be positive');
  const product = await productMeta(client, ctx, input.productId);

  // Resolve BOM (explicit id, else latest active for the product)
  let bom: any = null;
  if (input.bomId) {
    bom = (await client.query(`SELECT * FROM boms WHERE id = $1 AND tenant_id = $2`, [input.bomId, ctx.tenantId])).rows[0] ?? null;
  } else {
    bom = (await client.query(
      `SELECT * FROM boms WHERE product_id = $1 AND tenant_id = $2 AND is_active = true ORDER BY version DESC LIMIT 1`,
      [input.productId, ctx.tenantId]
    )).rows[0] ?? null;
  }
  let bomItems: any[] = [];
  if (bom) {
    bomItems = (await client.query(
      `SELECT bi.*, p.unit_id AS product_unit_id, p.standard_cost AS product_cost
       FROM bom_items bi JOIN products p ON p.id = bi.product_id
       WHERE bi.bom_id = $1`,
      [bom.id]
    )).rows;
  }

  // Resolve routing (explicit id, else latest active for the product)
  let routing: any = null;
  if (input.routingId) {
    routing = (await client.query(`SELECT * FROM routings WHERE id = $1 AND tenant_id = $2`, [input.routingId, ctx.tenantId])).rows[0] ?? null;
  } else {
    routing = (await client.query(
      `SELECT * FROM routings WHERE product_id = $1 AND tenant_id = $2 AND is_active = true ORDER BY version DESC LIMIT 1`,
      [input.productId, ctx.tenantId]
    )).rows[0] ?? null;
  }
  let routingOps: any[] = [];
  if (routing) {
    routingOps = (await client.query(
      `SELECT ro.*, wc.hourly_cost, wc.overhead_rate
       FROM routing_operations ro JOIN work_centres wc ON wc.id = ro.work_centre_id
       WHERE ro.routing_id = $1 ORDER BY ro.seq`,
      [routing.id]
    )).rows;
  }

  const woNo = await nextDoc(client, ctx, 'WO');
  const bomQty = bom ? Number(bom.quantity) : 1;
  let standardCost = 0;

  const materials: { productId: number; requiredQty: number; unitId: number | null; unitCost: number; isConsumable: boolean }[] = [];
  for (const bi of bomItems) {
    const requiredQty = Number(bi.quantity) * (qty / bomQty) * (1 + (Number(bi.scrap_percent) || 0) / 100);
    const unitCost = Number(bi.product_cost) || 0;
    materials.push({
      productId: Number(bi.product_id),
      requiredQty,
      unitId: bi.product_unit_id ? Number(bi.product_unit_id) : null,
      unitCost,
      isConsumable: Boolean(bi.is_consumable),
    });
    standardCost += requiredQty * unitCost;
  }

  const ops = routingOps.map((op: any) => ({
    routingOperationId: Number(op.id),
    seq: Number(op.seq),
    name: String(op.name),
    workCentreId: Number(op.work_centre_id),
    machineId: op.machine_id ? Number(op.machine_id) : null,
    plannedSetupMin: Number(op.setup_time_min ?? 0),
    plannedRunMin: Number(op.run_time_per_unit_min ?? 0) * qty,
    hourlyCost: Number(op.hourly_cost ?? 0),
    overheadRate: Number(op.overhead_rate ?? 0),
  }));
  for (const op of ops) {
    standardCost += ((op.plannedSetupMin + op.plannedRunMin) / 60) * op.hourlyCost;
  }

  const securityClassification = String(product.security_classification ?? 'NONE') === 'NONE' ? 'NONE' : String(product.security_classification);
  const ins = await client.query(
    `INSERT INTO work_orders
       (company_id, tenant_id, branch_id, facility_id, wo_no, product_id, bom_id, routing_id, plan_id, plan_item_id,
        sales_order_id, sales_order_item_id, quantity, unit_id, priority, status, security_classification,
        start_date, due_date, machine_id, operator_id, standard_cost, notes, created_by)
     VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'DRAFT',$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING id`,
    [
      companyId, ctx.tenantId, ctx.branchId ?? null, woNo, input.productId,
      bom ? bom.id : null, routing ? routing.id : null,
      input.planId ?? null, input.planItemId ?? null,
      input.salesOrderId ?? null, input.salesOrderItemId ?? null,
      qty, product.unit_id ?? null, input.priority ?? 'MEDIUM', securityClassification,
      input.startDate ?? null, input.dueDate ?? null,
      input.machineId ?? null, input.operatorId ?? null,
      round2(standardCost), input.notes ?? null, ctx.userId ?? null,
    ]
  );
  const workOrderId = Number(ins.rows[0].id);

  for (const m of materials) {
    await client.query(
      `INSERT INTO work_order_materials (work_order_id, product_id, required_qty, unit_id, unit_cost, is_consumable)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [workOrderId, m.productId, round2(m.requiredQty), m.unitId, round2(m.unitCost), m.isConsumable]
    );
  }
  for (const op of ops) {
    await client.query(
      `INSERT INTO work_order_operations
         (work_order_id, routing_operation_id, seq, name, work_centre_id, machine_id, planned_setup_min, planned_run_min)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [workOrderId, op.routingOperationId, op.seq, op.name, op.workCentreId, op.machineId, round2(op.plannedSetupMin), round2(op.plannedRunMin)]
    );
  }

  await emitEvent(client, ctx, {
    eventType: 'production.work_order_created',
    entityType: 'work_orders',
    entityId: workOrderId,
    entityCode: woNo,
    payload: { productId: input.productId, quantity: qty, standardCost: round2(standardCost) },
  });
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'work_orders',
    recordId: workOrderId,
    recordCode: woNo,
    newValues: { productId: input.productId, quantity: qty, bomId: bom ? bom.id : null, routingId: routing ? routing.id : null },
  });
  return { workOrderId, woNo, standardCost: round2(standardCost) };
}

/** Options for the work-order wizard: BOMs, routings, machines, exploded materials. */
export async function productSetup(client: pg.PoolClient, ctx: Ctx, productId: number, quantity = 1, bomId?: number | null, routingId?: number | null) {
  const product = await productMeta(client, ctx, productId);
  const boms = await client.query(
    `SELECT id, code, name, version, quantity, is_active, status FROM boms
     WHERE product_id = $1 AND tenant_id = $2 ORDER BY is_active DESC, version DESC`,
    [productId, ctx.tenantId]
  );
  const routings = await client.query(
    `SELECT id, code, name, version, is_active FROM routings
     WHERE product_id = $1 AND tenant_id = $2 ORDER BY is_active DESC, version DESC`,
    [productId, ctx.tenantId]
  );
  const machines = await client.query(
    `SELECT id, code, name, status, type FROM machines WHERE tenant_id = $1 AND company_id = $2 ORDER BY code`,
    [ctx.tenantId, ctx.companyId]
  );
  const chosenBom = bomId
    ? boms.rows.find((b) => Number(b.id) === Number(bomId)) ?? boms.rows[0]
    : boms.rows[0];
  const chosenRouting = routingId
    ? routings.rows.find((r) => Number(r.id) === Number(routingId)) ?? routings.rows[0]
    : routings.rows[0];
  let materials: Record<string, unknown>[] = [];
  if (chosenBom) {
    const items = await client.query(
      `SELECT bi.product_id, p.code AS product_code, p.name AS product_name, bi.quantity, bi.scrap_percent, bi.is_consumable, p.standard_cost
       FROM bom_items bi JOIN products p ON p.id = bi.product_id WHERE bi.bom_id = $1`,
      [chosenBom.id]
    );
    const bomQty = Number(chosenBom.quantity) || 1;
    materials = items.rows.map((bi) => ({
      productId: Number(bi.product_id),
      productCode: bi.product_code,
      productName: bi.product_name,
      requiredQty: round2(Number(bi.quantity) * (quantity / bomQty) * (1 + (Number(bi.scrap_percent) || 0) / 100)),
      scrapPercent: Number(bi.scrap_percent) || 0,
      isConsumable: Boolean(bi.is_consumable),
      unitCost: Number(bi.standard_cost) || 0,
    }));
  }
  let operations: Record<string, unknown>[] = [];
  if (chosenRouting) {
    const ops = await client.query(
      `SELECT seq, name, setup_time_min, run_time_per_unit_min FROM routing_operations WHERE routing_id = $1 ORDER BY seq`,
      [chosenRouting.id]
    );
    operations = ops.rows.map((op) => ({
      seq: Number(op.seq),
      name: op.name,
      setupMin: Number(op.setup_time_min) || 0,
      runMin: round2((Number(op.run_time_per_unit_min) || 0) * quantity),
    }));
  }
  return {
    product: toCamelRow(product as Record<string, unknown>),
    boms: toCamelRows(boms.rows),
    routings: toCamelRows(routings.rows),
    machines: toCamelRows(machines.rows),
    materials,
    operations,
    selectedBomId: chosenBom ? Number(chosenBom.id) : null,
    selectedRoutingId: chosenRouting ? Number(chosenRouting.id) : null,
  };
}

export async function submitWorkOrder(client: pg.PoolClient, ctx: Ctx, workOrderId: number) {
  const wo = await getWorkOrder(client, ctx, workOrderId, 'DRAFT');
  await client.query(`UPDATE work_orders SET status = 'SUBMITTED' WHERE id = $1`, [workOrderId]);
  await startWorkflow(client, ctx, {
    entityType: 'production.work_orders',
    entityId: workOrderId,
    entityCode: String(wo.wo_no),
  });
  return { workOrderId, woNo: wo.wo_no };
}

/** Release a draft or approved work order to the shop floor. */
export async function releaseWorkOrder(client: pg.PoolClient, ctx: Ctx, workOrderId: number) {
  const wo = await getWorkOrder(client, ctx, workOrderId);
  if (!['DRAFT', 'APPROVED'].includes(String(wo.status))) {
    throw badRequest(`Work order must be DRAFT or APPROVED to release (current: ${wo.status})`);
  }
  await client.query(
    `UPDATE work_orders SET status = 'RELEASED', released_by = $2, released_at = now() WHERE id = $1`,
    [workOrderId, ctx.userId ?? null]
  );
  await emitEvent(client, ctx, {
    eventType: 'production.work_order_released',
    entityType: 'work_orders',
    entityId: workOrderId,
    entityCode: String(wo.wo_no),
  });
  return { workOrderId, woNo: wo.wo_no };
}

/** Start production on a released or held work order. */
export async function startWorkOrder(client: pg.PoolClient, ctx: Ctx, workOrderId: number) {
  const wo = await getWorkOrder(client, ctx, workOrderId);
  if (!['RELEASED', 'ON_HOLD'].includes(String(wo.status))) {
    throw badRequest(`Work order must be RELEASED or ON_HOLD to start (current: ${wo.status})`);
  }
  if (wo.machine_id) {
    const machine = (await client.query(`SELECT * FROM machines WHERE id = $1`, [wo.machine_id])).rows[0];
    if (machine && ['BREAKDOWN', 'OFFLINE', 'MAINTENANCE'].includes(String(machine.status))) {
      throw badRequest(`Machine ${machine.code} is ${machine.status}; cannot start work order`);
    }
    await client.query(
      `INSERT INTO machine_status_history
         (machine_id, company_id, tenant_id, from_status, to_status, reason, work_order_id, changed_by)
       VALUES ($1,$2,$3,$4,'OPERATIONAL',$5,$6,$7)`,
      [wo.machine_id, ctx.companyId, ctx.tenantId, String(machine.status), 'Reserved for work order', workOrderId, ctx.userId ?? null]
    );
  }
  await client.query(
    `UPDATE work_orders SET status = 'IN_PROGRESS', started_at = now() WHERE id = $1`,
    [workOrderId]
  );
  if (wo.plan_id) {
    await client.query(
      `UPDATE production_plans SET status = 'IN_EXECUTION' WHERE id = $1 AND status = 'APPROVED'`,
      [wo.plan_id]
    );
  }
  await emitEvent(client, ctx, {
    eventType: 'production.started',
    entityType: 'work_orders',
    entityId: workOrderId,
    entityCode: String(wo.wo_no),
    payload: { machineId: wo.machine_id ? Number(wo.machine_id) : null },
  });
  await logAudit(client, ctx, {
    action: 'start',
    resource: 'work_orders',
    recordId: workOrderId,
    recordCode: String(wo.wo_no),
    newValues: { status: 'IN_PROGRESS' },
  });
  return { workOrderId, woNo: wo.wo_no };
}

// ---------------------------------------------------------------------------
// Execution: material issue, output, labour, downtime
// ---------------------------------------------------------------------------

export async function issueMaterial(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { workOrderId: number; materialId: number; quantity: number; warehouseId?: number | null; batchId?: number | null; binId?: number | null }
) {
  const wo = await getWorkOrder(client, ctx, input.workOrderId);
  if (!['RELEASED', 'IN_PROGRESS', 'ON_HOLD'].includes(String(wo.status))) {
    throw badRequest(`Work order must be RELEASED or IN_PROGRESS to issue material (current: ${wo.status})`);
  }
  const matRes = await client.query(
    `SELECT wm.*, p.type AS product_type, p.standard_cost AS product_cost
     FROM work_order_materials wm JOIN products p ON p.id = wm.product_id
     WHERE wm.id = $1 AND wm.work_order_id = $2 FOR UPDATE`,
    [input.materialId, input.workOrderId]
  );
  if (matRes.rows.length === 0) throw badRequest('Material line not found on this work order');
  const mat = matRes.rows[0];
  const qty = Number(input.quantity);
  if (qty <= 0) throw badRequest('Issue quantity must be positive');
  const issued = Number(mat.issued_qty);
  if (issued + qty > Number(mat.required_qty)) {
    throw badRequest(`Cannot issue ${qty}; only ${Number(mat.required_qty) - issued} remains on this work order`);
  }
  let warehouse = await warehouseByType(client, ctx, String(mat.product_type));
  let bin: number | null = await defaultBin(client, ctx, warehouse);
  if (input.warehouseId != null) {
    const wres = await client.query(
      `SELECT id FROM warehouses WHERE id = $1 AND company_id = $2`,
      [input.warehouseId, ctx.companyId]
    );
    if (wres.rows.length === 0) throw badRequest('Warehouse not found in this company');
    warehouse = Number(wres.rows[0].id);
  }
  if (input.binId != null) {
    const bres = await client.query(
      `SELECT b.id FROM warehouse_bins b JOIN warehouses w ON w.id = b.warehouse_id
       WHERE b.id = $1 AND w.company_id = $2`,
      [input.binId, ctx.companyId]
    );
    if (bres.rows.length === 0) throw badRequest('Bin not found in this company');
    bin = Number(bres.rows[0].id);
  }
  if (input.batchId != null) {
    const bres = await client.query(
      `SELECT id FROM product_batches WHERE id = $1 AND product_id = $2 AND company_id = $3`,
      [input.batchId, Number(mat.product_id), ctx.companyId]
    );
    if (bres.rows.length === 0) throw badRequest('Batch not found for this product');
  }
  const unitCost = Number(mat.unit_cost) || Number(mat.product_cost) || 0;
  await postMove(client, ctx, {
    movementType: 'PRODUCTION_ISSUE',
    product: Number(mat.product_id),
    warehouse,
    bin,
    batch: input.batchId ?? null,
    quantity: qty,
    unitCost,
    refType: 'work_orders',
    refId: input.workOrderId,
    refCode: String(wo.wo_no),
    workOrder: input.workOrderId,
    reason: `Material issue ${wo.wo_no}`,
  });
  await client.query(`UPDATE work_order_materials SET issued_qty = issued_qty + $1 WHERE id = $2`, [qty, input.materialId]);
  await finance.postInventoryValueChange(client, ctx, {
    productId: Number(mat.product_id),
    productType: String(mat.product_type),
    amount: -(qty * unitCost),
    entryDate: new Date().toISOString().slice(0, 10),
    description: `Material issue ${wo.wo_no}`,
    journalType: 'PRODUCTION',
    refType: 'work_orders',
    refId: input.workOrderId,
    refCode: String(wo.wo_no),
  });
  await emitEvent(client, ctx, {
    eventType: 'production.material_issued',
    entityType: 'work_orders',
    entityId: input.workOrderId,
    entityCode: String(wo.wo_no),
    payload: { materialId: input.materialId, quantity: qty },
  });
  await logAudit(client, ctx, {
    action: 'issue',
    resource: 'work_order_materials',
    recordId: input.materialId,
    recordCode: String(wo.wo_no),
    newValues: { quantity: qty },
  });
  return { workOrderId: input.workOrderId, materialId: input.materialId, quantity: qty };
}

export type OutputType = 'GOOD' | 'SCRAP' | 'REWORK' | 'WASTE';

export async function recordOutput(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { workOrderId: number; outputType: OutputType; quantity: number; unitCost?: number | null; reason?: string | null }
) {
  const wo = await getWorkOrder(client, ctx, input.workOrderId);
  if (String(wo.status) !== 'IN_PROGRESS') {
    throw badRequest(`Work order must be IN_PROGRESS to record output (current: ${wo.status})`);
  }
  const qty = Number(input.quantity);
  if (qty <= 0) throw badRequest('Output quantity must be positive');
  const product = await productMeta(client, ctx, Number(wo.product_id));
  const warehouse = await warehouseByType(client, ctx, String(product.type));
  const bin = await defaultBin(client, ctx, warehouse);
  const unitCost = input.unitCost != null ? Number(input.unitCost) : Number(product.standard_cost) || 0;

  let batchId: number | null = null;
  let qrId: number | null = null;

  if (input.outputType === 'GOOD') {
    const existing = (await client.query(
      `SELECT po.batch_id FROM production_outputs po
       WHERE po.work_order_id = $1 AND po.batch_id IS NOT NULL AND po.output_type = 'GOOD'
       ORDER BY po.id LIMIT 1`,
      [input.workOrderId]
    )).rows[0];
    if (existing) {
      batchId = Number(existing.batch_id);
    } else {
      const batchNo = await nextDoc(client, ctx, 'BT');
      const batchIns = await client.query(
        `INSERT INTO product_batches (company_id, tenant_id, product_id, batch_no, quantity, unit_cost, status, attributes)
         VALUES ($1,$2,$3,$4,0,$5,'ACTIVE','{}'::jsonb) RETURNING id`,
        [ctx.companyId, ctx.tenantId, Number(wo.product_id), batchNo, unitCost]
      );
      batchId = Number(batchIns.rows[0].id);
      const qrs = await generateQr(client, ctx, {
        entityType: 'BATCH',
        entityId: batchId,
        productId: Number(wo.product_id),
        batchId,
      });
      qrId = qrs[0].id;
      await client.query(`UPDATE work_orders SET batch_id = $1 WHERE id = $2`, [batchId, input.workOrderId]);
    }
    await postMove(client, ctx, {
      movementType: 'PRODUCTION_OUTPUT',
      product: Number(wo.product_id),
      batch: batchId,
      warehouse,
      bin,
      quantity: qty,
      unitCost,
      refType: 'work_orders',
      refId: input.workOrderId,
      refCode: String(wo.wo_no),
      workOrder: input.workOrderId,
      qr: qrId,
      reason: `Good output ${wo.wo_no}`,
    });
    await finance.postInventoryValueChange(client, ctx, {
      productId: Number(wo.product_id),
      productType: String(product.type),
      amount: qty * unitCost,
      entryDate: new Date().toISOString().slice(0, 10),
      description: `Production output ${wo.wo_no}`,
      journalType: 'PRODUCTION',
      refType: 'work_orders',
      refId: input.workOrderId,
      refCode: String(wo.wo_no),
    });
  } else if (input.outputType === 'SCRAP' || input.outputType === 'WASTE') {
    await postMove(client, ctx, {
      movementType: input.outputType === 'SCRAP' ? 'SCRAP' : 'CONSUMPTION',
      product: Number(wo.product_id),
      warehouse,
      bin,
      quantity: qty,
      unitCost,
      refType: 'work_orders',
      refId: input.workOrderId,
      refCode: String(wo.wo_no),
      workOrder: input.workOrderId,
      reason: input.reason ?? `${input.outputType} ${wo.wo_no}`,
    });
    await finance.postInventoryValueChange(client, ctx, {
      productId: Number(wo.product_id),
      productType: String(product.type),
      amount: -(qty * unitCost),
      entryDate: new Date().toISOString().slice(0, 10),
      description: `${input.outputType === 'SCRAP' ? 'Scrap' : 'Waste'} ${wo.wo_no}`,
      journalType: 'PRODUCTION',
      refType: 'work_orders',
      refId: input.workOrderId,
      refCode: String(wo.wo_no),
    });
  }

  await client.query(
    `INSERT INTO production_outputs (work_order_id, output_type, quantity, batch_id, qr_id, unit_cost, reason, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [input.workOrderId, input.outputType, qty, batchId, qrId, unitCost, input.reason ?? null, ctx.userId ?? null]
  );
  await client.query(
    `UPDATE work_orders SET
       produced_qty = produced_qty + CASE WHEN $2 = 'GOOD' THEN $1 ELSE 0 END,
       scrapped_qty = scrapped_qty + CASE WHEN $2 = 'SCRAP' THEN $1 ELSE 0 END,
       rework_qty = rework_qty + CASE WHEN $2 = 'REWORK' THEN $1 ELSE 0 END,
       waste_qty = waste_qty + CASE WHEN $2 = 'WASTE' THEN $1 ELSE 0 END
     WHERE id = $3`,
    [qty, input.outputType, input.workOrderId]
  );
  await emitEvent(client, ctx, {
    eventType: `production.output_${String(input.outputType).toLowerCase()}`,
    entityType: 'work_orders',
    entityId: input.workOrderId,
    entityCode: String(wo.wo_no),
    payload: { quantity: qty, batchId, qrId, outputType: input.outputType },
  });
  await logAudit(client, ctx, {
    action: 'record_output',
    resource: 'work_orders',
    recordId: input.workOrderId,
    recordCode: String(wo.wo_no),
    newValues: { outputType: input.outputType, quantity: qty, batchId, qrId },
  });
  return { workOrderId: input.workOrderId, outputType: input.outputType, quantity: qty, batchId, qrId };
}

export async function recordLabour(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { workOrderId: number; operatorUserId: number; hours: number; hourlyRate?: number | null; notes?: string | null }
) {
  const wo = await getWorkOrder(client, ctx, input.workOrderId);
  if (String(wo.status) !== 'IN_PROGRESS') throw badRequest(`Work order must be IN_PROGRESS to record labour`);
  const hours = Number(input.hours);
  if (hours <= 0) throw badRequest('Hours must be positive');
  let rate = input.hourlyRate != null ? Number(input.hourlyRate) : 0;
  if (rate === 0) {
    const wc = (await client.query(
      `SELECT hourly_cost FROM work_centres WHERE company_id = $1 AND code = 'MC-LABOUR'`,
      [ctx.companyId]
    )).rows[0];
    rate = wc ? Number(wc.hourly_cost) : 8000;
  }
  const cost = round2(hours * rate);
  await client.query(
    `INSERT INTO work_order_labour (work_order_id, operator_user_id, hours, hourly_rate, cost, notes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.workOrderId, input.operatorUserId, hours, rate, cost, input.notes ?? null]
  );
  await emitEvent(client, ctx, {
    eventType: 'production.labour_recorded',
    entityType: 'work_orders',
    entityId: input.workOrderId,
    entityCode: String(wo.wo_no),
    payload: { operatorUserId: input.operatorUserId, hours, cost },
  });
  return { workOrderId: input.workOrderId, hours, cost };
}

export async function recordDowntime(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    workOrderId: number;
    machineId?: number | null;
    downtimeType: string;
    reason?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    minutes?: number | null;
  }
) {
  const wo = await getWorkOrder(client, ctx, input.workOrderId);
  const machineId = input.machineId ?? (wo.machine_id ? Number(wo.machine_id) : null);
  if (!machineId) throw badRequest('machineId is required');
  let minutes = input.minutes != null ? Number(input.minutes) : null;
  const startedAt = input.startedAt ?? null;
  const endedAt = input.endedAt ?? null;
  if (minutes == null) {
    if (startedAt && endedAt) {
      minutes = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000));
    } else {
      throw badRequest('Either minutes or startedAt + endedAt is required');
    }
  }
  await client.query(
    `INSERT INTO production_downtime (work_order_id, machine_id, downtime_type, reason, started_at, ended_at, minutes, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [input.workOrderId, machineId, input.downtimeType, input.reason ?? null, startedAt, endedAt, minutes, ctx.userId ?? null]
  );
  if (input.downtimeType === 'BREAKDOWN') {
    const m = (await client.query(`SELECT status FROM machines WHERE id = $1`, [machineId])).rows[0];
    const fromStatus = m ? String(m.status) : 'OPERATIONAL';
    await client.query(`UPDATE machines SET status = 'BREAKDOWN' WHERE id = $1`, [machineId]);
    await client.query(
      `INSERT INTO machine_status_history
         (machine_id, company_id, tenant_id, from_status, to_status, reason, work_order_id, changed_by)
       VALUES ($1,$2,$3,$4,'BREAKDOWN',$5,$6,$7)`,
      [machineId, ctx.companyId, ctx.tenantId, fromStatus, input.reason ?? 'Breakdown recorded', input.workOrderId, ctx.userId ?? null]
    );
  }
  await emitEvent(client, ctx, {
    eventType: 'production.downtime_recorded',
    entityType: 'work_orders',
    entityId: input.workOrderId,
    entityCode: String(wo.wo_no),
    payload: { machineId, downtimeType: input.downtimeType, minutes },
    severity: input.downtimeType === 'BREAKDOWN' ? 'WARN' : 'INFO',
  });
  await logAudit(client, ctx, {
    action: 'record_downtime',
    resource: 'production_downtime',
    recordId: input.workOrderId,
    recordCode: String(wo.wo_no),
    newValues: { machineId, downtimeType: input.downtimeType, minutes },
  });
  return { workOrderId: input.workOrderId, machineId, minutes };
}

// ---------------------------------------------------------------------------
// Completion + costing
// ---------------------------------------------------------------------------

export async function completeWorkOrder(client: pg.PoolClient, ctx: Ctx, workOrderId: number) {
  const wo = await getWorkOrder(client, ctx, workOrderId);
  if (String(wo.status) !== 'IN_PROGRESS') {
    throw badRequest(`Work order must be IN_PROGRESS to complete (current: ${wo.status})`);
  }
  const product = await productMeta(client, ctx, Number(wo.product_id));

  const materials = (await client.query(
    `SELECT * FROM work_order_materials WHERE work_order_id = $1`,
    [workOrderId]
  )).rows;
  const actualMaterialCost = materials.reduce((sum, m) => sum + Number(m.issued_qty) * Number(m.unit_cost), 0);

  const labour = (await client.query(
    `SELECT * FROM work_order_labour WHERE work_order_id = $1`,
    [workOrderId]
  )).rows;
  const actualLabourCost = labour.reduce((sum, l) => sum + Number(l.cost), 0);

  const ops = (await client.query(
    `SELECT wo.*, wc.hourly_cost, wc.overhead_rate, m.hourly_rate AS machine_rate
     FROM work_order_operations wo
     LEFT JOIN work_centres wc ON wc.id = wo.work_centre_id
     LEFT JOIN machines m ON m.id = wo.machine_id
     WHERE wo.work_order_id = $1`,
    [workOrderId]
  )).rows;
  let actualMachineCost = 0;
  let actualOverheadCost = 0;
  for (const op of ops) {
    const hasActual = op.actual_started_at && op.actual_ended_at;
    const minutes = hasActual
      ? Math.max(0, (new Date(op.actual_ended_at).getTime() - new Date(op.actual_started_at).getTime()) / 60000)
      : Number(op.planned_setup_min) + Number(op.planned_run_min);
    const hours = minutes / 60;
    actualMachineCost += hours * (Number(op.machine_rate) || 0);
    actualOverheadCost += hours * (Number(op.hourly_cost) || 0) * (Number(op.overhead_rate) || 0);
  }

  const actualWasteCost = Number(wo.waste_qty) * (Number(product.standard_cost) || 0);
  const actualCost = round2(actualMaterialCost + actualLabourCost + actualMachineCost + actualOverheadCost + actualWasteCost);
  const standardCost = Number(wo.standard_cost);
  const costVariance = round2(standardCost - actualCost);
  const yieldPercent = Number(wo.quantity) > 0 ? round2((Number(wo.produced_qty) / Number(wo.quantity)) * 100) : 0;
  const efficiencyPercent = yieldPercent;

  await client.query(
    `UPDATE work_orders SET
       status = 'COMPLETED', completed_at = now(),
       actual_material_cost = $2, actual_labour_cost = $3, actual_machine_cost = $4,
       actual_overhead_cost = $5, actual_waste_cost = $6, actual_cost = $7, cost_variance = $8,
       yield_percent = $9, efficiency_percent = $10
     WHERE id = $1`,
    [
      workOrderId, round2(actualMaterialCost), round2(actualLabourCost), round2(actualMachineCost),
      round2(actualOverheadCost), round2(actualWasteCost), actualCost, costVariance, yieldPercent, efficiencyPercent,
    ]
  );

  if (wo.plan_id) {
    await client.query(
      `UPDATE production_plans SET status = 'COMPLETED'
       WHERE id = $1 AND status IN ('IN_EXECUTION','APPROVED')
         AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.plan_id = $1 AND w.status NOT IN ('COMPLETED','CLOSED','CANCELLED'))`,
      [wo.plan_id]
    );
  }

  await emitEvent(client, ctx, {
    eventType: 'production.completed',
    entityType: 'work_orders',
    entityId: workOrderId,
    entityCode: String(wo.wo_no),
    payload: { producedQty: Number(wo.produced_qty), actualCost, costVariance, yieldPercent },
  });
  await logAudit(client, ctx, {
    action: 'complete',
    resource: 'work_orders',
    recordId: workOrderId,
    recordCode: String(wo.wo_no),
    newValues: { status: 'COMPLETED', actualCost, costVariance, yieldPercent },
  });
  return { workOrderId, woNo: wo.wo_no, actualCost, costVariance, yieldPercent, efficiencyPercent };
}

export async function closeWorkOrder(client: pg.PoolClient, ctx: Ctx, workOrderId: number) {
  const wo = await getWorkOrder(client, ctx, workOrderId, 'COMPLETED');
  await client.query(`UPDATE work_orders SET status = 'CLOSED', closed_at = now() WHERE id = $1`, [workOrderId]);
  await emitEvent(client, ctx, {
    eventType: 'production.work_order_closed',
    entityType: 'work_orders',
    entityId: workOrderId,
    entityCode: String(wo.wo_no),
  });
  return { workOrderId, woNo: wo.wo_no };
}

export async function holdWorkOrder(client: pg.PoolClient, ctx: Ctx, workOrderId: number, reason?: string | null) {
  const wo = await getWorkOrder(client, ctx, workOrderId);
  if (!['RELEASED', 'IN_PROGRESS'].includes(String(wo.status))) {
    throw badRequest(`Cannot hold a work order in ${wo.status}`);
  }
  await client.query(
    `UPDATE work_orders SET status = 'ON_HOLD', notes = COALESCE($2, notes) WHERE id = $1`,
    [workOrderId, reason ?? null]
  );
  await logAudit(client, ctx, {
    action: 'hold',
    resource: 'work_orders',
    recordId: workOrderId,
    recordCode: String(wo.wo_no),
    newValues: { status: 'ON_HOLD', reason },
  });
  return { workOrderId, woNo: wo.wo_no, status: 'ON_HOLD' };
}

export async function listWorkOrders(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['wo.tenant_id = $1', 'wo.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(wo.wo_no ILIKE $${params.length} OR p.code ILIKE $${params.length} OR p.name ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`wo.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT wo.id, wo.wo_no, wo.status, wo.priority, wo.quantity, wo.produced_qty, wo.waste_qty, wo.scrapped_qty,
            wo.standard_cost, wo.actual_cost, wo.due_date, wo.start_date,
            p.code AS product_code, p.name AS product_name, m.code AS machine_code
     FROM work_orders wo
     JOIN products p ON p.id = wo.product_id
     LEFT JOIN machines m ON m.id = wo.machine_id
     WHERE ${where.join(' AND ')}
     ORDER BY wo.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = await client.query(
    `SELECT count(*)::int AS n FROM work_orders wo JOIN products p ON p.id = wo.product_id WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(res.rows), total: Number(total.rows[0].n), page, pageSize };
}

export async function getWorkOrderDetail(client: pg.PoolClient, ctx: Ctx, workOrderId: number) {
  const res = await client.query(
    `SELECT wo.*, p.code AS product_code, p.name AS product_name, p.type AS product_type,
            m.code AS machine_code, m.name AS machine_name
     FROM work_orders wo
     JOIN products p ON p.id = wo.product_id
     LEFT JOIN machines m ON m.id = wo.machine_id
     WHERE wo.id = $1 AND wo.tenant_id = $2`,
    [workOrderId, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Work order not found');
  const materials = await client.query(
    `SELECT wm.*, p.code AS product_code, p.name AS product_name,
            COALESCE((SELECT sum(i.quantity - i.reserved_qty) FROM inventory i WHERE i.product_id = wm.product_id),0)::numeric AS available_qty
     FROM work_order_materials wm JOIN products p ON p.id = wm.product_id
     WHERE wm.work_order_id = $1 ORDER BY wm.id`,
    [workOrderId]
  );
  const operations = await client.query(
    `SELECT * FROM work_order_operations WHERE work_order_id = $1 ORDER BY seq`,
    [workOrderId]
  );
  const outputs = await client.query(
    `SELECT * FROM production_outputs WHERE work_order_id = $1 ORDER BY id DESC`,
    [workOrderId]
  );
  return {
    workOrder: toCamelRow(res.rows[0]),
    materials: toCamelRows(materials.rows),
    operations: toCamelRows(operations.rows),
    outputs: toCamelRows(outputs.rows),
  };
}

export async function listPlans(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT pp.*,
            (SELECT count(*) FROM production_plan_items i WHERE i.plan_id = pp.id)::int AS item_count,
            (SELECT count(*) FROM work_orders w WHERE w.plan_id = pp.id)::int AS wo_count
     FROM production_plans pp
     WHERE pp.tenant_id = $1 AND pp.company_id = $2
     ORDER BY pp.id DESC`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function getPlan(client: pg.PoolClient, ctx: Ctx, planId: number) {
  const res = await client.query(
    `SELECT * FROM production_plans WHERE id = $1 AND tenant_id = $2`,
    [planId, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Production plan not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name
     FROM production_plan_items i JOIN products p ON p.id = i.product_id
     WHERE i.plan_id = $1 ORDER BY i.id`,
    [planId]
  );
  const orders = await client.query(
    `SELECT wo.id, wo.wo_no, wo.status, wo.quantity, wo.produced_qty, p.code AS product_code
     FROM work_orders wo JOIN products p ON p.id = wo.product_id
     WHERE wo.plan_id = $1 ORDER BY wo.id`,
    [planId]
  );
  return { plan: toCamelRow(res.rows[0]), items: toCamelRows(items.rows), workOrders: toCamelRows(orders.rows) };
}

export async function explodePlan(client: pg.PoolClient, ctx: Ctx, planId: number) {
  const { plan, items } = await getPlan(client, ctx, planId);
  if (!['DRAFT', 'APPROVED', 'IN_EXECUTION'].includes(String(plan.status))) {
    throw badRequest(`Cannot explode a ${plan.status} plan`);
  }
  const created: { workOrderId: number; woNo: string }[] = [];
  for (const item of items) {
    const existing = await client.query(
      `SELECT id FROM work_orders WHERE plan_id = $1 AND plan_item_id = $2 AND status NOT IN ('CANCELLED')`,
      [planId, item.id]
    );
    if (existing.rows.length) continue;
    const wo = await createWorkOrder(client, ctx, {
      productId: Number(item.productId),
      quantity: Number(item.quantity),
      planId,
      planItemId: Number(item.id),
      dueDate: item.dueDate != null ? String(item.dueDate).slice(0, 10) : null,
    });
    created.push({ workOrderId: wo.workOrderId, woNo: wo.woNo });
  }
  if (String(plan.status) === 'DRAFT') {
    await client.query(`UPDATE production_plans SET status = 'APPROVED' WHERE id = $1`, [planId]);
  }
  return { planId, created };
}

export async function salesDemand(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT soi.id AS sales_order_item_id, so.id AS sales_order_id, so.order_no, so.status AS order_status,
            soi.product_id, p.code AS product_code, p.name AS product_name,
            soi.quantity, soi.dispatched_qty,
            (soi.quantity - soi.dispatched_qty) AS remaining_qty,
            COALESCE((SELECT sum(wo.quantity) FROM work_orders wo
                      WHERE wo.sales_order_item_id = soi.id AND wo.status NOT IN ('CANCELLED','REJECTED')),0)::numeric AS planned_qty
     FROM sales_order_items soi
     JOIN sales_orders so ON so.id = soi.order_id
     JOIN products p ON p.id = soi.product_id
     WHERE so.tenant_id = $1 AND so.company_id = $2
       AND so.status IN ('APPROVED','ALLOCATED','PARTIALLY_DISPATCHED')
       AND soi.quantity > soi.dispatched_qty
     ORDER BY so.id, soi.id`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function makeFromDemand(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { salesOrderItemId: number; quantity?: number }
) {
  const line = await client.query(
    `SELECT soi.*, so.order_no FROM sales_order_items soi
     JOIN sales_orders so ON so.id = soi.order_id
     WHERE soi.id = $1 AND so.tenant_id = $2`,
    [input.salesOrderItemId, ctx.tenantId]
  );
  if (!line.rows.length) throw notFound('Sales order line not found');
  const soi = line.rows[0];
  const remaining = Number(soi.quantity) - Number(soi.dispatched_qty);
  const qty = input.quantity != null ? Number(input.quantity) : remaining;
  if (!(qty > 0)) throw badRequest('Quantity must be positive');
  return createWorkOrder(client, ctx, {
    productId: Number(soi.product_id),
    quantity: qty,
    salesOrderId: Number(soi.order_id),
    salesOrderItemId: Number(soi.id),
    notes: `From ${soi.order_no}`,
  });
}

export async function plantBoard(client: pg.PoolClient, ctx: Ctx) {
  const live = await client.query(
    `SELECT wo.id, wo.wo_no, wo.status, wo.priority, wo.quantity, wo.produced_qty, wo.waste_qty,
            p.code AS product_code, p.name AS product_name, m.code AS machine_code
     FROM work_orders wo
     JOIN products p ON p.id = wo.product_id
     LEFT JOIN machines m ON m.id = wo.machine_id
     WHERE wo.tenant_id = $1 AND wo.company_id = $2
       AND wo.status IN ('DRAFT','APPROVED','RELEASED','IN_PROGRESS','ON_HOLD')
     ORDER BY CASE wo.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, wo.id DESC
     LIMIT 40`,
    [ctx.tenantId, ctx.companyId]
  );
  const machines = await client.query(
    `SELECT m.id, m.code, m.name, m.status, m.type,
            (SELECT wo.wo_no FROM work_orders wo WHERE wo.machine_id = m.id AND wo.status = 'IN_PROGRESS' ORDER BY wo.id DESC LIMIT 1) AS current_wo
     FROM machines m WHERE m.tenant_id = $1 AND m.company_id = $2 ORDER BY m.code`,
    [ctx.tenantId, ctx.companyId]
  );
  const kpis = await client.query(
    `SELECT
       count(*) FILTER (WHERE status IN ('RELEASED','IN_PROGRESS','ON_HOLD'))::int AS live,
       count(*) FILTER (WHERE status = 'DRAFT')::int AS drafts,
       COALESCE(sum(quantity) FILTER (WHERE status IN ('RELEASED','IN_PROGRESS','ON_HOLD','COMPLETED')),0)::numeric AS planned,
       COALESCE(sum(produced_qty),0)::numeric AS produced,
       COALESCE(sum(waste_qty + scrapped_qty),0)::numeric AS waste
     FROM work_orders WHERE tenant_id = $1 AND company_id = $2`,
    [ctx.tenantId, ctx.companyId]
  );
  const shortages = await client.query(
    `SELECT p.code, p.name, sum(wm.required_qty - wm.issued_qty)::numeric AS short_qty,
            COALESCE((SELECT sum(i.quantity - i.reserved_qty) FROM inventory i WHERE i.product_id = wm.product_id),0)::numeric AS available
     FROM work_order_materials wm
     JOIN work_orders wo ON wo.id = wm.work_order_id
     JOIN products p ON p.id = wm.product_id
     WHERE wo.tenant_id = $1 AND wo.company_id = $2
       AND wo.status IN ('RELEASED','IN_PROGRESS','ON_HOLD')
       AND wm.required_qty > wm.issued_qty
     GROUP BY p.code, p.name, wm.product_id
     HAVING sum(wm.required_qty - wm.issued_qty) >
            COALESCE((SELECT sum(i.quantity - i.reserved_qty) FROM inventory i WHERE i.product_id = wm.product_id),0)
     ORDER BY 3 DESC`,
    [ctx.tenantId, ctx.companyId]
  );
  return {
    kpis: toCamelRow(kpis.rows[0]),
    live: toCamelRows(live.rows),
    machines: toCamelRows(machines.rows),
    shortages: toCamelRows(shortages.rows),
  };
}
