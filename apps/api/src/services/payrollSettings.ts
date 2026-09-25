import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { logAudit } from './audit.js';
import * as statutory from './statutory.js';

/**
 * Payroll settings and statutory configuration.
 *
 * Two things live here, both of which used to be raw JSON typed into the
 * generic record editor:
 *
 *  1. payroll_settings - named, typed scalars (document prefixes, default
 *     currency, default payment method) that the payroll engine actually reads.
 *     Each key is declared once in PAYROLL_SETTING_DEFINITIONS so a screen can
 *     render a real field and validate before saving, instead of asking an
 *     administrator to hand-write JSON.
 *
 *  2. statutory_configs - the versioned legal tables (PAYE bands, NSSF rates,
 *     LST schedules). The payroll engine resolves them through
 *     statutory.getStatutoryConfig; this service is the editing surface, and it
 *     validates a candidate table with the same semantics the engine applies
 *     when it pays a payslip.
 *
 * Precedence on both surfaces: a company-specific row beats a tenant-wide row,
 * then the newest effective_from, then the highest version.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const isoToday = () => new Date().toISOString().slice(0, 10);

// ===========================================================================
// Payroll settings catalogue
// ===========================================================================

export interface PayrollSettingDefinition {
  key: string;
  label: string;
  group: string;
  type: 'text' | 'code' | 'currency' | 'enum';
  defaultValue: string;
  options?: string[];
  description: string;
  /** Where the value is read at runtime, so a screen can say why it matters. */
  consumedBy: string;
}

export const PAYROLL_SETTING_DEFINITIONS: PayrollSettingDefinition[] = [
  {
    key: 'PAYSLIP_NUMBER_PREFIX',
    label: 'Payslip number prefix',
    group: 'Documents',
    type: 'code',
    defaultValue: 'PS',
    description: 'Prefix for generated payslip numbers, e.g. PS-2026-00000001.',
    consumedBy: 'Payslip generation while a payroll run is calculated',
  },
  {
    key: 'PAYROLL_RUN_PREFIX',
    label: 'Payroll run number prefix',
    group: 'Documents',
    type: 'code',
    defaultValue: 'PAY',
    description: 'Prefix for generated payroll run numbers, e.g. PAY-2026-00000001.',
    consumedBy: 'Payroll run numbering when a run is created',
  },
  {
    key: 'DEFAULT_PAYROLL_CURRENCY',
    label: 'Default payroll currency',
    group: 'Money',
    type: 'currency',
    defaultValue: 'UGX',
    description: 'Currency a new payroll run uses when the run does not name one.',
    consumedBy: 'Payroll run creation and recalculation, and payment batch totals',
  },
  {
    key: 'DEFAULT_PAYMENT_METHOD',
    label: 'Default payment method',
    group: 'Money',
    type: 'enum',
    defaultValue: 'BANK_TRANSFER',
    options: ['BANK_TRANSFER', 'MOBILE_MONEY', 'CASH', 'OTHER'],
    description: 'Method used for a pay-batch line when the employee file names none.',
    consumedBy: 'Payment batch creation, and new employee payroll profiles',
  },
];

/** `Z_PRIME` style keys: an escape hatch for values the catalogue does not name yet. */
const SETTING_KEY_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const PREFIX_PATTERN = /^[A-Z0-9]{1,8}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function requireCompany(ctx: Ctx): number {
  if (ctx.companyId == null) throw badRequest('An active company context is required to change payroll settings');
  return Number(ctx.companyId);
}

/** Unwrap the shapes a payroll_settings.config_value may hold. */
function unwrapSettingValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of ['value', 'text', 'string', 'code', 'amount']) {
      const v = obj[key];
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
  }
  return null;
}

/**
 * Read one setting for the active company. Never throws for a missing row or a
 * missing company: callers are on the payroll hot path and want the default.
 */
export async function getSettingString(
  client: pg.PoolClient,
  ctx: Ctx,
  key: string,
  fallback: string
): Promise<string> {
  if (ctx.companyId == null) return fallback;
  const res = await client.query(
    `SELECT config_value FROM payroll_settings
      WHERE tenant_id = $1 AND company_id = $2 AND config_key = $3 AND status = 'ACTIVE'
      LIMIT 1`,
    [ctx.tenantId ?? null, ctx.companyId, key]
  );
  if (res.rows.length === 0) return fallback;
  const stored = unwrapSettingValue(res.rows[0].config_value);
  const value = stored === null ? '' : String(stored).trim();
  return value === '' ? fallback : value;
}

export const getPayslipPrefix = (client: pg.PoolClient, ctx: Ctx) =>
  getSettingString(client, ctx, 'PAYSLIP_NUMBER_PREFIX', 'PS');

export const getPayrollRunPrefix = (client: pg.PoolClient, ctx: Ctx) =>
  getSettingString(client, ctx, 'PAYROLL_RUN_PREFIX', 'PAY');

export const getDefaultCurrency = (client: pg.PoolClient, ctx: Ctx) =>
  getSettingString(client, ctx, 'DEFAULT_PAYROLL_CURRENCY', 'UGX');

export const getDefaultPaymentMethod = (client: pg.PoolClient, ctx: Ctx) =>
  getSettingString(client, ctx, 'DEFAULT_PAYMENT_METHOD', 'BANK_TRANSFER');

interface StoredSetting {
  id: number;
  key: string;
  value: string | null;
  status: string;
  description: string | null;
  updatedAt: unknown;
  rawValue: unknown;
}

async function loadStoredSettings(client: pg.PoolClient, ctx: Ctx): Promise<Map<string, StoredSetting>> {
  const out = new Map<string, StoredSetting>();
  if (ctx.companyId == null) return out;
  const res = await client.query(
    `SELECT * FROM payroll_settings
      WHERE tenant_id = $1 AND company_id = $2
      ORDER BY config_key`,
    [ctx.tenantId ?? null, ctx.companyId]
  );
  for (const row of res.rows) {
    const key = String(row.config_key);
    out.set(key, {
      id: Number(row.id),
      key,
      value: unwrapSettingValue(row.config_value),
      status: String(row.status),
      description: row.description ?? null,
      updatedAt: row.updated_at ?? null,
      rawValue: row.config_value,
    });
  }
  return out;
}

/**
 * Every catalogue key with its effective value, every key that is stored but
 * not in the catalogue, and the groups the catalogue is organised into.
 */
export async function getPayrollSettings(client: pg.PoolClient, ctx: Ctx) {
  const stored = await loadStoredSettings(client, ctx);
  const definitions = PAYROLL_SETTING_DEFINITIONS.map((def) => {
    const row = stored.get(def.key);
    stored.delete(def.key);
    const value = row && row.value !== null && String(row.value).trim() !== '' ? String(row.value) : def.defaultValue;
    return {
      key: def.key,
      label: def.label,
      group: def.group,
      type: def.type,
      options: def.options ?? null,
      description: def.description,
      consumedBy: def.consumedBy,
      defaultValue: def.defaultValue,
      settingId: row ? row.id : null,
      value,
      isDefault: !row || row.value === null || String(row.value).trim() === '',
      status: row ? row.status : null,
      storedDescription: row ? row.description : null,
      updatedAt: row ? row.updatedAt : null,
    };
  });
  const extras = [...stored.values()].map((row) => ({
    settingId: row.id,
    key: row.key,
    value: row.value ?? JSON.stringify(row.rawValue ?? null),
    rawValue: row.rawValue,
    status: row.status,
    description: row.description,
    updatedAt: row.updatedAt,
  }));
  const groups = [...new Set(PAYROLL_SETTING_DEFINITIONS.map((d) => d.group))];
  return { companyId: ctx.companyId ?? null, definitions, extras, groups };
}

