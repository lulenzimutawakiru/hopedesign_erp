import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest } from '../../utils.js';
import { auditConfig, encryptSecret, decryptSecret, upsertAppSetting } from '../companyConfig.js';
import {
  OrgCategory,
  OrgSettingDef,
  categoryFields,
  defaultFor,
  isImmutableKey,
  secretFieldKeys,
  storageCategory,
} from './catalogue.js';

/**
 * Values an administrator sees, plus which secrets exist.
 *
 * Secrets are never returned by value. A settings screen has no business
 * knowing a password; it only needs to know whether one is set, so that a
 * blank field means "leave it alone" rather than "erase it".
 */
export interface CategoryValuesView {
  values: Record<string, unknown>;
  /** secret key -> true when a value is stored for it. */
  secrets: Record<string, boolean>;
}

/** Fields whose value is compared against options/min/max before it is stored. */
function coerce(def: OrgSettingDef, key: string, raw: unknown): unknown {
  switch (def.type) {
    case 'boolean': {
      if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
      if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false;
      throw badRequest(`${key} must be true or false`);
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw badRequest(`${key} must be a number`);
      if (def.min !== undefined && n < def.min) throw badRequest(`${key} must be at least ${def.min}`);
      if (def.max !== undefined && n > def.max) throw badRequest(`${key} must be at most ${def.max}`);
      return n;
    }
    case 'select': {
      const v = String(raw ?? '').trim();
      if (v === '' && def.default === undefined) return null;
      if (!def.options || !def.options.includes(v)) {
        throw badRequest(`${key} must be one of: ${(def.options ?? []).join(', ')}`);
      }
      return v;
    }
    case 'email': {
      const v = String(raw ?? '').trim();
      if (v === '') return null;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw badRequest(`${key} must be an email address`);
      return v;
    }
    case 'url': {
      const v = String(raw ?? '').trim();
      if (v === '') return null;
      if (!/^https?:\/\//i.test(v)) throw badRequest(`${key} must be an http(s) URL`);
      return v;
    }
    case 'date': {
      const v = String(raw ?? '').trim();
      if (v === '') return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest(`${key} must be a YYYY-MM-DD date`);
      return v;
    }
    default: {
      const v = String(raw ?? '');
      if (def.type === 'text' && v === '') return null;
      return v;
    }
  }
}

/**
 * Validate a patch against the catalogue for one category.
 *
 * Anything not in the catalogue is refused rather than ignored: a typo in a
 * field name would otherwise succeed silently and look like a saved change.
 */
export function validatePatch(
  cat: OrgCategory,
  patch: Record<string, unknown>,
  current: Record<string, unknown>
): Array<{ key: string; value: unknown }> {
  const fields = categoryFields(cat.id);
  const out: Array<{ key: string; value: unknown }> = [];
  for (const [key, raw] of Object.entries(patch)) {
    const def = fields[key];
    if (!def) throw badRequest(`${cat.id} has no setting named ${key}`);
    if (def.secret === true) continue; // handled by the secret writer
    if (isImmutableKey(key)) {
      const next = coerce(def, key, raw);
      if (next !== current[key] && next !== false) {
        throw badRequest(`${key} is a fixed invariant of the ERP and cannot be changed`);
      }
      continue;
    }
    out.push({ key, value: coerce(def, key, raw) });
  }
  return out;
}

/** Merge platform defaults with the stored company overrides. */
export async function loadCategoryValues(
  client: pg.PoolClient,
  ctx: Ctx,
  cat: OrgCategory
): Promise<CategoryValuesView> {
  const category = storageCategory(cat.id);
  const fields = categoryFields(cat.id);
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (fields[key].secret === true) continue;
    const dflt = defaultFor(cat.id, key);
    if (dflt !== undefined) values[key] = dflt;
  }
  const res = await client.query(
    `SELECT key, value, is_secret FROM app_settings
      WHERE tenant_id = $1 AND category = $2
        AND (company_id = $3 OR company_id IS NULL)
      ORDER BY (company_id IS NOT NULL) DESC`,
    [ctx.tenantId ?? null, category, ctx.companyId ?? null]
  );
  const secrets: Record<string, boolean> = {};
  for (const key of secretFieldKeys(cat.id)) secrets[key] = false;
  for (const row of res.rows) {
    if (!(row.key in fields)) continue;
    if (row.is_secret || fields[row.key].secret === true) {
      secrets[row.key] = row.value !== null && row.value !== undefined && String(row.value).length > 0;
      continue;
    }
    values[row.key] = row.value;
  }
  return { values, secrets };
}

