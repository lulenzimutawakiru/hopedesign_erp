import pg from 'pg';
import {
  badRequest,
  conflict,
  emitEvent,
  forbidden,
  hasPerm,
  idIn,
  isNumericRef,
  logAudit,
  n,
  notFound,
  notifyUsers,
  oneOf,
  paged,
  parsePagination,
  requireRow,
  resolveScope,
  s,
  sameId,
  strList,
  truthy,
  uniq,
  usersWithPermission,
  type Ctx,
  type TicketScope,
} from './serviceDeskCommon.js';

/**
 * HOPE DESIGN Service Desk - Change management (spec section 19).
 *
 *   CHANGE REQUEST -> RISK ASSESSMENT -> IMPACT ANALYSIS -> APPROVAL ->
 *   IMPLEMENTATION -> VALIDATION -> CLOSURE
 *
 * Three change models share one pipeline:
 *   NORMAL    full assessment and a risk/authorisation chain.
 *   STANDARD  a pre-approved, repeatable change: recorded for traceability, then
 *             implemented without a fresh approval chain.
 *   EMERGENCY may be implemented immediately to restore service, but is flagged
 *             for retrospective approval and cannot be closed until that
 *             ratification is recorded. The deviation itself is audited.
 */

export const CHANGE_TYPES = ['NORMAL', 'STANDARD', 'EMERGENCY'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const CHANGE_STATUSES = [
  'DRAFT',
  'RISK_ASSESSMENT',
  'IMPACT_ANALYSIS',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'IMPLEMENTATION',
  'VALIDATION',
  'CLOSED',
  'FAILED',
  'ROLLED_BACK',
  'CANCELLED',
] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export const CHANGE_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const CHANGE_APPROVAL_TYPES = [
  'RISK',
  'CAB',
  'IMPLEMENTATION',
  'RETROSPECTIVE',
  'EMERGENCY',
] as const;
export type ChangeApprovalType = (typeof CHANGE_APPROVAL_TYPES)[number];
export const CHANGE_APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'DELEGATED', 'SKIPPED'] as const;
export const CHANGE_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;

/**
 * Legal change transitions. EMERGENCY and STANDARD changes may skip the
 * assessment stages because those controls are applied after the fact or not at
 * all; assertChangeTransition decides which graph applies.
 */
const CHANGE_TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  DRAFT: ['RISK_ASSESSMENT', 'IMPACT_ANALYSIS', 'PENDING_APPROVAL', 'APPROVED', 'IMPLEMENTATION', 'CANCELLED'],
  RISK_ASSESSMENT: ['DRAFT', 'IMPACT_ANALYSIS', 'PENDING_APPROVAL', 'CANCELLED'],
  IMPACT_ANALYSIS: ['RISK_ASSESSMENT', 'PENDING_APPROVAL', 'DRAFT', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['IMPLEMENTATION', 'CANCELLED', 'FAILED'],
  REJECTED: ['DRAFT', 'CANCELLED'],
  IMPLEMENTATION: ['VALIDATION', 'FAILED', 'ROLLED_BACK', 'CANCELLED'],
  VALIDATION: ['CLOSED', 'IMPLEMENTATION', 'ROLLED_BACK', 'FAILED'],
  CLOSED: ['ROLLED_BACK'],
  FAILED: ['IMPLEMENTATION', 'ROLLED_BACK', 'CANCELLED'],
  ROLLED_BACK: ['IMPLEMENTATION', 'CLOSED', 'CANCELLED'],
  CANCELLED: ['DRAFT'],
};

export function assertChangeTransition(from: string, to: string, changeType?: string | null): void {
  const allowed = CHANGE_TRANSITIONS[from as ChangeStatus];
  if (!allowed) throw conflict('Unknown change status: ' + from);
  if (from === to) return;
  if (allowed.includes(to as ChangeStatus)) return;

  // Emergency changes exist to restore service now: they may be implemented
  // straight from the draft and ratified afterwards.
  if (changeType === 'EMERGENCY' && (to === 'IMPLEMENTATION' || to === 'APPROVED')) return;

  // A standard change is pre-authorised by policy, so it may skip the
  // assessment ladder and be recorded as approved for implementation.
  if (changeType === 'STANDARD' && (to === 'APPROVED' || to === 'IMPLEMENTATION')) return;

  throw conflict('Change cannot move from ' + from + ' to ' + to);
}

export interface ChangeScope extends TicketScope {
  canView: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  canImplement: boolean;
  canValidate: boolean;
  canClose: boolean;
  canCancel: boolean;
}

const perm = (scope: TicketScope, p: string) => scope.isAdmin || hasPerm(scope.permissions, p);

export async function resolveChangeScope(client: pg.PoolClient, ctx: Ctx): Promise<ChangeScope> {
  const base = await resolveScope(client, ctx);
  return {
    ...base,
    canView: perm(base, 'service_desk.changes.view') || perm(base, 'service_desk.tickets.view'),
    canCreate: perm(base, 'service_desk.changes.create'),
    canUpdate: perm(base, 'service_desk.changes.update'),
    canSubmit: perm(base, 'service_desk.changes.submit'),
    canApprove:
      perm(base, 'service_desk.change_approvals.approve') || perm(base, 'service_desk.changes.approve'),
    canImplement: perm(base, 'service_desk.changes.implement'),
    canValidate: perm(base, 'service_desk.changes.validate'),
    canClose: perm(base, 'service_desk.changes.close'),
    canCancel: perm(base, 'service_desk.changes.cancel'),
  };
}

export interface ChangeRow {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
  change_number: string;
  title: string;
  description: string | null;
  justification: string | null;
  change_type: string;
  category_id: number | null;
  subcategory_id: number | null;
  status: string;
  priority: string | null;
  risk_level: string | null;
  risk_assessment: string | null;
  impact_analysis: string | null;
  affected_systems: string[] | null;
  affected_asset_id: number | null;
  planned_start_at: string | null;
  planned_end_at: string | null;
  actual_start_at: string | null;
  actual_end_at: string | null;
  downtime_minutes: number | null;
  implementation_plan: string | null;
  backout_plan: string | null;
  test_plan: string | null;
  validation_notes: string | null;
  requested_by: number | null;
  requested_by_employee_id: number | null;
  assigned_to_user_id: number | null;
  assigned_team_id: number | null;
  related_ticket_id: number | null;
  related_problem_id: number | null;
  is_emergency: boolean;
  retrospective_approval_required: boolean;
  retrospective_approved_by: number | null;
  retrospective_approval_at: string | null;
  retrospective_justification: string | null;
  implemented_by: number | null;
  implemented_at: string | null;
  validated_by: number | null;
  validated_at: string | null;
  closed_by: number | null;
  closed_at: string | null;
  created_by: number | null;
}

export async function loadChange(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string
): Promise<ChangeRow | null> {
  const res =
    isNumericRef(ref)
      ? await client.query<ChangeRow>(
          'SELECT c.* FROM change_requests c WHERE c.id = $1 AND c.tenant_id = $2 AND c.company_id = $3',
          [Number(ref), ctx.tenantId, ctx.companyId]
        )
      : await client.query<ChangeRow>(
          'SELECT c.* FROM change_requests c WHERE c.change_number = $1 AND c.tenant_id = $2 AND c.company_id = $3',
          [String(ref), ctx.tenantId, ctx.companyId]
        );
  return res.rows[0] ?? null;
}

