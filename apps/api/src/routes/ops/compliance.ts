/**
 * Personal Data Protection Office (PDPO) operations surface.
 *
 *   /api/ops/compliance/*
 *
 * Mounted as its own router rather than bolted onto finance or governance: the
 * Data Protection and Privacy Act obligations run across the whole company -
 * customers, employees, applicants, suppliers - so the register belongs to a
 * compliance workspace and not to one department's screens.
 *
 * This router is a boundary adapter. It resolves the permission, runs the
 * service function in a transaction with the request context applied (so RLS,
 * created_by/updated_by and the audit triggers all see the real actor), and
 * returns the result. It decides nothing about what the registers mean: every
 * statutory rule - deadlines, the consent invariant, which statuses may follow
 * which - is enforced in services/pdpo/ops.ts and in the database behind it.
 *
 * There is no unauthenticated surface here, unlike the bank webhooks. Nothing
 * about a data protection register is inbound: every row is written by a named
 * human holding a named permission.
 */
import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils.js';
import * as pdpo from '../../services/pdpo/ops.js';

export const complianceOpsRouter = Router();

type OpFn = (
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>,
  params: Record<string, string>
) => Promise<unknown>;

type QueryFn = (
  client: pg.PoolClient,
  ctx: Ctx,
  query: Record<string, unknown>,
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

/** Query strings arrive as string | string[] | undefined; normalise once. */
const str = (v: unknown): string | undefined => (v == null || v === '' ? undefined : String(v));
const int = (v: unknown): number | undefined => (v == null || v === '' ? undefined : Number(v));
const flag = (v: unknown): boolean | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return undefined;
};

// ------------------------------------------------------------- configuration
complianceOpsRouter.get('/status', ...runGet('compliance.pdpo.view', (c, ctx) => pdpo.pdpoStatus(c, ctx)));
complianceOpsRouter.get('/config', ...runGet('compliance.pdpo.view', (c, ctx) => pdpo.pdpoConfig(c, ctx)));
complianceOpsRouter.patch('/config', ...run('compliance.pdpo.manage', (c, ctx, b) => pdpo.updatePdpoFromPatch(c, ctx, b)));
complianceOpsRouter.post('/test-connection', ...run('compliance.pdpo.manage', (c, ctx) => pdpo.testPdpoConnection(c, ctx)));

/**
 * The inspection pack: a snapshot of every register, for the person who has to
 * hand the files over.
 *
 * Each register is capped, and a register that was capped says so. An export
 * that silently truncates the breach register would be worse than no export at
 * all, because it would look complete.
 */
const EXPORT_CAP = 200;
complianceOpsRouter.get('/export', ...runGet('compliance.pdpo.export', async (c, ctx) => {
  const [config, activities, consents, requests, breaches, filings] = await Promise.all([
    pdpo.pdpoConfig(c, ctx),
    pdpo.listProcessingActivities(c, ctx, { limit: EXPORT_CAP }),
    pdpo.listConsents(c, ctx, { limit: EXPORT_CAP }),
    pdpo.listSubjectRequests(c, ctx, { limit: EXPORT_CAP }),
    pdpo.listBreaches(c, ctx, { limit: EXPORT_CAP }),
    pdpo.listSubmissions(c, ctx, { limit: EXPORT_CAP }),
  ]);
  const slice = <T>(page: { rows: T[]; total: number }) => ({
    rows: page.rows,
    total: page.total,
    truncated: page.total > page.rows.length,
  });
  return {
    generatedAt: new Date().toISOString(),
    config,
    processingActivities: slice(activities),
    consents: slice(consents),
    subjectRequests: slice(requests),
    breaches: slice(breaches),
    filings: slice(filings),
  };
}));

