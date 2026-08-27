import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest, notFound } from '../../utils.js';
import { logAudit } from '../../services/audit.js';
import { emitEvent } from '../../services/events.js';
import { postMove } from '../../services/inventory.js';
import { getAccountId, postJournalLines } from '../../services/finance.js';

export const healthcareOpsRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

const idOf = (p: Record<string, string>, name = 'id') => {
  const v = Number(p[name]);
  if (!Number.isFinite(v)) throw badRequest(`Invalid ${name}`);
  return v;
};

/** Admit an inpatient: reserve an available bed and open the admission. */
async function admitVisit(c: pg.PoolClient, ctx: Ctx, b: any, p: Record<string, string>) {
  const visitId = idOf(p);
  const bedId = b.bedId != null ? Number(b.bedId) : null;
  const visit = await c.query(
    `SELECT * FROM patient_visits WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [visitId, ctx.tenantId]
  );
  if (visit.rows.length === 0) throw notFound('Patient visit not found');
  const v = visit.rows[0];
  if (v.status !== 'REGISTERED' && v.status !== 'CHECKED_IN' && v.status !== 'TRIAGED' && v.status !== 'IN_PROGRESS') {
    throw badRequest(`Visit cannot be admitted from status ${v.status}`);
  }
  if (bedId == null) throw badRequest('bedId is required to admit a patient');
  const bed = await c.query(
    `SELECT * FROM beds WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [bedId, ctx.tenantId]
  );
  if (bed.rows.length === 0) throw notFound('Bed not found');
  const bd = bed.rows[0];
  if (bd.status !== 'AVAILABLE') throw badRequest(`Bed ${bd.code} is not available (${bd.status})`);
  await c.query(
    `UPDATE beds SET status = 'OCCUPIED', current_patient_id = $1, updated_at = now() WHERE id = $2`,
    [v.patient_id, bedId]
  );
  await c.query(
    `UPDATE patient_visits SET status = 'ADMITTED', admitted_at = now(), admitted_bed_id = $1, updated_at = now() WHERE id = $2`,
    [bedId, visitId]
  );
  await logAudit(c, ctx, {
    action: 'admit', resource: 'patient_visits', recordId: visitId, recordCode: String(v.visit_no),
    oldValues: { status: v.status, admitted_bed_id: v.admitted_bed_id },
    newValues: { status: 'ADMITTED', admitted_bed_id: bedId },
  });
  await emitEvent(c, ctx, {
    eventType: 'healthcare.visit_admitted', entityType: 'patient_visits', entityId: visitId,
    entityCode: String(v.visit_no), payload: { bedId, patientId: v.patient_id },
  });
  return { id: visitId, status: 'ADMITTED', bedId, admittedAt: new Date().toISOString() };
}

