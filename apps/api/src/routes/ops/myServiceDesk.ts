/**
 * HOPE DESIGN SERVICE DESK - employee self-service API (spec 2, 3, 16, 27, 30).
 *
 * Mounted at /api/my/service-desk. This is the MY HOPE DESIGN surface: it
 * answers only for the authenticated caller and never for anybody else.
 *
 * Every endpoint executes the mandated chain:
 *
 *   AUTHENTICATE -> AUTHORIZE RBAC -> AUTHORIZE ABAC -> VALIDATE
 *   -> EXECUTE BUSINESS LOGIC -> DATABASE TRANSACTION -> AUDIT -> NOTIFY
 *
 * Three deliberate differences from the operational router at
 * /api/service-desk:
 *
 *   1. `mine: true` is forced onto every list, and `selfService: true` onto
 *      every create. The services therefore take the requester from the
 *      authenticated context and never from the body, so an employee cannot
 *      impersonate another employee even if they post requesterEmployeeId by
 *      hand. A caller without service_desk.tickets.create_on_behalf who names a
 *      foreign requester is refused outright, and the refusal is audited.
 *   2. Replies written here are always public. Internal notes are a service
 *      desk instrument (spec 11) and are only writable through the operational
 *      router, which requires service_desk.internal_notes.create. Forcing the
 *      flag here means nothing an employee writes can ever be hidden from them.
 *   3. Read paths go through the very same service functions as the agent
 *      workspace, so row-level scope, classification, secure-asset and
 *      internal-note filtering cannot diverge between the two surfaces.
 *
 * The router contains no SQL: it is a thin, auditable authorization surface.
 */
import { Router } from 'express';
import pg from 'pg';
import multer from 'multer';
import { Request } from 'express';
import { tx, detach, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../utils.js';
import * as sd from '../../services/serviceDesk.js';
import * as kb from '../../services/serviceDeskKnowledge.js';
import * as acc from '../../services/serviceDeskAccess.js';
import * as ast from '../../services/serviceDeskAssets.js';

export const myServiceDeskRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

/**
 * Re-runs the full RBAC + SoD + ABAC chain from inside a handler, once the
 * service has published the ABAC facts for a specific record. The QR scan
 * (spec 13) cannot know the asset's classification until it has resolved the
 * tag, so it must authorize a second time with those facts.
 */
async function authorizeDecision(req: Request, permission: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    requirePermission(permission)(req, {} as unknown as import('express').Response, (err?: unknown) => (err ? reject(err) : resolve()));
  });
}

/** A ticket path segment is either a surrogate id or a HDG-SD-YYYY-NNNNNN number. */
const ref = (v: string): number | string => (/^\d+$/.test(v) ? Number(v) : v);
/** Optional numeric query value. */
const num = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(v));
const intParam = (v: string, label: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`Invalid ${label}`);
  return n;
};

/**
 * Force requester attribution onto the authenticated caller.
 *
 * The services already ignore these keys when `selfService` is set; clearing
 * them here as well means the intent is explicit at the edge and an audited
 * impersonation attempt cannot accidentally be honoured by a future refactor.
 */
function asSelf(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    requesterEmployeeId: undefined,
    requester_employee_id: undefined,
    requesterUserId: undefined,
    requester_user_id: undefined,
  };
}

// ===========================================================================
// My tickets (spec 2, 3, 27)
// ===========================================================================

/** "All my tickets" - every filter the employee portal offers, scoped to self. */
myServiceDeskRouter.get('/tickets', ...runGet('service_desk.tickets.view_own', (c, ctx, q) =>
  sd.listTickets(c, ctx, { ...q, mine: true })));

/** Raise an incident or service request as yourself (spec 3, 14). */
myServiceDeskRouter.post('/tickets', ...run('service_desk.tickets.create', (c, ctx, b) =>
  sd.createTicket(c, ctx, asSelf(b), { selfService: true })));

