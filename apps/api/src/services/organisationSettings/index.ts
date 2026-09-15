import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, forbidden, toCamelRows } from '../../utils.js';
import {
  ORG_DANGEROUS_KEYS,
  ORG_CATEGORIES,
  ORG_CATEGORY_BY_ID,
  ORG_GROUPS,
  ORG_IMMUTABLE_KEYS,
  ORG_MANAGE_PERMISSIONS,
  ORG_VIEW_PERMISSION,
  OrgCategory,
  OrgCategoryKind,
  categoryFields,
  storageCategory,
} from './catalogue.js';
import {
  CategoryValuesView,
  loadCategoryValues,
  readSecret,
  saveCategoryValues,
} from './settings.js';
import {
  STRUCTURE_ENTITY_IDS,
  listEntities,
  structureCatalogue,
  structureCounts,
  structureTree,
} from './structure.js';
import { listTaxCategories, listTaxRates } from './tax.js';
import { securityOverview, saveSecurityPolicy } from './security.js';
import { listWorkflows } from './approvals.js';
import { listIntegrations } from './integrations.js';
import { retentionOverview } from './retention.js';
import { fiscalOverview, listAccountingPeriods, listFiscalYears } from './fiscal.js';
import { listNumberingRules, listSequences } from './numbering.js';
import { SIGNATURE_STATUSES, signatureProfiles } from './signatures.js';

/**
 * Organisation Settings - the control plane.
 *
 * One entry point, loadCategory(), and one save path, saveCategory(), so the
 * router above does not have to know that "Tax" is a versioned vocabulary
 * while "Security" is a single policy row and "Integrations" is a registry
 * with encrypted credentials. Each category declares its kind in the
 * catalogue, and this file is the only place that maps kind to implementation.
 *
 * Adding a category is therefore: a catalogue entry, and a case here.
 */

export * from './catalogue.js';

export interface CategoryView {
  category: OrgCategory;
  kind: OrgCategoryKind;
  /** Scalar settings, for kind 'settings'. Secrets appear as booleans only. */
  values?: Record<string, unknown>;
  secrets?: Record<string, boolean>;
  /** Rows, for the categories that are lists rather than forms. */
  list?: unknown[];
  /** Summary rolled up for the category header. */
  overview?: Record<string, unknown> | null;
  readOnly?: boolean;
}

/**
 * Identity fields that also live on the companies row. Keeping them in step is
 * what makes "change a setting and the module picks it up immediately" true
 * without a deployment (AC-ORG-012): a document renderer that reads
 * companies.legal_name and one that reads app_settings sees the same value.
 */