export interface PayrollSettingsSaveInput {
  /** Either [{ key, value, description }] or a plain { KEY: value } map. */
  entries?: Array<{ key?: unknown; value?: unknown; description?: unknown }> | Record<string, unknown>;
  /** Keys to forget, reverting each to its catalogue default. */
  remove?: unknown;
  reason?: string | null;
}

function normalizeEntries(entries: PayrollSettingsSaveInput['entries']): Array<{ key: string; value: unknown; description: unknown }> {
  if (entries === null || entries === undefined) return [];
  if (Array.isArray(entries)) {
    return entries.map((e) => ({
      key: String((e as Record<string, unknown>)?.key ?? '').trim(),
      value: (e as Record<string, unknown>)?.value,
      description: (e as Record<string, unknown>)?.description,
    }));
  }
  if (typeof entries === 'object') {
    return Object.entries(entries).map(([key, value]) => ({ key: key.trim(), value, description: undefined }));
  }
  throw badRequest('entries must be an object of key/value pairs or an array of { key, value }');
}

function validateSettingValue(def: PayrollSettingDefinition | undefined, key: string, raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (value === '') return '';
  switch (def?.type) {
    case 'code':
      if (!PREFIX_PATTERN.test(value)) {
        throw badRequest(`${key} must be 1-8 characters of A-Z or 0-9, for example ${def.defaultValue}`);
      }
      return value;
    case 'currency':
      if (!CURRENCY_PATTERN.test(value)) {
        throw badRequest(`${key} must be a three-letter currency code, for example ${def.defaultValue}`);
      }
      return value;
    case 'enum':
      if (!(def.options ?? []).includes(value)) {
        throw badRequest(`${key} must be one of: ${(def.options ?? []).join(', ')}`);
      }
      return value;
    default:
      return value;
  }
}

/**
 * Upsert or clear payroll settings in one call.
 *
 * An empty value means "revert to the default" and deletes the row, so the
 * screen never has to store a value that merely restates the catalogue.
 */
export async function savePayrollSettings(
  client: pg.PoolClient,
  ctx: Ctx,
  input: PayrollSettingsSaveInput
) {
  const companyId = requireCompany(ctx);
  const defs = new Map(PAYROLL_SETTING_DEFINITIONS.map((d) => [d.key, d]));
  const entries = normalizeEntries(input.entries);
  const removes = (Array.isArray(input.remove) ? input.remove : input.remove ? [input.remove] : [])
    .map((k) => String(k).trim())
    .filter((k) => k !== '');
  const reason = input.reason != null && String(input.reason).trim() !== '' ? String(input.reason).trim() : null;

  if (entries.length === 0 && removes.length === 0) {
    throw badRequest('Nothing to save: provide entries, remove, or both');
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.key) throw badRequest('Every payroll setting entry needs a key');
    if (!SETTING_KEY_PATTERN.test(entry.key)) {
      throw badRequest(`${entry.key} is not a valid setting key (letters, digits and underscores, starting with a letter)`);
    }
    if (seen.has(entry.key)) throw badRequest(`${entry.key} is listed twice in the same save`);
    seen.add(entry.key);
  }
  for (const key of removes) {
    if (!SETTING_KEY_PATTERN.test(key)) throw badRequest(`${key} is not a valid setting key`);
    if (seen.has(key)) throw badRequest(`${key} is listed both for update and for removal`);
  }

  const before = await loadStoredSettings(client, ctx);
  const changes: Array<{ key: string; from: string | null; to: string | null }> = [];
  let saved = 0;
  let cleared = 0;

  const startVal = isoToday();
  for (const entry of entries) {
    const def = defs.get(entry.key);
    const value = validateSettingValue(def, entry.key, entry.value);
    const previous = before.get(entry.key)?.value ?? null;
    if (value === '') {
      await client.query(
        `DELETE FROM payroll_settings WHERE tenant_id = $1 AND company_id = $2 AND config_key = $3`,
        [ctx.tenantId ?? null, companyId, entry.key]
      );
      cleared += 1;
      changes.push({ key: entry.key, from: previous, to: null });
      continue;
    }
    const description = entry.description !== undefined
      ? (entry.description === null || String(entry.description).trim() === '' ? null : String(entry.description).trim())
      : def?.description ?? null;
    await client.query(
      `INSERT INTO payroll_settings (company_id, tenant_id, branch_id, config_key, config_value, description, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,'ACTIVE')
       ON CONFLICT (company_id, config_key)
       DO UPDATE SET config_value = EXCLUDED.config_value,
                     description = EXCLUDED.description,
                     status = 'ACTIVE',
                     tenant_id = EXCLUDED.tenant_id,
                     branch_id = COALESCE(EXCLUDED.branch_id, payroll_settings.branch_id)`,
      [companyId, ctx.tenantId ?? null, ctx.branchId ?? null, entry.key, JSON.stringify(value), description]
    );
    saved += 1;
    changes.push({ key: entry.key, from: previous, to: value });
  }

  for (const key of removes) {
    const previous = before.get(key)?.value ?? null;
    await client.query(
      `DELETE FROM payroll_settings WHERE tenant_id = $1 AND company_id = $2 AND config_key = $3`,
      [ctx.tenantId ?? null, companyId, key]
    );
    cleared += 1;
    changes.push({ key, from: previous, to: null });
  }

  if (changes.length > 0) {
    await logAudit(client, ctx, {
      action: 'update',
      resource: 'payroll_settings',
      recordCode: `company:${companyId}`,
      oldValues: Object.fromEntries(changes.map((c) => [c.key, c.from])),
      newValues: Object.fromEntries(changes.map((c) => [c.key, c.to])),
      metadata: {
        saved,
        cleared,
        ...(reason ? { reason } : {}),
      },
    });
  }

  return { ...(await getPayrollSettings(client, ctx)), saved, cleared, changes, reason };
}

// ===========================================================================
// Statutory configuration
// ===========================================================================

export const STATUTORY_CATEGORIES = [
  'PAYE', 'PAYE_SECONDARY', 'NSSF', 'LST', 'SDI', 'WHT', 'SEVERANCE', 'MINIMUM_WAGE', 'OTHER',
] as const;
export type StatutoryCategory = (typeof STATUTORY_CATEGORIES)[number];

/**
 * DATE columns are cast to text in SQL: pg hands back a JS Date at local
 * midnight, and formatting that through toISOString can shift the day.
 */
const STATUTORY_COLUMNS = `id, company_id, tenant_id, country, category, code, name, description,
  effective_from::text AS effective_from,
  effective_to::text AS effective_to,
  rates, thresholds, limits, formula, version, status, created_at, updated_at`;