myServiceDeskRouter.get('/tickets/:id', ...runGet(['service_desk.tickets.view_own', 'service_desk.tickets.view'], (c, ctx, q, p) =>
  sd.getTicket(c, ctx, ref(p.id), {
    withComments: q.withComments === undefined ? true : String(q.withComments) === 'true',
    withActivity: q.withActivity === undefined ? false : String(q.withActivity) === 'true',
    commentLimit: num(q.commentLimit) ?? undefined,
  })));

/**
 * Public reply. Internal notes are unreachable from this surface (spec 11).
 *
 * The comment type is overwritten as well as the three internal flags: the
 * service reads `commentType` first, so an employee posting
 * `{ commentType: 'NOTE' }` would otherwise reach the internal-note branch and
 * be refused. Forcing REPLY here keeps the promise the router makes in its
 * header comment - nothing written from this surface can ever be hidden from
 * the person who wrote it.
 */
myServiceDeskRouter.post('/tickets/:id/reply', ...run('service_desk.tickets.reply', (c, ctx, b, p) =>
  sd.addComment(c, ctx, intParam(p.id, 'ticket id'), {
    ...b,
    commentType: 'REPLY',
    comment_type: 'REPLY',
    isInternal: false,
    is_internal: false,
    internal: false,
  })));

/** The milestone list an employee sees on their own ticket (spec 9, 27). */
myServiceDeskRouter.get('/tickets/:id/activity', ...runGet(['service_desk.tickets.view_own', 'service_desk.tickets.view'], async (c, ctx, _q, p) => {
  const action = await sd.ticketActionContext(c, ctx, ref(p.id), 'view');
  sd.assertScoped(action);
  return sd.ticketActivity(c, ctx, Number(action.ticket.id), action.scope);
}));

/** Public comments only - listMyComments hard-filters is_internal = false. */
myServiceDeskRouter.get('/tickets/:id/comments', ...runGet(['service_desk.tickets.view_own', 'service_desk.tickets.view'], (c, ctx, _q, p) =>
  sd.listMyComments(c, ctx, intParam(p.id, 'ticket id'))));

myServiceDeskRouter.get('/tickets/:id/attachments', ...runGet(['service_desk.tickets.view_own', 'service_desk.tickets.view'], (c, ctx, _q, p) =>
  sd.listAttachments(c, ctx, intParam(p.id, 'ticket id'))));

/** Upload a photo of the fault from the mobile portal (spec 27). */
const selfAttach = [
  requirePermission(['service_desk.tickets.reply', 'service_desk.tickets.update']),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const body = {
      ...(req.body ?? {}),
      isInternal: false,
      is_internal: false,
      ...(req.file ? { file: req.file } : {}),
    };
    const out = await tx(
      (client) => sd.addAttachment(client, req.ctx, intParam((req.params as Record<string, string>).id, 'ticket id'), body),
      req.ctx
    );
    res.json({ data: out });
  }),
];
myServiceDeskRouter.post('/tickets/:id/attachments', ...selfAttach);

/** "This is fixed, thank you" - closes the loop for the requester (spec 1). */
myServiceDeskRouter.post('/tickets/:id/confirm', ...run(['service_desk.tickets.verify', 'service_desk.tickets.close_own'], (c, ctx, b, p) =>
  sd.confirmResolution(c, ctx, intParam(p.id, 'ticket id'), b)));