export function changeResourceAttributes(
  scope: ChangeScope,
  c: ChangeRow,
  action: string
): Record<string, unknown> {
  const isOwner = sameId(c.created_by, scope.userId) || sameId(c.requested_by, scope.userId);
  const isAssignee = sameId(c.assigned_to_user_id, scope.userId);
  const inReach = scope.isAdmin || scope.isAgent || isOwner || isAssignee;
  const attrs: Record<string, unknown> = {
    module: 'service_desk',
    resource: 'change_requests',
    action,
    change_id: c.id,
    change_number: c.change_number,
    change_type: c.change_type,
    status: c.status,
    risk_level: c.risk_level,
    owner_user_id: c.created_by,
    requested_by: c.requested_by,
    assigned_to_user_id: c.assigned_to_user_id,
    is_emergency: c.is_emergency,
    service_desk_agent: scope.isAgent,
    service_desk_internal_notes: scope.canViewInternalNotes,
    service_desk_readonly: false,
    classified_denied: false,
  };
  if (!inReach) attrs.scope_denied = true;
  return attrs;
}

export interface ChangeActionContext {
  change: ChangeRow;
  scope: ChangeScope;
  attributes: Record<string, unknown>;
}

/** Load a change, publish ABAC facts, and refuse out-of-scope callers. */
export async function changeActionContext(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  action: string
): Promise<ChangeActionContext> {
  const change = await loadChange(client, ctx, ref);
  if (!change) throw notFound('Change request not found');
  const scope = await resolveChangeScope(client, ctx);
  const attributes = changeResourceAttributes(scope, change, action);
  ctx.resourceAttributes = { ...(ctx.resourceAttributes ?? {}), ...attributes };
  if (attributes.scope_denied === true) {
    throw forbidden('This change request is outside your service desk scope');
  }
  return { change, scope, attributes };
}

const label = (c: ChangeRow) => c.change_number + ' - ' + c.title;

// ------------------------------------------------------------ read model

const CHANGE_SORTS: Record<string, string> = {
  newest: 'c.created_at DESC, c.id DESC',
  oldest: 'c.created_at ASC, c.id ASC',
  planned: 'c.planned_start_at ASC NULLS LAST, c.id DESC',
  risk: "CASE c.risk_level WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, c.created_at DESC",
  number: 'c.change_number ASC',
};

export interface ListChangesQuery extends Record<string, unknown> {
  status?: string;
  statuses?: string;
  changeType?: string;
  riskLevel?: string;
  categoryId?: number;
  assignedTo?: number;
  relatedTicketId?: number;
  relatedProblemId?: number;
  emergencyOnly?: boolean;
  pendingMyApproval?: boolean;
  mine?: boolean;
  search?: string;
  from?: string;
  to?: string;
  sortBy?: string;
  page?: number;
  pageSize?: number;
}

export async function listChanges(client: pg.PoolClient, ctx: Ctx, q: ListChangesQuery = {}) {
  const scope = await resolveChangeScope(client, ctx);
  if (!scope.canView && !scope.isAgent) {
    // Employees may still see the changes they requested or that touch them.
  }
  const { page, pageSize: limit, offset } = parsePagination(q as Record<string, unknown>);
  const where: string[] = ['c.tenant_id = $1', 'c.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const push = (sql: string, ...values: unknown[]) => {
    const first = params.length + 1;
    for (const v of values) params.push(v);
    where.push(sql.split('?').join('$' + String(first)));
  };

  const status = oneOf(q.status, CHANGE_STATUSES);
  if (status) push('c.status = ?', status);
  const statusList = strList(q.statuses)
    ?.map((x) => x.toUpperCase())
    .filter((x) => (CHANGE_STATUSES as readonly string[]).includes(x));
  if (!status && statusList && statusList.length) push('c.status = ANY(?)', statusList);
  const changeType = oneOf(q.changeType, CHANGE_TYPES);
  if (changeType) push('c.change_type = ?', changeType);
  const risk = oneOf(q.riskLevel, CHANGE_RISK_LEVELS);
  if (risk) push('c.risk_level = ?', risk);
  if (q.categoryId) push('c.category_id = ?', Number(q.categoryId));
  if (q.assignedTo) push('c.assigned_to_user_id = ?', Number(q.assignedTo));
  if (q.relatedTicketId) push('c.related_ticket_id = ?', Number(q.relatedTicketId));
  if (q.relatedProblemId) push('c.related_problem_id = ?', Number(q.relatedProblemId));
  if (truthy(q.emergencyOnly)) where.push('c.is_emergency');
  if (truthy(q.mine) && scope.userId) {
    push('(c.created_by = ? OR c.requested_by = ? OR c.assigned_to_user_id = ?)', scope.userId);
  }
  if (truthy(q.pendingMyApproval) && scope.userId) {
    push(
      "EXISTS (SELECT 1 FROM change_approvals a WHERE a.change_id = c.id AND a.status = 'PENDING' " +
        'AND (a.approver_user_id = ? OR a.approver_user_id IS NULL))',
      scope.userId
    );
  }
  const search = s(q.search);
  if (search) {
    push(
      '(c.title ILIKE ? OR c.change_number ILIKE ? OR c.description ILIKE ? OR c.justification ILIKE ?)',
      '%' + search + '%'
    );
  }
  const from = s(q.from);
  if (from) push('COALESCE(c.planned_start_at, c.created_at) >= ?::timestamptz', from);
  const to = s(q.to);
  if (to) push('COALESCE(c.planned_start_at, c.created_at) <= ?::timestamptz', to);

  // Non-staff only ever reach their own change requests.
  if (!scope.isAgent) {
    const userRef = '$' + String(params.length + 1);
    const empRef = '$' + String(params.length + 2);
    params.push(scope.userId ?? -1, scope.employeeId ?? -1);
    where.push(
      '(c.created_by = ' + userRef + ' OR c.requested_by = ' + userRef +
        ' OR c.requested_by_employee_id = ' + empRef + ')'
    );
  }

  // String(q.sortBy) would yield the literal string "undefined" when the
  // caller omits sortBy, producing `ORDER BY undefined` and a 500 (42703).
  // The default has to be applied to the value, not only to the guard.
  const sortKey = Object.keys(CHANGE_SORTS).includes(String(q.sortBy ?? 'newest'))
    ? String(q.sortBy ?? 'newest')
    : 'newest';
  const whereSql = where.join(' AND ');
  const totalRes = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM change_requests c WHERE ' + whereSql,
    params
  );
  const rows = await client.query(
    'SELECT c.*, cat.name AS category_name, ' +
      "u.first_name || ' ' || u.last_name AS assigned_to_name, " +
      "r.first_name || ' ' || r.last_name AS requested_by_name, " +
      "(SELECT count(*)::int FROM change_approvals a WHERE a.change_id = c.id AND a.status = 'PENDING') AS pending_approvals, " +
      "(SELECT count(*)::int FROM change_approvals a WHERE a.change_id = c.id AND a.status = 'REJECTED') AS rejected_approvals " +
      'FROM change_requests c ' +
      'LEFT JOIN service_categories cat ON cat.id = c.category_id ' +
      'LEFT JOIN users u ON u.id = c.assigned_to_user_id ' +
      'LEFT JOIN users r ON r.id = c.requested_by ' +
      'WHERE ' + whereSql + ' ORDER BY ' + CHANGE_SORTS[sortKey] + ' LIMIT ' + String(limit) +
      ' OFFSET ' + String(offset),
    params
  );
  return paged(rows.rows, Number(totalRes.rows[0]?.count ?? 0), page, limit, offset);
}

