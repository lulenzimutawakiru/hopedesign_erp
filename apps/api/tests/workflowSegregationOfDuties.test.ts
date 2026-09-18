import { describe, it, expect, afterAll } from 'vitest';
import { api, auth, loginAs, db } from './helpers.js';

/**
 * Chain-integrity rules across the stages of one approval chain.
 *
 * startWorkflow seeds every applicable step as PENDING at submission time, and a
 * role-based step is decidable by anyone holding that role code. A user holding
 * two role codes that appear on different steps would otherwise be able to clear
 * more than one stage of the same document. decideTask rejects that.
 *
 * The same seeding also makes the steps order-independent: without a guard an
 * approver could clear the final stage first, which would complete the chain and
 * release the document with the earlier sign-offs never given. decideTask
 * rejects that too.
 *
 * Every fixture is a dedicated three-stage instance built on a real submitted
 * requisition. No test ever decides the final stage, so the instance cannot
 * complete and the requisition row is never transitioned by these tests.
 */

const FIRST_APPROVER = 'cindy.cfo';
const SECOND_APPROVER = 'percy.proc';
const createdInstances: number[] = [];

async function userByUsername(username: string) {
  const res = await db('SELECT id, company_id, tenant_id FROM users WHERE username = $1 LIMIT 1', [username]);
  const row = res.rows[0];
  if (!row) throw new Error(`test fixture missing user ${username}`);
  return { id: Number(row.id), companyId: Number(row.company_id), tenantId: Number(row.tenant_id) };
}

/** A submitted requisition owned by a third party, so no approver under test
 *  trips the requester-cannot-decide-their-own-submission rule. */
async function fixtureRequisition(companyId: number, excluded: number[]) {
  const res = await db(
    `SELECT id, status, requested_by FROM requisitions
      WHERE company_id = $1 AND status = 'SUBMITTED'
        AND requested_by IS NOT NULL AND NOT (requested_by = ANY($2::bigint[]))
      ORDER BY id DESC LIMIT 1`,
    [companyId, excluded]
  );
  const row = res.rows[0];
  if (!row) throw new Error('test fixture missing a submitted requisition owned by a non-approver');
  return { id: Number(row.id), status: String(row.status), ownerId: Number(row.requested_by) };
}

async function fixtureWorkflow(companyId: number) {
  const res = await db(
    `SELECT id FROM workflows WHERE company_id = $1 AND entity_type = 'ops.requisitions' ORDER BY id LIMIT 1`,
    [companyId]
  );
  const row = res.rows[0];
  if (!row) throw new Error('test fixture missing the ops.requisitions workflow');
  return Number(row.id);
}

/**
 * One fresh RUNNING instance carrying three PENDING stages, each bound to a named
 * user rather than a role so the test does not depend on who holds which role.
 * Stage three is never decided, which keeps the chain open.
 */
async function fixtureChain(firstApproverId: number, secondApproverId: number, thirdApproverId: number) {
  const actor = await userByUsername(FIRST_APPROVER);
  const excluded = [...new Set([firstApproverId, secondApproverId, thirdApproverId])];
  const requisition = await fixtureRequisition(actor.companyId, excluded);
  const workflowId = await fixtureWorkflow(actor.companyId);

  const inst = await db(
    `INSERT INTO workflow_instances
       (company_id, tenant_id, workflow_id, entity_type, entity_id, entity_code, status, current_step, created_by)
     VALUES ($1, $2, $3, 'ops.requisitions', $4, $5, 'RUNNING', 1, $6)
     RETURNING id`,
    [actor.companyId, actor.tenantId, workflowId, requisition.id, `SOD-TEST-${Date.now()}`, requisition.ownerId]
  );
  const instanceId = Number(inst.rows[0].id);
  createdInstances.push(instanceId);

  const stage = async (stepSeq: number, stepName: string, approverId: number) => {
    const res = await db(
      `INSERT INTO approval_tasks
         (instance_id, step_seq, step_name, approver_role_id, approver_user_id, status, due_at)
       VALUES ($1, $2, $3, NULL, $4, 'PENDING', now() + interval '48 hours')
       RETURNING id`,
      [instanceId, stepSeq, stepName, approverId]
    );
    return Number(res.rows[0].id);
  };

  return {
    instanceId,
    requisitionId: requisition.id,
    firstTaskId: await stage(1, 'Stage One Verification', firstApproverId),
    secondTaskId: await stage(2, 'Stage Two Authorization', secondApproverId),
    thirdTaskId: await stage(3, 'Stage Three Release', thirdApproverId),
  };
}

