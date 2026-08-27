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
     VALUES ((SELECT company_id FROM employees WHERE id=$1),(SELECT tenant_id FROM employees WHERE id=$1),$2,'Payments Test Group','MONTHLY','UGX','ACTIVE')
     RETURNING id`,
    [employeeId, `PAYTEST-${Date.now()}`]
  );
  const groupId = Number(g.rows[0].id);
  await db(
    `INSERT INTO employee_payroll_profiles (company_id, tenant_id, employee_id, payroll_group_id, payment_method, currency, status)
     VALUES ((SELECT company_id FROM employees WHERE id=$1),(SELECT tenant_id FROM employees WHERE id=$1),$1,$2,'BANK_TRANSFER','UGX','ACTIVE')`,
    [employeeId, groupId]
  );
  return groupId;
}

describe('Payroll payments', () => {
  it('creates a payment batch, enforces separation of duties, confirms payments, publishes payslips and reconciles', async () => {
    // 1. Employee with bank details, created by the HR officer.
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Payment',
      lastName: `Tester${Date.now()}`,
      position: 'Clerk',
      baseSalary: 3000000,
      bankName: 'Stanbic',
      bankAccountNo: '0987654321',
      phone: '+256700000000',
      tin: '1234567893',
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);
    const groupId = await createGroupFor(employeeId);

    // 2. Group-scoped single-day payroll run inside FY2026-P12 (avoids the period overlap guard).
    const run = await api.post('/api/ops/hr/payrolls').set(auth(token)).send({
      periodStart: '2027-06-05',
      periodEnd: '2027-06-05',
      payrollGroupId: groupId,
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);

    // 3. Verify the calculation engine: 3,000,000 - PAYE 802,000 - NSSF 150,000 = 2,048,000.
    const detail = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(token));
    expect(detail.status).toBe(200);
    const items = detail.body.data.items as {
      employeeId: string;
      grossPay: string;
      paye: string;
      nssf: string;
      netPay: string;
      payslipNo: string;
    }[];
    const mine = items.find((i) => Number(i.employeeId) === employeeId);
    expect(mine).toBeTruthy();
    expect(Number(mine!.grossPay)).toBe(3000000);
    expect(Number(mine!.paye)).toBe(802000);
    expect(Number(mine!.nssf)).toBe(150000);
    expect(Number(mine!.netPay)).toBe(2048000);
    const payrollNet = Number(detail.body.data.payroll.netTotal);
    expect(payrollNet).toBe(2048000);

    // 4. Only the raw row flips to APPROVED; the officer who prepared the run
    // cannot self-approve through the UI/API.
    await db(`UPDATE payrolls SET status = 'APPROVED' WHERE id = $1`, [payrollId]);

    // 5. Finance posts the balanced GL journal (admin, system.admin.all).
    const { token: admin } = await loginAs('admin');
    const posted = await api.post(`/api/ops/hr/payrolls/${payrollId}/post`).set(auth(admin)).send({});
    expect(posted.status).toBe(200);
    const journalId = Number(posted.body.data.journalId);
    expect(journalId).toBeGreaterThan(0);
    const after = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(admin));
    expect(after.body.data.payroll.status).toBe('RELEASED');
    expect(after.body.data.payroll.glPosted).toBe(true);

    // 6. Payment batch: hannah prepared the payroll, so she is the batch creator.
    const batch = await api.post(`/api/ops/hr/payrolls/${payrollId}/payment-batch`).set(auth(token)).send({});
    expect(batch.status).toBe(200);
    const batchId = Number(batch.body.data.batchId);
    expect(batchId).toBeGreaterThan(0);
    expect(batch.body.data.status).toBe('DRAFT');
    expect(Number(batch.body.data.totalAmount)).toBe(payrollNet);
    expect(Number(batch.body.data.itemCount)).toBe(1);

    // 7. Four-eyes: the officer who prepared the payroll cannot approve its
    // payment batch (SoD blocks create + approve -> 403 at the middleware).
    const selfApprove = await api.post(`/api/ops/hr/payment-batches/${batchId}/approve`).set(auth(token)).send({});
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('FORBIDDEN');
    expect(String(selfApprove.body.error.message)).toMatch(/Segregation of duties/i);

    // 8. Validate (admin).
    const validated = await api.post(`/api/ops/hr/payment-batches/${batchId}/validate`).set(auth(admin)).send({});
    expect(validated.status).toBe(200);
    expect(validated.body.data.status).toBe('VALIDATED');
    expect(Array.isArray(validated.body.data.notes)).toBe(true);

    // 9. A different user with the payroll manager role approves.
    const { token: manager } = await loginAs('pay.manager');
    const approved = await api.post(`/api/ops/hr/payment-batches/${batchId}/approve`).set(auth(manager)).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');

    // 10. Export masked bank file: full account numbers must never leave the API.
    const exported = await api.post(`/api/ops/hr/payment-batches/${batchId}/export`).set(auth(admin)).send({});
    expect(exported.status).toBe(200);
    expect(exported.body.data.status).toBe('EXPORTED');
    expect(Number(exported.body.data.rowCount)).toBe(1);
    const fileContent = String(exported.body.data.fileContent);
    expect(fileContent).toContain('****4321');
    expect(fileContent).not.toContain('0987654321');
    expect(fileContent).toContain(mine!.payslipNo);

    // 11. Confirm payment -> SUCCESS transactions and PAID items.
    const confirmed = await api.post(`/api/ops/hr/payment-batches/${batchId}/confirm`).set(auth(admin)).send({});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('CONFIRMED');
    expect(Number(confirmed.body.data.transactionCount)).toBe(1);

    // 12. Batch detail exposes masked items, transactions and the linked payroll.
    const batchDetail = await api.get(`/api/ops/hr/payment-batches/${batchId}`).set(auth(admin));
    expect(batchDetail.status).toBe(200);
    const batchItem = (
      batchDetail.body.data.items as { employeeId: string; paymentMethod: string; maskedAccountNo: string | null }[]
    ).find((i) => Number(i.employeeId) === employeeId);
    expect(batchItem).toBeTruthy();
    expect(batchItem!.paymentMethod).toBe('BANK_TRANSFER');
    expect(batchItem!.maskedAccountNo).toBe('****4321');
    expect(batchDetail.body.data.transactions.length).toBe(1);
    expect(Number(batchDetail.body.data.payroll.netTotal)).toBe(payrollNet);

    // 13. Publish employee payslips (idempotent per employee).
    const published = await api.post(`/api/ops/hr/payrolls/${payrollId}/publish-payslips`).set(auth(admin)).send({});
    expect(published.status).toBe(200);
    expect(Number(published.body.data.published)).toBe(1);
    expect(String(published.body.data.payrollNo)).toMatch(/^PAY-/);

    // 14. Payslips are visible to payroll administrators with verification codes.
    const slips = await api.get(`/api/ops/hr/payrolls/${payrollId}/payslips`).set(auth(admin));
    expect(slips.status).toBe(200);
    const slip = (
      slips.body.data.rows as { employeeId: string; netTotal: string; status: string; verificationCode: string }[]
    ).find((r) => Number(r.employeeId) === employeeId);
    expect(slip).toBeTruthy();
    expect(Number(slip!.netTotal)).toBe(payrollNet);
    expect(slip!.status).toBe('PUBLISHED');
    expect(String(slip!.verificationCode).length).toBe(10);

    // 15. Reconcile payroll, payment batch, bank and GL totals. Reconcile uses
    // the approve permission, so a payroll manager (no payroll-create rights)
    // performs it; admin would trip the same SoD middleware as hannah.
    const { token: manager2 } = await loginAs('pay.manager');
    const reconciled = await api.post(`/api/ops/hr/payrolls/${payrollId}/reconcile`).set(auth(manager2)).send({});
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.data.status).toBe('MATCHED');
    expect(Number(reconciled.body.data.payrollTotal)).toBe(payrollNet);
    expect(Number(reconciled.body.data.batchTotal)).toBe(payrollNet);
    expect(Number(reconciled.body.data.bankTotal)).toBe(payrollNet);
    expect(Number(reconciled.body.data.journalTotal)).toBe(payrollNet);
    expect(reconciled.body.data.differences).toEqual([]);

    // 16. Payment dashboard and reconciliation centre shape (read-only, admin).
    const dash = await api.get('/api/ops/hr/payment-dashboard').set(auth(admin));
    expect(dash.status).toBe(200);
    expect(Number(dash.body.data.kpis.totalBatches)).toBeGreaterThanOrEqual(1);
    expect(Number(dash.body.data.kpis.reconciledBatches)).toBeGreaterThanOrEqual(1);
    expect(Number(dash.body.data.kpis.paidTransactions)).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(dash.body.data.byStatus)).toBe(true);

    const centre = await api.get('/api/ops/hr/reconciliation').set(auth(admin));
    expect(centre.status).toBe(200);
    expect(Array.isArray(centre.body.data.batches)).toBe(true);
    expect(Array.isArray(centre.body.data.transactions)).toBe(true);
    expect(Array.isArray(centre.body.data.reconciliations)).toBe(true);
    expect(Array.isArray(centre.body.data.recent)).toBe(true);

    // Self-clean in FK order so re-runs never collide with the period overlap guard.
    await db(`DELETE FROM payment_reconciliations WHERE payroll_id = $1`, [payrollId]);
    await db(
      `DELETE FROM payment_transactions WHERE batch_id IN (SELECT id FROM payment_batches WHERE payroll_id = $1)`,
      [payrollId]
    );
    await db(`DELETE FROM payment_batches WHERE payroll_id = $1`, [payrollId]);
    await db(`DELETE FROM payslips WHERE payroll_id = $1`, [payrollId]);
    await db(`DELETE FROM journal_entries WHERE id = $1`, [journalId]);
    await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
    await deleteEmployees([employeeId]);
    await db(`DELETE FROM employee_payroll_profiles WHERE payroll_group_id = $1`, [groupId]);
    await db(`DELETE FROM payroll_groups WHERE id = $1`, [groupId]);
  }, 30_000);

  it('blocks the same user from approving their own batch at the middleware (SoD)', async () => {
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'SoD',
      lastName: `Batch${Date.now()}`,
      position: 'Clerk',
      baseSalary: 1000000,
      bankName: 'Stanbic',
      bankAccountNo: '5555555555',
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);
    const groupId = await createGroupFor(employeeId);

    const run = await api.post('/api/ops/hr/payrolls').set(auth(token)).send({
      periodStart: '2027-06-06',
      periodEnd: '2027-06-06',
      payrollGroupId: groupId,
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);
    await db(`UPDATE payrolls SET status = 'APPROVED' WHERE id = $1`, [payrollId]);

    // Admin carries system.admin.all (RBAC) but still holds hr.payrolls.create,
    // so the hard SoD rule fires and rejects the self-approval with 403.
    const { token: admin } = await loginAs('admin');
    const batch = await api.post(`/api/ops/hr/payrolls/${payrollId}/payment-batch`).set(auth(admin)).send({});
    expect(batch.status).toBe(200);
    const batchId = Number(batch.body.data.batchId);

    const selfApprove = await api.post(`/api/ops/hr/payment-batches/${batchId}/approve`).set(auth(admin)).send({});
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('FORBIDDEN');
    expect(String(selfApprove.body.error.message)).toMatch(/Segregation of duties/i);

    await db(`DELETE FROM payment_batches WHERE payroll_id = $1`, [payrollId]);
    await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
    await deleteEmployees([employeeId]);
    await db(`DELETE FROM employee_payroll_profiles WHERE payroll_group_id = $1`, [groupId]);
    await db(`DELETE FROM payroll_groups WHERE id = $1`, [groupId]);
  }, 30_000);
});
