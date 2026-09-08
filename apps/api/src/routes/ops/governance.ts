import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils.js';
import * as gov from '../../services/governance.js';

export const governanceOpsRouter = Router();

type OpFn = (
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>,
  params: Record<string, string>
) => Promise<unknown>;

const run = (permission: string | string[], fn: OpFn) => [
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

// Combined governance dashboard (delegations + signature authority). Any-of
// permission lets delegation admins and signature admins both use the screen;
// every payload is an aggregate count, never row-level document data.
governanceOpsRouter.get('/dashboard', requirePermission(['governance.delegations.view', 'governance.signature_profiles.view']), asyncHandler(async (req, res) => {
  const out = await tx(async (client) => {
    const delegations = await gov.delegationDashboard(client, req.ctx);
    const signatures = await gov.signatureDashboard(client, req.ctx);
    return { delegations, signatures };
  }, req.ctx);
  res.json({ data: out });
}));

// ===========================================================================
// Acting roles (the current user's active acting authority)
// ===========================================================================
governanceOpsRouter.get('/acting/roles', ...run('governance.acting_roles.view', (c, ctx) => gov.listActingRoles(c, ctx)));

// ===========================================================================
// Delegations & acting authority
// ===========================================================================
governanceOpsRouter.get('/delegations', requirePermission('governance.delegations.view'), asyncHandler(async (req, res) => {
  const out = await tx((client) => gov.listDelegations(client, req.ctx, {
    status: req.query.status != null && String(req.query.status).length > 0 ? String(req.query.status) : null,
    mine: req.query.mine === 'true' || req.query.mine === '1',
  }), req.ctx);
  res.json({ data: out });
}));
governanceOpsRouter.post('/delegations', ...run('governance.delegations.create', (c, ctx, b) => gov.createDelegation(c, ctx, b)));
governanceOpsRouter.get('/delegations/:id/detail', ...run('governance.delegations.view', (c, ctx, _b, p) => gov.getDelegationDetail(c, ctx, Number(p.id))));
governanceOpsRouter.patch('/delegations/:id', ...run('governance.delegations.update', (c, ctx, b, p) => gov.updateDelegation(c, ctx, Number(p.id), b)));
governanceOpsRouter.post('/delegations/:id/submit', ...run('governance.delegations.submit', (c, ctx, b, p) => gov.submitDelegation(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/delegations/:id/approve', ...run('governance.delegations.approve', (c, ctx, b, p) => gov.approveDelegation(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/delegations/:id/reject', ...run('governance.delegations.reject', (c, ctx, b, p) => gov.rejectDelegation(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/delegations/:id/suspend', ...run('governance.delegations.suspend', (c, ctx, b, p) => gov.suspendDelegation(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/delegations/:id/resume', ...run('governance.delegations.resume', (c, ctx, b, p) => gov.resumeDelegation(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/delegations/:id/revoke', ...run('governance.delegations.revoke', (c, ctx, b, p) => gov.revokeDelegation(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/delegations/:id/expire', ...run('governance.delegations.expire', (c, ctx, b, p) => gov.expireDelegation(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/delegations/:id/cancel', ...run('governance.delegations.cancel', (c, ctx, b, p) => gov.cancelDelegation(c, ctx, Number(p.id), reasonOf(b))));

// Delegation authorities (transaction-type approval limits).
governanceOpsRouter.post('/delegations/:id/authorities', ...run('governance.delegation_authorities.create', (c, ctx, b, p) => gov.addDelegationAuthority(c, ctx, Number(p.id), b)));
governanceOpsRouter.patch('/delegations/:id/authorities/:aid', ...run('governance.delegation_authorities.update', (c, ctx, b, p) => gov.updateDelegationAuthority(c, ctx, Number(p.id), Number(p.aid), b)));
governanceOpsRouter.delete('/delegations/:id/authorities/:aid', ...run('governance.delegation_authorities.delete', (c, ctx, _b, p) => gov.deleteDelegationAuthority(c, ctx, Number(p.id), Number(p.aid))));

// ===========================================================================
// Signature profiles
// ===========================================================================
governanceOpsRouter.get('/signature-profiles', requirePermission('governance.signature_profiles.view'), asyncHandler(async (req, res) => {
  const out = await tx((client) => gov.listSignatureProfiles(client, req.ctx, {
    status: req.query.status != null && String(req.query.status).length > 0 ? String(req.query.status) : null,
    userId: req.query.userId != null ? Number(req.query.userId) : null,
  }), req.ctx);
  res.json({ data: out });
}));
governanceOpsRouter.post('/signature-profiles', ...run('governance.signature_profiles.create', (c, ctx, b) => gov.createSignatureProfile(c, ctx, b)));
governanceOpsRouter.get('/signature-profiles/:id/detail', ...run('governance.signature_profiles.view', (c, ctx, _b, p) => gov.getSignatureProfileDetail(c, ctx, Number(p.id))));
governanceOpsRouter.patch('/signature-profiles/:id', ...run('governance.signature_profiles.update', (c, ctx, b, p) => gov.updateSignatureProfile(c, ctx, Number(p.id), b)));
governanceOpsRouter.post('/signature-profiles/:id/artwork', ...run('governance.signature_profiles.upload', (c, ctx, b, p) => gov.attachSignatureArtwork(c, ctx, Number(p.id), b)));
governanceOpsRouter.post('/signature-profiles/:id/submit', ...run('governance.signature_profiles.submit', (c, ctx, b, p) => gov.submitSignatureProfile(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/signature-profiles/:id/approve', ...run('governance.signature_profiles.approve', (c, ctx, b, p) => gov.approveSignatureProfile(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/signature-profiles/:id/reject', ...run('governance.signature_profiles.reject', (c, ctx, b, p) => gov.rejectSignatureProfile(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/signature-profiles/:id/activate', ...run('governance.signature_profiles.activate', (c, ctx, b, p) => gov.activateSignatureProfile(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/signature-profiles/:id/suspend', ...run('governance.signature_profiles.suspend', (c, ctx, b, p) => gov.suspendSignatureProfile(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/signature-profiles/:id/revoke', ...run('governance.signature_profiles.revoke', (c, ctx, b, p) => gov.revokeSignatureProfile(c, ctx, Number(p.id), reasonOf(b))));
governanceOpsRouter.post('/signature-profiles/:id/expire', ...run('governance.signature_profiles.expire', (c, ctx, b, p) => gov.expireSignatureProfile(c, ctx, Number(p.id), reasonOf(b))));

// Signature authority scopes (document type / transaction type / amount).
governanceOpsRouter.get('/signature-profiles/:id/scopes', ...run('governance.signature_profiles.view', (c, ctx, _b, p) => gov.listSignatureScopes(c, ctx, Number(p.id))));
governanceOpsRouter.post('/signature-profiles/:id/scopes', ...run('governance.signature_authority_scopes.create', (c, ctx, b, p) => gov.createSignatureScope(c, ctx, Number(p.id), b)));
governanceOpsRouter.patch('/signature-profiles/:id/scopes/:sid', ...run('governance.signature_authority_scopes.update', (c, ctx, b, p) => gov.updateSignatureScope(c, ctx, Number(p.id), Number(p.sid), b)));
governanceOpsRouter.delete('/signature-profiles/:id/scopes/:sid', ...run('governance.signature_authority_scopes.delete', (c, ctx, _b, p) => gov.deleteSignatureScope(c, ctx, Number(p.id), Number(p.sid))));
governanceOpsRouter.post('/signature-profiles/:id/scopes/:sid/approve', ...run('governance.signature_authority_scopes.approve', (c, ctx, b, p) => gov.approveSignatureScope(c, ctx, Number(p.id), Number(p.sid), reasonOf(b))));
governanceOpsRouter.post('/signature-profiles/:id/scopes/:sid/reject', ...run('governance.signature_authority_scopes.reject', (c, ctx, b, p) => gov.rejectSignatureScope(c, ctx, Number(p.id), Number(p.sid), reasonOf(b))));

// ===========================================================================
// Applied document signatures (immutable records + QR verification)
// ===========================================================================
governanceOpsRouter.get('/document-signatures', requirePermission('governance.document_signatures.view'), asyncHandler(async (req, res) => {
  const out = await tx((client) => gov.listDocumentSignatures(client, req.ctx, {
    documentType: req.query.documentType != null && String(req.query.documentType).length > 0 ? String(req.query.documentType) : null,
    entityType: req.query.entityType != null && String(req.query.entityType).length > 0 ? String(req.query.entityType) : null,
    entityId: req.query.entityId != null ? Number(req.query.entityId) : null,
    documentCode: req.query.documentCode != null && String(req.query.documentCode).length > 0 ? String(req.query.documentCode) : null,
    userId: req.query.userId != null ? Number(req.query.userId) : null,
  }), req.ctx);
  res.json({ data: out });
}));
governanceOpsRouter.post('/document-signatures/apply', ...run('governance.document_signatures.create', (c, ctx, b) => gov.applyDocumentSignature(c, ctx, b)));
governanceOpsRouter.post('/document-signatures/verify', ...run('governance.document_signatures.verify', (c, ctx, b) => gov.verifyDocumentSignature(c, ctx, b)));