afterAll(async () => {
  for (const instanceId of createdInstances) {
    await db('DELETE FROM approval_tasks WHERE instance_id = $1', [instanceId]);
    await db('DELETE FROM workflow_instances WHERE id = $1', [instanceId]);
  }
});

describe('Approval chain segregation of duties', () => {
  it('lets a user decide one stage and then blocks them on a later stage', async () => {
    const approver = await userByUsername(FIRST_APPROVER);
    const chain = await fixtureChain(approver.id, approver.id, approver.id);
    const { token } = await loginAs(FIRST_APPROVER);

    const first = await api
      .post(`/api/approvals/${chain.firstTaskId}/decide`)
      .set(auth(token))
      .send({ decision: 'APPROVED', comment: 'stage one cleared' });
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('APPROVED');

    const second = await api
      .post(`/api/approvals/${chain.secondTaskId}/decide`)
      .set(auth(token))
      .send({ decision: 'APPROVED', comment: 'must not be accepted' });
    expect(second.status).toBe(403);
    expect(String(second.body.error.message)).toMatch(/already decided an earlier step/i);

    const blocked = await db('SELECT status, decided_by FROM approval_tasks WHERE id = $1', [chain.secondTaskId]);
    expect(blocked.rows[0].status).toBe('PENDING');
    expect(blocked.rows[0].decided_by).toBeNull();

    const untouched = await db('SELECT status FROM requisitions WHERE id = $1', [chain.requisitionId]);
    expect(untouched.rows[0].status).toBe('SUBMITTED');
  });

  it('does not block a different user from deciding a later stage', async () => {
    const first = await userByUsername(FIRST_APPROVER);
    const second = await userByUsername(SECOND_APPROVER);
    const chain = await fixtureChain(first.id, second.id, second.id);

    const firstToken = (await loginAs(FIRST_APPROVER)).token;
    const firstDecision = await api
      .post(`/api/approvals/${chain.firstTaskId}/decide`)
      .set(auth(firstToken))
      .send({ decision: 'APPROVED', comment: 'stage one cleared' });
    expect(firstDecision.status).toBe(200);

    const secondToken = (await loginAs(SECOND_APPROVER)).token;
    const secondDecision = await api
      .post(`/api/approvals/${chain.secondTaskId}/decide`)
      .set(auth(secondToken))
      .send({ decision: 'APPROVED', comment: 'stage two cleared by a second approver' });
    expect(secondDecision.status).toBe(200);
    expect(secondDecision.body.data.status).toBe('APPROVED');
    expect(secondDecision.body.data.completed).toBe(false);

    const untouched = await db('SELECT status FROM requisitions WHERE id = $1', [chain.requisitionId]);
    expect(untouched.rows[0].status).toBe('SUBMITTED');
  });

  it('blocks deciding the final stage while an earlier stage is still pending', async () => {
    const first = await userByUsername(FIRST_APPROVER);
    const second = await userByUsername(SECOND_APPROVER);
    const chain = await fixtureChain(first.id, second.id, second.id);

    // A different user from the one who would decide the earlier stages, so the
    // segregation-of-duties rules are not what rejects this decision.
    const token = (await loginAs(SECOND_APPROVER)).token;
    const outOfOrder = await api
      .post(`/api/approvals/${chain.thirdTaskId}/decide`)
      .set(auth(token))
      .send({ decision: 'APPROVED', comment: 'must not be accepted out of order' });
    expect(outOfOrder.status).toBe(403);
    expect(outOfOrder.body.error.code).toBe('FORBIDDEN');
    expect(String(outOfOrder.body.error.message)).toMatch(/out of order/i);

    const blocked = await db('SELECT status, decided_by FROM approval_tasks WHERE id = $1', [chain.thirdTaskId]);
    expect(blocked.rows[0].status).toBe('PENDING');
    expect(blocked.rows[0].decided_by).toBeNull();

    const untouched = await db('SELECT status FROM requisitions WHERE id = $1', [chain.requisitionId]);
    expect(untouched.rows[0].status).toBe('SUBMITTED');
  });
});
/**
 * The queue annotation that lets the UI explain a chain rule instead of
 * offering a button the API will refuse. getApprovalsQueue derives `actionable`
 * and `blocked_reason` from the same two conditions decideTask enforces, so the
 * two must agree: whatever the annotation calls blocked, a decision must fail,
 * and whatever it calls actionable, a decision must succeed.
 */
