import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { startWorkflow } from './workflow.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

function inclusiveDays(start: string, end: string): number {
  const s = Date.parse(start.slice(0, 10) + 'T00:00:00Z');
  const e = Date.parse(end.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) throw badRequest('Termination dates are invalid');
  return Math.floor((e - s) / 86400000) + 1;
}

async function loadEmployee(client: pg.PoolClient, ctx: Ctx, employeeId: number) {
  const res = await client.query(
    'SELECT * FROM employees WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [employeeId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Employee not found');
  return res.rows[0];
}

export async function prepareFinalSettlement(
  client: pg.PoolClient,
  ctx: Ctx,
  employeeId: number,
  input: { currency?: string; otherDeductions?: number }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const emp = await loadEmployee(client, ctx, employeeId);
  if (String(emp.status) !== 'TERMINATED') {
    throw badRequest('Only terminated employees can have a final settlement');
  }
  if (!emp.termination_date) throw badRequest('Employee has no termination date');
  const hire = toISODate(emp.hire_date);
  const termination = toISODate(emp.termination_date) ?? '';
  if (hire && termination && termination < hire) {
    throw badRequest('Termination date is before the hire date');
  }
  const open = await client.query(
    'SELECT settlement_no FROM final_settlements WHERE employee_id = $1 AND tenant_id = $2 AND status IN (\'DRAFT\',\'PENDING\',\'APPROVED\',\'PAID\')',
    [employeeId, ctx.tenantId]
  );
  if (open.rows.length > 0) {
    throw badRequest('Employee already has a final settlement (' + open.rows[0].settlement_no + ')');
  }

  const monthStart = termination.slice(0, 8) + '01';
  const salaryStart = hire && hire > monthStart ? hire : monthStart;
  const salaryDays = inclusiveDays(salaryStart, termination);
  const dailyRate = (Number(emp.base_salary) || 0) / 30;
  const salaryDue = round2(dailyRate * salaryDays);

  const leaveRes = await client.query(
    `SELECT COALESCE(SUM(l.days),0)::numeric AS days
     FROM leave_requests l
     LEFT JOIN leave_types lt ON lt.id = l.leave_type_id
     WHERE l.employee_id = $1 AND l.status = 'APPROVED'
       AND (
         (lt.id IS NOT NULL AND lt.is_paid = true)
         OR (lt.id IS NULL AND l.leave_type IN ('ANNUAL','STUDY','COMPASSIONATE'))
       )`,
    [employeeId]
  );
  const leaveDays = Number(leaveRes.rows[0].days) || 0;
  const leavePayment = round2(leaveDays * dailyRate);

  const benefitsRes = await client.query(
    `SELECT COALESCE(SUM(employer_contribution),0)::numeric AS value
     FROM employee_benefits
     WHERE employee_id = $1 AND status = 'ACTIVE'
       AND effective_from <= $2::date
       AND (effective_to IS NULL OR effective_to >= $2::date)`,
    [employeeId, termination]
  );
  const benefitsValue = round2(Number(benefitsRes.rows[0].value) || 0);

  const loansRes = await client.query(
    `SELECT COALESCE(SUM(COALESCE(outstanding_balance, balance)),0)::numeric AS balance
     FROM employee_loans WHERE employee_id = $1 AND status = 'ACTIVE'`,
    [employeeId]
  );
  const outstandingLoans = round2(Number(loansRes.rows[0].balance) || 0);

  const advancesRes = await client.query(
    `SELECT COALESCE(SUM(outstanding_balance),0)::numeric AS balance
     FROM salary_advances WHERE employee_id = $1 AND status = 'ACTIVE'`,
    [employeeId]
  );
  const outstandingAdvances = round2(Number(advancesRes.rows[0].balance) || 0);

  const otherDeductions = round2(Math.max(0, Number(input.otherDeductions ?? 0)));
  const netPayable = round2(salaryDue + leavePayment + benefitsValue - outstandingLoans - outstandingAdvances - otherDeductions);
  const currency = String(input.currency ?? 'UGX').toUpperCase();

  const components = [
    { kind: 'EARNING', code: 'SALARY', description: `Salary due ${salaryDays} day(s) to ${termination}`, amount: salaryDue, taxable: true, statutory: false },
    { kind: 'EARNING', code: 'LEAVE_PAY', description: `Approved paid leave payout (${leaveDays} day(s))`, amount: leavePayment, taxable: true, statutory: false },
    { kind: 'EARNING', code: 'BENEFITS', description: 'Active benefits employer value', amount: benefitsValue, taxable: false, statutory: false },
    { kind: 'DEDUCTION', code: 'LOANS', description: 'Outstanding loans offset', amount: outstandingLoans, taxable: false, statutory: false },
    { kind: 'DEDUCTION', code: 'ADVANCES', description: 'Outstanding salary advances offset', amount: outstandingAdvances, taxable: false, statutory: false },
  ];
  if (otherDeductions > 0) {
    components.push({ kind: 'DEDUCTION', code: 'OTHER', description: 'Other authorized deductions', amount: otherDeductions, taxable: false, statutory: false });
  }
  components.push({
    kind: 'INFO', code: 'STATUTORY', description: 'PAYE/NSSF per configured statutory rules applied at final payroll', amount: 0, taxable: false, statutory: true,
  });

  const settlementNo = await nextDoc(client, ctx, 'SUS');
  const ins = await client.query(
    `INSERT INTO final_settlements
       (company_id, tenant_id, branch_id, employee_id, settlement_no, termination_date, components,
        salary_due, leave_payment, benefits_value, outstanding_loans, outstanding_advances,
        other_deductions, net_payable, currency, status, prepared_by, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'DRAFT',$16,$16)
     RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, emp.branch_id ?? ctx.branchId ?? null, employeeId, settlementNo, termination,
      JSON.stringify(components), salaryDue, leavePayment, benefitsValue, outstandingLoans, outstandingAdvances,
      otherDeductions, netPayable, currency, ctx.userId ?? null,
    ]
  );
  const id = Number(ins.rows[0].id);
  await emitEvent(client, ctx, {
    eventType: 'hr.final_settlement.prepared',
    entityType: 'hr.final_settlements',
    entityId: id,
    entityCode: settlementNo,
    payload: { employeeId, netPayable, currency },
  });
  await logAudit(client, ctx, {
    action: 'prepare',
    resource: 'final_settlements',
    recordId: id,
    recordCode: settlementNo,
    newValues: { employeeId, salaryDue, leavePayment, benefitsValue, outstandingLoans, outstandingAdvances, otherDeductions, netPayable },
  });
  const saved = (await client.query('SELECT * FROM final_settlements WHERE id = $1', [id])).rows[0];
  const savedRow = toCamelRow(saved);
  savedRow.terminationDate = toISODate(saved.termination_date);
  return { ...savedRow, finalSettlementId: id };
}

async function loadSettlement(client: pg.PoolClient, ctx: Ctx, id: number, ...allowed: string[]) {
  const res = await client.query(
    'SELECT * FROM final_settlements WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Final settlement not found');
  if (allowed.length && !allowed.includes(String(res.rows[0].status))) {
    throw badRequest('Final settlement must be ' + allowed.join(' or ') + ' to perform this action (current: ' + res.rows[0].status + ')');
  }
  return res.rows[0];
}

export async function submitFinalSettlement(client: pg.PoolClient, ctx: Ctx, id: number) {
  const row = await loadSettlement(client, ctx, id, 'DRAFT');
  await client.query('UPDATE final_settlements SET status = \'PENDING\', updated_at = now() WHERE id = $1', [id]);
  await startWorkflow(client, ctx, {
    entityType: 'hr.final_settlements',
    entityId: id,
    entityCode: String(row.settlement_no),
    amount: Number(row.net_payable),
  });
  const after = await client.query('SELECT status FROM final_settlements WHERE id = $1', [id]);
  const status = String(after.rows[0].status);
  if (status === 'APPROVED') {
    await client.query('UPDATE final_settlements SET approved_by = $2, approved_at = now() WHERE id = $1', [id, ctx.userId ?? null]);
  }
  await emitEvent(client, ctx, {
    eventType: 'hr.final_settlement.submitted',
    entityType: 'hr.final_settlements',
    entityId: id,
    entityCode: String(row.settlement_no),
    payload: { status },
  });
  await logAudit(client, ctx, {
    action: 'submit',
    resource: 'final_settlements',
    recordId: id,
    recordCode: String(row.settlement_no),
    newValues: { status },
  });
  return { finalSettlementId: id, settlementNo: row.settlement_no, status };
}

export async function approveFinalSettlement(client: pg.PoolClient, ctx: Ctx, id: number) {
  const row = await loadSettlement(client, ctx, id, 'PENDING');
  await client.query(
    'UPDATE final_settlements SET status = \'APPROVED\', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1',
    [id, ctx.userId ?? null]
  );
  await emitEvent(client, ctx, {
    eventType: 'hr.final_settlement.approved',
    entityType: 'hr.final_settlements',
    entityId: id,
    entityCode: String(row.settlement_no),
  });
  await logAudit(client, ctx, {
    action: 'approve',
    resource: 'final_settlements',
    recordId: id,
    recordCode: String(row.settlement_no),
    newValues: { status: 'APPROVED' },
  });
  return { finalSettlementId: id, settlementNo: row.settlement_no, status: 'APPROVED' };
}

export async function rejectFinalSettlement(client: pg.PoolClient, ctx: Ctx, id: number) {
  const row = await loadSettlement(client, ctx, id, 'PENDING');
  await client.query('UPDATE final_settlements SET status = \'DRAFT\', updated_at = now() WHERE id = $1', [id]);
  await emitEvent(client, ctx, {
    eventType: 'hr.final_settlement.rejected',
    entityType: 'hr.final_settlements',
    entityId: id,
    entityCode: String(row.settlement_no),
  });
  await logAudit(client, ctx, {
    action: 'reject',
    resource: 'final_settlements',
    recordId: id,
    recordCode: String(row.settlement_no),
    newValues: { status: 'DRAFT' },
  });
  return { finalSettlementId: id, settlementNo: row.settlement_no, status: 'DRAFT' };
}

/**
 * Generate the payment instruction for an approved settlement and mark it paid.
 * Creates a FINAL payment batch so the payment is validated, approved, exported
 * and reconciled through the standard banking workflow.
 */
export async function payFinalSettlement(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: { paymentMethod?: string }
) {
  const row = await loadSettlement(client, ctx, id, 'APPROVED');
  if (!ctx.companyId) throw badRequest('Company context required');
  const emp = await loadEmployee(client, ctx, Number(row.employee_id));
  const paymentMethod = String(input.paymentMethod ?? 'BANK_TRANSFER').toUpperCase();
  const allowedMethods = ['BANK_TRANSFER', 'MOBILE_MONEY', 'CASH', 'OTHER'];
  if (!allowedMethods.includes(paymentMethod)) throw badRequest('Unsupported payment method');
  let bankName: string | null = null;
  let maskedAccount: string | null = null;
  let mobileNo: string | null = null;
  if (paymentMethod === 'BANK_TRANSFER') {
    if (!emp.bank_account_no) throw badRequest('Employee has no bank account for the final settlement payment');
    bankName = emp.bank_name ?? null;
    maskedAccount = '****' + String(emp.bank_account_no).slice(-4);
  } else if (paymentMethod === 'MOBILE_MONEY') {
    if (!emp.phone) throw badRequest('Employee has no mobile number for the final settlement payment');
    mobileNo = emp.phone;
  }

  const batchNo = await nextDoc(client, ctx, 'PB');
  const batch = await client.query(
    `INSERT INTO payment_batches
       (company_id, tenant_id, branch_id, payroll_run_id, batch_no, batch_type, currency,
        total_amount, item_count, status, created_by)
     VALUES ($1,$2,$3,NULL,$4,'FINAL',$5,$6,1,'DRAFT',$7) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, row.branch_id ?? ctx.branchId ?? null, batchNo,
      String(row.currency ?? 'UGX'), Number(row.net_payable), ctx.userId ?? null,
    ]
  );
  const batchId = Number(batch.rows[0].id);
  await client.query(
    `INSERT INTO payment_batch_items
       (company_id, tenant_id, batch_id, employee_id, payment_method, bank_name,
        masked_account_no, mobile_no, amount, currency, payment_reference, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING')`,
    [
      ctx.companyId, ctx.tenantId, batchId, Number(row.employee_id), paymentMethod, bankName,
      maskedAccount, mobileNo, Number(row.net_payable), String(row.currency ?? 'UGX'),
      String(row.settlement_no),
    ]
  );
  await client.query('UPDATE final_settlements SET status = \'PAID\', updated_at = now() WHERE id = $1', [id]);
  await emitEvent(client, ctx, {
    eventType: 'hr.final_settlement.paid',
    entityType: 'hr.final_settlements',
    entityId: id,
    entityCode: String(row.settlement_no),
    payload: { batchId, batchNo, amount: Number(row.net_payable), paymentMethod },
  });
  await logAudit(client, ctx, {
    action: 'pay',
    resource: 'final_settlements',
    recordId: id,
    recordCode: String(row.settlement_no),
    newValues: { status: 'PAID', batchId, batchNo, amount: Number(row.net_payable), paymentMethod },
  });
  return { finalSettlementId: id, settlementNo: row.settlement_no, status: 'PAID', batchId, batchNo };
}

