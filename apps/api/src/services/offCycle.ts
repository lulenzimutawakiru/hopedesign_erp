import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, toCamelRow, toISODate } from '../utils.js';
import { logAudit } from './audit.js';
import { calculatePayroll } from './hr.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

const OFF_CYCLE_TYPES = ['NEW_HIRE','TERMINATION','FINAL','BONUS','COMMISSION','CORRECTION','ARREARS','EMERGENCY'];

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

export interface OffCycleInput {
  periodStart: string;
  periodEnd: string;
  offCycleType: string;
  reason: string;
  employeeIds: number[];
  extraEarnings?: number;
  extraDeductions?: number;
  deductLoans?: boolean;
  paymentDate?: string;
}

export async function createOffCycleRun(client: pg.PoolClient, ctx: Ctx, input: OffCycleInput) {
  if (!ctx.companyId) throw badRequest('Company context required');
  if (!input.periodStart || !input.periodEnd) throw badRequest('Period start and end are required');
  if (input.periodEnd < input.periodStart) throw badRequest('Period end is before start');
  const offCycleType = String(input.offCycleType ?? '').toUpperCase();
  if (!OFF_CYCLE_TYPES.includes(offCycleType)) throw badRequest('Unsupported off-cycle type');
  const reason = String(input.reason ?? '').trim();
  if (!reason) throw badRequest('A reason is required for off-cycle payroll');
  const employeeIds = Array.isArray(input.employeeIds)
    ? [...new Set(input.employeeIds.map(Number))].filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (employeeIds.length === 0) throw badRequest('Select at least one employee for the off-cycle run');
  const emp = await client.query(
    `SELECT id FROM employees WHERE tenant_id = $1 AND company_id = $2 AND id = ANY($3::bigint[])`,
    [ctx.tenantId, ctx.companyId, employeeIds]
  );
  if (emp.rows.length !== employeeIds.length) {
    throw badRequest('One or more selected employees are not in this company');
  }
  let extraEarnings = round2(Math.max(0, Number(input.extraEarnings ?? 0)));
  if (offCycleType === 'ARREARS' && input.extraEarnings == null) {
    // Auto-load approved arrears for the selected employees. Only APPROVED
    // records feed payroll; unapproved arrears can never reach a run.
    const arr = await client.query(
      `SELECT COALESCE(sum(net_arrears),0)::numeric AS total FROM payroll_arrears
       WHERE tenant_id = $1 AND company_id = $2 AND employee_id = ANY($3::bigint[])
         AND status = 'APPROVED' AND to_period_end <= $4 AND payroll_id IS NULL`,
      [ctx.tenantId, ctx.companyId, employeeIds, input.periodEnd]
    );
    extraEarnings = round2(Number(arr.rows[0].total) || 0);
  }
  const extraDeductions = round2(Math.max(0, Number(input.extraDeductions ?? 0)));
  const deductLoans = input.deductLoans !== false;
  const paymentDate = input.paymentDate ? String(input.paymentDate) : null;
  const payrollNo = await nextDoc(client, ctx, 'PAY');
  const ins = await client.query(
    `INSERT INTO payrolls (company_id, tenant_id, payroll_no, period_start, period_end, status, created_by,
        run_type, off_cycle_type, reason, employee_ids, extra_earnings, extra_deductions, deduct_loans, payment_date)
     VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,'OFF_CYCLE',$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, payrollNo, input.periodStart, input.periodEnd, ctx.userId ?? null,
      offCycleType, reason, employeeIds, extraEarnings, extraDeductions, deductLoans, paymentDate,
    ]
  );
  const payrollId = Number(ins.rows[0].id);
  if (offCycleType === 'ARREARS' && input.extraEarnings == null) {
    // Link the auto-loaded records to this run so they can never be paid twice
    // and are closed when the run posts.
    await client.query(
      `UPDATE payroll_arrears SET payroll_id = $1
       WHERE tenant_id = $2 AND company_id = $3 AND employee_id = ANY($4::bigint[])
         AND status = 'APPROVED' AND to_period_end <= $5 AND payroll_id IS NULL`,
      [payrollId, ctx.tenantId, ctx.companyId, employeeIds, input.periodEnd]
    );
  }
  await calculatePayroll(client, ctx, payrollId);
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'off_cycle',
    recordId: payrollId,
    recordCode: payrollNo,
    newValues: {
      offCycleType, reason, employeeIds, extraEarnings, extraDeductions, deductLoans,
      periodStart: input.periodStart, periodEnd: input.periodEnd, paymentDate,
    },
  });
  return { payrollId, payrollNo };
}

export async function listOffCycleRuns(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, payroll_no, off_cycle_type, reason, employee_ids, payment_date, period_start, period_end,
            status, gross_total, deduction_total, net_total, extra_earnings, extra_deductions, deduct_loans,
            created_at
     FROM payrolls
     WHERE tenant_id = $1 AND company_id = $2 AND run_type = 'OFF_CYCLE'
     ORDER BY id DESC LIMIT 100`,
    [ctx.tenantId, ctx.companyId]
  );
  return res.rows.map((r) => {
    const out = toCamelRow(r);
    out.periodStart = toISODate(r.period_start);
    out.periodEnd = toISODate(r.period_end);
    out.paymentDate = toISODate(r.payment_date);
    out.employeeCount = Array.isArray(r.employee_ids) ? r.employee_ids.length : 0;
    return out;
  });
}
