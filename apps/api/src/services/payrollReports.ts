import pg from 'pg';
import { Ctx } from '../db.js';
import { parsePagination, toCamelRow, toCamelRows, toISODate } from '../utils.js';

/**
 * Odoo "Reporting" parity for payroll — the Payroll Register and the Payslip
 * Analysis summary. Both read the stored payroll items (the frozen per-employee
 * figures from the run that was actually released), never recomputing, so a
 * report always reproduces what payroll said on release day.
 */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

interface RangeFilters {
  fromDate?: string;
  toDate?: string;
}

function rangeWhere(params: unknown[], fromDate?: string, toDate?: string): string {
  const conds: string[] = [];
  if (fromDate) {
    params.push(fromDate);
    conds.push('p.period_end >= $' + params.length + '::date');
  }
  if (toDate) {
    params.push(toDate);
    conds.push('p.period_start <= $' + params.length + '::date');
  }
  return conds.join(' AND ');
}

/** Per-employee line-by-line register across runs in a date range. */
export async function payrollRegister(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: RangeFilters & { employeeId?: number; page?: number; pageSize?: number } = {}
) {
  const { page, pageSize, offset } = parsePagination({ page: filters.page, pageSize: filters.pageSize });
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['p.tenant_id = $1', 'p.company_id = $2'];
  const range = rangeWhere(params, filters.fromDate, filters.toDate);
  if (range) where.push(range);
  if (filters.employeeId) {
    params.push(filters.employeeId);
    where.push('i.employee_id = $' + params.length);
  }
  const whereSql = where.join(' AND ');

  const res = await client.query(
    `SELECT i.id, i.employee_id, i.payroll_id,
            e.employee_no, e.first_name, e.last_name, e.position,
            p.payroll_no, p.period_start, p.period_end, p.run_type, p.currency,
            i.basic_pay, i.allowances, i.gross_pay, i.taxable_income,
            i.paye, i.nssf, i.employer_nssf, i.lst,
            i.loans, i.advances, i.other_deductions, i.total_deductions, i.net_pay
       FROM payroll_items i
       JOIN payrolls p ON p.id = i.payroll_id
       JOIN employees e ON e.id = i.employee_id
      WHERE ${whereSql}
      ORDER BY p.period_start, e.last_name, e.first_name
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );

  const totalsRes = await client.query(
    `SELECT COALESCE(SUM(i.gross_pay),0) AS gross,
            COALESCE(SUM(i.taxable_income),0) AS taxable,
            COALESCE(SUM(i.paye),0) AS paye,
            COALESCE(SUM(i.nssf),0) AS nssf_employee,
            COALESCE(SUM(i.employer_nssf),0) AS nssf_employer,
            COALESCE(SUM(i.lst),0) AS lst,
            COALESCE(SUM(i.total_deductions),0) AS deductions,
            COALESCE(SUM(i.net_pay),0) AS net,
            COUNT(*)::int AS lines
       FROM payroll_items i
       JOIN payrolls p ON p.id = i.payroll_id
      WHERE ${whereSql}`,
    params
  );

  const rows = res.rows.map((r) => {
    const out = toCamelRow(r);
    out.periodStart = toISODate(r.period_start);
    out.periodEnd = toISODate(r.period_end);
    out.name = [r.first_name, r.last_name].filter(Boolean).join(' ');
    return out;
  });

  return {
    rows,
    page,
    pageSize,
    totals: toCamelRow(totalsRes.rows[0]),
  };
}

/** Payslip analysis — one row per payroll run in a date range, plus grand totals. */
export async function payslipAnalysis(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: RangeFilters = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['p.tenant_id = $1', 'p.company_id = $2'];
  const range = rangeWhere(params, filters.fromDate, filters.toDate);
  if (range) where.push(range);

  const res = await client.query(
    `SELECT p.id AS payroll_id, p.payroll_no, p.period_start, p.period_end, p.run_type, p.status, p.currency,
            COUNT(DISTINCT i.employee_id)::int AS headcount,
            COALESCE(SUM(i.gross_pay),0) AS gross,
            COALESCE(SUM(i.taxable_income),0) AS taxable,
            COALESCE(SUM(i.paye),0) AS paye,
            COALESCE(SUM(i.nssf),0) AS nssf_employee,
            COALESCE(SUM(i.employer_nssf),0) AS nssf_employer,
            COALESCE(SUM(i.lst),0) AS lst,
            COALESCE(SUM(i.total_deductions),0) AS deductions,
            COALESCE(SUM(i.net_pay),0) AS net
       FROM payrolls p
       JOIN payroll_items i ON i.payroll_id = p.id
      WHERE ${where.join(' AND ')}
      GROUP BY p.id
      ORDER BY p.period_start, p.id`,
    params
  );

  const rows = res.rows.map((r) => {
    const out = toCamelRow(r);
    out.periodStart = toISODate(r.period_start);
    out.periodEnd = toISODate(r.period_end);
    return out;
  });

  const totals = {
    headcount: rows.reduce((n, r) => n + Number(r.headcount ?? 0), 0),
    gross: rows.reduce((n, r) => n + num(r.gross), 0),
    taxable: rows.reduce((n, r) => n + num(r.taxable), 0),
    paye: rows.reduce((n, r) => n + num(r.paye), 0),
    nssfEmployee: rows.reduce((n, r) => n + num(r.nssfEmployee), 0),
    nssfEmployer: rows.reduce((n, r) => n + num(r.nssfEmployer), 0),
    lst: rows.reduce((n, r) => n + num(r.lst), 0),
    deductions: rows.reduce((n, r) => n + num(r.deductions), 0),
    net: rows.reduce((n, r) => n + num(r.net), 0),
  };

  return { rows, totals };
}