const PROFILE_MIRROR: ReadonlyArray<readonly [string, string]> = [
  ['legal_name', 'legal_name'],
  ['trading_name', 'name'],
  ['tin', 'tin'],
  ['vrn', 'vrn'],
  ['currency', 'currency'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['website', 'website'],
  ['physical_address', 'address'],
  ['org_type', 'org_type'],
  ['specialty', 'specialty'],
];

/** Categories that carry a settings form on top of their structured view. */
const HYBRID_PANELS: ReadonlySet<string> = new Set(['fiscal', 'numbering', 'backup']);

/**
 * The catalogue as the UI consumes it: the settings categories in declared
 * order, with the seven structure categories spliced in directly after the
 * profile so the navigation reads Organisation Profile, Companies, Branches,
 * ... Cost Centres, Fiscal Settings, as the specification lays it out.
 *
 * orgCategories() is the single list. Anything that needs "every category"
 * must call it rather than concatenating the two sources itself - that is what
 * produced a duplicate id the last time round.
 */
export function orgCategories(): OrgCategory[] {
  const structure = structureCatalogue();
  const all: OrgCategory[] = [];
  for (const category of ORG_CATEGORIES) {
    all.push(category);
    if (category.id === 'profile') all.push(...structure);
  }
  return all;
}

export function catalogueIndex() {
  return {
    groups: ORG_GROUPS,
    categories: orgCategories(),
    viewPermission: ORG_VIEW_PERMISSION,
    managePermissions: ORG_MANAGE_PERMISSIONS,
    // Published so the screen can render an invariant read-only and demand a
    // typed confirmation before a save that touches a dangerous key. The API
    // enforces both on its own; this only spares the user from learning the
    // rule by being refused.
    immutableKeys: Array.from(ORG_IMMUTABLE_KEYS),
    dangerousKeys: Array.from(ORG_DANGEROUS_KEYS),
  };
}

export function getCategory(id: string): OrgCategory {
  const direct = ORG_CATEGORY_BY_ID.get(id);
  if (direct) return direct;
  const structural = structureCatalogue().find((c) => c.id === id);
  if (structural) return structural;
  throw badRequest('Unknown organisation settings category: ' + id);
}

export function isStructureCategory(id: string): boolean {
  return (STRUCTURE_ENTITY_IDS as readonly string[]).includes(id);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function loadCategory(
  client: pg.PoolClient,
  ctx: Ctx,
  categoryId: string
): Promise<CategoryView> {
  const category = getCategory(categoryId);

  switch (category.kind) {
    case 'settings': {
      const view: CategoryValuesView = await loadCategoryValues(client, ctx, category);
      return {
        category,
        kind: category.kind,
        values: view.values,
        secrets: view.secrets,
        overview: HYBRID_PANELS.has(category.id)
          ? await hybridPanel(client, ctx, category.id)
          : null,
      };
    }

    case 'structure': {
      // The structure categories are lists; their CRUD lives in structure.ts so
      // that the lifecycle transitions stay in one place.
      const entities = await structureEntities(client, ctx, category.id);
      return {
        category,
        kind: category.kind,
        list: entities.rows,
        overview: { entity: entities.entity, label: entities.label },
      };
    }

    case 'tax':
      return {
        category,
        kind: category.kind,
        list: (await listTaxCategories(client, ctx)).rows,
        overview: { rates: (await listTaxRates(client, ctx)).rows.length },
      };

    case 'security_policy':
      return { category, kind: category.kind, overview: await securityOverview(client, ctx) };

    case 'approvals':
      return { category, kind: category.kind, list: await listWorkflows(client, ctx) };

    case 'signatures':
      return {
        category,
        kind: category.kind,
        list: await signatureProfiles.list(client, ctx, {}),
        overview: { statuses: SIGNATURE_STATUSES },
      };

    case 'integrations':
      return { category, kind: category.kind, list: await listIntegrations(client, ctx) };

    case 'retention':
      return { category, kind: category.kind, overview: await retentionOverview(client, ctx) };

    case 'audit':
      return {
        category,
        kind: category.kind,
        list: await settingsAuditTrail(client, ctx, { limit: 200 }),
        readOnly: true,
      };

    default:
      throw badRequest('Unsupported category kind: ' + String(category.kind));
  }
}

/**
 * Structure categories list rows rather than holding values. structure.ts
 * already validates the entity id, so there is nothing to re-check here.
 */
async function structureEntities(client: pg.PoolClient, ctx: Ctx, entityId: string) {
  return listEntities(client, ctx, entityId, {});
}

/** Supplementary structured data for the settings-shaped hybrid categories. */
async function hybridPanel(client: pg.PoolClient, ctx: Ctx, categoryId: string) {
  switch (categoryId) {
    case 'fiscal':
      return (await fiscalOverview(client, ctx)) as unknown as Record<string, unknown>;
    case 'numbering': {
      const rules = await listNumberingRules(client, ctx, {});
      const sequences = await listSequences(client, ctx, 50);
      return { rules, sequences, ruleCount: rules.length };
    }
    case 'backup':
      return (await retentionOverview(client, ctx)) as unknown as Record<string, unknown>;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface SaveOptions {
  /** Free-text justification, stored on every audit row this save produces. */
  reason?: string | null;
}

export async function saveCategory(
  client: pg.PoolClient,
  ctx: Ctx,
  categoryId: string,
  body: Record<string, unknown>,
  opts: SaveOptions = {}
): Promise<CategoryView | Record<string, unknown>> {
  const category = getCategory(categoryId);
  const reason =
    opts.reason != null && String(opts.reason).trim().length > 0 ? String(opts.reason).trim() : null;
  // The screen collects one justification for the whole save, but the writers do not all
  // look for it in the same place: the settings writers take it as an option, while the
  // record-shaped writers (tax, approvals) read it off the payload. Put it where each of
  // them looks, so the reason reaches the audit row either way (spec section 23).
  if (reason !== null && category.kind !== 'settings' && body.reason == null) {
    body.reason = reason;
  }

  switch (category.kind) {
    case 'settings': {
      const view = await saveCategoryValues(client, ctx, category, body, {
        resource: 'organisation.settings.' + category.id,
        reason,
        mirror: category.id === 'profile' ? PROFILE_MIRROR : undefined,
      });
      return {
        category,
        kind: category.kind,
        values: view.values,
        secrets: view.secrets,
        overview: HYBRID_PANELS.has(category.id)
          ? await hybridPanel(client, ctx, category.id)
          : null,
      };
    }

    case 'security_policy':
      return saveSecurityPolicy(client, ctx, body);

    case 'integrations': {
      const { saveIntegration } = await import('./integrations.js');
      const code = body.code;
      if (code == null || String(code).trim() === '') {
        throw badRequest('An integration code is required to save integration settings');
      }
      return saveIntegration(client, ctx, String(code), body);
    }

    case 'retention': {
      const { upsertBackupPolicy, upsertRetentionPolicy } = await import('./retention.js');
      const policyType = String(body.policyType ?? 'RETENTION').toUpperCase();
      if (policyType === 'BACKUP') return upsertBackupPolicy(client, ctx, body);
      if (policyType === 'RETENTION') return upsertRetentionPolicy(client, ctx, body);
      throw badRequest('policyType must be RETENTION or BACKUP');
    }

    case 'structure':
      throw badRequest(
        'Organisation structure is managed through its lifecycle endpoints (create, activate, ' +
        'deactivate, archive, restore), not through the settings save'
      );

    case 'tax': {
      const { createTaxCategory, createTaxRateRevision } = await import('./tax.js');
      if (body.rate != null || body.taxCode != null) return createTaxRateRevision(client, ctx, body);
      return createTaxCategory(client, ctx, body);
    }

    case 'approvals': {
      const { createWorkflow, createLevel, createFallbackRule } = await import('./approvals.js');
      const what = String(body.create ?? 'workflow');
      if (what === 'level') return createLevel(client, ctx, body);
      if (what === 'fallback') return createFallbackRule(client, ctx, body);
      return createWorkflow(client, ctx, body);
    }

    case 'signatures':
      return signatureProfiles.create(client, ctx, body);

    case 'audit':
      throw forbidden(
        'The audit trail is append-only. It is written by the actions it records and cannot be ' +
        'edited from Organisation Settings.'
      );

    default:
      throw badRequest('Unsupported category kind: ' + String(category.kind));
  }
}

/** Read a secret back for a caller that legitimately needs it (outbound request). */
export function readCategorySecret(
  client: pg.PoolClient,
  ctx: Ctx,
  categoryId: string,
  key: string
) {
  const category = getCategory(categoryId);
  return readSecret(client, ctx, category.id, key);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: number | string;
  at: string | null;
  actor: string | null;
  action: string;
  key: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  ip: string | null;
}

/**
 * Change history for one category, or for one field inside it.
 *
 * Two sources are merged because they answer different questions. audit_logs
 * says who touched the category and why. configuration_history says what each
 * individual field used to hold. A settings screen wants both: the narrative,
 * and the before/after per key (spec section 23).
 */
export async function categoryHistory(
  client: pg.PoolClient,
  ctx: Ctx,
  categoryId: string,
  filter: { key?: string | null; limit?: number } = {}
): Promise<HistoryEntry[]> {
  const category = getCategory(categoryId);
  const limit = Math.min(Math.max(Number(filter.limit ?? 100) || 100, 1), 500);
  const storage = storageCategory(category.id);

  const changes = await client.query(
    `SELECT h.id, h.created_at, h.config_key, h.old_value, h.new_value, h.ip,
            h.user_id, COALESCE(u.first_name || ' ' || u.last_name, u.email) AS actor
       FROM configuration_history h
       LEFT JOIN users u ON u.id = h.user_id
      WHERE h.tenant_id = $1 AND h.category = $2
        AND ($3::text IS NULL OR h.config_key = $3)
      ORDER BY h.created_at DESC
      LIMIT $4`,
    [ctx.tenantId ?? null, storage, filter.key ?? null, limit]
  );

  const actions = await client.query(
    `SELECT a.id, a.created_at, a.action, a.record_code, a.old_values, a.new_values,
            a.ip, a.metadata,
            COALESCE(u.first_name || ' ' || u.last_name, u.email) AS actor
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = $1 AND a.resource LIKE $2
      ORDER BY a.created_at DESC
      LIMIT $3`,
    [ctx.tenantId ?? null, 'organisation.settings.' + category.id + '%', limit]
  );

  const merged: HistoryEntry[] = [
    ...changes.rows.map((r: Record<string, unknown>) => ({
      id: 'cfg-' + String(r.id),
      at: r.created_at == null ? null : String(r.created_at),
      actor: r.actor == null ? null : String(r.actor),
      action: 'set',
      key: r.config_key == null ? null : String(r.config_key),
      oldValue: r.old_value ?? null,
      newValue: r.new_value ?? null,
      reason: null,
      ip: r.ip == null ? null : String(r.ip),
    })),
    ...actions.rows.map((r: Record<string, unknown>) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      return {
        id: 'aud-' + String(r.id),
        at: r.created_at == null ? null : String(r.created_at),
        actor: r.actor == null ? null : String(r.actor),
        action: String(r.action ?? 'update'),
        key: r.record_code == null ? null : String(r.record_code),
        oldValue: r.old_values ?? null,
        newValue: r.new_values ?? null,
        reason: meta.reason == null ? null : String(meta.reason),
        ip: r.ip == null ? null : String(r.ip),
      };
    }),
  ];

  merged.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return merged.slice(0, limit);
}

/** The audit category: every settings change, whatever the category. */
export async function settingsAuditTrail(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { resource?: string | null; limit?: number } = {}
) {
  const limit = Math.min(Math.max(Number(opts.limit ?? 200) || 200, 1), 1000);
  const res = await client.query(
    `SELECT a.id, a.created_at, a.action, a.resource, a.record_id, a.record_code,
            a.old_values, a.new_values, a.ip, a.user_agent, a.correlation_id, a.metadata,
            COALESCE(u.first_name || ' ' || u.last_name, u.email) AS actor
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = $1
        AND a.resource LIKE $2
        AND ($3::text IS NULL OR a.resource = $3)
      ORDER BY a.created_at DESC
      LIMIT $4`,
    [
      ctx.tenantId ?? null,
      (opts.resource ?? 'organisation.settings') + '%',
      opts.resource ?? null,
      limit,
    ]
  );
  return toCamelRows(res.rows);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SettingSearchHit {
  categoryId: string;
  categoryLabel: string;
  group: string;
  key: string | null;
  label: string;
  kind: OrgCategoryKind;
}

/**
 * Substring search across category names, field labels and field keys.
 *
 * Deliberately in-process: the whole catalogue is a constant, so searching it
 * costs nothing and needs no round trip, and it stays correct when a category
 * adds a field.
 */
export function searchSettings(query: string, limit = 40): SettingSearchHit[] {
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length === 0) return [];
  const hits: SettingSearchHit[] = [];
  const all = orgCategories();

  for (const category of all) {
    if (
      category.id.includes(q) ||
      category.label.toLowerCase().includes(q) ||
      category.blurb.toLowerCase().includes(q)
    ) {
      hits.push({
        categoryId: category.id,
        categoryLabel: category.label,
        group: category.group,
        key: null,
        label: category.label,
        kind: category.kind,
      });
    }
    for (const [key, def] of Object.entries(categoryFields(category.id))) {
      if (key.includes(q) || def.label.toLowerCase().includes(q)) {
        hits.push({
          categoryId: category.id,
          categoryLabel: category.label,
          group: category.group,
          key,
          label: def.label,
          kind: category.kind,
        });
      }
    }
    if (hits.length >= limit * 3) break;
  }
  return hits.slice(0, limit);
}

/** Counts per category, for the navigation badges. */
export async function structureSummary(client: pg.PoolClient, ctx: Ctx) {
  return {
    counts: await structureCounts(client, ctx),
    tree: await structureTree(client, ctx),
    fiscalYears: (await listFiscalYears(client, ctx)).length,
    periods: (await listAccountingPeriods(client, ctx)).length,
  };
}