/** Discharge an inpatient: free the bed and close the admission. */
async function dischargeVisit(c: pg.PoolClient, ctx: Ctx, b: any, p: Record<string, string>) {
  const visitId = idOf(p);
  const visit = await c.query(
    `SELECT * FROM patient_visits WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [visitId, ctx.tenantId]
  );
  if (visit.rows.length === 0) throw notFound('Patient visit not found');
  const v = visit.rows[0];
  if (v.status !== 'ADMITTED') throw badRequest(`Visit must be ADMITTED before discharge (current: ${v.status})`);
  if (v.admitted_bed_id) {
    await c.query(
      `UPDATE beds SET status = 'AVAILABLE', current_patient_id = NULL, updated_at = now() WHERE id = $1`,
      [v.admitted_bed_id]
    );
  }
  await c.query(
    `UPDATE patient_visits SET status = 'DISCHARGED', discharged_at = now(), updated_at = now() WHERE id = $1`,
    [visitId]
  );
  await logAudit(c, ctx, {
    action: 'discharge', resource: 'patient_visits', recordId: visitId, recordCode: String(v.visit_no),
    oldValues: { status: v.status, admitted_bed_id: v.admitted_bed_id },
    newValues: { status: 'DISCHARGED', discharged_at: new Date().toISOString() },
  });
  await emitEvent(c, ctx, {
    eventType: 'healthcare.visit_discharged', entityType: 'patient_visits', entityId: visitId,
    entityCode: String(v.visit_no), payload: { bedId: v.admitted_bed_id, patientId: v.patient_id },
  });
  return { id: visitId, status: 'DISCHARGED' };
}

/** Dispense a prescription item: post the inventory issue and record the dispensing. */
async function createDispensing(c: pg.PoolClient, ctx: Ctx, b: any, _p: Record<string, string>) {
  const prescriptionId = Number(b.prescriptionId);
  const prescriptionItemId = Number(b.prescriptionItemId);
  const quantity = Number(b.quantity);
  const productId = Number(b.productId);
  const warehouseId = b.warehouseId != null ? Number(b.warehouseId) : null;
  const batchId = b.batchId != null ? Number(b.batchId) : null;
  if (!prescriptionId || !prescriptionItemId || !productId || !quantity || quantity <= 0) {
    throw badRequest('prescriptionId, prescriptionItemId, productId and a positive quantity are required');
  }
  const item = await c.query(
    `SELECT pi.*, pr.patient_id, pr.status AS prescription_status, pr.prescription_no
     FROM prescription_items pi
     JOIN prescriptions pr ON pr.id = pi.prescription_id
     WHERE pi.id = $1 AND pi.prescription_id = $2 AND pr.tenant_id = $3 FOR UPDATE`,
    [prescriptionItemId, prescriptionId, ctx.tenantId]
  );
  if (item.rows.length === 0) throw notFound('Prescription item not found');
  const it = item.rows[0];
  if (it.prescription_status !== 'APPROVED' && it.prescription_status !== 'ACTIVE') {
    throw badRequest(`Prescription must be APPROVED before dispensing (current: ${it.prescription_status})`);
  }
  const remaining = Number(it.quantity) - Number(it.dispensed_qty ?? 0);
  if (quantity > remaining) throw badRequest(`Quantity exceeds remaining dispenseable amount (${remaining})`);
  const noRes = await c.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, 'DSP']);
  const dispensingNo = String(noRes.rows[0].code);
  const ins = await c.query(
    `INSERT INTO dispensings
       (company_id, tenant_id, branch_id, dispensing_no, patient_id, prescription_id, prescription_item_id,
        product_id, batch_id, warehouse_id, quantity, dispensed_by, dispensed_at, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),'COMPLETED',now())
     RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, ctx.branchId ?? null, dispensingNo, it.patient_id, prescriptionId,
      prescriptionItemId, productId, batchId ?? null, warehouseId ?? null, quantity, ctx.userId ?? null,
    ]
  );
  const dispensingId = Number(ins.rows[0].id);
  await postMove(c, ctx, {
    movementType: 'ISSUE',
    product: productId,
    batch: batchId ?? null,
    warehouse: warehouseId ?? null,
    quantity,
    unitCost: b.unitCost != null ? Number(b.unitCost) : 0,
    refType: 'dispensings',
    refId: dispensingId,
    refCode: dispensingNo,
    reason: `Dispensing ${dispensingNo} for prescription ${it.prescription_no}`,
  });
  await c.query(
    `UPDATE prescription_items SET dispensed_qty = dispensed_qty + $1, updated_at = now() WHERE id = $2`,
    [quantity, prescriptionItemId]
  );
  await logAudit(c, ctx, {
    action: 'create', resource: 'dispensings', recordId: dispensingId, recordCode: dispensingNo,
    newValues: { quantity, productId, batchId, warehouseId, prescriptionItemId },
  });
  await emitEvent(c, ctx, {
    eventType: 'healthcare.dispensing_created', entityType: 'dispensings', entityId: dispensingId,
    entityCode: dispensingNo, payload: { prescriptionId, prescriptionItemId, quantity },
  });
  return { id: dispensingId, dispensingNo, status: 'COMPLETED' };
}