// ---------------------------------------------- record of processing (RoPA)
complianceOpsRouter.get('/activities', ...runGet('compliance.processing_activities.view', (c, ctx, q) => pdpo.listProcessingActivities(c, ctx, {
  search: str(q.search),
  status: str(q.status),
  lawfulBasis: str(q.lawfulBasis),
  dataCategory: str(q.dataCategory),
  subjectCategory: str(q.subjectCategory),
  crossBorder: flag(q.crossBorder),
  limit: int(q.limit),
  offset: int(q.offset),
})));
complianceOpsRouter.get('/activities/:id', ...runGet('compliance.processing_activities.view', (c, ctx, _q, p) => pdpo.getProcessingActivity(c, ctx, Number(p.id))));
complianceOpsRouter.post('/activities', ...run('compliance.processing_activities.create', (c, ctx, b) => pdpo.createProcessingActivity(c, ctx, b)));
complianceOpsRouter.patch('/activities/:id', ...run('compliance.processing_activities.update', (c, ctx, b, p) => pdpo.updateProcessingActivity(c, ctx, Number(p.id), b)));
complianceOpsRouter.delete('/activities/:id', ...run('compliance.processing_activities.delete', (c, ctx, _b, p) => pdpo.deleteProcessingActivity(c, ctx, Number(p.id))));

// ------------------------------------------------------------- consent register
complianceOpsRouter.get('/consents', ...runGet('compliance.consents.view', (c, ctx, q) => pdpo.listConsents(c, ctx, {
  search: str(q.search),
  status: str(q.status),
  subjectType: str(q.subjectType),
  purpose: str(q.purpose),
  processingActivityId: int(q.processingActivityId),
  limit: int(q.limit),
  offset: int(q.offset),
})));
complianceOpsRouter.get('/consents/:id', ...runGet('compliance.consents.view', (c, ctx, _q, p) => pdpo.getConsent(c, ctx, Number(p.id))));
complianceOpsRouter.post('/consents', ...run('compliance.consents.create', (c, ctx, b) => pdpo.createConsent(c, ctx, b)));
complianceOpsRouter.post('/consents/:id/withdraw', ...run('compliance.consents.withdraw', (c, ctx, b, p) => pdpo.withdrawConsent(c, ctx, Number(p.id), b)));
complianceOpsRouter.delete('/consents/:id', ...run('compliance.consents.delete', (c, ctx, _b, p) => pdpo.deleteConsent(c, ctx, Number(p.id))));

// ------------------------------------------------------- data subject rights
complianceOpsRouter.get('/subject-requests', ...runGet('compliance.subject_requests.view', (c, ctx, q) => pdpo.listSubjectRequests(c, ctx, {
  search: str(q.search),
  status: str(q.status),
  requestType: str(q.requestType),
  subjectType: str(q.subjectType),
  subjectReference: str(q.subjectReference),
  overdue: flag(q.overdue),
  open: flag(q.open),
  limit: int(q.limit),
  offset: int(q.offset),
})));
complianceOpsRouter.get('/subject-requests/:id', ...runGet('compliance.subject_requests.view', (c, ctx, _q, p) => pdpo.getSubjectRequest(c, ctx, Number(p.id))));
complianceOpsRouter.post('/subject-requests', ...run('compliance.subject_requests.create', (c, ctx, b) => pdpo.createSubjectRequest(c, ctx, b)));
complianceOpsRouter.patch('/subject-requests/:id', ...run('compliance.subject_requests.update', (c, ctx, b, p) => pdpo.updateSubjectRequest(c, ctx, Number(p.id), b)));
// Telling the subject the request arrived is part of handling it, so it takes
// the update grant; deciding the outcome takes the decision grants.
complianceOpsRouter.post('/subject-requests/:id/acknowledge', ...run('compliance.subject_requests.update', (c, ctx, b, p) => pdpo.acknowledgeSubjectRequest(c, ctx, Number(p.id), b)));
complianceOpsRouter.post('/subject-requests/:id/complete', ...run('compliance.subject_requests.fulfil', (c, ctx, b, p) => pdpo.completeSubjectRequest(c, ctx, Number(p.id), b)));
complianceOpsRouter.post('/subject-requests/:id/refuse', ...run('compliance.subject_requests.refuse', (c, ctx, b, p) => pdpo.refuseSubjectRequest(c, ctx, Number(p.id), b)));
// Removing a request logged in error is an update to the register; the service
// refuses it once the request has been acknowledged.
complianceOpsRouter.delete('/subject-requests/:id', ...run('compliance.subject_requests.update', (c, ctx, _b, p) => pdpo.deleteSubjectRequest(c, ctx, Number(p.id))));

