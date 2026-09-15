import { Router, Request, Response, NextFunction } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils.js';
import {
  ORG_VIEW_PERMISSION,
  catalogueIndex,
  categoryHistory,
  getCategory,
  loadCategory,
  saveCategory,
  searchSettings,
  settingsAuditTrail,
  structureSummary,
} from '../../services/organisationSettings/index.js';
import * as structure from '../../services/organisationSettings/structure.js';
import * as numbering from '../../services/organisationSettings/numbering.js';
import * as fiscal from '../../services/organisationSettings/fiscal.js';
import * as tax from '../../services/organisationSettings/tax.js';
import * as approvals from '../../services/organisationSettings/approvals.js';
import * as security from '../../services/organisationSettings/security.js';
import * as integrations from '../../services/organisationSettings/integrations.js';
import * as retention from '../../services/organisationSettings/retention.js';
import * as signatures from '../../services/organisationSettings/signatures.js';

/**
 * Organisation Settings - the ERP control plane.
 *
 * Authority here is deliberately not a single 'administrator' switch. The
 * catalogue carries one manage permission per category, so a payroll manager
 * can open the screen and edit payroll rules without being able to rewrite tax
 * law. Every write runs the same requirePermission chain as the rest of the
 * API (RBAC + SoD + ABAC + company scope), never a bare permission test.
 */
export const organisationSettingsOpsRouter = Router();

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

/**
 * The permission a category's own writes require.
 *
 * Read access is one permission for the whole screen; writes are per category,
 * so the guard has to resolve the category before it can name the permission.
 * The category is looked up first and then the real requirePermission chain
 * runs - SoD, ABAC and company scope are enforced exactly as elsewhere.
 */
const runCategory = (
  mode: 'view' | 'manage',
  fn: (
    client: pg.PoolClient,
    ctx: Ctx,
    body: Record<string, unknown>,
    params: Record<string, string>
  ) => Promise<unknown>
) => [
  (req: Request, res: Response, next: NextFunction) => {
    let permission: string;
    try {
      const category = getCategory(String(req.params.id ?? ''));
      permission = mode === 'view' ? ORG_VIEW_PERMISSION : category.manage;
    } catch (err) {
      return next(err);
    }
    return requirePermission(permission)(req, res, next);
  },
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

/**
 * The same guard, for a route whose inputs arrive in the query string.
 *
 * runCategory hands the handler req.body, which is always empty on a GET, so a
 * query-filtered read needs its own variant. The category is still resolved
 * first (a bad id is a 404, not a spurious 403) and the real requirePermission
 * chain still runs.
 */
const runCategoryQuery = (
  fn: (
    client: pg.PoolClient,
    ctx: Ctx,
    query: Record<string, unknown>,
    params: Record<string, string>
  ) => Promise<unknown>
) => [
  (req: Request, res: Response, next: NextFunction) => {
    try {
      getCategory(String(req.params.id ?? ''));
    } catch (err) {
      return next(err);
    }
    return requirePermission(ORG_VIEW_PERMISSION)(req, res, next);
  },
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) =>
        fn(client, req.ctx, (req.query ?? {}) as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

/** A structured sub-resource inherits the manage permission of its category. */
const manage = (categoryId: string): string => getCategory(categoryId).manage;

const reasonOf = (b: Record<string, unknown>): string | null =>
  b.reason != null && String(b.reason).trim().length > 0 ? String(b.reason) : null;

const qs = (v: unknown): string | null =>
  v != null && String(v).trim().length > 0 ? String(v).trim() : null;

// ===========================================================================
// Catalogue, search and the aggregate overview
// ===========================================================================

organisationSettingsOpsRouter.get('/catalogue', requirePermission(ORG_VIEW_PERMISSION), asyncHandler(async (_req, res) => {
  res.json({ data: catalogueIndex() });
}));

organisationSettingsOpsRouter.get('/search', requirePermission(ORG_VIEW_PERMISSION), asyncHandler(async (req, res) => {
  res.json({ data: searchSettings(String(req.query.q ?? '')) });
}));

organisationSettingsOpsRouter.get('/summary', requirePermission(ORG_VIEW_PERMISSION), asyncHandler(async (req, res) => {
  const out = await tx((client) => structureSummary(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/audit', requirePermission(manage('audit')), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) =>
      settingsAuditTrail(client, req.ctx, {
        resource: qs(req.query.resource),
        limit: req.query.limit != null ? Number(req.query.limit) : undefined,
      }),
    req.ctx
  );
  res.json({ data: out });
}));

// ===========================================================================
// Category read / write
// ===========================================================================

organisationSettingsOpsRouter.get(
  '/category/:id',
  ...runCategory('view', (client, ctx, _b, p) => loadCategory(client, ctx, p.id))
);

// A category save may move money, tax law, payroll or security posture, so it
// carries a reason and is audited against the category's own resource name.
organisationSettingsOpsRouter.patch(
  '/category/:id',
  ...runCategory('manage', (client, ctx, b, p) => saveCategory(client, ctx, p.id, b, { reason: reasonOf(b) }))
);

organisationSettingsOpsRouter.get(
  '/category/:id/history',
  ...runCategoryQuery((client, ctx, query, p) =>
    categoryHistory(client, ctx, p.id, {
      key: qs(query.key),
      limit: query.limit != null ? Number(query.limit) : undefined,
    })
  )
);

// ===========================================================================
// Organisation structure (companies, branches, departments, ...)
// ===========================================================================

organisationSettingsOpsRouter.get('/structure', requirePermission(manage('companies')), asyncHandler(async (req, res) => {
  const out = await tx((client) => structure.structureTree(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/structure/entities', requirePermission(ORG_VIEW_PERMISSION), asyncHandler(async (_req, res) => {
  res.json({ data: structure.STRUCTURE_ENTITY_IDS });
}));

organisationSettingsOpsRouter.get('/structure/:entity', requirePermission(ORG_VIEW_PERMISSION), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) =>
      structure.listEntities(client, req.ctx, String(req.params.entity), {
        status: qs(req.query.status),
        includeArchived: req.query.includeArchived === 'true' || req.query.includeArchived === '1',
      } as structure.ListOptions),
    req.ctx
  );
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/structure/:entity/:id', requirePermission(ORG_VIEW_PERMISSION), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) => structure.getEntity(client, req.ctx, String(req.params.entity), Number(req.params.id)),
    req.ctx
  );
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/structure/:entity', requirePermission(manage('companies')), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) => structure.createEntity(client, req.ctx, String(req.params.entity), req.body ?? {}),
    req.ctx
  );
  res.json({ data: out });
}));

