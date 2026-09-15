import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, conflict, notFound, toCamelRow, toCamelRows } from '../../utils.js';
import { logAudit } from '../audit.js';

/**
 * Approval configuration.
 *
 * Three tables, three questions:
 *   approval_workflows       - which document type routes through which chain
 *   approval_levels          - who signs each step, how many signatures, SLA
 *   approval_fallback_rules  - who steps in when the named approver is absent
 *
 * The last one carries the invariant the spec is insistent about: a fallback
 * grants approval authority for a timeboxed window and nothing else. It must
 * never silently widen into administrative power, so every fallback is
 * required to name both a primary and a fallback, carry a reason and an end
 * date, and is refused outright if it would hand a fallback approver the
 * administrative permission set.
 *
 * Delegations and acting authority are NOT reimplemented here - they already
 * live in services/governance.ts with their own state machine. This module is
 * configuration; governance is the workflow that consumes it.
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

export const DOCUMENT_TYPES = [
  'PURCHASE_ORDER', 'PURCHASE_REQUISITION', 'PAYMENT', 'JOURNAL', 'INVOICE',
  'CREDIT_NOTE', 'EXPENSE', 'PAYROLL', 'LEAVE_REQUEST', 'CONTRACT',
  'STOCK_ADJUSTMENT', 'PRODUCTION_ORDER', 'PURCHASE_RETURN', 'SALES_ORDER', 'OTHER',
] as const;

/**
 * Permissions a fallback approver may never be handed by this screen.
 *
 * The point is that "who covers for the MD while she is away" and "who may
 * administer the ERP" are different questions. A fallback rule answers only
 * the first, so it cannot be used to bootstrap the second.
 */
const ADMIN_PREFIXES = ['system.', 'organisation.security', 'organisation.settings.delete'];

export async function listWorkflows(client: pg.PoolClient, ctx: Ctx, opts: { documentType?: string | null } = {}) {
  const res = await client.query(
    `SELECT w.*,
            (SELECT count(*) FROM approval_levels l WHERE l.workflow_id = w.id) AS level_count
       FROM approval_workflows w
      WHERE w.tenant_id = $1 AND w.company_id = $2
        AND ($3::text IS NULL OR w.document_type = $3)
      ORDER BY w.document_type, w.priority, w.code`,
    [ctx.tenantId ?? null, requireCompany(ctx), opts.documentType ?? null]
  );
  return toCamelRows(res.rows);
}

export async function getWorkflow(client: pg.PoolClient, ctx: Ctx, id: number) {
  const w = await requireScoped(client, 'approval_workflows', ctx, id);
  const levels = await client.query(
    'SELECT * FROM approval_levels WHERE workflow_id = $1 ORDER BY level_no',
    [id]
  );
  const fallbacks = await client.query(
    'SELECT * FROM approval_fallback_rules WHERE workflow_id = $1 ORDER BY id',
    [id]
  );
  return {
    workflow: toCamelRow(w),
    levels: toCamelRows(levels.rows),
    fallbacks: toCamelRows(fallbacks.rows),
  };
}

