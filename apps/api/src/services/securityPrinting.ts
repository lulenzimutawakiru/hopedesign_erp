import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, forbidden, notFound } from '../utils.js';
import { startWorkflow } from './workflow.js';
import { postMove } from './inventory.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import { generateQr } from './qr.js';
import * as finance from './finance.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

const SECURITY_CLASSIFICATIONS = ['RESTRICTED', 'CONFIDENTIAL', 'SECRET'] as const;
type SecurityClassification = (typeof SECURITY_CLASSIFICATIONS)[number];

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
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

/** Default warehouse by product type (security items go to SEC-WH). */
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
    `SELECT id FROM warehouse_bins WHERE warehouse_id = $1 AND tenant_id = $2 ORDER BY code LIMIT 1`,
    [warehouseId, ctx.tenantId]
  );
  return res.rows.length ? Number(res.rows[0].id) : null;
}

async function getSecureJob(
  client: pg.PoolClient,
  ctx: Ctx,
  jobId: number,
  expectedStatus?: string
) {
  const res = await client.query(
    `SELECT * FROM security_jobs WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [jobId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Security job not found');
  const job = res.rows[0];
  if (expectedStatus && String(job.status) !== expectedStatus) {
    throw badRequest(`Security job must be ${expectedStatus} (current: ${job.status})`);
  }
  return job;
}

async function assertRole(client: pg.PoolClient, userId: number, roleCode: string) {
  const res = await client.query(
    `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND r.code = $2 LIMIT 1`,
    [userId, roleCode]
  );
  if (res.rows.length === 0) throw forbidden(`Requires role ${roleCode}`);
}

async function activeUser(client: pg.PoolClient, ctx: Ctx, userId: number, label: string) {
  const res = await client.query(
    `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
    [userId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest(`${label} user not found or inactive`);
}

async function addCustody(
  client: pg.PoolClient,
  ctx: Ctx,
  jobId: number,
  eventType: string,
  opts: { fromUserId?: number | null; toUserId?: number | null; witnessUserId?: number | null; fromLocation?: string | null; toLocation?: string | null; notes?: string | null } = {}
) {
  await client.query(
    `INSERT INTO secure_custody_events
       (company_id, tenant_id, job_id, event_type, from_user_id, to_user_id, witness_user_id, from_location, to_location, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      ctx.companyId, ctx.tenantId, jobId, eventType,
      opts.fromUserId ?? ctx.userId ?? null,
      opts.toUserId ?? null,
      opts.witnessUserId ?? null,
      opts.fromLocation ?? null,
      opts.toLocation ?? null,
      opts.notes ?? null,
    ]
  );
}

// ---------------------------------------------------------------------------
// Job creation + submission
// ---------------------------------------------------------------------------

export interface SecureRequirementInput {
  productId: number;
  quantityRequired: number;
  unitCost?: number;
  securityCleared?: boolean;
}

export async function createSecureJob(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    customerId: number;
    salesOrderId?: number | null;
    description: string;
    specification?: Record<string, unknown>;
    securityClassification: SecurityClassification;
    quantityPlanned: number;
    startDate?: string | null;
    dueDate?: string | null;
    facilityId?: number | null;
    requirements: SecureRequirementInput[];
    operators?: number[];
    machines?: number[];
    notes?: string | null;
  }
) {
  const companyId = ctx.companyId;
  const userId = ctx.userId;
  if (!companyId) throw badRequest('Company context required');
  if (!userId) throw forbidden();
  if (input.requirements.length === 0) throw badRequest('At least one material requirement is required');
  if (!SECURITY_CLASSIFICATIONS.includes(input.securityClassification)) {
    throw badRequest(`Invalid security classification (allowed: ${SECURITY_CLASSIFICATIONS.join(', ')})`);
  }
  if (Number(input.quantityPlanned) <= 0) throw badRequest('Planned quantity must be positive');

  const cust = await client.query(
    `SELECT id FROM customers WHERE id = $1 AND tenant_id = $2`,
    [input.customerId, ctx.tenantId]
  );
  if (cust.rows.length === 0) throw badRequest('Customer not found');

  const jobNo = await nextDoc(client, ctx, 'SJ');
  const ins = await client.query(
    `INSERT INTO security_jobs
       (company_id, tenant_id, branch_id, facility_id, job_no, customer_id, sales_order_id, description,
        specification, security_classification, status, quantity_planned, start_date, due_date, requested_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT',$11,$12,$13,$14,$15) RETURNING id`,
    [
      companyId, ctx.tenantId, ctx.branchId ?? null, input.facilityId ?? null, jobNo,
      input.customerId, input.salesOrderId ?? null, input.description,
      JSON.stringify(input.specification ?? {}), input.securityClassification,
      Number(input.quantityPlanned), input.startDate ?? null, input.dueDate ?? null, userId, input.notes ?? null,
    ]
  );
  const jobId = Number(ins.rows[0].id);

  for (const req of input.requirements) {
    const product = await productMeta(client, ctx, req.productId);
    if (Number(req.quantityRequired) <= 0) throw badRequest('Requirement quantity must be positive');
    await client.query(
      `INSERT INTO security_job_requirements (job_id, product_id, quantity_required, unit_id, unit_cost, security_cleared)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [jobId, req.productId, Number(req.quantityRequired), product.unit_id ?? null, Number(req.unitCost ?? 0), req.securityCleared ?? false]
    );
  }
  for (const operatorUserId of input.operators ?? []) {
    await activeUser(client, ctx, operatorUserId, 'Operator');
    await client.query(
      `INSERT INTO security_job_operators (job_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [jobId, operatorUserId]
    );
  }
  for (const machineId of input.machines ?? []) {
    await assignSecureMachine(client, ctx, jobId, machineId, true);
  }

  await addCustody(client, ctx, jobId, 'JOB_CREATED', { fromUserId: userId });
  await emitEvent(client, ctx, {
    eventType: 'security_printing.job_created',
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: jobNo,
    payload: { customerId: input.customerId, classification: input.securityClassification, requirements: input.requirements.length },
  });
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'security_jobs',
    recordId: jobId,
    recordCode: jobNo,
    newValues: { classification: input.securityClassification, requirements: input.requirements.length },
  });
  return { jobId, jobNo };
}

export async function submitSecureJob(client: pg.PoolClient, ctx: Ctx, jobId: number) {
  const job = await getSecureJob(client, ctx, jobId, 'DRAFT');
  const totalRes = await client.query(
    `SELECT COALESCE(SUM(quantity_required * unit_cost),0)::numeric AS total FROM security_job_requirements WHERE job_id = $1`,
    [jobId]
  );
  const total = Number(totalRes.rows[0].total);
  await client.query(`UPDATE security_jobs SET status = 'SUBMITTED' WHERE id = $1`, [jobId]);
  await startWorkflow(client, ctx, {
    entityType: 'security_printing.jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
    amount: total,
  });
  return { jobId, jobNo: String(job.job_no), total };
}
/**
 * Workflow hook: a security job approval task was approved.
 * Step 1 = job approval (creator may not approve own job).
 * Step 2 = materials authorization (dual control: approver may not authorize own approval).
 */
export async function handleSecureJobTaskApproved(
  client: pg.PoolClient,
  ctx: Ctx,
  jobId: number,
  stepSeq: number
) {
  const user = ctx.userId;
  if (!user) throw forbidden();
  const job = await getSecureJob(client, ctx, jobId);
  await assertRole(client, user, 'secure_job_approver');

  if (stepSeq === 1) {
    if (String(job.status) !== 'SUBMITTED') {
      throw badRequest(`Security job must be SUBMITTED (current: ${job.status})`);
    }
    if (Number(job.requested_by) === user) {
      throw forbidden('The creator cannot approve their own security job');
    }
    await client.query(
      `UPDATE security_jobs SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1`,
      [jobId, user]
    );
    await addCustody(client, ctx, jobId, 'JOB_APPROVED', { fromUserId: user, toUserId: Number(job.requested_by) });
    await emitEvent(client, ctx, {
      eventType: 'security_printing.job_approved',
      entityType: 'security_jobs',
      entityId: jobId,
      entityCode: String(job.job_no),
      payload: { step: 1 },
    });
    await logAudit(client, ctx, {
      action: 'approve',
      resource: 'security_jobs',
      recordId: jobId,
      recordCode: String(job.job_no),
      newValues: { status: 'APPROVED', approvedBy: user },
    });
    return { jobId, status: 'APPROVED' };
  }

  if (stepSeq === 2) {
    if (String(job.status) !== 'APPROVED') {
      throw badRequest(`Security job must be APPROVED (current: ${job.status})`);
    }
    if (job.approved_by && Number(job.approved_by) === user) {
      throw forbidden('Dual control: the job approver cannot also authorize materials');
    }
    await client.query(
      `UPDATE security_jobs SET status = 'MATERIALS_AUTHORIZED', materials_authorized_by = $2, materials_authorized_at = now() WHERE id = $1`,
      [jobId, user]
    );
    await client.query(
      `UPDATE security_job_requirements SET quantity_authorized = quantity_required WHERE job_id = $1`,
      [jobId]
    );
    await addCustody(client, ctx, jobId, 'MATERIALS_AUTHORIZED', { fromUserId: user });
    await emitEvent(client, ctx, {
      eventType: 'security_printing.materials_authorized',
      entityType: 'security_jobs',
      entityId: jobId,
      entityCode: String(job.job_no),
      payload: { step: 2 },
    });
    await logAudit(client, ctx, {
      action: 'authorize_materials',
      resource: 'security_jobs',
      recordId: jobId,
      recordCode: String(job.job_no),
      newValues: { status: 'MATERIALS_AUTHORIZED', authorizedBy: user },
    });
    return { jobId, status: 'MATERIALS_AUTHORIZED' };
  }

  throw badRequest(`Unknown security workflow step ${stepSeq}`);
}

// ---------------------------------------------------------------------------
// Material issue (dual control)
// ---------------------------------------------------------------------------

export async function issueSecureMaterials(
  client: pg.PoolClient,
  ctx: Ctx,
  jobId: number,
  input: {
    requirements: { requirementId: number; productId: number; batchId?: number | null; quantity: number }[];
    toLocation?: string | null;
    verifiedBy: number;
  }
) {
  const user = ctx.userId;
  if (!user) throw forbidden();
  const job = await getSecureJob(client, ctx, jobId, 'MATERIALS_AUTHORIZED');
  const verifiedBy = Number(input.verifiedBy);
  if (verifiedBy === user) throw badRequest('Dual control: issuer and verifier must be different users');
  await activeUser(client, ctx, verifiedBy, 'Verifier');
  if (input.requirements.length === 0) throw badRequest('At least one material issue line is required');

  for (const item of input.requirements) {
    const reqRes = await client.query(
      `SELECT * FROM security_job_requirements WHERE id = $1 AND job_id = $2 FOR UPDATE`,
      [item.requirementId, jobId]
    );
    if (reqRes.rows.length === 0) throw badRequest(`Requirement ${item.requirementId} not found on job`);
    const req = reqRes.rows[0];
    if (Number(req.product_id) !== Number(item.productId)) throw badRequest('Requirement product mismatch');
    const qty = Number(item.quantity);
    if (qty <= 0) throw badRequest('Issue quantity must be positive');
    if (qty > Number(req.quantity_authorized) - Number(req.quantity_issued)) {
      throw badRequest('Issue quantity exceeds authorized remaining quantity');
    }
    const product = await productMeta(client, ctx, Number(req.product_id));
    const warehouseId = await warehouseByType(client, ctx, String(product.type));
    const unitCost = Number(req.unit_cost) || 0;

    await postMove(client, ctx, {
      movementType: 'PRODUCTION_ISSUE',
      product: Number(req.product_id),
      batch: item.batchId ?? null,
      warehouse: warehouseId,
      quantity: qty,
      unitCost,
      refType: 'security_jobs',
      refId: jobId,
      refCode: String(job.job_no),
      reason: `Secure job ${job.job_no} material issue`,
    });
    await client.query(
      `INSERT INTO secure_material_issues
         (company_id, tenant_id, job_id, requirement_id, product_id, batch_id, quantity, from_warehouse_id, to_location, issued_by, verified_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        ctx.companyId, ctx.tenantId, jobId, Number(req.id), Number(req.product_id), item.batchId ?? null,
        qty, warehouseId, input.toLocation ?? null, user, verifiedBy,
      ]
    );
    await client.query(
      `UPDATE security_job_requirements SET quantity_issued = quantity_issued + $1 WHERE id = $2`,
      [qty, req.id]
    );
  }

  const remaining = await client.query(
    `SELECT count(*)::int AS n FROM security_job_requirements
     WHERE job_id = $1 AND quantity_issued < quantity_authorized`,
    [jobId]
  );
  if (Number(remaining.rows[0].n) > 0) {
    throw badRequest('All authorized material requirements must be fully issued before production');
  }

  await client.query(
    `UPDATE security_jobs SET status = 'MATERIALS_ISSUED', materials_issued_by = $2, materials_issued_at = now() WHERE id = $1`,
    [jobId, user]
  );
  await addCustody(client, ctx, jobId, 'MATERIALS_ISSUED', {
    fromUserId: user,
    witnessUserId: verifiedBy,
    toLocation: input.toLocation ?? null,
  });
  await emitEvent(client, ctx, {
    eventType: 'security_printing.materials_issued',
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
    payload: { verifiedBy, lines: input.requirements.length },
  });
  await logAudit(client, ctx, {
    action: 'issue_materials',
    resource: 'security_jobs',
    recordId: jobId,
    recordCode: String(job.job_no),
    newValues: { status: 'MATERIALS_ISSUED', verifiedBy },
  });
  return { jobId, jobNo: String(job.job_no) };
}
// ---------------------------------------------------------------------------
// Machine / operator assignment
// ---------------------------------------------------------------------------

const ASSIGNABLE_STATUSES = ['APPROVED', 'MATERIALS_AUTHORIZED', 'MATERIALS_ISSUED'];

/** Assign a secure machine to a job (silent = used during creation). */
export async function assignSecureMachine(
  client: pg.PoolClient,
  ctx: Ctx,
  jobId: number,
  machineId: number,
  silent = false
) {
  const job = await getSecureJob(client, ctx, jobId);
  if (!ASSIGNABLE_STATUSES.includes(String(job.status))) {
    throw badRequest(`Machines can only be assigned when ${ASSIGNABLE_STATUSES.join('/')} (current: ${job.status})`);
  }
  const mach = await client.query(
    `SELECT * FROM machines WHERE id = $1 AND tenant_id = $2`,
    [machineId, ctx.tenantId]
  );
  if (mach.rows.length === 0) throw badRequest('Machine not found');
  const machine = mach.rows[0];
  if (!machine.is_secure) throw badRequest(`Machine ${machine.code} is not a secure machine`);
  if (['BREAKDOWN', 'OFFLINE', 'MAINTENANCE'].includes(String(machine.status))) {
    throw badRequest(`Machine ${machine.code} is ${machine.status} and cannot be assigned`);
  }
  await client.query(
    `INSERT INTO security_job_machines (job_id, machine_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [jobId, machineId]
  );
  if (!silent) {
    await addCustody(client, ctx, jobId, 'MACHINE_ASSIGNED', { toUserId: null, notes: `Machine ${machine.code}` });
    await emitEvent(client, ctx, {
      eventType: 'security_printing.machine_assigned',
      entityType: 'security_jobs',
      entityId: jobId,
      entityCode: String(job.job_no),
      payload: { machineId, machineCode: machine.code },
    });
    await logAudit(client, ctx, {
      action: 'assign_machine',
      resource: 'security_jobs',
      recordId: jobId,
      recordCode: String(job.job_no),
      newValues: { machineId, machineCode: machine.code },
    });
  }
  return { jobId, machineId };
}

/** Activate a pre-authorized operator for a job (only job operators can be assigned). */
export async function assignSecureOperator(client: pg.PoolClient, ctx: Ctx, jobId: number, operatorUserId: number) {
  const user = ctx.userId;
  if (!user) throw forbidden();
  const job = await getSecureJob(client, ctx, jobId);
  if (!ASSIGNABLE_STATUSES.includes(String(job.status))) {
    throw badRequest(`Operators can only be assigned when ${ASSIGNABLE_STATUSES.join('/')} (current: ${job.status})`);
  }
  const member = await client.query(
    `SELECT 1 FROM security_job_operators WHERE job_id = $1 AND user_id = $2`,
    [jobId, operatorUserId]
  );
  if (member.rows.length === 0) {
    throw forbidden('Only operators pre-authorized on the job can be assigned to production');
  }
  await addCustody(client, ctx, jobId, 'OPERATOR_ASSIGNED', { toUserId: operatorUserId });
  await emitEvent(client, ctx, {
    eventType: 'security_printing.operator_assigned',
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
    payload: { operatorUserId },
  });
  await logAudit(client, ctx, {
    action: 'assign_operator',
    resource: 'security_jobs',
    recordId: jobId,
    recordCode: String(job.job_no),
    newValues: { operatorUserId },
  });
  return { jobId, operatorUserId };
}

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

export async function startSecureProduction(client: pg.PoolClient, ctx: Ctx, jobId: number) {
  const job = await getSecureJob(client, ctx, jobId, 'MATERIALS_ISSUED');
  const machines = (await client.query(
    `SELECT count(*)::int AS n FROM security_job_machines WHERE job_id = $1`,
    [jobId]
  )).rows[0];
  if (Number(machines.n) === 0) throw badRequest('At least one secure machine must be assigned before production');
  const operators = (await client.query(
    `SELECT count(*)::int AS n FROM security_job_operators WHERE job_id = $1`,
    [jobId]
  )).rows[0];
  if (Number(operators.n) === 0) throw badRequest('At least one authorized operator must be assigned before production');

  await client.query(`UPDATE security_jobs SET status = 'IN_PRODUCTION' WHERE id = $1`, [jobId]);
  await addCustody(client, ctx, jobId, 'PRODUCTION_STARTED');
  await emitEvent(client, ctx, {
    eventType: 'security_printing.production_started',
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
  });
  await logAudit(client, ctx, {
    action: 'start_production',
    resource: 'security_jobs',
    recordId: jobId,
    recordCode: String(job.job_no),
    newValues: { status: 'IN_PRODUCTION' },
  });
  return { jobId, status: 'IN_PRODUCTION' };
}

async function productBatchByNo(client: pg.PoolClient, ctx: Ctx, batchNo: string): Promise<number | null> {
  const res = await client.query(
    `SELECT id FROM product_batches WHERE company_id = $1 AND batch_no = $2 LIMIT 1`,
    [ctx.companyId, batchNo]
  );
  return res.rows.length ? Number(res.rows[0].id) : null;
}

export async function completeSecureProduction(
  client: pg.PoolClient,
  ctx: Ctx,
  jobId: number,
  input: { quantityGood: number; quantitySpoiled?: number; quantityWaste?: number; quantityRework?: number; productId: number }
) {
  const job = await getSecureJob(client, ctx, jobId, 'IN_PRODUCTION');
  const qtyGood = Number(input.quantityGood);
  const qtySpoiled = Number(input.quantitySpoiled ?? 0);
  const qtyWaste = Number(input.quantityWaste ?? 0);
  const qtyRework = Number(input.quantityRework ?? 0);
  if (qtyGood < 0 || qtySpoiled < 0 || qtyWaste < 0 || qtyRework < 0) throw badRequest('Quantities cannot be negative');
  if (qtyGood + qtySpoiled > Number(job.quantity_planned)) {
    throw badRequest('Good + spoiled quantity cannot exceed planned quantity');
  }

  const product = await productMeta(client, ctx, input.productId);
  const warehouse = await warehouseByType(client, ctx, String(product.type));
  const bin = await defaultBin(client, ctx, warehouse);
  const unitCost = Number(product.standard_cost) || 0;

  const batchNo = await nextDoc(client, ctx, 'BT');
  const batchIns = await client.query(
    `INSERT INTO product_batches (company_id, tenant_id, product_id, batch_no, quantity, unit_cost, status, attributes)
     VALUES ($1,$2,$3,$4,0,$5,'ACTIVE','{"source":"security_job"}'::jsonb) RETURNING id`,
    [ctx.companyId, ctx.tenantId, input.productId, batchNo, unitCost]
  );
  const productBatchId = Number(batchIns.rows[0].id);

  const qrs = await generateQr(client, ctx, {
    entityType: 'SECURITY_JOB',
    entityId: jobId,
    productId: input.productId,
    batchId: productBatchId,
  });
  const qr = qrs[0];

  await client.query(
    `INSERT INTO secure_batches
       (company_id, tenant_id, job_id, batch_no, quantity_good, quantity_spoiled, quantity_waste, quantity_rework,
        product_id, qc_result, warehouse_id, qr_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10,$11)`,
    [
      ctx.companyId, ctx.tenantId, jobId, batchNo, qtyGood, qtySpoiled, qtyWaste, qtyRework,
      input.productId, warehouse, qr.id,
    ]
  );

  if (qtyGood > 0) {
    await postMove(client, ctx, {
      movementType: 'PRODUCTION_OUTPUT',
      product: input.productId,
      batch: productBatchId,
      warehouse,
      bin,
      quantity: qtyGood,
      unitCost,
      refType: 'security_jobs',
      refId: jobId,
      refCode: String(job.job_no),
      qr: qr.id,
      reason: `Secure job ${job.job_no} good output`,
    });
    await finance.postInventoryValueChange(client, ctx, {
      productId: input.productId,
      productType: String(product.type),
      amount: qtyGood * unitCost,
      entryDate: new Date().toISOString().slice(0, 10),
      description: `Secure production output ${job.job_no}`,
      journalType: 'PRODUCTION',
      refType: 'security_jobs',
      refId: jobId,
      refCode: String(job.job_no),
    });
  }
  if (qtySpoiled > 0) {
    await postMove(client, ctx, {
      movementType: 'SCRAP',
      product: input.productId,
      batch: productBatchId,
      warehouse,
      bin,
      quantity: qtySpoiled,
      unitCost,
      refType: 'security_jobs',
      refId: jobId,
      refCode: String(job.job_no),
      reason: `Secure job ${job.job_no} spoiled output`,
    });
    await finance.postInventoryValueChange(client, ctx, {
      productId: input.productId,
      productType: String(product.type),
      amount: -(qtySpoiled * unitCost),
      entryDate: new Date().toISOString().slice(0, 10),
      description: `Secure production spoiled ${job.job_no}`,
      journalType: 'PRODUCTION',
      refType: 'security_jobs',
      refId: jobId,
      refCode: String(job.job_no),
    });
  }

  await client.query(
    `UPDATE security_jobs SET
       quantity_produced = quantity_produced + $2,
       quantity_spoiled = quantity_spoiled + $3,
       quantity_waste = quantity_waste + $4,
       quantity_rework = quantity_rework + $5,
       status = 'QC'
     WHERE id = $1`,
    [jobId, qtyGood, qtySpoiled, qtyWaste, qtyRework]
  );
  await addCustody(client, ctx, jobId, 'PRODUCTION_COMPLETED', { notes: `Batch ${batchNo}` });
  await emitEvent(client, ctx, {
    eventType: 'security_printing.production_completed',
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
    payload: { batchNo, qtyGood, qtySpoiled, qtyWaste, qtyRework, qrCode: qr.code },
  });
  await logAudit(client, ctx, {
    action: 'complete_production',
    resource: 'security_jobs',
    recordId: jobId,
    recordCode: String(job.job_no),
    newValues: { batchNo, qtyGood, qtySpoiled, qtyWaste, qtyRework, status: 'QC' },
  });
  return { jobId, jobNo: String(job.job_no), batchId: productBatchId, batchNo, qrCode: qr.code };
}

// ---------------------------------------------------------------------------
// QC
// ---------------------------------------------------------------------------

export async function qcSecureJob(
  client: pg.PoolClient,
  ctx: Ctx,
  jobId: number,
  input: { result: 'PASSED' | 'FAILED' | 'QUARANTINED'; batchId?: number | null; inspectorId?: number | null; notes?: string | null }
) {
  const job = await getSecureJob(client, ctx, jobId, 'QC');
  if (!['PASSED', 'FAILED', 'QUARANTINED'].includes(input.result)) {
    throw badRequest('QC result must be PASSED, FAILED or QUARANTINED');
  }
  const inspectorId = input.inspectorId ? Number(input.inspectorId) : ctx.userId ?? null;
  if (!inspectorId) throw forbidden();

  const batches = (await client.query(
    `SELECT * FROM secure_batches WHERE job_id = $1 ORDER BY id`,
    [jobId]
  )).rows;
  const target = input.batchId
    ? batches.find((b) => Number(b.id) === Number(input.batchId))
    : batches.find((b) => String(b.qc_result) === 'PENDING') ?? batches[0];
  if (!target) throw badRequest('No secure batch found for this job');

  await client.query(
    `UPDATE secure_batches SET qc_result = $2 WHERE job_id = $1 AND qc_result = 'PENDING'`,
    [jobId, input.result]
  );

  const inspectionNo = await nextDoc(client, ctx, 'QC');
  const productBatchId = await productBatchByNo(client, ctx, String(target.batch_no));
  await client.query(
    `INSERT INTO inspections
       (company_id, tenant_id, inspection_no, kind, ref_type, ref_id, product_id, batch_id,
        quantity, result, status, inspector_id, inspected_at, completed_at, notes)
     VALUES ($1,$2,$3,'FINAL','security_jobs',$4,$5,$6,$7,$8,'APPROVED',$9,now(),now(),$10)`,
    [
      ctx.companyId, ctx.tenantId, inspectionNo, jobId,
      Number(target.product_id), productBatchId,
      Number(target.quantity_good), input.result, inspectorId, input.notes ?? null,
    ]
  );

  let nextStatus: string | null = null;
  let custodyType = 'QC_FAILED';
  let severity: 'INFO' | 'WARN' | 'ERROR' = 'WARN';

  if (input.result === 'PASSED') {
    nextStatus = 'RECONCILIATION';
    custodyType = 'QC_PASSED';
    severity = 'INFO';
  } else if (input.result === 'FAILED') {
    nextStatus = 'ON_HOLD';
    severity = 'ERROR';
  } else {
    nextStatus = 'QC';
    severity = 'WARN';
  }

  if (nextStatus) {
    await client.query(`UPDATE security_jobs SET status = $2 WHERE id = $1`, [jobId, nextStatus]);
  }
  await addCustody(client, ctx, jobId, custodyType, {
    fromUserId: inspectorId,
    notes: input.result === 'QUARANTINED' ? `QUARANTINED: ${input.notes ?? ''}` : input.notes ?? null,
  });
  await emitEvent(client, ctx, {
    eventType: `security_printing.qc_${input.result.toLowerCase()}`,
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
    payload: { result: input.result, batchNo: target.batch_no, inspectionNo },
    severity,
  });
  await logAudit(client, ctx, {
    action: 'qc',
    resource: 'security_jobs',
    recordId: jobId,
    recordCode: String(job.job_no),
    newValues: { result: input.result, batchNo: target.batch_no, inspectionNo, status: nextStatus },
  });
  return { jobId, jobNo: String(job.job_no), result: input.result, status: nextStatus, inspectionNo };
}

// ---------------------------------------------------------------------------
// Reconciliation (dual control)
// ---------------------------------------------------------------------------

export async function reconcileSecureJob(
  client: pg.PoolClient,
  ctx: Ctx,
  jobId: number,
  input: {
    materialProductId: number;
    quantityIssued: number;
    quantityOutput: number;
    quantitySpoiled?: number;
    quantityWaste?: number;
    quantityReturned?: number;
    secondCheckerId: number;
    notes?: string | null;
  }
) {
  const user = ctx.userId;
  if (!user) throw forbidden();
  const job = await getSecureJob(client, ctx, jobId, 'RECONCILIATION');
  const secondCheckerId = Number(input.secondCheckerId);
  if (secondCheckerId === user) throw badRequest('Dual control: reconciler and second checker must be different users');
  await activeUser(client, ctx, secondCheckerId, 'Second checker');

  const issued = Number(input.quantityIssued);
  const output = Number(input.quantityOutput);
  const spoiled = Number(input.quantitySpoiled ?? 0);
  const waste = Number(input.quantityWaste ?? 0);
  const returned = Number(input.quantityReturned ?? 0);
  if (issued < 0 || output < 0 || spoiled < 0 || waste < 0 || returned < 0) {
    throw badRequest('Reconciliation quantities cannot be negative');
  }
  const variance = round2(issued - output - spoiled - waste - returned);
  const status = variance === 0 ? 'RECONCILED' : 'IN_VESTIGATION';

  const ins = await client.query(
    `INSERT INTO secure_reconciliations
       (company_id, tenant_id, job_id, material_product_id, quantity_issued, quantity_output,
        quantity_spoiled, quantity_waste, quantity_returned, variance, status, reconciled_by, second_checker_id, reconciled_at, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, jobId, input.materialProductId, issued, output,
      spoiled, waste, returned, variance, status, user, secondCheckerId, input.notes ?? null,
    ]
  );
  const reconciliationId = Number(ins.rows[0].id);

  await addCustody(client, ctx, jobId, 'RECONCILIATION', {
    fromUserId: user,
    witnessUserId: secondCheckerId,
    notes: `Variance ${variance} (${status})`,
  });
  await emitEvent(client, ctx, {
    eventType: `security_printing.reconciliation_${status === 'RECONCILED' ? 'passed' : 'investigation'}`,
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
    payload: { reconciliationId, variance, status },
    severity: status === 'RECONCILED' ? 'INFO' : 'WARN',
  });
  await logAudit(client, ctx, {
    action: 'reconcile',
    resource: 'security_jobs',
    recordId: jobId,
    recordCode: String(job.job_no),
    newValues: { reconciliationId, variance, status, secondCheckerId },
  });
  return { jobId, jobNo: String(job.job_no), variance, status, reconciliationId };
}

export async function resolveSecureReconciliation(
  client: pg.PoolClient,
  ctx: Ctx,
  jobId: number,
  input: { reconciliationId: number; resolved: boolean; secondCheckerId: number; notes?: string | null }
) {
  const user = ctx.userId;
  if (!user) throw forbidden();
  const job = await getSecureJob(client, ctx, jobId);
  const res = await client.query(
    `SELECT * FROM secure_reconciliations WHERE id = $1 AND job_id = $2 FOR UPDATE`,
    [input.reconciliationId, jobId]
  );
  if (res.rows.length === 0) throw notFound('Reconciliation not found');
  const rec = res.rows[0];
  if (String(rec.status) !== 'IN_VESTIGATION') {
    throw badRequest(`Reconciliation must be IN_VESTIGATION to resolve (current: ${rec.status})`);
  }
  const secondCheckerId = Number(input.secondCheckerId);
  if (secondCheckerId === user) throw badRequest('Dual control: resolver and second checker must be different users');
  await activeUser(client, ctx, secondCheckerId, 'Second checker');
  const parties = [Number(rec.reconciled_by), rec.second_checker_id ? Number(rec.second_checker_id) : null];
  if (!parties.includes(user)) {
    throw forbidden('Only the reconciler or the second checker may resolve this reconciliation');
  }

  const newStatus = input.resolved ? 'CLOSED' : 'IN_VESTIGATION';
  await client.query(
    `UPDATE secure_reconciliations SET status = $2, second_checker_id = $3, reconciled_at = now(), notes = $4 WHERE id = $1`,
    [input.reconciliationId, newStatus, secondCheckerId, input.notes ?? null]
  );
  await logAudit(client, ctx, {
    action: input.resolved ? 'resolve_reconciliation' : 'reopen_reconciliation',
    resource: 'security_jobs',
    recordId: jobId,
    recordCode: String(job.job_no),
    newValues: { reconciliationId: input.reconciliationId, status: newStatus, secondCheckerId },
  });
  return { jobId, reconciliationId: input.reconciliationId, status: newStatus };
}

// ---------------------------------------------------------------------------
// Packaging / storage / dispatch / delivery
// ---------------------------------------------------------------------------

export async function packageSecureJob(client: pg.PoolClient, ctx: Ctx, jobId: number) {
  const job = await getSecureJob(client, ctx, jobId, 'RECONCILIATION');
  const open = (await client.query(
    `SELECT count(*)::int AS n FROM secure_reconciliations WHERE job_id = $1 AND status IN ('OPEN','IN_VESTIGATION')`,
    [jobId]
  )).rows[0];
  if (Number(open.n) > 0) throw badRequest('All material variances must be resolved before packaging');
  await client.query(`UPDATE security_jobs SET status = 'PACKAGING' WHERE id = $1`, [jobId]);
  await addCustody(client, ctx, jobId, 'PACKAGING');
  await emitEvent(client, ctx, {
    eventType: 'security_printing.packaging',
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
  });
  return { jobId, status: 'PACKAGING' };
}

export async function secureStorageSecureJob(client: pg.PoolClient, ctx: Ctx, jobId: number) {
  const job = await getSecureJob(client, ctx, jobId, 'PACKAGING');
  await client.query(`UPDATE security_jobs SET status = 'IN_SECURE_STORAGE' WHERE id = $1`, [jobId]);
  await addCustody(client, ctx, jobId, 'SECURE_STORAGE');
  await emitEvent(client, ctx, {
    eventType: 'security_printing.secure_storage',
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
  });
  return { jobId, status: 'IN_SECURE_STORAGE' };
}

export async function dispatchSecureJob(client: pg.PoolClient, ctx: Ctx, jobId: number) {
  const job = await getSecureJob(client, ctx, jobId, 'IN_SECURE_STORAGE');
  const batches = (await client.query(
    `SELECT * FROM secure_batches WHERE job_id = $1 AND qc_result = 'PASSED' ORDER BY id`,
    [jobId]
  )).rows;
  if (batches.length === 0) throw badRequest('At least one QC-passed batch is required for dispatch');

  for (const batch of batches) {
    const product = await productMeta(client, ctx, Number(batch.product_id));
    const productBatchId = await productBatchByNo(client, ctx, String(batch.batch_no));
    const unitCost = Number(product.standard_cost) || 0;
    await postMove(client, ctx, {
      movementType: 'DISPTACH',
      product: Number(batch.product_id),
      batch: productBatchId,
      warehouse: batch.warehouse_id ? Number(batch.warehouse_id) : undefined,
      quantity: Number(batch.quantity_good),
      unitCost,
      refType: 'security_jobs',
      refId: jobId,
      refCode: String(job.job_no),
      reason: `Secure job ${job.job_no} dispatch`,
    });
  }

  await client.query(
    `UPDATE security_jobs SET status = 'DISPATCHED', quantity_dispatched = quantity_produced WHERE id = $1`,
    [jobId]
  );
  await addCustody(client, ctx, jobId, 'DISPATCH', { notes: `${batches.length} batch(es) dispatched` });
  await emitEvent(client, ctx, {
    eventType: 'security_printing.dispatched',
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
    payload: { batches: batches.length, quantity: Number(job.quantity_produced) },
  });
  await logAudit(client, ctx, {
    action: 'dispatch',
    resource: 'security_jobs',
    recordId: jobId,
    recordCode: String(job.job_no),
    newValues: { status: 'DISPATCHED', batches: batches.length },
  });
  return { jobId, status: 'DISPATCHED', batches: batches.length };
}

export async function deliverSecureJob(client: pg.PoolClient, ctx: Ctx, jobId: number) {
  const job = await getSecureJob(client, ctx, jobId, 'DISPATCHED');
  await client.query(
    `UPDATE security_jobs SET status = 'DELIVERED', completed_at = now() WHERE id = $1`,
    [jobId]
  );
  await addCustody(client, ctx, jobId, 'DELIVERY');
  await emitEvent(client, ctx, {
    eventType: 'security_printing.delivered',
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
  });
  return { jobId, status: 'DELIVERED' };
}

// ---------------------------------------------------------------------------
// Hold / resume / cancel
// ---------------------------------------------------------------------------

const HOLDABLE_STATUSES = [
  'APPROVED', 'MATERIALS_AUTHORIZED', 'MATERIALS_ISSUED', 'IN_PRODUCTION',
  'QC', 'RECONCILIATION', 'PACKAGING', 'IN_SECURE_STORAGE',
];
const RESUME_TARGETS = [
  'APPROVED', 'MATERIALS_AUTHORIZED', 'MATERIALS_ISSUED', 'IN_PRODUCTION',
  'QC', 'RECONCILIATION', 'PACKAGING', 'IN_SECURE_STORAGE',
];

export async function holdSecureJob(client: pg.PoolClient, ctx: Ctx, jobId: number, reason?: string | null) {
  const job = await getSecureJob(client, ctx, jobId);
  if (!HOLDABLE_STATUSES.includes(String(job.status))) {
    throw badRequest(`Job cannot be held from ${job.status}`);
  }
  await client.query(`UPDATE security_jobs SET status = 'ON_HOLD' WHERE id = $1`, [jobId]);
  await addCustody(client, ctx, jobId, 'HOLD', { notes: reason ?? null });
  await emitEvent(client, ctx, {
    eventType: 'security_printing.held',
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
    payload: { reason: reason ?? null },
    severity: 'WARN',
  });
  await logAudit(client, ctx, {
    action: 'hold',
    resource: 'security_jobs',
    recordId: jobId,
    recordCode: String(job.job_no),
    newValues: { status: 'ON_HOLD', reason: reason ?? null },
  });
  return { jobId, status: 'ON_HOLD' };
}

export async function resumeSecureJob(client: pg.PoolClient, ctx: Ctx, jobId: number, toStatus: string) {
  const job = await getSecureJob(client, ctx, jobId, 'ON_HOLD');
  if (!RESUME_TARGETS.includes(toStatus)) {
    throw badRequest(`Invalid resume target ${toStatus}`);
  }
  await client.query(`UPDATE security_jobs SET status = $2 WHERE id = $1`, [jobId, toStatus]);
  await addCustody(client, ctx, jobId, 'RESUME', { notes: `Resumed to ${toStatus}` });
  await emitEvent(client, ctx, {
    eventType: 'security_printing.resumed',
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
    payload: { toStatus },
  });
  return { jobId, status: toStatus };
}

export async function cancelSecureJob(client: pg.PoolClient, ctx: Ctx, jobId: number, reason?: string | null) {
  const job = await getSecureJob(client, ctx, jobId);
  if (!['DRAFT', 'SUBMITTED', 'ON_HOLD'].includes(String(job.status))) {
    throw badRequest(`Job can only be cancelled from DRAFT/SUBMITTED/ON_HOLD (current: ${job.status})`);
  }
  await client.query(`UPDATE security_jobs SET status = 'CANCELLED', notes = COALESCE($2, notes) WHERE id = $1`, [jobId, reason ?? null]);
  await emitEvent(client, ctx, {
    eventType: 'security_printing.cancelled',
    entityType: 'security_jobs',
    entityId: jobId,
    entityCode: String(job.job_no),
    payload: { reason: reason ?? null },
    severity: 'WARN',
  });
  await logAudit(client, ctx, {
    action: 'cancel',
    resource: 'security_jobs',
    recordId: jobId,
    recordCode: String(job.job_no),
    newValues: { status: 'CANCELLED', reason: reason ?? null },
  });
  return { jobId, status: 'CANCELLED' };
}

// ---------------------------------------------------------------------------
// Detail / traceability
// ---------------------------------------------------------------------------

export async function getSecureJobDetail(client: pg.PoolClient, ctx: Ctx, jobId: number) {
  const jobRes = await client.query(
    `SELECT sj.*, c.name AS customer_name, u.email AS requested_by_email
     FROM security_jobs sj
     LEFT JOIN customers c ON c.id = sj.customer_id
     LEFT JOIN users u ON u.id = sj.requested_by
     WHERE sj.id = $1 AND sj.tenant_id = $2`,
    [jobId, ctx.tenantId]
  );
  if (jobRes.rows.length === 0) throw notFound('Security job not found');
  const job = jobRes.rows[0];

  const requirements = (await client.query(
    `SELECT sjr.*, p.code AS product_code, p.name AS product_name, p.type AS product_type
     FROM security_job_requirements sjr
     LEFT JOIN products p ON p.id = sjr.product_id
     WHERE sjr.job_id = $1 ORDER BY sjr.id`,
    [jobId]
  )).rows;
  const operators = (await client.query(
    `SELECT sjo.*, (u.first_name || ' ' || u.last_name) AS operator_name, u.email AS operator_email
     FROM security_job_operators sjo
     LEFT JOIN users u ON u.id = sjo.user_id
     WHERE sjo.job_id = $1 ORDER BY sjo.id`,
    [jobId]
  )).rows;
  const machines = (await client.query(
    `SELECT sjm.*, m.code AS machine_code, m.name AS machine_name, m.status AS machine_status
     FROM security_job_machines sjm
     LEFT JOIN machines m ON m.id = sjm.machine_id
     WHERE sjm.job_id = $1 ORDER BY sjm.id`,
    [jobId]
  )).rows;
  const batches = (await client.query(
    `SELECT sb.*, q.code AS qr_code, q.status AS qr_status, p.code AS product_code, p.name AS product_name
     FROM secure_batches sb
     LEFT JOIN qr_codes q ON q.id = sb.qr_id
     LEFT JOIN products p ON p.id = sb.product_id
     WHERE sb.job_id = $1 ORDER BY sb.id`,
    [jobId]
  )).rows;
  const custody = (await client.query(
    `SELECT sce.*, (u.first_name || ' ' || u.last_name) AS actor_name, u.email AS actor_email
     FROM secure_custody_events sce
     LEFT JOIN users u ON u.id = sce.from_user_id
     WHERE sce.job_id = $1 ORDER BY sce.occurred_at, sce.id`,
    [jobId]
  )).rows;
  const reconciliations = (await client.query(
    `SELECT sr.*, p.code AS product_code, p.name AS product_name
     FROM secure_reconciliations sr
     LEFT JOIN products p ON p.id = sr.material_product_id
     WHERE sr.job_id = $1 ORDER BY sr.id`,
    [jobId]
  )).rows;

  return { job, requirements, operators, machines, batches, custody, reconciliations };
}
