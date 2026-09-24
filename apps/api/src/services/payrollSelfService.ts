/**
 * HOPE DESIGN ERP - EMPLOYEE PAYROLL SELF-SERVICE (spec 21, 33, 34).
 *
 * "My Payroll" answers for the authenticated caller and for nobody else. The
 * employee is resolved from the user-to-employee link the identity module
 * already owns; the caller never supplies an employee id, so an employee
 * cannot read a colleague's payslip even by guessing one.
 *
 * Every figure quoted here is read back from the payroll that was actually
 * approved - the payslip header, the payroll item, and the item's stored
 * calculation breakdown. Nothing is recomputed on read, so a payslip today
 * says exactly what payroll said on the day it was released, even after the
 * employee's salary or the statutory rates have changed.
 */
import pg from 'pg';
import { Ctx } from '../db.js';
import { forbidden, notFound, parsePagination, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { logAudit } from './audit.js';

const round2 = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v: unknown) => round2(v);

/** Show only the last four digits of an account number. */
export function maskAccountNumber(value: unknown): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const tail = raw.slice(-4);
  return raw.length <= 4 ? tail : '\u2022'.repeat(Math.min(raw.length - 4, 12)) + tail;
}

/**
 * The employee behind the authenticated user.
 *
 * A login that is not linked to an employee file has no payslips, and the
 * refusal says exactly what to do about it rather than returning an empty
 * list that looks like 'you were never paid'.
 */
export async function requireLinkedEmployee(client: pg.PoolClient, ctx: Ctx) {
  if (!ctx.userId) throw forbidden('Sign in to view your payslips');
  const res = await client.query(
    `SELECT e.id, e.employee_no, e.first_name, e.last_name, e.position, e.status,
            e.email, e.phone, e.hire_date, e.department_id, e.branch_id,
            e.nssf_no, e.tin, e.bank_name, e.bank_account_no,
            d.name AS department_name, b.name AS branch_name,
            c.name AS company_name, c.legal_name AS company_legal_name, c.tin AS company_tin,
            c.address AS company_address, c.phone AS company_phone, c.email AS company_email,
            c.currency AS company_currency
       FROM users u
       JOIN employees e ON e.id = u.employee_id AND e.tenant_id = u.tenant_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN branches b ON b.id = e.branch_id
       LEFT JOIN companies c ON c.id = e.company_id
      WHERE u.id = $1 AND u.tenant_id = $2`,
    [ctx.userId, ctx.tenantId]
  );
  if (!res.rows.length) {
    throw forbidden(
      'Your sign-in is not linked to an employee record, so there is no payslip to show. Ask HR to link your user account to your employee file.'
    );
  }
  return res.rows[0];
}

