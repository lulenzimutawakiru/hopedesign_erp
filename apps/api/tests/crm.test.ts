import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, db } from './helpers.js';

async function productId(): Promise<number> {
  const res = await db(`SELECT id FROM products WHERE code = 'A4-80' UNION ALL SELECT id FROM products LIMIT 1`);
  expect(res.rows[0]).toBeTruthy();
  return Number(res.rows[0].id);
}

describe('CRM lead to quote', () => {
  it('converts a lead into an account and quotes the opportunity', async () => {
    const { token } = await loginAs('sarah.sales');
    const sku = await productId();

    const lead = await api.post('/api/ops/crm/leads').set(auth(token)).send({
      companyName: 'Nile Stationery Co',
      firstName: 'Amina',
      lastName: 'Okello',
      source: 'REFERRAL',
      value: 2400000,
    });
    expect(lead.status).toBe(200);
    const leadId = Number(lead.body.data.leadId);

    const qualified = await api.post(`/api/ops/crm/leads/${leadId}/qualify`).set(auth(token)).send({});
    expect(qualified.status).toBe(200);

    const converted = await api.post(`/api/ops/crm/leads/${leadId}/convert`).set(auth(token)).send({
      createOpportunity: true,
      amount: 2400000,
    });
    expect(converted.status).toBe(200);
    expect(Number(converted.body.data.customerId)).toBeGreaterThan(0);
    expect(Number(converted.body.data.opportunityId)).toBeGreaterThan(0);

    const oppId = Number(converted.body.data.opportunityId);
    const moved = await api.post(`/api/ops/crm/opportunities/${oppId}/move`).set(auth(token)).send({
      stage: 'NEGOTIATION',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.data.stage).toBe('NEGOTIATION');

    const quote = await api.post(`/api/ops/crm/opportunities/${oppId}/quote`).set(auth(token)).send({
      items: [{ productId: sku, quantity: 10, unitPrice: 12000 }],
    });
    expect(quote.status).toBe(200);
    expect(Number(quote.body.data.quotationId)).toBeGreaterThan(0);
    expect(quote.body.data.credit.ok).toBe(true);

    const detail = await api.get(`/api/ops/crm/opportunities/${oppId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.quotations.length).toBeGreaterThanOrEqual(1);
    expect(detail.body.data.opportunity.stage).toBe('NEGOTIATION');

    const account = await api.get(`/api/ops/crm/customers/${converted.body.data.customerId}`).set(auth(token));
    expect(account.status).toBe(200);
    expect(account.body.data.customer.code).toMatch(/^CUST/);
    expect(account.body.data.credit.ok).toBe(true);
  });

  it('blocks a quote when the account is credit-held', async () => {
    const { token } = await loginAs('sarah.sales');
    const sku = await productId();
    const created = await api.post('/api/ops/crm/customers').set(auth(token)).send({
      name: 'Blocked Buyer Ltd',
      creditLimit: 1000,
    });
    expect(created.status).toBe(200);
    const customerId = Number(created.body.data.customerId);

    const opp = await api.post('/api/ops/crm/opportunities').set(auth(token)).send({
      customerId,
      name: 'Blocked deal',
      amount: 50000,
    });
    expect(opp.status).toBe(200);

    const held = await api.post(`/api/ops/crm/customers/${customerId}/status`).set(auth(token)).send({
      status: 'BLOCKED',
      reason: 'Credit review',
    });
    expect(held.status).toBe(200);

    const quote = await api.post(`/api/ops/crm/opportunities/${opp.body.data.opportunityId}/quote`).set(auth(token)).send({
      items: [{ productId: sku, quantity: 1, unitPrice: 50000 }],
    });
    expect(quote.status).toBe(400);
    expect(quote.body.error.message).toMatch(/BLOCKED|cannot trade|Credit/i);
  });

  it('exposes the board, pipeline, and open activities', async () => {
    const { token } = await loginAs('sarah.sales');
    const board = await api.get('/api/ops/crm/board').set(auth(token));
    expect(board.status).toBe(200);
    expect(board.body.data.kpis).toBeTruthy();
    expect(Array.isArray(board.body.data.leads)).toBe(true);

    const pipe = await api.get('/api/ops/crm/pipeline').set(auth(token));
    expect(pipe.status).toBe(200);
    expect(Array.isArray(pipe.body.data.columns)).toBe(true);
    expect(pipe.body.data.columns.length).toBeGreaterThanOrEqual(5);

    const created = await api.post('/api/ops/crm/customers').set(auth(token)).send({ name: 'Follow-up Desk' });
    const act = await api.post('/api/ops/crm/activities').set(auth(token)).send({
      entityType: 'customers',
      entityId: created.body.data.customerId,
      activityType: 'FOLLOW_UP',
      subject: 'Call about A4 contract',
    });
    expect(act.status).toBe(200);
    const done = await api.post(`/api/ops/crm/activities/${act.body.data.activityId}/complete`).set(auth(token)).send({});
    expect(done.status).toBe(200);
    expect(done.body.data.done).toBe(true);
  });
});

describe('CRM enterprise desk', () => {
  it('detects duplicate accounts and blocks via the status API', async () => {
    const { token } = await loginAs('sarah.sales');
    const stamp = Date.now();
    const created = await api.post('/api/ops/crm/customers').set(auth(token)).send({
      name: `Twin Paper ${stamp}`,
      email: `twin.${stamp}@hopedesign.test`,
      phone: '0772000001',
    });
    expect(created.status).toBe(200);

    const again = await api.post('/api/ops/crm/customers').set(auth(token)).send({
      name: `Twin Paper ${stamp}`,
      email: `twin.${stamp}@hopedesign.test`,
    });
    expect(again.status).toBe(200);
    expect(again.body.data.duplicates.customers.length).toBeGreaterThan(0);

    const hits = await api.get('/api/ops/crm/duplicates')
      .query({ email: `twin.${stamp}@hopedesign.test` })
      .set(auth(token));
    expect(hits.status).toBe(200);
    expect(hits.body.data.customers.length).toBeGreaterThanOrEqual(1);

    const blocked = await api.post(`/api/ops/crm/customers/${created.body.data.customerId}/status`)
      .set(auth(token))
      .send({ status: 'BLOCKED', reason: 'Credit review' });
    expect(blocked.status).toBe(200);
    expect(blocked.body.data.status).toBe('BLOCKED');

    const account = await api.get(`/api/ops/crm/customers/${created.body.data.customerId}`).set(auth(token));
    expect(account.status).toBe(200);
    expect(account.body.data.customer.status).toBe('BLOCKED');
    expect(account.body.data.health.score).toBe(0);
    expect(account.body.data.credit.ok).toBe(false);
    expect(Array.isArray(account.body.data.timeline)).toBe(true);
    expect(account.body.data.aging).toBeTruthy();

    const opp = await api.post('/api/ops/crm/opportunities').set(auth(token)).send({
      customerId: created.body.data.customerId,
      name: 'Should not open on blocked',
      amount: 10000,
    });
    expect(opp.status).toBe(400);
  });

  it('disqualifies a lead and refuses conversion', async () => {
    const { token } = await loginAs('sarah.sales');
    const lead = await api.post('/api/ops/crm/leads').set(auth(token)).send({
      companyName: 'Lost Prospect Ltd',
      source: 'COLD_CALL',
    });
    expect(lead.status).toBe(200);
    expect(Number(lead.body.data.score)).toBeGreaterThan(0);

    const contacted = await api.post(`/api/ops/crm/leads/${lead.body.data.leadId}/contact`).set(auth(token)).send({});
    expect(contacted.status).toBe(200);
    expect(contacted.body.data.status).toBe('CONTACTED');

    const dq = await api.post(`/api/ops/crm/leads/${lead.body.data.leadId}/disqualify`)
      .set(auth(token))
      .send({ reason: 'Budget gone' });
    expect(dq.status).toBe(200);

    const convert = await api.post(`/api/ops/crm/leads/${lead.body.data.leadId}/convert`).set(auth(token)).send({});
    expect(convert.status).toBe(400);
  });

  it('holds an opportunity, then exposes analytics and my desk', async () => {
    const { token, user } = await loginAs('sarah.sales');
    const created = await api.post('/api/ops/crm/customers').set(auth(token)).send({ name: 'Hold Desk Ltd' });
    const opp = await api.post('/api/ops/crm/opportunities').set(auth(token)).send({
      customerId: created.body.data.customerId,
      name: 'Held print contract',
      amount: 900000,
    });
    expect(opp.status).toBe(200);

    const held = await api.post(`/api/ops/crm/opportunities/${opp.body.data.opportunityId}/hold`)
      .set(auth(token))
      .send({ reason: 'Waiting on credit' });
    expect(held.status).toBe(200);
    expect(held.body.data.status).toBe('ON_HOLD');

    const quote = await api.post(`/api/ops/crm/opportunities/${opp.body.data.opportunityId}/quote`)
      .set(auth(token))
      .send({ items: [{ productId: 1, quantity: 1, unitPrice: 1000 }] });
    expect(quote.status).toBe(400);

    const resumed = await api.post(`/api/ops/crm/opportunities/${opp.body.data.opportunityId}/resume`)
      .set(auth(token))
      .send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.status).toBe('OPEN');

    if (user?.id) {
      const assigned = await api.post(`/api/ops/crm/opportunities/${opp.body.data.opportunityId}/assign`)
        .set(auth(token))
        .send({ userId: user.id });
      expect(assigned.status).toBe(200);
    }

    const analytics = await api.get('/api/ops/crm/analytics').set(auth(token));
    expect(analytics.status).toBe(200);
    expect(analytics.body.data.funnel).toBeTruthy();
    expect(analytics.body.data.forecast).toBeTruthy();
    expect(analytics.body.data.aging).toBeTruthy();

    const mine = await api.get('/api/ops/crm/mine').set(auth(token));
    expect(mine.status).toBe(200);
    expect(mine.body.data.kpis).toBeTruthy();
    expect(Array.isArray(mine.body.data.leads)).toBe(true);

    const products = await api.get('/api/ops/crm/products').set(auth(token));
    expect(products.status).toBe(200);
    expect(products.body.data[0]).toHaveProperty('availableQty');
  });
});
