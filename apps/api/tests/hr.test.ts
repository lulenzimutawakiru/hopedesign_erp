import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, db, deleteEmployees, findPendingTask } from './helpers.js';

describe('HR and payroll', () => {
  it('calculates Uganda PAYE and NSSF, then posts a balanced payroll journal', async () => {
    const { token } = await loginAs('hr.hannah');
    const senior = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Peter',
      lastName: 'Mugisha',
      position: 'Production Manager',
      baseSalary: 3000000,
    });
    expect(senior.status).toBe(200);
    const junior = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Asha',
      lastName: 'Namutebi',
      position: 'Clerk',
      baseSalary: 200000,
    });
    expect(junior.status).toBe(200);
    const seniorId = Number(senior.body.data.employeeId);
    const juniorId = Number(junior.body.data.employeeId);

    const loan = await api.post(`/api/ops/hr/employees/${senior.body.data.employeeId}/loans`).set(auth(token)).send({
      amount: 400000,
      monthlyDeduction: 100000,
    });
    expect(loan.status).toBe(200);
    const approvedLoan = await api.post(`/api/ops/hr/loans/${loan.body.data.loanId}/approve`).set(auth(token)).send({});
    expect(approvedLoan.status).toBe(200);

    const day = String(10 + Math.floor(Math.random() * 18)).padStart(2, '0');
    const run = await api.post('/api/ops/hr/payrolls').set(auth(token)).send({
      periodStart: `2027-03-${day}`,
      periodEnd: `2027-03-${day}`,
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);

    const detail = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(token));
    expect(detail.status).toBe(200);
    const items = detail.body.data.items as { employeeId: string; paye: string; nssf: string; loans: string; netPay: string; grossPay: string }[];
    // Match by employeeId (not name) so leftovers from earlier failed runs can never be picked up.
    const peter = items.find((i) => Number(i.employeeId) === seniorId);
    const asha = items.find((i) => Number(i.employeeId) === juniorId);
    expect(peter && asha).toBeTruthy();
    expect(Number(peter!.paye)).toBe(743250);
    expect(Number(peter!.nssf)).toBe(150000);
    expect(Number(peter!.loans)).toBe(100000);
    expect(Number(peter!.netPay)).toBe(2006750);
    expect(Number(asha!.paye)).toBe(0);
    expect(Number(asha!.nssf)).toBe(10000);
    expect(Number(asha!.netPay)).toBe(190000);

    await db(`UPDATE payrolls SET status = 'APPROVED' WHERE id = $1`, [payrollId]);

    const { token: admin } = await loginAs('admin');
    const posted = await api.post(`/api/ops/hr/payrolls/${payrollId}/post`).set(auth(admin)).send({});
    expect(posted.status).toBe(200);
    expect(Number(posted.body.data.journalId)).toBeGreaterThan(0);

    const after = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(admin));
    expect(after.body.data.payroll.glPosted).toBe(true);
    expect(after.body.data.payroll.status).toBe('RELEASED');

    const loanRow = await db(`SELECT balance, status FROM employee_loans WHERE id = $1`, [loan.body.data.loanId]);
    expect(Number(loanRow.rows[0].balance)).toBe(300000);

    const tb = await api.get('/api/ops/finance/trial-balance').set(auth(admin));
    expect(tb.status).toBe(200);
    expect(Math.round(Number(tb.body.data.totals.debit) * 100)).toBe(Math.round(Number(tb.body.data.totals.credit) * 100));

    // Self-clean so re-runs never collide with the single-day period overlap guard.
    await db(`DELETE FROM journal_entries WHERE id = $1`, [Number(posted.body.data.journalId)]);
    await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
    await db(`DELETE FROM employee_loans WHERE employee_id IN ($1,$2)`, [seniorId, juniorId]);
    await deleteEmployees([seniorId, juniorId]);
  }, 30_000);

  it('creates, calculates, approves and posts an off-cycle bonus run', async () => {
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Bonus',
      lastName: 'OffCycle',
      position: 'Clerk',
      baseSalary: 3000000,
      bankName: 'Stanbic',
      bankAccountNo: '0987654321',
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);

    const loan = await api.post(`/api/ops/hr/employees/${employeeId}/loans`).set(auth(token)).send({
      amount: 400000,
      monthlyDeduction: 100000,
    });
    expect(loan.status).toBe(200);
    const approvedLoan = await api.post(`/api/ops/hr/loans/${loan.body.data.loanId}/approve`).set(auth(token)).send({});
    expect(approvedLoan.status).toBe(200);

    const created = await api.post('/api/ops/hr/off-cycle').set(auth(token)).send({
      periodStart: '2027-04-20',
      periodEnd: '2027-04-20',
      offCycleType: 'BONUS',
      reason: 'Q1 performance bonus',
      employeeIds: [employeeId],
      extraEarnings: 500000,
      extraDeductions: 50000,
      deductLoans: true,
      paymentDate: '2027-04-21',
    });
    expect(created.status).toBe(200);
    const payrollId = Number(created.body.data.payrollId);
    expect(payrollId).toBeGreaterThan(0);
    expect(String(created.body.data.payrollNo)).toMatch(/^PAY-/);

    const list = await api.get('/api/ops/hr/off-cycle').set(auth(token));
    expect(list.status).toBe(200);
    const found = (list.body.data as { id: number; offCycleType: string; employeeCount: number }[]).find(
      (r) => Number(r.id) === payrollId
    );
    expect(found).toBeTruthy();
    expect(found!.offCycleType).toBe('BONUS');
    expect(found!.employeeCount).toBe(1);

    const recalc = await api.post(`/api/ops/hr/off-cycle/${payrollId}/calculate`).set(auth(token)).send({});
    expect(recalc.status).toBe(200);

    const detail = await api.get(`/api/ops/hr/off-cycle/${payrollId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.payroll.runType).toBe('OFF_CYCLE');
    expect(detail.body.data.payroll.offCycleType).toBe('BONUS');
    expect(String(detail.body.data.payroll.reason)).toContain('bonus');
    expect(Number(detail.body.data.payroll.extraEarnings)).toBe(500000);
    expect(Number(detail.body.data.payroll.extraDeductions)).toBe(50000);
    const items = detail.body.data.items as {
      employeeId: string; grossPay: string; paye: string; nssf: string;
      loans: string; otherDeductions: string; netPay: string; employerNssf: string;
    }[];
    const bonus = items.find((i) => Number(i.employeeId) === employeeId);
    expect(bonus).toBeTruthy();
    // Basic 3,000,000 + extra earnings 500,000
    expect(Number(bonus!.grossPay)).toBe(3500000);
    // PAYE on 3,325,000 (3.5m minus 175k NSSF): 20% on 335k-410k + 25% on
    // 410k-485k + 30% on 485k-3,325,000 = 885,750.
    expect(Number(bonus!.paye)).toBe(885750);
    expect(Number(bonus!.nssf)).toBe(175000);
    expect(Number(bonus!.employerNssf)).toBe(350000);
    expect(Number(bonus!.loans)).toBe(100000);
    expect(Number(bonus!.otherDeductions)).toBe(50000);
    // 3,500,000 - 885,750 - 175,000 - 100,000 - 50,000 = 2,289,250
    expect(Number(bonus!.netPay)).toBe(2289250);

    await db(`UPDATE payrolls SET status = 'APPROVED' WHERE id = $1`, [payrollId]);

    const { token: admin } = await loginAs('admin');
    const posted = await api.post(`/api/ops/hr/off-cycle/${payrollId}/post`).set(auth(admin)).send({});
    expect(posted.status).toBe(200);
    expect(Number(posted.body.data.journalId)).toBeGreaterThan(0);

    const after = await api.get(`/api/ops/hr/off-cycle/${payrollId}`).set(auth(admin));
    expect(after.body.data.payroll.glPosted).toBe(true);
    expect(after.body.data.payroll.status).toBe('RELEASED');

    // Loan balance reduces only after the run posts.
    const loanRow = await db(`SELECT balance, status FROM employee_loans WHERE id = $1`, [loan.body.data.loanId]);
    expect(Number(loanRow.rows[0].balance)).toBe(300000);

    // Self-clean so re-runs never collide.
    await db(`DELETE FROM journal_entries WHERE id = $1`, [Number(posted.body.data.journalId)]);
    await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
    await db(`DELETE FROM employee_loans WHERE employee_id = $1`, [employeeId]);
    await deleteEmployees([employeeId]);
  }, 30_000);

  it('creates, approves and pays payroll arrears through an off-cycle run', async () => {
    const { token } = await loginAs('hr.hannah');
    const { token: manager } = await loginAs('pay.manager');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Arrears',
      lastName: 'Tester',
      position: 'Clerk',
      baseSalary: 3000000,
      bankName: 'Stanbic',
      bankAccountNo: '1122334455',
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);

    // 1. Create arrears for a retroactive salary review: 3,000,000 -> 3,500,000.
    const created = await api.post('/api/ops/hr/arrears').set(auth(token)).send({
      employeeId,
      originalPay: 3000000,
      correctPay: 3500000,
      fromPeriodStart: '2027-04-01',
      toPeriodEnd: '2027-04-30',
      reason: 'Salary review retroactive to April',
    });
    expect(created.status).toBe(200);
    expect(Number(created.body.data.difference)).toBe(500000);
    // PAYE delta: 938,250 on 3.5m minus 788,250 on 3.0m (both in the 30% band).
    expect(Number(created.body.data.taxImpact)).toBe(150000);
    expect(Number(created.body.data.netArrears)).toBe(350000);
    expect(created.body.data.status).toBe('PENDING');
    const arrearsId = Number(created.body.data.arrearsId);

    // Duplicate protection for the same employee, period and amounts.
    const dup = await api.post('/api/ops/hr/arrears').set(auth(token)).send({
      employeeId,
      originalPay: 3000000,
      correctPay: 3500000,
      fromPeriodStart: '2027-04-01',
      toPeriodEnd: '2027-04-30',
    });
    expect(dup.status).toBe(400);

    // The list endpoint shows PENDING records.
    const list = await api.get('/api/ops/hr/arrears?status=PENDING').set(auth(token));
    expect(list.status).toBe(200);
    expect(
      (list.body.data as { id: number; netArrears: string }[]).some(
        (r) => Number(r.id) === arrearsId && Number(r.netArrears) === 350000
      )
    ).toBe(true);

    // Rejected arrears must never be paid.
    const second = await api.post('/api/ops/hr/arrears').set(auth(token)).send({
      employeeId,
      originalPay: 3000000,
      correctPay: 3600000,
      fromPeriodStart: '2027-04-01',
      toPeriodEnd: '2027-04-30',
      reason: 'Rejected scenario',
    });
    expect(second.status).toBe(200);
    const secondId = Number(second.body.data.arrearsId);
    const rejected = await api.post(`/api/ops/hr/arrears/${secondId}/reject`).set(auth(manager)).send({});
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('REJECTED');

    // 2. Approve the real arrears so payroll may include them.
    const approved = await api.post(`/api/ops/hr/arrears/${arrearsId}/approve`).set(auth(manager)).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');

    // 3. An ARREARS off-cycle run auto-loads approved net arrears (no extraEarnings passed).
    const run = await api.post('/api/ops/hr/off-cycle').set(auth(token)).send({
      periodStart: '2027-05-20',
      periodEnd: '2027-05-20',
      offCycleType: 'ARREARS',
      reason: 'April salary review arrears',
      employeeIds: [employeeId],
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);
    expect(payrollId).toBeGreaterThan(0);

    const detail = await api.get(`/api/ops/hr/off-cycle/${payrollId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.payroll.offCycleType).toBe('ARREARS');
    expect(Number(detail.body.data.payroll.extraEarnings)).toBe(350000);
    const items = detail.body.data.items as {
      employeeId: string; grossPay: string; paye: string; nssf: string;
      loans: string; otherDeductions: string; netPay: string;
    }[];
    const ar = items.find((i) => Number(i.employeeId) === employeeId);
    expect(ar).toBeTruthy();
    // Basic 3,000,000 + net arrears 350,000.
    expect(Number(ar!.grossPay)).toBe(3350000);
    // PAYE on 3,182,500 (3.35m minus 167,500 NSSF): 20% on 335k-410k + 25% on
    // 410k-485k + 30% on 485k-3,182,500 = 843,000.
    expect(Number(ar!.paye)).toBe(843000);
    expect(Number(ar!.nssf)).toBe(167500);
    expect(Number(ar!.loans)).toBe(0);
    // 3,350,000 - 843,000 - 167,500 = 2,339,500.
    expect(Number(ar!.netPay)).toBe(2339500);

    // 4. Posting the run closes the linked arrears and keeps rejected ones unpaid.
    await db(`UPDATE payrolls SET status = 'APPROVED' WHERE id = $1`, [payrollId]);
    const posted = await api.post(`/api/ops/hr/off-cycle/${payrollId}/post`).set(auth(manager)).send({});
    expect(posted.status).toBe(200);
    expect(Number(posted.body.data.journalId)).toBeGreaterThan(0);

    const arrearsRow = await db(`SELECT status, payroll_id FROM payroll_arrears WHERE id = $1`, [arrearsId]);
    expect(String(arrearsRow.rows[0].status)).toBe('CLOSED');
    expect(Number(arrearsRow.rows[0].payroll_id)).toBe(payrollId);
    const rejectedRow = await db(`SELECT status, payroll_id FROM payroll_arrears WHERE id = $1`, [secondId]);
    expect(String(rejectedRow.rows[0].status)).toBe('REJECTED');
    expect(rejectedRow.rows[0].payroll_id).toBeNull();

    // Self-clean so re-runs never collide.
    await db(`DELETE FROM journal_entries WHERE id = $1`, [Number(posted.body.data.journalId)]);
    await db(`DELETE FROM payroll_arrears WHERE employee_id = $1`, [employeeId]);
    await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
    await deleteEmployees([employeeId]);
  }, 30_000);

  it('flags employees without a salary and blocks submission until resolved', async () => {
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'NoSal',
      lastName: 'Salary',
      position: 'Clerk',
      baseSalary: 0,
      bankName: 'Stanbic',
      bankAccountNo: '555000111',
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);

    const day = String(10 + Math.floor(Math.random() * 18)).padStart(2, '0');
    const run = await api.post('/api/ops/hr/payrolls').set(auth(token)).send({
      periodStart: `2027-06-${day}`,
      periodEnd: `2027-06-${day}`,
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);

    // The run is calculated and validated at creation, so the no-salary
    // employee surfaces as an ERROR exception with a reduced readiness score.
    const detail = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(token));
    expect(detail.status).toBe(200);
    const exceptions = detail.body.data.exceptions as { exceptionType: string; severity: string; employeeId: string; status: string }[];
    const noSalary = exceptions.find((x) => x.exceptionType === 'NO_SALARY' && Number(x.employeeId) === employeeId);
    expect(noSalary).toBeTruthy();
    expect(noSalary!.severity).toBe('ERROR');
    expect(noSalary!.status).toBe('OPEN');
    expect(Number(detail.body.data.payroll.validationScore)).toBeLessThan(100);

    // Submission is blocked while an ERROR exception is open.
    const blocked = await api.post(`/api/ops/hr/payrolls/${payrollId}/submit`).set(auth(token)).send({});
    expect(blocked.status).toBe(400);

    // Fix the salary, recalculate: the exception clears and submission passes.
    await db(`UPDATE employees SET base_salary = 500000 WHERE id = $1`, [employeeId]);
    const recalc = await api.post(`/api/ops/hr/payrolls/${payrollId}/calculate`).set(auth(token)).send({});
    expect(recalc.status).toBe(200);

    const after = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(token));
    const openErrors = (after.body.data.exceptions as { severity: string; status: string }[])
      .filter((x) => x.severity === 'ERROR' && x.status === 'OPEN');
    expect(openErrors.length).toBe(0);

    const ok = await api.post(`/api/ops/hr/payrolls/${payrollId}/submit`).set(auth(token)).send({});
    expect(ok.status).toBe(200);

    await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
    await deleteEmployees([employeeId]);
  }, 30_000);

  it('flags terminated employees selected in off-cycle runs', async () => {
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Term',
      lastName: 'Check',
      position: 'Clerk',
      baseSalary: 3000000,
      bankName: 'Stanbic',
      bankAccountNo: '666000222',
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);
    await db(`UPDATE employees SET status = 'TERMINATED', termination_date = '2027-05-01' WHERE id = $1`, [employeeId]);

    const run = await api.post('/api/ops/hr/off-cycle').set(auth(token)).send({
      periodStart: '2027-06-15',
      periodEnd: '2027-06-15',
      offCycleType: 'TERMINATION',
      reason: 'Final payment',
      employeeIds: [employeeId],
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);

    const detail = await api.get(`/api/ops/hr/off-cycle/${payrollId}`).set(auth(token));
    const exceptions = detail.body.data.exceptions as { exceptionType: string; severity: string; employeeId: string }[];
    const term = exceptions.find((x) => x.exceptionType === 'TERMINATED_INCLUDED' && Number(x.employeeId) === employeeId);
    expect(term).toBeTruthy();
    expect(term!.severity).toBe('ERROR');

    const blocked = await api.post(`/api/ops/hr/off-cycle/${payrollId}/submit`).set(auth(token)).send({});
    expect(blocked.status).toBe(400);

    await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
    await deleteEmployees([employeeId]);
  }, 30_000);

  it('takes leave through submit and approve', async () => {
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Leave',
      lastName: 'Tester',
      baseSalary: 800000,
    });
    const leave = await api.post('/api/ops/hr/leave').set(auth(token)).send({
      employeeId: emp.body.data.employeeId,
      leaveType: 'ANNUAL',
      startDate: '2026-09-01',
      endDate: '2026-09-05',
      reason: 'Family',
    });
    expect(leave.status).toBe(200);
    expect(Number(leave.body.data.days)).toBe(5);

    const ok = await api.post(`/api/ops/hr/leave/${leave.body.data.leaveId}/approve`).set(auth(token)).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('APPROVED');

    await db(`DELETE FROM leave_requests WHERE employee_id = $1`, [Number(emp.body.data.employeeId)]);
    await deleteEmployees([Number(emp.body.data.employeeId)]);
  }, 20_000);

  it('exposes the people board and clocks attendance', async () => {
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Board',
      lastName: 'Tester',
      baseSalary: 500000,
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);

    const board = await api.get('/api/ops/hr/board').set(auth(token));
    expect(board.status).toBe(200);
    expect(board.body.data.kpis).toBeTruthy();
    expect(Number(board.body.data.kpis.headcount)).toBeGreaterThan(0);

    const inn = await api.post(`/api/ops/hr/employees/${employeeId}/clock-in`).set(auth(token)).send({});
    expect([200, 400]).toContain(inn.status);
    const att = await api.get('/api/ops/hr/attendance').set(auth(token));
    expect(att.status).toBe(200);
    expect(Array.isArray(att.body.data.rows)).toBe(true);

    await db(`DELETE FROM attendance WHERE employee_id = $1`, [employeeId]);
    await deleteEmployees([employeeId]);
  });

  it('prepares, submits, approves and pays a final settlement', async () => {
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Final',
      lastName: 'Settlement',
      position: 'Clerk',
      baseSalary: 3000000,
      hireDate: '2026-01-01',
      bankName: 'Stanbic',
      bankAccountNo: '1234567890',
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);

    const term = await api
      .post(`/api/ops/hr/employees/${employeeId}/terminate`)
      .set(auth(token))
      .send({ terminationDate: '2026-08-15' });
    expect(term.status).toBe(200);

    const prep = await api
      .post(`/api/ops/hr/employees/${employeeId}/final-settlement`)
      .set(auth(token))
      .send({});
    expect(prep.status).toBe(200);
    expect(prep.body.data.status).toBe('DRAFT');
    expect(Number(prep.body.data.salaryDue)).toBe(1500000);
    expect(Number(prep.body.data.netPayable)).toBe(1500000);
    const settlementId = Number(prep.body.data.finalSettlementId);

    const sub = await api
      .post(`/api/ops/hr/final-settlements/${settlementId}/submit`)
      .set(auth(token))
      .send({});
    expect(sub.status).toBe(200);
    let status = String(sub.body.data.status);
    if (status !== 'APPROVED') {
      // A workflow may exist for final settlements; decide the first task as admin.
      const { token: adminToken } = await loginAs('admin');
      const taskId = await findPendingTask(adminToken, 'hr.final_settlements', settlementId, 1);
      expect(taskId).toBeTruthy();
      const decided = await api
        .post(`/api/approvals/${taskId}/decide`)
        .set(auth(adminToken))
        .send({ decision: 'APPROVED' });
      expect(decided.status).toBe(200);
      status = 'APPROVED';
    }
    expect(status).toBe('APPROVED');

    const { token: admin } = await loginAs('admin');
    const paid = await api
      .post(`/api/ops/hr/final-settlements/${settlementId}/pay`)
      .set(auth(admin))
      .send({ paymentMethod: 'BANK_TRANSFER' });
    expect(paid.status).toBe(200);
    expect(paid.body.data.status).toBe('PAID');
    const batchId = Number(paid.body.data.batchId);
    expect(batchId).toBeGreaterThan(0);

    const batch = await db(`SELECT batch_type, total_amount FROM payment_batches WHERE id = $1`, [batchId]);
    expect(String(batch.rows[0].batch_type)).toBe('FINAL');
    expect(Number(batch.rows[0].total_amount)).toBe(1500000);

    await db(`DELETE FROM payment_batches WHERE id = $1`, [batchId]);
    await db(`DELETE FROM final_settlements WHERE employee_id = $1`, [employeeId]);
    await deleteEmployees([employeeId]);
  }, 30_000);

  it('scopes a payroll run to a payroll group and flags employees paid outside it', async () => {
    const { token } = await loginAs('hr.hannah');
    const companyId = Number((await db(`SELECT id FROM companies WHERE code = 'HDG'`)).rows[0].id);
    const tenantId = Number((await db(`SELECT id FROM tenants WHERE code = 'HDG'`)).rows[0].id);

    const grouped = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Grouped',
      lastName: 'Worker',
      position: 'Clerk',
      baseSalary: 1000000,
      bankName: 'Stanbic',
      bankAccountNo: '1111111111',
      tin: '1234567890',
    });
    const ungrouped = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Ungrouped',
      lastName: 'Worker',
      position: 'Clerk',
      baseSalary: 1000000,
      bankName: 'Stanbic',
      bankAccountNo: '2222222222',
      tin: '1234567891',
    });
    expect(grouped.status).toBe(200);
    expect(ungrouped.status).toBe(200);
    const groupedId = Number(grouped.body.data.employeeId);
    const ungroupedId = Number(ungrouped.body.data.employeeId);

    const group = await db(
      `INSERT INTO payroll_groups (company_id, tenant_id, code, name, frequency, salary_currency, default_payment_method, status)
       VALUES ($1,$2,$3,'Test Monthly Staff','MONTHLY','UGX','BANK_TRANSFER','ACTIVE') RETURNING id`,
      [companyId, tenantId, `TEST-MONTHLY-${Date.now()}`]
    );
    const groupId = Number(group.rows[0].id);
    await db(
      `INSERT INTO employee_payroll_profiles (company_id, tenant_id, employee_id, payroll_group_id, payment_method, status)
       VALUES ($1,$2,$3,$4,'BANK_TRANSFER','ACTIVE')`,
      [companyId, tenantId, groupedId, groupId]
    );

    const day = String(10 + Math.floor(Math.random() * 18)).padStart(2, '0');
    const run = await api.post('/api/ops/hr/payrolls').set(auth(token)).send({
      periodStart: `2027-05-${day}`,
      periodEnd: `2027-05-${day}`,
      payrollGroupId: groupId,
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);
    const detail = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(Number(detail.body.data.payroll.payrollGroupId)).toBe(groupId);
    const items = detail.body.data.items as { employeeId: string }[];
    expect(items.some((i) => Number(i.employeeId) === groupedId)).toBe(true);
    expect(items.some((i) => Number(i.employeeId) === ungroupedId)).toBe(false);
    const exceptions = detail.body.data.exceptions as { employeeId: string | null; exceptionType: string }[];
    const outside = exceptions.find(
      (x) => x.exceptionType === 'PAID_OUTSIDE_PAYROLL_GROUP' && Number(x.employeeId) === ungroupedId
    );
    expect(outside).toBeTruthy();
    expect(exceptions.some(
      (x) => x.exceptionType === 'PAID_OUTSIDE_PAYROLL_GROUP' && Number(x.employeeId) === groupedId
    )).toBe(false);
    expect(Number(detail.body.data.payroll.validationScore)).toBeLessThan(100);

    // An open ERROR blocks submission until the profile is corrected.
    const blocked = await api.post(`/api/ops/hr/payrolls/${payrollId}/submit`).set(auth(token)).send({});
    expect(blocked.status).toBe(400);

    // Assigning the employee to the group and recalculating clears the exception.
    await db(
      `INSERT INTO employee_payroll_profiles (company_id, tenant_id, employee_id, payroll_group_id, payment_method, status)
       VALUES ($1,$2,$3,$4,'BANK_TRANSFER','ACTIVE')`,
      [companyId, tenantId, ungroupedId, groupId]
    );
    const recalc = await api.post(`/api/ops/hr/payrolls/${payrollId}/calculate`).set(auth(token)).send({});
    expect(recalc.status).toBe(200);
    const after = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(token));
    const afterItems = after.body.data.items as { employeeId: string }[];
    const afterExceptions = after.body.data.exceptions as { employeeId: string | null; exceptionType: string }[];
    expect(afterItems.some((i) => Number(i.employeeId) === ungroupedId)).toBe(true);
    expect(afterExceptions.some(
      (x) => x.exceptionType === 'PAID_OUTSIDE_PAYROLL_GROUP' && Number(x.employeeId) === ungroupedId
    )).toBe(false);
    expect(afterExceptions.some(
      (x) => x.exceptionType === 'PAID_OUTSIDE_PAYROLL_GROUP' && Number(x.employeeId) === groupedId
    )).toBe(false);

    // Company-wide runs (no group) never raise the group check.
    const day2 = String(10 + Math.floor(Math.random() * 18)).padStart(2, '0');
    const wide = await api.post('/api/ops/hr/payrolls').set(auth(token)).send({
      periodStart: `2027-06-${day2}`,
      periodEnd: `2027-06-${day2}`,
    });
    expect(wide.status).toBe(200);
    const wideId = Number(wide.body.data.payrollId);
    const wideDetail = await api.get(`/api/ops/hr/payrolls/${wideId}`).set(auth(token));
    const wideExceptions = wideDetail.body.data.exceptions as { exceptionType: string }[];
    expect(wideExceptions.some((x) => x.exceptionType === 'PAID_OUTSIDE_PAYROLL_GROUP')).toBe(false);

    // Self-clean so re-runs never collide with the period overlap guard.
    await db(`DELETE FROM payrolls WHERE id IN ($1,$2)`, [payrollId, wideId]);
    await db(`DELETE FROM employee_payroll_profiles WHERE employee_id IN ($1,$2)`, [groupedId, ungroupedId]);
    await db(`DELETE FROM payroll_groups WHERE id = $1`, [groupId]);
    await deleteEmployees([groupedId, ungroupedId]);
  }, 30_000);

  it('surfaces exceptions in the cross-run centre and lets reviewers resolve them', async () => {
    const { token } = await loginAs('hr.hannah');
    const companyId = Number((await db(`SELECT id FROM companies WHERE code = 'HDG'`)).rows[0].id);
    const tenantId = Number((await db(`SELECT id FROM tenants WHERE code = 'HDG'`)).rows[0].id);

    // Employee A has no salary (ERROR); Employee B has a salary but no bank
    // account or TIN (two WARNINGs). Both are created with unique names so
    // leftovers from an earlier failed run can never be picked up.
    const noSalary = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Edgar',
      lastName: `NoSalary${Date.now()}`,
      position: 'Clerk',
      baseSalary: 0,
      bankName: 'Stanbic',
      bankAccountNo: '3333333333',
      tin: '1234567892',
    });
    const noBank = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Faith',
      lastName: `NoBank${Date.now()}`,
      position: 'Clerk',
      baseSalary: 1000000,
    });
    expect(noSalary.status).toBe(200);
    expect(noBank.status).toBe(200);
    const empANoSalary = Number(noSalary.body.data.employeeId);
    const empBNoBank = Number(noBank.body.data.employeeId);

    const day = String(10 + Math.floor(Math.random() * 18)).padStart(2, '0');
    const run = await api.post('/api/ops/hr/payrolls').set(auth(token)).send({
      periodStart: `2027-08-${day}`,
      periodEnd: `2027-08-${day}`,
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);

    type CentreRow = {
      id: string;
      employeeId: string | null;
      exceptionType: string;
      severity: string;
      status: string;
      payrollNo: string;
      resolvedAt: string | null;
    };
    const centre = await api.get('/api/ops/hr/exceptions?pageSize=100').set(auth(token));
    expect(centre.status).toBe(200);
    const rows = centre.body.data.rows as CentreRow[];
    const noSalaryRow = rows.find((r) => r.exceptionType === 'NO_SALARY' && Number(r.employeeId) === empANoSalary);
    const noBankRow = rows.find((r) => r.exceptionType === 'MISSING_BANK_ACCOUNT' && Number(r.employeeId) === empBNoBank);
    expect(noSalaryRow).toBeTruthy();
    expect(noBankRow).toBeTruthy();
    expect(noSalaryRow!.status).toBe('OPEN');
    expect(noBankRow!.status).toBe('OPEN');
    expect(Number(centre.body.data.summary.openErrors)).toBeGreaterThanOrEqual(1);
    expect(Number(centre.body.data.summary.openWarnings)).toBeGreaterThanOrEqual(1);
    expect(centre.body.data.topTypes.length).toBeGreaterThan(0);
    expect(rows.every((r) => Number(r.id) > 0 && r.payrollNo)).toBe(true);

    const onlyErrors = await api.get('/api/ops/hr/exceptions?pageSize=100&severity=ERROR').set(auth(token));
    expect(onlyErrors.status).toBe(200);
    const errorRows = onlyErrors.body.data.rows as { severity: string }[];
    expect(errorRows.length).toBeGreaterThan(0);
    expect(errorRows.every((r) => r.severity === 'ERROR')).toBe(true);

    const searched = await api
      .get(`/api/ops/hr/exceptions?pageSize=100&q=${encodeURIComponent('NoBank')}`)
      .set(auth(token));
    expect(searched.status).toBe(200);
    const searchedRows = searched.body.data.rows as { exceptionType: string; employeeId: string | null }[];
    expect(searchedRows.some((r) => r.exceptionType === 'MISSING_BANK_ACCOUNT' && Number(r.employeeId) === empBNoBank)).toBe(true);

    // Four-eyes: the officer who prepared the run cannot resolve its
    // exceptions (SoD blocks create + approve); a payroll manager must act.
    const creatorResolve = await api
      .post(`/api/ops/hr/exceptions/${noBankRow!.id}/resolve`)
      .set(auth(token))
      .send({ status: 'RESOLVED', note: 'Bank details added' });
    expect(creatorResolve.status).toBe(403);

    const { token: manager } = await loginAs('pay.manager');
    const resolve = await api
      .post(`/api/ops/hr/exceptions/${noBankRow!.id}/resolve`)
      .set(auth(manager))
      .send({ status: 'RESOLVED', note: 'Bank details added' });
    expect(resolve.status).toBe(200);
    expect(resolve.body.data.status).toBe('RESOLVED');
    expect(resolve.body.data.resolvedAt).toBeTruthy();
    expect(resolve.body.data.validation).toBeTruthy();

    const again = await api.get('/api/ops/hr/exceptions?pageSize=100').set(auth(manager));
    const resolvedRow = (again.body.data.rows as CentreRow[]).find((r) => r.id === noBankRow!.id);
    expect(resolvedRow).toBeTruthy();
    expect(resolvedRow!.status).toBe('RESOLVED');
    expect(resolvedRow!.resolvedAt).toBeTruthy();

    // Errors can be resolved too, and re-resolving the same item is rejected.
    const resolveError = await api
      .post(`/api/ops/hr/exceptions/${noSalaryRow!.id}/resolve`)
      .set(auth(manager))
      .send({ status: 'RESOLVED' });
    expect(resolveError.status).toBe(200);
    const dup = await api
      .post(`/api/ops/hr/exceptions/${noSalaryRow!.id}/resolve`)
      .set(auth(manager))
      .send({ status: 'RESOLVED' });
    expect(dup.status).toBe(400);

    // Cross-tenant isolation: an exception owned by another tenant + company
    // must never surface in the HDG centre.
    const foreignTenant = await db(
      `INSERT INTO tenants (code, name) VALUES ($1, 'Isolation Tenant') RETURNING id`,
      [`T-ISO-${Date.now()}`]
    );
    const foreignTenantId = Number(foreignTenant.rows[0].id);
    const foreignCompany = await db(
      `INSERT INTO companies (tenant_id, code, name) VALUES ($1, $2, 'Isolation Co') RETURNING id`,
      [foreignTenantId, `C-ISO-${Date.now()}`]
    );
    const foreignCompanyId = Number(foreignCompany.rows[0].id);
    const foreignPayroll = await db(
      `INSERT INTO payrolls (company_id, tenant_id, payroll_no, period_start, period_end, status)
       VALUES ($1, $2, $3, '2027-08-01', '2027-08-01', 'DRAFT') RETURNING id`,
      [foreignCompanyId, foreignTenantId, `PR-ISO-${Date.now()}`]
    );
    const foreignPayrollId = Number(foreignPayroll.rows[0].id);
    await db(
      `INSERT INTO payroll_exceptions (company_id, tenant_id, payroll_id, exception_type, severity, message, status)
       VALUES ($1, $2, $3, 'FOREIGN_LEAK', 'ERROR', 'should never appear', 'OPEN')`,
      [foreignCompanyId, foreignTenantId, foreignPayrollId]
    );
    const leakCheck = await api.get('/api/ops/hr/exceptions?pageSize=100').set(auth(token));
    const leakRows = leakCheck.body.data.rows as { exceptionType: string }[];
    expect(leakRows.some((r) => r.exceptionType === 'FOREIGN_LEAK')).toBe(false);
    expect(Number(leakCheck.body.data.summary.total)).toBeGreaterThanOrEqual(0);

    // Self-clean so re-runs never collide with the period overlap guard.
    await db(`DELETE FROM payrolls WHERE id = $1`, [foreignPayrollId]);
    await db(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
    await db(`DELETE FROM tenants WHERE id = $1`, [foreignTenantId]);
    await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
    await deleteEmployees([empANoSalary, empBNoBank]);
  }, 30_000);

  it('updates an employee record via PATCH with permission and status guards', async () => {
    const { token } = await loginAs('hr.hannah');
    const created = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Edit',
      lastName: 'Candidate',
      position: 'Clerk',
      baseSalary: 200000,
      email: 'edit-candidate@example.com',
    });
    expect(created.status).toBe(200);
    const employeeId = Number(created.body.data.employeeId);
    const employeeNo = String(created.body.data.employeeNo);

    const patched = await api.patch(`/api/ops/hr/employees/${employeeId}`).set(auth(token)).send({
      firstName: 'Edited',
      lastName: 'Record',
      position: 'Supervisor',
      baseSalary: 850000,
      phone: '0700111222',
      bankName: 'Stanbic',
      bankAccountNo: '9030012345678',
      status: 'PROBATION',
    });
    expect(patched.status).toBe(200);
    expect(String(patched.body.data.employeeNo)).toBe(employeeNo);

    const detail = await api.get(`/api/ops/hr/employees/${employeeId}`).set(auth(token));
    expect(detail.status).toBe(200);
    const emp = detail.body.data.employee as Record<string, unknown>;
    expect(emp.firstName).toBe('Edited');
    expect(emp.lastName).toBe('Record');
    expect(emp.position).toBe('Supervisor');
    expect(Number(emp.baseSalary)).toBe(850000);
    expect(emp.phone).toBe('0700111222');
    expect(emp.bankName).toBe('Stanbic');
    expect(emp.bankAccountNo).toBe('9030012345678');
    expect(emp.status).toBe('PROBATION');
    // Untouched fields survive.
    expect(emp.email).toBe('edit-candidate@example.com');
    expect(emp.employeeNo).toBe(employeeNo);

    // Termination stays a dedicated flow; plain status edits cannot set it.
    const terminated = await api.patch(`/api/ops/hr/employees/${employeeId}`).set(auth(token)).send({ status: 'TERMINATED' });
    expect(terminated.status).toBe(400);

    // A user without hr.employees.update cannot edit.
    const { token: outsider } = await loginAs('sarah.sales');
    const denied = await api.patch(`/api/ops/hr/employees/${employeeId}`).set(auth(outsider)).send({ position: 'Hacked' });
    expect(denied.status).toBe(403);

    // Unknown ids 404.
    const missing = await api.patch('/api/ops/hr/employees/999999999').set(auth(token)).send({ position: 'Ghost' });
    expect(missing.status).toBe(404);

    await deleteEmployees([employeeId]);
  }, 30_000);
});