/** The caller's own payroll home: latest slip, history, YTD, loans and advances. */
export async function myPayroll(
  client: pg.PoolClient,
  ctx: Ctx,
  query: Record<string, unknown> = {}
) {
  const employee = await requireLinkedEmployee(client, ctx);
  const employeeId = Number(employee.id);
  const { page, pageSize, offset } = parsePagination(query);

  const slips = await client.query(
    `SELECT s.id, s.payslip_no, s.currency, s.gross_total, s.taxable_total, s.deduction_total,
            s.net_total, s.employer_contributions, s.payment_date, s.status, s.published_at,
            s.viewed_at, s.viewed_count, s.download_count, s.verification_code,
            p.id AS payroll_id, p.payroll_no, p.period_start, p.period_end, p.run_type, p.off_cycle_type
       FROM payslips s
       LEFT JOIN payrolls p ON p.id = s.payroll_id
      WHERE s.tenant_id = $1 AND s.employee_id = $2 AND s.status = 'PUBLISHED'
      ORDER BY COALESCE(p.period_end, s.created_at::date) DESC, s.id DESC
      LIMIT $3 OFFSET $4`,
    [ctx.tenantId, employeeId, pageSize, offset]
  );
  const count = await client.query(
    `SELECT count(*)::int AS n FROM payslips s
      WHERE s.tenant_id = $1 AND s.employee_id = $2 AND s.status = 'PUBLISHED'`,
    [ctx.tenantId, employeeId]
  );

  const year = new Date().getUTCFullYear();
  const ytd = await client.query(
    `SELECT COUNT(*)::int AS periods,
            COALESCE(SUM(s.gross_total),0) AS gross,
            COALESCE(SUM(s.taxable_total),0) AS taxable,
            COALESCE(SUM(s.deduction_total),0) AS deductions,
            COALESCE(SUM(s.net_total),0) AS net,
            COALESCE(SUM(s.employer_contributions),0) AS employer_contributions,
            COALESCE(SUM(i.paye),0) AS paye,
            COALESCE(SUM(i.nssf),0) AS nssf,
            COALESCE(SUM(i.lst),0) AS lst,
            COALESCE(SUM(i.loans),0) AS loans,
            COALESCE(SUM(i.advances),0) AS advances,
            COALESCE(SUM(i.other_deductions),0) AS other_deductions
       FROM payslips s
       LEFT JOIN payroll_items i ON i.payroll_id = s.payroll_id AND i.employee_id = s.employee_id
      WHERE s.tenant_id = $1 AND s.employee_id = $2 AND s.status = 'PUBLISHED'
        AND COALESCE(s.payment_date, s.published_at::date, s.created_at::date) >= make_date($3::int, 1, 1)`,
    [ctx.tenantId, employeeId, year]
  );

  const trend = await client.query(
    `SELECT s.id, s.payslip_no, s.net_total, s.gross_total, s.currency,
            p.period_start, p.period_end, p.payroll_no
       FROM payslips s
       LEFT JOIN payrolls p ON p.id = s.payroll_id
      WHERE s.tenant_id = $1 AND s.employee_id = $2 AND s.status = 'PUBLISHED'
      ORDER BY s.id DESC LIMIT 12`,
    [ctx.tenantId, employeeId]
  );

  const loans = await client.query(
    `SELECT id, loan_no, principal, interest_rate, tenure_months, monthly_deduction,
            COALESCE(outstanding_balance, balance) AS balance, start_date, end_date, status
       FROM employee_loans
      WHERE tenant_id = $1 AND employee_id = $2 AND status = 'ACTIVE' AND COALESCE(outstanding_balance, balance) > 0
      ORDER BY id`,
    [ctx.tenantId, employeeId]
  );
  const advances = await client.query(
    `SELECT id, advance_no, amount, monthly_deduction, outstanding_balance, start_date, status
       FROM salary_advances
      WHERE tenant_id = $1 AND employee_id = $2 AND status = 'ACTIVE' AND outstanding_balance > 0
      ORDER BY id`,
    [ctx.tenantId, employeeId]
  );

  const decorate = (r: Record<string, unknown>) => {
    const out = toCamelRow(r);
    out.paymentDate = toISODate(r.payment_date);
    out.periodStart = toISODate(r.period_start);
    out.periodEnd = toISODate(r.period_end);
    return out;
  };

  const rows = slips.rows.map(decorate);
  const t = ytd.rows[0] ?? {};
  return {
    employee: {
      id: employeeId,
      employeeNo: employee.employee_no == null ? null : String(employee.employee_no),
      name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
      position: employee.position == null ? null : String(employee.position),
      departmentName: employee.department_name == null ? null : String(employee.department_name),
      branchName: employee.branch_name == null ? null : String(employee.branch_name),
      companyName: employee.company_name == null ? null : String(employee.company_name),
      nssfNo: employee.nssf_no == null ? null : String(employee.nssf_no),
      tin: employee.tin == null ? null : String(employee.tin),
      bankName: employee.bank_name == null ? null : String(employee.bank_name),
      bankAccountMasked: maskAccountNumber(employee.bank_account_no),
    },
    current: rows.length > 0 ? rows[0] : null,
    payslips: rows,
    page,
    pageSize,
    totalCount: Number(count.rows[0]?.n) || 0,
    yearToDate: {
      year,
      periods: Number(t.periods) || 0,
      gross: num(t.gross),
      taxable: num(t.taxable),
      deductions: num(t.deductions),
      net: num(t.net),
      paye: num(t.paye),
      nssfEmployee: num(t.nssf),
      nssfEmployer: num(t.employer_contributions),
      lst: num(t.lst),
      loans: num(t.loans),
      advances: num(t.advances),
      otherDeductions: num(t.other_deductions),
    },
    trend: toCamelRows(trend.rows).map((r) => ({
      ...r,
      periodStart: toISODate(r.periodStart),
      periodEnd: toISODate(r.periodEnd),
      netTotal: num(r.netTotal),
      grossTotal: num(r.grossTotal),
    })).reverse(),
    loans: toCamelRows(loans.rows),
    advances: toCamelRows(advances.rows),
  };
}