async function notifyChangeWatchers(
  client: pg.PoolClient,
  ctx: Ctx,
  c: ChangeRow,
  payload: { type: string; title: string; body?: string; severity?: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' }
) {
  const approvers = await usersWithPermission(client, ctx, 'service_desk.change_approvals.approve');
  await notifyUsers(
    client,
    ctx,
    uniq([c.created_by, c.requested_by, c.assigned_to_user_id, ...approvers.slice(0, 25)]),
    {
      type: payload.type,
      title: payload.title,
      body: payload.body,
      link: '/service-desk/changes/' + c.id,
      entityType: 'service_change',
      entityId: c.id,
      severity: payload.severity ?? 'INFO',
    }
  );
}

/** People who must ratify a change: assignee first, then the approver pool. */
async function changeApproverIds(
  client: pg.PoolClient,
  ctx: Ctx,
  c: ChangeRow
): Promise<Array<number | null>> {
  const res = await client.query<{ id: number }>(
    "SELECT approver_user_id AS id FROM change_approvals WHERE change_id = $1 AND status = 'PENDING' " +
      'AND approver_user_id IS NOT NULL',
    [c.id]
  );
  const explicit = res.rows.map((r) => Number(r.id)).filter((x) => Number.isFinite(x) && x > 0);
  if (explicit.length) return uniq(explicit);
  return uniq([c.assigned_to_user_id, ...(await usersWithPermission(client, ctx, 'service_desk.change_approvals.approve')).slice(0, 25)]);
}

// ------------------------------------------------------------ change records

export interface ChangeDetail {
  change: Record<string, unknown>;
  approvals: unknown[];
  history: unknown[];
  permissions: Record<string, boolean>;
}

export async function getChange(client: pg.PoolClient, ctx: Ctx, ref: number | string): Promise<ChangeDetail> {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'view');
  const detail = await client.query(
    'SELECT c.*, cat.name AS category_name, sc.name AS subcategory_name, ' +
      "u.first_name || ' ' || u.last_name AS assigned_to_name, t.name AS assigned_team_name, " +
      "cu.first_name || ' ' || cu.last_name AS created_by_name, " +
      "rb.first_name || ' ' || rb.last_name AS requested_by_name, " +
      "im.first_name || ' ' || im.last_name AS implemented_by_name, " +
      "va.first_name || ' ' || va.last_name AS validated_by_name, " +
      "cl.first_name || ' ' || cl.last_name AS closed_by_name, " +
      "rt.ticket_number AS related_ticket_number, rt.subject AS related_ticket_subject, " +
      'p.problem_number AS related_problem_number ' +
      'FROM change_requests c ' +
      'LEFT JOIN service_categories cat ON cat.id = c.category_id ' +
      'LEFT JOIN service_subcategories sc ON sc.id = c.subcategory_id ' +
      'LEFT JOIN users u ON u.id = c.assigned_to_user_id ' +
      'LEFT JOIN service_teams t ON t.id = c.assigned_team_id ' +
      'LEFT JOIN users cu ON cu.id = c.created_by ' +
      'LEFT JOIN users rb ON rb.id = c.requested_by ' +
      'LEFT JOIN users im ON im.id = c.implemented_by ' +
      'LEFT JOIN users va ON va.id = c.validated_by ' +
      'LEFT JOIN users cl ON cl.id = c.closed_by ' +
      'LEFT JOIN service_tickets rt ON rt.id = c.related_ticket_id ' +
      'LEFT JOIN problems p ON p.id = c.related_problem_id ' +
      'WHERE c.id = $1',
    [change.id]
  );
  const approvals = await listChangeApprovals(client, ctx, change.id);
  const history = await client.query(
    'SELECT a.id, a.action, a.user_id, a.old_values, a.new_values, a.created_at, ' +
      "u.first_name || ' ' || u.last_name AS actor_name " +
      "FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id " +
      "WHERE a.resource = 'change_requests' AND a.record_id = $1 " +
      'ORDER BY a.created_at DESC, a.id DESC LIMIT 200',
    [change.id]
  );
  return {
    change: detail.rows[0] ?? change,
    approvals: approvals.items,
    history: history.rows,
    permissions: {
      update: scope.canUpdate,
      submit: scope.canSubmit && isChangeEditable(change.status),
      approve: scope.canApprove && change.status === 'PENDING_APPROVAL',
      implement: scope.canImplement && canStartImplementation(change),
      validate: scope.canValidate && change.status === 'VALIDATION',
      close: scope.canClose && change.status === 'VALIDATION',
      rollback: scope.canImplement && ['IMPLEMENTATION', 'VALIDATION', 'CLOSED', 'FAILED'].includes(change.status),
      cancel: scope.canCancel && CHANGE_TRANSITIONS[change.status as ChangeStatus]?.includes('CANCELLED') === true,
      retrospective: scope.canApprove && change.is_emergency && change.retrospective_approval_at === null,
    },
  };
}

/** Stages in which the change description is still mutable. */
export function isChangeEditable(status: string): boolean {
  return ['DRAFT', 'RISK_ASSESSMENT', 'IMPACT_ANALYSIS', 'REJECTED'].includes(status);
}

function canStartImplementation(c: ChangeRow): boolean {
  if (c.change_type === 'EMERGENCY') {
    return ['DRAFT', 'RISK_ASSESSMENT', 'IMPACT_ANALYSIS', 'PENDING_APPROVAL', 'APPROVED', 'FAILED', 'ROLLED_BACK'].includes(
      c.status
    );
  }
  return c.status === 'APPROVED' || c.status === 'FAILED' || c.status === 'ROLLED_BACK';
}

/**
 * Targeted column update with the same audit shape used elsewhere in the module.
 * Used for the assessment stages, where a change accumulates data without
 * necessarily moving status.
 */
