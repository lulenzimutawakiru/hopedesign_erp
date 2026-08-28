import pg from 'pg';
import { Ctx } from '../db.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Normalizes pg date values (Date objects or 'YYYY-MM-DD' strings). */
export function toIsoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function parseDate(d: unknown): number {
  const iso = toIsoDate(d);
  if (!iso) return Number.NaN;
  return Date.parse(`${iso}T00:00:00Z`);
}

/** Inclusive calendar-day overlap between two date ranges. */
export function overlapCalendarDays(
  aStart: unknown,
  aEnd: unknown,
  bStart: unknown,
  bEnd: unknown
): number {
  const s = Math.max(parseDate(aStart), parseDate(bStart));
  const e = Math.min(parseDate(aEnd), parseDate(bEnd));
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 0;
  return Math.floor((e - s) / 86400000) + 1;
}

export interface Proration {
  periodDays: number;
  workDays: number;
  unpaidDays: number;
  payableDays: number;
  factor: number;
}

/**
 * Modern payroll proration: an employee is paid for the calendar days they
 * actually worked inside the run period. Hire and termination dates bound the
 * employment window; approved unpaid leave reduces payable days further.
 */
export function prorateEmployment(
  hireDate: string | null | undefined,
  terminationDate: string | null | undefined,
  periodStart: string,
  periodEnd: string,
  unpaidDays = 0
): Proration {
  const periodDays = overlapCalendarDays(periodStart, periodEnd, periodStart, periodEnd);
  const hire = toIsoDate(hireDate);
  const term = toIsoDate(terminationDate);
  const workDays = hire || term
    ? overlapCalendarDays(periodStart, periodEnd, hire ?? periodStart, term ?? periodEnd)
    : periodDays;
  const cappedUnpaid = Math.min(Math.max(0, unpaidDays), workDays);
  const payableDays = Math.max(0, workDays - cappedUnpaid);
  const factor = periodDays > 0 ? payableDays / periodDays : 1;
  return { periodDays, workDays, unpaidDays: cappedUnpaid, payableDays, factor };
}

/**
 * Prorated monthly basic pay. Keeps the legacy unpaid-leave formula
 * (monthly salary divided by 30) so full-period employees see identical
 * numbers, and scales the entitlement by the employment-window factor for
 * mid-period hires and terminations.
 */
export function prorateBasic(baseSalary: number, pr: Proration): number {
  const workFactor = pr.periodDays > 0 ? pr.workDays / pr.periodDays : 1;
  const prorated = round2(Math.max(0, Number(baseSalary) || 0) * workFactor);
  const unpaidDeduct = round2((Math.max(0, Number(baseSalary) || 0) / 30) * pr.unpaidDays);
  return round2(Math.max(0, prorated - unpaidDeduct));
}

// ---------- Payroll components (employee_payroll_components) ----------

export interface PayrollComponent {
  componentId: number;
  code: string;
  name: string;
  type: 'EARNING' | 'DEDUCTION';
  category: string;
  isTaxable: boolean;
  isBenefitInKind: boolean;
  calculationType: string;
  value: number;
}

/** Resolves a component's monthly amount for the run (fixed or percentage of
 * prorated basic). FORMULA components are skipped - arbitrary formulas are
 * unsafe to evaluate here and should be pre-computed by an HCM action. */
export function resolveComponentAmount(
  comp: PayrollComponent,
  proratedBasic: number,
  factor: number
): number {
  const value = Number(comp.value) || 0;
  const method = String(comp.calculationType || 'FIXED').toUpperCase();
  if (method === 'PERCENTAGE') return round2(proratedBasic * (value / 100));
  if (method === 'FORMULA') return 0;
  return round2(value * factor);
}

/**
 * Loads the employee's active, effective-dated payroll components joined to
 * their definitions. This is the live component source (registry writes it);
 * salary_structures remain unused and are intentionally not read here.
 */