organisationSettingsOpsRouter.patch('/structure/:entity/:id', requirePermission(manage('companies')), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) => structure.updateEntity(client, req.ctx, String(req.params.entity), Number(req.params.id), req.body ?? {}),
    req.ctx
  );
  res.json({ data: out });
}));

// Activate / deactivate / archive / restore. Archiving requires a reason and
// the last live company or branch cannot be retired.
organisationSettingsOpsRouter.post('/structure/:entity/:id/:action', requirePermission(manage('companies')), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) =>
      structure.setEntityStatus(
        client,
        req.ctx,
        String(req.params.entity),
        Number(req.params.id),
        String(req.params.action) as structure.LifecycleAction,
        reasonOf(req.body ?? {})
      ),
    req.ctx
  );
  res.json({ data: out });
}));

// ===========================================================================
// Numbering and sequences
// ===========================================================================

organisationSettingsOpsRouter.get('/numbering/rules', requirePermission(manage('numbering')), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) =>
      numbering.listNumberingRules(client, req.ctx, {
        includeInactive: req.query.includeInactive === 'true' || req.query.includeInactive === '1',
      }),
    req.ctx
  );
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/numbering/rules/:id', requirePermission(manage('numbering')), asyncHandler(async (req, res) => {
  const out = await tx((client) => numbering.getNumberingRule(client, req.ctx, Number(req.params.id)), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/numbering/rules', requirePermission(manage('numbering')), asyncHandler(async (req, res) => {
  const out = await tx((client) => numbering.upsertNumberingRule(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/numbering/rules/:id/active', requirePermission(manage('numbering')), asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const out = await tx(
    (client) => numbering.setNumberingRuleActive(client, req.ctx, Number(req.params.id), body.active === true, reasonOf(body)),
    req.ctx
  );
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/numbering/seed', requirePermission(manage('numbering')), asyncHandler(async (req, res) => {
  const out = await tx((client) => numbering.seedMissingNumberingRules(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/numbering/sequences', requirePermission(manage('numbering')), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) => numbering.listSequences(client, req.ctx, req.query.limit != null ? Number(req.query.limit) : 200),
    req.ctx
  );
  res.json({ data: out });
}));