async function patchChange(
  client: pg.PoolClient,
  ctx: Ctx,
  change: ChangeRow,
  sets: Record<string, unknown>,
  meta: { action: string; eventType?: string; note?: string | null; severity?: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' }
): Promise<string[]> {
  const params: unknown[] = [change.id, ctx.tenantId, ctx.companyId, ctx.userId ?? null];
  const cols: string[] = ['updated_by = $4'];
  const changed: string[] = [];
  for (const [col, val] of Object.entries(sets)) {
    if (val === undefined) continue;
    params.push(val);
    cols.push(col + ' = $' + String(params.length));
    changed.push(col);
  }
  if (!changed.length) return changed;
  await client.query(
    'UPDATE change_requests SET ' + cols.join(', ') + ' WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    params
  );
  await logAudit(client, ctx, {
    action: meta.action,
    resource: 'change_requests',
    recordId: change.id,
    recordCode: change.change_number,
    oldValues: { status: change.status },
    newValues: { fields: changed, note: meta.note ?? null },
  });
  if (meta.eventType) {
    await emitEvent(client, ctx, {
      eventType: meta.eventType,
      entityType: 'service_change',
      entityId: change.id,
      entityCode: change.change_number,
      payload: { fields: changed, title: change.title },
      severity: meta.severity === 'SUCCESS' ? 'INFO' : meta.severity ?? 'INFO',
    });
  }
  return changed;
}

export interface CreateChangeInput extends Record<string, unknown> {
  title?: string;
  description?: string;
  justification?: string;
  changeType?: string;
  categoryId?: number;
  subcategoryId?: number;
  priority?: string;
  riskLevel?: string;
  affectedSystems?: string[] | string;
  affectedAssetId?: number;
  plannedStartAt?: string;
  plannedEndAt?: string;
  implementationPlan?: string;
  backoutPlan?: string;
  testPlan?: string;
  documentId?: number;
  assignedToUserId?: number;
  assignedTeamId?: number;
  relatedTicketId?: number;
  relatedProblemId?: number;
  requestedBy?: number;
  requestedByEmployeeId?: number;
  /** Submit for approval immediately instead of leaving the change in DRAFT. */
  submit?: boolean;
}

export async function createChange(client: pg.PoolClient, ctx: Ctx, b: CreateChangeInput = {}) {
  const scope = await resolveChangeScope(client, ctx);
  if (!scope.canCreate) throw forbidden('You cannot create change requests');

  const title = s(b.title);
  if (!title) throw badRequest('title is required');
  const changeType = oneOf(b.changeType, CHANGE_TYPES) ?? 'NORMAL';
  const priority = oneOf(b.priority, CHANGE_PRIORITIES) ?? 'P3';
  const riskLevel = oneOf(b.riskLevel, CHANGE_RISK_LEVELS) ?? null;
  const isEmergency = changeType === 'EMERGENCY';

  // Employees may only raise a change for themselves; staff may raise on behalf.
  const requestedBy = scope.isAgent ? n(b.requestedBy) ?? ctx.userId ?? null : ctx.userId ?? null;
  const requestedByEmployeeId = scope.isAgent
    ? n(b.requestedByEmployeeId) ?? scope.employeeId
    : scope.employeeId;

  const numRes = await client.query<{ no: string }>('SELECT next_change_no($1, $2) AS no', [
    ctx.tenantId,
    ctx.companyId,
  ]);
  const changeNumber = numRes.rows[0]?.no;
  if (!changeNumber) throw conflict('Could not allocate a change number');

  const ins = await client.query<{ id: number }>(
    'INSERT INTO change_requests ' +
      '(tenant_id, company_id, branch_id, change_number, title, description, justification, change_type, ' +
      'category_id, subcategory_id, status, priority, risk_level, affected_systems, affected_asset_id, ' +
      'planned_start_at, planned_end_at, implementation_plan, backout_plan, test_plan, document_id, ' +
      'requested_by, requested_by_employee_id, assigned_to_user_id, assigned_team_id, related_ticket_id, ' +
      'related_problem_id, is_emergency, retrospective_approval_required, created_by, updated_by) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20," +
      '$21,$22,$23,$24,$25,$26,$27,$28,$29,$29) RETURNING id',
    [
      ctx.tenantId,
      ctx.companyId,
      ctx.branchId ?? null,
      changeNumber,
      title,
      s(b.description) ?? null,
      s(b.justification) ?? null,
      changeType,
      n(b.categoryId) ?? null,
      n(b.subcategoryId) ?? null,
      priority,
      riskLevel,
      strList(b.affectedSystems) ?? null,
      n(b.affectedAssetId) ?? null,
      s(b.plannedStartAt) ?? null,
      s(b.plannedEndAt) ?? null,
      s(b.implementationPlan) ?? null,
      s(b.backoutPlan) ?? null,
      s(b.testPlan) ?? null,
      n(b.documentId) ?? null,
      requestedBy,
      requestedByEmployeeId ?? null,
      n(b.assignedToUserId) ?? null,
      n(b.assignedTeamId) ?? null,
      n(b.relatedTicketId) ?? null,
      n(b.relatedProblemId) ?? null,
      isEmergency,
      isEmergency,
      ctx.userId ?? null,
    ]
  );
  const id = ins.rows[0].id;

  // An emergency change is implemented before it is ratified, so the
  // retrospective approval is recorded up front and blocks closure later.
  if (isEmergency) {
    await insertChangeApproval(client, ctx, id, {
      seq: 1,
      approvalType: 'RETROSPECTIVE',
      approverRole: 'service_desk_manager',
      approverUserId: null,
    });
  }

  const change = requireRow(await loadChange(client, ctx, id), 'Change request not found');
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'change_requests',
    recordId: id,
    recordCode: changeNumber,
    newValues: { title, changeType, priority, riskLevel, isEmergency },
  });
  await emitEvent(client, ctx, {
    eventType: 'service_desk.change.created',
    entityType: 'service_change',
    entityId: id,
    entityCode: changeNumber,
    payload: { title, change_type: changeType, priority, risk_level: riskLevel, is_emergency: isEmergency },
    severity: isEmergency ? 'WARN' : 'INFO',
  });
  await notifyChangeWatchers(client, ctx, change, {
    type: 'service_desk.change.created',
    title: (isEmergency ? 'Emergency change raised: ' : 'Change raised: ') + changeNumber,
    body: title,
    severity: isEmergency ? 'WARN' : 'INFO',
  });

  if (truthy(b.submit)) {
    return submitChangeForApproval(client, ctx, id, {});
  }
  return getChange(client, ctx, id);
}

const CHANGE_PATCH_COLUMNS: Record<string, string> = {
  title: 'title',
  description: 'description',
  justification: 'justification',
  categoryId: 'category_id',
  subcategoryId: 'subcategory_id',
  priority: 'priority',
  riskLevel: 'risk_level',
  affectedSystems: 'affected_systems',
  affectedAssetId: 'affected_asset_id',
  plannedStartAt: 'planned_start_at',
  plannedEndAt: 'planned_end_at',
  downtimeMinutes: 'downtime_minutes',
  implementationPlan: 'implementation_plan',
  backoutPlan: 'backout_plan',
  testPlan: 'test_plan',
  documentId: 'document_id',
  assignedToUserId: 'assigned_to_user_id',
  assignedTeamId: 'assigned_team_id',
  relatedTicketId: 'related_ticket_id',
  relatedProblemId: 'related_problem_id',
  requestedByEmployeeId: 'requested_by_employee_id',
};

export async function updateChange(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'update');
  if (!scope.canUpdate) throw forbidden('You cannot update change requests');
  if (!isChangeEditable(change.status)) {
    throw conflict('A change in status ' + change.status + ' can no longer be edited');
  }
  if (b.changeType !== undefined) {
    throw badRequest('changeType cannot be changed after creation; raise a new change instead');
  }

  const sets: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(CHANGE_PATCH_COLUMNS)) {
    if (b[key] === undefined) continue;
    if (col === 'affected_systems') {
      sets[col] = strList(b[key]) ?? null;
      continue;
    }
    if (col === 'title') {
      const t = s(b[key]);
      if (!t) throw badRequest('title cannot be empty');
      sets[col] = t;
      continue;
    }
    if (['priority', 'risk_level'].includes(col)) {
      const allowed = col === 'priority' ? CHANGE_PRIORITIES : CHANGE_RISK_LEVELS;
      const v = oneOf(b[key], allowed);
      if (!v) throw badRequest('Invalid ' + key);
      sets[col] = v;
      continue;
    }
    if (['category_id', 'subcategory_id', 'affected_asset_id', 'downtime_minutes', 'document_id', 'assigned_to_user_id', 'assigned_team_id', 'related_ticket_id', 'related_problem_id', 'requested_by_employee_id'].includes(col)) {
      sets[col] = n(b[key]) ?? null;
      continue;
    }
    sets[col] = s(b[key]) ?? null;
  }
  if (!Object.keys(sets).length) return getChange(client, ctx, change.id);
  await patchChange(client, ctx, change, sets, {
    action: 'update',
    eventType: 'service_desk.change.updated',
    note: 'Change details updated',
  });
  return getChange(client, ctx, change.id);
}

// ------------------------------------------------------------ approvals

export interface ChangeApprovalRow {
  id: number;
  change_id: number;
  seq: number;
  approval_type: string;
  approver_role: string | null;
  approver_user_id: number | null;
  status: string;
  decided_at: string | null;
  comments: string | null;
}

async function insertChangeApproval(
  client: pg.PoolClient,
  ctx: Ctx,
  changeId: number,
  a: { seq: number; approvalType: ChangeApprovalType; approverRole?: string | null; approverUserId?: number | null }
): Promise<number> {
  const res = await client.query<{ id: number }>(
    'INSERT INTO change_approvals ' +
      '(tenant_id, company_id, branch_id, change_id, seq, approval_type, approver_role, approver_user_id, ' +
      "status, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$9) RETURNING id",
    [
      ctx.tenantId,
      ctx.companyId,
      ctx.branchId ?? null,
      changeId,
      a.seq,
      a.approvalType,
      a.approverRole ?? null,
      a.approverUserId ?? null,
      ctx.userId ?? null,
    ]
  );
  return res.rows[0].id;
}