export async function loadEmployeeComponents(
  client: pg.PoolClient,
  ctx: Ctx,
  employeeIds: number[],
  periodStart: string,
  periodEnd: string
): Promise<Map<number, PayrollComponent[]>> {
  const result = new Map<number, PayrollComponent[]>();
  if (employeeIds.length === 0) return result;
  const res = await client.query(
    `SELECT epc.employee_id, epc.component_id, d.code, d.name, d.type, d.category,
            d.is_taxable, d.is_benefit_in_kind, d.calculation_type,
            COALESCE(NULLIF(epc.value, 0), d.value, 0) AS value
     FROM employee_payroll_components epc
     JOIN payroll_component_definitions d ON d.id = epc.component_id
     WHERE epc.tenant_id = $1 AND epc.company_id = $2
       AND epc.employee_id = ANY($3::bigint[])
       AND epc.status = 'ACTIVE' AND d.status = 'ACTIVE'
       AND epc.effective_from <= $5::date
       AND (epc.effective_to IS NULL OR epc.effective_to >= $4::date)`,
    [ctx.tenantId, ctx.companyId, employeeIds, periodStart, periodEnd]
  );
  for (const r of res.rows) {
    const employeeId = Number(r.employee_id);
    const list = result.get(employeeId) ?? [];
    list.push({
      componentId: Number(r.component_id),
      code: String(r.code),
      name: String(r.name),
      type: String(r.type) === 'DEDUCTION' ? 'DEDUCTION' : 'EARNING',
      category: String(r.category ?? 'OTHER'),
      isTaxable: Boolean(r.is_taxable),
      isBenefitInKind: Boolean(r.is_benefit_in_kind),
      calculationType: String(r.calculation_type ?? 'FIXED'),
      value: Number(r.value) || 0,
    });
    result.set(employeeId, list);
  }
  return result;
}

// ---------- Variable pay (overtime / bonus / commission / earnings) ----------

export interface VariablePayLine {
  id: number;
  code: string;
  name: string;
  amount: number;
  taxable: boolean;
  percentage?: number;
}

export interface VariablePay {
  overtime: number;
  bonuses: number;
  commissions: number;
  earnings: VariablePayLine[];
  deductions: VariablePayLine[];
  benefitsEmployee: number;
  benefitsEmployer: number;
  benefitsTaxable: number;
}

export function emptyVariablePay(): VariablePay {
  return {
    overtime: 0,
    bonuses: 0,
    commissions: 0,
    earnings: [],
    deductions: [],
    benefitsEmployee: 0,
    benefitsEmployer: 0,
    benefitsTaxable: 0,
  };
}

/**
 * Loads approved, effective-dated variable pay and benefits for the run
 * period in three batched queries. Empty tables are a no-op so legacy runs
 * with no modern setup keep identical totals.
 */
export async function loadVariablePay(
  client: pg.PoolClient,
  ctx: Ctx,
  employeeIds: number[],
  periodStart: string,
  periodEnd: string
): Promise<Map<number, VariablePay>> {
  const result = new Map<number, VariablePay>();
  if (employeeIds.length === 0) return result;
  const ensure = (employeeId: number): VariablePay => {
    let v = result.get(employeeId);
    if (!v) {
      v = emptyVariablePay();
      result.set(employeeId, v);
    }
    return v;
  };

  const overtime = await client.query(
    `SELECT employee_id, id, overtime_type, hours, unit_amount,
            COALESCE(NULLIF(amount, 0), unit_amount * hours, 0) AS amount
     FROM overtime_records
     WHERE tenant_id = $1 AND company_id = $2
       AND employee_id = ANY($3::bigint[])
       AND status = 'APPROVED'
       AND overtime_date BETWEEN $4::date AND $5::date`,
    [ctx.tenantId, ctx.companyId, employeeIds, periodStart, periodEnd]
  );
  for (const r of overtime.rows) {
    const v = ensure(Number(r.employee_id));
    v.overtime = round2(v.overtime + (Number(r.amount) || 0));
  }

  const bonuses = await client.query(
    `SELECT employee_id, id, bonus_type, amount
     FROM bonus_records
     WHERE tenant_id = $1 AND company_id = $2
       AND employee_id = ANY($3::bigint[])
       AND status = 'APPROVED'
       AND COALESCE(approved_at, created_at)::date BETWEEN $4::date AND $5::date`,
    [ctx.tenantId, ctx.companyId, employeeIds, periodStart, periodEnd]
  );
  for (const r of bonuses.rows) {
    const v = ensure(Number(r.employee_id));
    v.bonuses = round2(v.bonuses + (Number(r.amount) || 0));
  }

  const commissions = await client.query(
    `SELECT employee_id, id, commission_type, amount
     FROM commission_records
     WHERE tenant_id = $1 AND company_id = $2
       AND employee_id = ANY($3::bigint[])
       AND status = 'APPROVED'
       AND COALESCE(period_start, created_at::date) <= $5::date
       AND (period_end IS NULL OR period_end >= $4::date)`,
    [ctx.tenantId, ctx.companyId, employeeIds, periodStart, periodEnd]
  );
  for (const r of commissions.rows) {
    const v = ensure(Number(r.employee_id));
    v.commissions = round2(v.commissions + (Number(r.amount) || 0));
  }
  return result;
}

