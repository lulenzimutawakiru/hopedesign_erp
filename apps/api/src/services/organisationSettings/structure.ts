import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, conflict, notFound } from '../../utils.js';
import { toCamelRow, toCamelRows } from '../../utils.js';
import { logAudit } from '../audit.js';
import { ORG_STRUCTURE_PERMISSION, OrgCategory } from './catalogue.js';

/**
 * Organisation structure: the entities the rest of the ERP hangs off.
 *
 * Every other settings category writes a value; this one writes *records*, and
 * those records are what company/branch/department scoping is enforced
 * against. That is why it lives in code rather than behind a generic setting:
 * a branch is not a setting, it is the boundary a permission check reads.
 *
 * Seven entities share one shape (code, name, status, tenant, company, often a
 * branch parent), so they share one implementation. The alternative - seven
 * near-identical services - is how the seven drift apart.
 */

export type FieldKind = 'text' | 'number' | 'boolean' | 'json';
export type StructureStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

export interface StructureEntityDef {
  id: string;
  table: string;
  label: string;
  /** Writable columns. Anything absent here is not editable through settings. */
  fields: Record<string, FieldKind>;
  required: readonly string[];
  /** Closed vocabularies, validated before the database sees them. */
  enumerations?: Record<string, readonly string[]>;
  /** Rows carry company_id. False only for the company row itself. */
  companyScoped: boolean;
  /** Rows may carry branch_id, and the list can be filtered by it. */
  branchScoped: boolean;
  /** The company row itself rather than a child of one. */
  root?: boolean;
  /** One line for the settings navigation, matching OrgCategory.blurb. */
  blurb: string;
}

/**
 * A structure entity presented as a settings category.
 *
 * It is a superset of OrgCategory: the extra fields are what the generic
 * settings screen cannot know about a table (which columns are writable, what
 * the closed vocabularies are, how wide a scope the row carries). One entry
 * therefore serves both the navigation and the entity editor.
 */
export interface StructureCategory extends OrgCategory {
  root: boolean;
  companyScoped: boolean;
  branchScoped: boolean;
  required: string[];
  fields: Array<{ key: string; kind: FieldKind; options: string[] | null; required: boolean }>;
}

const LOCATION_TYPES = ['WORKPLACE', 'FACTORY', 'WAREHOUSE', 'SITE', 'FIELD', 'REMOTE', 'RETAIL'] as const;
const WAREHOUSE_TYPES = [
  'RAW_MATERIAL', 'WIP', 'FINISHED_GOODS', 'SECURE', 'QUARANTINE',
  'DAMAGED', 'RETURNS', 'CONSUMABLES', 'SPARE_PARTS', 'PACKAGING', 'GENERAL',
] as const;

