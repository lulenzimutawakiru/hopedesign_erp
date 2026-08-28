import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, toCamelRow } from '../utils.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface StatutoryConfig {
  id: number;
  companyId: number | null;
  tenantId: number;
  country: string;
  category: string;
  code: string;
  name: string;
  description: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  rates: unknown;
  thresholds: unknown;
  limits: unknown;
  formula: unknown;
  version: number;
  status: string;
}

/**
 * Resolve the active statutory configuration for a category as at a given date.
 * Company-specific rows win over tenant-wide defaults; among equal precedence the
 * newest effective_from and highest version win. All legal values live in this
 * versioned table so statutory updates require no code change.
 */
export async function getStatutoryConfig(
  client: pg.PoolClient,
  ctx: Ctx,
  category: string,
  opts: { code?: string | null; effectiveDate?: string; companyId?: number | null; country?: string } = {}
): Promise<StatutoryConfig | null> {
  const effective = opts.effectiveDate ?? new Date().toISOString().slice(0, 10);
  const companyId = opts.companyId !== undefined ? opts.companyId : ctx.companyId ?? null;
  const res = await client.query(
    `SELECT * FROM statutory_configs
       WHERE tenant_id = $1 AND country = $2 AND category = $3
         AND ($4::text IS NULL OR code = $4)
         AND status = 'ACTIVE'
         AND (effective_from IS NULL OR effective_from <= $5)
         AND (effective_to IS NULL OR effective_to >= $5)
         AND ($6::bigint IS NULL OR company_id IS NULL OR company_id = $6)
       ORDER BY CASE WHEN company_id = $6 THEN 0 WHEN company_id IS NULL THEN 1 ELSE 2 END,
                effective_from DESC NULLS LAST, version DESC
       LIMIT 1`,
    [ctx.tenantId, opts.country ?? 'UG', category, opts.code ?? null, effective, companyId]
  );
  return res.rows[0] ? (toCamelRow(res.rows[0]) as unknown as StatutoryConfig) : null;
}

export async function requireStatutoryConfig(
  client: pg.PoolClient,
  ctx: Ctx,
  category: string,
  opts: { code?: string | null; effectiveDate?: string; companyId?: number | null; country?: string } = {}
): Promise<StatutoryConfig> {
  const cfg = await getStatutoryConfig(client, ctx, category, opts);
  if (!cfg) {
    const at = opts.effectiveDate ?? new Date().toISOString().slice(0, 10);
    throw badRequest(`No ACTIVE statutory configuration for ${category} on ${at}. An administrator must configure statutory_configs.`);
  }
  return cfg;
}

/** Immutable snapshot persisted on payroll runs for audit and re-print fidelity. */
export function statutorySnapshot(cfg: StatutoryConfig): Record<string, unknown> {
  return {
    code: cfg.code,
    name: cfg.name,
    category: cfg.category,
    country: cfg.country,
    version: cfg.version,
    effectiveFrom: cfg.effectiveFrom,
    effectiveTo: cfg.effectiveTo,
    rates: cfg.rates,
    thresholds: cfg.thresholds,
    limits: cfg.limits,
    formula: cfg.formula,
  };
}

interface PayeBand {
  min: number;
  max: number | null;
  rate: number;
}

/**
 * Bands are stored in statutory_configs, either as band objects in rates:
 *   rates = [{ min: 0, max: 235000, rate: 0 }, { min: 235000, max: 335000, rate: 10 }, ...]
 * or as parallel arrays: thresholds = [{ min, max }...], rates = [{ rate }...].
 */
function payeBands(cfg: StatutoryConfig): PayeBand[] {
  const rates = Array.isArray(cfg.rates) ? cfg.rates : [];
  const thresholds = Array.isArray(cfg.thresholds) ? cfg.thresholds : [];
  if (rates.length && rates[0] && typeof rates[0] === 'object' && 'rate' in (rates[0] as object)) {
    return (rates as Array<Record<string, unknown>>)
      .map((b) => ({ min: Number(b.min ?? 0), max: b.max != null ? Number(b.max) : null, rate: Number(b.rate ?? 0) }))
      .sort((a, b) => a.min - b.min);
  }
  const out: PayeBand[] = [];
  for (let i = 0; i < thresholds.length; i++) {
    const e = thresholds[i] as Record<string, unknown>;
    const r = (rates[i] ?? {}) as Record<string, unknown>;
    out.push({ min: Number(e.min ?? 0), max: e.max != null ? Number(e.max) : null, rate: Number(r.rate ?? 0) });
  }
  return out.sort((a, b) => a.min - b.min);
}

