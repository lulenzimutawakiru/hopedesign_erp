import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission, can } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils.js';
import * as crm from '../../services/crm.js';
import { AuthUser } from '../../types.js';

export const crmOpsRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>, auth?: AuthUser) => Promise<unknown>;
type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string | string[], fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>, req.auth), req.ctx);
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

crmOpsRouter.get('/board', ...runGet('crm.customers.view', (c, ctx) => crm.crmBoard(c, ctx)));
crmOpsRouter.get('/pipeline', ...runGet('crm.opportunities.view', (c, ctx) => crm.pipeline(c, ctx)));
crmOpsRouter.get('/products', ...runGet('sales.quotations.create', (c, ctx) => crm.listSellableProducts(c, ctx)));
crmOpsRouter.get('/analytics', ...runGet('crm.customers.view', (c, ctx) => crm.crmAnalytics(c, ctx)));
crmOpsRouter.get('/mine', ...runGet('crm.activities.view', (c, ctx) => crm.myDesk(c, ctx)));
crmOpsRouter.get('/duplicates', ...runGet('crm.customers.view', (c, ctx, q) => crm.findDuplicates(c, ctx, {
  name: q.name != null ? String(q.name) : undefined,
  email: q.email != null ? String(q.email) : undefined,
  phone: q.phone != null ? String(q.phone) : undefined,
})));
crmOpsRouter.get('/contacts', ...runGet('crm.contacts.view', (c, ctx, q) => crm.listContacts(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
})));
crmOpsRouter.get('/owners', ...runGet('crm.customers.view', (c, ctx) => crm.listOwners(c, ctx)));

