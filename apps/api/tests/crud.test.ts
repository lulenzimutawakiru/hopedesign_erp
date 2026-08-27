import { describe, it, expect } from 'vitest';
import { api, auth, loginAs } from './helpers.js';

describe('Generic CRUD+ with audit trail', () => {
  it('lists customers with pagination', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/crm/customers').set(auth(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination.page).toBe(1);
    expect(typeof res.body.pagination.pageSize).toBe('number');
    expect(typeof res.body.pagination.total).toBe('number');
  });

  it('creates a customer with an auto-generated code, reads it back, and audits it', async () => {
    const { token } = await loginAs('admin');
    const name = `API Test Customer ${Date.now()}`;
    const res = await api.post('/api/crm/customers').set(auth(token)).send({
      name,
      customerType: 'COMPANY',
      email: `api-${Date.now()}@example.com`,
      phone: '+256700000000',
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.data.id)).toBeGreaterThan(0);
    expect(res.body.data.code).toMatch(/^CUST-\d{4}-\d{8}$/);

    const id = res.body.data.id;
    const get = await api.get(`/api/crm/customers/${id}`).set(auth(token));
    expect(get.status).toBe(200);
    expect(get.body.data.name).toBe(name);
    expect(get.body.data.code).toBe(res.body.data.code);

    const audit = await api.get(`/api/crm/customers/${id}/audit`).set(auth(token));
    expect(audit.status).toBe(200);
    expect(Array.isArray(audit.body.data)).toBe(true);
    const createRows = audit.body.data.filter(
      (r: { action: string; resource: string }) => r.action === 'create' && r.resource === 'customers'
    );
    expect(createRows.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores status and posting fields on generic create/update', async () => {
    const { token } = await loginAs('admin');
    const created = await api.post('/api/ops/sales/orders').set(auth(token)).send({
      customerId: 1,
      items: [{ productId: 3, quantity: 1, unitPrice: 1000 }],
    });
    expect(created.status).toBe(200);
    const id = created.body.data.orderId;

    const meta = await api.get('/api/meta/entities/sales/orders').set(auth(token));
    expect(meta.status).toBe(200);
    expect(meta.body.data.writable).not.toContain('status');
    expect(meta.body.data.writable).not.toContain('allocated');

    const patch = await api.patch(`/api/sales/orders/${id}`).set(auth(token)).send({
      status: 'INVOICED',
      allocated: true,
      notes: 'still a draft',
    });
    expect(patch.status).toBe(200);
    expect(patch.body.data.status).toBe('DRAFT');
    expect(patch.body.data.allocated).toBe(false);
    expect(patch.body.data.notes).toBe('still a draft');

    const statusOnly = await api.patch(`/api/sales/orders/${id}`).set(auth(token)).send({ status: 'APPROVED' });
    expect(statusOnly.status).toBe(400);

    const customer = await api.post('/api/crm/customers').set(auth(token)).send({
      name: `Status Lock ${Date.now()}`,
      customerType: 'COMPANY',
      status: 'BLOCKED',
    });
    expect(customer.status).toBe(201);
    expect(customer.body.data.status).toBe('ACTIVE');
  });
});