interface TraceLine {
  label: string;
  detail: string;
  amount: number;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

/** Name the statutory rule that was applied, so a query can be answered with a rule id. */
function ruleDetail(rule: Record<string, unknown>, fallback: string): string {
  const code = rule.code == null ? null : String(rule.code);
  const version = rule.version == null ? null : String(rule.version);
  if (!code && !version) return fallback;
  return fallback + ' - statutory rule ' + (code ?? 'unknown') + (version ? ' v' + version : '');
}

/**
 * Rebuild the explanation of a payslip from the breakdown payroll stored when
 * the run was calculated. Each section reports whether its own lines add back
 * up to the stored total, so a slip that does not reconcile is visibly
 * flagged rather than quietly presented as correct.
 */
function buildCalculationTrace(item: Record<string, unknown>) {
  const b = asObject(item.breakdown);
  const basic = num(item.basic_pay);
  const gross = num(item.gross_pay);
  const lines: TraceLine[] = [
    { label: 'Basic salary', detail: 'Contractual salary for the period, pro-rated for any unpaid days', amount: basic },
  ];
  const earnings = asArray(b.earnings);
  const componentTotal = round2(earnings.filter((e) => e.kind === 'COMPONENT').reduce((a, e) => a + num(e.amount), 0));
  let itemised = 0;
  for (const e of earnings) {
    if (e.kind === 'COMPONENT') continue;
    const amount = num(e.amount);
    if (amount === 0) continue;
    itemised = round2(itemised + amount);
    lines.push({
      label: String(e.name ?? e.code ?? 'Earning'),
      detail: String(e.code ?? '') + (e.taxable === true ? ' - taxable' : ' - not taxable'),
      amount,
    });
  }
  const allowances = num(item.allowances);
  const contractual = round2(allowances - componentTotal);
  if (contractual !== 0) {
    lines.push({ label: 'Contractual allowances', detail: 'Allowances recorded on the employment contract', amount: contractual });
  }
  const extra = round2(gross - (basic + itemised + contractual));
  if (extra !== 0) {
    lines.push({ label: 'Arrears / additional pay', detail: 'Approved correction or off-cycle amount included in this run', amount: extra });
  }
  const earningsTotal = round2(lines.reduce((a, l) => a + l.amount, 0));

  const payeRule = asObject(b.paye);
  const nssfRule = asObject(b.nssf);
  const lstRule = asObject(b.lst);
  const deductions: TraceLine[] = [
    { label: 'PAYE', detail: ruleDetail(payeRule, 'Income tax on chargeable income'), amount: num(item.paye) },
  ];
  if (num(item.nssf) !== 0) {
    const ceiling = nssfRule.ceiling == null ? null : num(nssfRule.ceiling);
    deductions.push({
      label: 'NSSF (employee)',
      detail: ruleDetail(nssfRule, 'Employee contribution on contributable earnings') + (ceiling ? ' - ceiling ' + ceiling : ''),
      amount: num(item.nssf),
    });
  }
  if (num(item.lst) !== 0) {
    deductions.push({ label: 'Local Service Tax', detail: ruleDetail(lstRule, 'Local government service tax'), amount: num(item.lst) });
  }
  if (num(item.loans) !== 0) {
    deductions.push({ label: 'Loan repayment', detail: 'Recovery of an approved staff loan', amount: num(item.loans) });
  }
  if (num(item.advances) !== 0) {
    deductions.push({ label: 'Salary advance', detail: 'Recovery of an approved salary advance', amount: num(item.advances) });
  }
  const itemDeductions = asArray(b.deductions);
  let itemisedDeductions = 0;
  for (const d of itemDeductions) {
    const amount = num(d.amount);
    if (amount === 0) continue;
    itemisedDeductions = round2(itemisedDeductions + amount);
    deductions.push({ label: String(d.name ?? d.code ?? 'Deduction'), detail: String(d.kind ?? '') + (d.code ? ' - ' + String(d.code) : ''), amount });
  }
  const otherResidual = round2(num(item.other_deductions) - itemisedDeductions);
  if (otherResidual !== 0) {
    deductions.push({ label: 'Other deductions', detail: 'Other authorised deductions recorded on this run', amount: otherResidual });
  }
  const deductionsTotal = round2(deductions.reduce((a, l) => a + l.amount, 0));

  const storedDeductions = num(item.total_deductions);
  const net = num(item.net_pay);
  // Chargeable-income reconciliation. Newer runs record the chargeable figure
  // PAYE was actually computed on, which lets the slip show which part of gross
  // was excluded and confirm the arithmetic; older runs did not, so we fall back
  // to gross less the deductible employee NSSF contribution.
  const chargeableIncome = num(b.chargeableIncome);
  const lessNonTaxable = chargeableIncome > 0 ? round2(gross - chargeableIncome) : 0;
  const lessEmployeeNssf = num(nssfRule.employee);
  const taxableIncome = num(item.taxable_income);
  return {
    earnings: { lines, total: earningsTotal, balanced: Math.abs(earningsTotal - gross) <= 0.01 },
    gross,
    chargeable: {
      gross,
      lessNonTaxableEarnings: lessNonTaxable,
      lessEmployeeNssf,
      chargeableIncome: chargeableIncome > 0 ? chargeableIncome : round2(gross - lessNonTaxable),
      taxableIncome,
      reconciled: chargeableIncome > 0
        ? Math.abs(round2(gross - lessNonTaxable - lessEmployeeNssf) - taxableIncome) <= 0.01
        : Math.abs(round2(gross - lessEmployeeNssf) - taxableIncome) <= 0.01,
    },
    deductions: { lines: deductions, total: deductionsTotal, stored: storedDeductions, balanced: Math.abs(deductionsTotal - storedDeductions) <= 0.01 },
    net,
    netBalanced: Math.abs(round2(gross - storedDeductions) - net) <= 0.01,
    employerCost: round2(gross + num(item.employer_nssf) + num(item.lst)),
    employerNssf: num(item.employer_nssf),
    proration: asObject(b.proration),
    attendanceUnpaidDays: b.attendanceUnpaidDays == null ? null : num(b.attendanceUnpaidDays),
    benefits: asObject(b.benefits),
    ruleVersions: { paye: payeRule, nssf: nssfRule, lst: lstRule },
  };
}

/**
 * A single payslip, opened from the caller own history.
 *
 * The slip is addressed by id but the query also pins tenant and employee, so
 * naming somebody else id returns "not found" rather than revealing that the
 * slip exists. The calculation trace is rebuilt from the payroll item stored
 * when the run was calculated, never recomputed from today salary, so the slip
 * still explains itself exactly as it did on release day.
 */
export async function myPayslip(client: pg.PoolClient, ctx: Ctx, payslipId: number) {
  const employee = await requireLinkedEmployee(client, ctx);
  const employeeId = Number(employee.id);
  const slipRes = await client.query(
    `SELECT s.id, s.payslip_no, s.currency, s.gross_total, s.taxable_total, s.deduction_total,
            s.net_total, s.employer_contributions, s.payment_date, s.status, s.published_at,
            s.viewed_at, s.viewed_count, s.download_count, s.verification_code, s.watermark,
            p.id AS payroll_id, p.payroll_no, p.period_start, p.period_end, p.run_type,
            p.off_cycle_type, p.status AS payroll_status, p.currency AS payroll_currency
       FROM payslips s
       LEFT JOIN payrolls p ON p.id = s.payroll_id
      WHERE s.id = $1 AND s.tenant_id = $2 AND s.employee_id = $3 AND s.status = 'PUBLISHED'`,
    [payslipId, ctx.tenantId, employeeId]
  );
  if (!slipRes.rows.length) throw notFound('Payslip not found');
  const slip = slipRes.rows[0];

  const itemRes = await client.query(
    `SELECT * FROM payroll_items WHERE payroll_id = $1 AND employee_id = $2`,
    [slip.payroll_id, employeeId]
  );
  const item = (itemRes.rows[0] ?? {}) as Record<string, unknown>;

  // Year-to-date is anchored on the slip own payment year, so opening an old
  // slip shows the year that slip belongs to rather than the current one.
  const slipYear = new Date(
    String(slip.payment_date ?? slip.published_at ?? new Date().toISOString())
  ).getUTCFullYear();
  const ytd = await client.query(
    `SELECT COUNT(*)::int AS periods,
            COALESCE(SUM(s.gross_total),0) AS gross,
            COALESCE(SUM(s.taxable_total),0) AS taxable,
            COALESCE(SUM(s.deduction_total),0) AS deductions,
            COALESCE(SUM(s.net_total),0) AS net,
            COALESCE(SUM(s.employer_contributions),0) AS employer_contributions,
            COALESCE(SUM(i.paye),0) AS paye,
            COALESCE(SUM(i.nssf),0) AS nssf,
            COALESCE(SUM(i.lst),0) AS lst
       FROM payslips s
       LEFT JOIN payroll_items i ON i.payroll_id = s.payroll_id AND i.employee_id = s.employee_id
      WHERE s.tenant_id = $1 AND s.employee_id = $2 AND s.status = 'PUBLISHED'
        AND COALESCE(s.payment_date, s.published_at::date, s.created_at::date) >= make_date($3::int,1,1)`,
    [ctx.tenantId, employeeId, slipYear]
  );
  const t = ytd.rows[0] ?? {};

  return {
    payslip: {
      ...toCamelRow(slip),
      paymentDate: toISODate(slip.payment_date),
      periodStart: toISODate(slip.period_start),
      periodEnd: toISODate(slip.period_end),
      publishedAt: slip.published_at == null ? null : String(slip.published_at),
      viewedAt: slip.viewed_at == null ? null : String(slip.viewed_at),
    },
    employer: {
      name: employee.company_name == null ? null : String(employee.company_name),
      legalName: employee.company_legal_name == null ? null : String(employee.company_legal_name),
      tin: employee.company_tin == null ? null : String(employee.company_tin),
      address: employee.company_address == null ? null : String(employee.company_address),
      phone: employee.company_phone == null ? null : String(employee.company_phone),
      email: employee.company_email == null ? null : String(employee.company_email),
    },
    employee: {
      id: employeeId,
      employeeNo: employee.employee_no == null ? null : String(employee.employee_no),
      name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
      position: employee.position == null ? null : String(employee.position),
      departmentName: employee.department_name == null ? null : String(employee.department_name),
      branchName: employee.branch_name == null ? null : String(employee.branch_name),
      nssfNo: employee.nssf_no == null ? null : String(employee.nssf_no),
      tin: employee.tin == null ? null : String(employee.tin),
      bankName: employee.bank_name == null ? null : String(employee.bank_name),
      bankAccountMasked: maskAccountNumber(employee.bank_account_no),
    },
    yearToDate: {
      year: slipYear,
      periods: Number(t.periods) || 0,
      gross: num(t.gross),
      taxable: num(t.taxable),
      deductions: num(t.deductions),
      net: num(t.net),
      paye: num(t.paye),
      nssfEmployee: num(t.nssf),
      nssfEmployer: num(t.employer_contributions),
      lst: num(t.lst),
    },
    trace: buildCalculationTrace(item),
  };
}

/**
 * Record that the caller opened one of their own payslips.
 *
 * Only the caller own slip can be touched, and an id that belongs to somebody
 * else is reported as not found. The first open is audited so an employer can
 * show that a payslip was actually delivered and seen; repeat opens only bump
 * the counter, so a curious employee cannot flood the audit trail.
 */
export async function markPayslipViewed(client: pg.PoolClient, ctx: Ctx, payslipId: number) {
  const employee = await requireLinkedEmployee(client, ctx);
  const employeeId = Number(employee.id);
  const res = await client.query(
    `WITH before AS (
         SELECT id, viewed_at, payslip_no, payroll_id
           FROM payslips
          WHERE id = $1 AND tenant_id = $2 AND employee_id = $3 AND status = 'PUBLISHED'
          FOR UPDATE
       ),
       upd AS (
         UPDATE payslips p
            SET viewed_count = COALESCE(p.viewed_count, 0) + 1,
                viewed_at = COALESCE(p.viewed_at, now()),
                updated_at = now()
           FROM before
          WHERE p.id = before.id
      RETURNING p.id, p.viewed_at, p.viewed_count, p.payslip_no, p.payroll_id
       )
SELECT upd.*, (before.viewed_at IS NULL) AS first_view
  FROM upd JOIN before ON before.id = upd.id`,
    [payslipId, ctx.tenantId, employeeId]
  );
  if (!res.rows.length) throw notFound('Payslip not found');
  const row = res.rows[0];
  if (row.first_view === true) {
    await logAudit(client, ctx, {
      action: 'payslip-viewed',
      resource: 'payslips',
      recordId: Number(row.id),
      recordCode: row.payslip_no == null ? null : String(row.payslip_no),
      newValues: { payslipId: Number(row.id), payrollId: row.payroll_id, employeeId },
    });
  }
  return {
    id: Number(row.id),
    payslipNo: row.payslip_no == null ? null : String(row.payslip_no),
    viewedAt: row.viewed_at == null ? null : String(row.viewed_at),
    viewedCount: Number(row.viewed_count) || 0,
  };
}