function text(value: unknown, field: string, required = false): string | null {
  if (value === null || value === undefined) {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  const s = String(value).trim();
  if (s === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  return s;
}

function date(value: unknown, field: string, required = false): string | null {
  const s = text(value, field, required);
  if (s === null) return null;
  if (!DATE_PATTERN.test(s)) throw badRequest(`${field} must be a YYYY-MM-DD date`);
  return s;
}

function numberOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  return n;
}

function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === null || value === undefined || value === '') return fallback;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  throw badRequest(`${field} must be true or false`);
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || value === undefined || value === '') return {};
  if (Array.isArray(value)) {
    // The engine also accepts a single-element array of objects for object-shaped
    // rates, so a legacy row read back into the editor must still round-trip.
    if (value.length === 1 && value[0] !== null && typeof value[0] === 'object') {
      return value[0] as Record<string, unknown>;
    }
    throw badRequest(`${field} must be an object`);
  }
  if (typeof value !== 'object') throw badRequest(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function listOf(value: unknown): unknown[] {
  if (value === null || value === undefined || value === '') return [];
  return Array.isArray(value) ? value : [];
}

interface PreparedConfig {
  rates: unknown;
  thresholds: unknown;
  limits: unknown;
  formula: unknown;
  warnings: string[];
}

/** Field from the request body when present, else from the row being edited. */
function field(body: Record<string, unknown>, base: Record<string, unknown> | undefined, name: string): unknown {
  return body[name] !== undefined ? body[name] : base ? base[name] : undefined;
}

/**
 * PAYE bands.
 *
 * The engine pays from a list of { min, max, rate } bands and treats one
 * unbounded band (max: null) as the top rate. A typo in a band boundary is a
 * silent under- or over-withholding, so the boundaries are checked here for
 * contiguity and for an open-ended top band, not merely for being numeric.
 */
function preparePaye(body: Record<string, unknown>, base?: Record<string, unknown>): PreparedConfig {
  const warnings: string[] = [];
  const rawRates = listOf(field(body, base, 'rates'));
  const rawThresholds = listOf(field(body, base, 'thresholds'));
  const bandShaped = rawRates.length > 0 && rawRates[0] !== null && typeof rawRates[0] === 'object' && 'rate' in (rawRates[0] as object);

  let bands: Array<{ min: number; max: number | null; rate: number }>;
  if (bandShaped) {
    bands = rawRates.map((entry, i) => {
      const o = (entry ?? {}) as Record<string, unknown>;
      return {
        min: numberOrNull(o.min, `rates[${i}].min`) ?? 0,
        max: o.max === null || o.max === undefined || o.max === '' ? null : numberOrNull(o.max, `rates[${i}].max`),
        rate: numberOrNull(o.rate, `rates[${i}].rate`) ?? 0,
      };
    });
  } else if (rawThresholds.length > 0) {
    bands = rawThresholds.map((entry, i) => {
      const o = (entry ?? {}) as Record<string, unknown>;
      const r = (rawRates[i] ?? {}) as Record<string, unknown>;
      return {
        min: numberOrNull(o.min, `thresholds[${i}].min`) ?? 0,
        max: o.max === null || o.max === undefined || o.max === '' ? null : numberOrNull(o.max, `thresholds[${i}].max`),
        rate: numberOrNull(r.rate, `rates[${i}].rate`) ?? 0,
      };
    });
  } else {
    throw badRequest('A PAYE configuration needs rate bands: a list of { min, max, rate }');
  }

  bands.sort((a, b) => a.min - b.min);
  bands.forEach((band, i) => {
    if (band.min < 0) throw badRequest(`Band ${i} starts below zero`);
    if (band.rate < 0 || band.rate > 100) throw badRequest(`Band ${i} rate must be between 0 and 100, got ${band.rate}`);
    if (band.max !== null && band.max <= band.min) {
      throw badRequest(`Band ${i} ends at ${band.max}, which is not above its start of ${band.min}`);
    }
    if (band.max === null && i !== bands.length - 1) {
      throw badRequest(`Band ${i} is open-ended but ${bands.length - i - 1} more band(s) follow it; only the top band may run to infinity`);
    }
  });
  for (let i = 1; i < bands.length; i++) {
    if (bands[i].min !== bands[i - 1].max) {
      throw badRequest(
        `PAYE bands must be contiguous and ascending: band ${i} starts at ${bands[i].min} but band ${i - 1} ends at ${bands[i - 1].max}`
      );
    }
  }
  if (bands[0].min !== 0) {
    warnings.push(`The first band starts at ${bands[0].min}, so income below that is untaxed.`);
  }
  const top = bands[bands.length - 1];
  if (top.max !== null) {
    warnings.push(`The top band stops at ${top.max}, so income above that is untaxed because no band covers it.`);
  }

  return {
    rates: bands,
    thresholds: [],
    limits: plainObject(field(body, base, 'limits'), 'limits'),
    formula: field(body, base, 'formula') ?? null,
    warnings,
  };
}

/**
 * Which employments a statutory rule governs.
 *
 * Payroll runs two kinds of employment through one code path: an employee's own
 * job ("primary") and a second job the company pays as a second employer
 * ("secondary"). Two rules genuinely differ by employment - NSSF is owed once,
 * through the employment the member is enrolled under, and PAYE_SECONDARY
 * exists only for a second employment - so the distinction is declared on the
 * rule rather than branched in code.
 *
 * Leaving the marker off means "every employment", which is the behaviour every
 * row written before the marker existed already had, so this stays backward
 * compatible.
 */
function prepareEmploymentScopes(limits: Record<string, unknown>, warnings: string[]): void {
  const raw = limits.applies_to_employment;
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
    delete limits.applies_to_employment;
    return;
  }
  const entries = Array.isArray(raw) ? raw : [raw];
  const scopes: statutory.EmploymentScope[] = [];
  for (const entry of entries) {
    const scope = String(entry ?? '').trim().toLowerCase();
    if (!(statutory.EMPLOYMENT_SCOPES as readonly string[]).includes(scope)) {
      throw badRequest(
        `limits.applies_to_employment must be ${statutory.EMPLOYMENT_SCOPES.join(' or ')} (got ${String(entry)})`
      );
    }
    if (!scopes.includes(scope as statutory.EmploymentScope)) scopes.push(scope as statutory.EmploymentScope);
  }
  if (scopes.length === statutory.EMPLOYMENT_SCOPES.length) {
    warnings.push('applies_to_employment names every employment, so it does not narrow this rule.');
  }
  limits.applies_to_employment = scopes;
}

/**
 * NSSF rates.
 *
 * The engine multiplies gross pay by these numbers directly, so they are
 * fractions: 5% is 0.05. A rate above 1 is almost always a percentage typed
 * into a fraction field, which would withhold 500% of pay, so it is refused
 * with a message that says what to type instead.
 */
function prepareNssf(body: Record<string, unknown>, base?: Record<string, unknown>): PreparedConfig {
  const warnings: string[] = [];
  const rateObj = plainObject(field(body, base, 'rates'), 'rates');
  const limits = { ...plainObject(field(body, base, 'limits'), 'limits') };
  prepareEmploymentScopes(limits, warnings);

  const employee = numberOrNull(rateObj.employee, 'rates.employee') ?? 0;
  const employer = numberOrNull(rateObj.employer, 'rates.employer') ?? 0;
  for (const [name, value] of [['employee', employee], ['employer', employer]] as Array<[string, number]>) {
    if (value < 0) throw badRequest(`rates.${name} cannot be negative`);
    if (value > 1) {
      throw badRequest(`rates.${name} is a fraction, not a percentage: 5% is entered as 0.05 (got ${value})`);
    }
  }
  if (employee === 0 && employer === 0) {
    warnings.push('Both NSSF rates are zero, so no social security is withheld or matched.');
  }

  const ceiling = numberOrNull(limits.monthly_ceiling ?? limits.ceiling, 'limits.monthly_ceiling') ?? 0;
  if (ceiling < 0) throw badRequest('limits.monthly_ceiling cannot be negative (use 0 for no ceiling)');
  limits.monthly_ceiling = ceiling;
  if (ceiling === 0) warnings.push('No monthly ceiling is set, so NSSF applies to the whole gross pay.');

  return {
    rates: { ...rateObj, employee, employer },
    thresholds: field(body, base, 'thresholds') ?? [],
    limits,
    formula: field(body, base, 'formula') ?? null,
    warnings,
  };
}

/**
 * Local service tax.
 *
 * Three shapes are legal, and the editor must not blend them: a graduated
 * schedule (limits.bands, KCCA-style), a flat monthly amount, or a percentage
 * of gross. The engine prefers bands, then the flat amount, then the
 * percentage, so a row carrying two of them silently ignores one; that is
 * warned about rather than left to be discovered on a payslip.
 */
