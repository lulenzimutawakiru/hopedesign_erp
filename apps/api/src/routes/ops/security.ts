import { Router } from 'express';
import pg from 'pg';
import { query, tx, Ctx } from '../../db.js';
import { requirePermission, scopeFilter } from '../../middleware/authorize.js';
import { asyncHandler, toCamelRows } from '../../utils.js';
import * as sec from '../../services/securityPrinting.js';

export const securityOpsRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

// List secure jobs (company/branch scoped, newest first).
securityOpsRouter.get('/jobs', requirePermission('security_printing.jobs.view'), asyncHandler(async (req, res) => {
  const scope = scopeFilter('t')(req);
  const out = await query(
    `SELECT t.* FROM security_jobs t WHERE ${scope} ORDER BY t.id DESC LIMIT 500`,
    [],
    req.ctx
  );
  res.json({ data: toCamelRows(out.rows as Record<string, unknown>[]) });
}));

// Create a secure printing job (DRAFT) with classified materials, operators and machines.
securityOpsRouter.post('/jobs', ...run('security_printing.jobs.create', (c, ctx, b) => sec.createSecureJob(c, ctx, b)));

// Submit for approval (workflow step 1 = job approval, step 2 = materials authorization).
securityOpsRouter.post('/jobs/:id/submit', ...run('security_printing.jobs.submit', (c, ctx, _b, p) => sec.submitSecureJob(c, ctx, Number(p.id))));

// Dual-control material issue (issuer != verifier).
securityOpsRouter.post('/jobs/:id/issue-materials', ...run('security_printing.jobs.issue_materials', (c, ctx, b, p) => sec.issueSecureMaterials(c, ctx, Number(p.id), b)));

// Assign machine / operator to an approved job.
securityOpsRouter.post('/jobs/:id/assign-machine', ...run('security_printing.machines.assign', (c, ctx, b, p) => sec.assignSecureMachine(c, ctx, Number(p.id), Number(b.machineId))));
securityOpsRouter.post('/jobs/:id/assign-operator', ...run('security_printing.operators.assign', (c, ctx, b, p) => sec.assignSecureOperator(c, ctx, Number(p.id), Number(b.operatorUserId))));

// Production lifecycle.
securityOpsRouter.post('/jobs/:id/start', ...run('security_printing.jobs.update', (c, ctx, _b, p) => sec.startSecureProduction(c, ctx, Number(p.id))));
securityOpsRouter.post('/jobs/:id/complete', ...run('security_printing.jobs.update', (c, ctx, b, p) => sec.completeSecureProduction(c, ctx, Number(p.id), {
  quantityGood: Number(b.quantityGood),
  quantitySpoiled: b.quantitySpoiled != null ? Number(b.quantitySpoiled) : undefined,
  quantityWaste: b.quantityWaste != null ? Number(b.quantityWaste) : undefined,
  quantityRework: b.quantityRework != null ? Number(b.quantityRework) : undefined,
  productId: Number(b.productId),
})));

// Quality control.
securityOpsRouter.post('/jobs/:id/qc', ...run('security_printing.jobs.update', (c, ctx, b, p) => sec.qcSecureJob(c, ctx, Number(p.id), {
  result: b.result as 'PASSED' | 'FAILED' | 'QUARANTINED',
  batchId: b.batchId != null ? Number(b.batchId) : null,
  inspectorId: b.inspectorId != null ? Number(b.inspectorId) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));

// Material reconciliation with second-checker dual control.
securityOpsRouter.post('/jobs/:id/reconcile', ...run('security_printing.jobs.reconcile', (c, ctx, b, p) => sec.reconcileSecureJob(c, ctx, Number(p.id), b)));
securityOpsRouter.post('/jobs/:id/reconcile/:rid/resolve', ...run('security_printing.jobs.reconcile', (c, ctx, b, p) => sec.resolveSecureReconciliation(c, ctx, Number(p.id), {
  reconciliationId: Number(p.rid),
  resolved: b.resolved === true || b.resolved === 'true',
  secondCheckerId: Number(b.secondCheckerId),
  notes: b.notes != null ? String(b.notes) : null,
})));

// Packaging, secure storage, dispatch and delivery.
securityOpsRouter.post('/jobs/:id/package', ...run('security_printing.jobs.update', (c, ctx, _b, p) => sec.packageSecureJob(c, ctx, Number(p.id))));
securityOpsRouter.post('/jobs/:id/storage', ...run('security_printing.jobs.update', (c, ctx, _b, p) => sec.secureStorageSecureJob(c, ctx, Number(p.id))));
securityOpsRouter.post('/jobs/:id/dispatch', ...run('security_printing.jobs.dispatch', (c, ctx, _b, p) => sec.dispatchSecureJob(c, ctx, Number(p.id))));
securityOpsRouter.post('/jobs/:id/deliver', ...run('security_printing.jobs.update', (c, ctx, _b, p) => sec.deliverSecureJob(c, ctx, Number(p.id))));

// Hold / resume / cancel with reason.
securityOpsRouter.post('/jobs/:id/hold', ...run('security_printing.jobs.hold', (c, ctx, b, p) => sec.holdSecureJob(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : null)));
securityOpsRouter.post('/jobs/:id/resume', ...run('security_printing.jobs.resume', (c, ctx, b, p) => sec.resumeSecureJob(c, ctx, Number(p.id), String(b.toStatus))));
securityOpsRouter.post('/jobs/:id/cancel', ...run('security_printing.jobs.update', (c, ctx, b, p) => sec.cancelSecureJob(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : null)));

// Full job detail (requirements, operators, machines, batches, custody events, movements).
securityOpsRouter.get('/jobs/:id/detail', requirePermission('security_printing.jobs.view'), asyncHandler(async (req, res) => {
  const out = await tx((client) => sec.getSecureJobDetail(client, req.ctx, Number(req.params.id)), req.ctx);
  res.json({ data: out });
}));
