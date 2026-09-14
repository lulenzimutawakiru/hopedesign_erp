import pg from 'pg';
import {
  badRequest,
  conflict,
  emitEvent,
  forbidden,
  hasPerm,
  isNumericRef,
  logAudit,
  n,
  nn,
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
import { createTicket } from './serviceDesk.js';

/**
 * HOPE DESIGN Service Desk - Access requests (spec section 15).
 *
 *   EMPLOYEE -> REQUEST ERP ACCESS -> MANAGER APPROVAL ->
 *   SYSTEM / DATA OWNER APPROVAL -> RBAC ROLE ASSIGNMENT ->
 *   ABAC SCOPE CONFIGURATION -> ACCESS GRANTED -> AUDIT
 *
 * The Service Desk never grants access without the authorisation the policy
 * demands. Authorisation and provisioning are separate acts performed by
 * different people: an approver decides, and only a caller holding
 * service_desk.access_requests.grant can execute the grant - and never for a
 * request they raised themselves. Provisioning is refused until every approval
 * step the policy requires is APPROVED, so a skipped chain cannot be papered
 * over by handing out the role directly.
 */

export const ACCESS_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'MANAGER_APPROVED',
  'OWNER_APPROVED',
  'APPROVED',
  'REJECTED',
  'PROVISIONING',
  'GRANTED',
  'PROVISION_FAILED',
  'EXPIRED',
  'REVOKED',
  'CANCELLED',
] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

export const ACCESS_TYPES = [
  'ROLE',
  'PERMISSION',
  'MODULE',
  'DATA_SCOPE',
  'SHARED_MAILBOX',
  'VPN',
  'FOLDER',
  'DATABASE',
  'OTHER',
] as const;
export type AccessType = (typeof ACCESS_TYPES)[number];

export const ACCESS_DURATIONS = ['PERMANENT', 'TEMPORARY', 'DATE_BOUNDED'] as const;
export type AccessDuration = (typeof ACCESS_DURATIONS)[number];

/** Authorisation steps a request can be routed through, in pipeline order. */
export const ACCESS_STEPS = ['MANAGER', 'SYSTEM_OWNER', 'DATA_OWNER', 'SECURITY', 'ADMIN'] as const;
export type AccessStep = (typeof ACCESS_STEPS)[number];

export const ACCESS_APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'DELEGATED', 'SKIPPED'] as const;
export type AccessApprovalStatus = (typeof ACCESS_APPROVAL_STATUSES)[number];

export const ACCESS_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const ACCESS_DATA_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;

/** Access types that change RBAC, so they additionally need an ADMIN sign-off. */
const RBAC_ACCESS_TYPES: string[] = ['ROLE', 'PERMISSION', 'MODULE'];

/** Access types that reach into data, so the data owner authorises them. */
const DATA_ACCESS_TYPES: string[] = ['DATA_SCOPE', 'DATABASE', 'FOLDER'];

const ACCESS_TRANSITIONS: Record<AccessStatus, AccessStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['MANAGER_APPROVED', 'OWNER_APPROVED', 'APPROVED', 'REJECTED', 'CANCELLED'],
  MANAGER_APPROVED: ['OWNER_APPROVED', 'APPROVED', 'REJECTED', 'CANCELLED'],
  OWNER_APPROVED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['PROVISIONING', 'GRANTED', 'PROVISION_FAILED', 'REJECTED', 'CANCELLED'],
  PROVISIONING: ['GRANTED', 'PROVISION_FAILED'],
  PROVISION_FAILED: ['PROVISIONING', 'GRANTED', 'REJECTED', 'CANCELLED'],
  GRANTED: ['EXPIRED', 'REVOKED'],
  EXPIRED: ['REVOKED'],
  REVOKED: [],
  REJECTED: ['DRAFT', 'SUBMITTED', 'CANCELLED'],
  CANCELLED: ['DRAFT'],
};

export function assertAccessTransition(from: string, to: string): void {
  const allowed = ACCESS_TRANSITIONS[from as AccessStatus];
  if (!allowed) throw conflict('Unknown access request status: ' + from);
  if (from === to) return;
  if (allowed.includes(to as AccessStatus)) return;
  throw conflict('An access request cannot move from ' + from + ' to ' + to);
}

export interface AccessScope extends TicketScope {
  canView: boolean;
  canViewOwn: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canApprove: boolean;
  canReject: boolean;
  canGrant: boolean;
  canRevoke: boolean;
  canCancel: boolean;
}

const perm = (scope: TicketScope, p: string) => scope.isAdmin || hasPerm(scope.permissions, p);

export async function resolveAccessScope(client: pg.PoolClient, ctx: Ctx): Promise<AccessScope> {
  const base = await resolveScope(client, ctx);
  return {
    ...base,
    canView: perm(base, 'service_desk.access_requests.view') || perm(base, 'service_desk.tickets.view'),
    canViewOwn: true,
    canCreate: perm(base, 'service_desk.access_requests.create') || perm(base, 'service_desk.tickets.create'),
    canUpdate: perm(base, 'service_desk.access_requests.update'),
    canApprove: perm(base, 'service_desk.access_requests.approve'),
    canReject:
      perm(base, 'service_desk.access_requests.reject') || perm(base, 'service_desk.access_requests.approve'),
    canGrant: perm(base, 'service_desk.access_requests.grant'),
    canRevoke: perm(base, 'service_desk.access_requests.revoke'),
    canCancel: perm(base, 'service_desk.access_requests.cancel'),
  };
}
export interface AccessRow {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
  ticket_id: number;
  request_number: string;
  requester_employee_id: number | null;
  target_user_id: number | null;
  system_name: string;
  access_type: string;
  requested_role_code: string | null;
  requested_permissions: string[] | null;
  requested_scope: Record<string, unknown> | null;
  justification: string;
  duration: string;
  access_starts_at: string | null;
  access_expires_at: string | null;
  data_classification: string;
  risk_level: string | null;
  status: string;
  manager_approval_required: boolean;
  owner_approval_required: boolean;
  current_step: number;
  granted_role_id: number | null;
  granted_by: number | null;
  granted_at: string | null;
  revoked_by: number | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_by: number | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
}

export async function loadAccessRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string
): Promise<AccessRow | null> {
  const res =
    isNumericRef(ref)
      ? await client.query<AccessRow>(
          'SELECT ar.* FROM access_requests ar WHERE ar.id = $1 AND ar.tenant_id = $2 AND ar.company_id = $3',
          [Number(ref), ctx.tenantId, ctx.companyId]
        )
      : await client.query<AccessRow>(
          'SELECT ar.* FROM access_requests ar WHERE ar.request_number = $1 AND ar.tenant_id = $2 AND ar.company_id = $3',
          [String(ref), ctx.tenantId, ctx.companyId]
        );
  return res.rows[0] ?? null;
}

/**
 * Publish the ABAC facts for an access request. owner_user_id is the person who
 * raised the request, which is what ABAC-NO-SELF-APPROVE compares against the
 * subject, so a requester can never wave their own request through.
 */
export function accessResourceAttributes(
  scope: AccessScope,
  row: AccessRow,
  action: string
): Record<string, unknown> {
  const isOwner = sameId(row.created_by, scope.userId);
  const isTarget = sameId(row.target_user_id, scope.userId);
  const isApprover = scope.canApprove || scope.canGrant;
  const inReach = scope.isAdmin || isOwner || isTarget || isApprover;
  const attrs: Record<string, unknown> = {
    module: 'service_desk',
    resource: 'access_requests',
    action,
    access_request_id: row.id,
    request_number: row.request_number,
    access_type: row.access_type,
    system_name: row.system_name,
    status: row.status,
    data_classification: row.data_classification,
    risk_level: row.risk_level,
    owner_user_id: row.created_by,
    target_user_id: row.target_user_id,
    is_self_request: isOwner,
    service_desk_agent: scope.isAgent,
    service_desk_internal_notes: scope.canViewInternalNotes,
    service_desk_readonly: false,
    classified_denied: false,
  };
  if (!inReach) attrs.scope_denied = true;
  return attrs;
}

export interface AccessActionContext {
  request: AccessRow;
  scope: AccessScope;
  attributes: Record<string, unknown>;
}

/** Load a request, publish ABAC facts, and refuse out-of-scope callers. */
export async function accessActionContext(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  action: string
): Promise<AccessActionContext> {
  const request = await loadAccessRequest(client, ctx, ref);
  if (!request) throw notFound('Access request not found');
  const scope = await resolveAccessScope(client, ctx);
  const attributes = accessResourceAttributes(scope, request, action);
  ctx.resourceAttributes = { ...(ctx.resourceAttributes ?? {}), ...attributes };
  if (attributes.scope_denied === true) {
    throw forbidden('This access request is outside your service desk scope');
  }
  return { request, scope, attributes };
}

