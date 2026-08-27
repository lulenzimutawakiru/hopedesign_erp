import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, findPendingTask } from './helpers.js';

describe('Security printing workflow (dual control)', () => {
  it('runs the secure job approval chain with dual control', async () => {
    const sam = await loginAs('sam.secure');
    const approver = await loginAs('secure.approver');

    // Create a classified secure job as the security printing manager.
    const create = await api.post('/api/ops/security/jobs').set(auth(sam.token)).send({
      customerId: 1,
      description: `API test secure job ${Date.now()}`,
      securityClassification: 'CONFIDENTIAL',
      quantityPlanned: 1000,
      requirements: [{ productId: 5, quantityRequired: 500, unitCost: 2000 }],
    });
    expect(create.status).toBe(200);
    const jobId = create.body.data.jobId;
    expect(create.body.data.jobNo).toMatch(/^SJ-\d{4}-\d{8}$/);

    const submit = await api.post(`/api/ops/security/jobs/${jobId}/submit`).set(auth(sam.token)).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.total).toBe(1000000);

    // Step 1: the secure job approver approves the job.
    const step1Task = await findPendingTask(approver.token, 'security_printing.jobs', jobId, 1);
    expect(step1Task).not.toBeNull();
    const step1 = await api
      .post(`/api/approvals/${step1Task}/decide`)
      .set(auth(approver.token))
      .send({ decision: 'APPROVED' });
    expect(step1.status).toBe(200);
    expect(step1.body.data.status).toBe('APPROVED');
    expect(step1.body.data.completed).toBe(false);

    // The job detail reflects the approval and records a custody event.
    const detail = await api.get(`/api/ops/security/jobs/${jobId}/detail`).set(auth(sam.token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.job.status).toBe('APPROVED');
    const custodyTypes = detail.body.data.custody.map(
      (c: { event_type: string }) => c.event_type
    );
    expect(custodyTypes).toContain('JOB_APPROVED');

    // Step 2: materials authorization is dual control - the same approver is blocked.
    const step2Task = await findPendingTask(approver.token, 'security_printing.jobs', jobId, 2);
    expect(step2Task).not.toBeNull();
    const step2 = await api
      .post(`/api/approvals/${step2Task}/decide`)
      .set(auth(approver.token))
      .send({ decision: 'APPROVED' });
    expect(step2.status).toBe(403);
    expect(step2.body.error.code).toBe('FORBIDDEN');
    expect(step2.body.error.message).toMatch(/Dual control/i);
  });
});