import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, db, deleteEmployees } from './helpers.js';

/**
 * Creates a dedicated, unique payroll group and assigns the employee's payroll
 * profile to it, so the payroll run only ever contains the test employee
 * (group-less runs pull in every ACTIVE employee of the demo company).
 */
async function createGroupFor(employeeId: number): Promise<number> {
  const g = await db(
    `INSERT INTO payroll_groups (company_id, tenant_id, code, name, frequency, salary_currency, status)
     VALUES ((SELECT company_id FROM employees WHERE id=$1),(SELECT tenant_id FROM employees WHERE id=$1),$2,'Reports Test Group','MONTHLY','UGX','ACTIVE')
     RETURNING id`,
    [employeeId, `REPTEST-${Date.now()}`]
  );
  const groupId = Number(g.rows[0].id);
  await db(
    `INSERT INTO employee_payroll_profiles (company_id, tenant_id, employee_id, payroll_group_id, payment_method, currency, status)
     VALUES ((SELECT company_id FROM employees WHERE id=$1),(SELECT tenant_id FROM employees WHERE id=$1),$1,$2,'BANK_TRANSFER','UGX','ACTIVE')`,
    [employeeId, groupId]
  );
  return groupId;
}

type Row = Record<string, unknown>;

describe('Payroll reports', () => {
  it('serves register, summary, statutory, earnings, deductions and payslip-register reports for a processed run', async () => {
    // 1. Employee with bank details, created by the HR officer.
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Report',
      lastName: `Tester${Date.now()}`,
      position: 'Clerk',
      baseSalary: 3000000,
      bankName: 'Stanbic',
      bankAccountNo: '1122334455',
      phone: '+256700000001',
      tin: '1234567894',
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);
    const groupId = await createGroupFor(employeeId);

    // 2. Group-scoped single-day payroll run (known fixture: gross 3,000,000,
    // PAYE 743,250 on 2,850,000 taxable, NSSF 150,000, net 2,106,750).
    const run = await api.post('/api/ops/hr/payrolls').set(auth(token)).send({
      periodStart: '2027-06-08',
      periodEnd: '2027-06-08',
      payrollGroupId: groupId,
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);
    // 3. Seed one published payslip so the payslip-register view has a row.
    await db(
      `INSERT INTO payslips (company_id, tenant_id, employee_id, payslip_no, currency, gross_total, taxable_total, deduction_total, net_total, employer_contributions, payment_date, status, payroll_id)
       VALUES ((SELECT company_id FROM employees WHERE id=$1),(SELECT tenant_id FROM employees WHERE id=$1),$1,$2,'UGX',3000000,2850000,893250,2106750,300000,'2027-06-08','PUBLISHED', $3)`,
      [employeeId, `PST-${Date.now()}`, payrollId]
    );

    const { token: admin } = await loginAs('admin');
    const filter = { payrollId };

    // 4. Payroll register: one row per employee with the full calculation trail.
    const reg = await api.get('/api/reports/payroll-register').query(filter).set(auth(admin));
    expect(reg.status).toBe(200);
    const regRow = (reg.body.data as Row[]).find((r) => Number(r.employeeId) === employeeId);
    expect(regRow).toBeTruthy();
    expect(Number(regRow!.grossPay)).toBe(3000000);
    expect(Number(regRow!.taxableIncome)).toBe(2850000);
    expect(Number(regRow!.paye)).toBe(743250);
    expect(Number(regRow!.nssf)).toBe(150000);
    expect(Number(regRow!.totalDeductions)).toBe(893250);
    expect(Number(regRow!.netPay)).toBe(2106750);

    // 5. Payroll summary: per-run totals from the payroll header.
    const sum = await api.get('/api/reports/payroll-summary').query(filter).set(auth(admin));
    expect(sum.status).toBe(200);
    expect(sum.body.data.length).toBe(1);
    expect(Number(sum.body.data[0].employeeCount)).toBe(1);
    expect(Number(sum.body.data[0].grossTotal)).toBe(3000000);
    expect(Number(sum.body.data[0].payeTotal)).toBe(743250);
    expect(Number(sum.body.data[0].nssfTotal)).toBe(150000);
    expect(Number(sum.body.data[0].netTotal)).toBe(2106750);

    // 6. Statutory report: one row per employee per statutory rule.
    const stat = await api.get('/api/reports/payroll-statutory').query(filter).set(auth(admin));
    expect(stat.status).toBe(200);
    const rows = stat.body.data as Row[];
    const paye = rows.find((r) => r.ruleCode === 'PAYE' && r.contributionType === 'EMPLOYEE');
    expect(paye).toBeTruthy();
    expect(Number(paye!.taxableBase)).toBe(2850000);
    expect(Number(paye!.amount)).toBe(743250);
    expect(rows.some((r) => r.ruleCode === 'NSSF' && r.contributionType === 'EMPLOYEE' && Number(r.amount) === 150000)).toBe(true);
    expect(rows.some((r) => r.ruleCode === 'NSSF' && r.contributionType === 'EMPLOYER' && Number(r.amount) === 300000)).toBe(true);

    // 7. Earnings and deductions breakdowns.
    const earn = await api.get('/api/reports/payroll-earnings').query(filter).set(auth(admin));
    expect(earn.status).toBe(200);
    const earnRow = (earn.body.data as Row[]).find((r) => Number(r.employeeId) === employeeId);
    expect(Number(earnRow!.basicPay)).toBe(3000000);
    expect(Number(earnRow!.netPay)).toBe(2106750);

    const ded = await api.get('/api/reports/payroll-deductions').query(filter).set(auth(admin));
    expect(ded.status).toBe(200);
    const dedRow = (ded.body.data as Row[]).find((r) => Number(r.employeeId) === employeeId);
    expect(Number(dedRow!.totalDeductions)).toBe(893250);
    expect(Number(dedRow!.netPay)).toBe(2106750);

    // 8. Payslip register from published payslips.
    const slips = await api.get('/api/reports/payslip-register').query(filter).set(auth(admin));
    expect(slips.status).toBe(200);
    const slip = (slips.body.data as Row[]).find((r) => Number(r.employeeId) === employeeId);
    expect(slip).toBeTruthy();
    expect(slip!.payslipStatus).toBe('PUBLISHED');
    expect(Number(slip!.netTotal)).toBe(2106750);
    expect(Number(slip!.employerContributions)).toBe(300000);

    // 9. Export formats: CSV, XLSX and branded print HTML.
    const csv = await api.get('/api/reports/payroll-register').query({ ...filter, format: 'csv' }).set(auth(admin));
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');

    const xlsx = await api.get('/api/reports/payroll-summary').query({ ...filter, format: 'xlsx' }).set(auth(admin));
    expect(xlsx.status).toBe(200);
    expect(String(xlsx.headers['content-type'])).toContain('spreadsheetml');

    const print = await api.get('/api/reports/payroll-register').query({ ...filter, format: 'print' }).set(auth(admin));
    expect(print.status).toBe(200);
    expect(String(print.headers['content-type'])).toContain('text/html');
    expect(print.text).toContain('Payroll Register');

    // 10. RBAC: an HR officer with payroll rights but no reports permission is denied.
    const denied = await api.get('/api/reports/payroll-register').query(filter).set(auth(token));
    expect(denied.status).toBe(403);

    // Self-clean in FK order so re-runs never collide.
    await db(`DELETE FROM payslips WHERE payroll_id = $1`, [payrollId]);
    await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
    await deleteEmployees([employeeId]);
    await db(`DELETE FROM employee_payroll_profiles WHERE payroll_group_id = $1`, [groupId]);
    await db(`DELETE FROM payroll_groups WHERE id = $1`, [groupId]);
  }, 30_000);
});