const label = (row: AccessRow) => row.request_number + ' - ' + row.system_name;

// ------------------------------------------------------------ read model

const ACCESS_SORTS: Record<string, string> = {
  newest: 'ar.created_at DESC, ar.id DESC',
  oldest: 'ar.created_at ASC, ar.id ASC',
  expiry: 'ar.access_expires_at ASC NULLS LAST, ar.id DESC',
  risk: "CASE ar.risk_level WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, ar.created_at DESC",
  number: 'ar.request_number ASC',
};

export interface ListAccessRequestsQuery extends Record<string, unknown> {
  status?: string;
  statuses?: string;
  accessType?: string;
  systemName?: string;
  riskLevel?: string;
  dataClassification?: string;
  requesterEmployeeId?: number;
  targetUserId?: number;
  ticketId?: number;
  pendingMyApproval?: boolean;
  awaitingProvisioning?: boolean;
  mine?: boolean;
  search?: string;
  from?: string;
  to?: string;
  sortBy?: string;
  page?: number;
  pageSize?: number;
}

export async function listAccessRequests(
  client: pg.PoolClient,
  ctx: Ctx,
  q: ListAccessRequestsQuery = {}
) {
  const scope = await resolveAccessScope(client, ctx);
  const { page, pageSize: limit, offset } = parsePagination(q as Record<string, unknown>);
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where: string[] = ['ar.tenant_id = $1', 'ar.company_id = $2'];

  const status = s(q.status);
  if (status) {
    params.push(status.toUpperCase());
    where.push('ar.status = $' + String(params.length));
  }
  const statuses = strList(q.statuses);
  if (statuses && statuses.length) {
    params.push(statuses.map((x) => x.toUpperCase()));
    where.push('ar.status = ANY($' + String(params.length) + ')');
  }
  const accessType = s(q.accessType);
  if (accessType) {
    params.push(accessType.toUpperCase());
    where.push('ar.access_type = $' + String(params.length));
  }
  const systemName = s(q.systemName);
  if (systemName) {
    params.push(systemName);
    where.push('ar.system_name = $' + String(params.length));
  }
  const risk = s(q.riskLevel);
  if (risk) {
    params.push(risk.toUpperCase());
    where.push('ar.risk_level = $' + String(params.length));
  }
  const classification = s(q.dataClassification);
  if (classification) {
    params.push(classification.toUpperCase());
    where.push('ar.data_classification = $' + String(params.length));
  }
  const requester = n(q.requesterEmployeeId);
  if (requester) {
    params.push(requester);
    where.push('ar.requester_employee_id = $' + String(params.length));
  }
  const target = n(q.targetUserId);
  if (target) {
    params.push(target);
    where.push('ar.target_user_id = $' + String(params.length));
  }
  const ticketId = n(q.ticketId);
  if (ticketId) {
    params.push(ticketId);
    where.push('ar.ticket_id = $' + String(params.length));
  }
  if (truthy(q.pendingMyApproval) && scope.userId) {
    params.push(scope.userId);
    where.push(
      "EXISTS (SELECT 1 FROM access_approvals a WHERE a.access_request_id = ar.id AND a.status = 'PENDING' " +
        'AND a.approver_user_id = $' + String(params.length) + ')'
    );
  }
  if (truthy(q.awaitingProvisioning)) {
    where.push("ar.status = 'APPROVED'");
  }
  if (truthy(q.mine)) {
    params.push(scope.userId ?? -1, scope.employeeId ?? -1);
    where.push(
      '(ar.created_by = $' + String(params.length - 1) + ' OR ar.requester_employee_id = $' +
        String(params.length) + ')'
    );
  }
  const search = s(q.search);
  if (search) {
    params.push('%' + search + '%');
    const ref = '$' + String(params.length);
    where.push(
      '(ar.request_number ILIKE ' + ref + ' OR ar.system_name ILIKE ' + ref +
        ' OR ar.justification ILIKE ' + ref + ')'
    );
  }
  const from = s(q.from);
  if (from) {
    params.push(from);
    where.push('ar.created_at >= $' + String(params.length) + '::timestamptz');
  }
  const to = s(q.to);
  if (to) {
    params.push(to);
    where.push('ar.created_at <= $' + String(params.length) + '::timestamptz');
  }

  // Staff with view rights see the desk; everyone else only ever reaches the
  // requests they raised, are the target of, or must approve.
  if (!scope.canView) {
    params.push(scope.userId ?? -1, scope.employeeId ?? -1);
    where.push(
      '(ar.created_by = $' + String(params.length - 1) + ' OR ar.target_user_id = $' +
        String(params.length - 1) + ' OR ar.requester_employee_id = $' + String(params.length) +
        " OR EXISTS (SELECT 1 FROM access_approvals a WHERE a.access_request_id = ar.id AND a.approver_user_id = $" +
        String(params.length - 1) + '))'
    );
  }

  // String(q.sortBy) would yield the literal string "undefined" when the
  // caller omits sortBy, producing `ORDER BY undefined` and a 500 (42703).
  // The default has to be applied to the value, not only to the guard.
  const sortKey = Object.keys(ACCESS_SORTS).includes(String(q.sortBy ?? 'newest'))
    ? String(q.sortBy ?? 'newest')
    : 'newest';
  const whereSql = where.join(' AND ');
  const totalRes = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM access_requests ar WHERE ' + whereSql,
    params
  );
  const rows = await client.query(
    'SELECT ar.*, t.ticket_number, t.subject, t.priority, t.status AS ticket_status, ' +
      "e.first_name || ' ' || e.last_name AS requester_name, e.employee_no AS requester_employee_no, " +
      "tu.first_name || ' ' || tu.last_name AS target_name, " +
      "ru.first_name || ' ' || ru.last_name AS created_by_name, " +
      "r.code AS granted_role_code, r.name AS granted_role_name, " +
      "(SELECT count(*)::int FROM access_approvals a WHERE a.access_request_id = ar.id AND a.status = 'PENDING') AS pending_approvals, " +
      "(SELECT a.step FROM access_approvals a WHERE a.access_request_id = ar.id AND a.status = 'PENDING' " +
      'ORDER BY a.seq ASC, a.id ASC LIMIT 1) AS next_step ' +
      'FROM access_requests ar ' +
      'LEFT JOIN service_tickets t ON t.id = ar.ticket_id ' +
      'LEFT JOIN employees e ON e.id = ar.requester_employee_id ' +
      'LEFT JOIN users tu ON tu.id = ar.target_user_id ' +
      'LEFT JOIN users ru ON ru.id = ar.created_by ' +
      'LEFT JOIN roles r ON r.id = ar.granted_role_id ' +
      'WHERE ' + whereSql + ' ORDER BY ' + ACCESS_SORTS[sortKey] + ' LIMIT ' + String(limit) +
      ' OFFSET ' + String(offset),
    params
  );
  return paged(rows.rows, Number(totalRes.rows[0]?.count ?? 0), page, limit, offset);
}
// ------------------------------------------------------------ detail

export interface AccessRequestDetail {
  request: Record<string, unknown>;
  approvals: unknown[];
  permissions: Record<string, boolean>;
}

export async function getAccessRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string
): Promise<AccessRequestDetail> {
  const { request, scope } = await accessActionContext(client, ctx, ref, 'view');
  const detail = await client.query(
    'SELECT ar.*, t.ticket_number, t.subject, t.description AS ticket_description, ' +
      't.priority, t.status AS ticket_status, t.assigned_to_user_id, ' +
      "e.first_name || ' ' || e.last_name AS requester_name, e.employee_no AS requester_employee_no, " +
      "e.email AS requester_email, d.name AS requester_department_name, " +
      "tu.first_name || ' ' || tu.last_name AS target_name, tu.email AS target_email, " +
      "cu.first_name || ' ' || cu.last_name AS created_by_name, " +
      "gb.first_name || ' ' || gb.last_name AS granted_by_name, " +
      "rb.first_name || ' ' || rb.last_name AS revoked_by_name, " +
      'r.code AS granted_role_code, r.name AS granted_role_name ' +
      'FROM access_requests ar ' +
      'LEFT JOIN service_tickets t ON t.id = ar.ticket_id ' +
      'LEFT JOIN employees e ON e.id = ar.requester_employee_id ' +
      'LEFT JOIN departments d ON d.id = e.department_id ' +
      'LEFT JOIN users tu ON tu.id = ar.target_user_id ' +
      'LEFT JOIN users cu ON cu.id = ar.created_by ' +
      'LEFT JOIN users gb ON gb.id = ar.granted_by ' +
      'LEFT JOIN users rb ON rb.id = ar.revoked_by ' +
      'LEFT JOIN roles r ON r.id = ar.granted_role_id ' +
      'WHERE ar.id = $1',
    [request.id]
  );
  const approvals = await client.query(
    'SELECT a.*, ' +
      "u.first_name || ' ' || u.last_name AS approver_name, " +
      "e.first_name || ' ' || e.last_name AS approver_employee_name " +
      'FROM access_approvals a ' +
      'LEFT JOIN users u ON u.id = a.approver_user_id ' +
      'LEFT JOIN employees e ON e.id = a.approver_employee_id ' +
      'WHERE a.access_request_id = $1 ORDER BY a.seq ASC, a.id ASC',
    [request.id]
  );
  const canDecide = await isPendingApprover(client, ctx, request.id);
  return {
    request: detail.rows[0] ?? {},
    approvals: approvals.rows,
    permissions: {
      canView: scope.canView,
      canUpdate: scope.canUpdate && request.status === 'DRAFT',
      canApprove: scope.canApprove && canDecide,
      canReject: scope.canReject && canDecide,
      canGrant: scope.canGrant && request.status === 'APPROVED' && !sameId(request.created_by, scope.userId),
      canRevoke: scope.canRevoke && request.status === 'GRANTED',
      canCancel: scope.canCancel,
    },
  };
}

