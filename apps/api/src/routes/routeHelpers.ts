import pg from 'pg';
import { Ctx, tx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { asyncHandler } from '../utils.js';

/**
 * Shared route wiring shared by the ops routers. Every route is: check the
 * permission (single or "any-of" array), open one transaction, run the handler
 * with the tenant/session context, and answer `{ data }`. Keeping it here means
 * the transaction + permission pattern stays identical across modules instead
 * of being copy-pasted per router.
 */

export type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
export type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;

export const run = (permission: string | string[], fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

export const runGet = (permission: string | string[], fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];