export async function createWorkflow(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const documentType = text(body.document_type ?? body.documentType, 'document_type', true) as string;
  if (!(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    throw badRequest('document_type must be one of: ' + DOCUMENT_TYPES.join(', '));
  }
  try {
    const res = await client.query(
      `INSERT INTO approval_workflows
          (tenant_id, company_id, code, name, document_type, description, priority,
           min_amount, max_amount, scope, is_active, effective_from, effective_to, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$14)
       RETURNING *`,
      [
        ctx.tenantId ?? null, requireCompany(ctx),
        text(body.code, 'code', true),
        text(body.name, 'name', true),
        documentType,
        text(body.description, 'description'),
        int(body.priority, 'priority', 0, 100000) ?? 100,
        money(body.min_amount ?? body.minAmount, 'min_amount'),
        money(body.max_amount ?? body.maxAmount, 'max_amount'),
        JSON.stringify(body.scope ?? {}),
        bool(body.is_active ?? body.isActive, true),
        date(body.effective_from ?? body.effectiveFrom, 'effective_from') ?? new Date().toISOString().slice(0, 10),
        date(body.effective_to ?? body.effectiveTo, 'effective_to'),
        ctx.userId ?? null,
      ]
    );
    await logAudit(client, ctx, {
      action: 'create',
      resource: 'organisation.settings.approval.workflow',
      recordId: Number(res.rows[0].id),
      recordCode: String(res.rows[0].code),
      newValues: res.rows[0],
    });
    return toCamelRow(res.rows[0]);
  } catch (err) {
    if (pgCode(err) === UNIQUE_VIOLATION) {
      throw conflict('An approval workflow with that code already exists for this company');
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
  const before = await requireScoped(client, 'approval_workflows', ctx, id);
  const documentType = text(body.document_type ?? body.documentType, 'document_type');
  if (documentType !== null && !(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    throw badRequest('document_type must be one of: ' + DOCUMENT_TYPES.join(', '));
  }
  const res = await client.query(
    `UPDATE approval_workflows SET
        name = COALESCE($3, name),
        document_type = COALESCE($4, document_type),
        description = COALESCE($5, description),
        priority = COALESCE($6, priority),
        min_amount = COALESCE($7, min_amount),
        max_amount = COALESCE($8, max_amount),
        scope = COALESCE($9::jsonb, scope),
        is_active = COALESCE($10, is_active),
        effective_from = COALESCE($11, effective_from),
        effective_to = COALESCE($12, effective_to),
        updated_by = $13,
        updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [
      id, ctx.tenantId ?? null,
      text(body.name, 'name'),
      documentType,
      text(body.description, 'description'),
      int(body.priority, 'priority', 0, 100000),
      money(body.min_amount ?? body.minAmount, 'min_amount'),
      money(body.max_amount ?? body.maxAmount, 'max_amount'),
      body.scope === undefined ? null : JSON.stringify(body.scope),
      body.is_active === undefined && body.isActive === undefined
        ? null : bool(body.is_active ?? body.isActive, true),
      date(body.effective_from ?? body.effectiveFrom, 'effective_from'),
      date(body.effective_to ?? body.effectiveTo, 'effective_to'),
      ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'organisation.settings.approval.workflow',
    recordId: id,
    recordCode: String(res.rows[0].code),
    oldValues: before,
    newValues: res.rows[0],
  });
  return toCamelRow(res.rows[0]);
}

/**
 * Deactivate rather than delete.
 *
 * A workflow that has routed real documents is referenced by their approval
 * history; removing the row would orphan that trail. Switching it off stops
 * new routing while leaving the record of what happened intact.
 */
export async function deactivateWorkflow(client: pg.PoolClient, ctx: Ctx, id: number) {
  const before = await requireScoped(client, 'approval_workflows', ctx, id);
  const res = await client.query(
    `UPDATE approval_workflows SET is_active = false, updated_by = $3, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId ?? null, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'deactivate',
    resource: 'organisation.settings.approval.workflow',
    recordId: id,
    recordCode: String(res.rows[0].code),
    oldValues: before,
    newValues: res.rows[0],
  });
  return toCamelRow(res.rows[0]);
}

// ===================== Levels =====================

export async function createLevel(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const workflowId = idOrNull(body.workflow_id ?? body.workflowId, 'workflow_id');
  if (workflowId === null) throw badRequest('workflow_id is required');
  const workflow = await requireScoped(client, 'approval_workflows', ctx, workflowId);

  const roleId = idOrNull(body.approver_role_id ?? body.approverRoleId, 'approver_role_id');
  const userId = idOrNull(body.approver_user_id ?? body.approverUserId, 'approver_user_id');
  if (roleId === null && userId === null) {
    throw badRequest('A level needs an approver role or an approver user');
  }
  if (roleId !== null && userId !== null) {
    throw badRequest('A level takes an approver role or an approver user, not both');
  }

  const escalateTo = int(body.escalate_to_level_no ?? body.escalateToLevelNo, 'escalate_to_level_no', 1, 100);
  const levelNo = int(body.level_no ?? body.levelNo, 'level_no', 1, 100, true) as number;
  if (escalateTo !== null && escalateTo === levelNo) {
    throw badRequest('A level cannot escalate to itself');
  }

  try {
    const res = await client.query(
      `INSERT INTO approval_levels
          (workflow_id, tenant_id, company_id, level_no, name, approver_role_id, approver_user_id,
           required_approvals, is_optional, allow_delegation, sla_hours, escalate_to_level_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        workflowId, ctx.tenantId ?? null, Number(workflow.company_id),
        levelNo,
        text(body.name, 'name', true),
        roleId, userId,
        int(body.required_approvals ?? body.requiredApprovals, 'required_approvals', 1, 100) ?? 1,
        bool(body.is_optional ?? body.isOptional, false),
        bool(body.allow_delegation ?? body.allowDelegation, true),
        int(body.sla_hours ?? body.slaHours, 'sla_hours', 1, 8760),
        escalateTo,
      ]
    );
    await logAudit(client, ctx, {
      action: 'create',
      resource: 'organisation.settings.approval.level',
      recordId: Number(res.rows[0].id),
      recordCode: String(workflow.code) + '#' + levelNo,
      newValues: res.rows[0],
    });
    return toCamelRow(res.rows[0]);
  } catch (err) {
    if (pgCode(err) === UNIQUE_VIOLATION) {
      throw conflict('That level number already exists on this workflow');
    }
    throw err;
  }
}

export async function updateLevel(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const before = await requireScoped(client, 'approval_levels', ctx, id);
  const roleId = idOrNull(body.approver_role_id ?? body.approverRoleId, 'approver_role_id');
  const userId = idOrNull(body.approver_user_id ?? body.approverUserId, 'approver_user_id');
  if (roleId !== null && userId !== null) {
    throw badRequest('A level takes an approver role or an approver user, not both');
  }
  const res = await client.query(
    `UPDATE approval_levels SET
        name = COALESCE($3, name),
        approver_role_id = COALESCE($4, approver_role_id),
        approver_user_id = COALESCE($5, approver_user_id),
        required_approvals = COALESCE($6, required_approvals),
        is_optional = COALESCE($7, is_optional),
        allow_delegation = COALESCE($8, allow_delegation),
        sla_hours = COALESCE($9, sla_hours),
        escalate_to_level_no = COALESCE($10, escalate_to_level_no),
        updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [
      id, ctx.tenantId ?? null,
      text(body.name, 'name'), roleId, userId,
      int(body.required_approvals ?? body.requiredApprovals, 'required_approvals', 1, 100),
      body.is_optional === undefined && body.isOptional === undefined
        ? null : bool(body.is_optional ?? body.isOptional, false),
      body.allow_delegation === undefined && body.allowDelegation === undefined
        ? null : bool(body.allow_delegation ?? body.allowDelegation, true),
      int(body.sla_hours ?? body.slaHours, 'sla_hours', 1, 8760),
      int(body.escalate_to_level_no ?? body.escalateToLevelNo, 'escalate_to_level_no', 1, 100),
    ]
  );
  if (res.rows.length === 0) throw notFound('No such approval level: ' + id);
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'organisation.settings.approval.level',
    recordId: id,
    oldValues: before,
    newValues: res.rows[0],
  });
  return toCamelRow(res.rows[0]);
}

export async function deleteLevel(client: pg.PoolClient, ctx: Ctx, id: number) {
  const before = await requireScoped(client, 'approval_levels', ctx, id);
  await client.query('DELETE FROM approval_levels WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId ?? null]);
  await logAudit(client, ctx, {
    action: 'delete',
    resource: 'organisation.settings.approval.level',
    recordId: id,
    oldValues: before,
  });
  return { id, deleted: true };
}

// ===================== Fallback rules =====================

export async function listFallbackRules(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM approval_fallback_rules
      WHERE tenant_id = $1 AND company_id = $2
      ORDER BY effective_from DESC, id DESC`,
    [ctx.tenantId ?? null, requireCompany(ctx)]
  );
  return toCamelRows(res.rows);
}

/**
 * Create a fallback rule.
 *
 * Requirements, all of them load-bearing:
 *   - a named primary and a named fallback (a rule with neither decides nothing);
 *   - a reason, because this is an exception to the org chart;
 *   - an end date, because a fallback without one becomes a permanent
 *     shadow authority nobody remembers granting.
 */
export async function createFallbackRule(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
) {
  const primaryRole = idOrNull(body.primary_role_id ?? body.primaryRoleId, 'primary_role_id');
  const primaryUser = idOrNull(body.primary_user_id ?? body.primaryUserId, 'primary_user_id');
  const fallbackRole = idOrNull(body.fallback_role_id ?? body.fallbackRoleId, 'fallback_role_id');
  const fallbackUser = idOrNull(body.fallback_user_id ?? body.fallbackUserId, 'fallback_user_id');

  if (primaryRole === null && primaryUser === null) {
    throw badRequest('A fallback rule needs a primary role or a primary user');
  }
  if (primaryRole !== null && primaryUser !== null) {
    throw badRequest('Name either a primary role or a primary user, not both');
  }
  if (fallbackRole === null && fallbackUser === null) {
    throw badRequest('A fallback rule needs a fallback role or a fallback user');
  }
  if (fallbackRole !== null && fallbackUser !== null) {
    throw badRequest('Name either a fallback role or a fallback user, not both');
  }
  if (primaryUser !== null && fallbackUser !== null && primaryUser === fallbackUser) {
    throw badRequest('A fallback approver cannot be the same person as the primary approver');
  }

  const effectiveFrom = date(body.effective_from ?? body.effectiveFrom, 'effective_from');
  const effectiveTo = date(body.effective_to ?? body.effectiveTo, 'effective_to', true) as string;
  if (effectiveFrom !== null && effectiveTo <= effectiveFrom) {
    throw badRequest('effective_to must be after effective_from');
  }

  if (fallbackRole !== null) {
    await assertRoleIsNotAdministrative(client, ctx, fallbackRole);
  }

  const workflowId = idOrNull(body.workflow_id ?? body.workflowId, 'workflow_id');
  const levelId = idOrNull(body.level_id ?? body.levelId, 'level_id');
  if (workflowId !== null) await requireScoped(client, 'approval_workflows', ctx, workflowId);
  if (levelId !== null) await requireScoped(client, 'approval_levels', ctx, levelId);

  const res = await client.query(
    `INSERT INTO approval_fallback_rules
        (tenant_id, company_id, workflow_id, level_id, primary_role_id, primary_user_id,
         fallback_role_id, fallback_user_id, reason, effective_from, effective_to,
         is_active, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::date, now()),$11,$12,$13,$13)
     RETURNING *`,
    [
      ctx.tenantId ?? null, requireCompany(ctx),
      workflowId, levelId, primaryRole, primaryUser, fallbackRole, fallbackUser,
      text(body.reason, 'reason', true),
      effectiveFrom, effectiveTo,
      bool(body.is_active ?? body.isActive, true),
      ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'organisation.settings.approval.fallback_rule',
    recordId: Number(res.rows[0].id),
    newValues: res.rows[0],
    metadata: { reason: text(body.reason, 'reason', true) },
  });
  return toCamelRow(res.rows[0]);
}

export async function updateFallbackRule(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const before = await requireScoped(client, 'approval_fallback_rules', ctx, id);
  const fallbackRole = idOrNull(body.fallback_role_id ?? body.fallbackRoleId, 'fallback_role_id');
  if (fallbackRole !== null) await assertRoleIsNotAdministrative(client, ctx, fallbackRole);
  const effectiveTo = date(body.effective_to ?? body.effectiveTo, 'effective_to');
  const res = await client.query(
    `UPDATE approval_fallback_rules SET
        reason = COALESCE($3, reason),
        effective_to = COALESCE($4, effective_to),
        is_active = COALESCE($5, is_active),
        fallback_role_id = COALESCE($6, fallback_role_id),
        fallback_user_id = COALESCE($7, fallback_user_id),
        updated_by = $8,
        updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [
      id, ctx.tenantId ?? null,
      text(body.reason, 'reason'), effectiveTo,
      body.is_active === undefined && body.isActive === undefined
        ? null : bool(body.is_active ?? body.isActive, true),
      fallbackRole,
      idOrNull(body.fallback_user_id ?? body.fallbackUserId, 'fallback_user_id'),
      ctx.userId ?? null,
    ]
  );
  if (res.rows.length === 0) throw notFound('No such fallback rule: ' + id);
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'organisation.settings.approval.fallback_rule',
    recordId: id,
    oldValues: before,
    newValues: res.rows[0],
  });
  return toCamelRow(res.rows[0]);
}