/** True when the caller is on the hook for a still-pending approval step. */
export async function isPendingApprover(
  client: pg.PoolClient,
  ctx: Ctx,
  accessRequestId: number
): Promise<boolean> {
  if (!ctx.userId) return false;
  const res = await client.query<{ ok: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM access_approvals WHERE access_request_id = $1 AND status = 'PENDING' " +
      'AND approver_user_id = $2) AS ok',
    [accessRequestId, ctx.userId]
  );
  return res.rows[0]?.ok === true;
}

async function notifyAccessWatchers(
  client: pg.PoolClient,
  ctx: Ctx,
  row: AccessRow,
  payload: { type: string; title: string; body?: string; severity?: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' }
) {
  const approvers = await usersWithPermission(client, ctx, 'service_desk.access_requests.approve');
  await notifyUsers(
    client,
    ctx,
    uniq([row.created_by, row.target_user_id, ...approvers.slice(0, 25)]),
    {
      type: payload.type,
      title: payload.title,
      body: payload.body,
      link: '/service-desk/access-requests/' + row.id,
      entityType: 'service_access_request',
      entityId: row.id,
      severity: payload.severity ?? 'INFO',
    }
  );
}

// ------------------------------------------------------------ authorisation chain

async function usersWithRole(
  client: pg.PoolClient,
  ctx: Ctx,
  roleCode: string
): Promise<number[]> {
  const res = await client.query<{ id: number }>(
    'SELECT DISTINCT ur.user_id AS id FROM user_roles ur ' +
      'JOIN roles r ON r.id = ur.role_id ' +
      'JOIN users u ON u.id = ur.user_id ' +
      "WHERE r.code = $1 AND u.status = 'ACTIVE' AND (u.company_id = $2 OR u.company_id IS NULL)",
    [roleCode, ctx.companyId]
  );
  return res.rows.map((r) => Number(r.id)).filter((id) => Number.isFinite(id) && id > 0);
}

async function employeeForUser(client: pg.PoolClient, userId: number | null): Promise<number | null> {
  if (!userId) return null;
  const res = await client.query<{ employee_id: number | null }>(
    'SELECT employee_id FROM users WHERE id = $1',
    [userId]
  );
  return res.rows[0]?.employee_id ?? null;
}

/**
 * Route one authorisation step to a named person where the organisation has an
 * accountable owner, and fall back to the approver pool when it does not - so a
 * step is never silently left with nobody able to action it.
 */
export async function resolveStepApprover(
  client: pg.PoolClient,
  ctx: Ctx,
  step: AccessStep,
  row: AccessRow
): Promise<{ userId: number | null; employeeId: number | null; approverRole: string }> {
  if (step === 'MANAGER') {
    if (row.requester_employee_id) {
      const head = await client.query<{ head_user_id: number | null }>(
        'SELECT d.head_user_id FROM employees e ' +
          'JOIN departments d ON d.id = e.department_id ' +
          "WHERE e.id = $1 AND d.status <> 'INACTIVE'",
        [row.requester_employee_id]
      );
      const headUserId = head.rows[0]?.head_user_id ?? null;
      // A department head cannot authorise their own access request.
      if (headUserId && !sameId(headUserId, row.created_by)) {
        return {
          userId: headUserId,
          employeeId: await employeeForUser(client, headUserId),
          approverRole: 'department_manager',
        };
      }
    }
  } else {
    const roleHint: Record<string, string> = {
      SYSTEM_OWNER: 'it_support_administrator',
      DATA_OWNER: 'data_owner',
      SECURITY: 'security_manager',
      ADMIN: 'system_administrator',
    };
    const holders = await usersWithRole(client, ctx, roleHint[step]);
    const pick = holders.find((id) => !sameId(id, row.created_by)) ?? holders[0] ?? null;
    if (pick) {
      return {
        userId: pick,
        employeeId: await employeeForUser(client, pick),
        approverRole: roleHint[step],
      };
    }
  }

  const pool = await usersWithPermission(client, ctx, 'service_desk.access_requests.approve');
  const pick = pool.find((id) => !sameId(id, row.created_by)) ?? pool[0] ?? null;
  return {
    userId: pick,
    employeeId: await employeeForUser(client, pick),
    approverRole: step.toLowerCase(),
  };
}

/**
 * The authorisation a request must clear. Manager sign-off protects the
 * business case, the system or data owner protects the system, RBAC changes add
 * an administrator, and elevated risk or classification adds a security review.
 */
export function defaultAccessChain(row: AccessRow): Array<{ seq: number; step: AccessStep }> {
  const chain: Array<{ seq: number; step: AccessStep }> = [];
  let seq = 1;
  if (row.manager_approval_required) chain.push({ seq: seq++, step: 'MANAGER' });
  if (row.owner_approval_required) {
    chain.push({ seq: seq++, step: DATA_ACCESS_TYPES.includes(row.access_type) ? 'DATA_OWNER' : 'SYSTEM_OWNER' });
  }
  if (RBAC_ACCESS_TYPES.includes(row.access_type)) chain.push({ seq: seq++, step: 'ADMIN' });
  const elevated =
    row.risk_level === 'CRITICAL' ||
    row.risk_level === 'HIGH' ||
    row.data_classification === 'CONFIDENTIAL' ||
    row.data_classification === 'RESTRICTED';
  if (elevated) chain.push({ seq: seq++, step: 'SECURITY' });
  return chain;
}

async function insertAccessApproval(
  client: pg.PoolClient,
  ctx: Ctx,
  accessRequestId: number,
  a: { seq: number; step: AccessStep; approverRole?: string | null; approverUserId?: number | null; approverEmployeeId?: number | null }
): Promise<number> {
  const res = await client.query<{ id: number }>(
    'INSERT INTO access_approvals ' +
      '(tenant_id, company_id, branch_id, access_request_id, seq, step, approver_role, approver_user_id, ' +
      'approver_employee_id, status, created_by) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10) RETURNING id",
    [
      ctx.tenantId,
      ctx.companyId,
      ctx.branchId ?? null,
      accessRequestId,
      a.seq,
      a.step,
      a.approverRole ?? null,
      a.approverUserId ?? null,
      a.approverEmployeeId ?? null,
      ctx.userId ?? null,
    ]
  );
  return res.rows[0].id;
}

/** Build the full authorisation chain for a request that has none yet. */
async function buildAccessChain(
  client: pg.PoolClient,
  ctx: Ctx,
  row: AccessRow,
  steps?: string[]
): Promise<number> {
  const existing = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM access_approvals WHERE access_request_id = $1',
    [row.id]
  );
  if (Number(existing.rows[0]?.count ?? 0) > 0) return 0;

  const chain: Array<{ seq: number; step: AccessStep }> = [];
  if (steps && steps.length) {
    let seq = 1;
    for (const raw of steps) {
      const step = oneOf(raw, ACCESS_STEPS);
      if (!step) throw badRequest('Unknown approval step: ' + String(raw));
      chain.push({ seq: seq++, step });
    }
  } else {
    chain.push(...defaultAccessChain(row));
  }
  if (!chain.length) throw conflict('This request has no authorisation steps to route');

  let created = 0;
  for (const item of chain) {
    const approver = await resolveStepApprover(client, ctx, item.step, row);
    await insertAccessApproval(client, ctx, row.id, {
      seq: item.seq,
      step: item.step,
      approverRole: approver.approverRole,
      approverUserId: approver.userId,
      approverEmployeeId: approver.employeeId,
    });
    created += 1;
  }
  return created;
}