function prepareLst(body: Record<string, unknown>, base?: Record<string, unknown>): PreparedConfig {
  const warnings: string[] = [];
  const limits = { ...plainObject(field(body, base, 'limits'), 'limits') };
  const rates = { ...plainObject(field(body, base, 'rates'), 'rates') };

  const minGross = numberOrNull(limits.min_gross, 'limits.min_gross') ?? 0;
  if (minGross < 0) throw badRequest('limits.min_gross cannot be negative');
  limits.min_gross = minGross;

  const rawBands = limits.bands;
  const hasBands = Array.isArray(rawBands) && rawBands.length > 0;
  if (rawBands !== undefined && rawBands !== null && !Array.isArray(rawBands)) {
    throw badRequest('limits.bands must be an array of { max, monthly_amount }');
  }

  if (hasBands) {
    const bands = (rawBands as unknown[]).map((entry, i) => {
      const o = (entry ?? {}) as Record<string, unknown>;
      const amount = numberOrNull(o.monthly_amount ?? o.amount, `bands[${i}].monthly_amount`) ?? 0;
      if (amount < 0) throw badRequest(`bands[${i}].monthly_amount cannot be negative`);
      return {
        max: o.max === null || o.max === undefined || o.max === '' ? null : numberOrNull(o.max, `bands[${i}].max`),
        monthly_amount: amount,
      };
    });
    bands.sort((a, b) => (a.max ?? Number.POSITIVE_INFINITY) - (b.max ?? Number.POSITIVE_INFINITY));
    bands.forEach((band, i) => {
      if (band.max !== null && band.max <= 0) throw badRequest(`bands[${i}].max must be above zero`);
      if (band.max === null && i !== bands.length - 1) {
        throw badRequest(`bands[${i}] is open-ended but more bands follow it; only the top band may run to infinity`);
      }
      if (i > 0) {
        const previous = bands[i - 1].max;
        if (previous === null) throw badRequest(`bands[${i}] follows an open-ended band, so it can never apply`);
        if (band.max !== null && band.max <= previous) {
          throw badRequest(`bands[${i}].max (${band.max}) must be above the previous band's ${previous}`);
        }
      }
    });
    limits.bands = bands;
    if (numberOrNull(limits.monthly_amount, 'limits.monthly_amount') !== null) {
      warnings.push('limits.monthly_amount is ignored while a graduated band schedule is present.');
    }
  } else {
    delete limits.bands;
    const flat = numberOrNull(limits.monthly_amount ?? rates.monthly_amount, 'limits.monthly_amount');
    if (flat !== null) {
      if (flat < 0) throw badRequest('limits.monthly_amount cannot be negative');
      limits.monthly_amount = flat;
    } else {
      const pct = numberOrNull(rates.rate, 'rates.rate');
      if (pct === null) {
        throw badRequest('An LST configuration needs one of: limits.bands, limits.monthly_amount, or rates.rate');
      }
      if (pct < 0 || pct > 100) throw badRequest(`rates.rate must be between 0 and 100, got ${pct}`);
      rates.rate = pct;
      if (pct > 0) warnings.push(`LST is charged at ${pct}% of gross pay rather than a fixed amount.`);
    }
  }

  if (limits.months !== undefined) {
    const months = Array.isArray(limits.months) ? limits.months.map((m) => Number(m)) : [Number(limits.months)];
    for (const month of months) {
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw badRequest('limits.months must be month numbers between 1 and 12');
      }
    }
    const unique = [...new Set(months)].sort((a, b) => a - b);
    if (unique.length !== months.length) throw badRequest('limits.months cannot list the same month twice');
    limits.months = unique;
  }
  limits.apply_to_payroll = bool(limits.apply_to_payroll, 'limits.apply_to_payroll', true);
  if (limits.apply_to_payroll === false) {
    warnings.push('apply_to_payroll is off, so payroll withholds no LST even though this schedule is saved.');
  }
  if (minGross > 0) {
    warnings.push(`LST only applies once monthly gross reaches ${minGross}.`);
  }

  return {
    rates,
    thresholds: field(body, base, 'thresholds') ?? [],
    limits,
    formula: field(body, base, 'formula') ?? null,
    warnings,
  };
}

/**
 * Secondary-employment PAYE.
 *
 * A second employer withholds at a fixed rate on the chargeable income instead
 * of on the resident progressive bands. The Act publishes no numbered schedule
 * for that case, so the shape is configuration and three are legal; the engine
 * reads them in this order: limits.bands (graduated), then limits.monthly_amount
 * (flat), then rates.rate (a percentage, 40 = 40%). A row carrying more than one
 * is warned about rather than left to be discovered on a payslip.
 *
 * limits.applies_to_employment narrows the rule to the employments it governs.
 * The seed names ["secondary"], which is what makes the fallback to the
 * resident bands declarative: an employee who is not on a second employment
 * never meets this rule.
 */
function prepareSecondaryPaye(body: Record<string, unknown>, base?: Record<string, unknown>): PreparedConfig {
  const warnings: string[] = [];
  const limits = { ...plainObject(field(body, base, 'limits'), 'limits') };
  const rates = { ...plainObject(field(body, base, 'rates'), 'rates') };

  prepareEmploymentScopes(limits, warnings);

  limits.apply_to_payroll = bool(limits.apply_to_payroll, 'limits.apply_to_payroll', true);
  if (limits.apply_to_payroll === false) {
    warnings.push('apply_to_payroll is off, so payroll withholds no secondary-employment PAYE even though this schedule is saved.');
  }
  const minGross = numberOrNull(limits.min_gross, 'limits.min_gross') ?? 0;
  if (minGross < 0) throw badRequest('limits.min_gross cannot be negative');
  limits.min_gross = minGross;
  if (minGross > 0) {
    warnings.push(`Secondary-employment PAYE only applies once monthly chargeable income reaches ${minGross}.`);
  }

  const rawBands = limits.bands;
  if (rawBands !== undefined && rawBands !== null && !Array.isArray(rawBands)) {
    throw badRequest('limits.bands must be an array of { max, monthly_amount }');
  }
  const hasBands = Array.isArray(rawBands) && rawBands.length > 0;
  const flat = numberOrNull(limits.monthly_amount ?? rates.monthly_amount, 'limits.monthly_amount');
  const rawRate = rates.rate ?? limits.rate;
  const hasRate = rawRate !== undefined && rawRate !== null && rawRate !== '';

  if (hasBands) {
    const bands = (rawBands as unknown[]).map((entry, i) => {
      const o = (entry ?? {}) as Record<string, unknown>;
      const amount = numberOrNull(o.monthly_amount ?? o.amount, `bands[${i}].monthly_amount`) ?? 0;
      if (amount < 0) throw badRequest(`bands[${i}].monthly_amount cannot be negative`);
      return {
        max: o.max === null || o.max === undefined || o.max === '' ? null : numberOrNull(o.max, `bands[${i}].max`),
        monthly_amount: amount,
      };
    });
    bands.sort((a, b) => (a.max ?? Number.POSITIVE_INFINITY) - (b.max ?? Number.POSITIVE_INFINITY));
    bands.forEach((band, i) => {
      if (band.max !== null && band.max <= 0) throw badRequest(`bands[${i}].max must be above zero`);
      if (band.max === null && i !== bands.length - 1) {
        throw badRequest(`bands[${i}] is open-ended but more bands follow it; only the top band may run to infinity`);
      }
      if (i > 0) {
        const previous = bands[i - 1].max;
        if (previous === null) throw badRequest(`bands[${i}] follows an open-ended band, so it can never apply`);
        if (band.max !== null && band.max <= previous) {
          throw badRequest(`bands[${i}].max (${band.max}) must be above the previous band's ${previous}`);
        }
      }
    });
    limits.bands = bands;
    if (flat !== null) warnings.push('limits.monthly_amount is ignored while a graduated band schedule is present.');
    if (hasRate) warnings.push('rates.rate is ignored while a graduated band schedule is present.');
  } else {
    delete limits.bands;
    if (flat !== null) {
      if (flat < 0) throw badRequest('limits.monthly_amount cannot be negative');
      limits.monthly_amount = flat;
      if (hasRate) warnings.push('rates.rate is ignored while a flat monthly amount is present.');
    } else if (hasRate) {
      const pct = numberOrNull(rawRate, 'rates.rate');
      if (pct === null) throw badRequest('rates.rate must be a number');
      if (pct < 0 || pct > 100) throw badRequest(`rates.rate must be between 0 and 100, got ${pct}`);
      rates.rate = pct;
      delete limits.rate;
    } else {
      throw badRequest('A PAYE_SECONDARY configuration needs one of: limits.bands, limits.monthly_amount, or rates.rate');
    }
  }

  return {
    rates,
    thresholds: field(body, base, 'thresholds') ?? [],
    limits,
    formula: field(body, base, 'formula') ?? null,
    warnings,
  };
}

