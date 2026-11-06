import { describe, it, expect } from 'vitest';
import { api, auth, loginAs } from './helpers.js';

describe('Universal expense initiation', () => {
  it('allows a non-finance employee to create, view and submit only their own expense', async () => {
    const { token } = await loginAs('sarah.sales');

    const meta = await api.get('/api/ops/expenditure/meta').set(auth(token));
    expect(meta.status).toBe(200);
    const category = (meta.body.data.categories ?? [])[0];
    expect(category).toBeTruthy();

    const created = await api.post('/api/ops/expenditure/expenses').set(auth(token)).send({
      description: 'Universal expense initiation integration test',
      amount: 12500,
      currency: 'UGX',
      categoryId: category.id,
      expDate: '2026-11-06',
      isPlanned: true,
    });
    expect(created.status).toBe(200);
    const expenseId = created.body.data.id;
    expect(expenseId).toBeTruthy();

    const detail = await api.get(`/api/ops/expenditure/expenses/${expenseId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.createdBy).toBeTruthy();

    const list = await api.get('/api/ops/expenditure/expenses').set(auth(token));
    expect(list.status).toBe(200);
    expect(list.body.data.rows.some((row: { id: number }) => row.id === expenseId)).toBe(true);

    const submitted = await api.post(`/api/ops/expenditure/expenses/${expenseId}/submit`).set(auth(token)).send({});
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('SUBMITTED');

    // Universal initiation must not confer accounting authority.
    const posting = await api.post(`/api/ops/expenditure/expenses/${expenseId}/post`).set(auth(token)).send({});
    expect(posting.status).toBe(403);
  });
});
