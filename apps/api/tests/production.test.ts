import { describe, it, expect } from 'vitest';
import { api, auth, loginAs } from './helpers.js';

describe('Work order wizard setup', () => {
  it('returns BOM, routing and exploded materials for a product', async () => {
    const { token } = await loginAs('admin');
    const products = await api.get('/api/inventory/items?pageSize=20').set(auth(token));
    expect(products.status).toBe(200);
    const product = products.body.data.find((p: { code: string }) => p.code === 'NATEX-A4') ?? products.body.data[0];
    expect(product).toBeTruthy();

    const setup = await api
      .get(`/api/ops/production/products/${product.id}/setup?quantity=1000`)
      .set(auth(token));
    expect(setup.status).toBe(200);
    expect(setup.body.data.product).toBeTruthy();
    expect(Array.isArray(setup.body.data.boms)).toBe(true);
    expect(Array.isArray(setup.body.data.machines)).toBe(true);

    const created = await api.post('/api/ops/production/work-orders').set(auth(token)).send({
      productId: product.id,
      quantity: 50,
      priority: 'MEDIUM',
    });
    expect(created.status).toBe(200);
    expect(Number(created.body.data.workOrderId)).toBeGreaterThan(0);
  });

  it('runs a work order from draft through release, start, output and complete', async () => {
    const { token } = await loginAs('admin');
    const products = await api.get('/api/inventory/items?pageSize=20').set(auth(token));
    const product = products.body.data.find((p: { code: string }) => p.code === 'NATEX-A4') ?? products.body.data[0];
    const created = await api.post('/api/ops/production/work-orders').set(auth(token)).send({
      productId: product.id,
      quantity: 10,
      priority: 'HIGH',
    });
    expect(created.status).toBe(200);
    const id = created.body.data.workOrderId;

    const released = await api.post(`/api/ops/production/work-orders/${id}/release`).set(auth(token)).send({});
    expect(released.status).toBe(200);

    const started = await api.post(`/api/ops/production/work-orders/${id}/start`).set(auth(token)).send({});
    expect(started.status).toBe(200);

    const output = await api.post(`/api/ops/production/work-orders/${id}/output`).set(auth(token)).send({
      outputType: 'GOOD',
      quantity: 10,
    });
    expect(output.status).toBe(200);

    const done = await api.post(`/api/ops/production/work-orders/${id}/complete`).set(auth(token)).send({});
    expect(done.status).toBe(200);
    expect(done.body.data.actualCost).toBeDefined();

    const detail = await api.get(`/api/ops/production/work-orders/${id}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.workOrder.status).toBe('COMPLETED');
    expect(Number(detail.body.data.workOrder.producedQty)).toBeGreaterThanOrEqual(10);
  });

  it('exposes the plant board and sales demand', async () => {
    const { token } = await loginAs('admin');
    const board = await api.get('/api/ops/production/board').set(auth(token));
    expect(board.status).toBe(200);
    expect(board.body.data.kpis).toBeTruthy();
    expect(Array.isArray(board.body.data.live)).toBe(true);
    expect(Array.isArray(board.body.data.machines)).toBe(true);

    const demand = await api.get('/api/ops/production/demand').set(auth(token));
    expect(demand.status).toBe(200);
    expect(Array.isArray(demand.body.data)).toBe(true);
  });
});
