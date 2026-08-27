import { describe, it, expect } from 'vitest';
import { api, auth, loginAs } from './helpers.js';

interface QrRow {
  id: number;
  code: string;
  secret: string;
  payload: string;
  status: string;
}

describe('QR lifecycle, anti-counterfeit verification and traceability', () => {
  it('verifies a generated QR as AUTHENTIC then ALREADY_VERIFIED via the public portal', async () => {
    const { token } = await loginAs('admin');
    const gen = await api.post('/api/qr/generate').set(auth(token)).send({ entityType: 'PRODUCT', productId: 3, count: 1 });
    expect(gen.status).toBe(200);
    const qr: QrRow = gen.body.data[0];

    // Operational scan authenticates the QR and returns a scan id.
    const scan = await api.post('/api/qr/scan').set(auth(token)).send({ code: qr.code, action: 'VERIFY' });
    expect(scan.status).toBe(200);
    expect(scan.body.data.qrId).toBe(qr.id);
    expect(scan.body.data.result).toBe('AUTHENTIC');
    expect(typeof scan.body.data.scanId).toBe('number');

    // Public verification: first scan AUTHENTIC, second ALREADY_VERIFIED.
    const v1 = await api.post('/api/public/verify').send({ payload: qr.payload });
    expect(v1.status).toBe(200);
    expect(v1.body.data.result).toBe('AUTHENTIC');
    expect(v1.body.data.code).toBe(qr.code);
    // Public verification must not leak confidential internals.
    expect(v1.body.data).not.toHaveProperty('secret');
    expect(v1.body.data).not.toHaveProperty('secret_hash');
    expect(v1.body.data).not.toHaveProperty('cost');

    const v2 = await api.post('/api/public/verify').send({ payload: qr.payload });
    expect(v2.status).toBe(200);
    expect(v2.body.data.result).toBe('ALREADY_VERIFIED');

    // An unknown/fake payload returns UNKNOWN.
    const fake = await api.post('/api/public/verify').send({ payload: 'NOPE|FAKE' });
    expect(fake.status).toBe(200);
    expect(fake.body.data.result).toBe('UNKNOWN');

    // Traceability returns the QR plus movement/custody arrays.
    const tr = await api.get(`/api/qr/traceability/${qr.code}`).set(auth(token));
    expect(tr.status).toBe(200);
    expect(tr.body.data.qr.qrCode).toBe(qr.code);
    expect(Array.isArray(tr.body.data.movements)).toBe(true);
    expect(Array.isArray(tr.body.data.custodyEvents)).toBe(true);
  });

  it('voids a QR and reports VOID on later scans', async () => {
    const { token } = await loginAs('admin');
    const gen = await api.post('/api/qr/generate').set(auth(token)).send({ entityType: 'PRODUCT', productId: 3, count: 1 });
    expect(gen.status).toBe(200);
    const qr: QrRow = gen.body.data[0];

    const voidRes = await api.post(`/api/qr/${qr.id}/void`).set(auth(token)).send({ reason: 'test void' });
    expect(voidRes.status).toBe(200);

    const scan = await api.post('/api/qr/scan').set(auth(token)).send({ code: qr.code });
    expect(scan.status).toBe(200);
    expect(scan.body.data.result).toBe('VOID');
    expect(scan.body.data.status).toBe('VOID');
  });

  it('returns 404 for unknown traceability codes', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/qr/traceability/HDG-FG-2099-99999999').set(auth(token));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});