// ------------------------------------------------------------- breach register
complianceOpsRouter.get('/breaches', ...runGet('compliance.breaches.view', (c, ctx, q) => pdpo.listBreaches(c, ctx, {
  search: str(q.search),
  status: str(q.status),
  severity: str(q.severity),
  notifiable: flag(q.notifiable),
  open: flag(q.open),
  overdue: flag(q.overdue),
  limit: int(q.limit),
  offset: int(q.offset),
})));
complianceOpsRouter.get('/breaches/:id', ...runGet('compliance.breaches.view', (c, ctx, _q, p) => pdpo.getBreach(c, ctx, Number(p.id))));
complianceOpsRouter.post('/breaches', ...run('compliance.breaches.create', (c, ctx, b) => pdpo.createBreach(c, ctx, b)));
complianceOpsRouter.patch('/breaches/:id', ...run('compliance.breaches.update', (c, ctx, b, p) => pdpo.updateBreach(c, ctx, Number(p.id), b)));
complianceOpsRouter.post('/breaches/:id/report', ...run('compliance.breaches.report', (c, ctx, b, p) => pdpo.reportBreach(c, ctx, Number(p.id), b)));
complianceOpsRouter.post('/breaches/:id/close', ...run('compliance.breaches.close', (c, ctx, b, p) => pdpo.closeBreach(c, ctx, Number(p.id), b)));
complianceOpsRouter.delete('/breaches/:id', ...run('compliance.breaches.update', (c, ctx, _b, p) => pdpo.deleteBreach(c, ctx, Number(p.id))));

// ---------------------------------------------------------------- filing ledger
complianceOpsRouter.get('/filings', ...runGet('compliance.pdpo.view', (c, ctx, q) => pdpo.listSubmissions(c, ctx, {
  search: str(q.search),
  status: str(q.status),
  submissionType: str(q.submissionType),
  channel: str(q.channel),
  relatedTable: str(q.relatedTable),
  relatedId: int(q.relatedId),
  limit: int(q.limit),
  offset: int(q.offset),
})));
complianceOpsRouter.get('/filings/:id', ...runGet('compliance.pdpo.view', (c, ctx, _q, p) => pdpo.getSubmission(c, ctx, Number(p.id))));
complianceOpsRouter.post('/filings', ...run('compliance.pdpo.file', (c, ctx, b) => pdpo.createSubmission(c, ctx, b)));
complianceOpsRouter.patch('/filings/:id', ...run('compliance.pdpo.file', (c, ctx, b, p) => pdpo.updateSubmission(c, ctx, Number(p.id), b)));
complianceOpsRouter.post('/filings/:id/file', ...run('compliance.pdpo.file', (c, ctx, b, p) => pdpo.fileSubmission(c, ctx, Number(p.id), b)));
complianceOpsRouter.post('/filings/:id/acknowledge', ...run('compliance.pdpo.file', (c, ctx, b, p) => pdpo.acknowledgeSubmission(c, ctx, Number(p.id), b)));
complianceOpsRouter.post('/filings/:id/reject', ...run('compliance.pdpo.file', (c, ctx, b, p) => pdpo.rejectSubmission(c, ctx, Number(p.id), b)));
complianceOpsRouter.delete('/filings/:id', ...run('compliance.pdpo.file', (c, ctx, _b, p) => pdpo.deleteSubmission(c, ctx, Number(p.id))));
