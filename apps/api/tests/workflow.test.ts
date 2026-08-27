import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, findPendingTask } from './helpers.js';

describe('My work queue', () => {
  it('returns a personal assigned queue for the signed-in user', async () => {
    const { token } = await loginAs('sarah.sales');
    const res = await api.get('/api/dashboard/my-work').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toBeTruthy();
    expect(Array.isArray(res.body.data.leads)).toBe(true);
    expect(Array.isArray(res.body.data.opportunities)).toBe(true);
    expect(Array.isArray(res.body.data.activities)).toBe(true);
    expect(Array.isArray(res.body.data.complaints)).toBe(true);
    expect(Array.isArray(res.body.data.approvals)).toBe(true);
  });
});

describe('Workflow engine (sales)', () => {
  it('auto-approves quotations when no workflow is configured', async () => {
    const { token } = await loginAs('sarah.sales');
    const create = await api.post('/api/ops/sales/quotations').set(auth(token)).send({
      customerId: 1,
      items: [{ productId: 3, quantity: 10, unitPrice: 12000 }],
    });
    expect(create.status).toBe(200);
    const quotationId = create.body.data.quotationId;

    const submit = await api.post(`/api/ops/sales/quotations/${quotationId}/submit`).set(auth(token)).send({});
    expect(submit.status).toBe(200);

    const get = await api.get(`/api/sales/quotations/${quotationId}`).set(auth(token));
    expect(get.status).toBe(200);
    expect(get.body.data.status).toBe('APPROVED');
  });

  it('approves a sales order through the workflow queue', async () => {
    const { token } = await loginAs('sarah.sales');
    const create = await api.post('/api/ops/sales/orders').set(auth(token)).send({
      customerId: 1,
      items: [{ productId: 3, quantity: 10, unitPrice: 12000 }],
    });
    expect(create.status).toBe(200);
    const orderId = create.body.data.orderId;

    const submit = await api.post(`/api/ops/sales/orders/${orderId}/submit`).set(auth(token)).send({});
    expect(submit.status).toBe(200);

    const taskId = await findPendingTask(token, 'sales.orders', orderId, 1);
    expect(taskId).not.toBeNull();

    const decide = await api
      .post(`/api/approvals/${taskId}/decide`)
      .set(auth(token))
      .send({ decision: 'APPROVED', comment: 'approved by integration test' });
    expect(decide.status).toBe(200);
    expect(decide.body.data.status).toBe('APPROVED');
    expect(decide.body.data.completed).toBe(true);

    const get = await api.get(`/api/sales/orders/${orderId}`).set(auth(token));
    expect(get.status).toBe(200);
    expect(get.body.data.status).toBe('APPROVED');

    // A task can only be decided once.
    const again = await api
      .post(`/api/approvals/${taskId}/decide`)
      .set(auth(token))
      .send({ decision: 'APPROVED' });
    expect(again.status).toBe(400);
    expect(again.body.error.message).toMatch(/already APPROVED/i);
  });
});