export const STRUCTURE_ENTITIES: Record<string, StructureEntityDef> = {
  companies: {
    id: 'companies',
    table: 'companies',
    label: 'Company',
    blurb: 'The legal entity itself - registration, tax identifiers and the default currency every document falls back to.',
    companyScoped: false,
    branchScoped: false,
    root: true,
    // org_type is deliberately absent: companies.org_type is a module-registry
    // column (CORPORATE|HOSPITAL|...) that means something different from the
    // profile screen's Organisation Type (LIMITED_COMPANY|...). Editing it from
    // here would silently change which vertical modules the tenant may enable.
    fields: {
      code: 'text', name: 'text', legal_name: 'text', tin: 'text', vrn: 'text',
      currency: 'text', address: 'text', phone: 'text', email: 'text',
      website: 'text', fiscal_year_start: 'text', specialty: 'text',
    },
    required: ['code', 'name'],
  },
  branches: {
    id: 'branches',
    table: 'branches',
    label: 'Branch',
    blurb: 'Operating sites. Disabling a branch stops new transactions being raised against it.',
    companyScoped: true,
    branchScoped: false,
    fields: {
      code: 'text', name: 'text', address: 'text', phone: 'text',
      email: 'text', manager_user_id: 'number',
    },
    required: ['code', 'name'],
  },
  departments: {
    id: 'departments',
    table: 'departments',
    label: 'Department',
    blurb: 'Reporting units inside a branch, used for scoping, approvals and document numbering.',
    companyScoped: true,
    branchScoped: true,
    fields: { code: 'text', name: 'text', branch_id: 'number', head_user_id: 'number' },
    required: ['code', 'name'],
  },
  divisions: {
    id: 'divisions',
    table: 'divisions',
    label: 'Division',
    blurb: 'Larger operating groupings that span departments, such as Production or Finance.',
    companyScoped: true,
    branchScoped: true,
    fields: {
      code: 'text', name: 'text', description: 'text',
      branch_id: 'number', head_user_id: 'number',
    },
    required: ['code', 'name'],
  },
  locations: {
    id: 'locations',
    table: 'locations',
    label: 'Location',
    blurb: 'Geographic and operational addresses. Premises latitude, longitude and radius are saved here. Attendance settings names which of these locations device clock-in uses.',
    companyScoped: true,
    branchScoped: true,
    fields: {
      code: 'text', name: 'text', type: 'text', address: 'text', city: 'text',
      country: 'text', timezone: 'text', branch_id: 'number',
      premises_latitude: 'number', premises_longitude: 'number', premises_radius_m: 'number',
    },
    required: ['code', 'name'],
    enumerations: { type: LOCATION_TYPES },
  },
  warehouses: {
    id: 'warehouses',
    table: 'warehouses',
    label: 'Warehouse',
    blurb: 'Stock-holding sites, including the raw-material and finished-goods stores.',
    companyScoped: true,
    branchScoped: true,
    fields: {
      code: 'text', name: 'text', type: 'text', address: 'text', branch_id: 'number',
      is_secure: 'boolean', capacity_qty: 'number', capacity_uom_id: 'number',
      temperature_controlled: 'boolean', is_rfid_enabled: 'boolean',
    },
    required: ['code', 'name'],
    enumerations: { type: WAREHOUSE_TYPES },
  },
  cost_centres: {
    id: 'cost_centres',
    table: 'cost_centres',
    label: 'Cost Centre',
    blurb: 'The codes financial postings and budgets are attributed to.',
    companyScoped: true,
    branchScoped: false,
    fields: { code: 'text', name: 'text', description: 'text' },
    required: ['code', 'name'],
  },
};

export const STRUCTURE_ENTITY_IDS = Object.keys(STRUCTURE_ENTITIES);

export function structureDef(entityId: string): StructureEntityDef {
  const d = STRUCTURE_ENTITIES[entityId];
  if (!d) throw notFound('Unknown organisation structure entity: ' + entityId);
  return d;
}

/** Present the catalogue of entities and their editable fields to the UI. */
export function structureCatalogue(): StructureCategory[] {
  return STRUCTURE_ENTITY_IDS.map((id) => {
    const d = STRUCTURE_ENTITIES[id];
    return {
      id: d.id,
      label: d.label,
      group: 'Organisation',
      blurb: d.blurb,
      kind: 'structure' as const,
      manage: ORG_STRUCTURE_PERMISSION,
      root: d.root === true,
      companyScoped: d.companyScoped,
      branchScoped: d.branchScoped,
      required: [...d.required],
      fields: Object.entries(d.fields).map(([key, kind]) => ({
        key,
        kind,
        options: d.enumerations?.[key] ? [...(d.enumerations[key] as readonly string[])] : null,
        required: d.required.includes(key),
      })),
    };
  });
}

function requireCompany(ctx: Ctx): number {
  if (ctx.companyId == null) {
    throw badRequest('An active company context is required to manage the organisation structure');
  }
  return Number(ctx.companyId);
}

type Row = Record<string, unknown>;

/**
 * Tenant/company/branch predicate for one structural table.
 *
 * This is the SQL half of AC-ORG-011: a settings administrator sees and edits
 * only the slice of the organisation they belong to. companies is the tenant
 * root and has no company_id, so its own scope is the company they are in -
 * without that, a branch manager could rename the whole group.
 */
function scopeConds(d: StructureEntityDef, ctx: Ctx, alias: string, params: unknown[]): string[] {
  const conds: string[] = [];
  if (ctx.tenantId != null) {
    params.push(ctx.tenantId);
    conds.push(`${alias}.tenant_id = $${params.length}`);
  }
  if (d.root) {
    if (ctx.companyId != null) {
      params.push(ctx.companyId);
      conds.push(`${alias}.id = $${params.length}`);
    }
    return conds;
  }
  if (ctx.companyId != null) {
    params.push(ctx.companyId);
    conds.push(`${alias}.company_id = $${params.length}`);
  }
  if (ctx.branchId != null && d.branchScoped) {
    params.push(ctx.branchId);
    conds.push(`${alias}.branch_id = $${params.length}`);
  }
  return conds;
}

