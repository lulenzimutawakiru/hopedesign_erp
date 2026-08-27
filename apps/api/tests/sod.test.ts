import { describe, it, expect } from 'vitest';
import { api, auth, loginAs } from './helpers.js';

describe('Segregation of duties (procurement)', () => {
  it('blocks a user from approving their own purchase order', async () => {
    const { token } = await loginAs('opus.ops');
    const create = await api.post('/api/ops/procurement/orders').set(auth(token)).send({
      supplierId: 1,
      items: [{ productId: 1, quantity: 5, unitPrice: 10000 }],
    });
    expect(create.status).toBe(200);
    const orderId = create.body.data.orderId;

    const submit = await api.post(`/api/ops/procurement/orders/${orderId}/submit`).set(auth(token)).send({});
    expect(submit.status).toBe(200);

    // Create + Approve Purchase Order is a hard SoD conflict.
    const approve = await api
      .post(`/api/procurement/orders/${orderId}/approve`)
      .set(auth(token))
      .send({ comment: 'should be blocked' });
    expect(approve.status).toBe(403);
    expect(approve.body.error.code).toBe('FORBIDDEN');
    expect(approve.body.error.message).toMatch(/Segregation of duties/i);

    // Positive control: the user can still read the record they created.
    const get = await api.get(`/api/procurement/orders/${orderId}`).set(auth(token));
    expect(get.status).toBe(200);
    expect(Number(get.body.data.id)).toBe(orderId);
  });
});