export async function listAccessApprovals(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string
) {
  const row = requireRow(await loadAccessRequest(client, ctx, ref), 'Access request not found');
  const res = await client.query(
    'SELECT a.*, ' +
      "u.first_name || ' ' || u.last_name AS approver_name, " +
      "e.first_name || ' ' || e.last_name AS approver_employee_name " +
      'FROM access_approvals a ' +
      'LEFT JOIN users u ON u.id = a.approver_user_id ' +
      'LEFT JOIN employees e ON e.id = a.approver_employee_id ' +
      'WHERE a.access_request_id = $1 ORDER BY a.seq ASC, a.id ASC',
    [row.id]
  );
  return { items: res.rows, access_request_id: row.id, status: row.status, step: row.current_step };
}
// ------------------------------------------------------------ status gate

/** Actor and timestamp columns each terminal status must stamp. */
const ACCESS_STATUS_STAMPS: Record<string, { at?: string; actor?: string }> = {
  GRANTED: { at: 'granted_at', actor: 'granted_by' },
  REVOKED: { at: 'revoked_at', actor: 'revoked_by' },
};

async function applyAccessStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  to: AccessStatus,
  opts: {
    note?: string | null;
    eventType: string;
    notify?: boolean;
    notifyTargets?: Array<number | null | undefined>;
    extraSets?: Record<string, unknown>;
    severity?: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
  }
) {
  const row = requireRow(await loadAccessRequest(client, ctx, id), 'Access request not found');
  assertAccessTransition(row.status, to);

  const sets: string[] = ['status = $4', 'updated_by = $5'];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId, to, ctx.userId ?? null];

  const stamp = ACCESS_STATUS_STAMPS[to];
  if (stamp && stamp.at) sets.push(stamp.at + ' = now()');
  if (stamp && stamp.actor) sets.push(stamp.actor + ' = $5');
  for (const [col, val] of Object.entries(opts.extraSets ?? {})) {
    // undefined means "leave this column alone" so optional fields do not clobber.
    if (val === undefined) continue;
    params.push(val);
    sets.push(col + ' = $' + String(params.length));
  }

  await client.query(
    'UPDATE access_requests SET ' + sets.join(', ') + ' WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    params
  );

  await logAudit(client, ctx, {
    action: opts.eventType.split('.').pop() ?? 'update',
    resource: 'access_requests',
    recordId: id,
    recordCode: row.request_number,
    oldValues: { status: row.status },
    newValues: { status: to, note: opts.note ?? null },
  });
  await emitEvent(client, ctx, {
    eventType: opts.eventType,
    entityType: 'service_access_request',
    entityId: id,
    entityCode: row.request_number,
    payload: {
      from: row.status,
      to,
      system_name: row.system_name,
      access_type: row.access_type,
      target_user_id: row.target_user_id,
    },
    severity: opts.severity === 'SUCCESS' ? 'INFO' : opts.severity ?? 'INFO',
  });

  if (opts.notify !== false) {
    const targets = opts.notifyTargets ?? [row.created_by, row.target_user_id];
    await notifyUsers(client, ctx, targets, {
      type: opts.eventType,
      title: 'Access request ' + row.request_number + ' is now ' + to,
      body: opts.note ?? row.system_name,
      link: '/service-desk/access-requests/' + id,
      entityType: 'service_access_request',
      entityId: id,
      severity: opts.severity ?? (to === 'GRANTED' ? 'SUCCESS' : 'INFO'),
    });
  }
  return { id, request_number: row.request_number, status: to };
}

/**
 * Recompute the request status from the approvals on record. Deriving it from
 * the chain rather than incrementing it keeps the status honest when steps are
 * skipped, delegated or satisfied out of order.
 */
async function recomputeAccessStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  row: AccessRow,
  note: string
): Promise<string> {
  const agg = await client.query<{ step: string; status: string; pending: string }>(
    'SELECT step, status, ' +
      "count(*) FILTER (WHERE status = 'PENDING')::text AS pending " +
      'FROM access_approvals WHERE access_request_id = $1 GROUP BY step, status',
    [row.id]
  );
  const pendingAny = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM access_approvals WHERE access_request_id = $1 AND status = 'PENDING'",
    [row.id]
  );
  const approvedSteps = new Set(
    agg.rows.filter((r) => r.status === 'APPROVED').map((r) => String(r.step))
  );
  const anyRejected = agg.rows.some((r) => r.status === 'REJECTED');
  if (anyRejected) return row.status;

  const stillPending = Number(pendingAny.rows[0]?.count ?? 0);
  let next: AccessStatus = 'APPROVED';
  if (stillPending > 0) {
    if (row.manager_approval_required && !approvedSteps.has('MANAGER')) next = 'SUBMITTED';
    else if (row.owner_approval_required && !approvedSteps.has('SYSTEM_OWNER') && !approvedSteps.has('DATA_OWNER')) {
      next = 'MANAGER_APPROVED';
    } else {
      next = 'OWNER_APPROVED';
    }
  }

  // Only ever move forwards: a late approval must not reopen a granted request.
  const rank: Record<string, number> = {
    DRAFT: 0,
    SUBMITTED: 1,
    MANAGER_APPROVED: 2,
    OWNER_APPROVED: 3,
    APPROVED: 4,
    PROVISIONING: 5,
    GRANTED: 6,
    PROVISION_FAILED: 5,
    REJECTED: 4,
    EXPIRED: 6,
    REVOKED: 6,
    CANCELLED: 4,
  };
  if ((rank[next] ?? 0) <= (rank[row.status] ?? 0)) return row.status;

  const stepNo = stillPending > 0 ? await currentStepNumber(client, row.id) : 0;
  await applyAccessStatus(client, ctx, row.id, next, {
    eventType: 'service_desk.access_request.' + next.toLowerCase(),
    note,
    notify: next === 'APPROVED',
    extraSets: { current_step: stepNo > 0 ? stepNo : row.current_step },
  });
  return next;
}

/** The seq of the earliest still-pending approval, or 0 when the chain is clear. */
async function currentStepNumber(client: pg.PoolClient, accessRequestId: number): Promise<number> {
  const res = await client.query<{ seq: number | null }>(
    "SELECT min(seq) AS seq FROM access_approvals WHERE access_request_id = $1 AND status = 'PENDING'",
    [accessRequestId]
  );
  return Number(res.rows[0]?.seq ?? 0);
}

// ------------------------------------------------------------ creation

export interface CreateAccessRequestInput extends Record<string, unknown> {
  accessType?: string;
  systemName?: string;
  justification?: string;
  requestedRoleCode?: string;
  requestedPermissions?: string[] | string;
  requestedScope?: Record<string, unknown>;
  duration?: string;
  accessStartsAt?: string;
  accessExpiresAt?: string;
  dataClassification?: string;
  riskLevel?: string;
  managerApprovalRequired?: boolean;
  ownerApprovalRequired?: boolean;
  targetUserId?: number;
  requesterEmployeeId?: number;
  subject?: string;
  description?: string;
  priority?: string;
  impact?: string;
  urgency?: string;
  categoryId?: number;
  subcategoryId?: number;
  affectedAssetId?: number;
  preferredContactMethod?: string;
  approvalSteps?: string[] | string;
  draft?: boolean;
}

/**
 * The risk a request carries, derived from what is being asked for rather than
 * from the requester's own assessment of it.
 */
export function deriveAccessRisk(
  accessType: string,
  dataClassification: string,
  duration: string
): string {
  if (dataClassification === 'RESTRICTED') return 'CRITICAL';
  if (dataClassification === 'CONFIDENTIAL') return 'HIGH';
  if (['DATABASE', 'DATA_SCOPE'].includes(accessType) && duration === 'PERMANENT') return 'HIGH';
  if (RBAC_ACCESS_TYPES.includes(accessType)) return 'MEDIUM';
  if (duration === 'PERMANENT') return 'MEDIUM';
  return 'LOW';
}

export interface CreateAccessRequestOptions {
  /** Employee self-service: the requester is always the authenticated caller. */
  selfService?: boolean;
}