export async function deleteFallbackRule(client: pg.PoolClient, ctx: Ctx, id: number) {
  const before = await requireScoped(client, 'approval_fallback_rules', ctx, id);
  await client.query('DELETE FROM approval_fallback_rules WHERE id = $1 AND tenant_id = $2', [
    id, ctx.tenantId ?? null,
  ]);
  await logAudit(client, ctx, {
    action: 'delete',
    resource: 'organisation.settings.approval.fallback_rule',
    recordId: id,
    oldValues: before,
  });
  return { id, deleted: true };
}

/**
 * Refuse a fallback role that carries administrative authority.
 *
 * Reads the role's permission set and rejects the rule if it holds anything in
 * ADMIN_PREFIXES. This is the code-level half of
 * "Super Admin should not automatically receive unrestricted business
 * authority" - the converse direction, that a business fallback must not
 * become an administrator.
 */
async function assertRoleIsNotAdministrative(
  client: pg.PoolClient,
  ctx: Ctx,
  roleId: number
): Promise<void> {
  // roles.permissions is a jsonb array of permission codes; role_permissions
  // is the normalised join. Read both, so a role built either way is covered.
  const res = await client.query(
    `SELECT permission FROM (
         SELECT jsonb_array_elements_text(r.permissions) AS permission
           FROM roles r WHERE r.id = $1
         UNION
         SELECT p.code AS permission
           FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = $1
       ) AS perms`,
    [roleId]
  );
  for (const row of res.rows) {
    for (const prefix of ADMIN_PREFIXES) {
      if (String(row.permission) === prefix || String(row.permission).startsWith(prefix)) {
        throw badRequest(
          'That fallback role holds administrative permission ' + row.permission +
          '. Approval fallback grants business authority only; it must not hand out administration.'
        );
      }
    }
  }
}