crmOpsRouter.get('/customers', ...runGet('crm.customers.view', (c, ctx, q) => crm.listCustomers(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
crmOpsRouter.get('/customers/:id', ...runGet('crm.customers.view', (c, ctx, _q, p) => crm.getCustomer360(c, ctx, Number(p.id))));
crmOpsRouter.get('/customers/:id/credit', ...runGet('crm.customers.view', (c, ctx, q, p) => crm.creditCheck(c, ctx, Number(p.id), q.amount != null ? Number(q.amount) : 0)));
crmOpsRouter.post('/customers', ...run('crm.customers.create', (c, ctx, b) => crm.createCustomer(c, ctx, b)));
crmOpsRouter.post('/customers/:id/status', ...run(['crm.customers.update', 'crm.customers.block'], (c, ctx, b, p, reqAuth) => crm.setCustomerStatus(
  c, ctx, Number(p.id), String(b.status ?? ''), b.reason != null ? String(b.reason) : null,
  { canBlock: can(reqAuth, 'crm.customers.block') },
)));
crmOpsRouter.post('/customers/:id/assign', ...run('crm.customers.update', (c, ctx, b, p) => crm.assignOwner(c, ctx, {
  entity: 'customers',
  id: Number(p.id),
  userId: Number(b.userId),
})));
crmOpsRouter.post('/customers/:id/contacts', ...run('crm.contacts.create', (c, ctx, b, p) => crm.createContact(c, ctx, {
  customerId: Number(p.id),
  firstName: String(b.firstName ?? ''),
  lastName: String(b.lastName ?? ''),
  title: b.title != null ? String(b.title) : null,
  email: b.email != null ? String(b.email) : null,
  phone: b.phone != null ? String(b.phone) : null,
  isPrimary: Boolean(b.isPrimary),
})));

crmOpsRouter.get('/leads', ...runGet('crm.leads.view', (c, ctx, q) => crm.listLeads(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
crmOpsRouter.get('/leads/:id', ...runGet('crm.leads.view', (c, ctx, _q, p) => crm.getLead(c, ctx, Number(p.id))));
crmOpsRouter.post('/leads', ...run('crm.leads.create', (c, ctx, b) => crm.createLead(c, ctx, b)));
crmOpsRouter.post('/leads/:id/qualify', ...run('crm.leads.update', (c, ctx, _b, p) => crm.qualifyLead(c, ctx, Number(p.id))));
crmOpsRouter.post('/leads/:id/contact', ...run('crm.leads.update', (c, ctx, b, p) => crm.contactLead(c, ctx, Number(p.id), b.notes != null ? String(b.notes) : null)));
crmOpsRouter.post('/leads/:id/disqualify', ...run('crm.leads.update', (c, ctx, b, p) => crm.disqualifyLead(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : null)));
crmOpsRouter.post('/leads/:id/assign', ...run('crm.leads.assign', (c, ctx, b, p) => crm.assignOwner(c, ctx, {
  entity: 'leads',
  id: Number(p.id),
  userId: Number(b.userId),
})));
crmOpsRouter.post('/leads/:id/convert', ...run('crm.leads.convert', (c, ctx, b, p) => crm.convertLead(c, ctx, {
  leadId: Number(p.id),
  createOpportunity: b.createOpportunity !== false,
  amount: b.amount != null ? Number(b.amount) : undefined,
})));

crmOpsRouter.get('/opportunities', ...runGet('crm.opportunities.view', (c, ctx, q) => crm.listOpportunities(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
})));
crmOpsRouter.get('/opportunities/:id', ...runGet('crm.opportunities.view', (c, ctx, _q, p) => crm.getOpportunity(c, ctx, Number(p.id))));
crmOpsRouter.post('/opportunities', ...run('crm.opportunities.create', (c, ctx, b) => crm.createOpportunity(c, ctx, {
  customerId: Number(b.customerId),
  leadId: b.leadId != null ? Number(b.leadId) : null,
  name: String(b.name ?? ''),
  amount: b.amount != null ? Number(b.amount) : undefined,
  stage: b.stage != null ? String(b.stage) : undefined,
  expectedClose: b.expectedClose != null ? String(b.expectedClose) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));
crmOpsRouter.post('/opportunities/:id/move', ...run('crm.opportunities.update', (c, ctx, b, p) => crm.moveOpportunity(c, ctx, Number(p.id), String(b.stage))));
crmOpsRouter.post('/opportunities/:id/win', ...run('crm.opportunities.win', (c, ctx, _b, p) => crm.winOpportunity(c, ctx, Number(p.id))));
crmOpsRouter.post('/opportunities/:id/lose', ...run('crm.opportunities.lose', (c, ctx, b, p) => crm.loseOpportunity(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : null)));
crmOpsRouter.post('/opportunities/:id/hold', ...run('crm.opportunities.update', (c, ctx, b, p) => crm.holdOpportunity(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : null)));
crmOpsRouter.post('/opportunities/:id/resume', ...run('crm.opportunities.update', (c, ctx, _b, p) => crm.resumeOpportunity(c, ctx, Number(p.id))));
crmOpsRouter.post('/opportunities/:id/assign', ...run('crm.opportunities.assign', (c, ctx, b, p) => crm.assignOwner(c, ctx, {
  entity: 'opportunities',
  id: Number(p.id),
  userId: Number(b.userId),
})));
crmOpsRouter.post('/opportunities/:id/quote', ...run('sales.quotations.create', (c, ctx, b, p) => crm.quoteFromOpportunity(c, ctx, {
  opportunityId: Number(p.id),
  items: b.items ?? [],
  validUntil: b.validUntil != null ? String(b.validUntil) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));

crmOpsRouter.get('/activities', ...runGet('crm.activities.view', (c, ctx, q) => crm.listActivities(c, ctx, {
  open: q.open === '1' || q.open === 'true',
})));
crmOpsRouter.post('/activities', ...run('crm.activities.create', (c, ctx, b) => crm.createActivity(c, ctx, {
  entityType: String(b.entityType),
  entityId: Number(b.entityId),
  activityType: b.activityType != null ? String(b.activityType) : undefined,
  subject: String(b.subject ?? ''),
  notes: b.notes != null ? String(b.notes) : null,
  dueAt: b.dueAt != null ? String(b.dueAt) : null,
  assignedTo: b.assignedTo != null ? Number(b.assignedTo) : null,
})));
crmOpsRouter.post('/activities/:id/complete', ...run('crm.activities.complete', (c, ctx, _b, p) => crm.completeActivity(c, ctx, Number(p.id))));

crmOpsRouter.get('/complaints', ...runGet('crm.complaints.view', (c, ctx) => crm.listComplaints(c, ctx)));
crmOpsRouter.get('/complaints/:id', ...runGet('crm.complaints.view', (c, ctx, _q, p) => crm.getComplaint(c, ctx, Number(p.id))));
crmOpsRouter.post('/complaints', ...run('crm.complaints.create', (c, ctx, b) => crm.createComplaint(c, ctx, {
  customerId: Number(b.customerId),
  subject: String(b.subject ?? ''),
  description: b.description != null ? String(b.description) : null,
  priority: b.priority != null ? String(b.priority) : undefined,
})));
crmOpsRouter.post('/complaints/:id/resolve', ...run('crm.complaints.resolve', (c, ctx, b, p) => crm.resolveComplaint(c, ctx, Number(p.id), String(b.resolution ?? 'Resolved'))));
crmOpsRouter.post('/complaints/:id/escalate', ...run('crm.complaints.escalate', (c, ctx, _b, p) => crm.escalateComplaint(c, ctx, Number(p.id))));
