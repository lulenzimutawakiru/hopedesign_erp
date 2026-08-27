import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, db, deleteEmployees } from './helpers.js';

/**
 * Dedicated, unique payroll group so the run only ever contains the test
 * employee (group-less runs pull in every ACTIVE employee of the demo company).
 */
async function createGroupFor(employeeId: number): Promise<number> {
  const g = await db(
    `INSERT INTO payroll_groups (company_id, tenant_id, code, name, frequency, salary_currency, status)
     VALUES ((SELECT company_id FROM employees WHERE id=$1),(SELECT tenant_id FROM employees WHERE id=$1),$2,'Loans Test Group','MONTHLY','UGX','ACTIVE')
     RETURNING id`,
    [employeeId, `LNTEST-${Date.now()}`]
  );
  const groupId = Number(g.rows[0].id);
  await db(
    `INSERT INTO employee_payroll_profiles (company_id, tenant_id, employee_id, payroll_group_id, payment_method, currency, status)
     VALUES ((SELECT company_id FROM employees WHERE id=$1),(SELECT tenant_id FROM employees WHERE id=$1),$1,$2,'BANK_TRANSFER','UGX','ACTIVE')`,
    [employeeId, groupId]
  );
  return groupId;
}

describe('Payroll loans and salary advances', () => {
  it('runs the loan and advance lifecycle: request -> approve -> deduct -> repay -> close', async () => {
    // 1. Employee created by the HR manager.
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Loan',
      lastName: `Tester${Date.now()}`,
      position: 'Clerk',
      baseSalary: 3000000,
      bankName: 'Stanbic',
      bankAccountNo: '0987654321',
      phone: '+256700000000',
      tin: '1234567894',
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);
    const groupId = await createGroupFor(employeeId);

    // 2. Excessive advance is rejected by the configurable ceiling (1x salary).
    const excessive = await api.post(`/api/ops/hr/employees/${employeeId}/advances`).set(auth(token)).send({
      amount: 4000000,
    });
    expect(excessive.status).toBe(400);
    expect(String(excessive.body.error.message)).toMatch(/ceiling/i);

    // 3. Valid advance created as PENDING.
    const adv = await api.post(`/api/ops/hr/employees/${employeeId}/advances`).set(auth(token)).send({
      amount: 300000,
      reason: 'School fees',
    });
    expect(adv.status).toBe(200);
    const advanceId = Number(adv.body.data.advanceId);
    expect(adv.body.data.status).toBe('PENDING');
    expect(String(adv.body.data.advanceNo)).toMatch(/^ADV-/);

    // 4. Duplicate open advance is blocked.
    const dup = await api.post(`/api/ops/hr/employees/${employeeId}/advances`).set(auth(token)).send({
      amount: 200000,
    });
    expect(dup.status).toBe(400);
    expect(String(dup.body.error.message)).toMatch(/outstanding salary advance/i);

    // 5. Loan created as PENDING (approval required before it can be deducted).
    const loan = await api.post(`/api/ops/hr/employees/${employeeId}/loans`).set(auth(token)).send({
      amount: 500000,
      monthlyDeduction: 500000,
      tenureMonths: 1,
      reason: 'Furniture',
    });
    expect(loan.status).toBe(200);
    const loanId = Number(loan.body.data.loanId);
    expect(loan.body.data.status).toBe('PENDING');
    expect(String(loan.body.data.loanNo)).toMatch(/^LN-/);

    // 6. RBAC: an accountant without loan-approval rights is denied.
    const { token: gina } = await loginAs('gina.fin');
    const denied = await api.post(`/api/ops/hr/loans/${loanId}/approve`).set(auth(gina)).send({});
    expect(denied.status).toBe(403);
    expect(String(denied.body.error.message)).toMatch(/Missing permission/i);

    // 7. Payroll manager (holds hr.loans.approve + hr.advances.approve) approves both.
    const { token: manager } = await loginAs('pay.manager');
    const approvedLoan = await api.post(`/api/ops/hr/loans/${loanId}/approve`).set(auth(manager)).send({});
    expect(approvedLoan.status).toBe(200);
    expect(approvedLoan.body.data.status).toBe('ACTIVE');
    const approvedAdv = await api.post(`/api/ops/hr/advances/${advanceId}/approve`).set(auth(manager)).send({});
    expect(approvedAdv.status).toBe(200);
    expect(approvedAdv.body.data.status).toBe('ACTIVE');

    // 8. Group-scoped single-day payroll run inside FY2026-P12.
    const run = await api.post('/api/ops/hr/payrolls').set(auth(token)).send({
      periodStart: '2027-06-07',
      periodEnd: '2027-06-07',
      payrollGroupId: groupId,
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);

    // 9. Calculation engine deducts the approved loan and advance.
    const detail = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(token));
    expect(detail.status).toBe(200);
    const items = detail.body.data.items as {
      employeeId: string;
      grossPay: string;
      paye: string;
      nssf: string;
      loans: string;
      advances: string;
      netPay: string;
    }[];
    const mine = items.find((i) => Number(i.employeeId) === employeeId);
    expect(mine).toBeTruthy();
    expect(Number(mine!.grossPay)).toBe(3000000);
    expect(Number(mine!.paye)).toBe(802000);
    expect(Number(mine!.nssf)).toBe(150000);
    expect(Number(mine!.loans)).toBe(500000);
    expect(Number(mine!.advances)).toBe(300000);
    // 3,000,000 - 802,000 - 150,000 - 500,000 - 300,000 = 1,248,000
    expect(Number(mine!.netPay)).toBe(1248000);

    // 10. Posting settles the balances and writes repayment records.
    await db(`UPDATE payrolls SET status = 'APPROVED' WHERE id = $1`, [payrollId]);
    const { token: admin } = await loginAs('admin');
    const posted = await api.post(`/api/ops/hr/payrolls/${payrollId}/post`).set(auth(admin)).send({});
    expect(posted.status).toBe(200);
    const journalId = Number(posted.body.data.journalId);
    expect(journalId).toBeGreaterThan(0);

    const loanRow = await db(`SELECT balance, outstanding_balance, status, period_code FROM employee_loans WHERE id = $1`, [loanId]);
    expect(Number(loanRow.rows[0].balance)).toBe(0);
    expect(Number(loanRow.rows[0].outstanding_balance)).toBe(0);
    expect(loanRow.rows[0].status).toBe('PAID');
    expect(loanRow.rows[0].period_code).toBe('2027-06');

    const advRow = await db(`SELECT outstanding_balance, status, period_code FROM salary_advances WHERE id = $1`, [advanceId]);
    expect(Number(advRow.rows[0].outstanding_balance)).toBe(0);
    expect(advRow.rows[0].status).toBe('PAID');
    expect(advRow.rows[0].period_code).toBe('2027-06');

    const loanReps = await db(`SELECT amount, period_code FROM loan_repayments WHERE loan_id = $1`, [loanId]);
    expect(loanReps.rows).toHaveLength(1);
    expect(Number(loanReps.rows[0].amount)).toBe(500000);
    expect(loanReps.rows[0].period_code).toBe('2027-06');

    const advReps = await db(`SELECT amount FROM advance_repayments WHERE advance_id = $1`, [advanceId]);
    expect(advReps.rows).toHaveLength(1);
    expect(Number(advReps.rows[0].amount)).toBe(300000);

    // 11. Loan/advance detail exposes the repayment history.
    const loanDetail = await api.get(`/api/ops/hr/loans/${loanId}`).set(auth(admin));
    expect(loanDetail.status).toBe(200);
    expect(loanDetail.body.data.loan.status).toBe('PAID');
    expect(loanDetail.body.data.repayments).toHaveLength(1);

    const advDetail = await api.get(`/api/ops/hr/advances/${advanceId}`).set(auth(admin));
    expect(advDetail.status).toBe(200);
    expect(advDetail.body.data.advance.status).toBe('PAID');
    expect(advDetail.body.data.repayments).toHaveLength(1);

    // 12. List endpoints are tenant/company-scoped and filterable.
    const loans = await api.get(`/api/ops/hr/loans?employeeId=${employeeId}`).set(auth(admin));
    expect(loans.status).toBe(200);
    expect(loans.body.data.total).toBeGreaterThanOrEqual(1);
    const advances = await api.get(`/api/ops/hr/advances?status=PAID`).set(auth(admin));
    expect(advances.status).toBe(200);
    expect(advances.body.data.total).toBeGreaterThanOrEqual(1);

    // Self-clean in FK order so re-runs never collide.
    await db(`DELETE FROM journal_entries WHERE id = $1`, [journalId]);
    await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
    await db(`DELETE FROM employee_loans WHERE employee_id = $1`, [employeeId]);
    await deleteEmployees([employeeId]);
    await db(`DELETE FROM employee_payroll_profiles WHERE payroll_group_id = $1`, [groupId]);
    await db(`DELETE FROM payroll_groups WHERE id = $1`, [groupId]);
  }, 30_000);
});
