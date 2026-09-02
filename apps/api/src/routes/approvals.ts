import { Router } from 'express';
import { query, tx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { ENTITIES } from '../services/entities.js';
import { decideTask, getApprovalsQueue } from '../services/workflow.js';
import { asyncHandler, badRequest } from '../utils.js';

export const approvalsRouter = Router();

const DECISION_PERMISSION: Record<string, string> = {
  APPROVED: 'workflows.instances.approve',
  REJECTED: 'workflows.instances.reject',
  RETURNED: 'workflows.instances.return',
  DELEGATED: 'workflows.instances.delegate',
};

/** Run the full authorization chain (RBAC + SoD + ABAC + scope) for a decision. */
async function authorizeDecision(req: import('express').Request, permission: string) {
  await new Promise<void>((resolve, reject) => {
    requirePermission(permission)(req, {} as import('express').Response, (err?: unknown) =>
      err ? reject(err) : resolve()
    );
  });
}

approvalsRouter.get(
  '/',
  requirePermission('workflows.instances.view'),
  asyncHandler(async (req, res) => {
    const rows = await getApprovalsQueue(req.ctx, req.auth!.id);
    res.json({ data: rows, count: rows.length });
  })
);

approvalsRouter.get(
  '/pending-count',
  requirePermission('workflows.instances.view'),
  asyncHandler(async (req, res) => {
    const rows = await getApprovalsQueue(req.ctx, req.auth!.id);
    res.json({ count: rows.length });
  })
);

approvalsRouter.post(
  '/:taskId/decide',
  asyncHandler(async (req, res) => {
    const taskId = Number(req.params.taskId);
    const decision = String(req.body?.decision ?? '');
    const comment = req.body?.comment != null ? String(req.body.comment) : undefined;
    const delegateToUserId = req.body?.delegateToUserId != null ? Number(req.body.delegateToUserId) : undefined;
    const permission = DECISION_PERMISSION[decision];
    if (!permission) throw badRequest('Invalid decision; expected APPROVED, REJECTED, RETURNED or DELEGATED');

    // Resolve the task scoped to the caller's tenant + company so the ABAC
    // engine can evaluate resource attributes (e.g. owner_user_id) before
    // authorizing the decision. Never trust a bare task id.
    const taskRes = await query(
      `SELECT t.id, i.entity_type, i.entity_id
       FROM approval_tasks t
       JOIN workflow_instances i ON i.id = t.instance_id
       WHERE t.id = $1 AND i.tenant_id = $2 AND i.company_id = $3`,
      [taskId, req.ctx.tenantId, req.ctx.companyId],
      req.ctx
    );
    const task = taskRes.rows[0];
    if (!task) throw badRequest('Approval task not found in your workspace');
    const entity = ENTITIES[String(task.entity_type)];
    if (entity?.ownerColumn) {
      const ownerRes = await query(
        `SELECT ${entity.ownerColumn} AS owner_user_id FROM ${entity.table} WHERE id = $1`,
        [Number(task.entity_id)],
        req.ctx
      );
      req.ctx.resourceAttributes = { owner_user_id: ownerRes.rows[0]?.owner_user_id ?? null };
    }

    await authorizeDecision(req, permission);
    const out = await tx(
      (client) => decideTask(client, req.ctx, taskId, decision as 'APPROVED' | 'REJECTED' | 'RETURNED' | 'DELEGATED', comment, delegateToUserId),
      req.ctx
    );
    res.json({ data: out });
  })
);