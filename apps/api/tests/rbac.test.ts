import { describe, it, expect } from 'vitest';
import { api, auth, loginAs } from './helpers.js';

describe('RBAC: deny by default', () => {
  it('rejects unauthenticated API calls', async () => {
    const res = await api.post('/api/qr/generate').send({ entityType: 'PRODUCT', productId: 3, count: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('blocks a low-privilege user from generating QR codes', async () => {
    const { token } = await loginAs('sso.demo');
    const res = await api.post('/api/qr/generate').set(auth(token)).send({ entityType: 'PRODUCT', productId: 3, count: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('blocks a low-privilege user from viewing CRM customers', async () => {
    const { token } = await loginAs('sso.demo');
    const res = await api.get('/api/crm/customers').set(auth(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lets admin generate an opaque HDG-FG QR code', async () => {
    const { token } = await loginAs('admin');
    const res = await api.post('/api/qr/generate').set(auth(token)).send({ entityType: 'PRODUCT', productId: 3, count: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const qr = res.body.data[0];
    expect(qr.code).toMatch(/^HDG-FG-\d{4}-\d{8}$/);
    expect(qr.secret).toBeTruthy();
    expect(qr.payload).toBe(`${qr.code}|${qr.secret}`);
    expect(qr.status).toBe('ACTIVE');
  });

  it('returns 404 for unknown routes', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/does-not-exist').set(auth(token));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});