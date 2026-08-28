import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, db, deleteEmployees } from './helpers.js';

const rand = () => Math.floor(Math.random() * 9000) + 1000;
const code = (p: string) => `${p}-${rand()}`;

type Breakdown = {
  earnings: { kind: string; amount: number; taxable: boolean }[];
  deductions: { kind: string; amount: number }[];
  benefits: { employee: number; employer: number };
  proration: { periodDays: number; workDays: number; payableDays: number; factor: number };
};

const parseBreakdown = (raw: unknown): Breakdown =>
  typeof raw === 'string' ? JSON.parse(raw) : (raw as Breakdown);

describe('modern payroll engine', () => {
  it('calculates a run from components, variable pay, benefits and effective salaries', async () => {
    const { token } = await loginAs('hr.hannah');
    const day = String(10 + Math.floor(Math.random() * 18)).padStart(2, '0');
    const runDate = `2027-09-${day}`;

    // 1. Employee whose base salary an effective-salary record will override.
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Modern',
      lastName: 'Payroll',
      position: 'Engineer',
      baseSalary: 2500000,
      hireDate: '2026-01-01',
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);

    const empRow = await db(`SELECT company_id, tenant_id FROM employees WHERE id = $1`, [employeeId]);
    const companyId = Number(empRow.rows[0].company_id);
    const tenantId = Number(empRow.rows[0].tenant_id);

    // 2. Component definitions through the CRUD API (registry + hr_manager grants).
    const allow = await api.post('/api/hr/payroll_components').set(auth(token)).send({
      code: code('MOD-ALLOW'),
      name: 'Modern Taxable Allowance',
      type: 'EARNING',
      category: 'ALLOWANCE',
      isTaxable: true,
      calculationType: 'FIXED',
      value: 200000,
    });
    expect(allow.status).toBe(201);
    const allowId = Number(allow.body.data.id);

    const ntx = await api.post('/api/hr/payroll_components').set(auth(token)).send({
      code: code('MOD-NTX'),
      name: 'Modern Non-Taxable Allowance',
      type: 'EARNING',
      category: 'ALLOWANCE',
      isTaxable: false,
      calculationType: 'FIXED',
      value: 100000,
    });
    expect(ntx.status).toBe(201);
    const ntxId = Number(ntx.body.data.id);

    const ded = await api.post('/api/hr/payroll_components').set(auth(token)).send({
      code: code('MOD-DED'),
      name: 'Modern Deduction',
      type: 'DEDUCTION',
      category: 'OTHER',
      isTaxable: false,
      calculationType: 'FIXED',
      value: 50000,
    });
    expect(ded.status).toBe(201);
    const dedId = Number(ded.body.data.id);
    const componentIds = [allowId, ntxId, dedId];

    // 3. Employee component assignments (direct inserts: the shared
    //    payroll_components resource resolves to the definitions table and
    //    status is process-controlled, so it cannot be set through the API).
    await db(
      `INSERT INTO employee_payroll_components (company_id, tenant_id, employee_id, component_id, value, effective_from)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [companyId, tenantId, employeeId, allowId, 250000, '2026-01-01']
    );
    // Zero value falls back to the definition value (100000).
    await db(
      `INSERT INTO employee_payroll_components (company_id, tenant_id, employee_id, component_id, value, effective_from)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [companyId, tenantId, employeeId, ntxId, 0, '2026-01-01']
    );
    await db(
      `INSERT INTO employee_payroll_components (company_id, tenant_id, employee_id, component_id, value, effective_from)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [companyId, tenantId, employeeId, dedId, 50000, '2026-01-01']
    );

    // 4. Effective-dated salary overrides the 2.5m base salary.
    await db(
      `INSERT INTO employee_salaries (company_id, tenant_id, employee_id, basic_salary, effective_from, is_current)
       VALUES ($1,$2,$3,$4,$5,true)`,
      [companyId, tenantId, employeeId, 3000000, '2026-01-01']
    );

    // 5. Approved variable pay and benefits inside the run window.
    await db(
      `INSERT INTO employee_earnings (company_id, tenant_id, employee_id, amount, taxable, effective_from, status)
       VALUES ($1,$2,$3,$4,true,$5,'APPROVED')`,
      [companyId, tenantId, employeeId, 80000, '2026-01-01']
    );
    await db(
      `INSERT INTO employee_deductions (company_id, tenant_id, employee_id, amount, effective_from, status)
       VALUES ($1,$2,$3,$4,$5,'APPROVED')`,
      [companyId, tenantId, employeeId, 30000, '2026-01-01']
    );
    await db(
      `INSERT INTO employee_benefits (company_id, tenant_id, employee_id, benefit_type, name, employer_contribution, employee_contribution, taxable, recurrence, effective_from, status)
       VALUES ($1,$2,$3,'MEDICAL','Modern Medical',$4,$5,true,'MONTHLY',$6,'ACTIVE')`,
      [companyId, tenantId, employeeId, 200000, 40000, '2026-01-01']
    );
    await db(
      `INSERT INTO overtime_records (company_id, tenant_id, employee_id, overtime_type, overtime_date, hours, unit_amount, amount, status, approved_at)
       VALUES ($1,$2,$3,'NORMAL',$4,4,25000,100000,'APPROVED',$5)`,
      [companyId, tenantId, employeeId, runDate, `${runDate} 12:00:00`]
    );
    await db(
      `INSERT INTO bonus_records (company_id, tenant_id, employee_id, bonus_type, reason, amount, status, approved_at)
       VALUES ($1,$2,$3,'PERFORMANCE','Q3 performance',$4,'APPROVED',$5)`,
      [companyId, tenantId, employeeId, 150000, `${runDate} 12:00:00`]
    );
    await db(
      `INSERT INTO commission_records (company_id, tenant_id, employee_id, commission_type, amount, period_start, period_end, status, approved_at)
       VALUES ($1,$2,$3,'SALES',120000,'2027-09-01','2027-09-30','APPROVED',$4)`,
      [companyId, tenantId, employeeId, `${runDate} 12:00:00`]
    );

    // 6. Run the payroll.
    const run = await api.post('/api/ops/hr/payrolls').set(auth(token)).send({
      periodStart: runDate,
      periodEnd: runDate,
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);

    const detail = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(token));
    expect(detail.status).toBe(200);
    const items = detail.body.data.items as {
      employeeId: string; basicPay: string; grossPay: string; taxableIncome: string;
      paye: string; nssf: string; employerNssf: string; otherDeductions: string; netPay: string; breakdown: unknown;
    }[];
    const item = items.find((i) => Number(i.employeeId) === employeeId);
    expect(item).toBeTruthy();

    // Effective salary wins over employees.base_salary.
    expect(Number(item!.basicPay)).toBe(3000000);
    // Basic + taxable 250k + non-taxable 100k + overtime 100k + bonus 150k + commission 120k + earning 80k.
    expect(Number(item!.grossPay)).toBe(3800000);
    // The non-taxable component stays out of the tax base.
    expect(Number(item!.taxableIncome)).toBe(3900000);
    // PAYE on 3.9m: 10k + 15k + 30% over 410k.
    expect(Number(item!.paye)).toBe(1072000);
    expect(Number(item!.nssf)).toBe(190000);
    expect(Number(item!.employerNssf)).toBe(380000);
    // Component deduction 50k + employee deduction 30k + benefit employee share 40k.
    expect(Number(item!.otherDeductions)).toBe(120000);
    expect(Number(item!.netPay)).toBe(2418000);

    const breakdown = parseBreakdown(item!.breakdown);
    expect(breakdown.earnings.map((e) => ({ kind: e.kind, amount: e.amount, taxable: e.taxable }))).toEqual([
      { kind: 'COMPONENT', amount: 250000, taxable: true },
      { kind: 'COMPONENT', amount: 100000, taxable: false },
      { kind: 'OVERTIME', amount: 100000, taxable: true },
      { kind: 'BONUS', amount: 150000, taxable: true },
      { kind: 'COMMISSION', amount: 120000, taxable: true },
      { kind: 'EARNING', amount: 80000, taxable: true },
    ]);
    expect(breakdown.deductions.map((d) => ({ kind: d.kind, amount: d.amount }))).toEqual([
      { kind: 'COMPONENT', amount: 50000 },
      { kind: 'DEDUCTION', amount: 30000 },
      { kind: 'BENEFIT', amount: 40000 },
    ]);
    expect(breakdown.benefits).toEqual({ employee: 40000, employer: 200000 });

    // Component entries persist so reports can reconstruct the run.
    const entries = await db(
      `SELECT employee_id, component_id, amount FROM payroll_component_entries WHERE payroll_id = $1`,
      [payrollId]
    );
    expect(entries.rows.length).toBe(3);
    const entryTotal = entries.rows.reduce((s: number, r) => s + Number(r.amount), 0);
    expect(entryTotal).toBe(400000);

    // Cleanup: payroll first (cascades items/entries), employee children,
    // then component definitions last (no cascade from entries).
    await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
    await deleteEmployees([employeeId]);
    await db(`DELETE FROM payroll_component_definitions WHERE id = ANY($1::bigint[])`, [componentIds]);
  }, 30_000);

  it('prorates basic pay for a mid-period hire in a live run', async () => {
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Prorated',
      lastName: 'Hire',
      position: 'Clerk',
      baseSalary: 3000000,
      hireDate: '2027-09-10',
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);

    const run = await api.post('/api/ops/hr/payrolls').set(auth(token)).send({
      periodStart: '2027-09-01',
      periodEnd: '2027-09-30',
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);

    const detail = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(token));
    expect(detail.status).toBe(200);
    const items = detail.body.data.items as {
      employeeId: string; basicPay: string; grossPay: string; paye: string; nssf: string; netPay: string; breakdown: unknown;
    }[];
    const item = items.find((i) => Number(i.employeeId) === employeeId);
    expect(item).toBeTruthy();

    // Hired 2027-09-10: 21 of 30 days worked, so basic scales by 0.7.
    expect(Number(item!.basicPay)).toBe(2100000);
    expect(Number(item!.grossPay)).toBe(2100000);
    expect(Number(item!.paye)).toBe(532000);
    expect(Number(item!.nssf)).toBe(105000);
    expect(Number(item!.netPay)).toBe(1463000);

    const breakdown = parseBreakdown(item!.breakdown);
    expect(breakdown.proration.periodDays).toBe(30);
    expect(breakdown.proration.workDays).toBe(21);
    expect(breakdown.proration.payableDays).toBe(21);
    expect(breakdown.proration.factor).toBeCloseTo(0.7);

    await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
    await deleteEmployees([employeeId]);
  }, 30_000);
});