export async function createAccessRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  b: CreateAccessRequestInput = {},
  opts: CreateAccessRequestOptions = {}
) {
  const scope = await resolveAccessScope(client, ctx);
  if (!scope.canCreate) throw forbidden('You cannot raise access requests');

  // Impersonation is impossible by construction: self-service never reads the
  // requester from the body, so a caller cannot raise access for someone else.
  const selfService = opts.selfService === true;
  let requestEmployeeId: number | null;
  let targetUserId: number | null;
  if (selfService) {
    requestEmployeeId = scope.employeeId;
    targetUserId = scope.userId;
  } else {
    requestEmployeeId = n(b.requesterEmployeeId) ?? scope.employeeId;
    targetUserId = n(b.targetUserId) ?? (requestEmployeeId === scope.employeeId ? scope.userId : null);
    if (requestEmployeeId) {
      const emp = await client.query<{ user_id: number | null }>(
        'SELECT user_id FROM employees WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
        [requestEmployeeId, ctx.tenantId, ctx.companyId]
      );
      if (emp.rows.length === 0) throw badRequest('Requester employee not found in this company');
      targetUserId = targetUserId ?? emp.rows[0].user_id ?? null;
    }
  }
  if (!requestEmployeeId && !targetUserId) throw badRequest('A requester is required');

  const accessType = oneOf(b.accessType, ACCESS_TYPES) ?? 'ROLE';
  const systemName = s(b.systemName) ?? s(b.system_name);
  if (!systemName) throw badRequest('The system or service the access is for is required');
  const justification = s(b.justification);
  if (!justification) throw badRequest('A business justification is required');

  const duration = oneOf(b.duration, ACCESS_DURATIONS) ?? 'PERMANENT';
  const classification = oneOf(b.dataClassification, ACCESS_DATA_CLASSIFICATIONS) ?? 'INTERNAL';
  const startsAt = s(b.accessStartsAt) ?? null;
  const expiresAt = s(b.accessExpiresAt) ?? null;
  if (duration === 'DATE_BOUNDED' && !expiresAt) {
    throw badRequest('A date-bounded request must state when the access expires');
  }
  if (expiresAt && startsAt && new Date(expiresAt).getTime() <= new Date(startsAt).getTime()) {
    throw badRequest('The access expiry must be after the access start');
  }
  const riskLevel = oneOf(b.riskLevel, ACCESS_RISK_LEVELS) ?? deriveAccessRisk(accessType, classification, duration);
  const requiredPermissions = strList(b.requestedPermissions) ?? [];
  const requestedScope = (b.requestedScope ?? {}) as Record<string, unknown>;

  // Every access request is a ticket, so it inherits queueing, SLA, assignment,
  // communication and audit rather than living in a parallel workflow.
  const categoryId = await resolveAccessCategory(client, ctx, n(b.categoryId), n(b.subcategoryId));
  const subject = s(b.subject) ?? 'Access request: ' + systemName;
  const priority =
    oneOf(b.priority, ['P1', 'P2', 'P3', 'P4'] as const) ?? (classification === 'RESTRICTED' ? 'P2' : 'P3');

  const ticket = await createTicket(
    client,
    ctx,
    {
      ticketType: 'ACCESS_REQUEST',
      categoryId: categoryId.categoryId,
      subcategoryId: categoryId.subcategoryId,
      subject,
      description: s(b.description) ?? justification,
      priority,
      impact: s(b.impact),
      urgency: s(b.urgency),
      dataClassification: classification,
      affectedAssetId: n(b.affectedAssetId),
      preferredContact: s(b.preferredContactMethod),
      source: selfService ? 'PORTAL' : 'AGENT',
      requesterEmployeeId: requestEmployeeId,
      requesterUserId: targetUserId,
    },
    { selfService }
  );

  const inserted = await client.query<AccessRow>(
    'INSERT INTO access_requests ' +
      '(tenant_id, company_id, branch_id, ticket_id, request_number, requester_employee_id, target_user_id, ' +
      'system_name, access_type, requested_role_code, requested_permissions, requested_scope, justification, ' +
      'duration, access_starts_at, access_expires_at, data_classification, risk_level, status, ' +
      'manager_approval_required, owner_approval_required, current_step, created_by, updated_by) ' +
      'VALUES ($1,$2,$3,$4,next_access_request_no($1,$2),$5,$6,$7,$8,$9,$10,$11::jsonb,$12,' +
      "$13,$14::timestamptz,$15::timestamptz,$16,$17,'DRAFT',$18,$19,1,$20,$20) RETURNING *",
    [
      ctx.tenantId,
      ctx.companyId,
      ctx.branchId ?? null,
      Number(ticket.id),
      requestEmployeeId,
      targetUserId,
      systemName,
      accessType,
      s(b.requestedRoleCode) ?? null,
      requiredPermissions,
      JSON.stringify(requestedScope),
      justification,
      duration,
      startsAt,
      expiresAt,
      classification,
      riskLevel,
      b.managerApprovalRequired === undefined ? true : truthy(b.managerApprovalRequired),
      b.ownerApprovalRequired === undefined ? true : truthy(b.ownerApprovalRequired),
      ctx.userId ?? null,
    ]
  );
  const row = requireRow(inserted.rows[0], 'Access request could not be created');

  await logAudit(client, ctx, {
    action: 'create',
    resource: 'access_requests',
    recordId: row.id,
    recordCode: row.request_number,
    newValues: {
      ticket_number: (ticket as Record<string, unknown>).ticket_number,
      system_name: row.system_name,
      access_type: row.access_type,
      risk_level: row.risk_level,
      data_classification: row.data_classification,
      target_user_id: row.target_user_id,
    },
  });

  const wantsDraft = truthy(b.draft) === true;
  if (!wantsDraft) {
    const steps = strList(b.approvalSteps);
    const created = await buildAccessChain(client, ctx, row, steps);
    const submitted = await applyAccessStatus(client, ctx, row.id, 'SUBMITTED', {
      eventType: 'service_desk.access_request.submitted',
      note: 'Access request submitted with ' + String(created) + ' authorisation step(s)',
      notify: false,
    });
    await notifyAccessWatchers(client, ctx, row, {
      type: 'service_desk.access_request.submitted',
      title: 'Access request ' + row.request_number + ' needs authorisation',
      body: row.system_name,
      severity: 'INFO',
    });
    return { ...row, status: submitted.status, ticket, approvals_created: created };
  }

  return { ...row, ticket, approvals_created: 0 };
}

/** Default an access request onto the ERP access catalogue entry. */
async function resolveAccessCategory(
  client: pg.PoolClient,
  ctx: Ctx,
  categoryId: number | undefined,
  subcategoryId: number | undefined
): Promise<{ categoryId: number; subcategoryId: number }> {
  if (categoryId && subcategoryId) {
    const ok = await client.query<{ id: number }>(
      'SELECT id FROM service_subcategories WHERE id = $1 AND category_id = $2 AND tenant_id = $3 AND company_id = $4',
      [subcategoryId, categoryId, ctx.tenantId, ctx.companyId]
    );
    if (ok.rows.length === 0) throw badRequest('Subcategory does not belong to the chosen category');
    return { categoryId, subcategoryId };
  }
  const found = await client.query<{ id: number; category_id: number }>(
    "SELECT sc.id, sc.category_id FROM service_subcategories sc " +
      "WHERE sc.code = 'ERP_ACCESS' AND sc.tenant_id = $1 AND sc.company_id = $2 AND sc.is_active " +
      'ORDER BY sc.id ASC LIMIT 1',
    [ctx.tenantId, ctx.companyId]
  );
  if (found.rows.length > 0) {
    return { categoryId: found.rows[0].category_id, subcategoryId: found.rows[0].id };
  }
  const fallback = await client.query<{ id: number; category_id: number }>(
    'SELECT sc.id, sc.category_id FROM service_subcategories sc ' +
      'JOIN service_categories c ON c.id = sc.category_id ' +
      'WHERE sc.tenant_id = $1 AND sc.company_id = $2 AND sc.is_active AND c.is_active ' +
      'ORDER BY sc.id ASC LIMIT 1',
    [ctx.tenantId, ctx.companyId]
  );
  if (fallback.rows.length === 0) throw badRequest('No active service subcategory is configured');
  return { categoryId: fallback.rows[0].category_id, subcategoryId: fallback.rows[0].id };
}
// ------------------------------------------------------------ mutation

const ACCESS_PATCH_COLUMNS: Record<string, string> = {
  systemName: 'system_name',
  accessType: 'access_type',
  requestedRoleCode: 'requested_role_code',
  justification: 'justification',
  duration: 'duration',
  accessStartsAt: 'access_starts_at',
  accessExpiresAt: 'access_expires_at',
  dataClassification: 'data_classification',
  riskLevel: 'risk_level',
  managerApprovalRequired: 'manager_approval_required',
  ownerApprovalRequired: 'owner_approval_required',
  targetUserId: 'target_user_id',
};

