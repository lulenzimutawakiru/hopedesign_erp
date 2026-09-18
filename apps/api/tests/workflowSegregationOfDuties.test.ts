import { describe, it, expect, afterAll } from 'vitest';
import { api, auth, loginAs, db } from './helpers.js';

/**
 * Segregation of duties across the stages of one approval chain.
 *
 * startWorkflow seeds every applicable step as PENDING at submission time, and a
 * role-based step is decidable by anyone holding that role code. A user holding
 * two role codes that appear on different steps would otherwise be able to clear
 * more than one stage of the same document. decideTask rejects that.
 *
 * Every fixture is a dedicated three-stage instance built on a real submitted
 * requisition. Only the first two stages are ever decided, so the instance cannot
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
});