export async function listChangeApprovals(client: pg.PoolClient, ctx: Ctx, changeRef: number | string) {
  const change = requireRow(await loadChange(client, ctx, changeRef), 'Change request not found');
  const res = await client.query(
    'SELECT a.*, ' +
      "u.first_name || ' ' || u.last_name AS approver_name, " +
      "e.first_name || ' ' || e.last_name AS approver_employee_name " +
      'FROM change_approvals a ' +
      'LEFT JOIN users u ON u.id = a.approver_user_id ' +
      'LEFT JOIN employees e ON e.id = a.approver_employee_id ' +
      'WHERE a.change_id = $1 ORDER BY a.seq ASC, a.id ASC',
    [change.id]
  );
  return { items: res.rows };
}

/**
 * The authorisation chain a change must clear. Critical changes are assessed
 * for risk first, every normal change goes to the change advisory board, and
 * higher-risk changes additionally need an implementation authorisation.
 * Emergency changes carry a single retrospective ratification.
 */
function defaultApprovalChain(c: ChangeRow): Array<{ seq: number; approvalType: ChangeApprovalType; approverRole: string }> {
  const chain: Array<{ seq: number; approvalType: ChangeApprovalType; approverRole: string }> = [];
  let seq = 1;
  if (c.change_type === 'EMERGENCY') {
    chain.push({ seq: seq++, approvalType: 'RETROSPECTIVE', approverRole: 'service_desk_manager' });
    return chain;
  }
  if (c.risk_level === 'CRITICAL') {
    chain.push({ seq: seq++, approvalType: 'RISK', approverRole: 'it_support_administrator' });
  }
  chain.push({ seq: seq++, approvalType: 'CAB', approverRole: 'service_desk_manager' });
  if (c.risk_level === 'HIGH' || c.risk_level === 'CRITICAL') {
    chain.push({ seq: seq++, approvalType: 'IMPLEMENTATION', approverRole: 'it_support_administrator' });
  }
  return chain;
}

export async function submitChangeForApproval(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'submit');
  if (!scope.canSubmit) throw forbidden('You cannot submit change requests for approval');

  // A rejected change must be reworked before it can be resubmitted.
  if (change.status === 'REJECTED') {
    await applyChangeStatus(client, ctx, change.id, 'DRAFT', {
      eventType: 'service_desk.change.reworked',
      note: s(b.note) ?? 'Change reworked after rejection',
      notify: false,
    });
  } else if (!isChangeEditable(change.status)) {
    throw conflict('A change in status ' + change.status + ' cannot be submitted for approval');
  }

  const note = s(b.note) ?? null;
  // True when the change is entering the approval pipeline rather than continuing in it.
  const enteringApproval = change.status === 'REJECTED' || change.status === 'DRAFT';

  // Standard changes are pre-authorised by policy: they are recorded as
  // approved and go straight to the implementation backlog.
  if (change.change_type === 'STANDARD') {
    await insertChangeApproval(client, ctx, change.id, {
      seq: 1,
      approvalType: 'CAB',
      approverRole: 'change_policy',
      approverUserId: null,
    });
    await client.query(
      "UPDATE change_approvals SET status = 'SKIPPED', decided_at = now(), " +
        "comments = 'Pre-approved under the standard change policy', updated_by = $2 " +
        'WHERE change_id = $1 AND seq = 1',
      [change.id, ctx.userId ?? null]
    );
    return applyChangeStatus(client, ctx, change.id, 'APPROVED', {
      eventType: 'service_desk.change.approved',
      note: note ?? 'Standard change pre-approved by policy',
      severity: 'SUCCESS',
    });
  }

  // On a resubmission the prior rejections are retired rather than deleted so
  // the decision history survives, and the new chain continues the sequence.
  if (enteringApproval && change.change_type !== 'EMERGENCY') {
    const prior = await client.query<{ count: string; max_seq: number | null }>(
      "SELECT count(*)::text AS count, max(seq) AS max_seq FROM change_approvals WHERE change_id = $1",
      [change.id]
    );
    if (Number(prior.rows[0]?.count ?? 0) > 0) {
      await client.query(
        "UPDATE change_approvals SET status = 'SKIPPED', decided_at = now(), " +
          "comments = COALESCE(comments, 'Superseded by resubmission'), updated_by = $2 " +
          "WHERE change_id = $1 AND status IN ('REJECTED','PENDING')",
        [change.id, ctx.userId ?? null]
      );
    }
  }

  const pending = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM change_approvals WHERE change_id = $1 AND status = 'PENDING'",
    [change.id]
  );
  if (Number(pending.rows[0]?.count ?? 0) === 0) {
    const maxSeq = await client.query<{ max_seq: number | null }>(
      'SELECT max(seq) AS max_seq FROM change_approvals WHERE change_id = $1',
      [change.id]
    );
    let seq = Number(maxSeq.rows[0]?.max_seq ?? 0);
    const chain = defaultApprovalChain(change);
    for (const step of chain) {
      seq += 1;
      await insertChangeApproval(client, ctx, change.id, {
        seq,
        approvalType: step.approvalType,
        approverRole: step.approverRole,
        approverUserId: null,
      });
    }
  }

  const result = await applyChangeStatus(client, ctx, change.id, 'PENDING_APPROVAL', {
    eventType: 'service_desk.change.submitted',
    note: note ?? 'Submitted for approval',
  });
  const approvers = await changeApproverIds(client, ctx, change);
  await notifyUsers(client, ctx, approvers, {
    type: 'service_desk.change.submitted',
    title: 'Change awaiting your approval: ' + change.change_number,
    body: change.title,
    link: '/service-desk/changes/' + change.id,
    entityType: 'service_change',
    entityId: change.id,
    severity: 'INFO',
  });
  return result;
}

export interface DecideApprovalInput extends Record<string, unknown> {
  approvalId?: number;
  decision?: string;
  approve?: boolean;
  reject?: boolean;
  comments?: string;
  note?: string;
}

export async function decideChangeApproval(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: DecideApprovalInput = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'approve');
  if (!scope.canApprove) throw forbidden('You cannot approve change requests');
  if (change.status !== 'PENDING_APPROVAL') {
    throw conflict('This change is not awaiting approval');
  }
  // Mirrors ABAC-NO-SELF-APPROVE: the requester can never ratify their own change.
  if (ctx.userId && (sameId(change.created_by, ctx.userId) || sameId(change.requested_by, ctx.userId))) {
    throw forbidden('Segregation of duties: you cannot decide your own change request');
  }

  const decision = truthy(b.reject) || oneOf(b.decision, CHANGE_APPROVAL_STATUSES) === 'REJECTED'
    ? 'REJECTED'
    : 'APPROVED';

  const approvalId = n(b.approvalId);
  let approval: ChangeApprovalRow | null = null;
  if (approvalId) {
    const res = await client.query<ChangeApprovalRow>(
      'SELECT * FROM change_approvals WHERE id = $1 AND change_id = $2',
      [approvalId, change.id]
    );
    approval = res.rows[0] ?? null;
    if (!approval) throw notFound('Approval step not found on this change');
    if (approval.status !== 'PENDING') throw conflict('That approval step has already been decided');
  } else {
    const res = await client.query<ChangeApprovalRow>(
      "SELECT * FROM change_approvals WHERE change_id = $1 AND status = 'PENDING' " +
        'AND (approver_user_id = $2 OR approver_user_id IS NULL) ORDER BY seq ASC, id ASC LIMIT 1',
      [change.id, ctx.userId ?? -1]
    );
    approval = res.rows[0] ?? null;
    if (!approval) throw conflict('No pending approval step is assigned to you for this change');
  }

  const comments = s(b.comments) ?? s(b.note) ?? null;
  await client.query(
    'UPDATE change_approvals SET status = $4, decided_at = now(), comments = COALESCE($5, comments), ' +
      'approver_user_id = COALESCE(approver_user_id, $6), updated_by = $6 ' +
      'WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    [approval.id, ctx.tenantId, ctx.companyId, decision, comments, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: decision === 'APPROVED' ? 'approve' : 'reject',
    resource: 'change_approvals',
    recordId: approval.id,
    recordCode: change.change_number + '#' + String(approval.seq),
    oldValues: { status: approval.status, approval_type: approval.approval_type },
    newValues: { status: decision, comments },
  });

  if (decision === 'REJECTED') {
    return applyChangeStatus(client, ctx, change.id, 'REJECTED', {
      eventType: 'service_desk.change.rejected',
      note: comments ?? 'Rejected by ' + (approval.approver_role ?? 'approver'),
      severity: 'WARN',
    });
  }

  const remaining = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM change_approvals WHERE change_id = $1 AND status = 'PENDING'",
    [change.id]
  );
  if (Number(remaining.rows[0]?.count ?? 0) === 0) {
    return applyChangeStatus(client, ctx, change.id, 'APPROVED', {
      eventType: 'service_desk.change.approved',
      note: comments ?? 'All approvals recorded',
      severity: 'SUCCESS',
    });
  }

  const nextApprovers = await changeApproverIds(client, ctx, change);
  await notifyUsers(client, ctx, nextApprovers, {
    type: 'service_desk.change.approval_progress',
    title: 'Approval recorded for ' + change.change_number,
    body: comments ?? 'Further approvals are still required',
    link: '/service-desk/changes/' + change.id,
    entityType: 'service_change',
    entityId: change.id,
    severity: 'INFO',
  });
  return getChange(client, ctx, change.id);
}