/** The employee accepts the resolution and closes their own ticket. */
myServiceDeskRouter.post('/tickets/:id/close', ...run(['service_desk.tickets.close_own', 'service_desk.tickets.close'], (c, ctx, b, p) =>
  sd.closeTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

/** Reopening is a first-class employee right, and it feeds the audit trail. */
myServiceDeskRouter.post('/tickets/:id/reopen', ...run(['service_desk.tickets.reopen', 'service_desk.tickets.close_own'], (c, ctx, b, p) =>
  sd.reopenTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

/** Withdraw a request that is no longer needed. */
myServiceDeskRouter.post('/tickets/:id/cancel', ...run(['service_desk.tickets.update', 'service_desk.tickets.close_own'], (c, ctx, b, p) =>
  sd.cancelTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

/**
 * Employee satisfaction rating. confirmResolution already accepts a rating;
 * this alias lets the mobile "rate your support" card post one on its own.
 */
myServiceDeskRouter.post('/tickets/:id/rate', ...run(['service_desk.tickets.verify', 'service_desk.tickets.close_own'], (c, ctx, b, p) =>
  sd.confirmResolution(c, ctx, intParam(p.id, 'ticket id'), b)));

// ===========================================================================
// Knowledge base - search before you raise (spec 16, 27)
// ===========================================================================

myServiceDeskRouter.get('/knowledge/categories', ...runGet('service_desk.knowledge.view', (c, ctx) =>
  kb.listKnowledgeCategories(c, ctx, { includeInactive: false })));

myServiceDeskRouter.get('/knowledge/articles', ...runGet('service_desk.knowledge.view', (c, ctx, q) =>
  kb.listKnowledgeArticles(c, ctx, q)));

/** The "Need help?" box: ranked published articles, readable by this caller. */
myServiceDeskRouter.get('/knowledge/search', ...runGet('service_desk.knowledge.view', (c, ctx, q) =>
  kb.searchKnowledge(c, ctx, q)));

/** An article path segment is either a surrogate id or a HDG-KB-YYYY-NNNNNN number. */
async function articleRef(client: pg.PoolClient, ctx: Ctx, raw: string): Promise<number> {
  if (/^\d+$/.test(raw)) return Number(raw);
  const found = await kb.loadArticleByNumber(client, ctx, raw);
  if (!found) throw notFound('Knowledge article not found');
  return Number(found.id);
}

myServiceDeskRouter.get('/knowledge/articles/:id', ...runGet('service_desk.knowledge.view', async (c, ctx, q, p) =>
  kb.getKnowledgeArticle(c, ctx, await articleRef(c, ctx, p.id), { countView: String(q.countView ?? '') !== 'false' })));

myServiceDeskRouter.get('/knowledge/articles/:id/feedback', ...runGet('service_desk.knowledge.view', (c, ctx, _q, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.myArticleFeedback(c, ctx, id))));

/** "Was this helpful?" */
myServiceDeskRouter.post('/knowledge/articles/:id/rate', ...run('service_desk.knowledge.rate', (c, ctx, b, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.rateArticle(c, ctx, id, b))));

myServiceDeskRouter.post('/knowledge/articles/:id/feedback', ...run('service_desk.knowledge.rate', (c, ctx, b, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.rateArticle(c, ctx, id, b))));

// ===========================================================================
// Access requests (spec 15) - the employee raises, others approve
// ===========================================================================

myServiceDeskRouter.get('/access-requests', ...runGet('service_desk.access_requests.view_own', (c, ctx, q) =>
  acc.listMyAccessRequests(c, ctx, q)));

/**
 * Raise an access request. `selfService` is forced, so the requester and the
 * target are always the caller: the Service Desk can never be talked into
 * granting access on the strength of a hand-written body (spec 15).
 */
myServiceDeskRouter.post('/access-requests', ...run('service_desk.access_requests.create', (c, ctx, b) =>
  acc.createAccessRequest(c, ctx, asSelf(b), { selfService: true })));

myServiceDeskRouter.get('/access-requests/:ref', ...runGet('service_desk.access_requests.view_own', (c, ctx, _q, p) =>
  acc.getAccessRequest(c, ctx, ref(p.ref))));

/** Employees see who still has to sign off on their own request. */
myServiceDeskRouter.get('/access-requests/:ref/approvals', ...runGet('service_desk.access_requests.view_own', (c, ctx, _q, p) =>
  acc.listAccessApprovals(c, ctx, ref(p.ref))));

myServiceDeskRouter.post('/access-requests/:ref/cancel', ...run('service_desk.access_requests.view_own', (c, ctx, b, p) =>
  acc.cancelAccessRequest(c, ctx, ref(p.ref), b)));

// ===========================================================================
// QR asset scanning (spec 13, 27)
//
// Employees must be able to scan a tag and either read the asset or report a
// fault on it. prepareAssetScan resolves the tag, picks the permission that
// fits both the intent and the caller (an employee reaches the read intents
// through service_desk.tickets.view_own, not the agent-only tickets.view),
// writes the audit row first, and hands back the ABAC facts. The handler then
// re-runs the full RBAC + SoD + ABAC chain with those facts, so a secure asset
// is still refused. Every scan - allowed or denied - is audited.
// ===========================================================================

myServiceDeskRouter.post('/scan', requirePermission('service_desk.asset_scans.scan'), asyncHandler(async (req, res) => {
  // The ledger row is committed before any authorization outcome is decided: a
  // refused scan has to leave the same trail as a successful one (spec 13, 29).
  // Preparation therefore runs on its own connection, so rolling back the
  // request transaction can no longer erase the record of the attempt.
  const prep = await detach((client) => ast.prepareAssetScan(client, req.ctx, req.body ?? {}), req.ctx);

  if (!prep.allowed) {
    // prepareAssetScan has already committed DENIED_RBAC / DENIED_SCOPE /
    // ASSET_NOT_FOUND, so the refusal itself is on the audit trail. Writing a
    // second row here would double-count the denial.
    if (prep.outcome === 'ASSET_NOT_FOUND') throw notFound(prep.denyReason ?? 'Asset not found');
    throw forbidden(prep.denyReason ?? 'You cannot scan this asset');
  }

  // Publish what the tag revealed, then re-authorize before doing anything.
  req.ctx.resourceAttributes = prep.attributes;
  try {
    await authorizeDecision(req, prep.permission);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The refusal is recorded on its own connection for the same reason.
    await detach((client) => ast.failAssetScan(client, req.ctx, prep, reason), req.ctx).catch(() => undefined);
    throw err;
  }

  const out = await tx((client) => ast.executeAssetScan(client, req.ctx, prep, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

/** The caller's own scan history: proof of what was scanned and from where. */
myServiceDeskRouter.get('/asset-scans', ...runGet('service_desk.asset_scans.view', (c, ctx, q) =>
  ast.listAssetScans(c, ctx, { ...q, scannedByMe: true } as unknown as ast.ListAssetScansQuery)));

// ===========================================================================
// Landing payload and vocabulary (spec 2, 24, 28)
// ===========================================================================

/**
 * Enum vocabulary for the portal. Colour alone never conveys priority, so the
 * UI needs the codes, their order and their labels (spec 28).
 */
myServiceDeskRouter.get('/meta', ...runGet('service_desk.tickets.view_own', async () => ({
  ticketTypes: sd.TICKET_TYPES,
  statuses: sd.TICKET_STATUSES,
  priorities: sd.PRIORITIES,
  impacts: sd.IMPACTS,
  urgencies: sd.SEVERITIES,
  sources: sd.TICKET_SOURCES,
  classifications: sd.CLASSIFICATIONS,
  contactMethods: sd.CONTACT_METHODS,
  resolutionCodes: sd.RESOLUTION_CODES,
  module: 'service_desk',
  surface: 'self_service',
  version: 1,
})));

/** "MY SERVICE DESK" - open tickets, recent resolutions, knowledge (spec 2). */
myServiceDeskRouter.get('/summary', ...runGet('service_desk.tickets.view_own', (c, ctx) =>
  sd.myServiceDeskSummary(c, ctx)));

myServiceDeskRouter.get('/dashboard', ...runGet(['service_desk.dashboards.employee', 'service_desk.tickets.view_own'], (c, ctx) =>
  sd.employeeDashboard(c, ctx)));

/** Category tree for the create form. Inactive branches are hidden. */
myServiceDeskRouter.get('/categories', ...runGet('service_desk.tickets.view_own', (c, ctx) =>
  sd.listCategories(c, ctx, { includeInactive: false })));