/** Edit a request that has not yet entered authorisation. */
export async function updateAccessRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { request, scope } = await accessActionContext(client, ctx, ref, 'update');
  const isOwner = sameId(request.created_by, scope.userId);
  if (!scope.canUpdate && !isOwner) throw forbidden('You cannot update this access request');
  if (request.status !== 'DRAFT') {
    throw conflict('An access request can only be edited while it is a draft');
  }

  const sets: string[] = [];
  const params: unknown[] = [request.id, ctx.tenantId, ctx.companyId, ctx.userId ?? null];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  for (const [key, col] of Object.entries(ACCESS_PATCH_COLUMNS)) {
    if (b[key] === undefined && b[col] === undefined) continue;
    const raw = b[key] !== undefined ? b[key] : b[col];
    params.push(raw === undefined ? null : raw);
    sets.push(col + ' = $' + String(params.length));
    before[col] = (request as unknown as Record<string, unknown>)[col];
    after[col] = raw ?? null;
  }
  if (b.requestedPermissions !== undefined) {
    params.push(strList(b.requestedPermissions) ?? []);
    sets.push('requested_permissions = $' + String(params.length));
  }
  if (b.requestedScope !== undefined) {
    params.push(JSON.stringify((b.requestedScope ?? {}) as Record<string, unknown>));
    sets.push('requested_scope = $' + String(params.length) + '::jsonb');
  }
  if (!sets.length) throw badRequest('Nothing to update');
  sets.push('updated_by = $4');

  const res = await client.query<AccessRow>(
    'UPDATE access_requests SET ' + sets.join(', ') +
      ' WHERE id = $1 AND tenant_id = $2 AND company_id = $3 RETURNING *',
    params
  );
  const row = requireRow(res.rows[0], 'Access request not found');

  await logAudit(client, ctx, {
    action: 'update',
    resource: 'access_requests',
    recordId: row.id,
    recordCode: row.request_number,
    oldValues: before,
    newValues: after,
  });
  return row;
}

export async function submitAccessRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { request, scope } = await accessActionContext(client, ctx, ref, 'submit');
  const isOwner = sameId(request.created_by, scope.userId);
  if (!isOwner && !scope.canUpdate) throw forbidden('You cannot submit this access request');

  if (request.status === 'REJECTED') {
    await applyAccessStatus(client, ctx, request.id, 'DRAFT', {
      eventType: 'service_desk.access_request.reworked',
      note: s(b.note) ?? 'Access request reworked after rejection',
      notify: false,
    });
  } else if (request.status !== 'DRAFT') {
    throw conflict('An access request in status ' + request.status + ' cannot be submitted');
  }

  const steps = strList(b.approvalSteps);
  const created = await buildAccessChain(client, ctx, request, steps);
  const out = await applyAccessStatus(client, ctx, request.id, 'SUBMITTED', {
    eventType: 'service_desk.access_request.submitted',
    note: s(b.note) ?? 'Access request submitted for authorisation',
    notify: false,
  });
  await notifyAccessWatchers(client, ctx, request, {
    type: 'service_desk.access_request.submitted',
    title: 'Access request ' + request.request_number + ' needs authorisation',
    body: request.system_name,
    severity: 'INFO',
  });
  return { ...out, approvals_created: created };
}

export interface DecideAccessApprovalInput extends Record<string, unknown> {
  decision?: string;
  approved?: boolean;
  comments?: string;
  delegateToUserId?: number;
}

/**
 * Record one authorisation decision and re-derive the request status.
 *
 * Segregation of duties is enforced here and again by ABAC-NO-SELF-APPROVE: the
 * person who raised the request, and the person who will receive the access,
 * can never decide it.
 */
export async function decideAccessApproval(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  approvalId: number,
  b: DecideAccessApprovalInput = {}
) {
  const { request, scope } = await accessActionContext(client, ctx, ref, 'approve');

  const decisionRaw = s(b.decision);
  const approved = decisionRaw
    ? decisionRaw.toUpperCase() === 'APPROVED'
    : b.approved === undefined
      ? null
      : truthy(b.approved);
  if (approved === null) throw badRequest('A decision of APPROVED or REJECTED is required');
  if (approved && !scope.canApprove) throw forbidden('You cannot approve access requests');
  if (!approved && !scope.canReject) throw forbidden('You cannot reject access requests');

  if (sameId(request.created_by, scope.userId) || sameId(request.target_user_id, scope.userId)) {
    throw forbidden('You cannot decide your own access request');
  }

  const found = await client.query<{
    id: number;
    step: string;
    seq: number;
    status: string;
    approver_user_id: number | null;
  }>('SELECT id, step, seq, status, approver_user_id FROM access_approvals WHERE id = $1 AND access_request_id = $2', [
    approvalId,
    request.id,
  ]);
  const approval = found.rows[0];
  if (!approval) throw notFound('Approval step not found on this access request');
  if (approval.status !== 'PENDING') {
    throw conflict('This authorisation step has already been decided');
  }
  if (approval.approver_user_id && !sameId(approval.approver_user_id, scope.userId) && !scope.isAdmin) {
    throw forbidden('This authorisation step is assigned to another approver');
  }

  const comments = s(b.comments) ?? null;
  await client.query(
    'UPDATE access_approvals SET status = $2, decided_at = now(), comments = $3, updated_by = $4 WHERE id = $1',
    [approvalId, approved ? 'APPROVED' : 'REJECTED', comments, ctx.userId ?? null]
  );

  await logAudit(client, ctx, {
    action: approved ? 'approve' : 'reject',
    resource: 'access_approvals',
    recordId: approvalId,
    recordCode: request.request_number,
    oldValues: { status: 'PENDING', step: approval.step, seq: approval.seq },
    newValues: { status: approved ? 'APPROVED' : 'REJECTED', comments },
  });

  if (!approved) {
    // Withdraw the steps that no longer matter, but keep them on record.
    await client.query(
      "UPDATE access_approvals SET status = 'SKIPPED', decided_at = now(), updated_by = $2 " +
        "WHERE access_request_id = $1 AND status = 'PENDING'",
      [request.id, ctx.userId ?? null]
    );
    const out = await applyAccessStatus(client, ctx, request.id, 'REJECTED', {
      eventType: 'service_desk.access_request.rejected',
      note: 'Rejected at the ' + approval.step + ' step' + (comments ? ': ' + comments : ''),
      severity: 'WARN',
    });
    return { ...out, step: approval.step, decision: 'REJECTED' };
  }

  const status = await recomputeAccessStatus(
    client,
    ctx,
    request,
    'Approved at the ' + approval.step + ' step' + (comments ? ': ' + comments : '')
  );

  if (status === 'APPROVED') {
    const nextApprovers = await usersWithPermission(client, ctx, 'service_desk.access_requests.grant');
    await notifyUsers(client, ctx, nextApprovers.slice(0, 25), {
      type: 'service_desk.access_request.approved',
      title: 'Access request ' + request.request_number + ' is authorised for provisioning',
      body: request.system_name + ' - ' + request.access_type,
      link: '/service-desk/access-requests/' + request.id,
      entityType: 'service_access_request',
      entityId: request.id,
      severity: 'SUCCESS',
    });
  } else {
    const nextStep = await client.query<{ approver_user_id: number | null }>(
      "SELECT approver_user_id FROM access_approvals WHERE access_request_id = $1 AND status = 'PENDING' " +
        'ORDER BY seq ASC, id ASC LIMIT 1',
      [request.id]
    );
    await notifyUsers(client, ctx, [nextStep.rows[0]?.approver_user_id ?? null], {
      type: 'service_desk.access_request.awaiting_approval',
      title: 'Access request ' + request.request_number + ' needs your authorisation',
      body: request.system_name,
      link: '/service-desk/access-requests/' + request.id,
      entityType: 'service_access_request',
      entityId: request.id,
      severity: 'INFO',
    });
  }

  return { id: request.id, request_number: request.request_number, status, step: approval.step, decision: 'APPROVED' };
}

export async function approveAccessRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  approvalId: number,
  b: DecideAccessApprovalInput = {}
) {
  return decideAccessApproval(client, ctx, ref, approvalId, { ...b, decision: 'APPROVED' });
}

export async function rejectAccessRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  approvalId: number,
  b: DecideAccessApprovalInput = {}
) {
  return decideAccessApproval(client, ctx, ref, approvalId, { ...b, decision: 'REJECTED' });
}

export async function cancelAccessRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { request, scope } = await accessActionContext(client, ctx, ref, 'cancel');
  const isOwner = sameId(request.created_by, scope.userId);
  if (!scope.canCancel && !isOwner) throw forbidden('You cannot cancel this access request');
  if (['GRANTED', 'REVOKED', 'EXPIRED', 'CANCELLED'].includes(request.status)) {
    throw conflict('An access request in status ' + request.status + ' cannot be cancelled');
  }
  await client.query(
    "UPDATE access_approvals SET status = 'SKIPPED', decided_at = now(), updated_by = $2 " +
      "WHERE access_request_id = $1 AND status = 'PENDING'",
    [request.id, ctx.userId ?? null]
  );
  return applyAccessStatus(client, ctx, request.id, 'CANCELLED', {
    eventType: 'service_desk.access_request.cancelled',
    note: s(b.reason) ?? 'Access request cancelled',
    severity: 'WARN',
  });
}
// ------------------------------------------------------------ provisioning

