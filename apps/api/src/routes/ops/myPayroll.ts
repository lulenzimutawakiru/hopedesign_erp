/**
 * HOPE DESIGN ERP - MY PAYROLL (spec 33, 34).
 *
 * Mounted at /api/my/payroll. Employee self-service for payslips: the caller
 * sees their own payroll and nobody else. The employee is resolved from the
 * authenticated user employee link inside the service, so no employee id is
 * ever accepted from the request body or the query string, and an id that
 * belongs to a colleague resolves to "not found" rather than to their slip.
 *
 * Every endpoint is gated on hr.employee_payroll.self_view. The read paths
 * reuse the same service functions and the same job tables as the HR
 * workspace, so a figure shown to an employee cannot drift from the figure HR
 * sees for that employee.
 */
import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest } from '../../utils.js';
import * as self from '../../services/payrollSelfService.js';
import { PAYROLL_WORKFLOW } from '../../services/payrollLifecycle.js';

export const myPayrollRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;
const run = (permission: string | string[], fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;
const runGet = (permission: string | string[], fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

const intParam = (v: string, label: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${label}`);
  return n;
};

/** The caller own payroll home: latest slip, history, YTD, loans, advances. */
myPayrollRouter.get('/', ...runGet('hr.employee_payroll.self_view', (c, ctx, q) =>
  self.myPayroll(c, ctx, q)));

/** One of the caller own payslips, explained line by line from the run. */
myPayrollRouter.get('/payslips/:id', ...runGet('hr.employee_payroll.self_view', (c, ctx, _q, p) =>
  self.myPayslip(c, ctx, intParam(p.id, 'payslip id'))));

/**
 * Mark one of the caller own payslips as opened. Audited on the first open
 * only, so the employer has delivery evidence without an employee being able
 * to inflate the trail by refreshing.
 */
myPayrollRouter.post('/payslips/:id/viewed', ...run('hr.employee_payroll.self_view', (c, ctx, _b, p) =>
  self.markPayslipViewed(c, ctx, intParam(p.id, 'payslip id'))));

/** Vocabulary for the portal, so the UI never hard-codes a status or a run type. */
myPayrollRouter.get('/meta', ...runGet('hr.employee_payroll.self_view', async () => ({
  workflow: PAYROLL_WORKFLOW,
  runTypes: ['NORMAL', 'OFF_CYCLE', 'FINAL', 'ADJUSTMENT', 'REVERSAL', 'ARREARS'],
  module: 'payroll',
  surface: 'self_service',
  version: 1,
})));
