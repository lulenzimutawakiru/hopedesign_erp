import { NextFunction, Request, Response } from 'express';
import { query } from '../db.js';
import { forbidden } from '../utils.js';

/**
 * Module-activation gate for multi-tenant SaaS.
 * Every tenant declares `activate_modules` (JSONB array on tenants).
 * Requests to an inactive module are denied at the gateway — no route
 * handler runs, so no data is exposed and no audit noise is created.
 */
export function requireModule(moduleCode: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (req.ctx.tenantId == null) return next(forbidden(`Module "${moduleCode}" is not activated for this organisation`));
      const res = await query('SELECT activate_modules FROM tenants WHERE id = $1', [req.ctx.tenantId], req.ctx);
      const modules = Array.isArray(res.rows[0]?.activate_modules)
        ? (res.rows[0].activate_modules as string[])
        : [];
      if (!modules.includes(moduleCode)) {
        return next(forbidden(`Module "${moduleCode}" is not activated for this organisation`));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}