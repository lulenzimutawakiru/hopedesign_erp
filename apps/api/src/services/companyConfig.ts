import pg from 'pg';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Ctx } from '../db.js';
import { badRequest } from '../utils.js';
import { config } from '../config.js';
import { logAudit } from './audit.js';

export const PERMS = {
  view: 'admin.company_config.view',
  update: 'admin.company_config.update',
  administer: 'admin.company_config.administer',
};

/** Platform-level defaults applied when a company has no override. */
export const PLATFORM_DEFAULTS: Record<string, unknown> = {
  'general.currency': 'UGX',
  'general.currency_symbol': 'UGX',
  'general.default_tax_rate': 18,
  'general.tax_inclusive': false,
  'general.fiscal_year_start': '07-01',
  'general.decimal_precision': 2,
  'general.rounding_rule': 'round',
  'general.payment_terms': '30 days',
  'security.password_min_length': 8,
  'security.mfa_required_for_admins': false,
  'documents.document_retention_years': 7,
};

export const FINANCIAL_KEYS = [
  'currency', 'currency_symbol', 'fiscal_year_start', 'decimal_precision', 'payment_terms',
  'credit_limit', 'exchange_rate_source', 'rounding_rule', 'tax_inclusive',
];

export const TAX_KEYS = ['default_tax_rate', 'withholding_tax_rate', 'tax_id', 'vat_number', 'tax_inclusive', 'tax_exclusive'];

/** Merge app_settings: company override > tenant default > platform default. */
export async function resolveAppSettings(client: pg.PoolClient, ctx: Ctx): Promise<Record<string, unknown>> {
  const res = await client.query(
    `SELECT category, key, value, is_secret FROM app_settings
     WHERE tenant_id = $1 AND (company_id = $2 OR company_id IS NULL)
     ORDER BY (company_id IS NOT NULL) DESC`,
    [ctx.tenantId ?? null, ctx.companyId ?? null]
  );
  const out: Record<string, unknown> = { ...PLATFORM_DEFAULTS };
  for (const row of res.rows) {
    if (row.is_secret) continue;
    out[`${row.category}.${row.key}`] = row.value;
  }
  return out;
}

