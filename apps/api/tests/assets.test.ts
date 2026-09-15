import { describe, it, expect } from 'vitest';
import { api, auth, loginAs } from './helpers.js';

describe('Asset management', () => {
  it('records field verification without violating asset_scans.result', async () => {
    const { token } = await loginAs('admin');
    const list = await api.get('/api/ops/assets?pageSize=5').set(auth(token));
    expect(list.status).toBe(200);
    const row = (list.body.data.rows ?? list.body.data)[0];
    expect(row).toBeTruthy();
    const id = Number(row.id);

    const verified = await api.post('/api/ops/assets/verification/verify').set(auth(token)).send({
      assetId: id,
      result: 'VERIFIED',
      note: 'test authentic scan',
    });
    expect(verified.status).toBe(200);
    expect(verified.body.data.result).toBe('VERIFIED');

    const exception = await api.post('/api/ops/assets/verification/verify').set(auth(token)).send({
      assetId: id,
      result: 'WRONG_LOCATION',
      note: 'test suspicious scan',
    });
    expect(exception.status).toBe(200);
    expect(exception.body.data.result).toBe('WRONG_LOCATION');
  });

  it('creates, updates and deletes a draft asset', async () => {
    const { token } = await loginAs('admin');
    const name = 'CRUD test asset ' + Date.now();
    const created = await api.post('/api/ops/assets').set(auth(token)).send({ name, condition: 'NEW' });
    expect(created.status).toBe(200);
    const id = Number(created.body.data.assetId);
    expect(created.body.data.status).toBe('DRAFT');
    expect(created.body.data.assetNo).toBeTruthy();

    const desk = await api.get(`/api/ops/assets/${id}`).set(auth(token));
    expect(desk.status).toBe(200);
    expect(desk.body.data.asset.name).toBe(name);

    const updated = await api.patch(`/api/ops/assets/${id}`).set(auth(token)).send({
      name: name + ' updated',
      condition: 'GOOD',
      operationalState: 'IDLE',
    });
    expect(updated.status).toBe(200);

    const after = await api.get(`/api/ops/assets/${id}`).set(auth(token));
    expect(after.body.data.asset.name).toBe(name + ' updated');
    expect(after.body.data.asset.condition).toBe('GOOD');

    const del = await api.delete(`/api/ops/assets/${id}`).set(auth(token)).send({ reason: 'CRUD test cleanup' });
    expect(del.status).toBe(200);
    expect(del.body.data.deleted).toBe(true);

    const list = await api.get('/api/ops/assets?pageSize=100').set(auth(token));
    const rows = list.body.data.rows ?? [];
    expect(rows.some((r: { id: number }) => Number(r.id) === id)).toBe(false);
  });

  it('refuses to delete a live asset', async () => {
    const { token } = await loginAs('admin');
    const list = await api.get('/api/ops/assets?pageSize=50').set(auth(token));
    const live = (list.body.data.rows ?? []).find((r: { status: string }) => r.status && r.status !== 'DRAFT');
    if (!live) return;
    const res = await api.delete(`/api/ops/assets/${live.id}`).set(auth(token)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/draft/i);
  });
});
