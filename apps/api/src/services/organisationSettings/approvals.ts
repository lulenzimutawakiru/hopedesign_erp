import pg from 'pg';
import { Ctx } from '../../db.js';
import { ApprovalStep } from '../../types.js';
import { badRequest, conflict, notFound, toCamelRow, toCamelRows } from '../../utils.js';
import { logAudit } from '../audit.js';
import { ENTITIES } from '../entities.js';

/**
 * Approval workflow configuration — the LIVE engine.
 *
 * The declarative model (approval_workflows / approval_levels /
 * approval_fallback_rules) was deprecated in migration 0204. This module now
 * reads and writes the table the engine actually consults: `workflows`, whose
 * `config` JSONB holds the ordered approval steps. Levels became steps, and
 * temporary absence coverage is a first-class feature in services/governance.ts
 * (delegations + acting roles), so it is not reimplemented here.
 *
 * Editing a workflow here changes what startWorkflow (services/workflow.ts) will
 * do the next time a document of that entity type is submitted, because both
 * read the same `workflows` row.
 */

const UNIQUE_VIOLATION = '23505';

function pgCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

function requireCompany(ctx: Ctx): number {
  if (ctx.companyId == null) {
    throw badRequest('An active company context is required to configure approvals');
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

function date(v: unknown, field: string, required = false): string | null {
  const s = text(v, field, required);
  if (s === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest(field + ' must be a YYYY-MM-DD date');
  return s;
}

function money(v: unknown, field: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(field + ' must be a number');
  return n;
}

function bool(v: unknown, dflt: boolean): boolean {
  if (v === null || v === undefined || v === '') return dflt;
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  throw badRequest('Expected a boolean value');
}

function idOrNull(v: unknown, field: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(field + ' must be a record id');
  return n;
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

/** Human label for an entity_type key, e.g. `procurement.supplier_invoices` -> "Supplier Invoices". */
function entityLabel(type: string): string {
  const overrides: Record<string, string> = {
    'hr.payrolls': 'Payroll runs',
    'hr.final_settlements': 'Final settlements',
    'hr.requisitions': 'Job requisitions',
    'hr.workforce_plans': 'Workforce plans',
    'hr.contracts': 'Employment contracts',
    'security_printing.jobs': 'Security jobs',
    'ops.daily_closings': 'Daily cash closings',
    'ops.replenishments': 'Petty cash replenishments',
  };
  if (overrides[type]) return overrides[type];
  const resource = type.split('.').pop() ?? type;
  return resource
    .split('_')
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Convert a workflow `config` JSONB array to camel-case steps for the API. */
function toCamelSteps(config: unknown): Record<string, unknown>[] {
  if (!Array.isArray(config)) return [];
  return config.map((s) => {
    const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    return {
      seq: o.seq == null ? 0 : Number(o.seq),
      name: String(o.name ?? ''),
      approverRole: o.approver_role ?? null,
      approverRoles: o.approver_roles ?? null,
      approverUser: o.approver_user ?? null,
      amountMin: o.amount_min ?? null,
      amountMax: o.amount_max ?? null,
      slaHours: o.sla_hours ?? null,
      branchId: o.branch_id ?? null,
      departmentId: o.department_id ?? null,
      condition: o.condition ?? null,
    };
  });
}

/**
 * Validate a step array and normalise it to the snake_case `ApprovalStep` shape
 * the engine expects in `workflows.config`. Accepts camelCase or snake_case keys.
 */
function parseSteps(raw: unknown): ApprovalStep[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest('At least one approval step is required');
  }
  return raw.map((s, i) => {
    const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const role = text(o.approver_role ?? o.approverRole, `steps[${i}].approver_role`);
    const rolesRaw = o.approver_roles ?? o.approverRoles;
    const approverRoles = Array.isArray(rolesRaw)
      ? (rolesRaw as unknown[]).map((r) => text(r, 'approver_roles[]', true) as string)
      : undefined;
    const approverUser = idOrNull(o.approver_user ?? o.approverUser, 'approver_user');
    if (!role && !(approverRoles && approverRoles.length) && approverUser === null) {
      throw badRequest(`steps[${i}] needs an approver_role (or approver_roles or approver_user)`);
    }
    return {
      seq: int(o.seq ?? o.step, `steps[${i}].seq`, 1, 1000) ?? i + 1,
      name: text(o.name, `steps[${i}].name`, true) as string,
      approver_role: role ?? undefined,
      approver_roles: approverRoles,
      approver_user: approverUser ?? undefined,
      amount_min: money(o.amount_min ?? o.amountMin, 'amount_min') ?? undefined,
      amount_max: money(o.amount_max ?? o.amountMax, 'amount_max') ?? undefined,
      sla_hours: int(o.sla_hours ?? o.slaHours, 'sla_hours', 1, 8760) ?? undefined,
      branch_id: idOrNull(o.branch_id ?? o.branchId, 'branch_id') ?? undefined,
      department_id: idOrNull(o.department_id ?? o.departmentId, 'department_id') ?? undefined,
      condition: text(o.condition, 'condition') ?? undefined,
    };
  });
}

/** Fail closed on a step naming a role that does not exist for this company. */
async function assertRolesExist(
  client: pg.PoolClient,
  ctx: Ctx,
  steps: ApprovalStep[]
): Promise<void> {
  const res = await client.query('SELECT code FROM roles WHERE company_id = $1', [requireCompany(ctx)]);
  const known = new Set(res.rows.map((r) => String(r.code)));
  for (const step of steps) {
    const codes = step.approver_roles?.length
      ? step.approver_roles
      : step.approver_role
        ? [step.approver_role]
        : [];
    for (const code of codes) {
      if (!known.has(code)) {
        throw badRequest(`Approval step "${step.name}" references role "${code}" that does not exist for this company`);
      }
    }
  }
}

export async function listWorkflows(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name, entity_type, description, is_active, status, version,
            effective_from, updated_at,
            jsonb_array_length(config) AS step_count
       FROM workflows
      WHERE tenant_id = $1 AND company_id = $2
      ORDER BY entity_type`,
    [ctx.tenantId ?? null, requireCompany(ctx)]
  );
  return toCamelRows(res.rows);
}

export async function listApproverRoles(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    'SELECT id, code, name FROM roles WHERE company_id = $1 ORDER BY code',
    [requireCompany(ctx)]
  );
  return toCamelRows(res.rows);
}

/** Entity types the live engine can route, plus whether a workflow is already configured. */
export async function listWorkflowEntities(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    'SELECT entity_type FROM workflows WHERE tenant_id = $1 AND company_id = $2',
    [ctx.tenantId ?? null, requireCompany(ctx)]
  );
  const configured = new Set(res.rows.map((r) => String(r.entity_type)));
  return Object.keys(ENTITIES)
    .filter((type) => ENTITIES[type].requiresApproval !== false)
    .map((type) => ({ type, label: entityLabel(type), configured: configured.has(type) }));
}

export async function getWorkflow(client: pg.PoolClient, ctx: Ctx, id: number) {
  const w = await requireScoped(client, 'workflows', ctx, id);
  const { config, ...rest } = w;
  return { workflow: toCamelRow(rest), steps: toCamelSteps(config) };
}

export async function createWorkflow(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const entityType = text(body.entity_type ?? body.entityType, 'entity_type', true) as string;
  if (!ENTITIES[entityType] || ENTITIES[entityType].requiresApproval === false) {
    throw badRequest('entity_type must be a workflow-enabled entity type');
  }
  const existing = await client.query(
    'SELECT 1 FROM workflows WHERE tenant_id = $1 AND company_id = $2 AND entity_type = $3 LIMIT 1',
    [ctx.tenantId ?? null, requireCompany(ctx), entityType]
  );
  if (existing.rows.length > 0) {
    throw conflict('A workflow is already configured for ' + entityType + '; edit it instead of creating another');
  }

  const steps = parseSteps(body.steps ?? body.config);
  await assertRolesExist(client, ctx, steps);

  try {
    const res = await client.query(
      `INSERT INTO workflows
          (company_id, tenant_id, code, name, entity_type, description, config,
           is_active, status, version, effective_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'PUBLISHED',1,$9::date)
       RETURNING *`,
      [
        requireCompany(ctx), ctx.tenantId ?? null,
        text(body.code, 'code', true),
        text(body.name, 'name', true),
        entityType,
        text(body.description, 'description'),
        JSON.stringify(steps),
        bool(body.is_active ?? body.isActive, true),
        date(body.effective_from ?? body.effectiveFrom, 'effective_from'),
      ]
    );
    const row = res.rows[0];
    await logAudit(client, ctx, {
      action: 'create',
      resource: 'organisation.settings.approval.workflow',
      recordId: Number(row.id),
      recordCode: String(row.code),
      newValues: { entity_type: row.entity_type, steps },
    });
    const { config, ...rest } = row;
    return { workflow: toCamelRow(rest), steps: toCamelSteps(config) };
  } catch (err) {
    if (pgCode(err) === UNIQUE_VIOLATION) {
      throw conflict('A workflow with that code already exists for this company');
    }
    throw err;
  }
}

export async function updateWorkflow(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const before = await requireScoped(client, 'workflows', ctx, id);
  let steps: ApprovalStep[] | null = null;
  if (body.steps !== undefined || body.config !== undefined) {
    steps = parseSteps(body.steps ?? body.config);
    await assertRolesExist(client, ctx, steps);
  }
  const res = await client.query(
    `UPDATE workflows SET
        name = COALESCE($3, name),
        description = COALESCE($4, description),
        is_active = COALESCE($5, is_active),
        effective_from = COALESCE($6::date, effective_from),
        config = COALESCE($7::jsonb, config),
        version = version + 1,
        updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [
      id, ctx.tenantId ?? null,
      text(body.name, 'name'),
      text(body.description, 'description'),
      body.is_active === undefined && body.isActive === undefined
        ? null : bool(body.is_active ?? body.isActive, true),
      date(body.effective_from ?? body.effectiveFrom, 'effective_from'),
      steps === null ? null : JSON.stringify(steps),
    ]
  );
  if (res.rows.length === 0) throw notFound('No such workflow: ' + id);
  const row = res.rows[0];
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'organisation.settings.approval.workflow',
    recordId: id,
    recordCode: String(row.code),
    oldValues: { config: before.config },
    newValues: { config: row.config, version: row.version },
  });
  const { config, ...rest } = row;
  return { workflow: toCamelRow(rest), steps: toCamelSteps(config) };
}

/** Deactivate rather than delete: real documents reference the workflow by id. */
export async function setWorkflowActive(client: pg.PoolClient, ctx: Ctx, id: number, active: boolean) {
  const before = await requireScoped(client, 'workflows', ctx, id);
  const res = await client.query(
    `UPDATE workflows SET is_active = $3, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId ?? null, active]
  );
  if (res.rows.length === 0) throw notFound('No such workflow: ' + id);
  const row = res.rows[0];
  await logAudit(client, ctx, {
    action: active ? 'activate' : 'deactivate',
    resource: 'organisation.settings.approval.workflow',
    recordId: id,
    recordCode: String(row.code),
    oldValues: { is_active: before.is_active },
    newValues: { is_active: row.is_active },
  });
  return toCamelRow(row);
}

/**
 * Which workflow + steps the live engine would use for an entity type and
 * amount. Mirrors startWorkflow's match and amount-band filtering exactly, so
 * this "test resolution" is honest about what will actually happen.
 */
export async function resolveWorkflow(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { entityType?: string | null; amount?: number | null }
) {
  const entityType = opts.entityType;
  if (!entityType) return { workflow: null, steps: [] };
  const res = await client.query(
    `SELECT * FROM workflows
      WHERE tenant_id = $1 AND company_id = $2 AND entity_type = $3
        AND is_active = true AND status = 'PUBLISHED'
        AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
      ORDER BY id LIMIT 1`,
    [ctx.tenantId ?? null, requireCompany(ctx), entityType]
  );
  const wf = res.rows[0];
  if (!wf) return { workflow: null, steps: [] };
  const amount = opts.amount ?? null;
  const applicable = toCamelSteps(wf.config).filter((s) => {
    if (s.amountMin != null && (amount ?? 0) < Number(s.amountMin)) return false;
    if (s.amountMax != null && Number(s.amountMax) > 0 && (amount ?? 0) > Number(s.amountMax)) return false;
    return true;
  });
  const { config, ...rest } = wf;
  return { workflow: toCamelRow(rest), steps: applicable };
}

async function requireScoped(
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