/**
 * Refuse to provision unless the recorded authorisation actually supports it.
 * This is the guard that keeps "the Service Desk must never directly grant
 * access without required authorization" true even if a caller has the grant
 * permission and crafts a request that skipped its chain.
 */
async function ensureFullyAuthorised(client: pg.PoolClient, ctx: Ctx, request: AccessRow): Promise<void> {
  if (request.status !== 'APPROVED') {
    throw conflict('Access can only be provisioned once the request status is APPROVED');
  }
  const agg = await client.query<{ status: string; count: string }>(
    'SELECT status, count(*)::text AS count FROM access_approvals WHERE access_request_id = $1 GROUP BY status',
    [request.id]
  );
  const byStatus: Record<string, number> = {};
  for (const r of agg.rows) byStatus[String(r.status)] = Number(r.count);
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  if (total === 0) {
    throw conflict('This access request has no recorded authorisation and cannot be provisioned');
  }
  if ((byStatus.PENDING ?? 0) > 0) {
    throw conflict('This access request still has undecided authorisation steps');
  }
  if ((byStatus.REJECTED ?? 0) > 0) {
    throw conflict('This access request was rejected and cannot be provisioned');
  }
  if ((byStatus.APPROVED ?? 0) === 0) {
    throw conflict('This access request has no recorded approval and cannot be provisioned');
  }

  // The policy chain for the request as it stands must be satisfied in full, so
  // a hand-built chain cannot leave a required control out.
  const required = defaultAccessChain(request).map((x) => x.step);
  const approvedSteps = await client.query<{ step: string }>(
    "SELECT DISTINCT step FROM access_approvals WHERE access_request_id = $1 AND status = 'APPROVED'",
    [request.id]
  );
  const have = new Set(approvedSteps.rows.map((r) => String(r.step)));
  for (const step of required) {
    if (!have.has(step)) {
      throw conflict('The ' + step + ' authorisation required by policy has not been recorded');
    }
  }
}

export interface GrantAccessInput extends Record<string, unknown> {
  roleCode?: string;
  roleId?: number;
  targetUserId?: number;
  abacScope?: Record<string, unknown>;
  notBefore?: string;
  applyRole?: boolean;
  note?: string;
}

/**
 * Execute the grant. Provisioning is a distinct act from approving: it needs
 * service_desk.access_requests.grant, it must never be performed by the person
 * who raised the request, and the RBAC role assignment is recorded on the
 * request so it can be revoked deliberately later.
 */
export async function grantAccessRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: GrantAccessInput = {}
) {
  const { request, scope } = await accessActionContext(client, ctx, ref, 'grant');
  if (!scope.canGrant) throw forbidden('You cannot provision access');
  if (sameId(request.created_by, scope.userId)) {
    throw forbidden('You cannot provision an access request you raised yourself');
  }

  // A retry after a failed provisioning attempt is allowed to run again.
  if (request.status === 'PROVISION_FAILED' || request.status === 'PROVISIONING') {
    await applyAccessStatus(client, ctx, request.id, 'APPROVED', {
      eventType: 'service_desk.access_request.reprovisioning',
      note: s(b.note) ?? 'Retrying provisioning after a failed attempt',
      notify: false,
    });
  }
  const fresh = requireRow(await loadAccessRequest(client, ctx, request.id), 'Access request not found');
  await ensureFullyAuthorised(client, ctx, fresh);

  const targetUserId = nn(b.targetUserId) ?? fresh.target_user_id;
  if (!targetUserId) throw badRequest('The request has no target user to provision access for');

  const roleCode = s(b.roleCode) ?? fresh.requested_role_code;
  const roleId = nn(b.roleId);
  let resolvedRoleId: number | null = null;
  let resolvedRoleCode: string | null = null;
  if (roleId || roleCode) {
    const role = roleId
      ? await client.query<{ id: number; code: string }>('SELECT id, code FROM roles WHERE id = $1', [roleId])
      : await client.query<{ id: number; code: string }>('SELECT id, code FROM roles WHERE code = $1', [String(roleCode)]);
    if (role.rows.length === 0) throw badRequest('Role not found: ' + String(roleCode ?? roleId));
    resolvedRoleId = role.rows[0].id;
    resolvedRoleCode = role.rows[0].code;
  }

  await applyAccessStatus(client, ctx, fresh.id, 'PROVISIONING', {
    eventType: 'service_desk.access_request.provisioning',
    note: 'Provisioning started',
    notify: false,
  });

  // ABAC scope configuration: merge the authorised scope onto the request so the
  // access carries its data boundary rather than relying on the role alone.
  const abacScope = (b.abacScope ?? {}) as Record<string, unknown>;
  const scopeConfig = {
    ...(fresh.requested_scope ?? {}),
    ...abacScope,
    authorized_by: ctx.userId ?? null,
    authorized_at: new Date().toISOString(),
  };

  let roleApplied = false;
  const shouldApplyRole = b.applyRole === undefined ? true : truthy(b.applyRole);
  if (resolvedRoleId && fresh.access_type === 'ROLE' && shouldApplyRole) {
    const ins = await client.query(
      'INSERT INTO user_roles (user_id, role_id, company_id, branch_id) VALUES ($1,$2,$3,$4) ' +
        'ON CONFLICT (user_id, role_id) DO NOTHING',
      [targetUserId, resolvedRoleId, ctx.companyId, fresh.branch_id ?? ctx.branchId ?? null]
    );
    roleApplied = (ins.rowCount ?? 0) > 0;
  }

  const notBefore = s(b.notBefore) ?? fresh.access_starts_at ?? null;
  const out = await applyAccessStatus(client, ctx, fresh.id, 'GRANTED', {
    eventType: 'service_desk.access_request.granted',
    note:
      s(b.note) ??
      ('Access granted' + (resolvedRoleCode ? ' with role ' + resolvedRoleCode : '')),
    severity: 'SUCCESS',
    extraSets: {
      granted_role_id: resolvedRoleId ?? fresh.granted_role_id ?? null,
      target_user_id: targetUserId,
      requested_scope: JSON.stringify(scopeConfig),
      access_starts_at: notBefore,
    },
  });

  await logAudit(client, ctx, {
    action: 'grant',
    resource: 'access_requests',
    recordId: fresh.id,
    recordCode: fresh.request_number,
    oldValues: { status: 'APPROVED', target_user_id: fresh.target_user_id, granted_role_id: fresh.granted_role_id },
    newValues: {
      status: 'GRANTED',
      target_user_id: targetUserId,
      granted_role_id: resolvedRoleId,
      role_applied: roleApplied,
      access_type: fresh.access_type,
      system_name: fresh.system_name,
    },
    metadata: { abac_scope: scopeConfig },
  });
  const ticketRef = await client.query<{ ticket_id: number }>(
    'SELECT ticket_id FROM access_requests WHERE id = $1',
    [fresh.id]
  );
  await emitEvent(client, ctx, {
    eventType: 'service_desk.access_request.granted',
    entityType: 'service_access_request',
    entityId: fresh.id,
    entityCode: fresh.request_number,
    payload: {
      target_user_id: targetUserId,
      role_code: resolvedRoleCode,
      access_type: fresh.access_type,
      system_name: fresh.system_name,
      ticket_id: ticketRef.rows[0]?.ticket_id ?? null,
    },
    severity: 'INFO',
  });
  await notifyAccessWatchers(client, ctx, fresh, {
    type: 'service_desk.access_request.granted',
    title: 'Access granted: ' + fresh.request_number,
    body: fresh.system_name + (resolvedRoleCode ? ' - ' + resolvedRoleCode : ''),
    severity: 'SUCCESS',
  });

  return { ...out, granted_role_id: resolvedRoleId, role_code: resolvedRoleCode, role_applied: roleApplied };
}

export async function markAccessProvisioningFailed(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { request, scope } = await accessActionContext(client, ctx, ref, 'grant');
  if (!scope.canGrant) throw forbidden('You cannot update provisioning for this request');
  if (!['APPROVED', 'PROVISIONING', 'PROVISION_FAILED'].includes(request.status)) {
    throw conflict('Only an authorised request can report a provisioning failure');
  }
  if (request.status === 'APPROVED') {
    await applyAccessStatus(client, ctx, request.id, 'PROVISIONING', {
      eventType: 'service_desk.access_request.provisioning',
      note: 'Provisioning started',
      notify: false,
    });
  }
  const fresh = requireRow(await loadAccessRequest(client, ctx, request.id), 'Access request not found');
  return applyAccessStatus(client, ctx, fresh.id, 'PROVISION_FAILED', {
    eventType: 'service_desk.access_request.provision_failed',
    note: s(b.reason) ?? 'Provisioning failed',
    severity: 'ERROR',
  });
}
// ------------------------------------------------------------ revocation and expiry

