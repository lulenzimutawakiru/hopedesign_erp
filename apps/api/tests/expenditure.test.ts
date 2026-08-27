import { describe, it, expect, beforeAll } from 'vitest';
import { api, auth, loginAs, findPendingTask } from './helpers.js';

let opsToken: string;
let finToken: string;
let categoryId: number;
let paymentMethodId: number;
let fundId: number;
let employeeId: number;

function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Ops daily expenditure module', () => {
  beforeAll(async () => {
    opsToken = (await loginAs('opus.ops')).token;
    finToken = (await loginAs('cindy.cfo')).token;
    const meta = await api.get('/api/ops/expenditure/meta').set(auth(opsToken));
    expect(meta.status).toBe(200);
    expect(meta.body.data.categories.length).toBeGreaterThan(0);
    expect(meta.body.data.paymentMethods.length).toBeGreaterThan(0);
    expect(meta.body.data.pettyCashFunds.length).toBeGreaterThan(0);
    expect(meta.body.data.employees.length).toBeGreaterThan(0);
    categoryId = meta.body.data.categories[0].id;
    paymentMethodId = meta.body.data.paymentMethods[0].id;
    fundId = meta.body.data.pettyCashFunds[0].id;
    employeeId = meta.body.data.employees[0].id;
  });

  it('records, approves, pays and posts an expense', async () => {
    const create = await api.post('/api/ops/expenditure/expenses').set(auth(opsToken)).send({
      description: `Integration test fuel ${Date.now()}`,
      amount: 250000,
      categoryId,
      expDate: '2026-08-25',
      paymentMethodId,
      payee: 'Integration Fuel Station',
      isPlanned: true,
    });
    expect(create.status).toBe(200);
    const id = Number(create.body.data.id);
    expect(create.body.data.expNo).toMatch(/^EXP-/);
    expect(create.body.data.status).toBe('DRAFT');

    const submit = await api.post(`/api/ops/expenditure/expenses/${id}/submit`).set(auth(opsToken)).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.status).toBe('SUBMITTED');

    const taskId = await findPendingTask(finToken, 'ops.expenses', id, 1);
    expect(taskId).not.toBeNull();
    const decide = await api
      .post(`/api/approvals/${taskId}/decide`)
      .set(auth(finToken))
      .send({ decision: 'APPROVED', comment: 'approved by integration test' });
    expect(decide.status).toBe(200);
    expect(decide.body.data.status).toBe('APPROVED');

    const pay = await api.post(`/api/ops/expenditure/expenses/${id}/pay`).set(auth(finToken)).send({});
    expect(pay.status).toBe(200);
    expect(pay.body.data.status).toBe('PAID');
    expect(pay.body.data.payNo).toMatch(/^PAY-/);

    const post = await api.post(`/api/ops/expenditure/expenses/${id}/post`).set(auth(finToken)).send({});
    expect(post.status).toBe(200);
    expect(post.body.data.accountingStatus).toBe('POSTED');
    expect(post.body.data.glPosted).toBe(true);
  });

  it('blocks the creator from approving their own expense (segregation of duties)', async () => {
    const create = await api.post('/api/ops/expenditure/expenses').set(auth(finToken)).send({
      description: `CFO self-created expense ${Date.now()}`,
      amount: 100000,
      categoryId,
      expDate: '2026-08-25',
    });
    expect(create.status).toBe(200);
    const id = Number(create.body.data.id);

    const submit = await api.post(`/api/ops/expenditure/expenses/${id}/submit`).set(auth(finToken)).send({});
    expect(submit.status).toBe(200);

    const taskId = await findPendingTask(finToken, 'ops.expenses', id, 1);
    expect(taskId).not.toBeNull();
    const decide = await api.post(`/api/approvals/${taskId}/decide`).set(auth(finToken)).send({ decision: 'APPROVED' });
    expect(decide.status).toBe(403);
    expect(decide.body.error.message).toMatch(/Segregation of duties/i);
  });

  it('reconciles petty cash and requires an explanation for variances', async () => {
    const desk = await api.get('/api/ops/expenditure/petty-cash').set(auth(opsToken));
    expect(desk.status).toBe(200);
    const fund = desk.body.data.funds.find((f: { id: number }) => Number(f.id) === Number(fundId));
    expect(fund).toBeTruthy();
    const closing = Number(fund.closingBalance);

    const match = await api
      .post('/api/ops/expenditure/petty-cash/reconcile')
      .set(auth(opsToken))
      .send({ fundId, countedAmount: closing });
    expect(match.status).toBe(200);
    expect(match.body.data.status).toBe('MATCHED');
    expect(Math.abs(Number(match.body.data.variance))).toBeLessThanOrEqual(0.005);

    const variance = await api
      .post('/api/ops/expenditure/petty-cash/reconcile')
      .set(auth(opsToken))
      .send({ fundId, countedAmount: closing - 50000 });
    expect(variance.status).toBe(400);
    expect(variance.body.error.message).toMatch(/variance explanation/i);
  });

  it('creates, submits, approves and pays a petty cash replenishment', async () => {
    const create = await api
      .post('/api/ops/expenditure/replenishments')
      .set(auth(opsToken))
      .send({ fundId, amount: 200000, reason: 'Integration test top-up' });
    expect(create.status).toBe(200);
    const id = Number(create.body.data.id);
    expect(create.body.data.repNo).toMatch(/^PCR-/);
    expect(create.body.data.status).toBe('DRAFT');

    const submit = await api.post(`/api/ops/expenditure/replenishments/${id}/submit`).set(auth(opsToken)).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.status).toBe('SUBMITTED');

    const taskId = await findPendingTask(finToken, 'ops.replenishments', id, 1);
    expect(taskId).not.toBeNull();
    const decide = await api.post(`/api/approvals/${taskId}/decide`).set(auth(finToken)).send({ decision: 'APPROVED' });
    expect(decide.status).toBe(200);
    expect(decide.body.data.status).toBe('APPROVED');

    const pay = await api.post(`/api/ops/expenditure/replenishments/${id}/pay`).set(auth(finToken)).send({});
    expect(pay.status).toBe(200);
    expect(pay.body.data.status).toBe('PAID');
  });

  it('creates, submits, approves and reimburses an employee claim', async () => {
    const create = await api.post('/api/ops/expenditure/claims').set(auth(opsToken)).send({
      employeeId,
      trip: 'Kampala - Jinja',
      description: 'Integration test travel claim',
      expenseDate: '2026-08-25',
      amount: 150000,
      paymentMethodId,
    });
    expect(create.status).toBe(200);
    const id = Number(create.body.data.id);
    expect(create.body.data.claimNo).toMatch(/^CLM-/);
    expect(create.body.data.status).toBe('DRAFT');

    const submit = await api.post(`/api/ops/expenditure/claims/${id}/submit`).set(auth(opsToken)).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.status).toBe('SUBMITTED');

    const taskId = await findPendingTask(finToken, 'ops.claims', id, 1);
    expect(taskId).not.toBeNull();
    const decide = await api.post(`/api/approvals/${taskId}/decide`).set(auth(finToken)).send({ decision: 'APPROVED' });
    expect(decide.status).toBe(200);
    expect(decide.body.data.status).toBe('APPROVED');

    const reimburse = await api.post(`/api/ops/expenditure/claims/${id}/reimburse`).set(auth(finToken)).send({});
    expect(reimburse.status).toBe(200);
    expect(reimburse.body.data.status).toBe('REIMBURSED');
  });

  it('creates, submits and approves a daily cash close with a variance guard', async () => {
    // Derive the close date from the clock so repeated runs against a shared
    // database never collide with a close persisted by an earlier run.
    const closeDate = futureDate(9 + (Date.now() % 700));

    // A variance without an explanation is rejected and nothing is created.
    const bad = await api
      .post('/api/ops/expenditure/daily-close')
      .set(auth(opsToken))
      .send({ closeDate, physicalCash: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/variance explanation/i);

    const create = await api.post('/api/ops/expenditure/daily-close').set(auth(opsToken)).send({ closeDate });
    expect(create.status).toBe(200);
    const id = Number(create.body.data.id);
    expect(create.body.data.closeNo).toMatch(/^CLS-/);
    expect(create.body.data.status).toBe('DRAFT');

    const submit = await api.post(`/api/ops/expenditure/daily-close/${id}/submit`).set(auth(opsToken)).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.status).toBe('SUBMITTED');

    const taskId = await findPendingTask(finToken, 'ops.daily_closings', id, 1);
    expect(taskId).not.toBeNull();
    const decide = await api.post(`/api/approvals/${taskId}/decide`).set(auth(finToken)).send({ decision: 'APPROVED' });
    expect(decide.status).toBe(200);
    expect(decide.body.data.status).toBe('APPROVED');

    const status = await api
      .get(`/api/ops/expenditure/daily-close/status?date=${closeDate}`)
      .set(auth(opsToken));
    expect(status.status).toBe(200);
    expect(status.body.data.closed).toBe(true);
  });
});