export interface SaveValuesOptions {
  resource?: string;
  /** Free-text justification copied onto every audit row this save produces. */
  reason?: string | null;
  /** Identity fields that are mirrored onto the companies row. */
  mirror?: ReadonlyArray<readonly [settingKey: string, column: string]>;
}

/**
 * Persist a validated patch. Every key goes through upsertAppSetting, which
 * writes configuration_history and an audit entry, so AC-ORG-004 holds for
 * every field rather than only for whole-category saves.
 */
export async function saveCategoryValues(
  client: pg.PoolClient,
  ctx: Ctx,
  cat: OrgCategory,
  body: Record<string, unknown>,
  opts: SaveValuesOptions = {}
): Promise<CategoryValuesView> {
  const before = await loadCategoryValues(client, ctx, cat);
  const rawValues = (body.values ?? body) as Record<string, unknown>;
  const patch = validatePatch(cat, rawValues, before.values);

  for (const { key, value } of patch) {
    await upsertAppSetting(client, ctx, storageCategory(cat.id), key, value, {
      resource: opts.resource ?? `organisation.settings.${cat.id}`,
      reason: opts.reason,
    });
  }

  // Secrets: present-and-non-empty writes, an explicit clearSecrets entry
  // erases. Absent means untouched, so a screen that never received the value
  // cannot blank it by omission.
  const clear = new Set(
    (Array.isArray(body.clearSecrets) ? body.clearSecrets : []).map((s) => String(s))
  );
  for (const key of secretFieldKeys(cat.id)) {
    const typed = rawValues[key];
    const wantsWrite = typed !== undefined && typed !== null && String(typed).length > 0;
    const wantsClear = clear.has(key);
    if (!wantsWrite && !wantsClear) continue;
    if (wantsClear) {
      await client.query(
        `DELETE FROM app_settings
          WHERE tenant_id = $1 AND company_id = $2 AND category = $3 AND key = $4`,
        [ctx.tenantId ?? null, ctx.companyId ?? null, storageCategory(cat.id), key]
      );
      await auditConfig(client, ctx, 'delete', `organisation.settings.${cat.id}`, null,
        { [key]: '(set)' }, { [key]: null },
        { secret: true, ...(opts.reason ? { reason: opts.reason } : {}) });
      continue;
    }
    await upsertAppSetting(client, ctx, storageCategory(cat.id), key, encryptSecret(String(typed)), {
      secret: true,
      resource: `organisation.settings.${cat.id}`,
      reason: opts.reason,
    });
  }

  if (opts.mirror && opts.mirror.length > 0) {
    await mirrorToCompany(client, ctx, patch, opts.mirror);
  }

  return loadCategoryValues(client, ctx, cat);
}

/**
 * Push the identity fields onto the companies row.
 *
 * The profile screen is the organisation's description of itself; the
 * companies row is what the rest of the ERP reads (document numbering reads
 * fiscal_year_start from it, invoices read currency). Writing both is what
 * makes AC-ORG-012 true - a change here takes effect without a deployment.
 */
async function mirrorToCompany(
  client: pg.PoolClient,
  ctx: Ctx,
  patch: Array<{ key: string; value: unknown }>,
  mirror: ReadonlyArray<readonly [settingKey: string, column: string]>
): Promise<void> {
  if (ctx.companyId == null) return;
  const byKey = new Map(patch.map((p) => [p.key, p.value]));
  const assignments: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of mirror) {
    if (!byKey.has(key)) continue;
    params.push(byKey.get(key));
    assignments.push(`${column} = $${params.length}`);
  }
  if (assignments.length === 0) return;
  params.push(ctx.companyId, ctx.tenantId ?? null);
  await client.query(
    `UPDATE companies SET ${assignments.join(', ')}
      WHERE id = $${params.length - 1} AND tenant_id = $${params.length}`,
    params
  );
}

/** Read a stored secret in decrypted form. Only integrations may call this. */
export async function readSecret(
  client: pg.PoolClient,
  ctx: Ctx,
  categoryId: string,
  key: string
): Promise<string | null> {
  const res = await client.query(
    `SELECT value FROM app_settings
      WHERE tenant_id = $1 AND company_id = $2 AND category = $3 AND key = $4`,
    [ctx.tenantId ?? null, ctx.companyId ?? null, storageCategory(categoryId), key]
  );
  if (res.rows.length === 0) return null;
  return decryptSecret(res.rows[0].value);
}
