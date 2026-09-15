import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../../utils.js';
import { logAudit } from '../audit.js';
import { ORG_CATEGORY_BY_ID, categoryFields } from './catalogue.js';
import { loadCategoryValues, saveCategoryValues } from './settings.js';

/**
 * Security settings - the deny-by-default control plane.
 *
 * The screen is driven by the catalogue (kind 'security_policy'), but a screen
 * that only wrote app_settings would be decoration: the login path and the API
 * middleware read a security_policies row. So every save writes both - the
 * per-field app_settings value (which produces the per-field audit trail and
 * the change history) and the single security_policies row that enforcement
 * actually consults. One constant maps the two, so the reader and the writer
 * cannot drift apart.
 *
 * Storage note: the catalogue types ip_allowlist / ip_denylist as comma- or
 * newline-separated text because app_settings holds scalars. security_policies
 * holds text[]. POLICY_COLUMNS is the only place that translation is written
 * down, and it is used by both directions.
 */

export const SECURITY_CATEGORY = 'security';
export const DEFAULT_POLICY_CODE = 'DEFAULT';

/** Columns mirrored between the catalogue keys and security_policies. */
const ARRAY_COLUMNS = ['ip_allowlist', 'ip_denylist'] as const;
type ArrayColumn = (typeof ARRAY_COLUMNS)[number];

/** Every security_policies column the catalogue is allowed to drive. */
const POLICY_COLUMNS: readonly string[] = Object.freeze(
  Object.keys(categoryFields(SECURITY_CATEGORY)).filter((k) => k !== 'code' && k !== 'name')
);

function requireCompany(ctx: Ctx): number {
  if (ctx.companyId == null) {
    throw badRequest('An active company context is required to configure security');
  }
  return Number(ctx.companyId);
}

function text(v: unknown, field: string, required = false): string | null {
  if (v === null || v === undefined) {
    if (required) throw badRequest(field + ' is required');
    return null;
  }
  const s = String(v).trim();
  if (s === '') {
    if (required) throw badRequest(field + ' is required');
    return null;
  }
  return s;
}

function bool(v: unknown, dflt: boolean): boolean {
  if (v === null || v === undefined || v === '') return dflt;
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  throw badRequest('Expected a boolean value');
}