/** Categories with no bespoke shape keep whatever JSON they were given. */
function prepareGeneric(body: Record<string, unknown>, base?: Record<string, unknown>): PreparedConfig {
  const rates = field(body, base, 'rates') ?? [];
  const thresholds = field(body, base, 'thresholds') ?? [];
  const formula = field(body, base, 'formula') ?? null;
  if (rates !== null && !Array.isArray(rates) && typeof rates !== 'object') {
    throw badRequest('rates must be an array or an object');
  }
  return {
    rates,
    thresholds,
    limits: plainObject(field(body, base, 'limits'), 'limits'),
    formula,
    warnings: [],
  };
}

/** Validate a candidate table with the semantics the payroll engine applies. */
export function prepareStatutoryConfig(
  category: string,
  body: Record<string, unknown>,
  base?: Record<string, unknown>
): PreparedConfig {
  switch (category) {
    case 'PAYE':
      return preparePaye(body, base);
    case 'NSSF':
      return prepareNssf(body, base);
    case 'PAYE_SECONDARY':
      return prepareSecondaryPaye(body, base);
    case 'LST':
      return prepareLst(body, base);
    default:
      return prepareGeneric(body, base);
  }
}

export interface StatutoryListOptions {
  asOf?: string | null;
  /** undefined keeps the caller's company context, null asks for tenant-wide scope. */
  companyId?: number | null;
  category?: string | null;
  country?: string | null;
}

interface StatutoryRow {
  id: number;
  companyId: number | null;
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
  companyName: string | null;
}

/**
 * What payroll does with a stored table today:
 *   IN_EFFECT            the table the engine resolves for the active company
 *   SHADOWED_BY_COMPANY  a valid tenant-wide table that a company override beats
 *   OUTRANKED            a valid table a later or better-scoped table beats
 *   EXPIRED / SCHEDULED  outside its own effective window on the as-at date
 *   SUPERSEDED           retired by an administrator, so never resolved
 */
export const STATUTORY_STATES = [
  'IN_EFFECT',
  'SHADOWED_BY_COMPANY',
  'OUTRANKED',
  'EXPIRED',
  'SCHEDULED',
  'SUPERSEDED',
] as const;
export type StatutoryState = (typeof STATUTORY_STATES)[number];

/**
 * STATUTORY_COLUMNS, qualified with the alias `s` so it can be joined. The two
 * lists must stay in step: every key the API returns about a table comes from
 * one of them, and the date columns are cast to text in both so a DATE never
 * round-trips through a JS Date at local midnight and comes back a day early.
 */
const STATUTORY_COLUMNS_ALIASED = `s.id, s.company_id, s.tenant_id, s.country, s.category, s.code, s.name, s.description,
  s.effective_from::text AS effective_from,
  s.effective_to::text AS effective_to,
  s.rates, s.thresholds, s.limits, s.formula, s.version, s.status, s.created_at, s.updated_at`;

/**
 * undefined means "use my company", null means "the tenant-wide table every
 * company falls back to". Those are different values, so they stay different.
 */
function scopeFromBody(raw: unknown, ctx: Ctx): number | null {
  if (raw === undefined || raw === '') {
    const own = ctx.companyId != null ? Number(ctx.companyId) : NaN;
    return Number.isFinite(own) && own > 0 ? own : null;
  }
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw badRequest('companyId must be a company id, or null for the tenant-wide table');
  }
  return n;
}

function assertCategory(value: string): string {
  if (!(STATUTORY_CATEGORIES as readonly string[]).includes(value)) {
    throw badRequest(`category must be one of: ${STATUTORY_CATEGORIES.join(', ')}`);
  }
  return value;
}

function assertWindow(from: string, to: string | null) {
  if (to !== null && to < from) throw badRequest('effectiveFrom must be on or before effectiveTo');
}

/**
 * The statutory tables an administrator can see, each labelled with what payroll
 * will actually do with it on the as-at date.
 *
 * The winner per category comes from the engine's own resolver rather than from a
 * second copy of the precedence rule, so this screen can never claim a table is
 * in effect while a payslip is being calculated from a different one.
 */