/**
 * Remove the RBAC grant we made, but only when no other live access request
 * still depends on it - otherwise revoking one request would silently strip
 * access that another approved request legitimately granted.
 */
async function removeGrantedRole(
  client: pg.PoolClient,
  ctx: Ctx,
  request: AccessRow,
  targetUserId: number | null
): Promise<boolean> {
  if (!request.granted_role_id || !targetUserId) return false;
  const others = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM access_requests " +
      "WHERE target_user_id = $1 AND granted_role_id = $2 AND status = 'GRANTED' AND id <> $3",
    [targetUserId, request.granted_role_id, request.id]
  );
  if (Number(others.rows[0]?.count ?? 0) > 0) return false;
  const del = await client.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [
    targetUserId,
    request.granted_role_id,
  ]);
  return (del.rowCount ?? 0) > 0;
}

export async function revokeAccessRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  b: Record<string, unknown> = {}
) {
  const { request, scope } = await accessActionContext(client, ctx, ref, 'revoke');
  if (!scope.canRevoke) throw forbidden('You cannot revoke access');
  if (!['GRANTED', 'EXPIRED'].includes(request.status)) {
    throw conflict('Only granted access can be revoked, this request is ' + request.status);
  }
  const reason = s(b.reason) ?? s(b.revocationReason);
  if (!reason) throw badRequest('A revocation reason is required');

  const targetUserId = nn(b.targetUserId) ?? request.target_user_id;
  const roleRemoved = await removeGrantedRole(client, ctx, request, targetUserId);

  const out = await applyAccessStatus(client, ctx, request.id, 'REVOKED', {
    eventType: 'service_desk.access_request.revoked',
    note: reason,
    severity: 'WARN',
    extraSets: { revocation_reason: reason },
  });

  await logAudit(client, ctx, {
    action: 'revoke',
    resource: 'access_requests',
    recordId: request.id,
    recordCode: request.request_number,
    oldValues: { status: request.status, granted_role_id: request.granted_role_id },
    newValues: { status: 'REVOKED', revocation_reason: reason, role_removed: roleRemoved },
  });
  return { ...out, role_removed: roleRemoved, revocation_reason: reason };
}

/**
 * Lapse date-bounded access. Expiry is not cosmetic: the granted RBAC role is
 * withdrawn at the same time, so access genuinely ends when the window closes.
 */
export async function expireAccessRequests(
  client: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
) {
  const limit = Math.min(Math.max(n(q.limit) ?? 200, 1), 500);
  const due = await client.query<AccessRow>(
    "SELECT ar.* FROM access_requests ar " +
      "WHERE ar.tenant_id = $1 AND ar.company_id = $2 AND ar.status = 'GRANTED' " +
      'AND ar.access_expires_at IS NOT NULL AND ar.access_expires_at <= now() ' +
      'ORDER BY ar.access_expires_at ASC LIMIT ' + String(limit),
    [ctx.tenantId, ctx.companyId]
  );

  const expired: Array<Record<string, unknown>> = [];
  for (const row of due.rows) {
    const roleRemoved = await removeGrantedRole(client, ctx, row, row.target_user_id);
    const out = await applyAccessStatus(client, ctx, row.id, 'EXPIRED', {
      eventType: 'service_desk.access_request.expired',
      note:
        'Access window closed on ' +
        (row.access_expires_at ? new Date(row.access_expires_at).toISOString() : 'unknown'),
      severity: 'WARN',
    });
    await logAudit(client, ctx, {
      action: 'expire',
      resource: 'access_requests',
      recordId: row.id,
      recordCode: row.request_number,
      oldValues: { status: 'GRANTED', access_expires_at: row.access_expires_at },
      newValues: { status: 'EXPIRED', role_removed: roleRemoved },
    });
    expired.push({ id: out.id, request_number: out.request_number, role_removed: roleRemoved });
  }
  return { count: expired.length, expired };
}

/** Employee-facing list: always the caller's own requests. */
export async function listMyAccessRequests(
  client: pg.PoolClient,
  ctx: Ctx,
  q: ListAccessRequestsQuery = {}
) {
  return listAccessRequests(client, ctx, { ...q, mine: true });
}

// ------------------------------------------------------------ dashboard

export async function accessDashboard(client: pg.PoolClient, ctx: Ctx) {
  const scope = await resolveAccessScope(client, ctx);
  const base: unknown[] = [ctx.tenantId, ctx.companyId];
  const mineRef = '$' + String(base.length + 1);
  const mineParams = [...base, scope.userId ?? -1, scope.employeeId ?? -1];

  const [byStatus, byType, byRisk, mine, pending, provisioning, expiring, recent] = await Promise.all([
    client.query(
      'SELECT status, count(*)::int AS count FROM access_requests ' +
        'WHERE tenant_id = $1 AND company_id = $2 GROUP BY status ORDER BY count DESC',
      base
    ),
    client.query(
      'SELECT access_type, count(*)::int AS count FROM access_requests ' +
        'WHERE tenant_id = $1 AND company_id = $2 GROUP BY access_type ORDER BY count DESC',
      base
    ),
    client.query(
      'SELECT COALESCE(risk_level, \'UNSET\') AS risk_level, count(*)::int AS count FROM access_requests ' +
        'WHERE tenant_id = $1 AND company_id = $2 GROUP BY risk_level ORDER BY count DESC',
      base
    ),
    client.query(
      'SELECT ar.*, t.ticket_number, t.status AS ticket_status, ' +
        "e.first_name || ' ' || e.last_name AS requester_name " +
        'FROM access_requests ar ' +
        'LEFT JOIN service_tickets t ON t.id = ar.ticket_id ' +
        'LEFT JOIN employees e ON e.id = ar.requester_employee_id ' +
        'WHERE ar.tenant_id = $1 AND ar.company_id = $2 ' +
        'AND (ar.created_by = ' + mineRef + ' OR ar.target_user_id = ' + mineRef +
        ' OR ar.requester_employee_id = $' + String(mineParams.length) + ') ' +
        'ORDER BY ar.created_at DESC LIMIT 10',
      mineParams
    ),
    client.query(
      "SELECT count(*)::int AS count FROM access_approvals a " +
        'JOIN access_requests ar ON ar.id = a.access_request_id ' +
        "WHERE ar.tenant_id = $1 AND ar.company_id = $2 AND a.status = 'PENDING' AND a.approver_user_id = $3",
      [ctx.tenantId, ctx.companyId, scope.userId ?? -1]
    ),
    client.query(
      "SELECT count(*)::int AS count FROM access_requests WHERE tenant_id = $1 AND company_id = $2 AND status = 'APPROVED'",
      base
    ),
    client.query(
      "SELECT count(*)::int AS count FROM access_requests WHERE tenant_id = $1 AND company_id = $2 " +
        "AND status = 'GRANTED' AND access_expires_at IS NOT NULL AND access_expires_at <= now() + interval '7 days'",
      base
    ),
    client.query(
      'SELECT ar.id, ar.request_number, ar.system_name, ar.access_type, ar.status, ar.risk_level, ' +
        'ar.created_at, ar.access_expires_at ' +
        'FROM access_requests ar WHERE ar.tenant_id = $1 AND ar.company_id = $2 ' +
        'ORDER BY ar.created_at DESC LIMIT 10',
      base
    ),
  ]);

  const byStatusRows = byStatus.rows as Array<{ status: string; count: number }>;
  const statusCount = (code: string) =>
    Number(byStatusRows.find((r) => String(r.status) === code)?.count ?? 0);

  return {
    awaitingMyApproval: Number(pending.rows[0]?.count ?? 0),
    awaitingProvisioning: Number(provisioning.rows[0]?.count ?? 0),
    expiringWithinSevenDays: Number(expiring.rows[0]?.count ?? 0),
    openRequests: statusCount('DRAFT') + statusCount('SUBMITTED') + statusCount('MANAGER_APPROVED') +
      statusCount('OWNER_APPROVED') + statusCount('APPROVED') + statusCount('PROVISIONING'),
    granted: statusCount('GRANTED'),
    rejected: statusCount('REJECTED'),
    revoked: statusCount('REVOKED'),
    expired: statusCount('EXPIRED'),
    byStatus: byStatus.rows,
    byType: byType.rows,
    byRisk: byRisk.rows,
    myRequests: mine.rows,
    recent: recent.rows,
    scope: {
      canView: scope.canView,
      canCreate: scope.canCreate,
      canApprove: scope.canApprove,
      canGrant: scope.canGrant,
      canRevoke: scope.canRevoke,
      isAdmin: scope.isAdmin,
      isAgent: scope.isAgent,
    },
  };
}
