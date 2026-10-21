import { Router } from 'express';
import pg from 'pg';
import { query, tx, Ctx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import * as ex from '../services/approvalExceptions.js';
import { asyncHandler, badRequest } from '../utils.js';

export const approvalExceptionsRouter = Router();

type OpFn = (
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>,
  params: Record<string, string>
) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

const reasonOf = (b: Record<string, unknown>): string | null =>
  b.reason != null && String(b.reason).trim().length > 0 ? String(b.reason) : null;

approvalExceptionsRouter.get(
  '/',
  requirePermission('workflows.exceptions.view'),
  asyncHandler(async (req, res) => {
    const out = await tx((client) =>
      ex.listApprovalExceptions(client, req.ctx, {
        status: req.query.status != null && String(req.query.status).length > 0 ? String(req.query.status) : null,
        entityType: req.query.entityType != null && String(req.query.entityType).length > 0 ? String(req.query.entityType) : null,
        entityId: req.query.entityId != null ? Number(req.query.entityId) : null,
      }), req.ctx);
    res.json({ data: out, count: out.length });
  })
);

approvalExceptionsRouter.get(
  '/:id',
  requirePermission('workflows.exceptions.view'),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => ex.getApprovalExceptionDetail(client, req.ctx, Number(req.params.id)), req.ctx);
    res.json({ data: out });
  })
);

approvalExceptionsRouter.post('/', ...run('workflows.exceptions.create', (c, ctx, b) => ex.createApprovalException(c, ctx, b)));

approvalExceptionsRouter.post('/:id/approve', ...run('workflows.exceptions.approve', (c, ctx, b, p) => ex.approveApprovalException(c, ctx, Number(p.id), reasonOf(b))));
approvalExceptionsRouter.post('/:id/reject', ...run('workflows.exceptions.reject', (c, ctx, b, p) => ex.rejectApprovalException(c, ctx, Number(p.id), reasonOf(b))));
approvalExceptionsRouter.post('/:id/expire', ...run('workflows.exceptions.expire', (c, ctx, b, p) => ex.expireApprovalException(c, ctx, Number(p.id), reasonOf(b))));

// The independent reviewer may not hold a role permission, so this route
// authorises either the designated reviewer or a resolve-permission holder,
// mirroring the decision-time authorisation in approvals.ts.
approvalExceptionsRouter.post(
  '/:id/resolve',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const scoped = await query(
      `SELECT id, independent_reviewer FROM approval_exceptions
       WHERE id = $1 AND tenant_id = $2`,
      [id, req.ctx.tenantId],
      req.ctx
    );
    if (scoped.rows.length === 0) throw badRequest('Approval exception not found in your workspace');
    const isReviewer = Number(scoped.rows[0].independent_reviewer) === req.ctx.userId;
    if (!isReviewer) {
      await new Promise<void>((resolve, reject) => {
        requirePermission('workflows.exceptions.resolve')(
          req,
          {} as import('express').Response,
          (err?: unknown) => (err ? reject(err) : resolve())
        );
      });
    }
    const out = await tx(
      (client) => ex.resolveApprovalException(client, req.ctx, id, String(req.body?.reviewOutcome ?? ''), reasonOf(req.body ?? {})),
      req.ctx
    );
    res.json({ data: out });
  })
);