export async function listStatutoryConfigs(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: StatutoryListOptions = {}
) {
  const asOf = date(opts.asOf, 'asOf') ?? isoToday();
  const country = (text(opts.country, 'country') ?? 'UG').toUpperCase();
  const category = opts.category != null && String(opts.category).trim() !== ''
    ? assertCategory(String(opts.category).trim())
    : null;
  const companyId = scopeFromBody(opts.companyId, ctx);

  const res = await client.query(
    `SELECT ${STATUTORY_COLUMNS_ALIASED}, c.name AS company_name
       FROM statutory_configs s
       LEFT JOIN companies c ON c.id = s.company_id
      WHERE s.tenant_id = $1
        AND s.country = $2
        AND ($3::text IS NULL OR s.category = $3)
        AND ($4::bigint IS NULL OR s.company_id IS NULL OR s.company_id = $4)
      ORDER BY s.category ASC, s.company_id NULLS FIRST, s.effective_from DESC NULLS LAST, s.version DESC`,
    [ctx.tenantId ?? null, country, category, companyId]
  );
  const rows = toCamelRows(res.rows) as unknown as StatutoryRow[];

  // Every category is resolved, not just the ones holding rows, so a gap such as
  // "no NSSF table at all" reads as loudly on this screen as a wrong rate does.
  const resolution: Array<Record<string, unknown>> = [];
  const winner = new Map<string, { id: number | null; scope: 'COMPANY' | 'TENANT' | null; code: string | null }>();
  for (const cat of STATUTORY_CATEGORIES) {
    const cfg = await statutory.getStatutoryConfig(client, ctx, cat, {
      effectiveDate: asOf,
      companyId,
      country,
    });
    const scope = cfg ? (cfg.companyId == null ? 'TENANT' as const : 'COMPANY' as const) : null;
    winner.set(cat, { id: cfg ? Number(cfg.id) : null, scope, code: cfg ? cfg.code : null });
    resolution.push({
      category: cat,
      configId: cfg ? cfg.id : null,
      code: cfg ? cfg.code : null,
      name: cfg ? cfg.name : null,
      version: cfg ? cfg.version : null,
      scope,
      companyId: cfg ? cfg.companyId : null,
      effectiveFrom: cfg ? toISODate(cfg.effectiveFrom) : null,
      effectiveTo: cfg ? toISODate(cfg.effectiveTo) : null,
      missing: !cfg,
    });
  }

  const configs = rows.map((row) => {
    const win = winner.get(String(row.category));
    const resolved = Boolean(win && win.id !== null && win.id === Number(row.id));
    let state: StatutoryState;
    if (String(row.status) !== 'ACTIVE') state = 'SUPERSEDED';
    else if (row.effectiveTo != null && String(row.effectiveTo) < asOf) state = 'EXPIRED';
    else if (row.effectiveFrom != null && String(row.effectiveFrom) > asOf) state = 'SCHEDULED';
    else if (resolved) state = 'IN_EFFECT';
    else if (win && win.scope === 'COMPANY' && row.companyId == null) state = 'SHADOWED_BY_COMPANY';
    else state = 'OUTRANKED';
    return {
      ...row,
      scope: row.companyId == null ? ('TENANT' as const) : ('COMPANY' as const),
      resolved,
      state,
      winnerConfigId: win ? win.id : null,
      winnerCode: win ? win.code : null,
    };
  });

  const companyRes = await client.query(
    `SELECT DISTINCT c.id, c.name
       FROM statutory_configs s
       JOIN companies c ON c.id = s.company_id
      WHERE s.tenant_id = $1 AND s.country = $2
      ORDER BY c.name`,
    [ctx.tenantId ?? null, country]
  );
  const companies = toCamelRows(companyRes.rows) as unknown as Array<{ id: number; name: string }>;
  if (companyId != null && !companies.some((c) => Number(c.id) === companyId)) {
    const own = await client.query(
      `SELECT id, name FROM companies WHERE id = $1 AND tenant_id = $2`,
      [companyId, ctx.tenantId ?? null]
    );
    if (own.rows.length > 0) {
      companies.push({ id: Number(own.rows[0].id), name: String(own.rows[0].name) });
      companies.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
  }

  return {
    asOf,
    country,
    companyId,
    categories: [...STATUTORY_CATEGORIES],
    configs,
    resolution,
    companies,
  };
}

export interface StatutoryPreviewInput {
  asOf?: string | null;
  country?: string | null;
  companyId?: number | null;
  gross?: unknown;
  /** Income tax is charged on this after employee NSSF; defaults to gross. */
  chargeableIncome?: unknown;
  periodStart?: string | null;
  periodEnd?: string | null;
}

/**
 * Push one gross figure through the arithmetic calculatePayroll uses, so an
 * administrator can see what a band or rate change does before saving it.
 * Deliberately calls the same statutory helpers as the payslip builder: a preview
 * that disagreed with payroll would be worse than no preview at all.
 */
export async function previewStatutory(client: pg.PoolClient, ctx: Ctx, input: StatutoryPreviewInput) {
  const asOf = date(input.asOf, 'asOf') ?? isoToday();
  const country = (text(input.country, 'country') ?? 'UG').toUpperCase();
  const companyId = scopeFromBody(input.companyId, ctx);
  const gross = numberOrNull(input.gross, 'gross');
  if (gross === null) throw badRequest('gross is required');
  if (gross < 0) throw badRequest('gross cannot be negative');
  const chargeableIncome = numberOrNull(input.chargeableIncome, 'chargeableIncome') ?? gross;
  const periodStart = date(input.periodStart, 'periodStart');
  const periodEnd = date(input.periodEnd, 'periodEnd');

  const [payeCfg, secondaryPayeCfg, nssfCfg, lstCfg] = await Promise.all([
    statutory.getStatutoryConfig(client, ctx, 'PAYE', { effectiveDate: asOf, companyId, country }),
    statutory.getStatutoryConfig(client, ctx, 'PAYE_SECONDARY', { effectiveDate: asOf, companyId, country }),
    statutory.getStatutoryConfig(client, ctx, 'NSSF', { effectiveDate: asOf, companyId, country }),
    statutory.getStatutoryConfig(client, ctx, 'LST', { effectiveDate: asOf, companyId, country }),
  ]);

  // The preview contrasts the two employments an employee could be on, so NSSF
  // is computed for the primary one: that is the contribution the member is
  // enrolled under. A tenant whose NSSF rule names only the primary employment
  // sees zero here for a second employment, which is what payroll would withhold.
  const nssf = nssfCfg
    ? statutory.computeNssf(gross, nssfCfg, { scope: 'primary' })
    : { employee: 0, employer: 0, base: 0, ceiling: null as number | null };
  const lst = statutory.computeLst(gross, lstCfg, {
    periodStart: periodStart ?? undefined,
    periodEnd: periodEnd ?? undefined,
  });
  const taxableIncome = round2(Math.max(0, chargeableIncome - nssf.employee));

  let paye = 0;
  let payeError: string | null = null;
  if (!payeCfg) {
    payeError = `No ACTIVE PAYE table for ${country} on ${asOf}`;
  } else {
    try {
      paye = statutory.computePaye(taxableIncome, payeCfg);
    } catch (err) {
      payeError = err instanceof Error ? err.message : String(err);
    }
  }

  // Secondary-employment PAYE: a second employer withholds a flat rate on the
  // chargeable income instead of the resident bands. Computed alongside the
  // primary figure so switching an employee between the two is visible before
  // it is saved. Zero when the tenant has not adopted the schedule.
  const secondaryPaye = statutory.computeSecondaryPaye(chargeableIncome, secondaryPayeCfg, { scope: 'secondary' });

  const totalDeductions = round2(paye + nssf.employee + lst);
  const net = round2(gross - totalDeductions);

  const describe = (cfg: statutory.StatutoryConfig | null) =>
    cfg
      ? {
          ...statutory.statutorySnapshot(cfg),
          id: cfg.id,
          companyId: cfg.companyId,
          scope: cfg.companyId == null ? ('TENANT' as const) : ('COMPANY' as const),
          effectiveFrom: toISODate(cfg.effectiveFrom),
          effectiveTo: toISODate(cfg.effectiveTo),
        }
      : null;

  return {
    asOf,
    country,
    companyId,
    gross,
    chargeableIncome,
    taxableIncome,
    nssf,
    paye,
    payeError,
    secondaryPaye,
    lst,
    totalDeductions,
    net,
    employerCost: round2(gross + nssf.employer),
    configs: {
      paye: describe(payeCfg),
      secondaryPaye: describe(secondaryPayeCfg),
      nssf: describe(nssfCfg),
      lst: describe(lstCfg),
    },
    steps: [
      { label: 'Gross pay', amount: gross, kind: 'gross' },
      { label: 'Employee NSSF', amount: -nssf.employee, kind: 'deduction' },
      { label: 'Taxable income', amount: taxableIncome, kind: 'subtotal' },
      { label: 'PAYE', amount: -paye, kind: 'deduction' },
      ...(secondaryPayeCfg
        ? [{ label: 'PAYE (secondary employment)', amount: -secondaryPaye, kind: 'deduction' }]
        : []),
      { label: 'Local service tax', amount: -lst, kind: 'deduction' },
      { label: 'Net pay', amount: net, kind: 'net' },
    ],
  };
}

/** Columns whose value is JSON and therefore needs an explicit ::jsonb cast. */
const JSON_COLUMNS = new Set(['rates', 'thresholds', 'limits', 'formula']);

function statutoryId(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw badRequest('A statutory configuration id is required');
  return n;
}

async function loadStatutoryRow(client: pg.PoolClient, ctx: Ctx, id: number): Promise<StatutoryRow> {
  const res = await client.query(
    `SELECT ${STATUTORY_COLUMNS} FROM statutory_configs WHERE id = $1 AND tenant_id = $2`,
    [id, ctx.tenantId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Statutory configuration not found');
  return toCamelRow(res.rows[0]) as unknown as StatutoryRow;
}

function jsonOrNull(value: unknown, fallback: unknown): string | null {
  const v = value === undefined ? fallback : value;
  return v === null || v === undefined ? null : JSON.stringify(v);
}

function snakeToCamelColumn(column: string): string {
  return column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Add a statutory table.
 *
 * A new table is versioned above every table in its category, so the engine's
 * `version DESC` tiebreak resolves to the newest edit rather than to whichever
 * row happened to be inserted last. When closePrevious is left on, the open
 * window of the previous table in the same scope is closed the day before this
 * one starts: two open-ended tables in one scope is the configuration mistake
 * that makes withholding change for no visible reason.
 */
export async function createStatutoryConfig(
  client: pg.PoolClient,
  ctx: Ctx,
  input: Record<string, unknown>
) {
  const category = assertCategory(text(input.category, 'category', true) as string);
  const code = text(input.code, 'code', true) as string;
  const name = text(input.name, 'name', true) as string;
  const description = text(input.description, 'description');
  const country = (text(input.country, 'country') ?? 'UG').toUpperCase();
  const companyId = scopeFromBody(input.companyId, ctx);
  const effectiveFrom = date(input.effectiveFrom, 'effectiveFrom', true) as string;
  const effectiveTo = date(input.effectiveTo, 'effectiveTo');
  assertWindow(effectiveFrom, effectiveTo);

  // Read the candidate table the way the engine will read it before storing it:
  // a band gap accepted here is a silent under-withholding on every payslip after.
  const prepared = prepareStatutoryConfig(category, input);
  const closePrevious = bool(input.closePrevious, 'closePrevious', true);
  const reason = text(input.reason, 'reason');

  const versionRes = await client.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM statutory_configs
      WHERE tenant_id = $1 AND country = $2 AND category = $3`,
    [ctx.tenantId ?? null, country, category]
  );
  const version = Number(versionRes.rows[0].version);

  let closed: Array<{ id: number; code: string; effectiveTo: string | null }> = [];
  if (closePrevious) {
    const upd = await client.query(
      `UPDATE statutory_configs
          SET effective_to = GREATEST(effective_from, ($5::date - INTERVAL '1 day')::date),
              updated_at = now()
        WHERE tenant_id = $1 AND country = $2 AND category = $3
          AND company_id IS NOT DISTINCT FROM $4
          AND status = 'ACTIVE'
          AND effective_to IS NULL
          AND effective_from < $5::date
        RETURNING id, code, effective_to::text AS effective_to`,
      [ctx.tenantId ?? null, country, category, companyId, effectiveFrom]
    );
    closed = upd.rows.map((r) => ({
      id: Number(r.id),
      code: String(r.code),
      effectiveTo: r.effective_to != null ? String(r.effective_to) : null,
    }));
  }

  const ins = await client.query(
    `INSERT INTO statutory_configs
       (tenant_id, company_id, country, category, code, name, description,
        effective_from, effective_to, rates, thresholds, limits, formula, version, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,'ACTIVE')
     RETURNING ${STATUTORY_COLUMNS}`,
    [
      ctx.tenantId ?? null, companyId, country, category, code, name, description,
      effectiveFrom, effectiveTo,
      JSON.stringify(prepared.rates ?? []),
      JSON.stringify(prepared.thresholds ?? []),
      JSON.stringify(prepared.limits ?? {}),
      jsonOrNull(prepared.formula, null),
      version,
    ]
  );
  const created = toCamelRow(ins.rows[0]) as unknown as StatutoryRow;

  await logAudit(client, ctx, {
    action: 'create',
    resource: 'statutory_configs',
    recordId: created.id,
    recordCode: created.code,
    newValues: {
      category, code, name, country, companyId, effectiveFrom, effectiveTo, version,
      rates: prepared.rates, thresholds: prepared.thresholds, limits: prepared.limits, formula: prepared.formula,
    },
    metadata: {
      scope: companyId == null ? 'TENANT' : 'COMPANY',
      closedPrevious: closed,
      ...(reason ? { reason } : {}),
    },
  });

  return { config: created, warnings: prepared.warnings, closedPrevious: closed, reason };
}

/**
 * Edit a table in place. Only ACTIVE tables are editable: rewriting a superseded
 * table would change what a past payslip claims to have been calculated from.
 * A category change is allowed but re-validated, because PAYE bands and an NSSF
 * rate object are not interchangeable shapes.
 */
export async function updateStatutoryConfig(
  client: pg.PoolClient,
  ctx: Ctx,
  rawId: unknown,
  input: Record<string, unknown>
) {
  const id = statutoryId(rawId);
  const row = await loadStatutoryRow(client, ctx, id);
  if (String(row.status) !== 'ACTIVE') {
    throw badRequest(`${row.code} is SUPERSEDED and cannot be edited. Restore it first if it should apply again.`);
  }

  const category = input.category !== undefined
    ? assertCategory(String(input.category))
    : String(row.category);
  const country = input.country !== undefined
    ? (text(input.country, 'country', true) ?? 'UG').toUpperCase()
    : String(row.country);
  const companyId = input.companyId !== undefined ? scopeFromBody(input.companyId, ctx) : row.companyId;
  const effectiveFrom = input.effectiveFrom !== undefined
    ? (date(input.effectiveFrom, 'effectiveFrom', true) as string)
    : String(row.effectiveFrom);
  const effectiveTo = input.effectiveTo !== undefined
    ? date(input.effectiveTo, 'effectiveTo')
    : (row.effectiveTo != null ? String(row.effectiveTo) : null);
  assertWindow(effectiveFrom, effectiveTo);

  const touchesTable = ['rates', 'thresholds', 'limits', 'formula'].some((k) => input[k] !== undefined);
  const prepared = touchesTable
    ? prepareStatutoryConfig(category, input, row as unknown as Record<string, unknown>)
    : null;

  const params: unknown[] = [ctx.tenantId ?? null, id];
  const sets: string[] = [];
  const changed: Record<string, unknown> = {};
  const addSet = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}${JSON_COLUMNS.has(column) ? '::jsonb' : ''}`);
    changed[snakeToCamelColumn(column)] = value;
  };

  if (input.code !== undefined) addSet('code', text(input.code, 'code', true));
  if (input.name !== undefined) addSet('name', text(input.name, 'name', true));
  if (input.description !== undefined) addSet('description', text(input.description, 'description'));
  if (input.category !== undefined) addSet('category', category);
  if (input.country !== undefined) addSet('country', country);
  if (input.companyId !== undefined) addSet('company_id', companyId);
  if (input.effectiveFrom !== undefined) addSet('effective_from', effectiveFrom);
  if (input.effectiveTo !== undefined) addSet('effective_to', effectiveTo);
  if (prepared) {
    addSet('rates', JSON.stringify(prepared.rates ?? []));
    addSet('thresholds', JSON.stringify(prepared.thresholds ?? []));
    addSet('limits', JSON.stringify(prepared.limits ?? {}));
    addSet('formula', jsonOrNull(prepared.formula, null));
  }
  if (sets.length === 0) throw badRequest('Nothing to update');
  sets.push('updated_at = now()');

  const upd = await client.query(
    `UPDATE statutory_configs
        SET ${sets.join(', ')}
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${STATUTORY_COLUMNS}`,
    params
  );
  const updated = toCamelRow(upd.rows[0]) as unknown as StatutoryRow;

  const oldValues: Record<string, unknown> = {};
  for (const key of Object.keys(changed)) {
    oldValues[key] = (row as unknown as Record<string, unknown>)[key] ?? null;
  }

  const reason = text(input.reason, 'reason');
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'statutory_configs',
    recordId: id,
    recordCode: updated.code,
    oldValues,
    newValues: changed,
    metadata: { asOf: isoToday(), ...(reason ? { reason } : {}) },
  });

  return { config: updated, warnings: prepared ? prepared.warnings : [], changes: changed, reason };
}