/**
 * Loads approved, effective employee-specific earnings and deductions
 * (employee_earnings / employee_deductions). Percentages are resolved
 * against the employee's prorated basic in the caller.
 */
export async function loadEmployeeEarningsAndDeductions(
  client: pg.PoolClient,
  ctx: Ctx,
  employeeIds: number[],
  periodStart: string,
  periodEnd: string
): Promise<Map<number, { earnings: VariablePayLine[]; deductions: VariablePayLine[] }>> {
  const result = new Map<number, { earnings: VariablePayLine[]; deductions: VariablePayLine[] }>();
  if (employeeIds.length === 0) return result;
  const ensure = (employeeId: number) => {
    let v = result.get(employeeId);
    if (!v) {
      v = { earnings: [], deductions: [] };
      result.set(employeeId, v);
    }
    return v;
  };

  const earnings = await client.query(
    `SELECT e.employee_id, e.id, e.amount, e.percentage, e.taxable,
            COALESCE(sc.code, 'EEARN') AS code, COALESCE(sc.name, 'Employee earning') AS name
     FROM employee_earnings e
     LEFT JOIN salary_components sc ON sc.id = e.component_id
     WHERE e.tenant_id = $1 AND e.company_id = $2
       AND e.employee_id = ANY($3::bigint[])
       AND e.status = 'APPROVED'
       AND e.effective_from <= $5::date
       AND (e.effective_to IS NULL OR e.effective_to >= $4::date)`,
    [ctx.tenantId, ctx.companyId, employeeIds, periodStart, periodEnd]
  );
  for (const r of earnings.rows) {
    ensure(Number(r.employee_id)).earnings.push({
      id: Number(r.id),
      code: String(r.code),
      name: String(r.name),
      amount: Number(r.amount) || 0,
      percentage: Number(r.percentage) || 0,
      taxable: Boolean(r.taxable),
    });
  }

  const deductions = await client.query(
    `SELECT d.employee_id, d.id, d.amount, d.percentage,
            COALESCE(sc.code, 'EDDED') AS code, COALESCE(sc.name, 'Employee deduction') AS name
     FROM employee_deductions d
     LEFT JOIN salary_components sc ON sc.id = d.component_id
     WHERE d.tenant_id = $1 AND d.company_id = $2
       AND d.employee_id = ANY($3::bigint[])
       AND d.status = 'APPROVED'
       AND d.effective_from <= $5::date
       AND (d.effective_to IS NULL OR d.effective_to >= $4::date)`,
    [ctx.tenantId, ctx.companyId, employeeIds, periodStart, periodEnd]
  );
  for (const r of deductions.rows) {
    ensure(Number(r.employee_id)).deductions.push({
      id: Number(r.id),
      code: String(r.code),
      name: String(r.name),
      amount: Number(r.amount) || 0,
      percentage: Number(r.percentage) || 0,
      taxable: false,
    });
  }
  return result;
}

/**
 * Loads active benefits with their employer/employee contributions.
 * Recurrence: MONTHLY pays the full monthly value, ANNUAL is spread over
 * twelve months, ONE_TIME only pays when the benefit starts inside the run
 * period. Employee contributions are deducted from net pay; employer
 * contributions are employer cost (tracked separately, never in net).
 */
