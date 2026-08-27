import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils.js';
import * as empId from '../../services/employeeIdentity.js';

export const employeeIdentityOpsRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

const runGet = (permission: string, fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

// ---- Employee identity centre ----
employeeIdentityOpsRouter.get('/dashboard', ...runGet('hr.employee_identity.view', (c, ctx) => empId.identityDashboard(c, ctx)));
employeeIdentityOpsRouter.get('/', ...runGet('hr.employee_identity.view', (c, ctx, q) => empId.listIdentities(c, ctx, {
  q: q.q != null && q.q !== '' ? String(q.q) : undefined,
  status: q.status != null && q.status !== '' ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
employeeIdentityOpsRouter.get('/employees/:id', ...runGet('hr.employee_identity.view', (c, ctx, _q, p) => empId.getIdentity(c, ctx, Number(p.id))));
employeeIdentityOpsRouter.post('/employees/:id/generate', ...run('hr.employee_identity.generate', (c, ctx, _b, p) => empId.generateEmployeeId(c, ctx, { employeeId: Number(p.id) })));

// ---- ID cards ----
employeeIdentityOpsRouter.post('/employees/:id/cards', ...run('hr.employee_card.generate', (c, ctx, b, p) => empId.generateEmployeeCard(c, ctx, {
  employeeId: Number(p.id),
  serialNumber: b.serialNumber != null ? String(b.serialNumber) : null,
})));
employeeIdentityOpsRouter.post('/cards/:cardId/issue', ...run('hr.employee_card.issue', (c, ctx, _b, p) => empId.issueEmployeeCard(c, ctx, Number(p.cardId))));
employeeIdentityOpsRouter.post('/cards/:cardId/replace', ...run('hr.employee_card.replace', (c, ctx, b, p) => empId.replaceEmployeeCard(c, ctx, Number(p.cardId), b.reason != null ? String(b.reason) : undefined)));
employeeIdentityOpsRouter.post('/cards/:cardId/suspend', ...run('hr.employee_card.suspend', (c, ctx, b, p) => empId.suspendEmployeeCard(c, ctx, Number(p.cardId), b.reason != null ? String(b.reason) : undefined)));
employeeIdentityOpsRouter.post('/cards/:cardId/void', ...run('hr.employee_card.suspend', (c, ctx, b, p) => empId.voidEmployeeCard(c, ctx, Number(p.cardId), b.reason != null ? String(b.reason) : undefined)));

// ---- QR identities ----
employeeIdentityOpsRouter.post('/employees/:id/qr', ...run('hr.employee_qr.generate', (c, ctx, _b, p) => empId.generateEmployeeQr(c, ctx, { employeeId: Number(p.id) })));
employeeIdentityOpsRouter.post('/qr/scan', ...run('hr.employee_qr.scan', (c, ctx, b) => empId.scanEmployeeQr(c, ctx, {
  token: String(b.token ?? ''),
  location: b.location != null ? String(b.location) : null,
})));

// ---- Assignments / transfers ----
employeeIdentityOpsRouter.post('/employees/:id/assignments', ...run('hr.employee_assignments.create', (c, ctx, b, p) => empId.createAssignment(c, ctx, {
  employeeId: Number(p.id),
  assignmentType: b.assignmentType != null ? String(b.assignmentType) : undefined,
  branchId: b.branchId != null && b.branchId !== '' ? Number(b.branchId) : null,
  departmentId: b.departmentId != null && b.departmentId !== '' ? Number(b.departmentId) : null,
  positionId: b.positionId != null && b.positionId !== '' ? Number(b.positionId) : null,
  position: b.position != null ? String(b.position) : null,
  effectiveFrom: b.effectiveFrom != null ? String(b.effectiveFrom) : null,
  reason: b.reason != null ? String(b.reason) : null,
})));
