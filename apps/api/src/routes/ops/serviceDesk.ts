/**
 * HOPE DESIGN SERVICE DESK - operational API (spec sections 30, 10, 13, 17).
 *
 * Mounted at both /api/service-desk (spec 30 literal) and /api/ops/service-desk
 * (repository convention). Every endpoint executes the mandated chain:
 *
 *   AUTHENTICATE -> AUTHORIZE RBAC -> AUTHORIZE ABAC -> VALIDATE
 *   -> EXECUTE BUSINESS LOGIC -> DATABASE TRANSACTION -> AUDIT -> NOTIFY
 *
 * Authentication happens at the app level; RBAC/SoD/ABAC happen in
 * requirePermission; row-level organizational scope, validation, the
 * transaction, the audit record and the notifications all live in the service
 * modules this router binds to. The router deliberately contains no SQL: it is
 * a thin, auditable authorization surface.
 */
import { Router } from 'express';
import pg from 'pg';
import multer from 'multer';
import { Request } from 'express';
import { tx, detach, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../utils.js';
import * as sd from '../../services/serviceDesk.js';
import * as sla from '../../services/serviceDeskSla.js';
import * as kb from '../../services/serviceDeskKnowledge.js';
import * as pm from '../../services/serviceDeskProblems.js';
import * as chg from '../../services/serviceDeskChanges.js';
import * as acc from '../../services/serviceDeskAccess.js';
import * as ast from '../../services/serviceDeskAssets.js';
import * as cfg from '../../services/serviceDeskConfig.js';

export const serviceDeskOpsRouter = Router();

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
 * service has published the ABAC facts for a specific record. Used by the QR
 * scan flow (spec 13), which cannot know the asset's classification until it
 * has identified the asset.
 */
async function authorizeDecision(req: Request, permission: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    requirePermission(permission)(req, {} as unknown as import('express').Response, (err?: unknown) => (err ? reject(err) : resolve()));
  });
}

/** A ticket path segment is either a surrogate id or a HDG-SD-YYYY-NNNNNN number. */
const ref = (v: string): number | string => (/^\d+$/.test(v) ? Number(v) : v);

/** Express hands query values back as strings, so `?x=true` needs coercing. */
const boolQ = (v: unknown): boolean => v === true || v === 1 || v === 'true' || v === '1';
/** Optional numeric body/query value. */
const num = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(v));
const intParam = (v: string, label: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`Invalid ${label}`);
  return n;
};
const rows = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

// ===========================================================================
// Tickets (spec 21, 30)
// ===========================================================================

serviceDeskOpsRouter.get('/tickets', ...runGet('service_desk.tickets.view', (c, ctx, q) => sd.listTickets(c, ctx, q)));

serviceDeskOpsRouter.post('/tickets', ...run('service_desk.tickets.create', (c, ctx, b) => sd.createTicket(c, ctx, b)));

/** Employee-facing vocabulary: an INCIDENT is a typed ticket (spec 14). */
serviceDeskOpsRouter.post('/tickets/incident', ...run(['service_desk.incidents.create', 'service_desk.tickets.create'], (c, ctx, b) =>
  sd.createTicket(c, ctx, { ...b, ticketType: 'INCIDENT' })));

serviceDeskOpsRouter.post('/tickets/service-request', ...run(['service_desk.service_requests.create', 'service_desk.tickets.create'], (c, ctx, b) =>
  sd.createTicket(c, ctx, { ...b, ticketType: 'SERVICE_REQUEST' })));

serviceDeskOpsRouter.get('/tickets/:id', ...runGet(['service_desk.tickets.view', 'service_desk.tickets.view_own'], (c, ctx, q, p) =>
  sd.getTicket(c, ctx, ref(p.id), {
    withComments: q.withComments === undefined ? true : String(q.withComments) === 'true',
    withActivity: q.withActivity === undefined ? true : String(q.withActivity) === 'true',
    commentLimit: num(q.commentLimit) ?? undefined,
  })));

