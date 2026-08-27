import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toISODate } from '../utils.js';
import { logAudit } from './audit.js';
import * as statutory from './statutory.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ArrearsInput {
  employeeId: number;
  originalPay: number;
  correctPay: number;
  fromPeriodStart: string;
  toPeriodEnd: string;
  reason?: string | null;
  currency?: string;
}

/**
 * Create an arrears record. The engine derives the gross difference, the
 * statutory tax impact (delta PAYE computed from the versioned configuration
 * effective at the corrected period end) and the net arrears payable. Records
 * start PENDING and must be APPROVED before an ARREARS off-cycle run includes
 * them, so unapproved input can never reach payroll.
 */
export async function createArrears(client: pg.PoolClient, ctx: Ctx, input: ArrearsInput) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const employeeId = Number(input.employeeId);
  if (!Number.isFinite(employeeId) || employeeId <= 0) throw badRequest('Select an employee');
  const emp = await client.query(
    `SELECT id FROM employees WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [employeeId, ctx.tenantId, ctx.companyId]
  );
  if (emp.rows.length === 0) throw badRequest('Employee not found in this company');
  const originalPay = round2(Math.max(0, Number(input.originalPay) || 0));
  const correctPay = round2(Math.max(0, Number(input.correctPay) || 0));
  if (correctPay <= 0) throw badRequest('Correct pay must be greater than zero');
  if (correctPay === originalPay) throw badRequest('Correct pay must differ from original pay');
  const fromPeriodStart = String(input.fromPeriodStart ?? '').trim();
  const toPeriodEnd = String(input.toPeriodEnd ?? '').trim();
  if (!fromPeriodStart || !toPeriodEnd || toPeriodEnd < fromPeriodStart) {
    throw badRequest('Arrears period start/end are required and end must not precede start');
  }
  const reason = String(input.reason ?? '').trim() || null;
  const currency = String(input.currency ?? 'UGX').toUpperCase();

  const dup = await client.query(
    `SELECT id FROM payroll_arrears
     WHERE tenant_id = $1 AND company_id = $2 AND employee_id = $3
       AND from_period_start = $4 AND to_period_end = $5
       AND original_pay = $6 AND correct_pay = $7
       AND status IN ('PENDING','APPROVED')`,
    [ctx.tenantId, ctx.companyId, employeeId, fromPeriodStart, toPeriodEnd, originalPay, correctPay]
  );
  if (dup.rows.length) throw badRequest('Arrears for this employee and period already exist');

  // Tax impact uses the PAYE configuration effective at the corrected period
  // end, so a change in law never rewrites historical arrears.
  const payeCfg = await statutory.requireStatutoryConfig(client, ctx, 'PAYE', { effectiveDate: toPeriodEnd });
  const difference = round2(correctPay - originalPay);
  const taxImpact = round2(
    Math.max(0, statutory.computePaye(correctPay, payeCfg) - statutory.computePaye(originalPay, payeCfg))
  );
  const netArrears = round2(difference - taxImpact);

  const ins = await client.query(
    `INSERT INTO payroll_arrears
       (company_id, tenant_id, employee_id, original_pay, correct_pay, difference,
        tax_impact, net_arrears, from_period_start, to_period_end, status, currency, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',$11,$12) RETURNING id`,
    [ctx.companyId, ctx.tenantId, employeeId, originalPay, correctPay, difference, taxImpact, netArrears, fromPeriodStart, toPeriodEnd, currency, reason]
  );
  const arrearsId = Number(ins.rows[0].id);
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'arrears',
    recordId: arrearsId,
    newValues: {
      employeeId, originalPay, correctPay, difference, taxImpact, netArrears,
      fromPeriodStart, toPeriodEnd, reason, currency,
    },
  });
  return {
    arrearsId, originalPay, correctPay, difference, taxImpact, netArrears,
    status: 'PENDING', currency,
  };
}

export async function listArrears(client: pg.PoolClient, ctx: Ctx, opts: { status?: string } = {}) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = `a.tenant_id = $1 AND a.company_id = $2`;
  if (opts.status) {
    params.push(String(opts.status));
    where += ` AND a.status = $${params.length}`;
  }
  const res = await client.query(
    `SELECT a.id, a.employee_id, a.original_pay, a.correct_pay, a.difference, a.tax_impact,
            a.net_arrears, a.from_period_start, a.to_period_end, a.status, a.currency, a.reason,
            a.payroll_id, a.created_at,
            e.employee_no, e.first_name, e.last_name, e.position
     FROM payroll_arrears a
     JOIN employees e ON e.id = a.employee_id
     WHERE ${where}
     ORDER BY a.id DESC LIMIT 100`,
    params
  );
  return res.rows.map((r) => {
    const out = toCamelRow(r);
    out.fromPeriodStart = toISODate(r.from_period_start);
    out.toPeriodEnd = toISODate(r.to_period_end);
    return out;
  });
}

export async function decideArrears(
  client: pg.PoolClient,
  ctx: Ctx,
  arrearsId: number,
  status: 'APPROVED' | 'REJECTED' | 'CLOSED'
) {
  const res = await client.query(
    `UPDATE payroll_arrears SET status = $3, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status <> 'CLOSED'
     RETURNING id, employee_id, net_arrears`,
    [arrearsId, ctx.tenantId, status]
  );
  if (res.rows.length === 0) throw notFound('Arrears record not found or already closed');
  const action = status === 'APPROVED' ? 'approve' : status === 'REJECTED' ? 'reject' : 'close';
  await logAudit(client, ctx, {
    action,
    resource: 'arrears',
    recordId: arrearsId,
    newValues: { status },
  });
  return { arrearsId: Number(res.rows[0].id), status };
}