function coerceField(d: StructureEntityDef, key: string, raw: unknown): unknown {
  const kind = d.fields[key];
  if (raw === null || raw === undefined) return null;
  if (kind === 'number') {
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw badRequest(`${d.id}.${key} must be a number`);
    return n;
  }
  if (kind === 'boolean') {
    if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
    if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false;
    throw badRequest(`${d.id}.${key} must be true or false`);
  }
  if (kind === 'json') {
    if (typeof raw === 'string') {
      if (raw.trim() === '') return {};
      try {
        return JSON.parse(raw);
      } catch {
        throw badRequest(`${d.id}.${key} must be valid JSON`);
      }
    }
    if (typeof raw !== 'object') throw badRequest(`${d.id}.${key} must be an object`);
    return raw;
  }
  const v = String(raw).trim();
  if (v === '') return null;
  const allowed = d.enumerations?.[key];
  if (allowed && !allowed.includes(v)) {
    throw badRequest(`${d.id}.${key} must be one of: ${allowed.join(', ')}`);
  }
  return v;
}

/** Validate a body into column/value pairs. Unknown keys are refused, not ignored. */
function collectFields(
  d: StructureEntityDef,
  body: Record<string, unknown>
): Array<{ column: string; value: unknown }> {
  const out: Array<{ column: string; value: unknown }> = [];
  for (const [key, raw] of Object.entries(body)) {
    if (key === 'reason' || key === 'status' || key === 'id') continue;
    if (!(key in d.fields)) throw badRequest(`${d.id} has no field named ${key}`);
    out.push({ column: key, value: coerceField(d, key, raw) });
  }
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

async function requireRow(
  client: pg.PoolClient,
  ctx: Ctx,
  d: StructureEntityDef,
  id: number
): Promise<Row> {
  const params: unknown[] = [id];
  const conds = ['t.id = $1', ...scopeConds(d, ctx, 't', params)];
  const { rows } = await client.query(
    `SELECT t.* FROM ${d.table} t WHERE ${conds.join(' AND ')}`,
    params
  );
  if (rows.length === 0) throw notFound(`${d.label} ${id} not found`);
  return rows[0] as Row;
}

export interface ListOptions {
  includeArchived?: boolean;
  status?: string | null;
  branchId?: number | null;
}

export async function listEntities(
  client: pg.PoolClient,
  ctx: Ctx,
  entityId: string,
  opts: ListOptions = {}
) {
  const d = structureDef(entityId);
  const params: unknown[] = [];
  const conds = scopeConds(d, ctx, 't', params);
  if (opts.status) {
    params.push(opts.status);
    conds.push(`t.status = $${params.length}`);
  } else if (!opts.includeArchived) {
    conds.push("t.status <> 'ARCHIVED'");
  }
  if (d.branchScoped && opts.branchId != null) {
    params.push(opts.branchId);
    conds.push(`t.branch_id = $${params.length}`);
  }
  const where = conds.length > 0 ? conds.join(' AND ') : '1=1';
  const { rows } = await client.query(
    `SELECT t.* FROM ${d.table} t WHERE ${where} ORDER BY t.code`,
    params
  );
  return { entity: d.id, label: d.label, rows: toCamelRows(rows) };
}

export async function getEntity(client: pg.PoolClient, ctx: Ctx, entityId: string, id: number) {
  const d = structureDef(entityId);
  return toCamelRow(await requireRow(client, ctx, d, id));
}

export async function createEntity(
  client: pg.PoolClient,
  ctx: Ctx,
  entityId: string,
  body: Record<string, unknown>
) {
  const d = structureDef(entityId);
  const provided = collectFields(d, body);
  const byColumn = new Map(provided.map((p) => [p.column, p.value]));
  for (const col of d.required) {
    const v = byColumn.get(col);
    if (v === null || v === undefined || v === '') {
      throw badRequest(`${d.label} requires ${col}`);
    }
  }

  const cols: string[] = ['tenant_id', 'status'];
  const vals: unknown[] = [ctx.tenantId ?? null, 'ACTIVE'];
  if (!d.root) {
    cols.push('company_id');
    vals.push(requireCompany(ctx));
  }
  for (const { column, value } of provided) {
    cols.push(column);
    vals.push(value);
  }
  const placeholders = cols.map((_, i) => `$${i + 1}`);

  let row: Row;
  try {
    const res = await client.query(
      `INSERT INTO ${d.table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      vals
    );
    row = res.rows[0] as Row;
  } catch (err) {
    // The per-company code unique index is the real defence; this turns the
    // database's constraint name into something an administrator can act on.
    if (isUniqueViolation(err)) throw conflict(`${d.label} code ${String(byColumn.get('code'))} already exists`);
    throw err;
  }

  await logAudit(client, ctx, {
    action: 'create',
    resource: `organisation.structure.${d.id}`,
    recordId: Number(row.id),
    recordCode: row.code as string,
    newValues: row,
    metadata: { entity: d.id },
  });
  return toCamelRow(row);
}

export async function updateEntity(
  client: pg.PoolClient,
  ctx: Ctx,
  entityId: string,
  id: number,
  body: Record<string, unknown>
) {
  const d = structureDef(entityId);
  const before = await requireRow(client, ctx, d, id);
  const provided = collectFields(d, body);
  if (provided.length === 0) throw badRequest('No changes supplied');

  const params: unknown[] = [];
  const sets: string[] = [];
  for (const { column, value } of provided) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  params.push(id);
  let row: Row;
  try {
    const res = await client.query(
      `UPDATE ${d.table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params
    );
    row = res.rows[0] as Row;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`${d.label} code already exists in this company`);
    throw err;
  }

  await logAudit(client, ctx, {
    action: 'update',
    resource: `organisation.structure.${d.id}`,
    recordId: id,
    recordCode: (row.code ?? before.code) as string,
    oldValues: before,
    newValues: row,
    metadata: { entity: d.id, fields: provided.map((p) => p.column) },
  });
  return toCamelRow(row);
}

export type LifecycleAction = 'activate' | 'deactivate' | 'archive' | 'restore';

/**
 * Where each action lands.
 *
 * restore returns the entity to INACTIVE rather than ACTIVE on purpose: bringing
 * something back from the archive and putting it straight into live use should
 * be two deliberate steps, not one.
 */
const ACTION_TARGET: Record<LifecycleAction, StructureStatus> = {
  activate: 'ACTIVE',
  deactivate: 'INACTIVE',
  archive: 'ARCHIVED',
  restore: 'INACTIVE',
};

/** Entities where retiring the last live row would break the ERP. */
const SINGLETON_GUARD: Record<string, boolean> = { companies: true, branches: true };

async function countLive(client: pg.PoolClient, ctx: Ctx, d: StructureEntityDef): Promise<number> {
  const params: unknown[] = [];
  const conds = scopeConds(d, ctx, 't', params);
  conds.push("t.status = 'ACTIVE'");
  const where = conds.length > 0 ? conds.join(' AND ') : '1=1';
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM ${d.table} t WHERE ${where}`,
    params
  );
  return Number(rows[0].n);
}

export async function setEntityStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  entityId: string,
  id: number,
  action: LifecycleAction,
  reason: string | null
) {
  const d = structureDef(entityId);
  if (!(action in ACTION_TARGET)) throw badRequest('Unknown lifecycle action: ' + action);
  const before = await requireRow(client, ctx, d, id);
  const current = String(before.status) as StructureStatus;
  const target = ACTION_TARGET[action];

  if (action === 'archive' && (reason === null || reason.trim() === '')) {
    throw badRequest('Archiving requires a reason');
  }
  if (current === 'ARCHIVED' && action !== 'restore') {
    throw conflict(`${d.label} ${String(before.code)} is archived; restore it first`);
  }
  if (current !== 'ARCHIVED' && action === 'restore') {
    throw conflict(`${d.label} ${String(before.code)} is not archived`);
  }
  if (current === target && action !== 'archive') {
    throw conflict(`${d.label} ${String(before.code)} is already ${current}`);
  }

  // TC-ORG-010 protection at the source: an organisation with no live company,
  // or a company with no live branch, cannot create anything at all, so refuse
  // the transition rather than let an administrator lock themselves out.
  if (SINGLETON_GUARD[d.id] === true && target !== 'ACTIVE' && current === 'ACTIVE') {
    const live = await countLive(client, ctx, d);
    if (live <= 1) {
      throw conflict(
        `${d.label} ${String(before.code)} is the last active ${d.label.toLowerCase()} and cannot be ${action}d`
      );
    }
  }

  const archiving = action === 'archive';
  const params: unknown[] = [];
  const sets: string[] = [];
  params.push(target);
  sets.push(`status = $${params.length}`);
  if (archiving) {
    sets.push('archived_at = now()');
    params.push(ctx.userId ?? null);
    sets.push(`archived_by = $${params.length}`);
  } else if (action === 'restore') {
    sets.push('archived_at = NULL', 'archived_by = NULL');
  }
  params.push(id);
  const { rows } = await client.query(
    `UPDATE ${d.table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );

  await logAudit(client, ctx, {
    action: 'lifecycle.' + action,
    resource: `organisation.structure.${d.id}`,
    recordId: id,
    recordCode: String(before.code),
    oldValues: { status: current },
    newValues: { status: target },
    metadata: { entity: d.id, reason: reason ?? null },
  });
  return toCamelRow(rows[0]);
}

/**
 * Guard for transactional modules: refuse to build a document against a
 * structural entity that is not live.
 *
 * This is the enforcement half of TC-ORG-010. Callers create invoices,
 * purchase orders, stock movements and payroll runs; each of those must resolve
 * its branch/warehouse through here before it writes, so disabling a branch
 * stops new transactions immediately rather than only hiding it from a picker.
 */
export async function assertEntityActive(
  client: pg.PoolClient,
  ctx: Ctx,
  entityId: string,
  id: number
): Promise<void> {
  const d = structureDef(entityId);
  const row = await requireRow(client, ctx, d, id);
  if (row.status !== 'ACTIVE') {
    throw conflict(
      `${d.label} ${String(row.code)} is ${String(row.status)} and cannot be used for new transactions`
    );
  }
}

export async function assertBranchActive(
  client: pg.PoolClient,
  ctx: Ctx,
  branchId: number
): Promise<void> {
  return assertEntityActive(client, ctx, 'branches', branchId);
}

export async function assertWarehouseActive(
  client: pg.PoolClient,
  ctx: Ctx,
  warehouseId: number
): Promise<void> {
  return assertEntityActive(client, ctx, 'warehouses', warehouseId);
}

/**
 * The structure tree for the settings overview.
 *
 * Company -> Branches -> (Departments, Divisions, Locations, Warehouses), with
 * cost centres held at company level. Archived rows are included and flagged so
 * the screen can show what has been retired without a second request; the
 * caller decides whether to render them.
 */
export async function structureTree(client: pg.PoolClient, ctx: Ctx) {
  const ids = ['companies', 'branches', 'departments', 'divisions', 'locations', 'warehouses', 'cost_centres'];
  const lists = await Promise.all(
    ids.map((id) => listEntities(client, ctx, id, { includeArchived: true }))
  );
  const byId = new Map(lists.map((l) => [l.entity, l.rows as Row[]]));

  // Annotated as Row[] so the parent id stays reachable after the spread;
  // TypeScript otherwise narrows the object to only the literal keys added here.
  const branches: Row[] = (byId.get('branches') ?? []).map((b) => ({
    ...toCamelRow(b),
    departments: (byId.get('departments') ?? []).filter((r) => r.branch_id === b.id).map(toCamelRow),
    divisions: (byId.get('divisions') ?? []).filter((r) => r.branch_id === b.id).map(toCamelRow),
    locations: (byId.get('locations') ?? []).filter((r) => r.branch_id === b.id).map(toCamelRow),
    warehouses: (byId.get('warehouses') ?? []).filter((r) => r.branch_id === b.id).map(toCamelRow),
  }));

  return {
    companies: (byId.get('companies') ?? []).map((c) => ({
      ...toCamelRow(c),
      costCentres: (byId.get('cost_centres') ?? []).filter((r) => r.company_id === c.id).map(toCamelRow),
      branches: branches.filter((b) => b.companyId === c.id),
    })),
    // Branches whose company row sits outside the caller's scope still surface
    // here rather than disappearing silently.
    unassignedBranches: branches.filter(
      (b) => !(byId.get('companies') ?? []).some((c) => c.id === b.companyId)
    ),
  };
}

export async function structureCounts(client: pg.PoolClient, ctx: Ctx) {
  const out: Record<string, { total: number; active: number; archived: number }> = {};
  for (const id of STRUCTURE_ENTITY_IDS) {
    const d = STRUCTURE_ENTITIES[id];
    const params: unknown[] = [];
    const conds = scopeConds(d, ctx, 't', params);
    const where = conds.length > 0 ? conds.join(' AND ') : '1=1';
    const { rows } = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE t.status = 'ACTIVE')::int AS active,
              count(*) FILTER (WHERE t.status = 'ARCHIVED')::int AS archived
         FROM ${d.table} t WHERE ${where}`,
      params
    );
    out[id] = {
      total: Number(rows[0].total),
      active: Number(rows[0].active),
      archived: Number(rows[0].archived),
    };
  }
  return out;
}