export async function approveChange(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: DecideApprovalInput = {}
) {
  return decideChangeApproval(client, ctx, ref, { ...b, decision: 'APPROVED', reject: false });
}

export async function rejectChange(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: DecideApprovalInput = {}
) {
  return decideChangeApproval(client, ctx, ref, { ...b, decision: 'REJECTED', reject: true });
}

// ------------------------------------------------------------ status gate

const CHANGE_STATUS_STAMPS: Record<ChangeStatus, { at?: string; actor?: string }> = {
  DRAFT: {},
  RISK_ASSESSMENT: {},
  IMPACT_ANALYSIS: {},
  PENDING_APPROVAL: {},
  APPROVED: {},
  REJECTED: {},
  IMPLEMENTATION: { at: 'actual_start_at', actor: 'implemented_by' },
  VALIDATION: { at: 'actual_end_at' },
  CLOSED: { at: 'closed_at', actor: 'closed_by' },
  FAILED: { at: 'actual_end_at' },
  ROLLED_BACK: { at: 'actual_end_at' },
  CANCELLED: {},
};

/**
 * Single gate for every change status change: validates the edge, stamps the
 * matching lifecycle columns, audits, emits and notifies in one place so no
 * caller can move a change without leaving the same trail behind it.
 */
async function applyChangeStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  to: ChangeStatus,
  opts: {
    note?: string | null;
    eventType: string;
    notify?: boolean;
    notifyTargets?: Array<number | null | undefined>;
    extraSets?: Record<string, unknown>;
    severity?: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
  }
) {
  const change = requireRow(await loadChange(client, ctx, id), 'Change request not found');
  assertChangeTransition(change.status, to, change.change_type);

  const sets: string[] = ['status = $4', 'updated_by = $5'];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId, to, ctx.userId ?? null];

  const stamp = CHANGE_STATUS_STAMPS[to];
  if (stamp.at) sets.push(stamp.at + ' = now()');
  if (stamp.actor) sets.push(stamp.actor + ' = $5');
  for (const [col, val] of Object.entries(opts.extraSets ?? {})) {
    // undefined means "leave this column alone" so optional fields can be
    // passed through without clobbering an existing value.
    if (val === undefined) continue;
    params.push(val);
    sets.push(col + ' = $' + String(params.length));
  }

  await client.query(
    'UPDATE change_requests SET ' + sets.join(', ') + ' WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    params
  );

  await logAudit(client, ctx, {
    action: opts.eventType.split('.').pop() ?? 'update',
    resource: 'change_requests',
    recordId: id,
    recordCode: change.change_number,
    oldValues: { status: change.status },
    newValues: { status: to, note: opts.note ?? null },
  });
  await emitEvent(client, ctx, {
    eventType: opts.eventType,
    entityType: 'service_change',
    entityId: id,
    entityCode: change.change_number,
    payload: { from: change.status, to, title: change.title, change_type: change.change_type },
    severity: opts.severity === 'SUCCESS' ? 'INFO' : opts.severity ?? 'INFO',
  });

  if (opts.notify !== false) {
    const targets = opts.notifyTargets ?? [change.created_by, change.requested_by, change.assigned_to_user_id];
    await notifyUsers(client, ctx, targets, {
      type: opts.eventType,
      title: 'Change ' + change.change_number + ' is now ' + to,
      body: opts.note ?? change.title,
      link: '/service-desk/changes/' + id,
      entityType: 'service_change',
      entityId: id,
      severity: opts.severity ?? (to === 'CLOSED' ? 'SUCCESS' : 'INFO'),
    });
  }
  return { id, change_number: change.change_number, status: to };
}

// ------------------------------------------------------------ assessment

export async function assessRisk(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'risk_assessment');
  if (!scope.canUpdate) throw forbidden('You cannot update change requests');
  if (!isChangeEditable(change.status)) {
    throw conflict('Risk cannot be reassessed once the change is ' + change.status);
  }
  const riskLevel = oneOf(b.riskLevel, CHANGE_RISK_LEVELS);
  if (!riskLevel) throw badRequest('riskLevel must be one of ' + CHANGE_RISK_LEVELS.join(', '));
  const note = s(b.note) ?? 'Risk assessed as ' + riskLevel;
  const sets = { risk_level: riskLevel, risk_assessment: s(b.riskAssessment) ?? null };

  if (change.status === 'DRAFT') {
    return applyChangeStatus(client, ctx, change.id, 'RISK_ASSESSMENT', {
      eventType: 'service_desk.change.risk_assessed',
      note,
      extraSets: sets,
      severity: riskLevel === 'CRITICAL' ? 'WARN' : 'INFO',
    });
  }
  await patchChange(client, ctx, change, sets, {
    action: 'risk_assessment',
    eventType: 'service_desk.change.risk_assessed',
    note,
    severity: riskLevel === 'CRITICAL' ? 'WARN' : 'INFO',
  });
  return getChange(client, ctx, change.id);
}

export async function assessImpact(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'impact_analysis');
  if (!scope.canUpdate) throw forbidden('You cannot update change requests');
  if (!isChangeEditable(change.status)) {
    throw conflict('Impact cannot be reassessed once the change is ' + change.status);
  }
  const impactAnalysis = s(b.impactAnalysis);
  if (!impactAnalysis) throw badRequest('impactAnalysis is required');
  const note = s(b.note) ?? 'Impact analysis recorded';
  const sets: Record<string, unknown> = {
    impact_analysis: impactAnalysis,
    affected_systems: strList(b.affectedSystems) ?? undefined,
    affected_asset_id: n(b.affectedAssetId),
    downtime_minutes: n(b.downtimeMinutes),
    planned_start_at: s(b.plannedStartAt),
    planned_end_at: s(b.plannedEndAt),
  };

  if (change.status === 'DRAFT' || change.status === 'RISK_ASSESSMENT') {
    return applyChangeStatus(client, ctx, change.id, 'IMPACT_ANALYSIS', {
      eventType: 'service_desk.change.impact_assessed',
      note,
      extraSets: sets,
    });
  }
  await patchChange(client, ctx, change, sets, {
    action: 'impact_analysis',
    eventType: 'service_desk.change.impact_assessed',
    note,
  });
  return getChange(client, ctx, change.id);
}

// ------------------------------------------------------------ implementation