export interface StatutoryStatusChangeInput {
  asOf?: unknown;
  force?: unknown;
  reason?: unknown;
}

/**
 * The company scopes a stored table can serve today. A company-scoped table
 * serves exactly one company; a tenant-wide table is the fallback for every
 * company in the tenant, so retiring one has to be checked against all of them.
 */
async function scopesForRow(client: pg.PoolClient, ctx: Ctx, row: StatutoryRow): Promise<Array<number | null>> {
  if (row.companyId != null) return [Number(row.companyId)];
  const res = await client.query(
    `SELECT id FROM companies WHERE tenant_id = $1 ORDER BY id`,
    [ctx.tenantId ?? null]
  );
  const ids = res.rows.map((r) => Number(r.id));
  const own = ctx.companyId != null ? Number(ctx.companyId) : NaN;
  if (Number.isFinite(own) && own > 0 && !ids.includes(own)) ids.push(own);
  return ids.length > 0 ? ids : [null];
}

/** What payroll resolves for one company on the as-at date, if anything. */
async function resolveOne(
  client: pg.PoolClient,
  ctx: Ctx,
  row: StatutoryRow,
  asOf: string,
  companyId: number | null
): Promise<{ companyId: number | null; id: number | null; code: string | null }> {
  const cfg = await statutory.getStatutoryConfig(client, ctx, String(row.category), {
    effectiveDate: asOf,
    companyId,
    country: String(row.country),
  });
  return cfg ? { companyId, id: Number(cfg.id), code: String(cfg.code) } : { companyId, id: null, code: null };
}