describe('Approval queue actionability annotation', () => {
  /** The queue row for one task, exactly as the signed-in user is served it. */
  async function queueRow(token: string, taskId: number) {
    const res = await api.get('/api/approvals').set(auth(token));
    expect(res.status).toBe(200);
    return res.body.data.find((r: { task_id: unknown }) => Number(r.task_id) === taskId);
  }

  it('leaves a first stage actionable', async () => {
    const first = await userByUsername(FIRST_APPROVER);
    const second = await userByUsername(SECOND_APPROVER);
    const chain = await fixtureChain(first.id, second.id, second.id);

    const row = await queueRow((await loginAs(FIRST_APPROVER)).token, chain.firstTaskId);
    expect(row).toBeTruthy();
    expect(row.actionable).toBe(true);
    expect(row.blocked_reason).toBeNull();
  });

  it('marks a later stage as waiting while an earlier stage is still open', async () => {
    const first = await userByUsername(FIRST_APPROVER);
    const second = await userByUsername(SECOND_APPROVER);
    const chain = await fixtureChain(first.id, second.id, second.id);

    const row = await queueRow((await loginAs(SECOND_APPROVER)).token, chain.secondTaskId);
    expect(row).toBeTruthy();
    expect(row.actionable).toBe(false);
    expect(row.blocked_reason).toBe('EARLIER_STEP_PENDING');

    // The row stays visible so the holder knows the document is coming, and the
    // annotation matches what a decision would do.
    const attempt = await api
      .post(`/api/approvals/${chain.secondTaskId}/decide`)
      .set(auth((await loginAs(SECOND_APPROVER)).token))
      .send({ decision: 'APPROVED', comment: 'must not be accepted out of order' });
    expect(attempt.status).toBe(403);
  });

  it('moves a later stage from waiting to actionable once the earlier stage clears', async () => {
    const first = await userByUsername(FIRST_APPROVER);
    const second = await userByUsername(SECOND_APPROVER);
    const chain = await fixtureChain(first.id, second.id, second.id);
    const secondToken = (await loginAs(SECOND_APPROVER)).token;

    const before = await queueRow(secondToken, chain.secondTaskId);
    expect(before.actionable).toBe(false);
    expect(before.blocked_reason).toBe('EARLIER_STEP_PENDING');

    const cleared = await api
      .post(`/api/approvals/${chain.firstTaskId}/decide`)
      .set(auth((await loginAs(FIRST_APPROVER)).token))
      .send({ decision: 'APPROVED', comment: 'stage one cleared' });
    expect(cleared.status).toBe(200);

    const after = await queueRow(secondToken, chain.secondTaskId);
    expect(after.actionable).toBe(true);
    expect(after.blocked_reason).toBeNull();
  });

  it('reports the segregation-of-duties rule once the holder decided an earlier stage', async () => {
    const approver = await userByUsername(FIRST_APPROVER);
    const chain = await fixtureChain(approver.id, approver.id, approver.id);
    const { token } = await loginAs(FIRST_APPROVER);

    const before = await queueRow(token, chain.secondTaskId);
    expect(before.actionable).toBe(false);
    expect(before.blocked_reason).toBe('EARLIER_STEP_PENDING');

    const decided = await api
      .post(`/api/approvals/${chain.firstTaskId}/decide`)
      .set(auth(token))
      .send({ decision: 'APPROVED', comment: 'stage one cleared' });
    expect(decided.status).toBe(200);

    // The reason changes from "not your turn yet" to "not yours to decide",
    // which is what the user needs to be told instead of a bare refusal.
    const after = await queueRow(token, chain.secondTaskId);
    expect(after.actionable).toBe(false);
    expect(after.blocked_reason).toBe('ALREADY_DECIDED_EARLIER_STEP');

    const attempt = await api
      .post(`/api/approvals/${chain.secondTaskId}/decide`)
      .set(auth(token))
      .send({ decision: 'APPROVED', comment: 'must not be accepted' });
    expect(attempt.status).toBe(403);
    expect(String(attempt.body.error.message)).toMatch(/already decided an earlier step/i);
  });
});