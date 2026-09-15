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
});