export function settingString(settings: Record<string, unknown>, key: string): string {
  const v = settings[key];
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

export function settingNumber(settings: Record<string, unknown>, key: string): number {
  const v = Number(settings[key]);
  return Number.isFinite(v) ? v : 0;
}

export function settingBool(settings: Record<string, unknown>, key: string): boolean {
  const v = settings[key];
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** Upsert a company-scoped app_setting and record it in configuration_history + audit. */
export async function upsertAppSetting(
  client: pg.PoolClient,
  ctx: Ctx,
  category: string,
  key: string,
  value: unknown,
  opts: { secret?: boolean; resource?: string } = {}
) {
  const tenantId = ctx.tenantId ?? null;
  const companyId = ctx.companyId ?? null;
  const prev = await client.query(
    `SELECT value FROM app_settings WHERE tenant_id = $1 AND company_id = $2 AND category = $3 AND key = $4`,
    [tenantId, companyId, category, key]
  );
  const oldValue = prev.rows[0]?.value ?? null;
  await client.query(
    `INSERT INTO app_settings (tenant_id, company_id, category, key, value, is_secret, updated_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (tenant_id, company_id, category, key)
     DO UPDATE SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret,
                   updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantId, companyId, category, key, JSON.stringify(value), opts.secret ?? false, ctx.userId ?? null]
  );
  await client.query(
    `INSERT INTO configuration_history (tenant_id, user_id, category, config_key, old_value, new_value, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, ctx.userId ?? null, category, key, oldValue, JSON.stringify(value), ctx.ip ?? null]
  );
  await auditConfig(client, ctx, 'update', opts.resource ?? `company.config.${category}`, null, {
    [key]: oldValue,
  }, { [key]: value }, { category });
}

/** App-level audit entry for configuration changes. */
export async function auditConfig(
  client: pg.PoolClient,
  ctx: Ctx,
  action: string,
  resource: string,
  recordId: number | null,
  oldValues?: Record<string, unknown> | null,
  newValues?: Record<string, unknown> | null,
  metadata?: Record<string, unknown>
) {
  await logAudit(client, ctx, {
    action,
    resource,
    recordId: recordId ?? null,
    oldValues: oldValues ?? null,
    newValues: newValues ?? null,
    metadata,
  });
}

/** Encrypt a sensitive value at rest. Never returns ciphertext to clients. */
export function encryptSecret(plain: string): string {
  const key = createHash('sha256').update(`${config.jwtSecret}:company-config`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** Decrypt a value previously encrypted with encryptSecret; tolerant of legacy plaintext. */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith('v1:')) return stored;
  const [ver, ivB64, tagB64, dataB64] = stored.split(':');
  if (ver !== 'v1' || !ivB64 || !tagB64 || !dataB64) return null;
  try {
    const key = createHash('sha256').update(`${config.jwtSecret}:company-config`).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ===================== Numbering engine =====================

export interface NumberingRule {
  id: number;
  docType: string;
  prefix: string;
  format: string;
  includeYear: boolean;
  includeBranch: boolean;
  includeDepartment: boolean;
  pad: number;
  startSeq: number;
  suffix: string | null;
  resetFrequency: string;
  companyId: number | null;
  branchId: number | null;
}

export interface DocNoVars {
  year: number;
  month: number;
  day: number;
  branchCode?: string | null;
  departmentCode?: string | null;
  companyCode?: string | null;
}

const padNum = (n: number, w: number) => String(n).padStart(w, '0');

/** Fiscal year start from companies.fiscal_year_start ("MM-DD"); default 01 July. */
export function fiscalYearFor(date: Date, fiscalStart: string | null | undefined): number {
  const [m, d] = (fiscalStart || '07-01').split('-').map(Number);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  let year = date.getFullYear();
  if (month < m || (month === m && day < d)) year -= 1;
  return year;
}

export function resetKeyFor(
  docType: string,
  companyId: number | null | undefined,
  branchId: number | null | undefined,
  resetFrequency: string,
  year: number
): { seqKey: string; docYear: number } {
  const base = `${docType}:${companyId ?? 0}:${branchId ?? 0}`;
  const calYear = new Date().getFullYear();
  const month = new Date().getMonth() + 1;
  switch (resetFrequency) {
    case 'MONTH':
      return { seqKey: `${base}:${calYear}${padNum(month, 2)}`, docYear: calYear };
    case 'QUARTER':
      return { seqKey: `${base}:${calYear}Q${Math.ceil(month / 3)}`, docYear: calYear };
    case 'NONE':
      return { seqKey: `${base}:ALL`, docYear: 1 };
    case 'FISCAL_YEAR':
      return { seqKey: `${base}:FY:${year}`, docYear: year };
    default:
      return { seqKey: `${base}:${year}`, docYear: year };
  }
}

export function buildDocNo(rule: NumberingRule, seq: number, vars: DocNoVars): string {
  const widthMatch = rule.format.match(/\{#+\}/);
  const width = widthMatch ? widthMatch[0].length - 2 : rule.pad;
  const fmt = rule.format
    .replace(/\{PREFIX\}/g, rule.prefix)
    .replace(/\{YYYY\}/g, String(vars.year))
    .replace(/\{YY\}/g, String(vars.year).slice(-2))
    .replace(/\{YEAR\}/g, String(vars.year))
    .replace(/\{MM\}/g, padNum(vars.month, 2))
    .replace(/\{DD\}/g, padNum(vars.day, 2))
    .replace(/\{BRANCH\}/g, vars.branchCode ?? '')
    .replace(/\{DEPARTMENT\}/g, vars.departmentCode ?? '')
    .replace(/\{COMPANY\}/g, vars.companyCode ?? '')
    .replace(/\{#+\}/g, padNum(seq, width))
    .replace(/\{SEQ\}/g, padNum(seq, rule.pad));
  return fmt + (rule.suffix ?? '');
}

/** Find the most specific active numbering rule for a doc type. */
export async function resolveNumberingRule(
  client: pg.PoolClient,
  ctx: Ctx,
  docType: string
): Promise<NumberingRule | null> {
  const res = await client.query(
    `SELECT * FROM document_numbering_rules
     WHERE tenant_id = $1 AND doc_type = $2 AND is_active = true
       AND (company_id = $3 OR company_id IS NULL)
       AND (branch_id = $4 OR branch_id IS NULL)
     ORDER BY (company_id IS NOT NULL) DESC, (branch_id IS NOT NULL) DESC, id DESC
     LIMIT 1`,
    [ctx.tenantId ?? null, docType, ctx.companyId ?? null, ctx.branchId ?? null]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    id: Number(r.id),
    docType: r.doc_type,
    prefix: r.prefix,
    format: r.format ?? '{PREFIX}-{YEAR}-{SEQ}',
    includeYear: r.include_year ?? true,
    includeBranch: r.include_branch ?? false,
    includeDepartment: r.include_department ?? false,
    pad: Number(r.pad ?? 6),
    startSeq: Number(r.start_seq ?? 1),
    suffix: r.suffix ?? null,
    resetFrequency: r.reset_frequency ?? 'YEAR',
    companyId: r.company_id == null ? null : Number(r.company_id),
    branchId: r.branch_id == null ? null : Number(r.branch_id),
  };
}

interface ResolvedVars {
  vars: DocNoVars;
  fiscalStart: string | null;
}

async function resolveVars(client: pg.PoolClient, ctx: Ctx): Promise<ResolvedVars> {
  const date = new Date();
  const vars: DocNoVars = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  let fiscalStart: string | null = null;
  const companyId = ctx.companyId ?? null;
  if (companyId != null) {
    const c = await client.query('SELECT code, fiscal_year_start FROM companies WHERE id = $1 AND tenant_id = $2', [companyId, ctx.tenantId ?? null]);
    if (c.rows.length) {
      vars.companyCode = c.rows[0].code;
      fiscalStart = c.rows[0].fiscal_year_start ?? null;
    }
  }
  if (ctx.branchId != null) {
    const b = await client.query('SELECT code FROM branches WHERE id = $1 AND tenant_id = $2', [ctx.branchId, ctx.tenantId ?? null]);
    if (b.rows.length) vars.branchCode = b.rows[0].code;
  } else if (companyId != null) {
    const b = await client.query(
      'SELECT code FROM branches WHERE company_id = $1 AND tenant_id = $2 ORDER BY id LIMIT 1',
      [companyId, ctx.tenantId ?? null]
    );
    if (b.rows.length) vars.branchCode = b.rows[0].code;
  }
  return { vars, fiscalStart };
}

function yearForRule(dateYear: number, fiscalStart: string | null | undefined, rule: NumberingRule): number {
  return rule.resetFrequency === 'FISCAL_YEAR' ? fiscalYearFor(new Date(), fiscalStart) : dateYear;
}

/** Compute the next number without consuming it. */
export async function previewDocNo(client: pg.PoolClient, ctx: Ctx, docType: string): Promise<{ number: string; seq: number; rule: NumberingRule }> {
  const rule = await resolveNumberingRule(client, ctx, docType);
  if (!rule) throw badRequest(`No active numbering rule configured for ${docType}`);
  const { vars, fiscalStart } = await resolveVars(client, ctx);
  vars.year = yearForRule(vars.year, fiscalStart, rule);
  const { seqKey, docYear } = resetKeyFor(rule.docType, ctx.companyId, ctx.branchId, rule.resetFrequency, vars.year);
  const res = await client.query(
    'SELECT last_seq FROM number_sequences WHERE tenant_id = $1 AND seq_key = $2 AND doc_year = $3',
    [ctx.tenantId ?? null, seqKey, docYear]
  );
  const seq = res.rows.length ? Number(res.rows[0].last_seq) + 1 : rule.startSeq;
  return { number: buildDocNo(rule, seq, vars), seq, rule };
}

/** Transaction-safe allocation. Must run inside a transaction. */
export async function allocateDocNo(
  client: pg.PoolClient,
  ctx: Ctx,
  docType: string
): Promise<{ number: string; seq: number; rule: NumberingRule }> {
  const rule = await resolveNumberingRule(client, ctx, docType);
  if (!rule) throw badRequest(`No active numbering rule configured for ${docType}`);
  const { vars, fiscalStart } = await resolveVars(client, ctx);
  vars.year = yearForRule(vars.year, fiscalStart, rule);
  const { seqKey, docYear } = resetKeyFor(rule.docType, ctx.companyId, ctx.branchId, rule.resetFrequency, vars.year);
  const res = await client.query(
    `INSERT INTO number_sequences (tenant_id, seq_key, doc_year, last_seq)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, seq_key, doc_year)
     DO UPDATE SET last_seq = number_sequences.last_seq + 1, updated_at = now()
     RETURNING last_seq`,
    [ctx.tenantId ?? null, seqKey, docYear, rule.startSeq - 1]
  );
  const seq = Number(res.rows[0].last_seq);
  return { number: buildDocNo(rule, seq, vars), seq, rule };
}