export async function startImplementation(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'implement');
  if (!scope.canImplement) throw forbidden('You cannot implement change requests');
  if (!canStartImplementation(change)) {
    throw conflict('A change in status ' + change.status + ' cannot start implementation');
  }
  // A rollback route is the core control that makes a normal change safe to run.
  if (change.change_type === 'NORMAL' && !change.backout_plan && !s(b.backoutPlan)) {
    throw badRequest('A backout plan is required before implementation begins');
  }
  return applyChangeStatus(client, ctx, change.id, 'IMPLEMENTATION', {
    eventType: 'service_desk.change.implementation_started',
    note: s(b.note) ?? 'Implementation started',
    extraSets: {
      backout_plan: s(b.backoutPlan),
      implementation_plan: s(b.implementationPlan),
      assigned_to_user_id: n(b.assignedToUserId),
    },
  });
}

export async function completeImplementation(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'implement');
  if (!scope.canImplement) throw forbidden('You cannot implement change requests');
  if (change.status !== 'IMPLEMENTATION') {
    throw conflict('Only a change under implementation can be completed');
  }
  return applyChangeStatus(client, ctx, change.id, 'VALIDATION', {
    eventType: 'service_desk.change.implementation_completed',
    note: s(b.note) ?? 'Implementation completed; awaiting validation',
    extraSets: {
      downtime_minutes: n(b.downtimeMinutes),
      test_plan: s(b.testPlan),
      validation_notes: s(b.validationNotes),
    },
  });
}

export async function validateChange(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'validate');
  if (!scope.canValidate) throw forbidden('You cannot validate change requests');
  if (change.status !== 'VALIDATION') {
    throw conflict('Only a change in validation can be validated');
  }
  const notes = s(b.validationNotes) ?? s(b.note);
  if (!notes) throw badRequest('validationNotes is required');
  await patchChange(
    client,
    ctx,
    change,
    {
      validation_notes: notes,
      validated_by: ctx.userId ?? null,
      validated_at: new Date().toISOString(),
    },
    { action: 'validate', eventType: 'service_desk.change.validated', note: notes, severity: 'SUCCESS' }
  );
  await notifyChangeWatchers(client, ctx, change, {
    type: 'service_desk.change.validated',
    title: 'Change validated: ' + change.change_number,
    body: notes,
    severity: 'SUCCESS',
  });
  return getChange(client, ctx, change.id);
}

export async function failValidation(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'validate');
  if (!scope.canValidate) throw forbidden('You cannot validate change requests');
  if (change.status !== 'VALIDATION') {
    throw conflict('Only a change in validation can be failed');
  }
  const reason = s(b.reason) ?? s(b.note);
  if (!reason) throw badRequest('reason is required');
  return applyChangeStatus(client, ctx, change.id, 'FAILED', {
    eventType: 'service_desk.change.validation_failed',
    note: reason,
    extraSets: { validation_notes: reason },
    severity: 'WARN',
  });
}

export async function rollbackChange(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'rollback');
  if (!scope.canImplement) throw forbidden('You cannot roll back change requests');
  const reason = s(b.reason) ?? s(b.note);
  if (!reason) throw badRequest('A rollback reason is required');
  if (!['IMPLEMENTATION', 'VALIDATION', 'CLOSED', 'FAILED'].includes(change.status)) {
    throw conflict('A change in status ' + change.status + ' cannot be rolled back');
  }
  return applyChangeStatus(client, ctx, change.id, 'ROLLED_BACK', {
    eventType: 'service_desk.change.rolled_back',
    note: reason,
    extraSets: { validation_notes: reason },
    severity: 'WARN',
  });
}

export async function closeChange(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'close');
  if (!scope.canClose) throw forbidden('You cannot close change requests');
  // An emergency change is implemented first and ratified afterwards, so it
  // stays open until that ratification exists.
  if (change.retrospective_approval_required && change.retrospective_approval_at === null) {
    throw conflict('This emergency change cannot be closed until the retrospective approval is recorded');
  }
  if (!['VALIDATION', 'ROLLED_BACK'].includes(change.status)) {
    throw conflict('A change in status ' + change.status + ' cannot be closed');
  }
  return applyChangeStatus(client, ctx, change.id, 'CLOSED', {
    eventType: 'service_desk.change.closed',
    note: s(b.note) ?? 'Change closed',
    severity: 'SUCCESS',
  });
}

export async function cancelChange(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'cancel');
  if (!scope.canCancel) throw forbidden('You cannot cancel change requests');
  const reason = s(b.reason) ?? s(b.note);
  if (!reason) throw badRequest('A cancellation reason is required');
  if (change.status === 'CLOSED') throw conflict('A closed change cannot be cancelled');
  const allowed = CHANGE_TRANSITIONS[change.status as ChangeStatus] ?? [];
  if (!allowed.includes('CANCELLED')) {
    throw conflict('A change in status ' + change.status + ' cannot be cancelled');
  }
  return applyChangeStatus(client, ctx, change.id, 'CANCELLED', {
    eventType: 'service_desk.change.cancelled',
    note: reason,
    severity: 'WARN',
  });
}

/**
 * Emergency changes are implemented before they are authorised. Ratifying them
 * afterwards is a separate, attributed act that unblocks closure.
 */
export async function recordRetrospectiveApproval(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { change, scope } = await changeActionContext(client, ctx, ref, 'retrospective_approval');
  if (!scope.canApprove) throw forbidden('You cannot record retrospective approvals');
  if (!change.is_emergency) throw conflict('Retrospective approval only applies to emergency changes');
  if (change.retrospective_approval_at !== null) {
    throw conflict('Retrospective approval has already been recorded for this change');
  }
  // Mirrors ABAC-NO-SELF-APPROVE across everybody who touched the deviation.
  if (
    ctx.userId &&
    idIn([change.created_by, change.requested_by, change.implemented_by], ctx.userId)
  ) {
    throw forbidden('Segregation of duties: you cannot ratify your own emergency change');
  }
  const justification = s(b.justification) ?? s(b.note);
  if (!justification) throw badRequest('justification is required for a retrospective approval');

  const approved = b.approved === undefined ? true : truthy(b.approved);
  if (!approved) {
    await logAudit(client, ctx, {
      action: 'retrospective_rejected',
      resource: 'change_requests',
      recordId: change.id,
      recordCode: change.change_number,
      newValues: { justification },
    });
    await notifyChangeWatchers(client, ctx, change, {
      type: 'service_desk.change.retrospective_rejected',
      title: 'Retrospective approval refused: ' + change.change_number,
      body: justification,
      severity: 'ERROR',
    });
    return getChange(client, ctx, change.id);
  }

  await patchChange(
    client,
    ctx,
    change,
    {
      retrospective_approved_by: ctx.userId ?? null,
      retrospective_approval_at: new Date().toISOString(),
      retrospective_justification: justification,
    },
    {
      action: 'retrospective_approval',
      eventType: 'service_desk.change.retrospectively_approved',
      note: justification,
      severity: 'SUCCESS',
    }
  );
  await client.query(
    "UPDATE change_approvals SET status = 'APPROVED', decided_at = now(), approver_user_id = $2, " +
      'comments = COALESCE($3, comments), updated_by = $2 ' +
      "WHERE change_id = $1 AND approval_type = 'RETROSPECTIVE' AND status = 'PENDING'",
    [change.id, ctx.userId ?? null, justification]
  );
  const fresh = requireRow(await loadChange(client, ctx, change.id), 'Change request not found');
  await notifyChangeWatchers(client, ctx, fresh, {
    type: 'service_desk.change.retrospectively_approved',
    title: 'Emergency change ratified: ' + change.change_number,
    body: justification,
    severity: 'SUCCESS',
  });
  return getChange(client, ctx, change.id);
}

// ------------------------------------------------------------ views

/**
 * Planned changes in a window, for the change calendar. Emergency changes that
 * were implemented outside a window still appear because the fallback ordering
 * key is the recorded creation time.
 */
