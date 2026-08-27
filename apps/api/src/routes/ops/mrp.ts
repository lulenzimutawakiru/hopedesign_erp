import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils.js';
import * as mrp from '../../services/mrp.js';

export const mrpOpsRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

// Run MRP: computes gross requirements from approved forecasts + open sales orders,
// nets available/reserved stock + scheduled receipts, and writes purchase/production suggestions.
mrpOpsRouter.post('/run', ...run('production.plans.execute', (c, ctx, b) => mrp.runMrp(c, ctx, {
  horizonStart: b.horizonStart != null ? String(b.horizonStart) : null,
  horizonEnd: b.horizonEnd != null ? String(b.horizonEnd) : null,
  runType: b.runType != null ? String(b.runType) : undefined,
})));

// MRP summary for the latest run (or a specific run).
mrpOpsRouter.get('/summary', requirePermission('production.plans.view'), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) => mrp.getMrpSummary(client, req.ctx, req.query.runId ? Number(req.query.runId) : undefined),
    req.ctx
  );
  res.json({ data: out });
}));