// ===================== Runtime consumer =====================

/**
 * Resolve the approval chain that applies to a document.
 *
 * This is the function the rest of the ERP calls instead of hard-coding who
 * approves what. Narrowest match wins: a workflow scoped to a branch beats a
 * company-wide one, a higher priority number beats a lower, and amount bands
 * filter the candidates. Disabled workflows and out-of-window workflows are
 * ignored, so switching a workflow off takes effect immediately with no
 * deployment (AC-ORG-012).
 */
export async function resolveApprovalChain(
  client: pg.PoolClient,
  ctx: Ctx,
  documentType: string,
  amount: number | null = null,
  branchId: number | null = null
) {
  const res = await client.query(
    `SELECT * FROM approval_workflows
      WHERE tenant_id = $1 AND company_id = $2
        AND document_type = $3 AND is_active = true
        AND effective_from <= CURRENT_DATE
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
        AND (min_amount IS NULL OR $4::numeric IS NULL OR $4::numeric >= min_amount)
        AND (max_amount IS NULL OR $4::numeric IS NULL OR $4::numeric <= max_amount)
      ORDER BY priority DESC, id DESC`,
    [ctx.tenantId ?? null, requireCompany(ctx), documentType, amount]
  );
  if (res.rows.length === 0) return { workflow: null, levels: [], fallbacks: [] };

  // Prefer a workflow whose scope names this branch; otherwise take the first.
  let chosen = res.rows[0];
  if (branchId != null) {
    const scoped = res.rows.find((r) => {
      const scope = r.scope;
      if (scope === null || typeof scope !== 'object') return false;
      const list = (scope as Record<string, unknown>).branch_ids;
      return Array.isArray(list) && list.map(Number).includes(Number(branchId));
    });
    if (scoped) chosen = scoped;
  }

  const levels = await client.query(
    'SELECT * FROM approval_levels WHERE workflow_id = $1 ORDER BY level_no',
    [chosen.id]
  );
  const fallbacks = await client.query(
    `SELECT * FROM approval_fallback_rules
      WHERE workflow_id = $1 AND is_active = true
        AND effective_from <= CURRENT_DATE AND effective_to >= CURRENT_DATE`,
    [chosen.id]
  );
  return {
    workflow: toCamelRow(chosen),
    levels: toCamelRows(levels.rows),
    fallbacks: toCamelRows(fallbacks.rows),
  };
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