serviceDeskOpsRouter.patch('/tickets/:id', ...run('service_desk.tickets.update', (c, ctx, b, p) => sd.updateTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

// ---- assignment (spec 10) --------------------------------------------------

serviceDeskOpsRouter.post('/tickets/:id/assign', ...run('service_desk.tickets.assign', (c, ctx, b, p) =>
  sd.assignTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

serviceDeskOpsRouter.post('/tickets/:id/reassign', ...run('service_desk.tickets.assign', (c, ctx, b, p) =>
  sd.reassignTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

// ---- lifecycle (spec 8) ----------------------------------------------------

serviceDeskOpsRouter.post('/tickets/:id/open', ...run('service_desk.tickets.update', (c, ctx, b, p) =>
  sd.openTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

serviceDeskOpsRouter.post('/tickets/:id/start', ...run('service_desk.tickets.update', (c, ctx, b, p) =>
  sd.startProgress(c, ctx, intParam(p.id, 'ticket id'), b)));

serviceDeskOpsRouter.post('/tickets/:id/pending', ...run('service_desk.tickets.update', (c, ctx, b, p) =>
  sd.setPending(c, ctx, intParam(p.id, 'ticket id'), b)));

serviceDeskOpsRouter.post('/tickets/:id/resolve', ...run(['service_desk.tickets.resolve', 'service_desk.incidents.resolve'], (c, ctx, b, p) =>
  sd.resolveTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

serviceDeskOpsRouter.post('/tickets/:id/close', ...run(['service_desk.tickets.close', 'service_desk.incidents.close'], (c, ctx, b, p) =>
  sd.closeTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

serviceDeskOpsRouter.post('/tickets/:id/reopen', ...run('service_desk.tickets.reopen', (c, ctx, b, p) =>
  sd.reopenTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

serviceDeskOpsRouter.post('/tickets/:id/cancel', ...run(['service_desk.tickets.update', 'service_desk.service_requests.cancel'], (c, ctx, b, p) =>
  sd.cancelTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

/** Requester confirmation is what turns RESOLVED into CLOSED (spec 1, 8). */
serviceDeskOpsRouter.post('/tickets/:id/confirm', ...run(['service_desk.tickets.verify', 'service_desk.tickets.close'], (c, ctx, b, p) =>
  sd.confirmResolution(c, ctx, intParam(p.id, 'ticket id'), b)));

// ---- escalation (spec 17) --------------------------------------------------

serviceDeskOpsRouter.post('/tickets/:id/escalate', ...run(['service_desk.tickets.escalate', 'service_desk.incidents.escalate'], (c, ctx, b, p) =>
  sd.escalateTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

serviceDeskOpsRouter.post('/tickets/:id/escalations/:escalationId/acknowledge', ...run('service_desk.escalations.update', (c, ctx, b, p) =>
  sd.acknowledgeEscalation(c, ctx, intParam(p.id, 'ticket id'), intParam(p.escalationId, 'escalation id'), b)));

serviceDeskOpsRouter.post('/tickets/:id/escalations/resolve', ...run('service_desk.escalations.manage', (c, ctx, b, p) =>
  sd.resolveEscalations(c, ctx, intParam(p.id, 'ticket id'), b)));

// ---- communication: public replies and internal notes (spec 11) ------------

serviceDeskOpsRouter.post('/tickets/:id/respond', ...run(
  ['service_desk.tickets.reply', 'service_desk.internal_notes.create'],
  (c, ctx, b, p) => sd.addComment(c, ctx, intParam(p.id, 'ticket id'), b)
));

/**
 * Internal notes are a separate endpoint so the privileged channel is
 * impossible to reach by accident: the ABAC policy ABAC-SD-INTERNAL-NOTES keys
 * off resource "internal_notes", which only this route publishes.
 */
serviceDeskOpsRouter.post('/tickets/:id/notes', ...run('service_desk.internal_notes.create', (c, ctx, b, p) =>
  sd.addComment(c, ctx, intParam(p.id, 'ticket id'), { ...b, commentType: 'NOTE', internal: true })));

serviceDeskOpsRouter.get('/tickets/:id/comments', ...runGet(['service_desk.tickets.view', 'service_desk.tickets.view_own'], (c, ctx, q, p) =>
  sd.listComments(c, ctx, intParam(p.id, 'ticket id'), q)));

serviceDeskOpsRouter.patch('/tickets/:id/comments/:commentId', ...run('service_desk.tickets.update', (c, ctx, b, p) =>
  sd.updateComment(c, ctx, intParam(p.id, 'ticket id'), intParam(p.commentId, 'comment id'), b)));

// ---- attachments -----------------------------------------------------------

serviceDeskOpsRouter.get('/tickets/:id/attachments', ...runGet(['service_desk.tickets.view', 'service_desk.tickets.view_own'], (c, ctx, _q, p) =>
  sd.listAttachments(c, ctx, intParam(p.id, 'ticket id'))));

const attach: (permission: string | string[]) => import('express').RequestHandler[] = (permission) => [
  requirePermission(permission),
  upload.single('file'),
  asyncHandler(async (req: Request, res) => {
    const body = { ...(req.body ?? {}), ...(req.file ? { file: req.file } : {}) };
    const out = await tx(
      (client) => sd.addAttachment(client, req.ctx, intParam((req.params as Record<string, string>).id, 'ticket id'), body),
      req.ctx
    );
    res.json({ data: out });
  }),
];
serviceDeskOpsRouter.post('/tickets/:id/attachments', ...attach(['service_desk.tickets.update', 'service_desk.tickets.reply']));

// ---- activity timeline, relations, linked knowledge ------------------------

serviceDeskOpsRouter.get('/tickets/:id/activity', ...runGet(['service_desk.tickets.view', 'service_desk.tickets.view_own'], async (c, ctx, _q, p) => {
  const action = await sd.ticketActionContext(c, ctx, ref(p.id), 'view');
  sd.assertScoped(action);
  return sd.ticketActivity(c, ctx, Number(action.ticket.id), action.scope);
}));

serviceDeskOpsRouter.post('/tickets/:id/relations', ...run('service_desk.tickets.update', (c, ctx, b, p) =>
  sd.addTicketRelation(c, ctx, intParam(p.id, 'ticket id'), b)));

serviceDeskOpsRouter.delete('/tickets/:id/relations/:relationId', ...run('service_desk.tickets.update', (c, ctx, _b, p) =>
  sd.removeTicketRelation(c, ctx, intParam(p.id, 'ticket id'), intParam(p.relationId, 'relation id'))));

serviceDeskOpsRouter.get('/tickets/:id/knowledge', ...runGet('service_desk.knowledge.view', (c, ctx, _q, p) =>
  kb.listTicketKnowledge(c, ctx, intParam(p.id, 'ticket id'))));

serviceDeskOpsRouter.post('/tickets/:id/knowledge', ...run('service_desk.knowledge.update', (c, ctx, b, p) =>
  kb.linkArticleToTicket(c, ctx, intParam(p.id, 'ticket id'), b)));

serviceDeskOpsRouter.delete('/tickets/:id/knowledge/:articleId', ...run('service_desk.knowledge.update', (c, ctx, _b, p) =>
  kb.unlinkArticleFromTicket(c, ctx, intParam(p.id, 'ticket id'), intParam(p.articleId, 'article id'))));

serviceDeskOpsRouter.get('/tickets/:id/recommendations', ...runGet('service_desk.knowledge.view', (c, ctx, q, p) =>
  kb.recommendArticlesForTicket(c, ctx, intParam(p.id, 'ticket id'), { limit: num(q.limit) ?? undefined })));

// ===========================================================================
// Taxonomy, queues and workforce (spec 5, 9, 10)
// ===========================================================================

serviceDeskOpsRouter.get('/categories', ...runGet('service_desk.categories.view', (c, ctx, q) =>
  sd.listCategories(c, ctx, { includeInactive: String(q.includeInactive ?? '') === 'true' })));

serviceDeskOpsRouter.post('/categories', ...run('service_desk.categories.create', (c, ctx, b) => sd.createCategory(c, ctx, b)));

serviceDeskOpsRouter.patch('/categories/:id', ...run('service_desk.categories.update', (c, ctx, b, p) =>
  sd.updateCategory(c, ctx, intParam(p.id, 'category id'), b)));

serviceDeskOpsRouter.post('/subcategories', ...run('service_desk.categories.create', (c, ctx, b) => sd.createSubcategory(c, ctx, b)));

serviceDeskOpsRouter.patch('/subcategories/:id', ...run('service_desk.categories.update', (c, ctx, b, p) =>
  sd.updateSubcategory(c, ctx, intParam(p.id, 'subcategory id'), b)));

serviceDeskOpsRouter.get('/queues', ...runGet(['service_desk.queues.view', 'service_desk.command.view'], (c, ctx, q) =>
  sd.listQueues(c, ctx, { includeInactive: String(q.includeInactive ?? '') === 'true' })));

serviceDeskOpsRouter.post('/queues', ...run('service_desk.queues.create', (c, ctx, b) => sd.createQueue(c, ctx, b)));

serviceDeskOpsRouter.patch('/queues/:id', ...run('service_desk.queues.update', (c, ctx, b, p) =>
  sd.updateQueue(c, ctx, intParam(p.id, 'queue id'), b)));

/** Queue sidebar counts and the agent landing metrics (spec 9, 24). */
serviceDeskOpsRouter.get('/queues/summary', ...runGet(['service_desk.command.view', 'service_desk.tickets.view'], (c, ctx, q) =>
  sd.queueSummary(c, ctx, q)));

serviceDeskOpsRouter.get('/workload', ...runGet(['service_desk.command.view', 'service_desk.reports.view'], (c, ctx, q) =>
  sd.technicianWorkload(c, ctx, q)));

// ===========================================================================
// SLA and escalation configuration (spec 7, 17)
// ===========================================================================

serviceDeskOpsRouter.get('/sla/policies', ...runGet(['service_desk.sla.view', 'service_desk.sla.manage'], (c, ctx, q) =>
  cfg.listSlaPolicies(c, ctx, q)));

serviceDeskOpsRouter.get('/escalation/levels', ...runGet('service_desk.escalations.view', (c, ctx) => sd.listEscalationLevels(c, ctx)));

serviceDeskOpsRouter.get('/escalation/rules', ...runGet('service_desk.escalations.view', (c, ctx, q) => sd.listEscalationRules(c, ctx, q)));

// Escalation rules are configurable by category and priority (spec 17).
serviceDeskOpsRouter.post('/escalation/rules', ...run('service_desk.escalations.manage', (c, ctx, b) =>
  sd.createEscalationRule(c, ctx, b)));

serviceDeskOpsRouter.patch('/escalation/rules/:id', ...run('service_desk.escalations.manage', (c, ctx, b, p) =>
  sd.updateEscalationRule(c, ctx, intParam(p.id, 'escalation rule id'), b)));

/** Manual SLA sweep: the same entry point the background worker calls. */
serviceDeskOpsRouter.post('/sla/sweep', ...run(['service_desk.sla.manage', 'service_desk.admin'], () => sla.runServiceDeskSlaTick()));

serviceDeskOpsRouter.post('/sla/policies', ...run('service_desk.sla.manage', (c, ctx, b) => cfg.createSlaPolicy(c, ctx, b)));

serviceDeskOpsRouter.patch('/sla/policies/:id', ...run('service_desk.sla.manage', (c, ctx, b, p) =>
  cfg.updateSlaPolicy(c, ctx, intParam(p.id, 'SLA policy id'), b)));

/** Business calendars and the public holidays that suspend the SLA clock. */
serviceDeskOpsRouter.get('/calendars', ...runGet(['service_desk.sla.view', 'service_desk.sla.manage'], (c, ctx, q) =>
  cfg.listBusinessCalendars(c, ctx, q)));

serviceDeskOpsRouter.post('/calendars', ...run('service_desk.sla.manage', (c, ctx, b) => cfg.createBusinessCalendar(c, ctx, b)));

serviceDeskOpsRouter.patch('/calendars/:id', ...run('service_desk.sla.manage', (c, ctx, b, p) =>
  cfg.updateBusinessCalendar(c, ctx, intParam(p.id, 'calendar id'), b)));

serviceDeskOpsRouter.get('/calendars/:id/holidays', ...runGet(['service_desk.sla.view', 'service_desk.sla.manage'], (c, ctx, q, p) =>
  cfg.listHolidays(c, ctx, ref(p.id), q)));

serviceDeskOpsRouter.post('/calendars/:id/holidays', ...run('service_desk.sla.manage', (c, ctx, b, p) =>
  cfg.createHoliday(c, ctx, ref(p.id), b)));

serviceDeskOpsRouter.delete('/calendars/:id/holidays/:holidayId', ...run('service_desk.sla.manage', (c, ctx, _b, p) =>
  cfg.deleteHoliday(c, ctx, ref(p.id), intParam(p.holidayId, 'holiday id'))));

// ===========================================================================
// Teams and skills (spec 10 - team, skill-based and round-robin assignment)
// ===========================================================================

serviceDeskOpsRouter.get('/teams', ...runGet(['service_desk.teams.view', 'service_desk.command.view'], (c, ctx, q) =>
  cfg.listTeams(c, ctx, q)));

serviceDeskOpsRouter.post('/teams', ...run('service_desk.teams.create', (c, ctx, b) => cfg.createTeam(c, ctx, b)));

serviceDeskOpsRouter.patch('/teams/:id', ...run('service_desk.teams.update', (c, ctx, b, p) =>
  cfg.updateTeam(c, ctx, intParam(p.id, 'team id'), b)));

serviceDeskOpsRouter.get('/teams/:id/members', ...runGet('service_desk.teams.view', (c, ctx, _q, p) =>
  cfg.listTeamMembers(c, ctx, ref(p.id))));

serviceDeskOpsRouter.post('/teams/:id/members', ...run('service_desk.teams.update', (c, ctx, b, p) =>
  cfg.addTeamMember(c, ctx, ref(p.id), b)));

serviceDeskOpsRouter.delete('/teams/:id/members/:userId', ...run('service_desk.teams.update', (c, ctx, _b, p) =>
  cfg.removeTeamMember(c, ctx, ref(p.id), intParam(p.userId, 'user id'))));

serviceDeskOpsRouter.get('/skills', ...runGet(['service_desk.skills.view', 'service_desk.command.view'], (c, ctx, q) =>
  cfg.listSkills(c, ctx, q)));

serviceDeskOpsRouter.post('/skills', ...run('service_desk.skills.create', (c, ctx, b) => cfg.createSkill(c, ctx, b)));

serviceDeskOpsRouter.patch('/skills/:id', ...run('service_desk.skills.update', (c, ctx, b, p) =>
  cfg.updateSkill(c, ctx, intParam(p.id, 'skill id'), b)));

// ===========================================================================
// QR asset service desk (spec 13)
//
// SCAN QR -> AUTHENTICATE -> RBAC -> ABAC -> ASSET IDENTIFIED
// -> VIEW AUTHORIZED DETAILS -> CREATE / VIEW SERVICE TICKETS
//
// The scan cannot know the asset's classification until it has resolved the
// tag, so prepareAssetScan writes the audit row first and hands back the ABAC
// facts; the router then re-runs the full RBAC + ABAC chain with those facts
// before any work is performed. Every scan - allowed or denied - is audited.
// ===========================================================================

const scanHandler = asyncHandler(async (req, res) => {
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
});

serviceDeskOpsRouter.post('/scan', requirePermission('service_desk.asset_scans.scan'), scanHandler);

/** The scan history: who scanned what, when, from where, and with what result. */
serviceDeskOpsRouter.get('/asset-scans', ...runGet('service_desk.asset_scans.view', (c, ctx, q) =>
  ast.listAssetScans(c, ctx, { ...q, denialOnly: boolQ(q.denialOnly) } as unknown as ast.ListAssetScansQuery)));

serviceDeskOpsRouter.get('/assets/:ref', ...runGet('service_desk.assets.view', async (c, ctx, _q, p) => {
  const assetRef = await ast.resolveAssetRef(c, ctx, p.ref);
  const history = await ast.assetServiceHistory(c, ctx, assetRef);
  const maintenance = await ast.assetMaintenanceHistory(c, ctx, assetRef);
  return { asset: assetRef, history, maintenance };
}));

serviceDeskOpsRouter.get('/assets/:ref/tickets', ...runGet('service_desk.tickets.view', async (c, ctx, q, p) => {
  const assetRef = await ast.resolveAssetRef(c, ctx, p.ref);
  return ast.listAssetTickets(c, ctx, assetRef, q);
}));

serviceDeskOpsRouter.get('/assets/:ref/history', ...runGet('service_desk.assets.view', async (c, ctx, _q, p) =>
  ast.assetServiceHistory(c, ctx, await ast.resolveAssetRef(c, ctx, p.ref))));

serviceDeskOpsRouter.get('/assets/:ref/maintenance', ...runGet('service_desk.assets.view', async (c, ctx, _q, p) =>
  ast.assetMaintenanceHistory(c, ctx, await ast.resolveAssetRef(c, ctx, p.ref))));

// ===========================================================================
// Knowledge base (spec 16)
// ===========================================================================
//
// Article lifecycle: DRAFT -> REVIEW -> APPROVED -> PUBLISHED -> ARCHIVED.
// Reads are permission-gated here and audience-gated in the service, because a
// published article can still be restricted to a department or a branch.

type ArticleSearchQuery = Parameters<typeof kb.searchKnowledge>[2];

/** An article path segment is either a surrogate id or a HDG-KB-YYYY-NNNNNN number. */
async function articleRef(client: pg.PoolClient, ctx: Ctx, raw: string): Promise<number> {
  if (/^\d+$/.test(raw)) return Number(raw);
  const found = await kb.loadArticleByNumber(client, ctx, raw);
  if (!found) throw notFound('Knowledge article not found');
  return Number(found.id);
}

serviceDeskOpsRouter.get('/knowledge/categories', ...runGet('service_desk.knowledge.view', (c, ctx, q) =>
  kb.listKnowledgeCategories(c, ctx, { includeInactive: String(q.includeInactive ?? '') === 'true' })));

serviceDeskOpsRouter.post('/knowledge/categories', ...run('service_desk.knowledge.manage', (c, ctx, b) =>
  kb.createKnowledgeCategory(c, ctx, b)));

serviceDeskOpsRouter.patch('/knowledge/categories/:id', ...run('service_desk.knowledge.manage', (c, ctx, b, p) =>
  kb.updateKnowledgeCategory(c, ctx, intParam(p.id, 'category id'), b)));

serviceDeskOpsRouter.get('/knowledge/search', ...runGet('service_desk.knowledge.view', (c, ctx, q) =>
  kb.searchKnowledge(c, ctx, q as unknown as ArticleSearchQuery)));

serviceDeskOpsRouter.get('/knowledge/dashboard', ...runGet('service_desk.knowledge.view', (c, ctx) =>
  kb.knowledgeDashboard(c, ctx)));

serviceDeskOpsRouter.get('/knowledge/articles', ...runGet('service_desk.knowledge.view', (c, ctx, q) =>
  kb.listKnowledgeArticles(c, ctx, q)));

serviceDeskOpsRouter.post('/knowledge/articles', ...run('service_desk.knowledge.create', (c, ctx, b) =>
  kb.createKnowledgeArticle(c, ctx, b)));

serviceDeskOpsRouter.get('/knowledge/articles/:id', ...runGet('service_desk.knowledge.view', async (c, ctx, q, p) =>
  kb.getKnowledgeArticle(c, ctx, await articleRef(c, ctx, p.id), { countView: String(q.countView ?? '') !== 'false' })));

serviceDeskOpsRouter.patch('/knowledge/articles/:id', ...run('service_desk.knowledge.update', (c, ctx, b, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.updateKnowledgeArticle(c, ctx, id, b))));

serviceDeskOpsRouter.delete('/knowledge/articles/:id', ...run('service_desk.knowledge.delete', (c, ctx, _b, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.deleteKnowledgeArticle(c, ctx, id))));

serviceDeskOpsRouter.post('/knowledge/articles/:id/submit', ...run('service_desk.knowledge.submit', (c, ctx, b, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.submitArticleForReview(c, ctx, id, b))));

serviceDeskOpsRouter.post('/knowledge/articles/:id/approve', ...run('service_desk.knowledge.approve', (c, ctx, b, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.approveArticle(c, ctx, id, b))));

serviceDeskOpsRouter.post('/knowledge/articles/:id/publish', ...run('service_desk.knowledge.publish', (c, ctx, b, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.publishArticle(c, ctx, id, b))));

serviceDeskOpsRouter.post('/knowledge/articles/:id/archive', ...run('service_desk.knowledge.archive', (c, ctx, b, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.archiveArticle(c, ctx, id, b))));

serviceDeskOpsRouter.post('/knowledge/articles/:id/restore', ...run('service_desk.knowledge.update', (c, ctx, b, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.restoreArticle(c, ctx, id, b))));

serviceDeskOpsRouter.get('/knowledge/articles/:id/versions', ...runGet('service_desk.knowledge.view', (c, ctx, _q, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.listArticleVersions(c, ctx, id))));

serviceDeskOpsRouter.get('/knowledge/articles/:id/versions/:version', ...runGet('service_desk.knowledge.view', (c, ctx, _q, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.getArticleVersion(c, ctx, id, intParam(p.version, 'version')))));

serviceDeskOpsRouter.get('/knowledge/articles/:id/versions/:version/diff', ...runGet('service_desk.knowledge.view', (c, ctx, _q, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.diffArticleVersion(c, ctx, id, intParam(p.version, 'version')))));

/** Employees rate an article; the service enforces one rating per user. */
serviceDeskOpsRouter.post('/knowledge/articles/:id/feedback', ...run('service_desk.knowledge.rate', (c, ctx, b, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.rateArticle(c, ctx, id, b))));

serviceDeskOpsRouter.get('/knowledge/articles/:id/feedback', ...runGet('service_desk.knowledge.view', (c, ctx, q, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.listArticleFeedback(c, ctx, id, { limit: num(q.limit) ?? undefined }))));

serviceDeskOpsRouter.get('/knowledge/articles/:id/my-feedback', ...runGet('service_desk.knowledge.view', (c, ctx, _q, p) =>
  articleRef(c, ctx, p.id).then((id) => kb.myArticleFeedback(c, ctx, id))));

// ===========================================================================
// Problem management, known errors and root cause analysis (spec 18)
//
// Multiple incidents -> pattern detected -> problem created -> root cause
// investigation -> known error -> permanent fix -> problem closed.
// ===========================================================================

serviceDeskOpsRouter.get('/problems', ...runGet('service_desk.problems.view', (c, ctx, q) =>
  pm.listProblems(c, ctx, q)));

/** Recurring-incident detection. Declared before /problems/:id so that the
 *  literal segment is not captured as a surrogate id. */
serviceDeskOpsRouter.get('/problems/candidates', ...runGet('service_desk.problems.view', (c, ctx, q) =>
  pm.detectProblemCandidates(c, ctx, q)));

serviceDeskOpsRouter.get('/problems/dashboard', ...runGet('service_desk.problems.view', (c, ctx) =>
  pm.problemDashboard(c, ctx)));

serviceDeskOpsRouter.post('/problems', ...run('service_desk.problems.create', (c, ctx, b) =>
  pm.createProblem(c, ctx, b)));

/** Promote a detected cluster of incidents into a single problem record. */
serviceDeskOpsRouter.post('/problems/from-group', ...run('service_desk.problems.create', (c, ctx, b) =>
  pm.createProblemFromGroup(c, ctx, b)));

serviceDeskOpsRouter.get('/problems/:ref', ...runGet('service_desk.problems.view', async (c, ctx, _q, p) =>
  pm.getProblem(c, ctx, await pm.resolveProblemId(c, ctx, ref(p.ref)))));

serviceDeskOpsRouter.patch('/problems/:ref', ...run('service_desk.problems.update', async (c, ctx, b, p) =>
  pm.updateProblem(c, ctx, await pm.resolveProblemId(c, ctx, ref(p.ref)), b)));

serviceDeskOpsRouter.get('/problems/:ref/incidents', ...runGet('service_desk.problems.view', (c, ctx, _q, p) =>
  pm.listProblemIncidents(c, ctx, ref(p.ref))));

serviceDeskOpsRouter.post('/problems/:ref/incidents', ...run('service_desk.problems.update', (c, ctx, b, p) => {
  const raw = b.ticketId ?? b.ticketRef ?? b.ticketNumber;
  if (raw === undefined || raw === null || raw === '') throw badRequest('ticketId is required');
  return pm.linkIncidentToProblem(c, ctx, ref(p.ref), typeof raw === 'number' ? raw : String(raw), b.linkType);
}));

serviceDeskOpsRouter.delete('/problems/:ref/incidents/:ticketId', ...run('service_desk.problems.update', (c, ctx, _b, p) =>
  pm.unlinkIncidentFromProblem(c, ctx, ref(p.ref), intParam(p.ticketId, 'ticket id'))));

serviceDeskOpsRouter.post('/problems/:ref/investigate', ...run('service_desk.problems.investigate', async (c, ctx, b, p) =>
  pm.startProblemInvestigation(c, ctx, await pm.resolveProblemId(c, ctx, ref(p.ref)), b)));

serviceDeskOpsRouter.post('/problems/:ref/root-cause', ...run('service_desk.problems.investigate', async (c, ctx, b, p) =>
  pm.identifyRootCause(c, ctx, await pm.resolveProblemId(c, ctx, ref(p.ref)), b)));

serviceDeskOpsRouter.post('/problems/:ref/known-error', ...run('service_desk.problems.update', async (c, ctx, b, p) =>
  pm.markProblemAsKnownError(c, ctx, await pm.resolveProblemId(c, ctx, ref(p.ref)), b)));

serviceDeskOpsRouter.post('/problems/:ref/resolve', ...run('service_desk.problems.resolve', async (c, ctx, b, p) =>
  pm.resolveProblem(c, ctx, await pm.resolveProblemId(c, ctx, ref(p.ref)), b)));

serviceDeskOpsRouter.post('/problems/:ref/close', ...run('service_desk.problems.close', async (c, ctx, b, p) =>
  pm.closeProblem(c, ctx, await pm.resolveProblemId(c, ctx, ref(p.ref)), b)));

serviceDeskOpsRouter.post('/problems/:ref/cancel', ...run('service_desk.problems.close', async (c, ctx, b, p) =>
  pm.cancelProblem(c, ctx, await pm.resolveProblemId(c, ctx, ref(p.ref)), b)));

serviceDeskOpsRouter.post('/problems/:ref/reopen', ...run('service_desk.problems.update', async (c, ctx, b, p) =>
  pm.reopenProblem(c, ctx, await pm.resolveProblemId(c, ctx, ref(p.ref)), b)));

serviceDeskOpsRouter.get('/problems/:ref/rcas', ...runGet('service_desk.problems.view', (c, ctx, _q, p) =>
  pm.listRcasForProblem(c, ctx, ref(p.ref))));

serviceDeskOpsRouter.post('/problems/:ref/rcas', ...run('service_desk.problems.investigate', (c, ctx, b, p) =>
  pm.createRca(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.get('/rcas/:id', ...runGet('service_desk.problems.view', (c, ctx, _q, p) =>
  pm.getRca(c, ctx, intParam(p.id, 'root cause analysis id'))));

serviceDeskOpsRouter.patch('/rcas/:id', ...run('service_desk.problems.investigate', (c, ctx, b, p) =>
  pm.updateRca(c, ctx, intParam(p.id, 'root cause analysis id'), b)));

serviceDeskOpsRouter.post('/rcas/:id/submit', ...run('service_desk.problems.investigate', (c, ctx, b, p) =>
  pm.submitRca(c, ctx, intParam(p.id, 'root cause analysis id'), b)));

serviceDeskOpsRouter.post('/rcas/:id/review', ...run('service_desk.problems.resolve', (c, ctx, b, p) =>
  pm.reviewRca(c, ctx, intParam(p.id, 'root cause analysis id'), b)));

serviceDeskOpsRouter.get('/known-errors', ...runGet('service_desk.known_errors.view', (c, ctx, q) =>
  pm.listKnownErrors(c, ctx, q)));

serviceDeskOpsRouter.post('/known-errors', ...run('service_desk.known_errors.create', (c, ctx, b) =>
  pm.createKnownError(c, ctx, b)));

serviceDeskOpsRouter.get('/known-errors/:id', ...runGet('service_desk.known_errors.view', (c, ctx, _q, p) =>
  pm.getKnownError(c, ctx, intParam(p.id, 'known error id'))));

serviceDeskOpsRouter.patch('/known-errors/:id', ...run('service_desk.known_errors.update', (c, ctx, b, p) =>
  pm.updateKnownError(c, ctx, intParam(p.id, 'known error id'), b)));

serviceDeskOpsRouter.post('/known-errors/:id/archive', ...run('service_desk.known_errors.archive', (c, ctx, _b, p) =>
  pm.archiveKnownError(c, ctx, intParam(p.id, 'known error id'))));

// ===========================================================================
// Change management (spec 19)
//
// CHANGE REQUEST -> RISK ASSESSMENT -> IMPACT ANALYSIS -> APPROVAL
// -> IMPLEMENTATION -> VALIDATION -> CLOSURE
//
// Normal, standard and emergency changes share the pipeline; the emergency
// path records a retrospective approval instead of skipping the gate.
// ===========================================================================

serviceDeskOpsRouter.get('/changes', ...runGet('service_desk.changes.view', (c, ctx, q) =>
  chg.listChanges(c, ctx, q)));

serviceDeskOpsRouter.get('/changes/calendar', ...runGet('service_desk.changes.view', (c, ctx, q) =>
  chg.changeCalendar(c, ctx, q)));

serviceDeskOpsRouter.get('/changes/dashboard', ...runGet('service_desk.changes.view', (c, ctx) =>
  chg.changeDashboard(c, ctx)));

serviceDeskOpsRouter.post('/changes', ...run('service_desk.changes.create', (c, ctx, b) =>
  chg.createChange(c, ctx, b)));

serviceDeskOpsRouter.get('/changes/:ref', ...runGet('service_desk.changes.view', (c, ctx, _q, p) =>
  chg.getChange(c, ctx, ref(p.ref))));

serviceDeskOpsRouter.patch('/changes/:ref', ...run('service_desk.changes.update', (c, ctx, b, p) =>
  chg.updateChange(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.get('/changes/:ref/approvals', ...runGet('service_desk.change_approvals.view', (c, ctx, _q, p) =>
  chg.listChangeApprovals(c, ctx, ref(p.ref))));

serviceDeskOpsRouter.post('/changes/:ref/submit', ...run('service_desk.changes.submit', (c, ctx, b, p) =>
  chg.submitChangeForApproval(c, ctx, ref(p.ref), b)));

/** A CAB member records their decision on a single approval step. */
serviceDeskOpsRouter.post('/changes/:ref/approvals/decide', ...run('service_desk.change_approvals.approve', (c, ctx, b, p) =>
  chg.decideChangeApproval(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/changes/:ref/approve', ...run('service_desk.changes.approve', (c, ctx, b, p) =>
  chg.approveChange(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/changes/:ref/reject', ...run('service_desk.changes.reject', (c, ctx, b, p) =>
  chg.rejectChange(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/changes/:ref/risk', ...run('service_desk.changes.update', (c, ctx, b, p) =>
  chg.assessRisk(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/changes/:ref/impact', ...run('service_desk.changes.update', (c, ctx, b, p) =>
  chg.assessImpact(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/changes/:ref/implement', ...run('service_desk.changes.implement', (c, ctx, b, p) =>
  chg.startImplementation(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/changes/:ref/complete', ...run('service_desk.changes.implement', (c, ctx, b, p) =>
  chg.completeImplementation(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/changes/:ref/validate', ...run('service_desk.changes.validate', (c, ctx, b, p) =>
  chg.validateChange(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/changes/:ref/fail-validation', ...run('service_desk.changes.validate', (c, ctx, b, p) =>
  chg.failValidation(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/changes/:ref/rollback', ...run('service_desk.changes.implement', (c, ctx, b, p) =>
  chg.rollbackChange(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/changes/:ref/close', ...run('service_desk.changes.close', (c, ctx, b, p) =>
  chg.closeChange(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/changes/:ref/cancel', ...run('service_desk.changes.cancel', (c, ctx, b, p) =>
  chg.cancelChange(c, ctx, ref(p.ref), b)));

/** Emergency changes must still be approved - retrospectively. */
serviceDeskOpsRouter.post('/changes/:ref/retrospective-approval', ...run('service_desk.change_approvals.approve', (c, ctx, b, p) =>
  chg.recordRetrospectiveApproval(c, ctx, ref(p.ref), b)));

// ===========================================================================
// Access request workflow (spec 15)
//
// EMPLOYEE -> REQUEST -> MANAGER APPROVAL -> SYSTEM / DATA OWNER APPROVAL
// -> RBAC ROLE ASSIGNMENT -> ABAC SCOPE CONFIGURATION -> ACCESS GRANTED
// -> AUDIT
//
// The Service Desk never grants access on its own: granting requires the
// dedicated grant permission, the approval chain must be complete, and the
// segregation-of-duties policy blocks an approver from approving their own
// request (ABAC-NO-SELF-APPROVE).
// ===========================================================================

serviceDeskOpsRouter.get('/access-requests', ...runGet('service_desk.access_requests.view', (c, ctx, q) =>
  acc.listAccessRequests(c, ctx, q)));

serviceDeskOpsRouter.get('/access-requests/dashboard', ...runGet('service_desk.access_requests.view', (c, ctx) =>
  acc.accessDashboard(c, ctx)));

/** An employee's own access requests, regardless of the org-wide view right. */
serviceDeskOpsRouter.get('/access-requests/my', ...runGet('service_desk.access_requests.view_own', (c, ctx, q) =>
  acc.listMyAccessRequests(c, ctx, q)));

serviceDeskOpsRouter.post('/access-requests', ...run('service_desk.access_requests.create', (c, ctx, b) =>
  acc.createAccessRequest(c, ctx, b)));

/** Expire time-boxed grants that have run past their end date. */
serviceDeskOpsRouter.post('/access-requests/expire', ...run(['service_desk.access_requests.revoke', 'service_desk.admin'], (c, ctx, b) =>
  acc.expireAccessRequests(c, ctx, b)));

serviceDeskOpsRouter.get('/access-requests/:ref', ...runGet('service_desk.access_requests.view', (c, ctx, _q, p) =>
  acc.getAccessRequest(c, ctx, ref(p.ref))));

serviceDeskOpsRouter.patch('/access-requests/:ref', ...run('service_desk.access_requests.update', (c, ctx, b, p) =>
  acc.updateAccessRequest(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/access-requests/:ref/submit', ...run('service_desk.access_requests.update', (c, ctx, b, p) =>
  acc.submitAccessRequest(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.get('/access-requests/:ref/approvals', ...runGet('service_desk.access_requests.view', (c, ctx, _q, p) =>
  acc.listAccessApprovals(c, ctx, ref(p.ref))));

serviceDeskOpsRouter.post('/access-requests/:ref/approvals/:approvalId/decide', ...run('service_desk.access_requests.approve', (c, ctx, b, p) =>
  acc.decideAccessApproval(c, ctx, ref(p.ref), intParam(p.approvalId, 'approval id'), b)));

serviceDeskOpsRouter.post('/access-requests/:ref/approvals/:approvalId/approve', ...run('service_desk.access_requests.approve', (c, ctx, b, p) =>
  acc.approveAccessRequest(c, ctx, ref(p.ref), intParam(p.approvalId, 'approval id'), b)));

serviceDeskOpsRouter.post('/access-requests/:ref/approvals/:approvalId/reject', ...run('service_desk.access_requests.reject', (c, ctx, b, p) =>
  acc.rejectAccessRequest(c, ctx, ref(p.ref), intParam(p.approvalId, 'approval id'), b)));

serviceDeskOpsRouter.post('/access-requests/:ref/cancel', ...run('service_desk.access_requests.cancel', (c, ctx, b, p) =>
  acc.cancelAccessRequest(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/access-requests/:ref/grant', ...run('service_desk.access_requests.grant', (c, ctx, b, p) =>
  acc.grantAccessRequest(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/access-requests/:ref/provisioning-failed', ...run('service_desk.access_requests.update', (c, ctx, b, p) =>
  acc.markAccessProvisioningFailed(c, ctx, ref(p.ref), b)));

serviceDeskOpsRouter.post('/access-requests/:ref/revoke', ...run('service_desk.access_requests.revoke', (c, ctx, b, p) =>
  acc.revokeAccessRequest(c, ctx, ref(p.ref), b)));

// ===========================================================================
// Dashboards and reporting (spec 24, 25)
// ===========================================================================

/**
 * The enum vocabulary the UI needs to render status chips, priority labels and
 * the impact/urgency matrix. Colour alone never conveys priority, so the client
 * needs the codes and their order.
 */
serviceDeskOpsRouter.get('/meta', ...runGet(['service_desk.tickets.view', 'service_desk.tickets.view_own'], async () => ({
  ticketTypes: sd.TICKET_TYPES,
  statuses: sd.TICKET_STATUSES,
  priorities: sd.PRIORITIES,
  impacts: sd.IMPACTS,
  urgencies: sd.SEVERITIES,
  sources: sd.TICKET_SOURCES,
  classifications: sd.CLASSIFICATIONS,
  contactMethods: sd.CONTACT_METHODS,
  assignmentStrategies: sd.ASSIGNMENT_STRATEGIES,
  relationTypes: sd.TICKET_RELATION_TYPES,
  resolutionCodes: sd.RESOLUTION_CODES,
  reports: sd.serviceDeskReportCatalogue(),
  module: 'service_desk',
  version: 1,
})));

/** "MY SERVICE DESK" - the employee landing payload (spec 2). */
serviceDeskOpsRouter.get('/summary', ...runGet(['service_desk.tickets.view', 'service_desk.tickets.view_own'], (c, ctx) =>
  sd.myServiceDeskSummary(c, ctx)));

serviceDeskOpsRouter.get('/dashboard/employee', ...runGet(['service_desk.dashboards.employee', 'service_desk.tickets.view_own'], (c, ctx) =>
  sd.employeeDashboard(c, ctx)));

serviceDeskOpsRouter.get('/dashboard/agent', ...runGet('service_desk.dashboards.agent', (c, ctx, q) =>
  sd.agentDashboard(c, ctx, q)));

serviceDeskOpsRouter.get('/dashboard/manager', ...runGet('service_desk.dashboards.manager', (c, ctx, q) =>
  sd.managerDashboard(c, ctx, q)));

serviceDeskOpsRouter.get('/dashboard/executive', ...runGet('service_desk.dashboards.executive', (c, ctx, q) =>
  sd.executiveDashboard(c, ctx, q)));

/** The report catalogue: every report the caller may run, with its columns. */
serviceDeskOpsRouter.get('/reports', ...runGet('service_desk.reports.view', async () => sd.serviceDeskReportCatalogue()));

serviceDeskOpsRouter.get('/reports/run', ...runGet('service_desk.reports.view', (c, ctx, q) =>
  sd.runServiceDeskReport(c, ctx, q)));

/**
 * Run one report by code. Supports FILTER / GROUP / DRILL DOWN through the
 * query string, and EXPORT PDF / EXCEL / CSV through `format`.
 */
serviceDeskOpsRouter.get('/reports/:code', ...runGet('service_desk.reports.view', (c, ctx, q, p) =>
  sd.runServiceDeskReport(c, ctx, { ...q, report: p.code })));