export async function changeCalendar(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const scope = await resolveChangeScope(client, ctx);
  const from = s(q.from) ?? new Date(Date.now() - 7 * 86400000).toISOString();
  const to = s(q.to) ?? new Date(Date.now() + 30 * 86400000).toISOString();
  const params: unknown[] = [ctx.tenantId, ctx.companyId, from, to];

  let sql =
    'SELECT c.id, c.change_number, c.title, c.change_type, c.status, c.priority, c.risk_level, ' +
    'c.planned_start_at, c.planned_end_at, c.actual_start_at, c.actual_end_at, c.is_emergency, ' +
    'c.retrospective_approval_required, c.retrospective_approval_at, cat.name AS category_name, ' +
    "u.first_name || ' ' || u.last_name AS assigned_to_name " +
    'FROM change_requests c ' +
    'LEFT JOIN service_categories cat ON cat.id = c.category_id ' +
    'LEFT JOIN users u ON u.id = c.assigned_to_user_id ' +
    'WHERE c.tenant_id = $1 AND c.company_id = $2 ' +
    'AND COALESCE(c.planned_start_at, c.created_at) >= $3::timestamptz ' +
    'AND COALESCE(c.planned_start_at, c.created_at) <= $4::timestamptz';

  const extra: string[] = [];
  const changeType = oneOf(q.changeType, CHANGE_TYPES);
  if (changeType) {
    params.push(changeType);
    extra.push('c.change_type = $' + String(params.length));
  }
  const status = oneOf(q.status, CHANGE_STATUSES);
  if (status) {
    params.push(status);
    extra.push('c.status = $' + String(params.length));
  } else if (!truthy(q.includeCancelled)) {
    extra.push("c.status <> 'CANCELLED'");
  }
  // Employees only ever see their own entries on the calendar.
  if (!scope.isAgent && !scope.isAdmin) {
    params.push(scope.userId ?? -1);
    extra.push('(c.created_by = $' + String(params.length) + ' OR c.requested_by = $' + String(params.length) + ')');
  }
  if (extra.length) sql += ' AND ' + extra.join(' AND ');
  sql += ' ORDER BY COALESCE(c.planned_start_at, c.created_at) ASC, c.id ASC LIMIT 500';

  const res = await client.query(sql, params);
  return { from, to, items: res.rows };
}

export async function changeDashboard(client: pg.PoolClient, ctx: Ctx) {
  const scope = await resolveChangeScope(client, ctx);
  const base = [ctx.tenantId, ctx.companyId];

  const byStatus = await client.query<{ status: string; count: string }>(
    'SELECT status, count(*)::text AS count FROM change_requests ' +
      'WHERE tenant_id = $1 AND company_id = $2 GROUP BY status',
    base
  );
  const byType = await client.query<{ change_type: string; count: string }>(
    'SELECT change_type, count(*)::text AS count FROM change_requests ' +
      'WHERE tenant_id = $1 AND company_id = $2 GROUP BY change_type',
    base
  );
  const byRisk = await client.query<{ risk_level: string | null; count: string }>(
    "SELECT risk_level, count(*)::text AS count FROM change_requests " +
      "WHERE tenant_id = $1 AND company_id = $2 AND status NOT IN ('CLOSED','CANCELLED') " +
      'GROUP BY risk_level',
    base
  );
  const unratified = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM change_requests WHERE tenant_id = $1 AND company_id = $2 ' +
      'AND is_emergency AND retrospective_approval_required AND retrospective_approval_at IS NULL',
    base
  );
  const awaitingApproval = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM change_requests WHERE tenant_id = $1 AND company_id = $2 " +
      "AND status = 'PENDING_APPROVAL'",
    base
  );
  // Change approval is role-scoped, so My Approvals is the sum of pending steps
  // that either name the caller or name nobody and are therefore claimable.
  const myApprovals = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM change_requests c WHERE c.tenant_id = $1 AND c.company_id = $2 " +
      "AND c.status = 'PENDING_APPROVAL' AND EXISTS (SELECT 1 FROM change_approvals a " +
      "WHERE a.change_id = c.id AND a.status = 'PENDING' " +
      'AND (a.approver_user_id = $3 OR a.approver_user_id IS NULL))',
    [ctx.tenantId, ctx.companyId, scope.userId ?? -1]
  );
  const upcoming = await client.query(
    "SELECT c.id, c.change_number, c.title, c.change_type, c.status, c.risk_level, c.is_emergency, " +
      'c.planned_start_at, c.planned_end_at ' +
      'FROM change_requests c WHERE c.tenant_id = $1 AND c.company_id = $2 ' +
      "AND c.status NOT IN ('CLOSED','CANCELLED','REJECTED') AND c.planned_start_at IS NOT NULL " +
      "AND c.planned_start_at >= now() AND c.planned_start_at <= now() + interval '14 days' " +
      'ORDER BY c.planned_start_at ASC LIMIT 10',
    base
  );
  const overdue = await client.query(
    "SELECT c.id, c.change_number, c.title, c.change_type, c.status, c.planned_end_at " +
      'FROM change_requests c WHERE c.tenant_id = $1 AND c.company_id = $2 ' +
      "AND c.status NOT IN ('CLOSED','CANCELLED','REJECTED','FAILED','ROLLED_BACK') " +
      'AND c.planned_end_at IS NOT NULL AND c.planned_end_at < now() ' +
      'ORDER BY c.planned_end_at ASC LIMIT 10',
    base
  );
  const outcomes = await client.query<{ closed: string; failed: string; rolled_back: string }>(
    "SELECT count(*) FILTER (WHERE status = 'CLOSED')::text AS closed, " +
      "count(*) FILTER (WHERE status = 'FAILED')::text AS failed, " +
      "count(*) FILTER (WHERE status = 'ROLLED_BACK')::text AS rolled_back " +
      'FROM change_requests WHERE tenant_id = $1 AND company_id = $2',
    base
  );

  const counts = (rows: Array<{ count: string }>, key: string) => {
    const out: Record<string, number> = {};
    for (const r of rows as Array<Record<string, unknown>>) {
      const k = String(r[key] ?? 'UNSPECIFIED');
      out[k] = Number(r.count);
    }
    return out;
  };

  const statusCounts = counts(byStatus.rows, 'status');
  const closed = Number(outcomes.rows[0]?.closed ?? 0);
  const failed = Number(outcomes.rows[0]?.failed ?? 0);
  const rolledBack = Number(outcomes.rows[0]?.rolled_back ?? 0);
  const completed = closed + failed + rolledBack;
  const activeStatuses = ['DRAFT', 'RISK_ASSESSMENT', 'IMPACT_ANALYSIS', 'PENDING_APPROVAL', 'APPROVED', 'IMPLEMENTATION', 'VALIDATION'];

  return {
    activeChanges: activeStatuses.reduce((sum, k) => sum + (statusCounts[k] ?? 0), 0),
    awaitingApproval: Number(awaitingApproval.rows[0]?.count ?? 0),
    myApprovals: Number(myApprovals.rows[0]?.count ?? 0),
    unratifiedEmergencyChanges: Number(unratified.rows[0]?.count ?? 0),
    implementedChanges: statusCounts.CLOSED ?? 0,
    failedChanges: statusCounts.FAILED ?? 0,
    rolledBackChanges: statusCounts.ROLLED_BACK ?? 0,
    successRate:
      completed === 0 ? null : Math.round(((closed / completed) * 100 + Number.EPSILON) * 10) / 10,
    byStatus: statusCounts,
    byType: counts(byType.rows, 'change_type'),
    byRisk: counts(byRisk.rows, 'risk_level'),
    upcomingChanges: upcoming.rows,
    overdueChanges: overdue.rows,
    scope: {
      isAgent: scope.isAgent,
      isAdmin: scope.isAdmin,
      canCreate: scope.canCreate,
      canApprove: scope.canApprove,
      canImplement: scope.canImplement,
    },
  };
}