async function resolveAcrossScopes(
  client: pg.PoolClient,
  ctx: Ctx,
  row: StatutoryRow,
  asOf: string,
  scopes: Array<number | null>
) {
  const out: Array<{ companyId: number | null; id: number | null; code: string | null }> = [];
  for (const scope of scopes) out.push(await resolveOne(client, ctx, row, asOf, scope));
  return out;
}

const scopeLabel = (companyId: number | null) =>
  companyId == null ? 'the tenant-wide scope' : `company ${companyId}`;

const setStatus = (
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  status: 'ACTIVE' | 'SUPERSEDED'
) =>
  client.query(
    `UPDATE statutory_configs
        SET status = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${STATUTORY_COLUMNS}`,
    [ctx.tenantId ?? null, id, status]
  );

/**
 * Retire a statutory table without deleting it.
 *
 * The guard is arithmetic rather than a rule of thumb: the row is flipped to
 * SUPERSEDED, then the engine is asked again what each affected company
 * resolves. If any of them would now resolve nothing, payroll has just lost a
 * withholding table, so the flip is undone and the caller is told to add the
 * replacement first. `force` exists because retiring the last table in a scope
 * is legitimate when a category stops applying - but it has to be a stated,
 * recorded decision, which is why it requires a reason.
 */
export async function supersedeStatutoryConfig(
  client: pg.PoolClient,
  ctx: Ctx,
  rawId: unknown,
  input: StatutoryStatusChangeInput = {}
) {
  const id = statutoryId(rawId);
  const row = await loadStatutoryRow(client, ctx, id);
  if (String(row.status) !== 'ACTIVE') {
    throw badRequest(`${row.code} is already ${row.status}; only an ACTIVE table can be superseded.`);
  }
  const asOf = date(input.asOf, 'asOf') ?? isoToday();
  const force = bool(input.force, 'force', false);
  const reason = text(input.reason, 'reason');
  if (force && !reason) throw badRequest('A reason is required when forcing a statutory table out of effect.');

  const scopes = await scopesForRow(client, ctx, row);
  const before = await resolveAcrossScopes(client, ctx, row, asOf, scopes);
  const affected = before.filter((r) => r.id === id);

  const upd = await setStatus(client, ctx, id, 'SUPERSEDED');
  const updated = toCamelRow(upd.rows[0]) as unknown as StatutoryRow;

  const after = await resolveAcrossScopes(client, ctx, row, asOf, scopes);
  const nextFor = (companyId: number | null) => after.find((a) => a.companyId === companyId);
  const lost = affected.filter((r) => {
    const next = nextFor(r.companyId);
    return !next || next.id === null;
  });
  const replacements = affected.flatMap((r) => {
    const next = nextFor(r.companyId);
    return next && next.id != null ? [{ companyId: r.companyId, id: next.id, code: next.code }] : [];
  });

  if (lost.length > 0 && !force) {
    await setStatus(client, ctx, id, 'ACTIVE');
    throw badRequest(
      `${row.code} is the table payroll uses today for ${lost.map((l) => scopeLabel(l.companyId)).join(', ')}. ` +
        `Add a replacement table covering ${asOf}, or repeat with force and a reason.`
    );
  }

  const forced = force && lost.length > 0;
  const affectedScopes = affected.map((r) => r.companyId);
  const lostScopes = lost.map((r) => r.companyId);

  await logAudit(client, ctx, {
    action: 'update',
    resource: 'statutory_configs',
    recordId: id,
    recordCode: updated.code,
    oldValues: { status: String(row.status) },
    newValues: { status: 'SUPERSEDED' },
    metadata: {
      asOf,
      forced,
      affectedScopes,
      lostScopes,
      replacements,
      ...(reason ? { reason } : {}),
    },
  });

  return { config: updated, asOf, forced, affectedScopes, lostScopes, replacements, reason };
}

/**
 * Put a retired table back in effect.
 *
 * Restoring is refused while another ACTIVE table already covers the same scope
 * and date, because the engine would then break the tie on `version` and
 * withholding would silently follow whichever row happened to be saved last.
 * Conflicts are reported by code so the administrator can close or supersede the
 * other table instead.
 */
export async function restoreStatutoryConfig(
  client: pg.PoolClient,
  ctx: Ctx,
  rawId: unknown,
  input: StatutoryStatusChangeInput = {}
) {
  const id = statutoryId(rawId);
  const row = await loadStatutoryRow(client, ctx, id);
  if (String(row.status) === 'ACTIVE') throw badRequest(`${row.code} is already ACTIVE.`);
  const asOf = date(input.asOf, 'asOf') ?? isoToday();
  const force = bool(input.force, 'force', false);
  const reason = text(input.reason, 'reason');
  if (force && !reason) throw badRequest('A reason is required when restoring a table over an existing one.');

  const clash = await client.query(
    `SELECT id, code, version, effective_from::text AS effective_from, effective_to::text AS effective_to
       FROM statutory_configs
      WHERE tenant_id = $1 AND country = $2 AND category = $3
        AND company_id IS NOT DISTINCT FROM $4
        AND status = 'ACTIVE'
        AND id <> $5
        AND (effective_from IS NULL OR effective_from <= $6::date)
        AND (effective_to IS NULL OR effective_to >= $6::date)
      ORDER BY effective_from DESC NULLS LAST, version DESC`,
    [ctx.tenantId ?? null, String(row.country), String(row.category), row.companyId, id, asOf]
  );
  const conflicts = clash.rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    version: Number(r.version),
    effectiveFrom: r.effective_from != null ? String(r.effective_from) : null,
    effectiveTo: r.effective_to != null ? String(r.effective_to) : null,
  }));

  if (conflicts.length > 0 && !force) {
    throw badRequest(
      `${row.code} would overlap ${conflicts.map((c) => c.code).join(', ')} in ` +
        `${scopeLabel(row.companyId)} on ${asOf}. Supersede the other table first, or repeat with force and a reason.`
    );
  }

  const upd = await setStatus(client, ctx, id, 'ACTIVE');
  const updated = toCamelRow(upd.rows[0]) as unknown as StatutoryRow;

  const scopes = await scopesForRow(client, ctx, row);
  const resolved = await resolveAcrossScopes(client, ctx, row, asOf, scopes);
  const winsScopes = resolved.filter((r) => r.id === id).map((r) => r.companyId);
  const warnings =
    winsScopes.length === 0
      ? [`${row.code} is ACTIVE again but payroll still resolves a different table on ${asOf}.`]
      : [];

  const forced = force && conflicts.length > 0;
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'statutory_configs',
    recordId: id,
    recordCode: updated.code,
    oldValues: { status: String(row.status) },
    newValues: { status: 'ACTIVE' },
    metadata: { asOf, forced, conflicts, winsScopes, ...(reason ? { reason } : {}) },
  });

  return { config: updated, asOf, forced, conflicts, winsScopes, warnings, reason };
}