/** Progressive monthly income tax from versioned bands (e.g. Uganda PAYE). */
export function computePaye(taxable: number, cfg: StatutoryConfig): number {
  const t = Math.max(0, Number(taxable) || 0);
  const bands = payeBands(cfg);
  if (!bands.length) throw badRequest(`PAYE configuration ${cfg.code} has no rate bands`);
  let tax = 0;
  for (const b of bands) {
    if (t <= b.min) break;
    const upper = b.max ?? Number.POSITIVE_INFINITY;
    if (upper <= b.min) continue;
    tax += (Math.min(t, upper) - b.min) * (b.rate / 100);
  }
  return round2(tax);
}

export interface NssfResult {
  employee: number;
  employer: number;
  base: number;
  ceiling: number | null;
}

/** Object-shaped rates (object or single-element array of objects). */
function configRates(cfg: StatutoryConfig): Record<string, unknown> {
  if (Array.isArray(cfg.rates) && cfg.rates.length === 1 && typeof cfg.rates[0] === 'object') {
    return cfg.rates[0] as Record<string, unknown>;
  }
  if (!Array.isArray(cfg.rates) && cfg.rates && typeof cfg.rates === 'object') {
    return cfg.rates as Record<string, unknown>;
  }
  return {};
}

/**
 * Social security split. rates: { employee: 0.05, employer: 0.10 };
 * limits: { monthly_ceiling: 0 } (0 = no ceiling).
 */
export function computeNssf(gross: number, cfg: StatutoryConfig): NssfResult {
  const g = Math.max(0, Number(gross) || 0);
  const rates = configRates(cfg);
  const limits = (cfg.limits ?? {}) as Record<string, unknown>;
  const ceiling = Number(limits.monthly_ceiling ?? limits.ceiling ?? 0);
  const base = ceiling > 0 ? Math.min(g, ceiling) : g;
  return {
    employee: round2(base * Number(rates.employee ?? 0)),
    employer: round2(base * Number(rates.employer ?? 0)),
    base: round2(base),
    ceiling: ceiling > 0 ? ceiling : null,
  };
}

/**
 * Local service tax / flat statutory deduction.
 * Flat or percentage forms:
 *   limits: { monthly_amount: 5000, min_gross: 100000, apply_to_payroll: true }
 *   rates:  { rate: 0 } optional percentage alternative.
 * Graduated schedule (KCCA-style), keyed on monthly gross pay:
 *   limits: { apply_to_payroll: true, months: [7,8,9,10],
 *             bands: [{ max: 200000, monthly_amount: 1250 }, ..., { max: null, monthly_amount: 25000 }] }
 * The first band whose max (null = unbounded) covers gross wins. When the
 * config declares collection months and the caller supplies the payroll
 * period, LST only applies if the period overlaps those months.
 */
export function computeLst(
  gross: number,
  cfg: StatutoryConfig | null,
  opts: { months?: number[]; periodStart?: string; periodEnd?: string } = {}
): number {
  if (!cfg) return 0;
  const rates = configRates(cfg);
  const limits = (cfg.limits ?? {}) as Record<string, unknown>;
  if (limits.apply_to_payroll === false) return 0;
  const minGross = Number(limits.min_gross ?? 0);
  if (minGross > 0 && (Number(gross) || 0) < minGross) return 0;
  // Season gate: when the config declares collection months and the caller
  // supplies the payroll period, skip LST when the period does not overlap.
  const months = Array.isArray(limits.months) ? (limits.months as unknown[]).map(Number) : [];
  if (months.length && opts.periodStart && opts.periodEnd) {
    const start = new Date(String(opts.periodStart) + 'T00:00:00');
    const end = new Date(String(opts.periodEnd) + 'T00:00:00');
    const first = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    let overlap = false;
    for (let d = new Date(first); d <= last && !overlap; d.setUTCMonth(d.getUTCMonth() + 1)) {
      if (months.includes(d.getUTCMonth() + 1)) overlap = true;
    }
    if (!overlap) return 0;
  }
  // Graduated band schedule (KCCA-style).
  const bands = Array.isArray(limits.bands) ? (limits.bands as Array<Record<string, unknown>>) : [];
  if (bands.length) {
    const g = Math.max(0, Number(gross) || 0);
    const sorted = [...bands].sort((a, b) => {
      const am = a.max != null ? Number(a.max) : Number.POSITIVE_INFINITY;
      const bm = b.max != null ? Number(b.max) : Number.POSITIVE_INFINITY;
      return am - bm;
    });
    for (const b of sorted) {
      const upper = b.max != null ? Number(b.max) : Number.POSITIVE_INFINITY;
      if (g <= upper) return round2(Number(b.monthly_amount ?? b.amount ?? 0));
    }
    return 0;
  }
  const flat = Number(limits.monthly_amount ?? rates.monthly_amount ?? 0);
  if (flat > 0) return round2(flat);
  const pct = Number(rates.rate ?? 0);
  if (pct > 0) return round2((Number(gross) || 0) * (pct / 100));
  return 0;
}