function int(v: unknown, field: string, min: number, max: number, required = false): number | null {
  if (v === null || v === undefined || v === '') {
    if (required) throw badRequest(field + ' is required');
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest(field + ' must be a whole number');
  if (n < min || n > max) throw badRequest(field + ' must be between ' + min + ' and ' + max);
  return n;
}

/** '10.0.0.0/8, 41.210.0.0/16' and newline lists both become text[]. */
export function parseAddressList(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  const raw = Array.isArray(v) ? v.map((x) => String(x)) : String(v).split(/[,\n;]/);
  const out: string[] = [];
  for (const entry of raw) {
    const s = entry.trim();
    if (s !== '' && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The inverse of parseAddressList, so an edit round-trips unchanged. */
export function formatAddressList(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  return String(v);
}

/**
 * The effective policy row for the acting company.
 *
 * A company row wins over a tenant-wide row (company_id IS NULL). NULLs are
 * distinct in the unique index, so a tenant-wide row cannot be upserted by the
 * ON CONFLICT path; that is why writes always carry a company_id and the
 * tenant-wide row is read-only fallback.
 */
export async function getSecurityPolicyRow(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM security_policies
      WHERE tenant_id = $1 AND is_active = true AND (company_id = $2 OR company_id IS NULL)
      ORDER BY (company_id IS NOT NULL) DESC, id DESC
      LIMIT 1`,
    [ctx.tenantId ?? null, ctx.companyId ?? null]
  );
  return res.rows.length > 0 ? res.rows[0] : null;
}

/**
 * The security settings screen: catalogue defaults, stored overrides, and the
 * enforced row, so an administrator can see whether the policy is live.
 */
export async function securityOverview(client: pg.PoolClient, ctx: Ctx) {
  const cat = ORG_CATEGORY_BY_ID.get(SECURITY_CATEGORY);
  if (!cat) throw notFound('Security settings are not configured in the catalogue');
  const values = await loadCategoryValues(client, ctx, cat);
  const row = await getSecurityPolicyRow(client, ctx);
  return {
    category: cat.id,
    label: cat.label,
    values: values.values,
    secrets: values.secrets,
    enforced: row
      ? { code: row.code, name: row.name, isActive: row.is_active, source: 'company' }
      : { code: DEFAULT_POLICY_CODE, name: 'Platform defaults', isActive: false, source: 'defaults' },
  };
}

/**
 * Persist the security screen.
 *
 * Values go through saveCategoryValues first (validation, per-field audit,
 * configuration_history), then the union of what the screen now holds is
 * written onto security_policies so the enforcement path sees the same policy.
 */
export async function saveSecurityPolicy(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
) {
  const cat = ORG_CATEGORY_BY_ID.get(SECURITY_CATEGORY);
  if (!cat) throw notFound('Security settings are not configured in the catalogue');
  const saved = await saveCategoryValues(client, ctx, cat, body);
  const merged = { ...saved.values };
  const existing = await getSecurityPolicyRow(client, ctx);
  if (existing) {
    for (const k of ARRAY_COLUMNS) {
      const key = k as ArrayColumn;
      if (merged[key] === undefined || merged[key] === null || merged[key] === '') {
        merged[key] = formatAddressList(existing[key]);
      }
    }
  }
  await writeSecurityPolicyRow(client, ctx, merged, body);
  return securityOverview(client, ctx);
}

/**
 * Upsert the enforced row. Select-then-write rather than ON CONFLICT because
 * the reader may have resolved a tenant-wide row and this screen must correct
 * that row in place rather than create a second one.
 */
async function writeSecurityPolicyRow(
  client: pg.PoolClient,
  ctx: Ctx,
  values: Record<string, unknown>,
  body: Record<string, unknown>
) {
  const tenantId = ctx.tenantId ?? null;
  const companyId = requireCompany(ctx);
  const code = text(body.code, 'code') ?? (await resolvePolicyCode(client, tenantId, companyId));
  const name = text(body.name, 'name') ?? 'Organisation security policy';

  const columns: string[] = ['tenant_id', 'company_id', 'code', 'name'];
  const params: unknown[] = [tenantId, companyId, code, name];
  const assignments: string[] = [];

  for (const col of POLICY_COLUMNS) {
    if (col === 'ip_allowlist' || col === 'ip_denylist') continue;
    const def = categoryFields(SECURITY_CATEGORY)[col];
    if (!def) continue;
    const raw = values[col];
    if (raw === undefined) continue;
    if (def.type === 'boolean') {
      params.push(bool(raw, false));
    } else if (def.type === 'number') {
      const n = int(raw, col, def.min ?? 0, def.max ?? 100000, false);
      if (n === null) continue;
      params.push(n);
    } else {
      const s = text(raw, col, false);
      if (s === null) continue;
      params.push(s);
    }
    columns.push(col);
  }

  // Address lists are written in both directions from the same constant, which
  // is what stops a stored key and a read key from diverging.
  for (const key of ARRAY_COLUMNS) {
    const source = values[key] !== undefined ? values[key] : body[key];
    if (source === undefined) continue;
    params.push(parseAddressList(source));
    columns.push(key);
  }

  params.push(ctx.userId ?? null);
  const updatedByIdx = params.length;

  const placeholders = params.map((_v, i) => '$' + (i + 1)).join(',');
  const updates = columns
    .slice(4)
    .map((c, i) => c + ' = $' + (i + 5))
    .concat('updated_by = $' + updatedByIdx, 'updated_at = now()');

  const res = await client.query(
    `INSERT INTO security_policies (${columns.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT (tenant_id, company_id, code)
     DO UPDATE SET ${updates.join(', ')}
     RETURNING *`,
    params
  );

  await logAudit(client, ctx, {
    action: 'update',
    resource: 'organisation.settings.security.policy',
    recordId: Number(res.rows[0].id),
    recordCode: code,
    newValues: res.rows[0],
    metadata: { enforced: true },
  });
  return toCamelRow(res.rows[0]);
}

/** Keep the existing policy code when the screen does not resend one. */
async function resolvePolicyCode(
  client: pg.PoolClient,
  tenantId: number | null,
  companyId: number
): Promise<string> {
  const res = await client.query(
    `SELECT code FROM security_policies
      WHERE tenant_id = $1 AND company_id = $2 ORDER BY id DESC LIMIT 1`,
    [tenantId, companyId]
  );
  return res.rows.length > 0 ? String(res.rows[0].code) : DEFAULT_POLICY_CODE;
}

// ===================== Segregation of duties =====================

export async function listSodRules(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM sod_rules WHERE tenant_id = $1 ORDER BY code`,
    [ctx.tenantId ?? null]
  );
  return toCamelRows(res.rows);
}

export async function createSodRule(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const res = await client.query(
    `INSERT INTO sod_rules
        (tenant_id, code, name, description, primary_permission, conflicting_permission, enforcement, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      ctx.tenantId ?? null,
      text(body.code, 'code', true),
      text(body.name, 'name', true),
      text(body.description, 'description'),
      text(body.primary_permission ?? body.primaryPermission, 'primary_permission', true),
      text(body.conflicting_permission ?? body.conflictingPermission, 'conflicting_permission', true),
      text(body.enforcement, 'enforcement') ?? 'hard',
      bool(body.is_active ?? body.isActive, true),
    ]
  );
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'organisation.settings.security.sod_rule',
    recordId: Number(res.rows[0].id),
    recordCode: String(res.rows[0].code),
    newValues: res.rows[0],
  });
  return toCamelRow(res.rows[0]);
}

export async function updateSodRule(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const before = await requireRow(client, 'sod_rules', ctx, id);
  const res = await client.query(
    `UPDATE sod_rules SET
        name = COALESCE($4, name),
        description = COALESCE($5, description),
        primary_permission = COALESCE($6, primary_permission),
        conflicting_permission = COALESCE($7, conflicting_permission),
        enforcement = COALESCE($8, enforcement),
        is_active = COALESCE($9, is_active)
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [
      id, ctx.tenantId ?? null,
      text(body.name, 'name'),
      text(body.description, 'description'),
      text(body.primary_permission ?? body.primaryPermission, 'primary_permission'),
      text(body.conflicting_permission ?? body.conflictingPermission, 'conflicting_permission'),
      text(body.enforcement, 'enforcement'),
      body.is_active === undefined && body.isActive === undefined
        ? null : bool(body.is_active ?? body.isActive, true),
    ]
  );
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'organisation.settings.security.sod_rule',
    recordId: id,
    recordCode: String(res.rows[0].code),
    oldValues: before,
    newValues: res.rows[0],
  });
  return toCamelRow(res.rows[0]);
}

export async function deleteSodRule(client: pg.PoolClient, ctx: Ctx, id: number) {
  const before = await requireRow(client, 'sod_rules', ctx, id);
  await client.query('DELETE FROM sod_rules WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId ?? null]);
  await logAudit(client, ctx, {
    action: 'delete',
    resource: 'organisation.settings.security.sod_rule',
    recordId: id,
    recordCode: String(before.code),
    oldValues: before,
  });
  return { id, deleted: true };
}

// ===================== IP restrictions =====================

const IP_POLICIES = ['ALLOW_ALL', 'ALLOWLIST_ONLY', 'DENYLIST', 'RESTRICTED_NETWORK'] as const;

export async function listIpRules(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM ip_rules WHERE tenant_id = $1 ORDER BY code`,
    [ctx.tenantId ?? null]
  );
  return toCamelRows(res.rows);
}

export async function createIpRule(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const policy = text(body.policy, 'policy', true) as string;
  if (!(IP_POLICIES as readonly string[]).includes(policy)) {
    throw badRequest('policy must be one of: ' + IP_POLICIES.join(', '));
  }
  const res = await client.query(
    `INSERT INTO ip_rules (tenant_id, code, name, policy, target, entries, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      ctx.tenantId ?? null,
      text(body.code, 'code', true),
      text(body.name, 'name', true),
      policy,
      text(body.target, 'target') ?? 'API',
      JSON.stringify(parseAddressList(body.entries ?? body.addresses)),
      bool(body.is_active ?? body.isActive, true),
    ]
  );
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'organisation.settings.security.ip_rule',
    recordId: Number(res.rows[0].id),
    recordCode: String(res.rows[0].code),
    newValues: res.rows[0],
  });
  return toCamelRow(res.rows[0]);
}

export async function updateIpRule(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const before = await requireRow(client, 'ip_rules', ctx, id);
  const policy = text(body.policy, 'policy');
  if (policy !== null && !(IP_POLICIES as readonly string[]).includes(policy)) {
    throw badRequest('policy must be one of: ' + IP_POLICIES.join(', '));
  }
  const entries =
    body.entries === undefined && body.addresses === undefined
      ? null
      : JSON.stringify(parseAddressList(body.entries ?? body.addresses));
  const res = await client.query(
    `UPDATE ip_rules SET
        name = COALESCE($3, name),
        policy = COALESCE($4, policy),
        target = COALESCE($5, target),
        entries = COALESCE($6::jsonb, entries),
        is_active = COALESCE($7, is_active),
        updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [
      id, ctx.tenantId ?? null,
      text(body.name, 'name'),
      policy,
      text(body.target, 'target'),
      entries,
      body.is_active === undefined && body.isActive === undefined
        ? null : bool(body.is_active ?? body.isActive, true),
    ]
  );
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'organisation.settings.security.ip_rule',
    recordId: id,
    recordCode: String(res.rows[0].code),
    oldValues: before,
    newValues: res.rows[0],
  });
  return toCamelRow(res.rows[0]);
}

export async function deleteIpRule(client: pg.PoolClient, ctx: Ctx, id: number) {
  const before = await requireRow(client, 'ip_rules', ctx, id);
  await client.query('DELETE FROM ip_rules WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId ?? null]);
  await logAudit(client, ctx, {
    action: 'delete',
    resource: 'organisation.settings.security.ip_rule',
    recordId: id,
    recordCode: String(before.code),
    oldValues: before,
  });
  return { id, deleted: true };
}

async function requireRow(
  client: pg.PoolClient,
  table: string,
  ctx: Ctx,
  id: number
): Promise<Record<string, unknown>> {
  const res = await client.query(
    `SELECT * FROM ${table} WHERE id = $1 AND tenant_id = $2`,
    [id, ctx.tenantId ?? null]
  );
  if (res.rows.length === 0) throw notFound('No such record: ' + id);
  return res.rows[0] as Record<string, unknown>;
}
