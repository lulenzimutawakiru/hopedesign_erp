import { describe, it, expect } from 'vitest';
import { api, auth, db, loginAs } from './helpers.js';

type Row = Record<string, unknown>;

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Sum of on-hand quantity for a product across every location in a warehouse. */
function sumAt(locations: Row[], warehouseId: unknown): number {
  return locations
    .filter((l) => Number(l.warehouseId) === Number(warehouseId))
    .reduce((s, l) => s + Number(l.quantity ?? 0), 0);
}

describe('Quick stock entry', () => {
  it('posts a receipt, increases on-hand and records the movement', async () => {
    const { token } = await loginAs('willy.wh');
    const board = await api.get('/api/ops/inventory/warehouses').set(auth(token));
    const wh = board.body.data.find((w: { code: string }) => w.code === 'FG-WH');
    expect(wh).toBeTruthy();

    const stock = await api.get('/api/ops/inventory/stock?warehouseId=' + wh.id).set(auth(token));
    const line = stock.body.data.rows.find((r: { quantity: number }) => Number(r.quantity) >= 0);
    expect(line).toBeTruthy();
    const productId = line.productId;

    const before = await api.get(`/api/ops/inventory/products/${productId}/stock`).set(auth(token));
    const qtyBefore = sumAt(before.body.data.locations, wh.id);

    const res = await api.post('/api/ops/inventory/entries').set(auth(token)).send({
      entryType: 'RECEIPT',
      warehouseId: wh.id,
      referenceNo: 'receipt test',
      clientToken: uuid(),
      action: 'submit',
      lines: [{ productId, quantity: 2 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('POSTED');
    const entryNo = res.body.data.entryNo;

    const after = await api.get(`/api/ops/inventory/products/${productId}/stock`).set(auth(token));
    expect(sumAt(after.body.data.locations, wh.id)).toBe(qtyBefore + 2);

    const move = after.body.data.movements.find(
      (m: { referenceType: string; referenceCode: string }) =>
        m.referenceType === 'stock_entries' && m.referenceCode === entryNo
    );
    expect(move).toBeTruthy();
    expect(move.movementType).toBe('RECEIPT');
    expect(Number(move.quantity)).toBe(2);
  });

  it('is idempotent: the same clientToken never posts twice', async () => {
    const { token } = await loginAs('willy.wh');
    const board = await api.get('/api/ops/inventory/warehouses').set(auth(token));
    const wh = board.body.data.find((w: { code: string }) => w.code === 'FG-WH');
    const stock = await api.get('/api/ops/inventory/stock?warehouseId=' + wh.id).set(auth(token));
    const productId = stock.body.data.rows[0].productId;

    const before = await api.get(`/api/ops/inventory/products/${productId}/stock`).set(auth(token));
    const qtyBefore = sumAt(before.body.data.locations, wh.id);

    const clientToken = uuid();
    const body = {
      entryType: 'RECEIPT',
      warehouseId: wh.id,
      clientToken,
      action: 'submit',
      lines: [{ productId, quantity: 1 }],
    };
    const first = await api.post('/api/ops/inventory/entries').set(auth(token)).send(body);
    expect(first.status).toBe(200);
    const second = await api.post('/api/ops/inventory/entries').set(auth(token)).send(body);
    expect(second.status).toBe(200);
    expect(second.body.data.entryNo).toBe(first.body.data.entryNo);

    const after = await api.get(`/api/ops/inventory/products/${productId}/stock`).set(auth(token));
    expect(sumAt(after.body.data.locations, wh.id)).toBe(qtyBefore + 1); // not +2
  });

  it('saves a draft, then cancels it; a cancelled entry cannot be posted', async () => {
    const { token } = await loginAs('willy.wh');
    const board = await api.get('/api/ops/inventory/warehouses').set(auth(token));
    const wh = board.body.data.find((w: { code: string }) => w.code === 'FG-WH');
    const stock = await api.get('/api/ops/inventory/stock?warehouseId=' + wh.id).set(auth(token));
    const productId = stock.body.data.rows[0].productId;

    const save = await api.post('/api/ops/inventory/entries').set(auth(token)).send({
      entryType: 'RECEIPT',
      warehouseId: wh.id,
      clientToken: uuid(),
      lines: [{ productId, quantity: 2 }],
    });
    expect(save.status).toBe(200);
    expect(save.body.data.status).toBe('DRAFT');
    const entryId = save.body.data.entryId;

    const detail = await api.get(`/api/ops/inventory/entries/${entryId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.entry.status).toBe('DRAFT');

    const cancel = await api.post(`/api/ops/inventory/entries/${entryId}/cancel`).set(auth(token));
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');

    const post = await api.post(`/api/ops/inventory/entries/${entryId}/submit`).set(auth(token));
    expect(post.status).toBe(400);
  });

  it('validates warehouses and lines', async () => {
    const { token } = await loginAs('willy.wh');
    const board = await api.get('/api/ops/inventory/warehouses').set(auth(token));
    const wh = board.body.data.find((w: { code: string }) => w.code === 'FG-WH');
    const stock = await api.get('/api/ops/inventory/stock?warehouseId=' + wh.id).set(auth(token));
    const productId = stock.body.data.rows[0].productId;

    const same = await api.post('/api/ops/inventory/entries').set(auth(token)).send({
      entryType: 'TRANSFER',
      warehouseId: wh.id,
      toWarehouseId: wh.id,
      clientToken: uuid(),
      lines: [{ productId, quantity: 1 }],
    });
    expect(same.status).toBe(400);

    const empty = await api.post('/api/ops/inventory/entries').set(auth(token)).send({
      entryType: 'RECEIPT',
      warehouseId: wh.id,
      clientToken: uuid(),
      lines: [],
    });
    expect(empty.status).toBe(400);
  });

  it('denies a user without the create permission', async () => {
    const { token } = await loginAs('sarah.sales');
    const res = await api.post('/api/ops/inventory/entries').set(auth(token)).send({
      entryType: 'RECEIPT',
      warehouseId: 1,
      clientToken: uuid(),
      lines: [{ productId: 1, quantity: 1 }],
    });
    expect(res.status).toBe(403);
  });

  it('returns 409 when a draft is re-saved with a stale expectedUpdatedAt', async () => {
    const { token } = await loginAs('willy.wh');
    const board = await api.get('/api/ops/inventory/warehouses').set(auth(token));
    const wh = board.body.data.find((w: { code: string }) => w.code === 'FG-WH');
    const stock = await api.get('/api/ops/inventory/stock?warehouseId=' + wh.id).set(auth(token));
    const productId = stock.body.data.rows[0].productId;

    const clientToken = uuid();
    const body = { entryType: 'RECEIPT', warehouseId: wh.id, clientToken, lines: [{ productId, quantity: 1 }] };
    const first = await api.post('/api/ops/inventory/entries').set(auth(token)).send(body);
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('DRAFT');

    // A second device holds an older view of the same draft; a save must not
    // silently clobber the newer copy.
    const stale = await api.post('/api/ops/inventory/entries').set(auth(token)).send({
      ...body,
      expectedUpdatedAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT');
  });

  it('rejects restricted / security material through quick entry', async () => {
    const { token } = await loginAs('willy.wh');
    const board = await api.get('/api/ops/inventory/warehouses').set(auth(token));
    const wh = board.body.data.find((w: { code: string }) => w.code === 'FG-WH');
    const stock = await api.get('/api/ops/inventory/stock?warehouseId=' + wh.id).set(auth(token));
    const existingId = stock.body.data.rows[0].productId;

    // Learn the tenant/company from an existing product, then create a fresh
    // security-classified product in the same scope so the test is self-contained.
    const scope = await db(`SELECT tenant_id, company_id FROM products WHERE id = $1`, [Number(existingId)]);
    const { tenant_id, company_id } = scope.rows[0];
    const code = `TEST-SEC-${Math.random().toString(16).slice(2, 10)}`;
    const ins = await db(
      `INSERT INTO products (company_id, tenant_id, code, name, type, security_classification)
       VALUES ($1, $2, $3, $4, 'SECURITY_ITEM', 'CONFIDENTIAL') RETURNING id`,
      [company_id, tenant_id, code, 'Test security item']
    );
    const productId = ins.rows[0].id;

    try {
      const res = await api.post('/api/ops/inventory/entries').set(auth(token)).send({
        entryType: 'RECEIPT',
        warehouseId: wh.id,
        clientToken: uuid(),
        action: 'submit',
        lines: [{ productId, quantity: 1 }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Restricted or security material/);
    } finally {
      await db(`DELETE FROM products WHERE id = $1`, [productId]);
    }
  });
});
