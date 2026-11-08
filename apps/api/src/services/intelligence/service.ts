import pg from 'pg';
import { Ctx, query, tx } from '../../db.js';
import { badRequest, notFound } from '../../utils.js';
import { logAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { createCustomer, createLead, createOpportunity } from '../crm.js';
import { duplicateScore, DUPLICATE_THRESHOLD, scoreProspect, type DuplicateCandidate } from './scoring.js';
import { resolveAiEngine } from './ai.js';
import { resolveProvider } from './providers.js';
import { intelligenceFromWebsite } from './website.js';
import { CAMPAIGN_STATUSES } from './types.js';
import type {
  AiAnalysis,
  AiEngine,
  DiscoveryQuery,
  DiscoveryResult,
  ScoreResult,
  WebsiteIntel,
} from './types.js';

/**
 * Natex Intelligence service: discovery campaigns, the prospect database,
 * explainable scoring, duplicate detection, human review and CRM conversion.
 *
 * Network work (provider search, website fetch, AI analysis) never runs inside
 * a transaction: the route/worker does the slow calls first and then persists
 * the finished, immutable result in a short transaction. This mirrors the
 * codebase's "send email after COMMIT" discipline.
 */

type PoolClient = pg.PoolClient;

const MAX_RESULTS_DEFAULT = 50;
const MAX_RESULTS_CAP = 500;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function intParam(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((s) => String(s).trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

export function coerceCriteria(input: unknown): DiscoveryQuery {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: DiscoveryQuery = {};
  if (typeof o.query === 'string' && o.query.trim()) out.query = o.query.trim().slice(0, 500);
  const industries = strArray(o.industries);
  const countries = strArray(o.countries);
  const regions = strArray(o.regions);
  const cities = strArray(o.cities);
  const keywords = strArray(o.keywords);
  if (industries) out.industries = industries.slice(0, 50);
  if (countries) out.countries = countries.slice(0, 50);
  if (regions) out.regions = regions.slice(0, 50);
  if (cities) out.cities = cities.slice(0, 50);
  if (keywords) out.keywords = keywords.slice(0, 50);
  if (o.minEmployees != null) out.minEmployees = intParam(o.minEmployees, 0, 1_000_000, 0) || null;
  if (o.maxEmployees != null) out.maxEmployees = intParam(o.maxEmployees, 0, 1_000_000, 0) || null;
  return out;
}

export function coerceSchedule(input: unknown): { enabled: boolean; everyMs: number } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const everyMs = intParam(o.everyMs, 60_000, 31 * 24 * 60 * 60 * 1000, 86_400_000);
  return { enabled: Boolean(o.enabled), everyMs };
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function prospectToOut(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: num(row.id),
    companyId: num(row.company_id),
    tenantId: num(row.tenant_id),
    branchId: num(row.branch_id),
    code: row.code,
    campaignId: num(row.campaign_id),
    name: row.name,
    legalName: row.legal_name,
    industry: row.industry,
    country: row.country,
    region: row.region,
    city: row.city,
    website: row.website,
    email: row.email,
    phone: row.phone,
    employeesMin: num(row.employees_min),
    employeesMax: num(row.employees_max),
    revenueMin: num(row.revenue_min),
    revenueMax: num(row.revenue_max),
    sourceProvider: row.source_provider,
    sourceQuery: row.source_query,
    sourceRank: num(row.source_rank),
    status: row.status,
    score: num(row.score),
    scoreVersion: num(row.score_version),
    scoreFactors: row.score_factors ?? [],
    duplicateOf: num(row.duplicate_of),
    duplicateScore: num(row.duplicate_score),
    extracted: row.extracted ?? {},
    ai: row.ai ?? {},
    raw: row.raw ?? {},
    convertedCustomerId: num(row.converted_customer_id),
    convertedLeadId: num(row.converted_lead_id),
    convertedAt: row.converted_at,
    reviewedBy: num(row.reviewed_by),
    reviewedAt: row.reviewed_at,
    reviewNotes: row.review_notes,
    attributes: row.attributes ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function campaignToOut(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: num(row.id),
    companyId: num(row.company_id),
    tenantId: num(row.tenant_id),
    branchId: num(row.branch_id),
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    criteria: row.criteria ?? {},
    schedule: row.schedule ?? { enabled: false, everyMs: 86_400_000 },
    ownerUserId: num(row.owner_user_id),
    maxResults: num(row.max_results),
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    runCount: num(row.run_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function nextDoc(client: PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

function requireCompany(ctx: Ctx): number {
  if (!ctx.companyId) throw badRequest('Company context required');
  return ctx.companyId;
}

// ---------------------------------------------------------------------------
// Enrichment (network-side; never call inside a transaction)
// ---------------------------------------------------------------------------

export interface EnrichedProspect {
  result: DiscoveryResult;
  extracted: WebsiteIntel;
  analysis: AiAnalysis;
  score: ScoreResult;
}

async function enrichResult(result: DiscoveryResult, engine: AiEngine): Promise<EnrichedProspect> {
  const extracted = await intelligenceFromWebsite(result.website);
  const analysis = await engine.analyze({
    name: result.name,
    industry: result.industry,
    website: result.website,
    description: result.description ?? extracted.description ?? extracted.textSample,
    country: result.country,
    city: result.city,
    employees: result.employeesMin != null ? `${result.employeesMin}-${result.employeesMax ?? result.employeesMin}` : null,
    extractedText: extracted.textSample,
  });
  const score = scoreProspect({
    name: result.name,
    website: result.website,
    email: result.email,
    phone: result.phone,
    industry: analysis.industryClass ?? result.industry,
    country: result.country,
    city: result.city,
    employeesMin: result.employeesMin,
    employeesMax: result.employeesMax,
    revenueMin: result.revenueMin,
    revenueMax: result.revenueMax,
    websiteOk: extracted.websiteOk,
    websiteEmails: extracted.emails?.length ?? 0,
    icpFit: analysis.icpFit,
    industryClass: analysis.industryClass,
  });
  return { result, extracted, analysis, score };
}

/** Enrich a single DiscoveryResult (network-side) with the configured engine. */
export async function enrichProspectResult(result: DiscoveryResult): Promise<EnrichedProspect> {
  return enrichResult(result, resolveAiEngine());
}

/** Run a discovery query and enrich every result. Pure network work. */
export async function runCampaignDiscovery(criteria: DiscoveryQuery, maxResults?: number): Promise<EnrichedProspect[]> {
  const provider = resolveProvider();
  const engine = resolveAiEngine();
  const results = await provider.search({
    ...criteria,
    maxResults: intParam(maxResults ?? MAX_RESULTS_DEFAULT, 1, MAX_RESULTS_CAP, MAX_RESULTS_DEFAULT),
  });
  const enriched: EnrichedProspect[] = [];
  for (const result of results) {
    enriched.push(await enrichResult(result, engine));
  }
  return enriched;
}

// ---------------------------------------------------------------------------
// Duplicate detection (section J)
// ---------------------------------------------------------------------------

async function findBestDuplicate(
  client: PoolClient,
  ctx: Ctx,
  candidate: DuplicateCandidate,
  excludeId: number | null
): Promise<{ id: number; score: number } | null> {
  const { rows } = await client.query(
    `SELECT id, name, website, email, phone, industry, city
       FROM prospects
      WHERE tenant_id = $1
        AND ($2::bigint IS NULL OR company_id = $2)
        AND ($3::bigint IS NULL OR id <> $3)`,
    [ctx.tenantId, ctx.companyId ?? null, excludeId]
  );
  let best: { id: number; score: number } | null = null;
  for (const r of rows as Record<string, unknown>[]) {
    const score = duplicateScore(candidate, {
      name: String(r.name ?? ''),
      website: String(r.website ?? ''),
      email: String(r.email ?? ''),
      phone: String(r.phone ?? ''),
      industry: String(r.industry ?? ''),
      city: String(r.city ?? ''),
    });
    if (score >= DUPLICATE_THRESHOLD && (!best || score > best.score)) {
      best = { id: Number(r.id), score };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Prospect persistence
// ---------------------------------------------------------------------------

interface InsertProspectInput {
  campaignId: number | null;
  result: DiscoveryResult;
  extracted: WebsiteIntel;
  analysis: AiAnalysis;
  score: ScoreResult;
  duplicateOf: number | null;
  duplicateScore: number | null;
}

async function insertProspectRow(client: PoolClient, ctx: Ctx, input: InsertProspectInput): Promise<{ id: number; code: string }> {
  const code = await nextDoc(client, ctx, 'PRS');
  const r = input.result;
  const ins = await client.query(
    `INSERT INTO prospects
       (company_id, tenant_id, branch_id, code, campaign_id, name, legal_name, industry, country, region, city,
        website, email, phone, employees_min, employees_max, revenue_min, revenue_max,
        source_provider, source_query, source_rank, score, score_factors,
        duplicate_of, duplicate_score, extracted, ai, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     RETURNING id`,
    [
      ctx.companyId,
      ctx.tenantId,
      ctx.branchId ?? null,
      code,
      input.campaignId,
      r.name.trim(),
      r.legalName ?? null,
      input.analysis.industryClass ?? r.industry ?? null,
      r.country ?? null,
      r.region ?? null,
      r.city ?? null,
      r.website ?? null,
      r.email ?? null,
      r.phone ?? null,
      r.employeesMin ?? null,
      r.employeesMax ?? null,
      r.revenueMin ?? null,
      r.revenueMax ?? null,
      r.sourceProvider,
      r.sourceQuery ?? null,
      r.sourceRank ?? null,
      input.score.score,
      JSON.stringify(input.score.factors),
      input.duplicateOf,
      input.duplicateScore,
      JSON.stringify(input.extracted),
      JSON.stringify({
        industryClass: input.analysis.industryClass ?? null,
        icpFit: input.analysis.icpFit,
        rationale: input.analysis.rationale,
        buyingSignals: input.analysis.buyingSignals,
        tags: input.analysis.tags,
        source: input.analysis.source,
      }),
      JSON.stringify(r.raw ?? {}),
    ]
  );
  const id = Number(ins.rows[0].id);
  await emitEvent(client, ctx, { eventType: 'intelligence.prospect_created', entityType: 'prospects', entityId: id, entityCode: code });
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'intelligence.prospects',
    recordId: id,
    recordCode: code,
    newValues: { name: r.name, score: input.score.score, duplicateOf: input.duplicateOf },
  });
  return { id, code };
}

/** Persist enriched discovery results and advance the campaign counters. */
export async function persistCampaignRun(
  client: PoolClient,
  ctx: Ctx,
  campaignId: number,
  enriched: EnrichedProspect[]
): Promise<{ discovered: number; inserted: number; duplicates: number }> {
  let inserted = 0;
  let duplicates = 0;
  for (const e of enriched) {
    const best = await findBestDuplicate(client, ctx, {
      name: e.result.name,
      website: e.result.website,
      email: e.result.email,
      phone: e.result.phone,
      industry: e.result.industry,
      city: e.result.city,
    }, null);
    await insertProspectRow(client, ctx, {
      campaignId,
      result: e.result,
      extracted: e.extracted,
      analysis: e.analysis,
      score: e.score,
      duplicateOf: best ? best.id : null,
      duplicateScore: best ? best.score : null,
    });
    inserted += 1;
    if (best) duplicates += 1;
  }
  await client.query(
    `UPDATE discovery_campaigns SET last_run_at = now(), run_count = run_count + 1, updated_at = now() WHERE id = $1`,
    [campaignId]
  );
  return { discovered: enriched.length, inserted, duplicates };
}

/** Load a campaign's targeting config for a run (short transaction). */
export async function loadCampaignForRun(
  client: PoolClient,
  ctx: Ctx,
  campaignId: number
): Promise<{ criteria: DiscoveryQuery; maxResults: number; code: string; name: string }> {
  const res = await client.query(
    `SELECT * FROM discovery_campaigns WHERE id = $1 AND tenant_id = $2 AND ($3::bigint IS NULL OR company_id = $3)`,
    [campaignId, ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Campaign not found');
  const row = res.rows[0] as Record<string, unknown>;
  return {
    criteria: coerceCriteria(row.criteria),
    maxResults: Number(row.max_results),
    code: String(row.code),
    name: String(row.name),
  };
}

// ---------------------------------------------------------------------------
// Campaign CRUD
// ---------------------------------------------------------------------------

export async function listCampaigns(client: PoolClient, ctx: Ctx): Promise<Record<string, unknown>[]> {
  const res = await client.query(
    `SELECT * FROM discovery_campaigns
      WHERE tenant_id = $1 AND ($2::bigint IS NULL OR company_id = $2)
      ORDER BY created_at DESC
      LIMIT 200`,
    [ctx.tenantId, ctx.companyId ?? null]
  );
  return (res.rows as Record<string, unknown>[]).map(campaignToOut);
}

export async function getCampaign(client: PoolClient, ctx: Ctx, campaignId: number): Promise<Record<string, unknown>> {
  const res = await client.query(
    `SELECT * FROM discovery_campaigns WHERE id = $1 AND tenant_id = $2 AND ($3::bigint IS NULL OR company_id = $3)`,
    [campaignId, ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Campaign not found');
  return campaignToOut(res.rows[0] as Record<string, unknown>);
}

export async function createCampaign(
  client: PoolClient,
  ctx: Ctx,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = String(input.name ?? '').trim();
  if (!name) throw badRequest('Campaign name is required');
  const code = await nextDoc(client, ctx, 'CAM');
  const criteria = coerceCriteria(input.criteria);
  const schedule = coerceSchedule(input.schedule);
  const maxResults = intParam(input.maxResults, 1, MAX_RESULTS_CAP, MAX_RESULTS_DEFAULT);
  const ins = await client.query(
    `INSERT INTO discovery_campaigns
       (company_id, tenant_id, branch_id, code, name, description, criteria, schedule, owner_user_id, max_results)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)
     RETURNING *`,
    [
      ctx.companyId,
      ctx.tenantId,
      ctx.branchId ?? null,
      code,
      name,
      input.description != null ? String(input.description) : null,
      JSON.stringify(criteria),
      JSON.stringify(schedule),
      ctx.userId ?? null,
      maxResults,
    ]
  );
  await logAudit(client, ctx, { action: 'create', resource: 'intelligence.campaigns', recordId: Number(ins.rows[0].id), recordCode: code, newValues: { name } });
  return campaignToOut(ins.rows[0] as Record<string, unknown>);
}

export async function updateCampaign(
  client: PoolClient,
  ctx: Ctx,
  campaignId: number,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await client.query(
    `SELECT * FROM discovery_campaigns WHERE id = $1 AND tenant_id = $2 AND ($3::bigint IS NULL OR company_id = $3) FOR UPDATE`,
    [campaignId, ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Campaign not found');
  const sets: string[] = [];
  const params: unknown[] = [];
  const setCol = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw badRequest('Campaign name is required');
    setCol('name', name);
  }
  if (input.description !== undefined) setCol('description', input.description != null ? String(input.description) : null);
  if (input.criteria !== undefined) {
    params.push(JSON.stringify(coerceCriteria(input.criteria)));
    sets.push(`criteria = $${params.length}::jsonb`);
  }
  if (input.schedule !== undefined) {
    params.push(JSON.stringify(coerceSchedule(input.schedule)));
    sets.push(`schedule = $${params.length}::jsonb`);
  }
  if (input.maxResults !== undefined) setCol('max_results', intParam(input.maxResults, 1, MAX_RESULTS_CAP, MAX_RESULTS_DEFAULT));
  if (sets.length === 0) throw badRequest('Nothing to update');
  params.push(campaignId);
  const up = await client.query(
    `UPDATE discovery_campaigns SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  return campaignToOut(up.rows[0] as Record<string, unknown>);
}

export async function changeCampaignStatus(
  client: PoolClient,
  ctx: Ctx,
  campaignId: number,
  status: string
): Promise<Record<string, unknown>> {
  if (!(CAMPAIGN_STATUSES as readonly string[]).includes(status)) throw badRequest('Unknown campaign status');
  const res = await client.query(
    `SELECT * FROM discovery_campaigns WHERE id = $1 AND tenant_id = $2 AND ($3::bigint IS NULL OR company_id = $3) FOR UPDATE`,
    [campaignId, ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Campaign not found');
  const nextRun = status === 'ACTIVE' ? ', next_run_at = now()' : '';
  const up = await client.query(
    `UPDATE discovery_campaigns SET status = $1, updated_at = now() ${nextRun} WHERE id = $2 RETURNING *`,
    [status, campaignId]
  );
  await logAudit(client, ctx, { action: 'update', resource: 'intelligence.campaigns', recordId: campaignId, recordCode: String(res.rows[0].code), newValues: { status } });
  return campaignToOut(up.rows[0] as Record<string, unknown>);
}

export async function deleteCampaign(client: PoolClient, ctx: Ctx, campaignId: number): Promise<{ deleted: boolean }> {
  const res = await client.query(
    `SELECT status FROM discovery_campaigns WHERE id = $1 AND tenant_id = $2 AND ($3::bigint IS NULL OR company_id = $3) FOR UPDATE`,
    [campaignId, ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Campaign not found');
  if (!['DRAFT', 'ARCHIVED', 'COMPLETED'].includes(String(res.rows[0].status))) {
    throw badRequest('Pause the campaign before deleting it');
  }
  await client.query(`DELETE FROM discovery_campaigns WHERE id = $1`, [campaignId]);
  await logAudit(client, ctx, { action: 'delete', resource: 'intelligence.campaigns', recordId: campaignId, recordCode: String(res.rows[0].code ?? campaignId) });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Prospect CRUD / enrich / review / convert
// ---------------------------------------------------------------------------

export interface ProspectFilters {
  status?: string | null;
  industry?: string | null;
  campaignId?: number | null;
  q?: string | null;
  limit?: number;
}

export async function listProspects(client: PoolClient, ctx: Ctx, filters: ProspectFilters = {}): Promise<Record<string, unknown>[]> {
  const limit = intParam(filters.limit, 1, 500, 100);
  const res = await client.query(
    `SELECT * FROM prospects
      WHERE tenant_id = $1
        AND ($2::bigint IS NULL OR company_id = $2)
        AND ($3::text IS NULL OR status = $3)
        AND ($4::text IS NULL OR industry = $4)
        AND ($5::bigint IS NULL OR campaign_id = $5)
        AND ($6::text IS NULL OR name ILIKE '%' || $6 || '%')
      ORDER BY COALESCE(score, -1) DESC, created_at DESC
      LIMIT $7`,
    [
      ctx.tenantId,
      ctx.companyId ?? null,
      filters.status ?? null,
      filters.industry ?? null,
      filters.campaignId ?? null,
      filters.q && String(filters.q).trim() ? String(filters.q).trim() : null,
      limit,
    ]
  );
  return (res.rows as Record<string, unknown>[]).map(prospectToOut);
}

export async function getProspect(client: PoolClient, ctx: Ctx, prospectId: number): Promise<Record<string, unknown>> {
  const res = await client.query(
    `SELECT * FROM prospects WHERE id = $1 AND tenant_id = $2 AND ($3::bigint IS NULL OR company_id = $3)`,
    [prospectId, ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Prospect not found');
  return prospectToOut(res.rows[0] as Record<string, unknown>);
}

/** Raw (snake_case) prospect row, for building a re-enrichment input. */
export async function getProspectRow(client: PoolClient, ctx: Ctx, prospectId: number): Promise<Record<string, unknown>> {
  const res = await client.query(
    `SELECT * FROM prospects WHERE id = $1 AND tenant_id = $2 AND ($3::bigint IS NULL OR company_id = $3)`,
    [prospectId, ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Prospect not found');
  return res.rows[0] as Record<string, unknown>;
}

function manualResult(input: Record<string, unknown>): DiscoveryResult {
  return {
    name: String(input.name ?? '').trim(),
    legalName: input.legalName != null ? String(input.legalName) : null,
    website: input.website != null ? String(input.website) : null,
    email: input.email != null ? String(input.email) : null,
    phone: input.phone != null ? String(input.phone) : null,
    industry: input.industry != null ? String(input.industry) : null,
    country: input.country != null ? String(input.country) : null,
    region: input.region != null ? String(input.region) : null,
    city: input.city != null ? String(input.city) : null,
    employeesMin: input.employeesMin != null ? Number(input.employeesMin) || null : null,
    employeesMax: input.employeesMax != null ? Number(input.employeesMax) || null : null,
    revenueMin: input.revenueMin != null ? Number(input.revenueMin) || null : null,
    revenueMax: input.revenueMax != null ? Number(input.revenueMax) || null : null,
    description: input.description != null ? String(input.description) : null,
    sourceRank: 1,
    sourceProvider: 'manual',
    sourceQuery: null,
    raw: { manual: true },
  };
}

/** Manual prospect creation. Enrichment happens outside the transaction. */
export async function persistManualProspect(
  client: PoolClient,
  ctx: Ctx,
  enriched: EnrichedProspect,
  campaignId: number | null
): Promise<Record<string, unknown>> {
  const best = await findBestDuplicate(client, ctx, {
    name: enriched.result.name,
    website: enriched.result.website,
    email: enriched.result.email,
    phone: enriched.result.phone,
    industry: enriched.result.industry,
    city: enriched.result.city,
  }, null);
  const { id } = await insertProspectRow(client, ctx, {
    campaignId,
    result: enriched.result,
    extracted: enriched.extracted,
    analysis: enriched.analysis,
    score: enriched.score,
    duplicateOf: best ? best.id : null,
    duplicateScore: best ? best.score : null,
  });
  const res = await client.query(`SELECT * FROM prospects WHERE id = $1`, [id]);
  return prospectToOut(res.rows[0] as Record<string, unknown>);
}

/** Build the enrich payload for a single manual input (network-side). */
export async function enrichManualInput(input: Record<string, unknown>): Promise<EnrichedProspect> {
  const name = String(input.name ?? '').trim();
  if (!name) throw badRequest('Prospect name is required');
  return enrichResult(manualResult(input), resolveAiEngine());
}

/** Re-run website + AI + scoring for an existing prospect. */
export async function enrichExistingProspect(
  client: PoolClient,
  ctx: Ctx,
  prospectId: number,
  enriched: EnrichedProspect
): Promise<Record<string, unknown>> {
  const res = await client.query(
    `SELECT * FROM prospects WHERE id = $1 AND tenant_id = $2 AND ($3::bigint IS NULL OR company_id = $3) FOR UPDATE`,
    [prospectId, ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Prospect not found');
  const up = await client.query(
    `UPDATE prospects
        SET extracted = $2::jsonb, ai = $3::jsonb, score = $4, score_factors = $5::jsonb,
            score_version = score_version + 1, industry = COALESCE($6, industry), updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      prospectId,
      JSON.stringify(enriched.extracted),
      JSON.stringify({
        industryClass: enriched.analysis.industryClass ?? null,
        icpFit: enriched.analysis.icpFit,
        rationale: enriched.analysis.rationale,
        buyingSignals: enriched.analysis.buyingSignals,
        tags: enriched.analysis.tags,
        source: enriched.analysis.source,
      }),
      enriched.score.score,
      JSON.stringify(enriched.score.factors),
      enriched.analysis.industryClass ?? null,
    ]
  );
  return prospectToOut(up.rows[0] as Record<string, unknown>);
}

/** Build a DiscoveryResult from an existing prospect row for re-enrichment. */
export function prospectToResult(row: Record<string, unknown>): DiscoveryResult {
  return {
    name: String(row.name ?? ''),
    legalName: row.legal_name != null ? String(row.legal_name) : null,
    website: row.website != null ? String(row.website) : null,
    email: row.email != null ? String(row.email) : null,
    phone: row.phone != null ? String(row.phone) : null,
    industry: row.industry != null ? String(row.industry) : null,
    country: row.country != null ? String(row.country) : null,
    region: row.region != null ? String(row.region) : null,
    city: row.city != null ? String(row.city) : null,
    employeesMin: num(row.employees_min),
    employeesMax: num(row.employees_max),
    revenueMin: num(row.revenue_min),
    revenueMax: num(row.revenue_max),
    description: null,
    sourceRank: num(row.source_rank) ?? 1,
    sourceProvider: String(row.source_provider ?? 'manual'),
    sourceQuery: row.source_query != null ? String(row.source_query) : null,
    raw: (row.raw ?? {}) as Record<string, unknown>,
  };
}

export async function updateProspect(
  client: PoolClient,
  ctx: Ctx,
  prospectId: number,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await client.query(
    `SELECT * FROM prospects WHERE id = $1 AND tenant_id = $2 AND ($3::bigint IS NULL OR company_id = $3) FOR UPDATE`,
    [prospectId, ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Prospect not found');
  const sets: string[] = [];
  const params: unknown[] = [];
  const setCol = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  const editable = ['name', 'legalName', 'industry', 'country', 'region', 'city', 'website', 'email', 'phone'] as const;
  const colMap: Record<string, string> = { legalName: 'legal_name' };
  for (const key of editable) {
    if (input[key] !== undefined) setCol(colMap[key] ?? key, input[key] != null ? String(input[key]) : null);
  }
  if (input.employeesMin !== undefined) setCol('employees_min', input.employeesMin != null ? Number(input.employeesMin) || null : null);
  if (input.employeesMax !== undefined) setCol('employees_max', input.employeesMax != null ? Number(input.employeesMax) || null : null);
  if (input.revenueMin !== undefined) setCol('revenue_min', input.revenueMin != null ? Number(input.revenueMin) || null : null);
  if (input.revenueMax !== undefined) setCol('revenue_max', input.revenueMax != null ? Number(input.revenueMax) || null : null);
  if (sets.length === 0) throw badRequest('Nothing to update');
  params.push(prospectId);
  const up = await client.query(
    `UPDATE prospects SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  return prospectToOut(up.rows[0] as Record<string, unknown>);
}

export async function reviewProspect(
  client: PoolClient,
  ctx: Ctx,
  prospectId: number,
  decision: string,
  notes: string | null
): Promise<Record<string, unknown>> {
  if (!(['REVIEWED', 'APPROVED', 'REJECTED', 'DISCARDED'] as readonly string[]).includes(decision)) {
    throw badRequest('Invalid review decision');
  }
  const res = await client.query(
    `SELECT * FROM prospects WHERE id = $1 AND tenant_id = $2 AND ($3::bigint IS NULL OR company_id = $3) FOR UPDATE`,
    [prospectId, ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Prospect not found');
  const prev = res.rows[0] as Record<string, unknown>;
  if (String(prev.status) === 'CONVERTED') throw badRequest('Prospect already converted');
  const up = await client.query(
    `UPDATE prospects
        SET status = $2, reviewed_by = $3, reviewed_at = now(), review_notes = $4, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [prospectId, decision, ctx.userId ?? null, notes ?? null]
  );
  await logAudit(client, ctx, {
    action: decision.toLowerCase(),
    resource: 'intelligence.prospects',
    recordId: prospectId,
    recordCode: String(prev.code ?? prospectId),
    newValues: { status: decision, notes },
  });
  return prospectToOut(up.rows[0] as Record<string, unknown>);
}

/** Convert an APPROVED prospect into CRM (customer + lead + opportunity). */
export async function convertProspect(client: PoolClient, ctx: Ctx, prospectId: number): Promise<Record<string, unknown>> {
  const res = await client.query(
    `SELECT * FROM prospects WHERE id = $1 AND tenant_id = $2 AND ($3::bigint IS NULL OR company_id = $3) FOR UPDATE`,
    [prospectId, ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Prospect not found');
  const p = res.rows[0] as Record<string, unknown>;
  if (String(p.status) !== 'APPROVED') {
    throw badRequest('Approve the prospect before converting it to CRM');
  }
  const name = String(p.name ?? '').trim();
  const email = p.email != null ? String(p.email) : null;
  const phone = p.phone != null ? String(p.phone) : null;
  const website = p.website != null ? String(p.website) : null;
  const revenue = num(p.revenue_min) ?? 0;

  const customer = await createCustomer(client, ctx, { name, email, phone, website, status: 'ACTIVE' });
  const lead = await createLead(client, ctx, {
    companyName: name,
    email,
    phone,
    source: 'OTHER',
    value: revenue,
    notes: `Converted from intelligence prospect ${String(p.code ?? prospectId)}.`,
  });
  const opportunity = await createOpportunity(client, ctx, {
    customerId: customer.customerId,
    leadId: lead.leadId,
    name: `${name} · from ${String(p.code ?? prospectId)}`,
    amount: revenue,
    stage: 'PROSPECTING',
  });

  const up = await client.query(
    `UPDATE prospects
        SET status = 'CONVERTED', converted_customer_id = $2, converted_lead_id = $3, converted_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [prospectId, customer.customerId, lead.leadId]
  );
  await logAudit(client, ctx, {
    action: 'convert',
    resource: 'intelligence.prospects',
    recordId: prospectId,
    recordCode: String(p.code ?? prospectId),
    newValues: { customerId: customer.customerId, leadId: lead.leadId, opportunityId: opportunity.opportunityId },
  });
  return {
    prospect: prospectToOut(up.rows[0] as Record<string, unknown>),
    customerId: customer.customerId,
    leadId: lead.leadId,
    opportunityId: opportunity.opportunityId,
  };
}

export async function deleteProspect(client: PoolClient, ctx: Ctx, prospectId: number): Promise<{ deleted: boolean }> {
  const res = await client.query(
    `SELECT status, code FROM prospects WHERE id = $1 AND tenant_id = $2 AND ($3::bigint IS NULL OR company_id = $3) FOR UPDATE`,
    [prospectId, ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Prospect not found');
  if (String(res.rows[0].status) === 'CONVERTED') throw badRequest('Converted prospects cannot be deleted');
  await client.query(`DELETE FROM prospects WHERE id = $1`, [prospectId]);
  await logAudit(client, ctx, { action: 'delete', resource: 'intelligence.prospects', recordId: prospectId, recordCode: String(res.rows[0].code ?? prospectId) });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Dashboard (section A)
// ---------------------------------------------------------------------------

export async function intelligenceDashboard(client: PoolClient, ctx: Ctx): Promise<Record<string, unknown>> {
  const company = requireCompany(ctx);
  const stats = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'NEW')::int AS new_count,
            count(*) FILTER (WHERE status = 'REVIEWED')::int AS reviewed,
            count(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
            count(*) FILTER (WHERE status = 'CONVERTED')::int AS converted,
            count(*) FILTER (WHERE status IN ('REJECTED','DISCARDED'))::int AS rejected,
            count(*) FILTER (WHERE duplicate_of IS NOT NULL)::int AS duplicates,
            COALESCE(round(avg(score)), 0)::int AS avg_score
       FROM prospects
      WHERE company_id = $1`,
    [company]
  );
  const bands = await client.query(
    `SELECT count(*) FILTER (WHERE score >= 80)::int AS hot,
            count(*) FILTER (WHERE score >= 60 AND score < 80)::int AS warm,
            count(*) FILTER (WHERE score >= 40 AND score < 60)::int AS cool,
            count(*) FILTER (WHERE score < 40 OR score IS NULL)::int AS cold
       FROM prospects
      WHERE company_id = $1`,
    [company]
  );
  const industries = await client.query(
    `SELECT COALESCE(industry, 'Unknown') AS industry, count(*)::int AS n
       FROM prospects
      WHERE company_id = $1
      GROUP BY 1
      ORDER BY n DESC
      LIMIT 8`,
    [company]
  );
  const sources = await client.query(
    `SELECT source_provider AS provider, count(*)::int AS n
       FROM prospects
      WHERE company_id = $1
      GROUP BY 1
      ORDER BY n DESC
      LIMIT 8`,
    [company]
  );
  const campaigns = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'ACTIVE')::int AS active
       FROM discovery_campaigns
      WHERE company_id = $1`,
    [company]
  );
  const recent = await client.query(
    `SELECT * FROM prospects WHERE company_id = $1 ORDER BY created_at DESC LIMIT 6`,
    [company]
  );
  const s = stats.rows[0] as Record<string, unknown>;
  const b = bands.rows[0] as Record<string, unknown>;
  const c = campaigns.rows[0] as Record<string, unknown>;
  return {
    totals: {
      total: Number(s.total ?? 0),
      newCount: Number(s.new_count ?? 0),
      reviewed: Number(s.reviewed ?? 0),
      approved: Number(s.approved ?? 0),
      converted: Number(s.converted ?? 0),
      rejected: Number(s.rejected ?? 0),
      duplicates: Number(s.duplicates ?? 0),
      avgScore: Number(s.avg_score ?? 0),
    },
    bands: {
      hot: Number(b.hot ?? 0),
      warm: Number(b.warm ?? 0),
      cool: Number(b.cool ?? 0),
      cold: Number(b.cold ?? 0),
    },
    industries: (industries.rows as Record<string, unknown>[]).map((r) => ({ industry: r.industry, count: Number(r.n) })),
    sources: (sources.rows as Record<string, unknown>[]).map((r) => ({ provider: r.provider, count: Number(r.n) })),
    campaigns: { total: Number(c.total ?? 0), active: Number(c.active ?? 0) },
    recent: (recent.rows as Record<string, unknown>[]).map(prospectToOut),
    aiProvider: resolveAiEngine().name,
    searchProvider: resolveProvider().name,
  };
}

// ---------------------------------------------------------------------------
// Discovery worker tick (scheduled, section B)
// ---------------------------------------------------------------------------

/** Run every ACTIVE, schedule-enabled, due campaign across all tenants. */
export async function runIntelligenceDiscoveryTick(): Promise<{ processed: number; ok: number; failed: number }> {
  const res = await query(
    `SELECT * FROM discovery_campaigns
      WHERE status = 'ACTIVE'
        AND COALESCE((schedule->>'enabled')::boolean, false)
        AND next_run_at IS NOT NULL
        AND next_run_at <= now()
      ORDER BY next_run_at ASC
      LIMIT 10`
  );
  let ok = 0;
  let failed = 0;
  for (const row of res.rows as Record<string, unknown>[]) {
    const id = Number(row.id);
    const ctx: Ctx = {
      tenantId: Number(row.tenant_id),
      companyId: Number(row.company_id),
      branchId: num(row.branch_id) ?? undefined,
    };
    try {
      const criteria = coerceCriteria(row.criteria);
      const enriched = await runCampaignDiscovery(criteria, Number(row.max_results));
      const everyMs = intParam((row.schedule as Record<string, unknown>)?.everyMs, 60_000, 31 * 24 * 60 * 60 * 1000, 86_400_000);
      await tx(async (client) => {
        await persistCampaignRun(client, ctx, id, enriched);
        await client.query(
          `UPDATE discovery_campaigns SET next_run_at = now() + ($2::bigint * interval '1 millisecond'), updated_at = now() WHERE id = $1`,
          [id, everyMs]
        );
      }, ctx);
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error('[intelligence] campaign run failed', id, err instanceof Error ? err.message : String(err));
    }
  }
  return { processed: res.rows.length, ok, failed };
}