export async function loadEmployeeBenefits(
  client: pg.PoolClient,
  ctx: Ctx,
  employeeIds: number[],
  periodStart: string,
  periodEnd: string
): Promise<Map<number, { employee: number; employer: number; taxable: number }>> {
  const result = new Map<number, { employee: number; employer: number; taxable: number }>();
  if (employeeIds.length === 0) return result;
  const res = await client.query(
    `SELECT employee_id, id, name, employer_contribution, employee_contribution,
            taxable, recurrence, effective_from
     FROM employee_benefits
     WHERE tenant_id = $1 AND company_id = $2
       AND employee_id = ANY($3::bigint[])
       AND status = 'ACTIVE'
       AND effective_from <= $5::date
       AND (effective_to IS NULL OR effective_to >= $4::date)`,
    [ctx.tenantId, ctx.companyId, employeeIds, periodStart, periodEnd]
  );
  for (const r of res.rows) {
    const employeeId = Number(r.employee_id);
    const recurrence = String(r.recurrence ?? 'MONTHLY').toUpperCase();
    const inPeriod = overlapCalendarDays(r.effective_from, r.effective_from, periodStart, periodEnd) > 0;
    let employee = Number(r.employee_contribution) || 0;
    let employer = Number(r.employer_contribution) || 0;
    if (recurrence === 'ANNUAL') {
      employee = employee / 12;
      employer = employer / 12;
    } else if (recurrence === 'ONE_TIME' && !inPeriod) {
      continue;
    }
    const v = result.get(employeeId) ?? { employee: 0, employer: 0, taxable: 0 };
    v.employee = round2(v.employee + employee);
    v.employer = round2(v.employer + employer);
    if (Boolean(r.taxable)) v.taxable = round2(v.taxable + employer);
    result.set(employeeId, v);
  }
  return result;
}

// ---------- Effective-dated salary ----------

export interface EffectiveSalary {
  id: number;
  basicSalary: number;
  effectiveFrom: string;
}

/** Loads the employee's current effective-dated salary (employee_salaries).
 * When present it overrides employees.base_salary; otherwise the employee
 * record's base salary is used. */
export async function loadEffectiveSalaries(
  client: pg.PoolClient,
  ctx: Ctx,
  employeeIds: number[],
  periodStart: string,
  periodEnd: string
): Promise<Map<number, EffectiveSalary>> {
  const result = new Map<number, EffectiveSalary>();
  if (employeeIds.length === 0) return result;
  const res = await client.query(
    `SELECT employee_id, id, basic_salary, effective_from
     FROM employee_salaries
     WHERE tenant_id = $1 AND company_id = $2
       AND employee_id = ANY($3::bigint[])
       AND is_current = true
       AND effective_from <= $5::date
       AND (effective_to IS NULL OR effective_to >= $4::date)`,
    [ctx.tenantId, ctx.companyId, employeeIds, periodStart, periodEnd]
  );
  for (const r of res.rows) {
    result.set(Number(r.employee_id), {
      id: Number(r.id),
      basicSalary: Number(r.basic_salary) || 0,
      effectiveFrom: String(r.effective_from),
    });
  }
  return result;
}

// ---------- Batch loader used by the live calculation engine ----------

export interface ModernPayrollInputs {
  components: Map<number, PayrollComponent[]>;
  variablePay: Map<number, VariablePay>;
  earningsAndDeductions: Map<number, { earnings: VariablePayLine[]; deductions: VariablePayLine[] }>;
  benefits: Map<number, { employee: number; employer: number; taxable: number }>;
  salaries: Map<number, EffectiveSalary>;
}

/** Loads every modern-payroll input for the run's staff in one pass so the
 * calculation loop stays O(1) per employee. All loads are no-ops on empty
 * tables, keeping legacy-only runs bit-identical. */
export async function loadModernPayrollInputs(
  client: pg.PoolClient,
  ctx: Ctx,
  employeeIds: number[],
  periodStart: string,
  periodEnd: string
): Promise<ModernPayrollInputs> {
  const [components, variablePay, earningsAndDeductions, benefits, salaries] = await Promise.all([
    loadEmployeeComponents(client, ctx, employeeIds, periodStart, periodEnd),
    loadVariablePay(client, ctx, employeeIds, periodStart, periodEnd),
    loadEmployeeEarningsAndDeductions(client, ctx, employeeIds, periodStart, periodEnd),
    loadEmployeeBenefits(client, ctx, employeeIds, periodStart, periodEnd),
    loadEffectiveSalaries(client, ctx, employeeIds, periodStart, periodEnd),
  ]);
  return { components, variablePay, earningsAndDeductions, benefits, salaries };
}

export interface EarningsLine {
  kind: 'COMPONENT' | 'OVERTIME' | 'BONUS' | 'COMMISSION' | 'EARNING';
  componentId?: number;
  code: string;
  name: string;
  amount: number;
  taxable: boolean;
}

export interface DeductionLine {
  kind: 'COMPONENT' | 'DEDUCTION' | 'BENEFIT';
  componentId?: number;
  code: string;
  name: string;
  amount: number;
}