// Peek only - this never consumes a number. Allocation stays inside the
// transactional services so a settings screen can never burn a document number.
organisationSettingsOpsRouter.get('/numbering/preview/:docType', requirePermission(manage('numbering')), asyncHandler(async (req, res) => {
  const out = await tx(async (client) => {
    const docType = String(req.params.docType);
    const preview = await numbering.previewSequence(client, req.ctx, docType);
    const sample = await numbering.renderSample(client, req.ctx, docType);
    return { preview, sample };
  }, req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/numbering/sequences/:docType/reset', requirePermission(manage('numbering')), asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const out = await tx(
    (client) =>
      numbering.resetSequence(client, req.ctx, String(req.params.docType), {
        reason: reasonOf(body),
        nextSeq: body.nextSeq != null ? Number(body.nextSeq) : null,
        toStart: body.toStart === true,
        force: body.force === true,
      }),
    req.ctx
  );
  res.json({ data: out });
}));

// ===========================================================================
// Fiscal years and accounting periods
// ===========================================================================

organisationSettingsOpsRouter.get('/fiscal/overview', requirePermission(manage('fiscal')), asyncHandler(async (req, res) => {
  const out = await tx((client) => fiscal.fiscalOverview(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/fiscal/years', requirePermission(manage('fiscal')), asyncHandler(async (req, res) => {
  const out = await tx((client) => fiscal.listFiscalYears(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/fiscal/years', requirePermission(manage('fiscal')), asyncHandler(async (req, res) => {
  const out = await tx((client) => fiscal.createFiscalYear(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.patch('/fiscal/years/:id', requirePermission(manage('fiscal')), asyncHandler(async (req, res) => {
  const out = await tx((client) => fiscal.updateFiscalYear(client, req.ctx, Number(req.params.id), req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/fiscal/periods', requirePermission(manage('fiscal')), asyncHandler(async (req, res) => {
  const out = await tx((client) => fiscal.listAccountingPeriods(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/fiscal/periods', requirePermission(manage('fiscal')), asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const out = await tx(
    (client) =>
      fiscal.openAccountingPeriod(client, req.ctx, {
        code: String(body.code ?? ''),
        name: String(body.name ?? ''),
        startDate: String(body.startDate ?? ''),
        endDate: String(body.endDate ?? ''),
        status: body.status != null ? String(body.status) : undefined,
      }),
    req.ctx
  );
  res.json({ data: out });
}));

// One-way ladder: OPEN -> SOFT_CLOSE -> CLOSED -> LOCKED. Going backwards
// (reopen, unlock) requires a reason and is audited.
organisationSettingsOpsRouter.post('/fiscal/periods/:id/move', requirePermission(manage('fiscal')), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) => fiscal.movePeriod(client, req.ctx, Number(req.params.id), req.body as fiscal.PeriodMove),
    req.ctx
  );
  res.json({ data: out });
}));

// ===========================================================================
// Tax
// ===========================================================================

organisationSettingsOpsRouter.get('/tax/categories', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.listTaxCategories(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/tax/categories', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.createTaxCategory(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.patch('/tax/categories/:id', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.updateTaxCategory(client, req.ctx, Number(req.params.id), req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/tax/rates', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) =>
      tax.listTaxRates(client, req.ctx, {
        taxCode: qs(req.query.taxCode),
        includeHistory: String(req.query.includeHistory ?? '') === 'true',
      }),
    req.ctx
  );
  res.json({ data: out });
}));

// A new rate closes the open revision rather than editing history in place.
organisationSettingsOpsRouter.post('/tax/rates', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.createTaxRateRevision(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.patch('/tax/rates/:id', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.updateTaxRate(client, req.ctx, Number(req.params.id), req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/tax/rates/:id/close', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.closeTaxRate(client, req.ctx, Number(req.params.id), req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.delete('/tax/rates/:id', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.deleteTaxRate(client, req.ctx, Number(req.params.id)), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/tax/rates/:taxCode/history', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.taxRateHistory(client, req.ctx, String(req.params.taxCode)), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/tax/resolve', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) => tax.resolveTaxRate(client, req.ctx, String(req.query.taxCode ?? ''), String(req.query.onDate ?? '')),
    req.ctx
  );
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/tax/exemptions', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.listTaxExemptions(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/tax/exemptions', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.createTaxExemption(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.patch('/tax/exemptions/:id', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.updateTaxExemption(client, req.ctx, Number(req.params.id), req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/tax/thresholds', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.listTaxThresholds(client, req.ctx, { taxCode: qs(req.query.taxCode) }), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.put('/tax/thresholds', requirePermission(manage('tax')), asyncHandler(async (req, res) => {
  const out = await tx((client) => tax.replaceTaxThresholds(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

// ===========================================================================
// Approval workflows, levels and fallbacks
// ===========================================================================

organisationSettingsOpsRouter.get('/approvals/workflows', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx((client) => approvals.listWorkflows(client, req.ctx, { documentType: qs(req.query.documentType) }), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/approvals/workflows/:id', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx((client) => approvals.getWorkflow(client, req.ctx, Number(req.params.id)), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/approvals/workflows', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx((client) => approvals.createWorkflow(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.patch('/approvals/workflows/:id', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx((client) => approvals.updateWorkflow(client, req.ctx, Number(req.params.id), req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/approvals/workflows/:id/deactivate', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx((client) => approvals.deactivateWorkflow(client, req.ctx, Number(req.params.id)), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/approvals/levels', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx((client) => approvals.createLevel(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.patch('/approvals/levels/:id', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx((client) => approvals.updateLevel(client, req.ctx, Number(req.params.id), req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.delete('/approvals/levels/:id', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx((client) => approvals.deleteLevel(client, req.ctx, Number(req.params.id)), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/approvals/fallbacks', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx((client) => approvals.listFallbackRules(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/approvals/fallbacks', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx((client) => approvals.createFallbackRule(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.patch('/approvals/fallbacks/:id', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx((client) => approvals.updateFallbackRule(client, req.ctx, Number(req.params.id), req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.delete('/approvals/fallbacks/:id', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx((client) => approvals.deleteFallbackRule(client, req.ctx, Number(req.params.id)), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/approvals/resolve', requirePermission(manage('approvals')), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) =>
      approvals.resolveApprovalChain(
        client,
        req.ctx,
        String(req.query.documentType ?? ''),
        req.query.amount != null ? Number(req.query.amount) : null,
        req.query.branchId != null ? Number(req.query.branchId) : null
      ),
    req.ctx
  );
  res.json({ data: out });
}));

// ===========================================================================
// Security policy, segregation of duties and network rules
// ===========================================================================

organisationSettingsOpsRouter.get('/security/overview', requirePermission(manage('security')), asyncHandler(async (req, res) => {
  const out = await tx((client) => security.securityOverview(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/security/policy', requirePermission(manage('security')), asyncHandler(async (req, res) => {
  const out = await tx((client) => security.getSecurityPolicyRow(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.put('/security/policy', requirePermission(manage('security')), asyncHandler(async (req, res) => {
  const out = await tx((client) => security.saveSecurityPolicy(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/security/sod', requirePermission(manage('security')), asyncHandler(async (req, res) => {
  const out = await tx((client) => security.listSodRules(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/security/sod', requirePermission(manage('security')), asyncHandler(async (req, res) => {
  const out = await tx((client) => security.createSodRule(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.patch('/security/sod/:id', requirePermission(manage('security')), asyncHandler(async (req, res) => {
  const out = await tx((client) => security.updateSodRule(client, req.ctx, Number(req.params.id), req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.delete('/security/sod/:id', requirePermission(manage('security')), asyncHandler(async (req, res) => {
  const out = await tx((client) => security.deleteSodRule(client, req.ctx, Number(req.params.id)), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/security/ip-rules', requirePermission(manage('security')), asyncHandler(async (req, res) => {
  const out = await tx((client) => security.listIpRules(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/security/ip-rules', requirePermission(manage('security')), asyncHandler(async (req, res) => {
  const out = await tx((client) => security.createIpRule(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.patch('/security/ip-rules/:id', requirePermission(manage('security')), asyncHandler(async (req, res) => {
  const out = await tx((client) => security.updateIpRule(client, req.ctx, Number(req.params.id), req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.delete('/security/ip-rules/:id', requirePermission(manage('security')), asyncHandler(async (req, res) => {
  const out = await tx((client) => security.deleteIpRule(client, req.ctx, Number(req.params.id)), req.ctx);
  res.json({ data: out });
}));

// ===========================================================================
// Integrations (secrets are write-only; the API never returns them)
// ===========================================================================

organisationSettingsOpsRouter.get('/integrations', requirePermission(manage('integrations')), asyncHandler(async (req, res) => {
  const out = await tx((client) => integrations.listIntegrations(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/integrations/registry', requirePermission(ORG_VIEW_PERMISSION), asyncHandler(async (_req, res) => {
  res.json({ data: integrations.integrationRegistry() });
}));

organisationSettingsOpsRouter.get('/integrations/logs', requirePermission(manage('integrations')), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) =>
      integrations.listIntegrationLogs(client, req.ctx, {
        code: qs(req.query.code),
        limit: req.query.limit != null ? Number(req.query.limit) : undefined,
      }),
    req.ctx
  );
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/integrations/:code', requirePermission(manage('integrations')), asyncHandler(async (req, res) => {
  const out = await tx((client) => integrations.getIntegration(client, req.ctx, String(req.params.code)), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.patch('/integrations/:code', requirePermission(manage('integrations')), asyncHandler(async (req, res) => {
  const out = await tx(
    (client) => integrations.saveIntegration(client, req.ctx, String(req.params.code), req.body ?? {}),
    req.ctx
  );
  res.json({ data: out });
}));

// Records the outcome of a connectivity probe performed against the provider.
organisationSettingsOpsRouter.post('/integrations/:code/test-result', requirePermission(manage('integrations')), asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const out = await tx(
    (client) =>
      integrations.recordIntegrationTest(client, req.ctx, String(req.params.code), {
        ok: body.ok === true,
        detail: qs(body.detail),
      }),
    req.ctx
  );
  res.json({ data: out });
}));

// ===========================================================================
// Retention and backup
// ===========================================================================

organisationSettingsOpsRouter.get('/retention/overview', requirePermission(manage('backup')), asyncHandler(async (req, res) => {
  const out = await tx((client) => retention.retentionOverview(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/retention/policies', requirePermission(manage('backup')), asyncHandler(async (req, res) => {
  const out = await tx((client) => retention.listRetentionPolicies(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/retention/policies/:id', requirePermission(manage('backup')), asyncHandler(async (req, res) => {
  const out = await tx((client) => retention.getRetentionPolicy(client, req.ctx, Number(req.params.id)), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.put('/retention/policies', requirePermission(manage('backup')), asyncHandler(async (req, res) => {
  const out = await tx((client) => retention.upsertRetentionPolicy(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/retention/policies/:id/legal-hold', requirePermission(manage('backup')), asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const out = await tx(
    (client) => retention.setRetentionLegalHold(client, req.ctx, Number(req.params.id), body.hold === true, reasonOf(body)),
    req.ctx
  );
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/backup/policies', requirePermission(manage('backup')), asyncHandler(async (req, res) => {
  const out = await tx((client) => retention.listBackupPolicies(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/backup/policies', requirePermission(manage('backup')), asyncHandler(async (req, res) => {
  const out = await tx((client) => retention.upsertBackupPolicy(client, req.ctx, req.body ?? {}), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.post('/backup/policies/:id/active', requirePermission(manage('backup')), asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const out = await tx(
    (client) => retention.setBackupPolicyActive(client, req.ctx, Number(req.params.id), body.active === true, reasonOf(body)),
    req.ctx
  );
  res.json({ data: out });
}));

// ===========================================================================
// Signatures - thin reads over the governance service; the signing chain and
// the profile lifecycle stay in the governance router.
// ===========================================================================

organisationSettingsOpsRouter.get('/signatures/overview', requirePermission(manage('signatures')), asyncHandler(async (req, res) => {
  const out = await tx((client) => signatures.signatureOverview(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

organisationSettingsOpsRouter.get('/signatures/profiles/:id', requirePermission(manage('signatures')), asyncHandler(async (req, res) => {
  const out = await tx((client) => signatures.requireSignatureProfile(client, req.ctx, Number(req.params.id)), req.ctx);
  res.json({ data: out });
}));

// Advisory check: may this profile sign this document at this amount?
organisationSettingsOpsRouter.post('/signatures/can-sign', requirePermission(manage('signatures')), asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const out = await tx(
    (client) =>
      signatures.canSign(client, req.ctx, {
        profileId: Number(body.profileId),
        documentType: String(body.documentType ?? ''),
        amount: body.amount != null ? Number(body.amount) : null,
        transactionType: qs(body.transactionType),
      }),
    req.ctx
  );
  res.json({ data: out });
}));
