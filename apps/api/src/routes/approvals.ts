import { Router } from 'express';
import { tx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
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
    await authorizeDecision(req, permission);
    const out = await tx(
      (client) => decideTask(client, req.ctx, taskId, decision as 'APPROVED' | 'REJECTED' | 'RETURNED' | 'DELEGATED', comment, delegateToUserId),
      req.ctx
    );
    res.json({ data: out });
  })
);
