import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils.js';
import * as intelligence from '../../services/intelligence/service.js';

export const intelligenceOpsRouter = Router();

type OpFn = (
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>,
  params: Record<string, string>
) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

const intParam = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// --- Dashboard (section A) ---------------------------------------------------
intelligenceOpsRouter.get('/dashboard', requirePermission('intelligence.dashboard.view'), asyncHandler(async (req, res) => {
  const out = await tx((client) => intelligence.intelligenceDashboard(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

// --- Providers (section E) ---------------------------------------------------
intelligenceOpsRouter.get('/providers', requirePermission('intelligence.providers.view'), asyncHandler(async (_req, res) => {
  res.json({
    data: {
      searchProvider: (process.env.SEARCH_PROVIDER ?? 'sandbox').trim().toLowerCase(),
      aiProvider: (process.env.AI_PROVIDER ?? (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'heuristic')).trim().toLowerCase(),
      aiConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
    },
  });
}));

// --- Campaigns (section B) ----------------------------------------------------
intelligenceOpsRouter.get('/campaigns', requirePermission('intelligence.campaigns.view'), asyncHandler(async (req, res) => {
  const out = await tx((client) => intelligence.listCampaigns(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

intelligenceOpsRouter.post('/campaigns', ...run('intelligence.campaigns.create', (c, ctx, b) => intelligence.createCampaign(c, ctx, b)));
intelligenceOpsRouter.get('/campaigns/:id', ...run('intelligence.campaigns.view', (c, ctx, _b, p) => intelligence.getCampaign(c, ctx, Number(p.id))));
intelligenceOpsRouter.patch('/campaigns/:id', ...run('intelligence.campaigns.update', (c, ctx, b, p) => intelligence.updateCampaign(c, ctx, Number(p.id), b)));
intelligenceOpsRouter.delete('/campaigns/:id', ...run('intelligence.campaigns.delete', (c, ctx, _b, p) => intelligence.deleteCampaign(c, ctx, Number(p.id))));
intelligenceOpsRouter.post('/campaigns/:id/status', ...run('intelligence.campaigns.update', (c, ctx, b, p) => {
  return intelligence.changeCampaignStatus(c, ctx, Number(p.id), String(b.status ?? ''));
}));

// Run a campaign: load criteria (tx) -> discover + enrich (network) -> persist (tx).
intelligenceOpsRouter.post('/campaigns/:id/run', requirePermission('intelligence.campaigns.run'), asyncHandler(async (req, res) => {
  const campaignId = Number(req.params.id);
  const loaded = await tx((client) => intelligence.loadCampaignForRun(client, req.ctx, campaignId), req.ctx);
  const enriched = await intelligence.runCampaignDiscovery(loaded.criteria, loaded.maxResults);
  const out = await tx((client) => intelligence.persistCampaignRun(client, req.ctx, campaignId, enriched), req.ctx);
  res.json({ data: out });
}));

// --- Prospects (sections G/H/I) ----------------------------------------------
intelligenceOpsRouter.get('/prospects', requirePermission('intelligence.prospects.view'), asyncHandler(async (req, res) => {
  const out = await tx((client) => intelligence.listProspects(client, req.ctx, {
    status: req.query.status != null && String(req.query.status).length > 0 ? String(req.query.status) : null,
    industry: req.query.industry != null && String(req.query.industry).length > 0 ? String(req.query.industry) : null,
    campaignId: intParam(req.query.campaignId),
    q: req.query.q != null && String(req.query.q).length > 0 ? String(req.query.q) : null,
  }), req.ctx);
  res.json({ data: out });
}));

// Manual prospect: enrich (network) -> persist (tx).
intelligenceOpsRouter.post('/prospects', requirePermission('intelligence.prospects.create'), asyncHandler(async (req, res) => {
  const enriched = await intelligence.enrichManualInput(req.body ?? {});
  const campaignId = req.body?.campaignId != null ? Number(req.body.campaignId) : null;
  const out = await tx((client) => intelligence.persistManualProspect(client, req.ctx, enriched, campaignId), req.ctx);
  res.json({ data: out });
}));

intelligenceOpsRouter.get('/prospects/:id', ...run('intelligence.prospects.view', (c, ctx, _b, p) => intelligence.getProspect(c, ctx, Number(p.id))));
intelligenceOpsRouter.patch('/prospects/:id', ...run('intelligence.prospects.update', (c, ctx, b, p) => intelligence.updateProspect(c, ctx, Number(p.id), b)));
intelligenceOpsRouter.delete('/prospects/:id', ...run('intelligence.prospects.delete', (c, ctx, _b, p) => intelligence.deleteProspect(c, ctx, Number(p.id))));

// Re-enrich: load (tx) -> website + AI (network) -> update (tx).
intelligenceOpsRouter.post('/prospects/:id/enrich', requirePermission('intelligence.prospects.enrich'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const row = await tx((client) => intelligence.getProspectRow(client, req.ctx, id), req.ctx);
  const enriched = await intelligence.enrichProspectResult(intelligence.prospectToResult(row));
  const out = await tx((client) => intelligence.enrichExistingProspect(client, req.ctx, id, enriched), req.ctx);
  res.json({ data: out });
}));

intelligenceOpsRouter.post('/prospects/:id/review', ...run('intelligence.prospects.review', (c, ctx, b, p) =>
  intelligence.reviewProspect(c, ctx, Number(p.id), String(b.decision ?? ''), b.notes != null ? String(b.notes) : null)
));

intelligenceOpsRouter.post('/prospects/:id/convert', ...run('intelligence.prospects.convert', (c, ctx, _b, p) =>
  intelligence.convertProspect(c, ctx, Number(p.id))
));
