import { describe, it, expect, beforeAll } from 'vitest';
import { api, auth, loginAs, findPendingTask } from './helpers.js';

let opsToken: string;
let finToken: string;
let adminToken: string;
let deptId: number;
let costCentreId: number | null = null;

async function createServiceReq(token: string, unitCost: number, purpose: string) {
  return api
    .post('/api/ops/requisitions')
    .set(auth(token))
    .send({
      requestType: 'SERVICE',
      departmentId: deptId,
      requiredDate: '2026-09-30',
      priority: 'NORMAL',
      purpose,
      costCentreId: costCentreId ?? undefined,
      items: [{ itemType: 'SERVICE', description: purpose, quantity: 1, unitCost }],
    });
}

describe('Ops requisition centre', () => {
  beforeAll(async () => {
    opsToken = (await loginAs('opus.ops')).token;
    finToken = (await loginAs('cindy.cfo')).token;
    adminToken = (await loginAs('admin')).token;
    const meta = await api.get('/api/ops/requisitions/meta').set(auth(opsToken));
    expect(meta.status).toBe(200);
    expect(meta.body.data.departments.length).toBeGreaterThan(0);
    deptId = meta.body.data.departments[0].id;
    costCentreId = meta.body.data.costCentres[0]?.id ?? null;
  });

  it('smart item lookup returns live stock position and a fulfilment recommendation', async () => {
    const res = await api.get('/api/ops/requisitions/items?q=paper').set(auth(opsToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const first = res.body.data[0];
    expect(first).toBeTruthy();
    expect(typeof first.onHandQty).toBe('number');
    expect(typeof first.reservedQty).toBe('number');
    expect(typeof first.availableToIssue).toBe('number');
    expect(['STORE_ISSUE', 'PURCHASE']).toContain(first.recommendation);
  });

  it('creates, submits and approves a low-value service requisition', async () => {
    const create = await createServiceReq(opsToken, 250000, `Integration service req ${Date.now()}`);
    expect(create.status).toBe(200);
    const id = Number(create.body.data.id);
    expect(create.body.data.reqNo).toMatch(/^REQ-/);
    expect(create.body.data.status).toBe('DRAFT');

    const submit = await api.post(`/api/ops/requisitions/${id}/submit`).set(auth(opsToken)).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.status).toBe('SUBMITTED');

    const taskId = await findPendingTask(finToken, 'ops.requisitions', id, 1);
    expect(taskId).not.toBeNull();
    const decide = await api
      .post(`/api/approvals/${taskId}/decide`)
      .set(auth(finToken))
      .send({ decision: 'APPROVED', comment: 'approved by integration test' });
    expect(decide.status).toBe(200);
    expect(decide.body.data.status).toBe('APPROVED');
    expect(decide.body.data.completed).toBe(true);

    const detail = await api.get(`/api/ops/requisitions/${id}`).set(auth(opsToken));
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe('APPROVED');
  });

  it('routes higher-value requisitions through two approval steps', async () => {
    const create = await createServiceReq(adminToken, 1000000, `Two-step service req ${Date.now()}`);
    expect(create.status).toBe(200);
    const id = Number(create.body.data.id);

    const submit = await api.post(`/api/ops/requisitions/${id}/submit`).set(auth(adminToken)).send({});
    expect(submit.status).toBe(200);

    // Step 1: operations director (admin is the requester, so no SoD conflict).
    const step1 = await findPendingTask(opsToken, 'ops.requisitions', id, 1);
    expect(step1).not.toBeNull();
    const d1 = await api.post(`/api/approvals/${step1}/decide`).set(auth(opsToken)).send({ decision: 'APPROVED' });
    expect(d1.status).toBe(200);
    expect(d1.body.data.completed).toBe(false);

    // Step 2: finance manager completes the chain.
    const step2 = await findPendingTask(finToken, 'ops.requisitions', id, 2);
    expect(step2).not.toBeNull();
    const d2 = await api.post(`/api/approvals/${step2}/decide`).set(auth(finToken)).send({ decision: 'APPROVED' });
    expect(d2.status).toBe(200);
    expect(d2.body.data.status).toBe('APPROVED');
    expect(d2.body.data.completed).toBe(true);

    const detail = await api.get(`/api/ops/requisitions/${id}`).set(auth(adminToken));
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe('APPROVED');
  });

  it('blocks the requester from approving their own requisition (segregation of duties)', async () => {
    const create = await createServiceReq(opsToken, 1000000, `SoD service req ${Date.now()}`);
    expect(create.status).toBe(200);
    const id = Number(create.body.data.id);

    const submit = await api.post(`/api/ops/requisitions/${id}/submit`).set(auth(opsToken)).send({});
    expect(submit.status).toBe(200);

    const taskId = await findPendingTask(opsToken, 'ops.requisitions', id, 1);
    expect(taskId).not.toBeNull();
    const decide = await api.post(`/api/approvals/${taskId}/decide`).set(auth(opsToken)).send({ decision: 'APPROVED' });
    expect(decide.status).toBe(403);
    expect(decide.body.error.message).toMatch(/Segregation of duties|ABAC-NO-SELF-APPROVE/i);
  });
});