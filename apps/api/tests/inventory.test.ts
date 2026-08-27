import { describe, it, expect } from 'vitest';
import { api, auth, loginAs } from './helpers.js';

describe('Inventory warehouse workspace', () => {
  it('returns a named stock board with opening balances', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/ops/inventory/stock').set(auth(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.rows)).toBe(true);
    expect(res.body.data.total).toBeGreaterThan(0);
    const line = res.body.data.rows[0];
    expect(line.productCode).toBeTruthy();
    expect(line.warehouseCode).toBeTruthy();
    expect(Number(line.quantity)).toBeGreaterThan(0);

    const summary = await api.get('/api/ops/inventory/stock/summary').set(auth(token));
    expect(summary.status).toBe(200);
    expect(Number(summary.body.data.stockValue)).toBeGreaterThan(0);
  });

  it('creates a transfer draft and refuses same-warehouse moves', async () => {
    const { token } = await loginAs('willy.wh');
    const board = await api.get('/api/ops/inventory/warehouses').set(auth(token));
    expect(board.status).toBe(200);
    const from = board.body.data.find((w: { code: string }) => w.code === 'FG-WH');
    const to = board.body.data.find((w: { code: string }) => w.code === 'RETURNS');
    expect(from).toBeTruthy();
    expect(to).toBeTruthy();

    const stock = await api.get('/api/ops/inventory/stock?warehouseId=' + from.id).set(auth(token));
    const productId = stock.body.data.rows[0].productId;

    const same = await api.post('/api/ops/inventory/transfers').set(auth(token)).send({
      fromWarehouseId: from.id,
      toWarehouseId: from.id,
      items: [{ productId, quantity: 1 }],
    });
    expect(same.status).toBe(400);

    const create = await api.post('/api/ops/inventory/transfers').set(auth(token)).send({
      fromWarehouseId: from.id,
      toWarehouseId: to.id,
      notes: 'workspace test',
      items: [{ productId, quantity: 2 }],
    });
    expect(create.status).toBe(200);
    const transferId = create.body.data.transferId;

    const detail = await api.get(`/api/ops/inventory/transfers/${transferId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.transfer.status).toBe('DRAFT');
    expect(detail.body.data.items.length).toBe(1);
    expect(detail.body.data.transfer.fromWarehouseCode).toBe('FG-WH');
  });

  it('exposes a cross-module warehouse work queue and demand board', async () => {
    const { token } = await loginAs('admin');
    const work = await api.get('/api/ops/inventory/work').set(auth(token));
    expect(work.status).toBe(200);
    expect(work.body.data.inbound).toBeTruthy();
    expect(work.body.data.outbound).toBeTruthy();
    expect(work.body.data.production).toBeTruthy();
    expect(work.body.data.reserved).toBeTruthy();

    const demand = await api.get('/api/ops/inventory/demand').set(auth(token));
    expect(demand.status).toBe(200);
    expect(Array.isArray(demand.body.data)).toBe(true);
    if (demand.body.data.length) {
      const row = demand.body.data[0];
      expect(row.code).toBeTruthy();
      expect(row.atp !== undefined).toBe(true);
    }

    const inbound = await api.get('/api/ops/inventory/inbound').set(auth(token));
    expect(inbound.status).toBe(200);
    expect(Array.isArray(inbound.body.data)).toBe(true);

    const outbound = await api.get('/api/ops/inventory/outbound').set(auth(token));
    expect(outbound.status).toBe(200);
    expect(Array.isArray(outbound.body.data)).toBe(true);

    const plant = await api.get('/api/ops/inventory/production-issue').set(auth(token));
    expect(plant.status).toBe(200);
    expect(Array.isArray(plant.body.data)).toBe(true);

    const resv = await api.get('/api/ops/inventory/reservations').set(auth(token));
    expect(resv.status).toBe(200);
    expect(Array.isArray(resv.body.data)).toBe(true);
  });

  it('lets a warehouse manager open the inbound and pick desks', async () => {
    const { token } = await loginAs('willy.wh');
    const inbound = await api.get('/api/ops/inventory/inbound').set(auth(token));
    expect(inbound.status).toBe(200);
    const outbound = await api.get('/api/ops/inventory/outbound').set(auth(token));
    expect(outbound.status).toBe(200);
    const work = await api.get('/api/ops/inventory/work').set(auth(token));
    expect(work.status).toBe(200);
  });
});