export async function listFinalSettlements(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number } = {}
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['f.tenant_id = $1', 'f.company_id = $2'];
  if (filters.q?.trim()) {
    params.push('%' + filters.q.trim() + '%');
    where.push('(f.settlement_no ILIKE $' + params.length + ' OR e.employee_no ILIKE $' + params.length + ' OR e.first_name ILIKE $' + params.length + ' OR e.last_name ILIKE $' + params.length + ')');
  }
  if (filters.status) {
    params.push(filters.status);
    where.push('f.status = $' + params.length);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT f.id, f.settlement_no, f.termination_date, f.salary_due, f.leave_payment,
            f.benefits_value, f.outstanding_loans, f.outstanding_advances, f.other_deductions,
            f.net_payable, f.currency, f.status, f.created_at, f.updated_at,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name, e.position
     FROM final_settlements f
     JOIN employees e ON e.id = f.employee_id
     WHERE ${where.join(' AND ')}
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const rows = res.rows.map((r) => {
    const out = toCamelRow(r);
    out.terminationDate = toISODate(r.termination_date);
    return out;
  });
  return { rows, page, pageSize };
}

export async function getFinalSettlement(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT f.*, e.employee_no, e.first_name, e.last_name, e.position, e.bank_name, e.bank_account_no, e.phone
     FROM final_settlements f
     JOIN employees e ON e.id = f.employee_id
     WHERE f.id = $1 AND f.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Final settlement not found');
  const detail = toCamelRow(res.rows[0]);
  detail.terminationDate = toISODate(res.rows[0].termination_date);
  return detail;
}