/** Complete a lab result: record performer, reviewer, values and status. */
async function completeLabResult(c: pg.PoolClient, ctx: Ctx, b: any, p: Record<string, string>) {
  const resultId = idOf(p);
  const res = await c.query(
    `SELECT * FROM lab_results WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [resultId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Lab result not found');
  const r = res.rows[0];
  if (r.status === 'COMPLETED') return { id: resultId, status: 'COMPLETED' };
  await c.query(
    `UPDATE lab_results
       SET result_value = COALESCE($1, result_value),
           unit = COALESCE($2, unit),
           is_abnormal = COALESCE($3, is_abnormal),
           performed_by = COALESCE($4, performed_by),
           performed_at = COALESCE($5, performed_at),
           reviewed_by = $6,
           reviewed_at = now(),
           status = 'COMPLETED',
           updated_at = now()
     WHERE id = $7`,
    [
      b.resultValue != null ? String(b.resultValue) : null,
      b.unit != null ? String(b.unit) : null,
      b.isAbnormal != null ? Boolean(b.isAbnormal) : null,
      b.performedBy != null ? Number(b.performedBy) : ctx.userId,
      b.performedAt ?? null,
      ctx.userId,
      resultId,
    ]
  );
  await logAudit(c, ctx, {
    action: 'complete', resource: 'lab_results', recordId: resultId, recordCode: String(r.result_no),
    oldValues: { status: r.status }, newValues: { status: 'COMPLETED', resultValue: b.resultValue ?? r.result_value },
  });
  await emitEvent(c, ctx, {
    eventType: 'healthcare.lab_result_completed', entityType: 'lab_results', entityId: resultId,
    entityCode: String(r.result_no), payload: { isAbnormal: b.isAbnormal ?? r.is_abnormal },
  });
  return { id: resultId, status: 'COMPLETED' };
}

/** Post a healthcare bill to the GL: Dr AR, Cr Revenue. */
async function postBill(c: pg.PoolClient, ctx: Ctx, _b: any, p: Record<string, string>) {
  const billId = idOf(p);
  const bill = await c.query(
    `SELECT * FROM healthcare_bills WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [billId, ctx.tenantId]
  );
  if (bill.rows.length === 0) throw notFound('Healthcare bill not found');
  const bl = bill.rows[0];
  if (bl.journal_id) return { id: billId, journalId: Number(bl.journal_id), status: bl.status };
  if (bl.status !== 'APPROVED' && bl.status !== 'CONFIRMED') {
    throw badRequest(`Healthcare bill must be APPROVED before posting (current: ${bl.status})`);
  }
  const arId = await getAccountId(c, ctx, '1400');
  const revId = await getAccountId(c, ctx, '4000');
  const amount = Number(bl.amount);
  const journalId = await postJournalLines(c, ctx, {
    entryDate: new Date().toISOString().slice(0, 10),
    journalType: 'HEALTHCARE_BILL',
    description: `Healthcare bill ${bl.bill_no}`,
    lines: [
      { account_id: arId, debit: amount, description: `Bill ${bl.bill_no}` },
      { account_id: revId, credit: amount, description: `Bill ${bl.bill_no}` },
    ],
    refType: 'healthcare_bills',
    refId: billId,
    refCode: String(bl.bill_no),
  });
  await c.query(
    `UPDATE healthcare_bills SET journal_id = $1, status = 'POSTED', updated_at = now() WHERE id = $2`,
    [journalId, billId]
  );
  await logAudit(c, ctx, {
    action: 'post', resource: 'healthcare_bills', recordId: billId, recordCode: String(bl.bill_no),
    oldValues: { status: bl.status }, newValues: { status: 'POSTED', journalId },
  });
  await emitEvent(c, ctx, {
    eventType: 'healthcare.bill_posted', entityType: 'healthcare_bills', entityId: billId,
    entityCode: String(bl.bill_no), payload: { journalId, amount },
  });
  return { id: billId, journalId, status: 'POSTED' };
}

/** Submit an insurance claim for adjudication. */
async function submitClaim(c: pg.PoolClient, ctx: Ctx, _b: any, p: Record<string, string>) {
  const claimId = idOf(p);
  const claim = await c.query(
    `SELECT * FROM insurance_claims WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [claimId, ctx.tenantId]
  );
  if (claim.rows.length === 0) throw notFound('Insurance claim not found');
  const cl = claim.rows[0];
  if (cl.status !== 'DRAFT') throw badRequest(`Claim can only be submitted from DRAFT (current: ${cl.status})`);
  await c.query(
    `UPDATE insurance_claims SET status = 'SUBMITTED', submitted_at = now(), updated_at = now() WHERE id = $1`,
    [claimId]
  );
  await logAudit(c, ctx, {
    action: 'submit', resource: 'insurance_claims', recordId: claimId, recordCode: String(cl.claim_no),
    oldValues: { status: cl.status }, newValues: { status: 'SUBMITTED' },
  });
  await emitEvent(c, ctx, {
    eventType: 'healthcare.insurance_claim_submitted', entityType: 'insurance_claims', entityId: claimId,
    entityCode: String(cl.claim_no), payload: { amount: Number(cl.amount) },
  });
  return { id: claimId, status: 'SUBMITTED' };
}

healthcareOpsRouter.post('/visits/:id/admit', ...run('healthcare.visits.admit', admitVisit));
healthcareOpsRouter.post('/visits/:id/discharge', ...run('healthcare.visits.discharge', dischargeVisit));
healthcareOpsRouter.post('/dispensings', ...run('healthcare.dispensings.create', createDispensing));
healthcareOpsRouter.post('/lab-results/:id/complete', ...run('healthcare.lab_results.complete', completeLabResult));
healthcareOpsRouter.post('/bills/:id/post', ...run('healthcare.bills.post', postBill));
healthcareOpsRouter.post('/insurance-claims/:id/submit', ...run('healthcare.insurance_claims.submit', submitClaim));