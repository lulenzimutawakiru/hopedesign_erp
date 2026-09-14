import pg from 'pg';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Ctx } from '../db.js';
import { badRequest, conflict, forbidden, idIn, isNumericRef, notFound, parsePagination, sameId } from '../utils.js';
import { config } from '../config.js';
import { logAudit } from './audit.js';
import { createNotification, type NotificationInput } from './notifications.js';
import { emitEvent } from './events.js';
import {
  applyEscalationRules,
  applySlaToTicket,
  cancelSla,
  closeOpenEscalations,
  markResolvedForSla,
  pauseSla,
  recordFirstResponse,
  resumeSla,
  selectSlaPolicy,
  type SlaTicketRef,
} from './serviceDeskSla.js';

/**
 * HOPE DESIGN Service Desk - ticket service (spec sections 1-23, 29-31).
 *
 * One module owns the ticket aggregate: numbering, classification, priority,
 * queuing and assignment, the comment stream, attachments, the status
 * lifecycle and the SLA hand-offs. Everything else in the Service Desk
 * (knowledge base, problems, changes, access requests, QR scans, dashboards)
 * builds on the ticket ids produced here.
 *
 * Authorization is deliberately split in two so that neither half can be
 * forgotten:
 *
 *   1. RBAC - the route declares the permission it needs (requirePermission).
 *   2. ABAC + organizational scope - `ticketActionContext` loads the ticket,
 *      computes the caller's real reach (requester / queue / department /
 *      admin) and publishes it as resource attributes, and the route then
 *      re-runs the policy engine with those attributes. `assertScoped` is
 *      applied inside every mutating function as well, so a route that forgot
 *      the policy step still cannot touch an out-of-scope ticket.
 *
 * Internal notes are never selected unless the caller holds
 * service_desk.internal_notes.view - see `commentVisibility`.
 */

// ---------------------------------------------------------------- primitives

const s = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const t = String(v).trim();
  return t === '' ? undefined : t;
};

const n = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};

const nn = (v: unknown): number | null => n(v) ?? null;

const truthy = (v: unknown): boolean =>
  v === true || v === 'true' || v === 1 || v === '1' || v === 'yes';

const strList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x !== '');
  const t = s(v);
  return t ? t.split(',').map((x) => x.trim()).filter((x) => x !== '') : [];
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], field: string): T => {
  const t = s(v)?.toUpperCase().replace(/[ -]+/g, '_') as T | undefined;
  if (!t || !allowed.includes(t)) {
    throw badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return t;
};

/** Deduplicate while preserving order, and drop null/undefined. */
const uniq = <T>(items: T[]): T[] => Array.from(new Set(items));

export const TICKET_TYPES = ['INCIDENT', 'SERVICE_REQUEST', 'ACCESS_REQUEST', 'CHANGE_REQUEST', 'MAINTENANCE_REQUEST', 'SECURITY_INCIDENT'] as const;
export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
/** Urgency scale (also used for severity reporting). */
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
/** Impact scale - the other half of the priority matrix. */
export const IMPACTS = ['ENTERPRISE', 'DEPARTMENT', 'INDIVIDUAL', 'MINOR'] as const;
/** `service_tickets.source` CHECK constraint values, in portal-first order. */
export const TICKET_SOURCES = ['PORTAL', 'AGENT', 'MOBILE', 'EMAIL', 'QR_SCAN', 'PHONE', 'API', 'SYSTEM'] as const;
export const TICKET_STATUSES = [
  'NEW', 'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REQUESTER', 'PENDING_VENDOR',
  'RESOLVED', 'CLOSED', 'CANCELLED', 'REOPENED', 'ESCALATED',
] as const;
export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;
export const CONTACT_METHODS = ['EMAIL', 'PHONE', 'SMS', 'WHATSAPP', 'IN_PERSON', 'PORTAL'] as const;
export const ASSIGNMENT_TYPES = ['MANUAL', 'AUTOMATIC', 'QUEUE', 'TEAM', 'SKILL_BASED', 'ROUND_ROBIN'] as const;
export const ASSIGNMENT_STRATEGIES = ['MANUAL', 'ROUND_ROBIN', 'LOAD_BALANCED', 'SKILL_BASED', 'TEAM', 'QUEUE'] as const;

/** Statuses that still consume SLA time and count as "open" for workload. */
export const ACTIVE_STATUSES = ['NEW', 'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REQUESTER', 'PENDING_VENDOR', 'ESCALATED', 'REOPENED'] as const;
/** Statuses that pause the clock under a pause_on_pending policy. */
const PAUSING_STATUSES = ['PENDING_REQUESTER', 'PENDING_VENDOR'] as const;

export interface TicketRow {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
  department_id: number | null;
  ticket_number: string;
  ticket_type: string;
  requester_employee_id: number | null;
  requester_user_id: number | null;
  category_id: number | null;
  subcategory_id: number | null;
  subject: string;
  description: string | null;
  impact: string | null;
  urgency: string | null;
  priority: string;
  priority_overridden: boolean;
  status: string;
  data_classification: string;
  assigned_queue_id: number | null;
  assigned_team_id: number | null;
  assigned_to_user_id: number | null;
  assignment_strategy: string | null;
  affected_asset_id: number | null;
  reopen_count: number;
  opened_at: string;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  cancelled_at?: string | null;
  reopened_at: string | null;
  confirmation_required: boolean;
  service_desk_readonly?: boolean;
}

export interface TicketScope {
  userId: number | null;
  companyId: number | null;
  branchId: number | null;
  employeeId: number | null;
  departmentId: number | null;
  permissions: string[];
  isAdmin: boolean;
  isAgent: boolean;
  isManager: boolean;
  canViewInternalNotes: boolean;
  /** Queues this caller may work, or null when unrestricted. */
  queueIds: number[] | null;
  /** Departments whose tickets this caller may see beyond their own. */
  departmentIds: number[];

  /**
   * Employees whose tickets this caller may see because they are that
   * employee record manager (employees.user_id points at this caller).
   * Derived from one query and consumed by both scopePredicate and inScope.
   */
  managedEmployeeIds: number[];
  /** Subject extras derived from the caller (clearance drives SD-CLASSIFIED). */
  securityClearance: boolean;
}

/**
 * Resolve the caller's Service Desk reach from the database rather than the
 * token, so a stale or hand-crafted JWT cannot widen scope.
 */
export async function resolveScope(client: pg.PoolClient, ctx: Ctx): Promise<TicketScope> {
  const userId = ctx.userId ?? null;
  const perms = new Set<string>();
  let employeeId: number | null = null;
  let departmentId: number | null = null;
  let clearance = false;

  if (userId) {
    const permRes = await client.query<{ code: string }>(
      `SELECT DISTINCT p.code
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = $1`,
      [userId]
    );
    for (const row of permRes.rows) perms.add(String(row.code));

    const u = await client.query<{ employee_id: number | null; department_id: number | null; attributes: Record<string, unknown> | null }>(
      `SELECT employee_id, department_id, attributes FROM users WHERE id = $1`,
      [userId]
    );
    const urow = u.rows[0];
    if (urow) {
      employeeId = nn(urow.employee_id);
      departmentId = nn(urow.department_id);
      const attrs = (urow.attributes ?? {}) as Record<string, unknown>;
      clearance = attrs.security_clearance !== undefined && attrs.security_clearance !== null && attrs.security_clearance !== false;
    }
  }

  const isAdmin = perms.has('service_desk.admin') || perms.has('system.admin.all') || perms.has('*');
  const canViewInternalNotes =
    isAdmin || perms.has('service_desk.internal_notes.view') || perms.has('service_desk.internal_notes.*');
  const isAgent =
    isAdmin ||
    canViewInternalNotes ||
    perms.has('service_desk.tickets.assign') ||
    perms.has('service_desk.tickets.resolve');

  // Agents work the queues they are attached to: a queue is reachable when it
  // is not departmental, when it belongs to the agent's department, or when the
  // agent is a member of the queue's team. Admins and agents with no queue
  // binding fall back to the whole company desk.
  let queueIds: number[] | null = null;
  if (isAgent && !isAdmin && userId) {
    const q = await client.query<{ id: number }>(
      `SELECT q.id
         FROM service_queues q
        WHERE q.tenant_id = $1 AND q.company_id = $2 AND q.is_active
          AND (
            q.department_id IS NULL
            OR q.department_id = $3
            OR EXISTS (
              SELECT 1 FROM service_team_members m
               WHERE m.team_id = q.team_id AND m.user_id = $4 AND m.is_active)
          )`,
      [ctx.tenantId, ctx.companyId, departmentId, userId]
    );
    queueIds = q.rows.map((r) => Number(r.id));
  }

  const departmentIds: number[] = [];
  if (isManagerScope(perms)) {
    if (departmentId) departmentIds.push(departmentId);
    if (userId) {
      const d = await client.query<{ id: number }>(
        `SELECT id FROM departments WHERE head_user_id = $1 AND status <> 'INACTIVE'`,
        [userId]
      );
      for (const row of d.rows) departmentIds.push(Number(row.id));
    }
  }

  // The requester line manager owns the request. scopePredicate has always
  // honoured this, but inScope did not, which meant a manager could list a
  // ticket and then be refused when opening it. Both now read this one set.
  const managedEmployeeIds: number[] = [];
  if (userId) {
    const m = await client.query<{ id: number }>(
      `SELECT e.id FROM employees e WHERE e.user_id = $1`,
      [userId]
    );
    for (const row of m.rows) managedEmployeeIds.push(Number(row.id));
  }

  return {
    userId: nn(userId),
    companyId: nn(ctx.companyId),
    branchId: nn(ctx.branchId),
    employeeId,
    departmentId,
    permissions: Array.from(perms),
    isAdmin,
    isAgent,
    isManager: departmentIds.length > 0,
    canViewInternalNotes,
    queueIds,
    departmentIds: uniq(departmentIds),
    managedEmployeeIds: uniq(managedEmployeeIds),
    securityClearance: clearance,
  };
}

/**
 * Manager scope is granted by permission, not by the accident of having a
 * department: service_desk.tickets.escalate / reports.view / admin all imply
 * responsibility for a department's tickets.
 */
function isManagerScope(perms: Set<string>): boolean {
  return (
    perms.has('service_desk.admin') ||
    perms.has('service_desk.tickets.escalate') ||
    perms.has('service_desk.reports.view') ||
    perms.has('service_desk.sla.manage')
  );
}

// ------------------------------------------------------- scope + ABAC facts

/**
 * SQL predicate that limits a ticket query to what `scope` may see.
 * Returns the fragment plus the parameters it needs, starting at $1.
 */
function scopePredicate(scope: TicketScope, alias = 't'): { sql: string; params: unknown[] } {
  if (scope.isAdmin) return { sql: 'true', params: [] };
  const ors: string[] = [];
  const params: unknown[] = [];

  // Own tickets - by user id and by employee id, because a ticket raised before
  // the requester had an ERP login is still theirs.
  if (scope.userId) {
    params.push(scope.userId);
    ors.push(`${alias}.requester_user_id = $${params.length}`);
  }
  if (scope.employeeId) {
    params.push(scope.employeeId);
    ors.push(`${alias}.requester_employee_id = $${params.length}`);
  }
  // If the caller is the requester line manager the request is theirs to see.
  // Reads the same fact set as inScope, so list and detail cannot disagree.
  if (scope.managedEmployeeIds.length > 0) {
    params.push(scope.managedEmployeeIds);
    ors.push(`${alias}.requester_employee_id = ANY($${params.length}::bigint[])`);
  }

  if (scope.isAgent) {
    if (scope.queueIds === null) {
      ors.push('true');
    } else if (scope.queueIds.length > 0) {
      params.push(scope.queueIds);
      ors.push(`${alias}.assigned_queue_id = ANY($${params.length}::bigint[])`);
    }
    if (scope.userId) {
      params.push(scope.userId);
      ors.push(`${alias}.assigned_to_user_id = $${params.length}`);
    }
  }

  if (scope.departmentIds.length > 0) {
    params.push(scope.departmentIds);
    ors.push(`${alias}.department_id = ANY($${params.length}::bigint[])`);
  }

  if (ors.length === 0) return { sql: 'false', params: [] };
  return { sql: `(${ors.join(' OR ')})`, params };
}

/** Same reach test, evaluated in JS against a loaded ticket. */
function inScope(scope: TicketScope, t: TicketRow): boolean {
  if (scope.isAdmin) return true;
  // Ids read back from Postgres are bigint-as-string while scope ids are
  // numbers, so every comparison goes through sameId/idIn.
  if (sameId(t.requester_user_id, scope.userId)) return true;
  if (sameId(t.requester_employee_id, scope.employeeId)) return true;
  // Line manager of the requester: the exact rule scopePredicate applies.
  if (idIn(scope.managedEmployeeIds, t.requester_employee_id)) return true;
  if (scope.isAgent) {
    if (sameId(t.assigned_to_user_id, scope.userId)) return true;
    if (scope.queueIds === null) return true;
    if (idIn(scope.queueIds, t.assigned_queue_id)) return true;
  }
  if (idIn(scope.departmentIds, t.department_id)) return true;
  return false;
}

export interface TicketActionContext {
  ticket: TicketRow;
  scope: TicketScope;
  /** Facts the ABAC engine needs; assign to req.ctx.resourceAttributes. */
  attributes: Record<string, unknown>;
  /** True when the caller is the person (or delegate) who raised the ticket. */
  isRequester: boolean;
}

const TICKET_COLUMNS = `t.*`;

export async function loadTicketRow(client: pg.PoolClient, ctx: Ctx, id: number): Promise<TicketRow | null> {
  const res = await client.query<TicketRow>(
    `SELECT ${TICKET_COLUMNS} FROM service_tickets t
      WHERE t.id = $1 AND t.tenant_id = $2 AND t.company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
  );
  return res.rows[0] ?? null;
}

export async function loadTicketByNumber(client: pg.PoolClient, ctx: Ctx, ticketNumber: string): Promise<TicketRow | null> {
  const res = await client.query<TicketRow>(
    `SELECT ${TICKET_COLUMNS} FROM service_tickets t
      WHERE t.ticket_number = $1 AND t.tenant_id = $2 AND t.company_id = $3`,
    [ticketNumber, ctx.tenantId, ctx.companyId]
  );
  return res.rows[0] ?? null;
}

export function ticketResourceAttributes(
  scope: TicketScope,
  t: TicketRow,
  action: string
): Record<string, unknown> {
  const isRequester =
    sameId(t.requester_user_id, scope.userId) || sameId(t.requester_employee_id, scope.employeeId);
  const classified = t.data_classification === 'CONFIDENTIAL' || t.data_classification === 'RESTRICTED';
  const scoped = inScope(scope, t);
  const attrs: Record<string, unknown> = {
    module: 'service_desk',
    resource: 'tickets',
    action,
    ticket_id: t.id,
    ticket_number: t.ticket_number,
    requester_user_id: t.requester_user_id,
    requester_employee_id: t.requester_employee_id,
    department_id: t.department_id,
    priority: t.priority,
    status: t.status,
    data_classification: t.data_classification,
    // SD-CLASSIFIED keys on this: the requester always keeps their own ticket,
    // everyone else needs a security clearance for CONFIDENTIAL/RESTRICTED.
    classified_denied: classified && !isRequester && !scope.securityClearance,
    service_desk_agent: scope.isAgent,
    service_desk_internal_notes: scope.canViewInternalNotes,
    service_desk_readonly: false,
  };
  // SD-OUT-OF-SCOPE denies when scope_denied is present and true. Publishing the
  // key only when it applies keeps SD-AGENT-SCOPE's {$exists:false} meaningful.
  if (!scoped) attrs.scope_denied = true;
  return attrs;
}

/**
 * Load a ticket, resolve the caller's reach, and publish the ABAC facts.
 * Throws before the caller can forget: out-of-scope is refused here, not in a
 * policy that may or may not run.
 */
export async function ticketActionContext(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  action: string
): Promise<TicketActionContext> {
  const ticket = isNumericRef(ref) ? await loadTicketRow(client, ctx, Number(ref)) : await loadTicketByNumber(client, ctx, String(ref));
  if (!ticket) throw notFound('Service ticket not found');
  const scope = await resolveScope(client, ctx);
  const isRequester =
    sameId(ticket.requester_user_id, scope.userId) ||
    sameId(ticket.requester_employee_id, scope.employeeId);
  const attributes = ticketResourceAttributes(scope, ticket, action);
  ctx.resourceAttributes = { ...(ctx.resourceAttributes ?? {}), ...attributes };
  return { ticket, scope, attributes, isRequester };
}

/** Refuse a ticket the caller cannot reach. Defence in depth behind ABAC. */
export function assertScoped(c: TicketActionContext): void {
  if (c.attributes.scope_denied === true) {
    throw forbidden('This ticket is outside your service desk scope');
  }
}

/** Internal notes are invisible without the explicit permission. */
export function commentVisibility(scope: TicketScope): string {
  // The alias is `cm` in every statement that interpolates this clause; a
  // mismatch is a runtime SQL error, not a compile error, so it is asserted in
  // the service desk test suite.
  return scope.canViewInternalNotes ? 'true' : 'cm.is_internal = false';
}

// ------------------------------------------------- categories and subcategory

export async function listCategories(client: pg.PoolClient, ctx: Ctx, q: { includeInactive?: boolean } = {}) {
  const cats = await client.query(
    `SELECT c.id, c.code, c.name, c.description, c.icon, c.accent, c.default_priority,
            c.default_queue_id, c.sort_order, c.is_active
       FROM service_categories c
      WHERE c.tenant_id = $1 AND c.company_id = $2
        AND ($3::boolean OR c.is_active)
      ORDER BY c.sort_order, c.name`,
    [ctx.tenantId, ctx.companyId, q.includeInactive === true]
  );
  const subs = await client.query(
    `SELECT sc.id, sc.category_id, sc.code, sc.name, sc.description, sc.default_priority,
            sc.default_queue_id, sc.requires_asset, sc.requires_approval, sc.sort_order, sc.is_active
       FROM service_subcategories sc
      WHERE sc.tenant_id = $1 AND sc.company_id = $2
        AND ($3::boolean OR sc.is_active)
      ORDER BY sc.sort_order, sc.name`,
    [ctx.tenantId, ctx.companyId, q.includeInactive === true]
  );
  const byCat = new Map<number, unknown[]>();
  for (const row of subs.rows) {
    const key = Number(row.category_id);
    const list = byCat.get(key) ?? [];
    list.push(row);
    byCat.set(key, list);
  }
  return cats.rows.map((c) => ({ ...c, subcategories: byCat.get(Number(c.id)) ?? [] }));
}

export async function createCategory(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const code = s(b.code);
  const name = s(b.name);
  if (!code) throw badRequest('Category code is required');
  if (!name) throw badRequest('Category name is required');
  const accent = s(b.accent) ?? 'SKY';
  const priority = b.defaultPriority ? oneOf(b.defaultPriority, PRIORITIES, 'defaultPriority') : 'P3';
  const res = await client.query(
    `INSERT INTO service_categories
       (tenant_id, company_id, code, name, description, icon, accent, default_queue_id,
        default_priority, sort_order, is_active, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
     RETURNING *`,
    [
      ctx.tenantId, ctx.companyId, code.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), name,
      s(b.description) ?? null, s(b.icon) ?? null, accent, nn(b.defaultQueueId), priority,
      n(b.sortOrder) ?? 100, b.isActive === undefined ? true : truthy(b.isActive), ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'create', resource: 'service_desk.categories', recordId: Number(res.rows[0].id),
    recordCode: String(res.rows[0].code), newValues: res.rows[0],
  });
  return res.rows[0];
}

export async function updateCategory(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown>) {
  const before = await client.query('SELECT * FROM service_categories WHERE id = $1 AND tenant_id = $2 AND company_id = $3', [id, ctx.tenantId, ctx.companyId]);
  if (before.rows.length === 0) throw notFound('Service category not found');
  const res = await client.query(
    `UPDATE service_categories
        SET name = COALESCE($4, name),
            description = COALESCE($5, description),
            icon = COALESCE($6, icon),
            accent = COALESCE($7, accent),
            default_queue_id = COALESCE($8, default_queue_id),
            default_priority = COALESCE($9, default_priority),
            sort_order = COALESCE($10, sort_order),
            is_active = COALESCE($11, is_active),
            updated_by = $12,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3
      RETURNING *`,
    [
      id, ctx.tenantId, ctx.companyId, s(b.name) ?? null, s(b.description) ?? null, s(b.icon) ?? null,
      s(b.accent) ?? null, nn(b.defaultQueueId),
      b.defaultPriority !== undefined ? oneOf(b.defaultPriority, PRIORITIES, 'defaultPriority') : null,
      n(b.sortOrder) ?? null, b.isActive === undefined ? null : truthy(b.isActive), ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'update', resource: 'service_desk.categories', recordId: id,
    recordCode: String(before.rows[0].code), oldValues: before.rows[0], newValues: res.rows[0],
  });
  return res.rows[0];
}

export async function createSubcategory(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const categoryId = n(b.categoryId);
  const code = s(b.code);
  const name = s(b.name);
  if (!categoryId) throw badRequest('categoryId is required');
  if (!code) throw badRequest('Subcategory code is required');
  if (!name) throw badRequest('Subcategory name is required');
  const cat = await client.query('SELECT id FROM service_categories WHERE id = $1 AND tenant_id = $2 AND company_id = $3', [categoryId, ctx.tenantId, ctx.companyId]);
  if (cat.rows.length === 0) throw notFound('Service category not found');
  const res = await client.query(
    `INSERT INTO service_subcategories
       (tenant_id, company_id, category_id, code, name, description, default_priority,
        default_queue_id, requires_asset, requires_approval, sort_order, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      ctx.tenantId, ctx.companyId, categoryId, code.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), name,
      s(b.description) ?? null,
      b.defaultPriority !== undefined ? oneOf(b.defaultPriority, PRIORITIES, 'defaultPriority') : null,
      nn(b.defaultQueueId), truthy(b.requiresAsset), truthy(b.requiresApproval),
      n(b.sortOrder) ?? 100, b.isActive === undefined ? true : truthy(b.isActive), ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'create', resource: 'service_desk.subcategories', recordId: Number(res.rows[0].id),
    recordCode: String(res.rows[0].code), newValues: res.rows[0],
  });
  return res.rows[0];
}

export async function updateSubcategory(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown>) {
  const before = await client.query('SELECT * FROM service_subcategories WHERE id = $1 AND tenant_id = $2 AND company_id = $3', [id, ctx.tenantId, ctx.companyId]);
  if (before.rows.length === 0) throw notFound('Service subcategory not found');
  const res = await client.query(
    `UPDATE service_subcategories
        SET name = COALESCE($4, name),
            description = COALESCE($5, description),
            default_priority = COALESCE($6, default_priority),
            default_queue_id = COALESCE($7, default_queue_id),
            requires_asset = COALESCE($8, requires_asset),
            requires_approval = COALESCE($9, requires_approval),
            sort_order = COALESCE($10, sort_order),
            is_active = COALESCE($11, is_active),
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3
      RETURNING *`,
    [
      id, ctx.tenantId, ctx.companyId, s(b.name) ?? null, s(b.description) ?? null,
      b.defaultPriority !== undefined ? oneOf(b.defaultPriority, PRIORITIES, 'defaultPriority') : null,
      nn(b.defaultQueueId), b.requiresAsset === undefined ? null : truthy(b.requiresAsset),
      b.requiresApproval === undefined ? null : truthy(b.requiresApproval),
      n(b.sortOrder) ?? null, b.isActive === undefined ? null : truthy(b.isActive),
    ]
  );
  await logAudit(client, ctx, {
    action: 'update', resource: 'service_desk.subcategories', recordId: id,
    recordCode: String(before.rows[0].code), oldValues: before.rows[0], newValues: res.rows[0],
  });
  return res.rows[0];
}

// ------------------------------------------------------------------- queues

export async function listQueues(client: pg.PoolClient, ctx: Ctx, q: { includeInactive?: boolean } = {}) {
  const res = await client.query(
    `SELECT q.*,
            (SELECT count(*) FROM service_tickets t
              WHERE t.assigned_queue_id = q.id AND t.status = ANY($4::text[])) AS open_tickets,
            (SELECT count(*) FROM service_team_members m WHERE m.team_id = q.team_id AND m.is_active) AS team_size
       FROM service_queues q
      WHERE q.tenant_id = $1 AND q.company_id = $2
        AND ($3::boolean OR q.is_active)
      ORDER BY q.is_default DESC, q.name`,
    [ctx.tenantId, ctx.companyId, q.includeInactive === true, ACTIVE_STATUSES as unknown as string[]]
  );
  return res.rows;
}

export async function createQueue(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const code = s(b.code);
  const name = s(b.name);
  if (!code) throw badRequest('Queue code is required');
  if (!name) throw badRequest('Queue name is required');
  const strategy = b.assignmentStrategy !== undefined
    ? oneOf(b.assignmentStrategy, ASSIGNMENT_STRATEGIES, 'assignmentStrategy')
    : 'LOAD_BALANCED';
  const res = await client.query(
    `INSERT INTO service_queues
       (tenant_id, company_id, branch_id, department_id, code, name, description, category_id,
        assignment_strategy, team_id, target_response_minutes, target_resolution_minutes,
        max_open_tickets, is_default, is_active, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
     RETURNING *`,
    [
      ctx.tenantId, ctx.companyId, nn(b.branchId), nn(b.departmentId),
      code.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), name, s(b.description) ?? null, nn(b.categoryId),
      strategy, nn(b.teamId), n(b.targetResponseMinutes) ?? 60, n(b.targetResolutionMinutes) ?? 480,
      nn(b.maxOpenTickets), truthy(b.isDefault), b.isActive === undefined ? true : truthy(b.isActive),
      ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'create', resource: 'service_desk.queues', recordId: Number(res.rows[0].id),
    recordCode: String(res.rows[0].code), newValues: res.rows[0],
  });
  return res.rows[0];
}

export async function updateQueue(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown>) {
  const before = await client.query('SELECT * FROM service_queues WHERE id = $1 AND tenant_id = $2 AND company_id = $3', [id, ctx.tenantId, ctx.companyId]);
  if (before.rows.length === 0) throw notFound('Service queue not found');
  const res = await client.query(
    `UPDATE service_queues
        SET name = COALESCE($4, name),
            description = COALESCE($5, description),
            category_id = COALESCE($6, category_id),
            department_id = COALESCE($7, department_id),
            assignment_strategy = COALESCE($8, assignment_strategy),
            team_id = COALESCE($9, team_id),
            target_response_minutes = COALESCE($10, target_response_minutes),
            target_resolution_minutes = COALESCE($11, target_resolution_minutes),
            max_open_tickets = COALESCE($12, max_open_tickets),
            is_default = COALESCE($13, is_default),
            is_active = COALESCE($14, is_active),
            updated_by = $15,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3
      RETURNING *`,
    [
      id, ctx.tenantId, ctx.companyId, s(b.name) ?? null, s(b.description) ?? null, nn(b.categoryId),
      nn(b.departmentId),
      b.assignmentStrategy !== undefined ? oneOf(b.assignmentStrategy, ASSIGNMENT_STRATEGIES, 'assignmentStrategy') : null,
      nn(b.teamId), n(b.targetResponseMinutes) ?? null, n(b.targetResolutionMinutes) ?? null,
      nn(b.maxOpenTickets), b.isDefault === undefined ? null : truthy(b.isDefault),
      b.isActive === undefined ? null : truthy(b.isActive), ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'update', resource: 'service_desk.queues', recordId: id,
    recordCode: String(before.rows[0].code), oldValues: before.rows[0], newValues: res.rows[0],
  });
  return res.rows[0];
}

// ---------------------------------------------- ticket numbers and priority

/**
 * Ticket numbers are issued by the database (`next_service_ticket_no`) so two
 * concurrent requests can never share a number and a rolled-back transaction
 * never leaks a number for reuse.
 */
async function nextTicketNumber(client: pg.PoolClient, ctx: Ctx): Promise<string> {
  const res = await client.query<{ ticket_number: string }>(
    `SELECT next_service_ticket_no($1, $2) AS ticket_number`,
    [ctx.tenantId, ctx.companyId]
  );
  const no = res.rows[0]?.ticket_number;
  if (!no) throw conflict('Unable to allocate a service ticket number');
  return String(no);
}

/** IMPACT + URGENCY -> PRIORITY, evaluated by the database matrix. */
export async function priorityFor(client: pg.PoolClient, impact: string, urgency: string): Promise<string> {
  const res = await client.query<{ priority: string }>(
    `SELECT service_priority_for($1, $2) AS priority`,
    [impact, urgency]
  );
  return String(res.rows[0]?.priority ?? 'P3');
}

/**
 * The queue a brand new ticket lands in: subcategory default, then category
 * default, then the company default desk.
 */
async function pickQueue(
  client: pg.PoolClient,
  ctx: Ctx,
  categoryId: number | null,
  subcategoryId: number | null
): Promise<number | null> {
  const res = await client.query<{ id: number | null }>(
    `SELECT COALESCE(
              (SELECT sc.default_queue_id FROM service_subcategories sc
                WHERE sc.id = $3 AND sc.tenant_id = $1 AND sc.company_id = $2),
              (SELECT c.default_queue_id FROM service_categories c
                WHERE c.id = $4 AND c.tenant_id = $1 AND c.company_id = $2),
              (SELECT q.id FROM service_queues q
                WHERE q.tenant_id = $1 AND q.company_id = $2 AND q.is_active AND q.is_default
                ORDER BY q.id LIMIT 1)) AS id`,
    [ctx.tenantId, ctx.companyId, subcategoryId, categoryId]
  );
  const id = res.rows[0]?.id;
  return id === null || id === undefined ? null : Number(id);
}

/**
 * Raising a ticket FOR ANOTHER PERSON is a desk capability, not a self-service
 * one. Every employee holds `service_desk.tickets.create` (it is what lets them
 * raise their own ticket), so it can never be the gate for naming a requester.
 * The grant is deliberately separate so the capability can be reported, revoked
 * and audited on its own.
 */
export const CREATE_ON_BEHALF_PERMISSION = 'service_desk.tickets.create_on_behalf';

export function mayActOnBehalf(scope: TicketScope): boolean {
  return scope.isAdmin || scope.permissions.includes(CREATE_ON_BEHALF_PERMISSION);
}

// ------------------------------------------------------------ create ticket

export interface CreateTicketOptions {
  /** Employee portal: the requester is always the authenticated caller. */
  selfService?: boolean;
}

export async function createTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  b: Record<string, unknown>,
  opts: CreateTicketOptions = {}
) {
  const scope = await resolveScope(client, ctx);

  // Impersonation is impossible by construction. The self-service portal never
  // reads the requester from the request body; the desk path is gated on the
  // explicit create-on-behalf capability rather than on
  // service_desk.tickets.create, which every employee already holds in order to
  // raise their own ticket.
  const onBehalf = opts.selfService !== true && mayActOnBehalf(scope);

  let requesterEmployeeId: number | null = null;
  let requesterUserId: number | null = null;

  if (onBehalf) {
    requesterEmployeeId = n(b.requesterEmployeeId) ?? n(b.requester_employee_id) ?? null;
    requesterUserId = n(b.requesterUserId) ?? n(b.requester_user_id) ?? null;
    if (requesterEmployeeId) {
      const emp = await client.query<{ id: number; user_id: number | null; department_id: number | null; branch_id: number | null }>(
        `SELECT id, user_id, department_id, branch_id FROM employees
          WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
        [requesterEmployeeId, ctx.tenantId, ctx.companyId]
      );
      if (emp.rows.length === 0) throw badRequest('Requester employee not found in this company');
      requesterUserId = requesterUserId ?? emp.rows[0].user_id ?? null;
    } else if (requesterUserId) {
      const usr = await client.query<{ employee_id: number | null }>(
        `SELECT employee_id FROM users WHERE id = $1 AND tenant_id = $2`,
        [requesterUserId, ctx.tenantId]
      );
      if (usr.rows.length === 0) throw badRequest('Requester user not found in this tenant');
      requesterEmployeeId = usr.rows[0].employee_id ?? null;
    }
  }

  // A caller without the capability who names somebody else is refused outright
  // rather than silently rewritten, so the attempt reaches the audit trail.
  if (!onBehalf) {
    const claimedEmployeeId = nn(b.requesterEmployeeId ?? b.requester_employee_id);
    const claimedUserId = nn(b.requesterUserId ?? b.requester_user_id);
    const foreign =
      (claimedEmployeeId !== null && claimedEmployeeId !== scope.employeeId) ||
      (claimedUserId !== null && claimedUserId !== scope.userId);
    if (foreign) {
      throw forbidden(
        'Raising a ticket for another employee requires ' + CREATE_ON_BEHALF_PERMISSION
      );
    }
  }

  if (!requesterEmployeeId && !requesterUserId) {
    requesterEmployeeId = scope.employeeId;
    requesterUserId = scope.userId;
  }
  if (!requesterEmployeeId && !requesterUserId) {
    throw badRequest('A requester is required');
  }

  const ticketType = b.ticketType !== undefined
    ? oneOf(b.ticketType, TICKET_TYPES, 'ticketType')
    : b.ticket_type !== undefined
      ? oneOf(b.ticket_type, TICKET_TYPES, 'ticket_type')
      : 'SERVICE_REQUEST';

  const categoryId = nn(b.categoryId ?? b.category_id);
  if (!categoryId) throw badRequest('Category is required');
  const cat = await client.query<{ id: number; default_priority: string | null; default_queue_id: number | null }>(
    `SELECT id, default_priority, default_queue_id FROM service_categories
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3 AND is_active`,
    [categoryId, ctx.tenantId, ctx.companyId]
  );
  if (cat.rows.length === 0) throw badRequest('Service category not found or inactive');

  const subcategoryId = nn(b.subcategoryId ?? b.subcategory_id);
  if (!subcategoryId) throw badRequest('Subcategory is required');
  const sub = await client.query<{ id: number; category_id: number; requires_asset: boolean; requires_approval: boolean; default_priority: string | null }>(
    `SELECT id, category_id, requires_asset, requires_approval, default_priority
       FROM service_subcategories
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3 AND is_active`,
    [subcategoryId, ctx.tenantId, ctx.companyId]
  );
  if (sub.rows.length === 0) throw badRequest('Service subcategory not found or inactive');
  if (Number(sub.rows[0].category_id) !== categoryId) {
    throw badRequest('Subcategory does not belong to the selected category');
  }

  const subject = s(b.subject);
  if (!subject) throw badRequest('Subject is required');
  if (subject.length > 200) throw badRequest('Subject must be 200 characters or fewer');
  const description = s(b.description);
  if (!description) throw badRequest('Description is required');

  const impact = b.impact !== undefined ? oneOf(b.impact, IMPACTS, 'impact') : 'INDIVIDUAL';
  const urgency = b.urgency !== undefined ? oneOf(b.urgency, SEVERITIES, 'urgency') : 'MEDIUM';

  // Manual override is a privilege, not a field: without the permission the
  // matrix always wins, and every override is recorded with its reason.
  const requestedPriority = b.priority !== undefined ? oneOf(b.priority, PRIORITIES, 'priority') : undefined;
  const mayOverride = scope.isAdmin || scope.permissions.includes('service_desk.tickets.assign');
  const matrixPriority = await priorityFor(client, impact, urgency);
  let priority = matrixPriority;
  let priorityOverridden = false;
  let priorityOverrideReason: string | null = null;
  if (requestedPriority && requestedPriority !== matrixPriority) {
    if (mayOverride) {
      priority = requestedPriority;
      priorityOverridden = true;
      priorityOverrideReason = s(b.priorityOverrideReason ?? b.priority_override_reason) ?? 'Manual override';
    }
  } else if (requestedPriority) {
    priority = requestedPriority;
  }

  const classification = b.dataClassification !== undefined || b.data_classification !== undefined
    ? oneOf(b.dataClassification ?? b.data_classification, CLASSIFICATIONS, 'dataClassification')
    : 'INTERNAL';

  const preferredContact = b.preferredContact !== undefined || b.preferred_contact !== undefined
    ? oneOf(b.preferredContact ?? b.preferred_contact, CONTACT_METHODS, 'preferredContact')
    : 'PORTAL';

  const affectedAssetId = nn(b.affectedAssetId ?? b.affected_asset_id);
  if (affectedAssetId) {
    const asset = await client.query(
      `SELECT id FROM asset_register WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
      [affectedAssetId, ctx.tenantId, ctx.companyId]
    );
    if (asset.rows.length === 0) throw badRequest('Affected asset not found in this company');
  } else if (sub.rows[0].requires_asset) {
    throw badRequest('This request type requires an affected asset');
  }

  const ticketNumber = await nextTicketNumber(client, ctx);
  const queueId = await pickQueue(client, ctx, categoryId, subcategoryId);
  const tags = strList(b.tags);
  const deviceInfo = b.deviceInfo ?? b.device_info ?? {};
  const source = (() => {
    const raw = s(b.source);
    if (!raw) return onBehalf ? 'AGENT' : 'PORTAL';
    const up = raw.toUpperCase().replace(/[ -]+/g, '_');
    return (TICKET_SOURCES as readonly string[]).includes(up) ? up : 'PORTAL';
  })();

  const inserted = await client.query<TicketRow>(
    `INSERT INTO service_tickets
       (tenant_id, company_id, branch_id, department_id, ticket_number, ticket_type,
        requester_employee_id, requester_user_id, preferred_contact, category_id, subcategory_id,
        subject, description, impact, urgency, priority, priority_overridden, priority_override_reason,
        status, status_reason, data_classification, assigned_queue_id, affected_asset_id,
        device_info, source, tags, opened_at, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             'NEW','Ticket created',$19,$20,$21,$22::jsonb,$23,$24::text[],now(),$25,$25)
     RETURNING *`,
    [
      ctx.tenantId, ctx.companyId, nn(b.branchId ?? b.branch_id) ?? ctx.branchId ?? null,
      nn(b.departmentId ?? b.department_id) ?? (await requesterDepartment(client, requesterEmployeeId)),
      ticketNumber, ticketType, requesterEmployeeId, requesterUserId, preferredContact,
      categoryId, subcategoryId, subject, description, impact, urgency, priority,
      priorityOverridden, priorityOverrideReason, classification, queueId, affectedAssetId,
      JSON.stringify(deviceInfo ?? {}), source, tags, ctx.userId ?? null,
    ]
  );
  const ticket = inserted.rows[0];

  // The type-specific detail row keeps the aggregate honest: an INCIDENT is
  // always findable as an incident, an ACCESS_REQUEST always as a request.
  if (ticketType === 'INCIDENT' || ticketType === 'SECURITY_INCIDENT') {
    await client.query(
      `INSERT INTO incidents
         (tenant_id, company_id, branch_id, ticket_id, incident_no, detection_source,
          detected_at, affected_asset_id, is_security_incident, impact_summary, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8,$9,$10,$10)`,
      [
        ctx.tenantId, ctx.companyId, ticket.branch_id, ticket.id,
        ticketNumber.replace('HDG-SD-', 'HDG-INC-'),
        source === 'QR_SCAN' ? 'QR_SCAN' : 'USER_REPORT',
        affectedAssetId, ticketType === 'SECURITY_INCIDENT', description, ctx.userId ?? null,
      ]
    );
  } else if (
    ticketType === 'SERVICE_REQUEST' || ticketType === 'ACCESS_REQUEST' ||
    ticketType === 'MAINTENANCE_REQUEST' || ticketType === 'CHANGE_REQUEST'
  ) {
    await client.query(
      `INSERT INTO service_requests
         (tenant_id, company_id, branch_id, ticket_id, subcategory_id, catalog_item, quantity,
          required_by, delivery_location, preferred_contact_method, fulfilment_status, notes,
          created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,'REQUESTED',$10,$11,$11)`,
      [
        ctx.tenantId, ctx.companyId, ticket.branch_id, ticket.id, subcategoryId,
        s(b.catalogItem ?? b.catalog_item) ?? subject,
        (s(b.requiredBy ?? b.required_by) ?? null) as unknown as string | null,
        s(b.deliveryLocation ?? b.delivery_location) ?? null,
        CONTACT_METHODS.includes(preferredContact as (typeof CONTACT_METHODS)[number]) &&
        preferredContact !== 'WHATSAPP'
          ? preferredContact
          : 'PORTAL',
        s(b.notes) ?? null, ctx.userId ?? null,
      ]
    );
  }

  await logAudit(client, ctx, {
    action: 'create',
    resource: 'service_desk.tickets',
    recordId: Number(ticket.id),
    recordCode: ticket.ticket_number,
    newValues: ticket as unknown as Record<string, unknown>,
    metadata: {
      on_behalf: onBehalf && !sameId(requesterUserId, ctx.userId),
      priority_overridden: priorityOverridden,
      matrix_priority: matrixPriority,
    },
  });

  // Queue first so the SLA timer and the assignment both see a routable ticket.
  let assigned: Awaited<ReturnType<typeof autoAssignTicket>> | null = null;
  if (queueId) {
    assigned = await autoAssignTicket(client, ctx, ticket, { queueId });
  }

  const window = await applySlaToTicket(client, ctx, {
    id: Number(ticket.id),
    companyId: Number(ticket.company_id),
    branchId: ticket.branch_id,
    categoryId,
    subcategoryId,
    priority,
    ticketType,
    departmentId: ticket.department_id,
    openedAt: ticket.opened_at,
  });

  await emitEvent(client, ctx, {
    eventType: 'service_desk.ticket.created',
    entityType: 'service_ticket',
    entityId: Number(ticket.id),
    entityCode: ticket.ticket_number,
    severity: priority === 'P1' ? 'CRITICAL' : priority === 'P2' ? 'WARN' : 'INFO',
    payload: {
      ticketNumber: ticket.ticket_number,
      subject,
      ticketType,
      priority,
      status: 'NEW',
      requesterUserId,
      categoryId,
      subcategoryId,
      queueId,
      affectedAssetId,
    },
  });

  await notifyDeskRoles(client, ctx, ['service_desk_agent', 'service_desk_manager', 'it_support_administrator'], {
    type: 'service_desk.ticket.created',
    title: `${priority} ${ticketNumber}: ${subject}`,
    body: `A new ${ticketType.replace(/_/g, ' ').toLowerCase()} was raised.`,
    link: `/service-desk/tickets/${ticket.id}`,
    entityType: 'service_ticket',
    entityId: Number(ticket.id),
    severity: priority === 'P1' ? 'ERROR' : priority === 'P2' ? 'WARN' : 'INFO',
    actionRequired: true,
  }, { excludeUserId: ctx.userId ?? null, queueId });

  if (requesterUserId) {
    await createNotification(client, ctx, {
      userId: requesterUserId,
      type: 'service_desk.ticket.created',
      title: `Ticket ${ticketNumber} received`,
      body: `We have logged your request: ${subject}.`,
      link: `/my/service-desk/tickets/${ticket.id}`,
      entityType: 'service_ticket',
      entityId: Number(ticket.id),
      severity: 'INFO',
    });
  }

  return {
    ...ticket,
    assignment: assigned,
    sla: window,
  };
}

/** The requester's department, used when the body does not name one. */
async function requesterDepartment(client: pg.PoolClient, employeeId: number | null): Promise<number | null> {
  if (!employeeId) return null;
  const res = await client.query<{ department_id: number | null }>(
    `SELECT department_id FROM employees WHERE id = $1`,
    [employeeId]
  );
  return res.rows[0]?.department_id ?? null;
}

// ------------------------------------------------------------ notifications

/**
 * Role notification with a tenant predicate. `notifyRole` in notifications.ts
 * is intentionally tenant-agnostic for interactive use; background work and
 * cross-company fan-out must not leak, so the Service Desk uses this instead.
 *
 * When a queue is supplied the notification prefers that queue's team members
 * and only widens to every role holder when nobody is bound to the queue.
 */
async function notifyDeskRoles(
  client: pg.PoolClient,
  ctx: Ctx,
  roleCodes: string[],
  n: Omit<NotificationInput, 'userId'>,
  opts: { excludeUserId?: number | null; queueId?: number | null } = {}
): Promise<number> {
  const people = new Set<number>();

  if (opts.queueId) {
    const scoped = await client.query<{ id: number }>(
      `SELECT DISTINCT u.id
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id
        WHERE r.code = ANY($1) AND u.tenant_id = $2 AND u.status = 'ACTIVE'
          AND u.id IN (
            SELECT m.user_id
              FROM service_team_members m
              JOIN service_queues q ON q.team_id = m.team_id
             WHERE q.id = $3 AND m.is_active)`,
      [roleCodes, ctx.tenantId, opts.queueId]
    );
    for (const row of scoped.rows) people.add(Number(row.id));
  }

  if (people.size === 0) {
    const all = await client.query<{ id: number }>(
      `SELECT DISTINCT u.id
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id
        WHERE r.code = ANY($1) AND u.tenant_id = $2 AND u.status = 'ACTIVE'`,
      [roleCodes, ctx.tenantId]
    );
    for (const row of all.rows) people.add(Number(row.id));
  }

  let sent = 0;
  for (const userId of people) {
    if (opts.excludeUserId && sameId(userId, opts.excludeUserId)) continue;
    await createNotification(client, ctx, { ...n, userId });
    sent += 1;
  }
  return sent;
}

// ------------------------------------------------------- assignment engine

interface AssignCandidate {
  user_id: number;
  open_tickets: number;
  last_assigned_at: string | null;
  skill_hits: number;
  is_lead?: boolean;
}

/**
 * Everyone who may receive work from a queue. Membership is: the queue's team
 * members when the queue is team-bound, otherwise holders of the Service Desk
 * agent/technician roles, optionally narrowed to the queue's department.
 */
async function assignmentCandidates(
  client: pg.PoolClient,
  ctx: Ctx,
  queueId: number,
  categoryId: number | null
): Promise<AssignCandidate[]> {
  const res = await client.query<AssignCandidate>(
    `WITH q AS (
       SELECT id, tenant_id, company_id, department_id, team_id
         FROM service_queues WHERE id = $1
     ),
     members AS (
       SELECT m.user_id, m.is_lead
         FROM service_team_members m
         JOIN q ON q.team_id IS NOT NULL AND q.team_id = m.team_id
        WHERE m.is_active
     ),
     agents AS (
       SELECT DISTINCT u.id AS user_id, false AS is_lead
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE u.tenant_id = $2
          AND u.status = 'ACTIVE'
          AND r.code IN ('service_desk_agent', 'service_desk_technician',
                         'service_desk_manager', 'it_support_administrator')
     )
     SELECT c.user_id,
            c.is_lead,
            (SELECT count(*) FROM service_tickets t
              WHERE t.assigned_to_user_id = c.user_id
                AND t.status = ANY($4::text[])) AS open_tickets,
            (SELECT max(a.assigned_at)::text FROM ticket_assignments a
              WHERE a.assigned_to_user_id = c.user_id) AS last_assigned_at,
            COALESCE((
              SELECT count(*)
                FROM service_agent_skills s
                JOIN service_category_skills cs ON cs.skill_id = s.skill_id
               WHERE s.user_id = c.user_id
                 AND cs.category_id = $3
                 AND s.proficiency >= COALESCE(cs.min_proficiency, 1)
            ), 0) AS skill_hits
       FROM (
         SELECT user_id, is_lead FROM members
         UNION
         SELECT user_id, is_lead FROM agents
       ) c
      ORDER BY c.user_id`,
    [queueId, ctx.tenantId, categoryId, ACTIVE_STATUSES as unknown as string[]]
  );
  return res.rows.map((r) => ({
    user_id: Number(r.user_id),
    open_tickets: Number(r.open_tickets),
    last_assigned_at: r.last_assigned_at ?? null,
    skill_hits: Number(r.skill_hits),
    is_lead: r.is_lead === true,
  }));
}

/** Choose the winner for a strategy. Pure so it can be unit tested. */
function pickAssignee(
  candidates: AssignCandidate[],
  strategy: string
): AssignCandidate | null {
  if (candidates.length === 0) return null;
  const pool = candidates.slice();
  const byIdle = (a: AssignCandidate, b: AssignCandidate): number => {
    // Never-assigned agents come first, then the longest-idle one: this is a
    // round robin that survives process restarts because it reads history.
    const at = a.last_assigned_at ? Date.parse(a.last_assigned_at) : 0;
    const bt = b.last_assigned_at ? Date.parse(b.last_assigned_at) : 0;
    if (at !== bt) return at - bt;
    return a.user_id - b.user_id;
  };
  const byLoad = (a: AssignCandidate, b: AssignCandidate): number => {
    if (a.open_tickets !== b.open_tickets) return a.open_tickets - b.open_tickets;
    return byIdle(a, b);
  };
  switch (strategy) {
    case 'ROUND_ROBIN':
      pool.sort(byIdle);
      break;
    case 'SKILL_BASED':
      pool.sort((a, b) => {
        if (a.skill_hits !== b.skill_hits) return b.skill_hits - a.skill_hits;
        return byLoad(a, b);
      });
      break;
    case 'TEAM':
      pool.sort((a, b) => {
        if (a.is_lead !== b.is_lead) return a.is_lead ? -1 : 1;
        return byLoad(a, b);
      });
      break;
    default:
      pool.sort(byLoad);
      break;
  }
  return pool[0] ?? null;
}

/** Map the configured queue strategy onto the assignment_type enum. */
function assignmentTypeFor(strategy: string, isReassignment: boolean): string {
  if (isReassignment && strategy === 'MANUAL') return 'MANUAL';
  switch (strategy) {
    case 'ROUND_ROBIN':
      return 'ROUND_ROBIN';
    case 'SKILL_BASED':
      return 'SKILL_BASED';
    case 'TEAM':
      return 'TEAM';
    case 'MANUAL':
      return 'MANUAL';
    case 'QUEUE':
      return 'QUEUE';
    default:
      return 'AUTOMATIC';
  }
}

interface QueueRow {
  id: number;
  code: string;
  name: string;
  department_id: number | null;
  team_id: number | null;
  category_id: number | null;
  assignment_strategy: string;
  target_response_minutes: number | null;
  target_resolution_minutes: number | null;
  max_open_tickets: number | null;
}

async function loadQueue(client: pg.PoolClient, ctx: Ctx, queueId: number): Promise<QueueRow | null> {
  const res = await client.query<QueueRow>(
    `SELECT id, code, name, department_id, team_id, category_id, assignment_strategy,
            target_response_minutes, target_resolution_minutes, max_open_tickets
       FROM service_queues
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [queueId, ctx.tenantId, ctx.companyId]
  );
  return res.rows[0] ?? null;
}

/**
 * Resolve the strategy for a queue, degrading gracefully when the data the
 * strategy needs does not exist yet:
 *   TEAM        -> needs a team bound to the queue
 *   SKILL_BASED -> needs at least one skill mapped in the company
 * In both cases the fallback is recorded in strategy_detail so the reason a
 * ticket went to a particular technician is never a mystery.
 */
async function resolveStrategy(
  client: pg.PoolClient,
  ctx: Ctx,
  queue: QueueRow,
  requested?: string
): Promise<{ strategy: string; detail: Record<string, unknown> }> {
  const configured = (requested ?? queue.assignment_strategy ?? 'LOAD_BALANCED').toUpperCase();
  const detail: Record<string, unknown> = { configured };

  if (configured === 'TEAM') {
    if (queue.team_id) {
      const n = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM service_team_members WHERE team_id = $1 AND is_active`,
        [queue.team_id]
      );
      if (Number(n.rows[0]?.c ?? 0) > 0) return { strategy: 'TEAM', detail };
    }
    detail.fallback = 'queue has no active team members';
    detail.effective = 'LOAD_BALANCED';
    return { strategy: 'LOAD_BALANCED', detail };
  }

  if (configured === 'SKILL_BASED') {
    const n = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c
         FROM service_category_skills cs
         JOIN service_agent_skills s ON s.skill_id = cs.skill_id
        WHERE cs.tenant_id = $1 AND cs.company_id = $2`,
      [ctx.tenantId, ctx.companyId]
    );
    if (Number(n.rows[0]?.c ?? 0) > 0) return { strategy: 'SKILL_BASED', detail };
    detail.fallback = 'no agent skills are mapped in this company';
    detail.effective = 'LOAD_BALANCED';
    return { strategy: 'LOAD_BALANCED', detail };
  }

  if (!['MANUAL', 'ROUND_ROBIN', 'LOAD_BALANCED'].includes(configured)) {
    detail.fallback = 'unknown strategy';
    detail.effective = 'LOAD_BALANCED';
    return { strategy: 'LOAD_BALANCED', detail };
  }
  return { strategy: configured, detail };
}

export interface AssignmentOutcome {
  assignmentId: number | null;
  assignedToUserId: number | null;
  queueId: number | null;
  teamId: number | null;
  strategy: string;
  assignmentType: string;
  status: string;
  strategyDetail: Record<string, unknown>;
}

/**
 * Route a ticket to a queue and (unless the queue is MANUAL) to a technician.
 * Used by ticket creation and by the explicit /assign endpoint.
 */
export async function autoAssignTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  ticket: TicketRow,
  opts: {
    queueId?: number | null;
    strategy?: string;
    toUserId?: number | null;
    teamId?: number | null;
    reason?: string | null;
    actorUserId?: number | null;
    force?: boolean;
  } = {}
): Promise<AssignmentOutcome> {
  const queueId = opts.queueId ?? ticket.assigned_queue_id ?? null;
  const queue = queueId ? await loadQueue(client, ctx, queueId) : null;

  const base: AssignmentOutcome = {
    assignmentId: null,
    assignedToUserId: null,
    queueId: queue?.id ?? null,
    teamId: queue?.team_id ?? opts.teamId ?? null,
    strategy: 'MANUAL',
    assignmentType: 'AUTOMATIC',
    status: ticket.status,
    strategyDetail: {},
  };

  // An explicit technician wins over every automatic strategy.
  let targetUserId = opts.toUserId ?? null;
  let strategy = 'MANUAL';
  let detail: Record<string, unknown> = {};

  if (targetUserId) {
    strategy = 'MANUAL';
    detail = { reason: opts.reason ?? 'Direct assignment' };
  } else if (queue) {
    const resolved = await resolveStrategy(client, ctx, queue, opts.strategy);
    strategy = resolved.strategy;
    detail = resolved.detail;
    if (strategy !== 'MANUAL') {
      const candidates = await assignmentCandidates(client, ctx, queue.id, queue.category_id ?? ticket.category_id ?? null);
      const chosen = pickAssignee(candidates, strategy);
      if (chosen) {
        targetUserId = chosen.user_id;
        detail.candidates = candidates.length;
        detail.open_tickets = chosen.open_tickets;
        detail.skill_hits = chosen.skill_hits;
      } else {
        detail.candidates = 0;
        detail.fallback = 'no eligible technicians on this queue';
      }
    }
  }

  const assignmentType = assignmentTypeFor(strategy, false);
  const previousAssignee = ticket.assigned_to_user_id ?? null;
  const isReassignment = previousAssignee !== null && !sameId(previousAssignee, targetUserId);

  if (targetUserId || queueId) {
    const ins = await client.query<{ id: number }>(
      `INSERT INTO ticket_assignments
         (tenant_id, company_id, branch_id, ticket_id, assignment_type, assigned_to_user_id,
          assigned_team_id, queue_id, previous_assignee_id, is_reassignment, reason, strategy_detail,
          assigned_by, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$13)
       RETURNING id`,
      [
        ctx.tenantId, ctx.companyId, ticket.branch_id, ticket.id, assignmentType,
        targetUserId, base.teamId, queueId, previousAssignee, isReassignment,
        opts.reason ?? null, JSON.stringify(detail), opts.actorUserId ?? ctx.userId ?? null,
      ]
    );
    base.assignmentId = Number(ins.rows[0].id);
  }

  // Close any assignment that is being replaced.
  if (base.assignmentId) {
    await client.query(
      `UPDATE ticket_assignments
          SET ended_at = now(), updated_at = now()
        WHERE ticket_id = $1 AND id <> $2 AND ended_at IS NULL`,
      [ticket.id, base.assignmentId]
    );
  }

  const nextStatus = (() => {
    if (!targetUserId) return ticket.status;
    return ['NEW', 'OPEN', 'REOPENED', 'ESCALATED'].includes(ticket.status) ? 'ASSIGNED' : ticket.status;
  })();

  const updated = await client.query<TicketRow>(
    `UPDATE service_tickets
        SET assigned_queue_id    = COALESCE($4, assigned_queue_id),
            assigned_team_id     = COALESCE($5, assigned_team_id),
            assigned_to_user_id  = $6,
            assignment_strategy  = $7,
            status               = $8,
            status_reason        = CASE WHEN $8 <> status THEN $9 ELSE status_reason END,
            updated_by           = $10,
            updated_at           = now()
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3
      RETURNING *`,
    [
      ticket.id, ctx.tenantId, ctx.companyId, queueId, base.teamId, targetUserId,
      strategy, nextStatus, `Auto-assigned to ${strategy.replace(/_/g, ' ').toLowerCase()}`,
      ctx.userId ?? null,
    ]
  );

  Object.assign(ticket, updated.rows[0] ?? {});
  base.assignedToUserId = targetUserId;
  base.strategy = strategy;
  base.assignmentType = assignmentType;
  base.status = nextStatus;
  base.strategyDetail = detail;

  await logAudit(client, ctx, {
    action: isReassignment ? 'reassign' : 'assign',
    resource: 'service_desk.tickets',
    recordId: Number(ticket.id),
    recordCode: ticket.ticket_number,
    oldValues: { assigned_to_user_id: previousAssignee, assigned_queue_id: ticket.assigned_queue_id },
    newValues: {
      assigned_to_user_id: targetUserId,
      assigned_queue_id: queueId,
      assigned_team_id: base.teamId,
      strategy,
      strategy_detail: detail,
    },
    metadata: { reason: opts.reason ?? null },
  });

  if (targetUserId) {
    await createNotification(client, ctx, {
      userId: targetUserId,
      type: 'service_desk.ticket.assigned',
      title: `${ticket.priority} ${ticket.ticket_number} assigned to you`,
      body: ticket.subject,
      link: `/service-desk/tickets/${ticket.id}`,
      entityType: 'service_ticket',
      entityId: Number(ticket.id),
      severity: ticket.priority === 'P1' ? 'ERROR' : 'INFO',
      actionRequired: true,
    });
  }

  await emitEvent(client, ctx, {
    eventType: 'service_desk.ticket.assigned',
    entityType: 'service_ticket',
    entityId: Number(ticket.id),
    entityCode: ticket.ticket_number,
    severity: 'INFO',
    payload: {
      ticketNumber: ticket.ticket_number,
      assignedToUserId: targetUserId,
      queueId,
      strategy,
      assignmentType,
      isReassignment,
    },
  });

  return base;
}

/** Explicit assignment / reassignment from the agent workspace. */
export async function assignTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  b: Record<string, unknown>
) {
  const action = await ticketActionContext(client, ctx, ticketId, 'assign');
  assertScoped(action);
  const ticket = action.ticket;

  const toUserId = nn(b.assignedToUserId ?? b.assigned_to_user_id ?? b.userId);
  const queueId = nn(b.queueId ?? b.queue_id) ?? ticket.assigned_queue_id ?? null;
  const reason = s(b.reason) ?? null;
  const requestedStrategy = b.strategy !== undefined
    ? oneOf(b.strategy, ASSIGNMENT_STRATEGIES, 'strategy')
    : b.assignmentType !== undefined
      ? oneOf(b.assignmentType, ASSIGNMENT_TYPES, 'assignmentType')
      : undefined;

  if (toUserId) {
    const user = await client.query(
      `SELECT u.id FROM users u WHERE u.id = $1 AND u.tenant_id = $2 AND u.status = 'ACTIVE'`,
      [toUserId, ctx.tenantId]
    );
    if (user.rows.length === 0) throw badRequest('Technician not found or inactive');
  }

  const outcome = await autoAssignTicket(client, ctx, ticket, {
    queueId,
    strategy: requestedStrategy,
    toUserId,
    teamId: nn(b.teamId ?? b.team_id),
    reason,
    actorUserId: ctx.userId ?? null,
  });

  if (
    ['NEW', 'OPEN', 'REOPENED', 'ESCALATED'].includes(String(ticket.status)) &&
    outcome.assignedToUserId
  ) {
    await refineSlaForAssignment(client, ctx, ticket);
  }

  return { ticket, assignment: outcome };
}

/**
 * Reassignment is assignment with a mandatory reason: the spec requires the
 * reason to be recorded for every move between technicians.
 */
export async function reassignTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  b: Record<string, unknown>
) {
  const reason = s(b.reason);
  if (!reason) throw badRequest('A reassignment reason is required');
  const action = await ticketActionContext(client, ctx, ticketId, 'assign');
  assertScoped(action);
  if (!action.ticket.assigned_to_user_id) {
    throw conflict('Ticket is not currently assigned; use assign instead');
  }
  return assignTicket(client, ctx, ticketId, { ...b, reason });
}

/** Keep the SLA row pointed at the department/queue the ticket now lives in. */
async function refineSlaForAssignment(client: pg.PoolClient, ctx: Ctx, ticket: TicketRow): Promise<void> {
  await applySlaToTicket(client, ctx, {
    id: Number(ticket.id),
    companyId: Number(ticket.company_id),
    branchId: ticket.branch_id,
    categoryId: ticket.category_id,
    subcategoryId: ticket.subcategory_id,
    priority: ticket.priority,
    ticketType: ticket.ticket_type,
    departmentId: ticket.department_id,
    openedAt: ticket.opened_at,
  });
}

/** Per-technician workload for the manager dashboard and the queues sidebar.
 *
 * Two correctness notes, both learned the hard way:
 *
 *   1. The query groups by real columns rather than the SELECT alias name.
 *      Postgres resolves a bare GROUP BY name against INPUT columns before
 *      output aliases, and the joined roles table has a name column, so the
 *      old grouping bound to roles.name and left the name expression
 *      ungrouped - error 42803, which surfaced as a 500 on both the agent and
 *      manager dashboards.
 *   2. The role test is EXISTS, not a join. Joining user_roles/roles emitted
 *      one row per matching role, so an agent who is also a manager had every
 *      ticket counted twice. EXISTS also lets the grant be scoped to the
 *      company being reported on, where a NULL company is a tenant-wide grant.
 */
export async function technicianWorkload(
  client: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown> = {}
) {
  const res = await client.query(
    `SELECT u.id AS user_id,
            COALESCE(e.first_name || ' ' || e.last_name, u.email) AS name,
            count(t.id) FILTER (WHERE t.status = ANY($3::text[])) AS open_tickets,
            count(t.id) FILTER (WHERE t.priority = 'P1' AND t.status = ANY($3::text[])) AS critical_tickets,
            count(t.id) FILTER (WHERE t.status = 'PENDING_REQUESTER') AS pending_tickets,
            count(t.id) FILTER (WHERE t.status = 'RESOLVED') AS resolved_tickets,
            count(t.id) FILTER (WHERE t.sla_resolution_due_at < now() AND t.status = ANY($3::text[])) AS overdue_tickets,
            round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.opened_at)) / 60.0)
                  FILTER (WHERE t.resolved_at IS NOT NULL)) AS avg_resolution_minutes
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN service_tickets t
              ON t.assigned_to_user_id = u.id
             AND t.tenant_id = $1 AND t.company_id = $2
             AND ($4::bigint IS NULL OR t.assigned_queue_id = $4)
      WHERE u.tenant_id = $1
        AND EXISTS (
          SELECT 1 FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id
             AND (ur.company_id IS NULL OR ur.company_id = $2)
             AND r.code IN ('service_desk_agent', 'service_desk_technician', 'service_desk_manager')
        )
      GROUP BY u.id, u.email, e.first_name, e.last_name
      ORDER BY open_tickets DESC, COALESCE(e.first_name || ' ' || e.last_name, u.email)`,
    [ctx.tenantId, ctx.companyId, ACTIVE_STATUSES as unknown as string[], nn(q.queueId ?? q.queue_id)]
  );
  return res.rows;
}

// ---------------------------------------------------------- ticket queries

/**
 * Rewrite the `$n` placeholders of a fragment so it can be appended to a query
 * that already owns the lower numbers. `scopePredicate` always starts at $1.
 */
const bindAfter = (sql: string, base: number): string =>
  sql.replace(/\$(\d+)/g, (_, d: string) => `$${Number(d) + base}`);

const TICKET_SELECT = `
  SELECT t.*,
         c.name  AS category_name,
         c.code  AS category_code,
         sc.name AS subcategory_name,
         q.name  AS queue_name,
         q.code  AS queue_code,
         COALESCE(nullif(trim(coalesce(ae.first_name, '') || ' ' || coalesce(ae.last_name, '')), ''), ru.email) AS assignee_name,
         ru.email AS assignee_email,
         req.employee_no AS requester_employee_no,
         nullif(trim(coalesce(req.first_name, '') || ' ' || coalesce(req.last_name, '')), '') AS requester_name,
         req.department_id AS requester_department_id,
         a.asset_no AS asset_no,
         a.name    AS asset_name,
         a.status  AS asset_status,
         s.state             AS sla_state,
         s.response_due_at   AS sla_response_due_at,
         s.resolution_due_at AS sla_resolution_due_at,
         s.response_state    AS sla_response_state,
         s.resolution_state  AS sla_resolution_state,
         s.response_warning_at   AS sla_response_warning_at,
         s.resolution_warning_at AS sla_resolution_warning_at,
         s.paused_at         AS sla_paused_at,
         EXISTS (SELECT 1 FROM sla_breaches b WHERE b.ticket_id = t.id) AS sla_breached,
         (SELECT count(*) FROM ticket_comments cm
           WHERE cm.ticket_id = t.id AND cm.comment_type = 'REPLY') AS reply_count,
         (SELECT count(*) FROM ticket_comments cm
           WHERE cm.ticket_id = t.id AND cm.comment_type = 'NOTE') AS note_count,
         (SELECT count(*) FROM ticket_attachments at WHERE at.ticket_id = t.id) AS attachment_count`;

const TICKET_FROM = `
    FROM service_tickets t
    LEFT JOIN service_categories c    ON c.id = t.category_id
    LEFT JOIN service_subcategories sc ON sc.id = t.subcategory_id
    LEFT JOIN service_queues q        ON q.id = t.assigned_queue_id
    LEFT JOIN users ru                ON ru.id = t.assigned_to_user_id
    LEFT JOIN employees ae            ON ae.id = ru.employee_id
    LEFT JOIN employees req           ON req.id = t.requester_employee_id
    LEFT JOIN asset_register a        ON a.id = t.affected_asset_id
    LEFT JOIN sla_tracking s          ON s.ticket_id = t.id`;

const TICKET_SORTS: Record<string, string> = {
  openedat: 't.opened_at',
  opened_at: 't.opened_at',
  updatedat: 't.updated_at',
  updated_at: 't.updated_at',
  priority: 't.priority',
  status: 't.status',
  ticketnumber: 't.ticket_number',
  ticket_number: 't.ticket_number',
  sla: 's.resolution_due_at',
  sladue: 's.resolution_due_at',
  resolutiondue: 's.resolution_due_at',
  subject: 't.subject',
};

export interface ListTicketsQuery extends Record<string, unknown> {
  search?: string;
  /** Restrict to tickets the caller raised. Used by the self-service portal. */
  mine?: boolean;
}

export async function listTickets(client: pg.PoolClient, ctx: Ctx, q: ListTicketsQuery = {}) {
  const scope = await resolveScope(client, ctx);
  const { page, pageSize, offset } = parsePagination(q);

  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where: string[] = ['t.tenant_id = $1', 't.company_id = $2'];

  const pred = scopePredicate(scope, 't');
  if (pred.sql !== 'true') {
    where.push(bindAfter(pred.sql, params.length));
    params.push(...pred.params);
  } else if (pred.sql === 'true' && !scope.isAdmin) {
    where.push('true');
  }

  const add = (value: unknown, build: (idx: number) => string): void => {
    if (value === undefined || value === null || value === '') return;
    params.push(value);
    where.push(build(params.length));
  };

  const statuses = strList(q.status).map((x) => x.toUpperCase());
  if (statuses.length === 1) add(statuses[0], (i) => `t.status = $${i}`);
  else if (statuses.length > 1) add(statuses, (i) => `t.status = ANY($${i}::text[])`);

  const priorities = strList(q.priority).map((x) => x.toUpperCase());
  if (priorities.length === 1) add(priorities[0], (i) => `t.priority = $${i}`);
  else if (priorities.length > 1) add(priorities, (i) => `t.priority = ANY($${i}::text[])`);

  const types = strList(q.ticketType ?? q.ticket_type ?? q.type).map((x) => x.toUpperCase().replace(/[ -]+/g, '_'));
  if (types.length === 1) add(types[0], (i) => `t.ticket_type = $${i}`);
  else if (types.length > 1) add(types, (i) => `t.ticket_type = ANY($${i}::text[])`);

  add(nn(q.categoryId ?? q.category_id), (i) => `t.category_id = $${i}`);
  add(nn(q.subcategoryId ?? q.subcategory_id), (i) => `t.subcategory_id = $${i}`);
  add(nn(q.queueId ?? q.queue_id), (i) => `t.assigned_queue_id = $${i}`);
  add(nn(q.assignedToUserId ?? q.assigned_to_user_id ?? q.assigneeId), (i) => `t.assigned_to_user_id = $${i}`);
  add(nn(q.departmentId ?? q.department_id), (i) => `t.department_id = $${i}`);
  add(nn(q.requesterUserId ?? q.requester_user_id), (i) => `t.requester_user_id = $${i}`);
  add(nn(q.requesterEmployeeId ?? q.requester_employee_id), (i) => `t.requester_employee_id = $${i}`);
  add(nn(q.affectedAssetId ?? q.affected_asset_id ?? q.assetId), (i) => `t.affected_asset_id = $${i}`);
  add(nn(q.branchId ?? q.branch_id), (i) => `t.branch_id = $${i}`);
  add(nn(q.relatedProblemId ?? q.problemId), (i) => `t.related_problem_id = $${i}`);

  if (truthy(q.unassigned)) where.push('t.assigned_to_user_id IS NULL');
  if (truthy(q.unassignedQueue)) where.push('t.assigned_queue_id IS NULL');
  if (truthy(q.critical)) where.push(`t.priority = 'P1' AND t.status = ANY($${pushParam(params, ACTIVE_STATUSES as unknown as string[])}::text[])`);
  if (truthy(q.active) || truthy(q.activeOnly)) where.push(`t.status = ANY($${pushParam(params, ACTIVE_STATUSES as unknown as string[])}::text[])`);
  if (truthy(q.overdue)) {
    where.push('s.resolution_due_at IS NOT NULL AND s.resolution_due_at < now()');
    where.push(`t.status = ANY($${pushParam(params, ACTIVE_STATUSES as unknown as string[])}::text[])`);
  }
  if (truthy(q.slaWarning)) {
    where.push('s.resolution_warning_at IS NOT NULL AND s.resolution_warning_at <= now()');
    where.push(`t.status = ANY($${pushParam(params, ACTIVE_STATUSES as unknown as string[])}::text[])`);
  }
  if (truthy(q.breached)) where.push('EXISTS (SELECT 1 FROM sla_breaches b WHERE b.ticket_id = t.id)');
  if (truthy(q.myTickets) && scope.userId) {
    params.push(scope.userId);
    where.push(`t.assigned_to_user_id = $${params.length}`);
  }
  if (truthy(q.myRequests) && scope.userId) {
    params.push(scope.userId);
    where.push(`t.requester_user_id = $${params.length}`);
  }
  // Caller-owned tickets only. Matching on both identities matters: a request
  // raised before the employee had an ERP login is keyed on employee id alone.
  if (truthy(q.mine) && (scope.userId || scope.employeeId)) {
    const own: string[] = [];
    if (scope.userId) {
      params.push(scope.userId);
      own.push('t.requester_user_id = $' + String(params.length));
    }
    if (scope.employeeId) {
      params.push(scope.employeeId);
      own.push('t.requester_employee_id = $' + String(params.length));
    }
    where.push('(' + own.join(' OR ') + ')');
  }

  if (truthy(q.securityOnly)) where.push('(t.ticket_type = \'SECURITY_INCIDENT\' OR t.data_classification IN (\'CONFIDENTIAL\',\'RESTRICTED\'))');

  add(s(q.openedFrom), (i) => `t.opened_at >= $${i}::timestamptz`);
  add(s(q.openedTo), (i) => `t.opened_at < $${i}::timestamptz`);

  const search = s(q.search);
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    where.push(`(t.ticket_number ILIKE $${i} OR t.subject ILIKE $${i} OR COALESCE(t.description,'') ILIKE $${i})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortKey = String(q.sortBy ?? q.sort ?? 'openedat').toLowerCase();
  const sortCol = TICKET_SORTS[sortKey] ?? 't.opened_at';
  const dir = String(q.sortDir ?? q.dir ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const totalRes = await client.query<{ total: string }>(
    `SELECT count(*)::text AS total ${TICKET_FROM} ${whereSql}`,
    params
  );
  const total = Number(totalRes.rows[0]?.total ?? 0);

  const rows = await client.query(
    `${TICKET_SELECT} ${TICKET_FROM} ${whereSql}
      ORDER BY ${sortCol} ${dir}, t.id DESC
      LIMIT $${pushParam(params, pageSize)} OFFSET $${pushParam(params, offset)}`,
    params
  );

  return {
    items: rows.rows,
    page,
    pageSize,
    total,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 1,
    scope: {
      isAgent: scope.isAgent,
      isAdmin: scope.isAdmin,
      isManager: scope.isManager,
      canViewInternalNotes: scope.canViewInternalNotes,
    },
  };
}

/** Push a parameter and return its 1-based placeholder index. */
function pushParam(params: unknown[], value: unknown): number {
  params.push(value);
  return params.length;
}

/** Full ticket workspace payload: header, SLA, asset, conversation, activity. */
export async function getTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  opts: { withComments?: boolean; withActivity?: boolean; commentLimit?: number } = {}
) {
  const action = await ticketActionContext(client, ctx, ref, 'view');
  assertScoped(action);
  const ticket = action.ticket;

  const header = await client.query(
    `${TICKET_SELECT} ${TICKET_FROM} WHERE t.id = $1 AND t.tenant_id = $2 AND t.company_id = $3`,
    [ticket.id, ctx.tenantId, ctx.companyId]
  );

  const [comments, attachments, asset, sla, escalations, related, knowledge] = await Promise.all([
    opts.withComments === false
      ? Promise.resolve({ rows: [] as unknown[] })
      : client.query(
          `SELECT cm.*,
                  COALESCE(nullif(trim(coalesce(ce.first_name, '') || ' ' || coalesce(ce.last_name, '')), ''), cu.email) AS author_name
             FROM ticket_comments cm
             LEFT JOIN users cu    ON cu.id = cm.author_user_id
             LEFT JOIN employees ce ON ce.id = cu.employee_id
            WHERE cm.ticket_id = $1 AND ${commentVisibility(action.scope)}
            ORDER BY cm.created_at ASC
            LIMIT $2`,
          [ticket.id, Math.min(500, Math.max(1, opts.commentLimit ?? 200))]
        ),
    client.query(
      `SELECT at.id, at.document_id, at.file_name, at.mime_type, at.size_bytes, at.kind,
              at.is_internal, at.uploaded_by_user_id, at.created_at
         FROM ticket_attachments at
        WHERE at.ticket_id = $1
          AND (${action.scope.canViewInternalNotes ? 'true' : 'at.is_internal = false'})
        ORDER BY at.created_at ASC`,
      [ticket.id]
    ),
    ticket.affected_asset_id
      ? client.query(
          `SELECT a.id, a.asset_no, a.name, a.status, a.condition, a.operational_state,
                  a.manufacturer, a.model, a.serial_no, a.qr_id, a.barcode,
                  a.location_id, a.department_id, a.last_maintenance, a.next_maintenance,
                  a.last_scan_at, cat.name AS category_name
             FROM asset_register a
             LEFT JOIN asset_categories cat ON cat.id = a.category_id
            WHERE a.id = $1 AND a.tenant_id = $2 AND a.company_id = $3`,
          [ticket.affected_asset_id, ctx.tenantId, ctx.companyId]
        )
      : Promise.resolve({ rows: [] as unknown[] }),
    client.query(
      `SELECT s.*, p.code AS policy_code, p.name AS policy_name, p.response_minutes, p.resolution_minutes,
              p.time_basis, p.pause_on_pending,
              (SELECT json_agg(json_build_object(
                        'id', b.id, 'type', b.breach_type, 'minutes', b.minutes_over,
                        'at', b.breached_at, 'acknowledged', b.acknowledged_at) ORDER BY b.breached_at)
                 FROM sla_breaches b WHERE b.ticket_id = s.ticket_id) AS breaches
         FROM sla_tracking s
         LEFT JOIN sla_policies p ON p.id = s.policy_id
        WHERE s.ticket_id = $1`,
      [ticket.id]
    ),
    client.query(
      `SELECT e.*, l.code AS level_code, l.name AS level_name
         FROM ticket_escalations e
         LEFT JOIN escalation_levels l ON l.level = e.level
        WHERE e.ticket_id = $1
        ORDER BY e.created_at DESC`,
      [ticket.id]
    ),
    client.query(
      `SELECT r.id, r.relation_type, r.note, r.related_ticket_id,
              rt.ticket_number, rt.subject, rt.status, rt.priority
         FROM ticket_relations r
         JOIN service_tickets rt ON rt.id = r.related_ticket_id
        WHERE r.ticket_id = $1
        ORDER BY r.created_at DESC`,
      [ticket.id]
    ),
    client.query(
      `SELECT l.id, l.article_id, l.link_type, l.created_at,
              ka.article_number, ka.title, ka.status, ka.summary
         FROM ticket_knowledge_links l
         JOIN knowledge_articles ka ON ka.id = l.article_id
        WHERE l.ticket_id = $1
        ORDER BY l.created_at DESC`,
      [ticket.id]
    ),
  ]);

  const row = header.rows[0] ?? ticket;
  return {
    ticket: row,
    sla: sla.rows[0] ?? null,
    asset: asset.rows[0] ?? null,
    comments: comments.rows,
    attachments: attachments.rows,
    escalations: escalations.rows,
    related: related.rows,
    knowledge: knowledge.rows,
    activity: opts.withActivity === false ? null : await ticketActivity(client, ctx, ticket.id, action.scope),
    permissions: {
      canViewInternalNotes: action.scope.canViewInternalNotes,
      isRequester: action.isRequester,
      isAgent: action.scope.isAgent,
      isAdmin: action.scope.isAdmin,
    },
  };
}

const UPDATABLE_CLASSIFICATIONS = CLASSIFICATIONS;

/**
 * PATCH. Only the fields a service desk is allowed to move are writable, and
 * any change that could invalidate the SLA (category, department, priority) is
 * followed by a fresh SLA window so the clock always matches the ticket.
 */
export async function updateTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  b: Record<string, unknown>
) {
  const action = await ticketActionContext(client, ctx, ticketId, 'update');
  assertScoped(action);
  const before = action.ticket;

  const sets: string[] = [];
  const params: unknown[] = [ticketId, ctx.tenantId, ctx.companyId];
  const push = (value: unknown): number => {
    params.push(value);
    return params.length;
  };

  const subject = s(b.subject);
  if (subject !== undefined) {
    if (subject.length > 200) throw badRequest('Subject must be 200 characters or fewer');
    sets.push(`subject = $${push(subject)}`);
  }
  const description = s(b.description);
  if (description !== undefined) sets.push(`description = $${push(description)}`);

  if (b.categoryId !== undefined || b.category_id !== undefined) {
    const categoryId = nn(b.categoryId ?? b.category_id);
    if (categoryId) {
      const exists = await client.query(
        `SELECT 1 FROM service_categories WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
        [categoryId, ctx.tenantId, ctx.companyId]
      );
      if (exists.rows.length === 0) throw badRequest('Service category not found');
    }
    sets.push(`category_id = $${push(categoryId)}`);
  }

  if (b.subcategoryId !== undefined || b.subcategory_id !== undefined) {
    const subcategoryId = nn(b.subcategoryId ?? b.subcategory_id);
    if (subcategoryId) {
      const sub = await client.query<{ category_id: number }>(
        `SELECT category_id FROM service_subcategories WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
        [subcategoryId, ctx.tenantId, ctx.companyId]
      );
      if (sub.rows.length === 0) throw badRequest('Service subcategory not found');
      const targetCategory = nn(b.categoryId ?? b.category_id) ?? before.category_id;
      if (targetCategory && Number(sub.rows[0].category_id) !== targetCategory) {
        throw badRequest('Subcategory does not belong to the selected category');
      }
    }
    sets.push(`subcategory_id = $${push(subcategoryId)}`);
  }

  let impact = before.impact;
  if (b.impact !== undefined) {
    impact = oneOf(b.impact, IMPACTS, 'impact');
    sets.push(`impact = $${push(impact)}`);
  }
  let urgency = before.urgency;
  if (b.urgency !== undefined) {
    urgency = oneOf(b.urgency, SEVERITIES, 'urgency');
    sets.push(`urgency = $${push(urgency)}`);
  }

  const requestedPriority = b.priority !== undefined ? oneOf(b.priority, PRIORITIES, 'priority') : undefined;
  const recomputed = await priorityFor(client, impact ?? 'INDIVIDUAL', urgency ?? 'MEDIUM');
  if (requestedPriority && requestedPriority !== before.priority) {
    const mayOverride = action.scope.isAdmin || action.scope.permissions.includes('service_desk.tickets.assign');
    const reason = s(b.priorityOverrideReason ?? b.priority_override_reason);
    if (!mayOverride) {
      if (recomputed !== before.priority) {
        sets.push(`priority = $${push(recomputed)}`);
        sets.push('priority_overridden = false');
        sets.push('priority_override_reason = NULL');
      }
    } else {
      if (!reason) throw badRequest('A reason is required to override the calculated priority');
      sets.push(`priority = $${push(requestedPriority)}`);
      sets.push('priority_overridden = true');
      sets.push(`priority_override_reason = $${push(reason)}`);
    }
  } else if (recomputed !== before.priority && !before.priority_overridden) {
    sets.push(`priority = $${push(recomputed)}`);
  }

  if (b.dataClassification !== undefined || b.data_classification !== undefined) {
    const classification = oneOf(b.dataClassification ?? b.data_classification, UPDATABLE_CLASSIFICATIONS, 'dataClassification');
    sets.push(`data_classification = $${push(classification)}`);
  }
  if (b.preferredContact !== undefined || b.preferred_contact !== undefined) {
    const contact = oneOf(b.preferredContact ?? b.preferred_contact, CONTACT_METHODS, 'preferredContact');
    sets.push(`preferred_contact = $${push(contact)}`);
  }
  if (b.affectedAssetId !== undefined || b.affected_asset_id !== undefined) {
    const assetId = nn(b.affectedAssetId ?? b.affected_asset_id);
    if (assetId) {
      const asset = await client.query(
        `SELECT 1 FROM asset_register WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
        [assetId, ctx.tenantId, ctx.companyId]
      );
      if (asset.rows.length === 0) throw badRequest('Affected asset not found in this company');
    }
    sets.push(`affected_asset_id = $${push(assetId)}`);
  }
  if (b.departmentId !== undefined || b.department_id !== undefined) {
    sets.push(`department_id = $${push(nn(b.departmentId ?? b.department_id))}`);
  }
  if (b.branchId !== undefined || b.branch_id !== undefined) {
    sets.push(`branch_id = $${push(nn(b.branchId ?? b.branch_id))}`);
  }
  if (b.impactSummary !== undefined) {
    // Incident detail lives beside the ticket, not in it.
    await client.query(
      `UPDATE incidents SET impact_summary = $1, workaround = COALESCE($2, workaround),
              updated_by = $3, updated_at = now()
        WHERE ticket_id = $4`,
      [s(b.impactSummary) ?? null, s(b.workaround) ?? null, ctx.userId ?? null, ticketId]
    );
  }
  if (b.tags !== undefined) {
    sets.push(`tags = $${push(strList(b.tags))}::text[]`);
  }
  if (b.deviceInfo !== undefined || b.device_info !== undefined) {
    sets.push(`device_info = $${push(JSON.stringify(b.deviceInfo ?? b.device_info ?? {}))}::jsonb`);
  }

  if (sets.length === 0) {
    return { ticket: before, changed: false };
  }

  const updated = await client.query<TicketRow>(
    `UPDATE service_tickets
        SET ${sets.join(', ')},
            updated_by = $${push(ctx.userId ?? null)},
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3
      RETURNING *`,
    params
  );
  const after = updated.rows[0];

  await logAudit(client, ctx, {
    action: 'update',
    resource: 'service_desk.tickets',
    recordId: Number(after.id),
    recordCode: after.ticket_number,
    oldValues: before as unknown as Record<string, unknown>,
    newValues: after as unknown as Record<string, unknown>,
  });

  // Anything that can move the SLA target recomputes the window; the open
  // ticket keeps its history but gets a target that matches reality.
  const slaRelevant =
    after.priority !== before.priority ||
    after.category_id !== before.category_id ||
    after.subcategory_id !== before.subcategory_id ||
    after.department_id !== before.department_id;

  if (slaRelevant && !['CLOSED', 'CANCELLED'].includes(String(after.status))) {
    await applySlaToTicket(client, ctx, {
      id: Number(after.id),
      companyId: Number(after.company_id),
      branchId: after.branch_id,
      categoryId: after.category_id,
      subcategoryId: after.subcategory_id,
      priority: after.priority,
      ticketType: after.ticket_type,
      departmentId: after.department_id,
      openedAt: after.opened_at,
    });
  }

  if (after.priority !== before.priority) {
    await emitEvent(client, ctx, {
      eventType: 'service_desk.ticket.priority_changed',
      entityType: 'service_ticket',
      entityId: Number(after.id),
      entityCode: after.ticket_number,
      severity: after.priority === 'P1' || after.priority === 'P2' ? 'WARN' : 'INFO',
      payload: { from: before.priority, to: after.priority, overridden: after.priority_overridden },
    });
  }

  return { ticket: after, changed: true };
}

// ------------------------------------------------------------- conversation

const COMMENT_TYPES = ['REPLY', 'NOTE'] as const;
const ATTACHMENT_KINDS = ['EVIDENCE', 'SCREENSHOT', 'LOG', 'DOCUMENT', 'PHOTO', 'OTHER'] as const;

/**
 * Two communication types, never mixed:
 *   REPLY - public, seen by the requester and authorised service personnel.
 *   NOTE  - internal, seen only by agents and managers who hold
 *           service_desk.internal_notes.view.
 * A requester can never create a NOTE, and a NOTE never notifies a requester.
 */
export async function addComment(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  b: Record<string, unknown>
) {
  const action = await ticketActionContext(client, ctx, ticketId, 'respond');
  assertScoped(action);
  const ticket = action.ticket;

  const body = s(b.body ?? b.message ?? b.text);
  if (!body) throw badRequest('A comment body is required');
  if (body.length > 20000) throw badRequest('Comment is too long');

  const requested = b.commentType !== undefined || b.comment_type !== undefined
    ? oneOf(b.commentType ?? b.comment_type, COMMENT_TYPES, 'commentType')
    : b.internal === true || b.internal === 'true'
      ? 'NOTE'
      : 'REPLY';

  if (requested === 'NOTE' && !action.scope.canViewInternalNotes) {
    // Internal notes are a privileged channel; refuse rather than silently
    // downgrading, so a mistaken client never leaks intent into a public reply.
    throw forbidden('You are not authorised to add internal notes');
  }
  if (requested === 'NOTE' && action.isRequester && !action.scope.isAgent) {
    throw forbidden('Requesters cannot add internal notes');
  }

  const authorDisplay = await displayName(client, ctx.userId ?? null);

  const ins = await client.query(
    `INSERT INTO ticket_comments
       (tenant_id, company_id, branch_id, ticket_id, comment_type, is_internal, body,
        author_user_id, author_employee_id, author_display, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
     RETURNING *`,
    [
      ctx.tenantId, ctx.companyId, ticket.branch_id, ticket.id, requested,
      requested === 'NOTE', body, ctx.userId ?? null, action.scope.employeeId,
      authorDisplay, ctx.userId ?? null,
    ]
  );
  const comment = ins.rows[0];

  await logAudit(client, ctx, {
    action: requested === 'NOTE' ? 'note' : 'reply',
    resource: 'service_desk.tickets',
    recordId: Number(ticket.id),
    recordCode: ticket.ticket_number,
    newValues: { commentId: Number(comment.id), commentType: requested, length: body.length },
    metadata: { internal: requested === 'NOTE' },
  });

  if (requested === 'REPLY') {
    // The first public reply is the first response, and it stops the response
    // clock. Internal notes deliberately do not count.
    if (!ticket.first_response_at) {
      await recordFirstResponse(client, ctx, ticket.id);
      await emitEvent(client, ctx, {
        eventType: 'service_desk.ticket.first_response',
        entityType: 'service_ticket',
        entityId: Number(ticket.id),
        entityCode: ticket.ticket_number,
        severity: 'INFO',
        payload: { ticketNumber: ticket.ticket_number, byUserId: ctx.userId ?? null },
      });
    }

    if (ticket.requester_user_id && !sameId(ticket.requester_user_id, ctx.userId)) {
      await createNotification(client, ctx, {
        userId: ticket.requester_user_id,
        type: 'service_desk.ticket.reply',
        title: `New response on ${ticket.ticket_number}`,
        body: body.slice(0, 180),
        link: `/my/service-desk/tickets/${ticket.id}`,
        entityType: 'service_ticket',
        entityId: Number(ticket.id),
        severity: 'INFO',
      });
    }
    if (ticket.assigned_to_user_id && !sameId(ticket.assigned_to_user_id, ctx.userId)) {
      await createNotification(client, ctx, {
        userId: ticket.assigned_to_user_id,
        type: 'service_desk.ticket.reply',
        title: `New response on ${ticket.ticket_number}`,
        body: body.slice(0, 180),
        link: `/service-desk/tickets/${ticket.id}`,
        entityType: 'service_ticket',
        entityId: Number(ticket.id),
        severity: 'INFO',
      });
    }
  }

  await emitEvent(client, ctx, {
    eventType: 'service_desk.ticket.commented',
    entityType: 'service_ticket',
    entityId: Number(ticket.id),
    entityCode: ticket.ticket_number,
    severity: 'INFO',
    payload: { commentId: Number(comment.id), commentType: requested, internal: requested === 'NOTE' },
  });

  return comment;
}

async function displayName(client: pg.PoolClient, userId: number | null): Promise<string | null> {
  if (!userId) return null;
  const res = await client.query<{ name: string | null }>(
    `SELECT COALESCE(nullif(trim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')), ''), u.email) AS name
       FROM users u LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.id = $1`,
    [userId]
  );
  return res.rows[0]?.name ?? null;
}

export async function listComments(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  q: Record<string, unknown> = {}
) {
  const action = await ticketActionContext(client, ctx, ticketId, 'view');
  assertScoped(action);

  const params: unknown[] = [ticketId];
  const where: string[] = [`cm.ticket_id = $1`, commentVisibility(action.scope)];

  const type = s(q.commentType ?? q.type);
  if (type) {
    params.push(oneOf(type, COMMENT_TYPES, 'commentType'));
    where.push(`cm.comment_type = $${params.length}`);
  }
  const since = s(q.since);
  if (since) {
    params.push(since);
    where.push(`cm.created_at > $${params.length}::timestamptz`);
  }
  params.push(Math.min(500, Math.max(1, n(q.limit) ?? 200)));

  const res = await client.query(
    `SELECT cm.*,
            COALESCE(nullif(trim(coalesce(ce.first_name, '') || ' ' || coalesce(ce.last_name, '')), ''), cu.email) AS author_name
       FROM ticket_comments cm
       LEFT JOIN users cu     ON cu.id = cm.author_user_id
       LEFT JOIN employees ce ON ce.id = cu.employee_id
      WHERE ${where.join(' AND ')}
      ORDER BY cm.created_at ASC
      LIMIT $${params.length}`,
    params
  );
  return { ticketId, canViewInternalNotes: action.scope.canViewInternalNotes, comments: res.rows };
}

/**
 * Comments an ordinary employee must never see are additionally invisible to
 * the requester payload: `listMyComments` reuses the same visibility gate.
 */
export async function listMyComments(client: pg.PoolClient, ctx: Ctx, ticketId: number) {
  const action = await ticketActionContext(client, ctx, ticketId, 'view');
  assertScoped(action);
  if (!action.isRequester && !action.scope.isAgent) {
    throw forbidden('This ticket does not belong to you');
  }
  const res = await client.query(
    `SELECT cm.id, cm.comment_type, cm.body, cm.author_display, cm.created_at, cm.is_edited
       FROM ticket_comments cm
      WHERE cm.ticket_id = $1 AND cm.is_internal = false
      ORDER BY cm.created_at ASC`,
    [ticketId]
  );
  return { ticketId, comments: res.rows };
}

export async function updateComment(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  commentId: number,
  b: Record<string, unknown>
) {
  const action = await ticketActionContext(client, ctx, ticketId, 'update');
  assertScoped(action);
  const body = s(b.body);
  if (!body) throw badRequest('A comment body is required');

  const existing = await client.query<{ id: number; author_user_id: number | null; is_internal: boolean; body: string }>(
    `SELECT id, author_user_id, is_internal, body FROM ticket_comments
      WHERE id = $1 AND ticket_id = $2 AND tenant_id = $3`,
    [commentId, ticketId, ctx.tenantId]
  );
  if (existing.rows.length === 0) throw notFound('Comment not found');
  const row = existing.rows[0];
  const own = sameId(row.author_user_id, ctx.userId);
  if (!own && !action.scope.isAdmin) throw forbidden('You can only edit your own comments');
  if (row.is_internal && !action.scope.canViewInternalNotes) {
    throw forbidden('You are not authorised to edit internal notes');
  }

  const res = await client.query(
    `UPDATE ticket_comments
        SET body = $4, is_edited = true, edited_at = now(), updated_by = $5, updated_at = now()
      WHERE id = $1 AND ticket_id = $2 AND tenant_id = $3
      RETURNING *`,
    [commentId, ticketId, ctx.tenantId, body, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'service_desk.comments',
    recordId: commentId,
    recordCode: action.ticket.ticket_number,
    oldValues: { body: row.body },
    newValues: { body },
  });
  return res.rows[0];
}

// ------------------------------------------------------------- attachments

function fileFromBody(b: Record<string, unknown>): { originalname: string; mimetype: string; size: number; buffer: Buffer } | null {
  const f = b.file as { originalname?: string; mimetype?: string; size?: number; buffer?: Buffer } | undefined;
  if (f && (f.buffer || f.originalname)) {
    return {
      originalname: String(f.originalname ?? 'attachment.bin'),
      mimetype: String(f.mimetype ?? 'application/octet-stream'),
      size: Number(f.size) || (f.buffer?.length ?? 0),
      buffer: f.buffer ?? Buffer.alloc(0),
    };
  }
  const base64 = s(b.fileBase64);
  if (base64) {
    const buf = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    return {
      originalname: s(b.fileName) ?? 'attachment.bin',
      mimetype: s(b.mimeType) ?? 'application/octet-stream',
      size: buf.length,
      buffer: buf,
    };
  }
  return null;
}

export async function addAttachment(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  b: Record<string, unknown>
) {
  const action = await ticketActionContext(client, ctx, ticketId, 'respond');
  assertScoped(action);
  const ticket = action.ticket;

  const file = fileFromBody(b);
  const storageKey = s(b.storageKey);
  if (!file && !storageKey) throw badRequest('Provide a file upload or an existing storageKey');

  const kind = b.kind !== undefined ? oneOf(b.kind, ATTACHMENT_KINDS, 'kind') : 'EVIDENCE';
  // Requesters never get to mark an attachment internal - it would hide their
  // own evidence from themselves.
  const isInternal = truthy(b.isInternal ?? b.is_internal) && action.scope.canViewInternalNotes;

  const fileName = (file?.originalname ?? path.basename(storageKey ?? 'attachment')).replace(/[^A-Za-z0-9._-]+/g, '_');
  const mime = file?.mimetype ?? s(b.mimeType) ?? 'application/octet-stream';
  const size = file?.size ?? (Number(b.sizeBytes ?? b.size_bytes ?? 0) || 0);
  const checksum = file?.buffer?.length ? createHash('sha256').update(file.buffer).digest('hex') : null;
  const docNo = await nextTicketDocNo(client, ctx);
  const resolvedKey = storageKey ?? `service-desk/${ctx.companyId}/${ticket.ticket_number}/${docNo}-${fileName}`;

  if (file?.buffer?.length) {
    mkdirSync(path.join(config.storageRoot, path.dirname(resolvedKey)), { recursive: true });
    writeFileSync(path.join(config.storageRoot, resolvedKey), file.buffer);
  }

  const doc = await client.query<{ id: number }>(
    `INSERT INTO documents
       (company_id, tenant_id, doc_no, title, description, category, file_name, mime_type,
        file_size, storage_key, checksum, status, uploaded_by, attributes)
     VALUES ($1,$2,$3,$4,$5,'SERVICE_DESK',$6,$7,$8,$9,$10,'SUBMITTED',$11,$12::jsonb)
     RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, docNo,
      s(b.title) ?? `${ticket.ticket_number} - ${fileName}`,
      s(b.description) ?? null, fileName, mime, size, resolvedKey, checksum,
      ctx.userId ?? null,
      JSON.stringify({
        ticketId: Number(ticket.id),
        ticketNumber: ticket.ticket_number,
        classification: ticket.data_classification,
      }),
    ]
  );

  const ins = await client.query(
    `INSERT INTO ticket_attachments
       (tenant_id, company_id, branch_id, ticket_id, comment_id, document_id, file_name, mime_type,
        size_bytes, storage_key, kind, is_internal, uploaded_by_user_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
     RETURNING *`,
    [
      ctx.tenantId, ctx.companyId, ticket.branch_id, ticket.id, nn(b.commentId ?? b.comment_id),
      Number(doc.rows[0].id), fileName, mime, size, resolvedKey, kind, isInternal, ctx.userId ?? null,
    ]
  );

  await logAudit(client, ctx, {
    action: 'upload',
    resource: 'service_desk.attachments',
    recordId: Number(ins.rows[0].id),
    recordCode: ticket.ticket_number,
    newValues: { documentId: Number(doc.rows[0].id), docNo, fileName, mime, size, kind, isInternal, checksum },
  });

  if (!isInternal && ticket.requester_user_id && !sameId(ticket.requester_user_id, ctx.userId)) {
    await createNotification(client, ctx, {
      userId: ticket.requester_user_id,
      type: 'service_desk.ticket.reply',
      title: `A file was added to ${ticket.ticket_number}`,
      body: fileName,
      link: `/my/service-desk/tickets/${ticket.id}`,
      entityType: 'service_ticket',
      entityId: Number(ticket.id),
      severity: 'INFO',
    });
  }

  return { ...ins.rows[0], docNo, checksum };
}

async function nextTicketDocNo(client: pg.PoolClient, ctx: Ctx): Promise<string> {
  const res = await client.query<{ code: string }>('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, 'SD']);
  return String(res.rows[0].code);
}

export async function listAttachments(client: pg.PoolClient, ctx: Ctx, ticketId: number) {
  const action = await ticketActionContext(client, ctx, ticketId, 'view');
  assertScoped(action);
  const res = await client.query(
    `SELECT at.*, d.doc_no, d.status AS document_status
       FROM ticket_attachments at
       LEFT JOIN documents d ON d.id = at.document_id
      WHERE at.ticket_id = $1
        AND (${action.scope.canViewInternalNotes ? 'true' : 'at.is_internal = false'})
      ORDER BY at.created_at ASC`,
    [ticketId]
  );
  return { ticketId, attachments: res.rows };
}

// ------------------------------------------------------ activity timeline

export interface ActivityEvent {
  id: string;
  kind: string;
  at: string;
  actorUserId: number | null;
  actorName: string | null;
  body: string | null;
  meta: Record<string, unknown>;
}

/**
 * Merge every stream that touched a ticket into one chronological feed
 * (spec sections 9, 29). Internal-only streams and internal notes are gated
 * by the caller's scope so an ordinary employee can never read agent
 * conversation out of the timeline endpoint.
 */
export async function ticketActivity(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  scope: TicketScope
): Promise<ActivityEvent[]> {
  const internal = scope.canViewInternalNotes;
  const commentFilter = internal
    ? 'true'
    : `(c.is_internal = false AND c.comment_type <> 'NOTE')`;
  const restricted = internal ? 'true' : 'false';

  const { rows } = await client.query(
    `SELECT ev.kind, ev.at, ev.actor_user_id, ev.body, ev.meta, ev.seq,
            COALESCE(
              nullif(trim(coalesce(emp.first_name, '') || ' ' || coalesce(emp.last_name, '')), ''),
              usr.email
            ) AS actor_name
       FROM (
         SELECT 'CREATED'::text AS kind, t.opened_at AS at, t.requester_user_id AS actor_user_id,
                NULL::text AS body, 0 AS seq,
                jsonb_build_object('status', t.status, 'priority', t.priority,
                                   'ticketNumber', t.ticket_number) AS meta
           FROM service_tickets t
          WHERE t.id = $1

         UNION ALL
         SELECT 'STATUS_CHANGED', h.changed_at, h.changed_by, h.reason, 1,
                jsonb_build_object('fromStatus', h.from_status, 'toStatus', h.to_status)
           FROM ticket_status_history h
          WHERE h.ticket_id = $1

         UNION ALL
         SELECT CASE WHEN c.comment_type = 'NOTE' THEN 'INTERNAL_NOTE'
                     WHEN c.comment_type = 'SYSTEM' THEN 'SYSTEM' ELSE 'REPLY' END,
                c.created_at, c.author_user_id, c.body, 2,
                jsonb_build_object('commentId', c.id, 'commentType', c.comment_type,
                                   'isInternal', c.is_internal, 'isEdited', c.is_edited,
                                   'authorDisplay', c.author_display)
           FROM ticket_comments c
          WHERE c.ticket_id = $1 AND ${commentFilter}

         UNION ALL
         SELECT CASE WHEN a.is_reassignment THEN 'REASSIGNMENT' ELSE 'ASSIGNED' END,
                a.assigned_at, COALESCE(a.assigned_by, a.created_by), a.reason, 3,
                jsonb_build_object('assignmentId', a.id, 'assignmentType', a.assignment_type,
                                   'strategy', a.strategy_detail,
                                   'toUserId', a.assigned_to_user_id,
                                   'toTeamId', a.assigned_team_id,
                                   'fromUserId', a.previous_assignee_id,
                                   'queueId', a.queue_id)
           FROM ticket_assignments a
          WHERE a.ticket_id = $1

         UNION ALL
         SELECT 'ESCALATED', e.created_at, COALESCE(e.created_by, e.escalated_from_user_id),
                e.reason, 4,
                jsonb_build_object('escalationId', e.id, 'level', e.level,
                                   'levelCode', l.code, 'levelName', l.name,
                                   'triggerType', e.trigger_type,
                                   'toRole', e.escalated_to_role,
                                   'acknowledgedAt', e.acknowledged_at,
                                   'resolvedAt', e.resolved_at)
           FROM ticket_escalations e
           LEFT JOIN escalation_levels l ON l.id = e.level_id
          WHERE e.ticket_id = $1 AND $2::boolean

         UNION ALL
         SELECT 'SLA_BREACH', b.breached_at, NULL::bigint, b.reason, 5,
                jsonb_build_object('breachId', b.id, 'breachType', b.breach_type,
                                   'minutesOver', b.minutes_over, 'dueAt', b.due_at,
                                   'acknowledgedAt', b.acknowledged_at)
           FROM sla_breaches b
          WHERE b.ticket_id = $1 AND $3::boolean
       ) ev
       LEFT JOIN users usr     ON usr.id = ev.actor_user_id
       LEFT JOIN employees emp ON emp.id = usr.employee_id
      ORDER BY ev.at ASC, ev.seq ASC
      LIMIT 1000`,
    [ticketId, restricted, restricted]
  );

  return rows.map((r, i) => ({
    id: `${r.kind}:${i}`,
    kind: String(r.kind),
    at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
    actorUserId: r.actor_user_id === null ? null : Number(r.actor_user_id),
    actorName: r.actor_name ?? null,
    body: r.body ?? null,
    meta: (r.meta ?? {}) as Record<string, unknown>,
  }));
}

// ------------------------------------------------------------- lifecycle

/**
 * Statuses that legally carry a timestamp. `REOPENED` overwrites (a ticket can
 * be reopened many times and `reopen_count` records how often) while the
 * terminal statuses keep the first time they were reached.
 */
const STATUS_TIMESTAMP: Record<string, string> = {
  RESOLVED: 'resolved_at',
  CLOSED: 'closed_at',
  CANCELLED: 'cancelled_at',
  REOPENED: 'reopened_at',
};

/** Waiting on somebody else, which may stop the SLA clock. */
const PENDING_STATUSES: string[] = ['PENDING_REQUESTER', 'PENDING_VENDOR'];

/** Terminal for SLA purposes: nothing further is expected to happen. */
const TERMINAL_STATUSES: string[] = ['CLOSED', 'CANCELLED'];

export const RESOLUTION_CODES = [
  'FIXED',
  'PERMANENT_FIX',
  'WORKAROUND',
  'USER_EDUCATION',
  'SOFTWARE_UPDATE',
  'HARDWARE_REPLACED',
  'REIMAGED',
  'RECONFIGURED',
  'NO_FAULT_FOUND',
  'NOT_REPRODUCIBLE',
  'DUPLICATE',
  'WITHDRAWN',
  'CANCELLED',
] as const;

/** The SLA engine needs the ticket in its own shape. */
function slaRef(t: TicketRow): SlaTicketRef {
  return {
    id: Number(t.id),
    companyId: Number(t.company_id),
    branchId: t.branch_id,
    categoryId: t.category_id,
    subcategoryId: t.subcategory_id,
    priority: t.priority,
    ticketType: t.ticket_type,
    departmentId: t.department_id,
    openedAt: t.opened_at,
  };
}

async function assertTransition(
  client: pg.PoolClient,
  from: string,
  to: string,
  ticketNumber: string
): Promise<void> {
  const res = await client.query<{ ok: boolean }>(
    `SELECT service_ticket_status_transition_ok($1, $2) AS ok`,
    [from, to]
  );
  if (res.rows[0]?.ok !== true) {
    throw conflict(`Ticket ${ticketNumber} cannot move from ${from} to ${to}`);
  }
}

/**
 * The single writer for `service_tickets.status`. The BEFORE UPDATE trigger
 * records `ticket_status_history` and rejects illegal edges, so this function
 * only has to prove the edge is legal first (for a readable error) and stamp
 * `status_reason`, which the trigger copies into the history row.
 */
async function applyStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  action: TicketActionContext,
  toStatus: string,
  opts: { reason?: string | null; at?: Date } = {}
): Promise<TicketRow> {
  const before = action.ticket;
  if (before.status === toStatus) return before;

  await assertTransition(client, before.status, toStatus, before.ticket_number);

  const at = opts.at ?? new Date();
  const params: unknown[] = [
    before.id,
    ctx.tenantId,
    ctx.companyId,
    toStatus,
    opts.reason ?? null,
    ctx.userId ?? null,
  ];
  const sets = [
    'status = $4',
    'status_reason = $5',
    'updated_by = $6',
    'updated_at = now()',
  ];

  const tsCol = STATUS_TIMESTAMP[toStatus];
  if (tsCol) {
    if (toStatus === 'REOPENED') {
      params.push(at.toISOString());
      sets.push(`reopened_at = $${params.length}`);
    } else {
      params.push(at.toISOString());
      sets.push(`${tsCol} = COALESCE(${tsCol}, $${params.length})`);
    }
  }
  // Leaving a resolved/closed state clears the terminal stamps so the ticket
  // reads as genuinely live again and the resolution metrics stay honest.
  if (toStatus === 'REOPENED') {
    sets.push('resolved_at = NULL', 'closed_at = NULL', 'cancelled_at = NULL');
  }

  await client.query(
    `UPDATE service_tickets SET ${sets.join(', ')}
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    params
  );

  const refreshed = await loadTicketRow(client, ctx, Number(before.id));
  return refreshed ?? before;
}

/**
 * SLA bookkeeping that must follow every status change (spec sections 7, 8):
 * pause while the ticket waits on a third party, stop the resolution clock on
 * RESOLVED, and cancel the clock plus any open escalation on CLOSED/CANCELLED.
 */
async function afterStatusChange(
  client: pg.PoolClient,
  ctx: Ctx,
  ticket: TicketRow,
  previousStatus: string,
  nextStatus: string
): Promise<void> {
  const id = Number(ticket.id);
  const wasPending = PENDING_STATUSES.includes(previousStatus);
  const isPending = PENDING_STATUSES.includes(nextStatus);

  if (isPending && !wasPending) {
    const policy = await selectSlaPolicy(client, ctx, slaRef(ticket));
    if (policy?.pauseOnPending) await pauseSla(client, id);
  } else if (!isPending && wasPending) {
    await resumeSla(client, id);
  }

  if (nextStatus === 'RESOLVED') {
    await markResolvedForSla(client, ctx, id);
  }

  if (TERMINAL_STATUSES.includes(nextStatus)) {
    await cancelSla(client, id);
    await closeOpenEscalations(client, id);
  }
}

/** Notify the person who raised the ticket. */
async function notifyRequester(
  client: pg.PoolClient,
  ctx: Ctx,
  ticket: TicketRow,
  n: { type: string; title: string; body?: string; severity?: NotificationInput['severity'] }
): Promise<void> {
  if (!ticket.requester_user_id) return;
  if (sameId(ticket.requester_user_id, ctx.userId)) return;
  await createNotification(client, ctx, {
    userId: ticket.requester_user_id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: `/my/service-desk/tickets/${ticket.id}`,
    entityType: 'service_ticket',
    entityId: Number(ticket.id),
    severity: n.severity ?? 'INFO',
  });
}

async function statusEvent(
  client: pg.PoolClient,
  ctx: Ctx,
  ticket: TicketRow,
  nextStatus: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await emitEvent(client, ctx, {
    eventType: `service_desk.ticket.${nextStatus.toLowerCase()}`,
    entityType: 'service_ticket',
    entityId: Number(ticket.id),
    entityCode: ticket.ticket_number,
    severity: nextStatus === 'ESCALATED' ? 'WARN' : 'INFO',
    payload: { ticketNumber: ticket.ticket_number, fromStatus: ticket.status, toStatus: nextStatus, ...extra },
  });
}

/** NEW/REOPENED -> OPEN. The desk has picked the ticket up. */
export async function openTicket(client: pg.PoolClient, ctx: Ctx, ticketId: number, b: Record<string, unknown> = {}) {
  const action = await ticketActionContext(client, ctx, ticketId, 'update');
  assertScoped(action);
  const ticket = action.ticket;
  const updated = await applyStatus(client, ctx, action, 'OPEN', {
    reason: s(b.reason) ?? 'Accepted by the service desk',
  });
  await logAudit(client, ctx, {
    action: 'status_change',
    resource: 'service_desk.tickets',
    recordId: Number(ticket.id),
    recordCode: ticket.ticket_number,
    oldValues: { status: ticket.status },
    newValues: { status: updated.status },
  });
  await statusEvent(client, ctx, ticket, 'OPEN');
  return updated;
}

/** -> IN_PROGRESS. Work has actually started. */
export async function startProgress(client: pg.PoolClient, ctx: Ctx, ticketId: number, b: Record<string, unknown> = {}) {
  const action = await ticketActionContext(client, ctx, ticketId, 'update');
  assertScoped(action);
  const ticket = action.ticket;
  const updated = await applyStatus(client, ctx, action, 'IN_PROGRESS', {
    reason: s(b.reason) ?? 'Investigation started',
  });
  await logAudit(client, ctx, {
    action: 'status_change',
    resource: 'service_desk.tickets',
    recordId: Number(ticket.id),
    recordCode: ticket.ticket_number,
    oldValues: { status: ticket.status },
    newValues: { status: updated.status },
  });
  await statusEvent(client, ctx, ticket, 'IN_PROGRESS');
  return updated;
}

/** -> PENDING_REQUESTER / PENDING_VENDOR. Waiting on somebody else. */
export async function setPending(client: pg.PoolClient, ctx: Ctx, ticketId: number, b: Record<string, unknown>) {
  const status = oneOf(b.status ?? 'PENDING_REQUESTER', PENDING_STATUSES, 'status');
  const action = await ticketActionContext(client, ctx, ticketId, 'update');
  assertScoped(action);
  const ticket = action.ticket;
  if (!s(b.reason)) throw badRequest('A reason is required when the ticket is placed on hold');

  const updated = await applyStatus(client, ctx, action, status, { reason: s(b.reason) });
  await afterStatusChange(client, ctx, updated, ticket.status, status);
  await logAudit(client, ctx, {
    action: 'status_change',
    resource: 'service_desk.tickets',
    recordId: Number(ticket.id),
    recordCode: ticket.ticket_number,
    oldValues: { status: ticket.status },
    newValues: { status },
    metadata: { reason: s(b.reason) },
  });
  await statusEvent(client, ctx, ticket, status);
  if (status === 'PENDING_REQUESTER') {
    await notifyRequester(client, ctx, ticket, {
      type: 'service_desk.ticket.pending_requester',
      title: `${ticket.ticket_number} is waiting on you`,
      body: s(b.reason),
      severity: 'WARN',
    });
  }
  return updated;
}

/**
 * RESOLVED. The resolution code and summary are mandatory because they are what
 * the reports, the knowledge base and the requester's confirmation all read.
 */
export async function resolveTicket(client: pg.PoolClient, ctx: Ctx, ticketId: number, b: Record<string, unknown>) {
  const action = await ticketActionContext(client, ctx, ticketId, 'resolve');
  assertScoped(action);
  const ticket = action.ticket;
  if (ticket.status === 'CLOSED') throw conflict('Ticket is already closed');
  if (ticket.status === 'CANCELLED') throw conflict('Ticket was cancelled');
  if (!s(b.resolutionSummary ?? b.resolution_summary)) {
    throw badRequest('A resolution summary is required');
  }

  const summary = s(b.resolutionSummary ?? b.resolution_summary) as string;
  const requestedCode = s(b.resolutionCode ?? b.resolution_code);
  const code = requestedCode ? oneOf(requestedCode.toUpperCase(), RESOLUTION_CODES, 'resolutionCode') : 'FIXED';
  const confirmationRequired =
    b.confirmationRequired === undefined && b.confirmation_required === undefined
      ? ticket.confirmation_required
      : truthy(b.confirmationRequired ?? b.confirmation_required);

  await client.query(
    `UPDATE service_tickets
        SET resolution_code = $4, resolution_summary = $5, confirmation_required = $6,
            updated_by = $7, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [ticket.id, ctx.tenantId, ctx.companyId, code, summary, confirmationRequired, ctx.userId ?? null]
  );

  const updated = await applyStatus(client, ctx, action, 'RESOLVED', {
    reason: s(b.reason) ?? 'Resolved by the service desk',
  });
  await afterStatusChange(client, ctx, updated, ticket.status, 'RESOLVED');

  const note = s(b.workNotes ?? b.work_notes);
  if (note && action.scope.canViewInternalNotes) {
    await addComment(client, ctx, Number(ticket.id), { body: note, commentType: 'NOTE' });
  }

  await logAudit(client, ctx, {
    action: 'resolve',
    resource: 'service_desk.tickets',
    recordId: Number(ticket.id),
    recordCode: ticket.ticket_number,
    oldValues: { status: ticket.status },
    newValues: { status: 'RESOLVED', resolutionCode: code, confirmationRequired },
  });
  await statusEvent(client, ctx, ticket, 'RESOLVED', { resolutionCode: code });
  await notifyRequester(client, ctx, ticket, {
    type: 'service_desk.ticket.resolved',
    title: `${ticket.ticket_number} has been resolved`,
    body: summary,
    severity: 'SUCCESS',
  });
  await notifyDeskRoles(client, ctx, ['service_desk_manager'], {
    type: 'service_desk.ticket.resolved',
    title: `${ticket.ticket_number} resolved`,
    body: summary.slice(0, 180),
    link: `/service-desk/tickets/${ticket.id}`,
    entityType: 'service_ticket',
    entityId: Number(ticket.id),
    severity: 'INFO',
  }, { excludeUserId: ctx.userId ?? null });

  return updated;
}

/** RESOLVED -> CLOSED. Cancels the SLA clock and any open escalation. */
export async function closeTicket(client: pg.PoolClient, ctx: Ctx, ticketId: number, b: Record<string, unknown> = {}) {
  const action = await ticketActionContext(client, ctx, ticketId, 'close');
  assertScoped(action);
  const ticket = action.ticket;
  if (ticket.status === 'CLOSED') throw conflict('Ticket is already closed');

  const updated = await applyStatus(client, ctx, action, 'CLOSED', {
    reason: s(b.reason) ?? 'Closed',
  });
  await afterStatusChange(client, ctx, updated, ticket.status, 'CLOSED');

  await logAudit(client, ctx, {
    action: 'close',
    resource: 'service_desk.tickets',
    recordId: Number(ticket.id),
    recordCode: ticket.ticket_number,
    oldValues: { status: ticket.status },
    newValues: { status: 'CLOSED' },
  });
  await statusEvent(client, ctx, ticket, 'CLOSED');
  await notifyRequester(client, ctx, ticket, {
    type: 'service_desk.ticket.closed',
    title: `${ticket.ticket_number} has been closed`,
    severity: 'INFO',
  });
  return updated;
}

/**
 * Reopening restarts the resolution clock from the reopen moment, so a ticket
 * that was closed inside SLA and reopened a week later cannot report a false
 * "met" against its original window.
 */
export async function reopenTicket(client: pg.PoolClient, ctx: Ctx, ticketId: number, b: Record<string, unknown>) {
  const reason = s(b.reason);
  if (!reason) throw badRequest('A reason is required to reopen a ticket');

  const action = await ticketActionContext(client, ctx, ticketId, 'reopen');
  assertScoped(action);
  const ticket = action.ticket;
  if (!['RESOLVED', 'CLOSED', 'CANCELLED'].includes(ticket.status)) {
    throw conflict('Only resolved, closed or cancelled tickets can be reopened');
  }

  const at = new Date();
  const updated = await applyStatus(client, ctx, action, 'REOPENED', { reason, at });
  await client.query(
    `UPDATE service_tickets
        SET reopen_count = reopen_count + 1, updated_by = $4, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [ticket.id, ctx.tenantId, ctx.companyId, ctx.userId ?? null]
  );

  // Restart the SLA from the reopen, keeping the policy the ticket already had.
  await client.query(
    `UPDATE sla_tracking
        SET resolved_at = NULL, resolution_state = 'PENDING', state = 'RUNNING',
            paused_at = NULL, updated_at = now()
      WHERE ticket_id = $1`,
    [ticket.id]
  );
  await applySlaToTicket(client, ctx, { ...slaRef(refreshedTicket(updated, at)), openedAt: at });

  await logAudit(client, ctx, {
    action: 'reopen',
    resource: 'service_desk.tickets',
    recordId: Number(ticket.id),
    recordCode: ticket.ticket_number,
    oldValues: { status: ticket.status },
    newValues: { status: 'REOPENED' },
    metadata: { reason },
  });
  await statusEvent(client, ctx, ticket, 'REOPENED', { reason });
  await notifyRequester(client, ctx, ticket, {
    type: 'service_desk.ticket.reopened',
    title: `${ticket.ticket_number} was reopened`,
    body: reason,
    severity: 'WARN',
  });
  await notifyDeskRoles(client, ctx, ['service_desk_agent', 'service_desk_manager'], {
    type: 'service_desk.ticket.reopened',
    title: `${ticket.priority} ${ticket.ticket_number} reopened`,
    body: reason.slice(0, 180),
    link: `/service-desk/tickets/${ticket.id}`,
    entityType: 'service_ticket',
    entityId: Number(ticket.id),
    severity: 'WARN',
    actionRequired: true,
  }, { excludeUserId: ctx.userId ?? null, queueId: ticket.assigned_queue_id });

  return loadTicketRow(client, ctx, Number(ticket.id));
}

function refreshedTicket(t: TicketRow, reopenedAt: Date): TicketRow {
  return { ...t, resolved_at: null, closed_at: null, reopened_at: reopenedAt.toISOString() };
}

/** -> CANCELLED. Used for duplicates, withdrawn requests and misfiled tickets. */
export async function cancelTicket(client: pg.PoolClient, ctx: Ctx, ticketId: number, b: Record<string, unknown>) {
  const reason = s(b.reason);
  if (!reason) throw badRequest('A cancellation reason is required');

  const action = await ticketActionContext(client, ctx, ticketId, 'update');
  assertScoped(action);
  const ticket = action.ticket;
  if (TERMINAL_STATUSES.includes(ticket.status)) throw conflict('Ticket is already closed or cancelled');

  const updated = await applyStatus(client, ctx, action, 'CANCELLED', { reason });
  await afterStatusChange(client, ctx, updated, ticket.status, 'CANCELLED');

  await logAudit(client, ctx, {
    action: 'cancel',
    resource: 'service_desk.tickets',
    recordId: Number(ticket.id),
    recordCode: ticket.ticket_number,
    oldValues: { status: ticket.status },
    newValues: { status: 'CANCELLED' },
    metadata: { reason },
  });
  await statusEvent(client, ctx, ticket, 'CANCELLED', { reason });
  await notifyRequester(client, ctx, ticket, {
    type: 'service_desk.ticket.cancelled',
    title: `${ticket.ticket_number} was cancelled`,
    body: reason,
    severity: 'WARN',
  });
  return updated;
}

/**
 * The requester (or the desk on their behalf) accepts the fix. A resolved
 * ticket that needed confirmation closes here; one that did not stays RESOLVED
 * until the desk closes it.
 */
export async function confirmResolution(client: pg.PoolClient, ctx: Ctx, ticketId: number, b: Record<string, unknown> = {}) {
  const action = await ticketActionContext(client, ctx, ticketId, 'view');
  assertScoped(action);
  const ticket = action.ticket;

  const isRequester = action.isRequester;
  const mayConfirm = isRequester || action.scope.isAgent || action.scope.permissions.includes('service_desk.tickets.close');
  if (!mayConfirm) throw forbidden('Only the requester or the service desk can confirm a resolution');
  if (ticket.status !== 'RESOLVED' && ticket.status !== 'CLOSED') {
    throw conflict('Only a resolved ticket can be confirmed');
  }

  const note = s(b.note ?? b.comment);
  const rating = n(b.satisfactionRating ?? b.satisfaction_rating ?? b.rating);
  if (rating !== undefined && (rating < 1 || rating > 5)) {
    throw badRequest('Satisfaction rating must be between 1 and 5');
  }

  await client.query(
    `UPDATE service_tickets
        SET confirmed_at = COALESCE(confirmed_at, now()),
            confirmed_by = COALESCE(confirmed_by, $4),
            satisfaction_rating = COALESCE($5, satisfaction_rating),
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [ticket.id, ctx.tenantId, ctx.companyId, action.scope.employeeId, rating ?? null]
  );

  if (note) {
    await addComment(client, ctx, Number(ticket.id), { body: note, commentType: 'REPLY' });
  }

  await logAudit(client, ctx, {
    action: 'confirm',
    resource: 'service_desk.tickets',
    recordId: Number(ticket.id),
    recordCode: ticket.ticket_number,
    newValues: { confirmed: true, satisfactionRating: rating ?? null },
  });

  let closed: TicketRow = ticket;
  if (ticket.status === 'RESOLVED' && ticket.confirmation_required) {
    closed = await applyStatus(client, ctx, action, 'CLOSED', {
      reason: 'Requester confirmed the resolution',
    });
    await afterStatusChange(client, ctx, closed, 'RESOLVED', 'CLOSED');
    await statusEvent(client, ctx, ticket, 'CLOSED', { reason: 'CONFIRMED_BY_REQUESTER' });
  }

  await emitEvent(client, ctx, {
    eventType: 'service_desk.ticket.confirmed',
    entityType: 'service_ticket',
    entityId: Number(ticket.id),
    entityCode: ticket.ticket_number,
    severity: 'INFO',
    payload: { ticketNumber: ticket.ticket_number, rating: rating ?? null, closed: closed.status === 'CLOSED' },
  });

  return loadTicketRow(client, ctx, Number(ticket.id));
}

// ------------------------------------------------------------ escalation

export async function listEscalationLevels(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT l.id, l.level, l.code, l.name, l.role_code, l.description, l.is_active
       FROM escalation_levels l
      WHERE l.tenant_id = $1 AND l.company_id = $2
      ORDER BY l.level`,
    [ctx.tenantId, ctx.companyId]
  );
  return res.rows;
}

export async function listEscalationRules(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const res = await client.query(
    `SELECT r.id, r.code, r.name, r.category_id, c.name AS category_name, r.priority,
            r.level_id, l.level, l.code AS level_code, l.name AS level_name, l.role_code,
            r.after_minutes, r.trigger_on, r.notify_roles, r.is_active
       FROM escalation_rules r
       LEFT JOIN escalation_levels l ON l.id = r.level_id
       LEFT JOIN service_categories c ON c.id = r.category_id
      WHERE r.tenant_id = $1 AND r.company_id = $2
        AND ($3::boolean OR r.is_active)
      ORDER BY l.level, r.after_minutes`,
    [ctx.tenantId, ctx.companyId, q.includeInactive === true]
  );
  return res.rows;
}

const ESCALATION_TRIGGERS = ['NO_RESPONSE', 'NO_RESOLUTION', 'SLA_WARNING', 'SLA_BREACH'] as const;

/** Resolve an escalation level by id or by level number, whichever was supplied. */
async function escalationLevelRef(
  client: pg.PoolClient,
  ctx: Ctx,
  levelId: number | null,
  levelNo: number | undefined
): Promise<{ id: number; level: number }> {
  const res = await client.query<{ id: number; level: number }>(
    `SELECT id, level
       FROM escalation_levels
      WHERE tenant_id = $1 AND company_id = $2
        AND ($3::bigint IS NULL OR id = $3)
        AND ($4::int IS NULL OR level = $4)
      ORDER BY level
      LIMIT 1`,
    [ctx.tenantId, ctx.companyId, levelId, levelNo ?? null]
  );
  const row = res.rows[0];
  if (!row) throw badRequest('A valid escalation level is required (level 1-5, or a levelId)');
  return row;
}

/**
 * Escalation rule authoring (spec section 17). A rule binds a trigger - no
 * first response, no resolution, an SLA warning or an SLA breach - to a level
 * after a delay, and can be narrowed to one category and one priority so that a
 * P1 network outage climbs the ladder far sooner than a P4 request for a mouse.
 *
 * The rule engine itself lives in serviceDeskSla.ts (applyEscalationRules); this
 * is the configuration surface an administrator drives it with.
 */
export async function createEscalationRule(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const code = s(b.code);
  const name = s(b.name);
  if (!code) throw badRequest('Escalation rule code is required');
  if (!name) throw badRequest('Escalation rule name is required');

  const level = await escalationLevelRef(client, ctx, nn(b.levelId ?? b.level_id), n(b.level));
  const afterMinutes = n(b.afterMinutes ?? b.after_minutes);
  if (!afterMinutes || afterMinutes <= 0) throw badRequest('afterMinutes must be greater than zero');

  const categoryId = nn(b.categoryId ?? b.category_id);
  if (categoryId) {
    const cat = await client.query(
      'SELECT 1 FROM service_categories WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
      [categoryId, ctx.tenantId, ctx.companyId]
    );
    if (cat.rows.length === 0) throw badRequest('Service category not found');
  }

  const priority = s(b.priority) === undefined ? null : oneOf(b.priority, PRIORITIES, 'priority');
  const triggerOn =
    s(b.triggerOn ?? b.trigger_on) === undefined
      ? 'NO_RESPONSE'
      : oneOf(b.triggerOn ?? b.trigger_on, ESCALATION_TRIGGERS, 'triggerOn');

  const res = await client.query(
    `INSERT INTO escalation_rules
       (tenant_id, company_id, branch_id, code, name, category_id, priority, level_id,
        after_minutes, trigger_on, notify_roles, is_active, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
     RETURNING *`,
    [
      ctx.tenantId, ctx.companyId, nn(b.branchId ?? b.branch_id),
      code.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), name, categoryId, priority, level.id,
      afterMinutes, triggerOn, strList(b.notifyRoles ?? b.notify_roles),
      b.isActive === undefined ? true : truthy(b.isActive), ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'create', resource: 'service_desk.escalation_rules', recordId: Number(res.rows[0].id),
    recordCode: String(res.rows[0].code), newValues: res.rows[0],
  });
  return res.rows[0];
}

export async function updateEscalationRule(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown>
) {
  const before = await client.query(
    'SELECT * FROM escalation_rules WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    [id, ctx.tenantId, ctx.companyId]
  );
  if (before.rows.length === 0) throw notFound('Escalation rule not found');

  let levelId: number | null = null;
  if (b.levelId !== undefined || b.level_id !== undefined || b.level !== undefined) {
    levelId = (await escalationLevelRef(client, ctx, nn(b.levelId ?? b.level_id), n(b.level))).id;
  }

  const after = n(b.afterMinutes ?? b.after_minutes);
  if (after !== undefined && after <= 0) throw badRequest('afterMinutes must be greater than zero');

  const res = await client.query(
    `UPDATE escalation_rules
        SET name = COALESCE($4, name),
            category_id = COALESCE($5, category_id),
            priority = COALESCE($6, priority),
            level_id = COALESCE($7, level_id),
            after_minutes = COALESCE($8, after_minutes),
            trigger_on = COALESCE($9, trigger_on),
            notify_roles = COALESCE($10, notify_roles),
            is_active = COALESCE($11, is_active),
            updated_by = $12,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3
      RETURNING *`,
    [
      id, ctx.tenantId, ctx.companyId,
      s(b.name) ?? null,
      b.categoryId !== undefined || b.category_id !== undefined ? nn(b.categoryId ?? b.category_id) : null,
      b.priority !== undefined ? oneOf(b.priority, PRIORITIES, 'priority') : null,
      levelId,
      after ?? null,
      b.triggerOn !== undefined || b.trigger_on !== undefined
        ? oneOf(b.triggerOn ?? b.trigger_on, ESCALATION_TRIGGERS, 'triggerOn')
        : null,
      b.notifyRoles !== undefined || b.notify_roles !== undefined
        ? strList(b.notifyRoles ?? b.notify_roles)
        : null,
      b.isActive === undefined ? null : truthy(b.isActive),
      ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'update', resource: 'service_desk.escalation_rules', recordId: id,
    recordCode: String(before.rows[0].code), oldValues: before.rows[0], newValues: res.rows[0],
  });
  return res.rows[0];
}

/**
 * Manual escalation (spec section 17). The engine raises automatic ones from
 * the SLA sweep; this covers the judgement call an agent or manager makes
 * before a clock runs out - a P1 that is not moving, a vendor that has gone
 * quiet, an executive asking for visibility.
 */
export async function escalateTicket(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  b: Record<string, unknown>
) {
  const action = await ticketActionContext(client, ctx, ticketId, 'escalate');
  assertScoped(action);
  const ticket = action.ticket;

  const reason = s(b.reason);
  if (!reason) throw badRequest('An escalation reason is required');
  if (ticket.status === 'CLOSED' || ticket.status === 'CANCELLED') {
    throw conflict('A closed or cancelled ticket cannot be escalated');
  }

  const levelNo = n(b.level);
  const levelId = nn(b.levelId ?? b.level_id);
  const levelRes = await client.query<{ id: number; level: number; role_code: string; name: string }>(
    `SELECT id, level, role_code, name
       FROM escalation_levels
      WHERE tenant_id = $1 AND company_id = $2 AND is_active
        AND ($3::bigint IS NULL OR id = $3)
        AND ($4::int IS NULL OR level = $4)
      ORDER BY level
      LIMIT 1`,
    [ctx.tenantId, ctx.companyId, levelId, levelNo]
  );
  const level = levelRes.rows[0];
  if (!level) throw badRequest('No matching escalation level was found');

  const toUserId = nn(b.escalateToUserId ?? b.escalate_to_user_id ?? b.userId);
  if (toUserId) {
    const person = await client.query(
      `SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
      [toUserId, ctx.tenantId]
    );
    if (person.rows.length === 0) throw badRequest('Escalation target user not found');
  }

  const ins = await client.query(
    `INSERT INTO ticket_escalations
       (tenant_id, company_id, branch_id, ticket_id, level_id, level, reason, trigger_type,
        escalated_from_user_id, escalated_to_user_id, escalated_to_role, notified_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'MANUAL',$8,$9,$10,now(),$11)
     RETURNING *`,
    [
      ctx.tenantId, ctx.companyId, ticket.branch_id, ticket.id, level.id, Number(level.level),
      reason, ticket.assigned_to_user_id ?? null, toUserId, level.role_code, ctx.userId ?? null,
    ]
  );

  // ESCALATED is legal from most live states; when it is not (for example a
  // ticket already waiting on the requester), the escalation is still recorded
  // and notified - the flag is informational, the record is the truth.
  const canFlag = await client.query<{ ok: boolean }>(
    `SELECT service_ticket_status_transition_ok($1, 'ESCALATED') AS ok`,
    [ticket.status]
  );
  if (canFlag.rows[0]?.ok === true) {
    await applyStatus(client, ctx, action, 'ESCALATED', { reason: `Escalated to L${level.level}: ${reason}` });
    await statusEvent(client, ctx, ticket, 'ESCALATED', { level: Number(level.level), reason });
  }

  await logAudit(client, ctx, {
    action: 'escalate',
    resource: 'service_desk.tickets',
    recordId: Number(ticket.id),
    recordCode: ticket.ticket_number,
    oldValues: { status: ticket.status },
    newValues: { status: 'ESCALATED', level: Number(level.level), roleCode: level.role_code },
    metadata: { reason, triggerType: 'MANUAL' },
  });

  await emitEvent(client, ctx, {
    eventType: 'service_desk.ticket.escalated',
    entityType: 'service_ticket',
    entityId: Number(ticket.id),
    entityCode: ticket.ticket_number,
    severity: Number(level.level) >= 3 ? 'CRITICAL' : 'WARN',
    payload: {
      ticketNumber: ticket.ticket_number,
      level: Number(level.level),
      levelName: level.name,
      roleCode: level.role_code,
      reason,
      triggerType: 'MANUAL',
    },
  });

  await notifyDeskRoles(client, ctx, [level.role_code], {
    type: 'service_desk.ticket.escalated',
    title: `${ticket.priority} ${ticket.ticket_number} escalated to L${level.level}`,
    body: `${level.name}: ${reason}`.slice(0, 220),
    link: `/service-desk/tickets/${ticket.id}`,
    entityType: 'service_ticket',
    entityId: Number(ticket.id),
    severity: Number(level.level) >= 3 ? 'ERROR' : 'WARN',
    actionRequired: true,
  }, { excludeUserId: ctx.userId ?? null, queueId: ticket.assigned_queue_id });

  if (toUserId) {
    await createNotification(client, ctx, {
      userId: toUserId,
      type: 'service_desk.ticket.escalated',
      title: `${ticket.ticket_number} escalated to you`,
      body: reason.slice(0, 200),
      link: `/service-desk/tickets/${ticket.id}`,
      entityType: 'service_ticket',
      entityId: Number(ticket.id),
      severity: 'WARN',
      actionRequired: true,
    });
  }

  return ins.rows[0];
}

/** Acknowledge an open escalation so the level above knows it was seen. */
export async function acknowledgeEscalation(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  escalationId: number,
  b: Record<string, unknown> = {}
) {
  const action = await ticketActionContext(client, ctx, ticketId, 'escalate');
  assertScoped(action);

  const res = await client.query(
    `UPDATE ticket_escalations
        SET acknowledged_at = now(), acknowledged_by = $4, updated_at = now()
      WHERE id = $1 AND ticket_id = $2 AND company_id = $3 AND acknowledged_at IS NULL
      RETURNING *`,
    [escalationId, ticketId, ctx.companyId, ctx.userId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Open escalation not found');

  await logAudit(client, ctx, {
    action: 'acknowledge_escalation',
    resource: 'service_desk.tickets',
    recordId: ticketId,
    recordCode: action.ticket.ticket_number,
    newValues: { escalationId, acknowledged: true },
    metadata: s(b.note) ? { note: s(b.note) } : undefined,
  });
  return res.rows[0];
}

/** Close every open escalation - used when the desk deliberately stands down. */
export async function resolveEscalations(client: pg.PoolClient, ctx: Ctx, ticketId: number, b: Record<string, unknown> = {}) {
  const action = await ticketActionContext(client, ctx, ticketId, 'escalate');
  assertScoped(action);
  const closed = await closeOpenEscalations(client, Number(ticketId));
  await logAudit(client, ctx, {
    action: 'resolve_escalation',
    resource: 'service_desk.tickets',
    recordId: ticketId,
    recordCode: action.ticket.ticket_number,
    newValues: { closed },
    metadata: s(b.reason) ? { reason: s(b.reason) } : undefined,
  });
  return { closed };
}

// ------------------------------------------------------- ticket relations

/**
 * Link two tickets (duplicate, blocked by, caused by ...). Relations are
 * bidirectional in meaning but stored once, on the ticket they were created
 * from.
 */
export async function addTicketRelation(
  client: pg.PoolClient,
  ctx: Ctx,
  ticketId: number,
  b: Record<string, unknown>
) {
  const action = await ticketActionContext(client, ctx, ticketId, 'update');
  assertScoped(action);

  const relationType = oneOf(
    b.relationType ?? b.relation_type ?? 'RELATED',
    TICKET_RELATION_TYPES,
    'relationType'
  );
  const ref = b.relatedTicketId ?? b.related_ticket_id ?? b.relatedTicketNumber ?? b.related_ticket_number;
  let related: TicketRow | null = null;
  if (ref !== undefined && ref !== null && ref !== '') {
    const num = Number(ref);
    related = Number.isFinite(num) && String(ref).match(/^\d+$/)
      ? await loadTicketRow(client, ctx, num)
      : await loadTicketByNumber(client, ctx, String(ref));
  }
  if (!related) throw badRequest('Related ticket not found');
  if (Number(related.id) === Number(ticketId)) throw badRequest('A ticket cannot be related to itself');

  const ins = await client.query(
    `INSERT INTO ticket_relations
       (tenant_id, company_id, ticket_id, related_ticket_id, relation_type, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (ticket_id, related_ticket_id, relation_type) DO UPDATE
        SET note = EXCLUDED.note
     RETURNING *`,
    [
      ctx.tenantId, ctx.companyId, action.ticket.id, related.id, relationType,
      s(b.note) ?? null, ctx.userId ?? null,
    ]
  );

  await logAudit(client, ctx, {
    action: 'relate_ticket',
    resource: 'service_desk.tickets',
    recordId: Number(ticketId),
    recordCode: action.ticket.ticket_number,
    newValues: { relatedTicketId: Number(related.id), relationType },
  });
  return ins.rows[0];
}

export async function removeTicketRelation(client: pg.PoolClient, ctx: Ctx, ticketId: number, relationId: number) {
  const action = await ticketActionContext(client, ctx, ticketId, 'update');
  assertScoped(action);
  const res = await client.query(
    `DELETE FROM ticket_relations
      WHERE id = $1 AND ticket_id = $2 AND company_id = $3 AND tenant_id = $4
      RETURNING id`,
    [relationId, ticketId, ctx.companyId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Ticket relation not found');
  await logAudit(client, ctx, {
    action: 'unrelate_ticket',
    resource: 'service_desk.tickets',
    recordId: Number(ticketId),
    recordCode: action.ticket.ticket_number,
    oldValues: { relationId },
  });
  return { removed: true };
}

export const TICKET_RELATION_TYPES = [
  'RELATED', 'DUPLICATE', 'BLOCKS', 'BLOCKED_BY', 'CAUSED_BY', 'PARENT', 'CHILD',
] as const;

// ------------------------------------------------------------- summaries

/**
 * Sidebar counters for the agent workspace. Deliberately one round trip: the
 * workspace polls this on every list refresh.
 */
export async function queueSummary(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  const params: unknown[] = [ctx.tenantId, ctx.companyId, scope.userId, ACTIVE_STATUSES as unknown as string[]];
  const where: string[] = ['t.tenant_id = $1', 't.company_id = $2', 't.status = ANY($4::text[])'];

  const pred = scopePredicate(scope, 't');
  if (pred.sql !== 'true') {
    where.push(bindAfter(pred.sql, params.length));
    params.push(...pred.params);
  }

  const res = await client.query(
    `SELECT
       count(*)                                                            AS open_total,
       count(*) FILTER (WHERE t.assigned_to_user_id = $3)                  AS my_tickets,
       count(*) FILTER (WHERE t.assigned_to_user_id IS NULL)               AS unassigned,
       count(*) FILTER (WHERE t.priority = 'P1')                           AS critical,
       count(*) FILTER (WHERE t.status = 'ESCALATED')                      AS escalated,
       count(*) FILTER (WHERE t.status = 'PENDING_REQUESTER')              AS pending_requester,
       count(*) FILTER (WHERE t.status = 'PENDING_VENDOR')                 AS pending_vendor,
       count(*) FILTER (WHERE t.sla_resolution_due_at IS NOT NULL
                          AND t.sla_resolution_due_at < now())             AS overdue,
       count(*) FILTER (WHERE t.sla_resolution_due_at IS NOT NULL
                          AND t.sla_resolution_due_at >= now()
                          AND t.sla_resolution_due_at <= now() + interval '60 minutes') AS due_soon,
       count(*) FILTER (WHERE t.sla_response_due_at IS NOT NULL
                          AND t.first_response_at IS NULL
                          AND t.sla_response_due_at < now())               AS response_overdue,
       count(*) FILTER (WHERE t.opened_at::date = current_date)            AS opened_today,
       count(*) FILTER (WHERE t.resolved_at::date = current_date)          AS resolved_today
     FROM service_tickets t
     WHERE ${where.join(' AND ')}`,
    params
  );

  const queues = await client.query(
    `SELECT q.id, q.code, q.name, q.assignment_strategy, q.is_default,
            count(t.id) FILTER (WHERE t.status = ANY($3::text[])) AS open_tickets,
            count(t.id) FILTER (WHERE t.status = ANY($3::text[]) AND t.assigned_to_user_id IS NULL) AS unassigned,
            count(t.id) FILTER (WHERE t.status = ANY($3::text[]) AND t.priority = 'P1') AS critical
       FROM service_queues q
       LEFT JOIN service_tickets t
              ON t.assigned_queue_id = q.id AND t.tenant_id = $1 AND t.company_id = $2
      WHERE q.tenant_id = $1 AND q.company_id = $2 AND q.is_active
      GROUP BY q.id, q.code, q.name, q.assignment_strategy, q.is_default
      ORDER BY q.is_default DESC, q.name`,
    [ctx.tenantId, ctx.companyId, ACTIVE_STATUSES as unknown as string[]]
  );

  const counts = res.rows[0] ?? {};
  return {
    counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v ?? 0)])),
    queues: queues.rows,
  };
}

/**
 * The employee portal payload (spec section 24): what I raised, what was just
 * fixed, what is waiting on me, and knowledge that might answer it before a
 * ticket is even raised.
 */
export async function myServiceDeskSummary(client: pg.PoolClient, ctx: Ctx) {
  const scope = await resolveScope(client, ctx);
  const params: unknown[] = [ctx.tenantId, ctx.companyId, scope.userId ?? -1, scope.employeeId ?? -1];
  const mine = `t.tenant_id = $1 AND t.company_id = $2
                AND (t.requester_user_id = $3 OR t.requester_employee_id = $4)`;

  const open = await client.query(
    `${TICKET_SELECT} ${TICKET_FROM}
      WHERE ${mine} AND t.status = ANY($5::text[])
      ORDER BY CASE t.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
               t.opened_at DESC
      LIMIT 50`,
    [...params, ACTIVE_STATUSES as unknown as string[]]
  );

  const recent = await client.query(
    `${TICKET_SELECT} ${TICKET_FROM}
      WHERE ${mine} AND t.status IN ('RESOLVED','CLOSED')
      ORDER BY COALESCE(t.resolved_at, t.closed_at) DESC
      LIMIT 20`,
    params
  );

  const pending = await client.query(
    `${TICKET_SELECT} ${TICKET_FROM}
      WHERE ${mine} AND t.status = 'PENDING_REQUESTER'
      ORDER BY t.opened_at DESC
      LIMIT 20`,
    params
  );

  const counts = await client.query<{ open_tickets: string }>(
    `SELECT count(*)::text AS open_tickets
       FROM service_tickets t
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND (t.requester_user_id = $3 OR t.requester_employee_id = $4)
        AND t.status = ANY($5::text[])`,
    [...params, ACTIVE_STATUSES as unknown as string[]]
  );

  const knowledge = await client.query(
    `SELECT k.id, k.article_number, k.title, k.summary, k.category_id, kc.name AS category_name,
            k.view_count, k.helpful_count, k.published_at
       FROM knowledge_articles k
       LEFT JOIN knowledge_categories kc ON kc.id = k.category_id
      WHERE k.tenant_id = $1 AND k.company_id = $2 AND k.status = 'PUBLISHED'
      ORDER BY k.helpful_count DESC, k.view_count DESC, k.published_at DESC NULLS LAST
      LIMIT 6`,
    [ctx.tenantId, ctx.companyId]
  );

  const assets = await client.query(
    `SELECT a.id, a.asset_no, a.name, a.status, a.operational_state, a.last_maintenance
       FROM asset_register a
      WHERE a.tenant_id = $1 AND a.company_id = $2
        AND (a.custodian_employee_id = $3 OR a.custodian_user_id = $4)
      ORDER BY a.asset_no
      LIMIT 20`,
    [ctx.tenantId, ctx.companyId, scope.employeeId ?? -1, scope.userId ?? -1]
  );

  return {
    openTickets: open.rows,
    recentTickets: recent.rows,
    pendingTickets: pending.rows,
    openCount: Number(counts.rows[0]?.open_tickets ?? 0),
    knowledge: knowledge.rows,
    myAssets: assets.rows,
  };
}

// ------------------------------------------------------------ dashboards

const dashboardWindow = (v: unknown, fallbackDays: number): number => {
  const days = n(v);
  if (days === undefined) return fallbackDays;
  return Math.min(365, Math.max(1, Math.round(days)));
};

/** Employee dashboard (spec section 24). */
export async function employeeDashboard(client: pg.PoolClient, ctx: Ctx) {
  const scope = await resolveScope(client, ctx);
  const summary = await myServiceDeskSummary(client, ctx);
  const counts = await client.query(
    `SELECT
       count(*) FILTER (WHERE t.status = ANY($5::text[]))                 AS open_tickets,
       count(*) FILTER (WHERE t.status = 'PENDING_REQUESTER')            AS awaiting_me,
       count(*) FILTER (WHERE t.status = 'RESOLVED')                     AS awaiting_confirmation,
       count(*) FILTER (WHERE t.resolved_at >= now() - interval '30 days') AS resolved_30d,
       count(*) FILTER (WHERE t.opened_at >= now() - interval '30 days')  AS raised_30d
     FROM service_tickets t
     WHERE t.tenant_id = $1 AND t.company_id = $2
       AND (t.requester_user_id = $3 OR t.requester_employee_id = $4)`,
    [ctx.tenantId, ctx.companyId, scope.userId ?? -1, scope.employeeId ?? -1,
      ACTIVE_STATUSES as unknown as string[]]
  );
  return {
    ...summary,
    counts: Object.fromEntries(
      Object.entries(counts.rows[0] ?? {}).map(([k, v]) => [k, Number(v ?? 0)])
    ),
  };
}

/** Service desk agent dashboard: my work, and what is about to go wrong. */
export async function agentDashboard(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  const [summary, workload] = await Promise.all([
    queueSummary(client, ctx, q),
    technicianWorkload(client, ctx, q),
  ]);

  const mine = await client.query(
    `${TICKET_SELECT} ${TICKET_FROM}
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.assigned_to_user_id = $3
        AND t.status = ANY($4::text[])
      ORDER BY CASE t.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
               COALESCE(t.sla_resolution_due_at, 'infinity') ASC
      LIMIT 25`,
    [ctx.tenantId, ctx.companyId, scope.userId ?? -1, ACTIVE_STATUSES as unknown as string[]]
  );

  const unassigned = await client.query(
    `${TICKET_SELECT} ${TICKET_FROM}
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.assigned_to_user_id IS NULL
        AND t.status = ANY($3::text[])
      ORDER BY CASE t.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
               t.opened_at ASC
      LIMIT 25`,
    [ctx.tenantId, ctx.companyId, ACTIVE_STATUSES as unknown as string[]]
  );

  const slaWarnings = await client.query(
    `${TICKET_SELECT} ${TICKET_FROM}
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.status = ANY($3::text[])
        AND (
          (t.sla_resolution_due_at IS NOT NULL AND t.sla_resolution_due_at <= now() + interval '60 minutes')
          OR (t.first_response_at IS NULL AND t.sla_response_due_at IS NOT NULL AND t.sla_response_due_at <= now())
        )
      ORDER BY COALESCE(t.sla_resolution_due_at, t.sla_response_due_at) ASC
      LIMIT 25`,
    [ctx.tenantId, ctx.companyId, ACTIVE_STATUSES as unknown as string[]]
  );

  const critical = await client.query(
    `${TICKET_SELECT} ${TICKET_FROM}
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.priority = 'P1'
        AND t.status = ANY($3::text[])
      ORDER BY t.opened_at ASC
      LIMIT 25`,
    [ctx.tenantId, ctx.companyId, ACTIVE_STATUSES as unknown as string[]]
  );

  return {
    counts: summary.counts,
    queues: summary.queues,
    workload,
    myTickets: mine.rows,
    unassigned: unassigned.rows,
    slaWarnings: slaWarnings.rows,
    criticalIncidents: critical.rows,
  };
}

/** Manager dashboard: compliance, throughput, workload, escalation pressure. */
export async function managerDashboard(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const days = dashboardWindow(q.days, 30);
  const [summary, workload] = await Promise.all([
    queueSummary(client, ctx, q),
    technicianWorkload(client, ctx, q),
  ]);

  const compliance = await client.query(
    `SELECT
       count(*)                                                                   AS tracked,
       count(*) FILTER (WHERE s.response_state = 'MET')                           AS response_met,
       count(*) FILTER (WHERE s.response_state = 'BREACHED')                      AS response_breached,
       count(*) FILTER (WHERE s.resolution_state = 'MET')                         AS resolution_met,
       count(*) FILTER (WHERE s.resolution_state = 'BREACHED')                    AS resolution_breached,
       round(100.0 * count(*) FILTER (WHERE s.resolution_state = 'MET')
             / NULLIF(count(*) FILTER (WHERE s.resolution_state IN ('MET','BREACHED')), 0), 1) AS resolution_compliance_pct,
       round(100.0 * count(*) FILTER (WHERE s.response_state = 'MET')
             / NULLIF(count(*) FILTER (WHERE s.response_state IN ('MET','BREACHED')), 0), 1)   AS response_compliance_pct
     FROM sla_tracking s
     JOIN service_tickets t ON t.id = s.ticket_id
     WHERE s.tenant_id = $1 AND s.company_id = $2
       AND t.opened_at >= now() - ($3::int || ' days')::interval`,
    [ctx.tenantId, ctx.companyId, days]
  );

  const resolution = await client.query(
    `SELECT
       round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.opened_at)) / 60.0)::numeric, 1)          AS avg_minutes,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t.resolved_at - t.opened_at)) / 60.0) AS median_minutes,
       round(avg(EXTRACT(EPOCH FROM (t.first_response_at - t.opened_at)) / 60.0)::numeric, 1)      AS avg_first_response_minutes
     FROM service_tickets t
     WHERE t.tenant_id = $1 AND t.company_id = $2
       AND t.opened_at >= now() - ($3::int || ' days')::interval
       AND t.resolved_at IS NOT NULL`,
    [ctx.tenantId, ctx.companyId, days]
  );

  const escalations = await client.query(
    `SELECT e.level, l.name AS level_name, l.role_code,
            count(*)                                        AS total,
            count(*) FILTER (WHERE e.resolved_at IS NULL)   AS open_count
       FROM ticket_escalations e
       LEFT JOIN escalation_levels l ON l.id = e.level_id
      WHERE e.tenant_id = $1 AND e.company_id = $2
        AND e.created_at >= now() - ($3::int || ' days')::interval
      GROUP BY e.level, l.name, l.role_code
      ORDER BY e.level`,
    [ctx.tenantId, ctx.companyId, days]
  );

  const recurring = await client.query(
    `SELECT t.category_id, c.name AS category_name, t.subcategory_id, sc.name AS subcategory_name,
            count(*)                                                 AS incidents,
            count(*) FILTER (WHERE t.priority IN ('P1','P2'))         AS high_impact,
            count(DISTINCT t.affected_asset_id)                       AS distinct_assets,
            max(t.opened_at)                                          AS last_seen
       FROM service_tickets t
       LEFT JOIN service_categories c ON c.id = t.category_id
       LEFT JOIN service_subcategories sc ON sc.id = t.subcategory_id
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.ticket_type IN ('INCIDENT','SECURITY_INCIDENT')
        AND t.opened_at >= now() - ($3::int || ' days')::interval
      GROUP BY t.category_id, c.name, t.subcategory_id, sc.name
     HAVING count(*) >= 3
      ORDER BY count(*) DESC, max(t.opened_at) DESC
      LIMIT 20`,
    [ctx.tenantId, ctx.companyId, days]
  );

  const trend = await client.query(
    `SELECT to_char(date_trunc('day', t.opened_at), 'YYYY-MM-DD') AS day,
            count(*)                                              AS opened,
            count(*) FILTER (WHERE t.resolved_at IS NOT NULL
                               AND t.resolved_at::date = t.opened_at::date) AS same_day_resolved
       FROM service_tickets t
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.opened_at >= now() - ($3::int || ' days')::interval
      GROUP BY 1
      ORDER BY 1`,
    [ctx.tenantId, ctx.companyId, days]
  );

  return {
    windowDays: days,
    counts: summary.counts,
    queues: summary.queues,
    workload,
    sla: compliance.rows[0] ?? {},
    resolutionTime: resolution.rows[0] ?? {},
    escalations: escalations.rows,
    recurringIncidents: recurring.rows,
    trend: trend.rows,
  };
}

/** Executive dashboard: what is on fire, and whether the desk is keeping up. */
export async function executiveDashboard(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const days = dashboardWindow(q.days, 90);
  const params = [ctx.tenantId, ctx.companyId, days] as unknown[];

  const headline = await client.query(
    `SELECT
       count(*) FILTER (WHERE t.status = ANY($4::text[]) AND t.priority = 'P1')  AS open_critical,
       count(*) FILTER (WHERE t.status = ANY($4::text[]) AND t.priority = 'P2')  AS open_high,
       count(*) FILTER (WHERE t.status = ANY($4::text[]))                        AS open_total,
       count(*) FILTER (WHERE t.status = 'ESCALATED')                            AS escalated,
       count(*) FILTER (WHERE t.status = ANY($4::text[]) AND t.ticket_type = 'SECURITY_INCIDENT') AS open_security,
       count(*) FILTER (WHERE t.opened_at >= now() - ($3::int || ' days')::interval)              AS opened_window,
       count(*) FILTER (WHERE t.resolved_at >= now() - ($3::int || ' days')::interval)            AS resolved_window
     FROM service_tickets t
     WHERE t.tenant_id = $1 AND t.company_id = $2`,
    [...params, ACTIVE_STATUSES as unknown as string[]]
  );

  const sla = await client.query(
    `SELECT
       round(100.0 * count(*) FILTER (WHERE s.resolution_state = 'MET')
             / NULLIF(count(*) FILTER (WHERE s.resolution_state IN ('MET','BREACHED')), 0), 1) AS resolution_compliance_pct,
       count(*) FILTER (WHERE s.resolution_state = 'BREACHED') AS resolution_breached,
       round(100.0 * count(*) FILTER (WHERE s.response_state = 'MET')
             / NULLIF(count(*) FILTER (WHERE s.response_state IN ('MET','BREACHED')), 0), 1) AS response_compliance_pct
     FROM sla_tracking s
     JOIN service_tickets t ON t.id = s.ticket_id
     WHERE s.tenant_id = $1 AND s.company_id = $2
       AND t.opened_at >= now() - ($3::int || ' days')::interval`,
    params
  );

  const outages = await client.query(
    `SELECT t.id, t.ticket_number, t.subject, t.priority, t.status, t.impact,
            t.opened_at, t.assigned_to_user_id, u.email AS assignee_email,
            t.affected_asset_id, a.asset_no, a.name AS asset_name
       FROM service_tickets t
       LEFT JOIN users u ON u.id = t.assigned_to_user_id
       LEFT JOIN asset_register a ON a.id = t.affected_asset_id
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.status = ANY($3::text[])
        AND t.impact = 'ENTERPRISE'
      ORDER BY CASE t.priority WHEN 'P1' THEN 1 ELSE 2 END, t.opened_at ASC
      LIMIT 20`,
    [ctx.tenantId, ctx.companyId, ACTIVE_STATUSES as unknown as string[]]
  );

  const trend = await client.query(
    `SELECT to_char(date_trunc('week', t.opened_at), 'YYYY-MM-DD') AS week,
            count(*)                                              AS opened,
            count(*) FILTER (WHERE t.priority = 'P1')              AS critical,
            count(*) FILTER (WHERE t.resolved_at IS NOT NULL)      AS resolved
       FROM service_tickets t
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.opened_at >= now() - ($3::int || ' days')::interval
      GROUP BY 1
      ORDER BY 1`,
    params
  );

  const byCategory = await client.query(
    `SELECT c.name AS category_name, count(*) AS total,
            count(*) FILTER (WHERE t.priority = 'P1') AS critical,
            round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.opened_at)) / 60.0)::numeric, 1) AS avg_resolution_minutes
       FROM service_tickets t
       LEFT JOIN service_categories c ON c.id = t.category_id
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.opened_at >= now() - ($3::int || ' days')::interval
      GROUP BY c.name
      ORDER BY count(*) DESC
      LIMIT 12`,
    params
  );

  return {
    windowDays: days,
    headline: Object.fromEntries(
      Object.entries(headline.rows[0] ?? {}).map(([k, v]) => [k, Number(v ?? 0)])
    ),
    sla: sla.rows[0] ?? {},
    majorOutages: outages.rows,
    trend: trend.rows,
    byCategory: byCategory.rows,
  };
}

// -------------------------------------------------------------- reporting

export const SERVICE_DESK_REPORTS = [
  'tickets_by_category',
  'tickets_by_department',
  'tickets_by_employee',
  'sla_compliance',
  'sla_breaches',
  'resolution_time',
  'first_response_time',
  'technician_workload',
  'recurring_incidents',
  'asset_incidents',
  'service_trends',
] as const;

export type ServiceDeskReportCode = (typeof SERVICE_DESK_REPORTS)[number];

interface ReportDefinition {
  title: string;
  groupBy: string;
  columns: { key: string; label: string; type: 'text' | 'number' | 'date' | 'minutes' | 'percent' }[];
  sql: string;
}

const minutes = { type: 'minutes' as const };
const pct = { type: 'percent' as const };

const REPORT_DEFINITIONS: Record<ServiceDeskReportCode, ReportDefinition> = {
  tickets_by_category: {
    title: 'Tickets by category',
    groupBy: 'category',
    columns: [
      { key: 'category', label: 'Category', type: 'text' },
      { key: 'total', label: 'Tickets', type: 'number' },
      { key: 'critical', label: 'P1', type: 'number' },
      { key: 'open_tickets', label: 'Open', type: 'number' },
      { key: 'avg_resolution_minutes', label: 'Avg resolution', ...minutes },
    ],
    sql: `
      SELECT COALESCE(c.name, 'Uncategorised') AS category, t.category_id,
             count(*)::int AS total,
             count(*) FILTER (WHERE t.priority = 'P1')::int AS critical,
             count(*) FILTER (WHERE t.status = ANY($4::text[]))::int AS open_tickets,
             round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.opened_at)) / 60.0)::numeric, 1) AS avg_resolution_minutes
        FROM service_tickets t
        LEFT JOIN service_categories c ON c.id = t.category_id
       WHERE t.tenant_id = $1 AND t.company_id = $2 AND t.opened_at >= $3::timestamptz
       GROUP BY 1, t.category_id
       ORDER BY total DESC`,
  },
  tickets_by_department: {
    title: 'Tickets by department',
    groupBy: 'department',
    columns: [
      { key: 'department', label: 'Department', type: 'text' },
      { key: 'total', label: 'Tickets', type: 'number' },
      { key: 'critical', label: 'P1', type: 'number' },
      { key: 'open_tickets', label: 'Open', type: 'number' },
      { key: 'avg_resolution_minutes', label: 'Avg resolution', ...minutes },
    ],
    sql: `
      SELECT COALESCE(d.name, 'Unassigned') AS department, t.department_id,
             count(*)::int AS total,
             count(*) FILTER (WHERE t.priority = 'P1')::int AS critical,
             count(*) FILTER (WHERE t.status = ANY($4::text[]))::int AS open_tickets,
             round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.opened_at)) / 60.0)::numeric, 1) AS avg_resolution_minutes
        FROM service_tickets t
        LEFT JOIN departments d ON d.id = t.department_id
       WHERE t.tenant_id = $1 AND t.company_id = $2 AND t.opened_at >= $3::timestamptz
       GROUP BY 1, t.department_id
       ORDER BY total DESC`,
  },
  tickets_by_employee: {
    title: 'Tickets by employee',
    groupBy: 'employee',
    columns: [
      { key: 'employee_no', label: 'Employee no', type: 'text' },
      { key: 'employee', label: 'Employee', type: 'text' },
      { key: 'total', label: 'Tickets', type: 'number' },
      { key: 'open_tickets', label: 'Open', type: 'number' },
      { key: 'breaches', label: 'SLA breaches', type: 'number' },
    ],
    sql: `
      SELECT e.employee_no,
             NULLIF(trim(coalesce(e.first_name,'') || ' ' || coalesce(e.last_name,'')), '') AS employee,
             t.requester_employee_id,
             count(*)::int AS total,
             count(*) FILTER (WHERE t.status = ANY($4::text[]))::int AS open_tickets,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM sla_breaches b WHERE b.ticket_id = t.id))::int AS breaches
        FROM service_tickets t
        LEFT JOIN employees e ON e.id = t.requester_employee_id
       WHERE t.tenant_id = $1 AND t.company_id = $2 AND t.opened_at >= $3::timestamptz
       GROUP BY 1, 2, t.requester_employee_id
       ORDER BY total DESC
       LIMIT 500`,
  },
  sla_compliance: {
    title: 'SLA compliance',
    groupBy: 'policy',
    columns: [
      { key: 'policy', label: 'SLA policy', type: 'text' },
      { key: 'tickets', label: 'Tickets', type: 'number' },
      { key: 'response_met', label: 'Response met', type: 'number' },
      { key: 'resolution_met', label: 'Resolution met', type: 'number' },
      { key: 'resolution_breached', label: 'Resolution breached', type: 'number' },
      { key: 'compliance_pct', label: 'Compliance', ...pct },
      { key: 'avg_resolution_minutes', label: 'Avg resolution', ...minutes },
    ],
    sql: `
      SELECT COALESCE(p.name, p.code, 'Unmatched') AS policy, s.policy_id,
             count(*)::int AS tickets,
             count(*) FILTER (WHERE s.response_state = 'MET')::int AS response_met,
             count(*) FILTER (WHERE s.resolution_state = 'MET')::int AS resolution_met,
             count(*) FILTER (WHERE s.resolution_state = 'BREACHED')::int AS resolution_breached,
             round(100.0 * count(*) FILTER (WHERE s.resolution_state = 'MET')
                   / NULLIF(count(*) FILTER (WHERE s.resolution_state IN ('MET','BREACHED')), 0), 1) AS compliance_pct,
             round(avg(EXTRACT(EPOCH FROM (s.resolved_at - t.opened_at)) / 60.0)::numeric, 1) AS avg_resolution_minutes
        FROM sla_tracking s
        JOIN service_tickets t ON t.id = s.ticket_id
        LEFT JOIN sla_policies p ON p.id = s.policy_id
       WHERE s.tenant_id = $1 AND s.company_id = $2 AND t.opened_at >= $3::timestamptz
       GROUP BY 1, s.policy_id
       ORDER BY tickets DESC`,
  },
  sla_breaches: {
    title: 'SLA breaches',
    groupBy: 'breach',
    columns: [
      { key: 'ticket_number', label: 'Ticket', type: 'text' },
      { key: 'subject', label: 'Subject', type: 'text' },
      { key: 'priority', label: 'Priority', type: 'text' },
      { key: 'breach_type', label: 'Breach', type: 'text' },
      { key: 'due_at', label: 'Due', type: 'date' },
      { key: 'breached_at', label: 'Breached', type: 'date' },
      { key: 'minutes_over', label: 'Minutes over', type: 'number' },
      { key: 'assignee', label: 'Assignee', type: 'text' },
    ],
    sql: `
      SELECT t.ticket_number, t.subject, t.priority, b.breach_type,
             b.due_at, b.breached_at, b.minutes_over::int AS minutes_over,
             COALESCE(NULLIF(trim(coalesce(e.first_name,'') || ' ' || coalesce(e.last_name,'')), ''), u.email) AS assignee
        FROM sla_breaches b
        JOIN service_tickets t ON t.id = b.ticket_id
        LEFT JOIN users u ON u.id = t.assigned_to_user_id
        LEFT JOIN employees e ON e.id = u.employee_id
       WHERE b.tenant_id = $1 AND b.company_id = $2 AND b.breached_at >= $3::timestamptz
       ORDER BY b.breached_at DESC
       LIMIT 1000`,
  },
  resolution_time: {
    title: 'Resolution time',
    groupBy: 'priority',
    columns: [
      { key: 'priority', label: 'Priority', type: 'text' },
      { key: 'resolved', label: 'Resolved', type: 'number' },
      { key: 'avg_resolution_minutes', label: 'Average', ...minutes },
      { key: 'median_resolution_minutes', label: 'Median', ...minutes },
      { key: 'p90_resolution_minutes', label: '90th percentile', ...minutes },
      { key: 'within_sla', label: 'Within SLA', type: 'number' },
    ],
    sql: `
      SELECT t.priority,
             count(*)::int AS resolved,
             round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.opened_at)) / 60.0)::numeric, 1) AS avg_resolution_minutes,
             round(percentile_cont(0.5) WITHIN GROUP (
                     ORDER BY EXTRACT(EPOCH FROM (t.resolved_at - t.opened_at)) / 60.0)::numeric, 1) AS median_resolution_minutes,
             round(percentile_cont(0.9) WITHIN GROUP (
                     ORDER BY EXTRACT(EPOCH FROM (t.resolved_at - t.opened_at)) / 60.0)::numeric, 1) AS p90_resolution_minutes,
             count(*) FILTER (WHERE t.resolved_at <= t.sla_resolution_due_at)::int AS within_sla
        FROM service_tickets t
       WHERE t.tenant_id = $1 AND t.company_id = $2
         AND t.resolved_at IS NOT NULL AND t.resolved_at >= $3::timestamptz
       GROUP BY t.priority
       ORDER BY t.priority`,
  },
  first_response_time: {
    title: 'First response time',
    groupBy: 'priority',
    columns: [
      { key: 'priority', label: 'Priority', type: 'text' },
      { key: 'responded', label: 'Responded', type: 'number' },
      { key: 'avg_first_response_minutes', label: 'Average', ...minutes },
      { key: 'median_first_response_minutes', label: 'Median', ...minutes },
      { key: 'within_sla', label: 'Within SLA', type: 'number' },
      { key: 'awaiting_response', label: 'Awaiting response', type: 'number' },
    ],
    sql: `
      SELECT t.priority,
             count(*) FILTER (WHERE t.first_response_at IS NOT NULL)::int AS responded,
             round(avg(EXTRACT(EPOCH FROM (t.first_response_at - t.opened_at)) / 60.0)::numeric, 1) AS avg_first_response_minutes,
             round(percentile_cont(0.5) WITHIN GROUP (
                     ORDER BY EXTRACT(EPOCH FROM (t.first_response_at - t.opened_at)) / 60.0)::numeric, 1) AS median_first_response_minutes,
             count(*) FILTER (WHERE t.first_response_at IS NOT NULL
                                AND (t.sla_response_due_at IS NULL OR t.first_response_at <= t.sla_response_due_at))::int AS within_sla,
             count(*) FILTER (WHERE t.first_response_at IS NULL
                                AND t.status = ANY($4::text[]))::int AS awaiting_response
        FROM service_tickets t
       WHERE t.tenant_id = $1 AND t.company_id = $2 AND t.opened_at >= $3::timestamptz
       GROUP BY t.priority
       ORDER BY t.priority`,
  },
  technician_workload: {
    title: 'Technician workload',
    groupBy: 'technician',
    columns: [
      { key: 'technician', label: 'Technician', type: 'text' },
      { key: 'open_tickets', label: 'Open', type: 'number' },
      { key: 'critical_tickets', label: 'P1', type: 'number' },
      { key: 'overdue_tickets', label: 'Overdue', type: 'number' },
      { key: 'resolved_tickets', label: 'Resolved', type: 'number' },
      { key: 'avg_resolution_minutes', label: 'Avg resolution', ...minutes },
    ],
    sql: `
      SELECT COALESCE(NULLIF(trim(coalesce(e.first_name,'') || ' ' || coalesce(e.last_name,'')), ''), u.email) AS technician,
             u.id AS user_id,
             count(t.id) FILTER (WHERE t.status = ANY($4::text[]))::int AS open_tickets,
             count(t.id) FILTER (WHERE t.priority = 'P1' AND t.status = ANY($4::text[]))::int AS critical_tickets,
             count(t.id) FILTER (WHERE t.sla_resolution_due_at < now() AND t.status = ANY($4::text[]))::int AS overdue_tickets,
             count(t.id) FILTER (WHERE t.resolved_at >= $3::timestamptz)::int AS resolved_tickets,
             round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.opened_at)) / 60.0)
                   FILTER (WHERE t.resolved_at IS NOT NULL))::numeric(12,1) AS avg_resolution_minutes
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles r ON r.id = ur.role_id
        LEFT JOIN employees e ON e.id = u.employee_id
        LEFT JOIN service_tickets t
               ON t.assigned_to_user_id = u.id AND t.tenant_id = $1 AND t.company_id = $2
       WHERE u.tenant_id = $1
         AND r.code IN ('service_desk_agent','service_desk_technician','service_desk_manager')
       GROUP BY 1, u.id
       ORDER BY open_tickets DESC, technician`,
  },
  recurring_incidents: {
    title: 'Recurring incidents',
    groupBy: 'pattern',
    columns: [
      { key: 'category_name', label: 'Category', type: 'text' },
      { key: 'subcategory_name', label: 'Subcategory', type: 'text' },
      { key: 'incidents', label: 'Incidents', type: 'number' },
      { key: 'high_impact', label: 'P1/P2', type: 'number' },
      { key: 'distinct_assets', label: 'Assets', type: 'number' },
      { key: 'distinct_requesters', label: 'Requesters', type: 'number' },
      { key: 'last_seen', label: 'Last seen', type: 'date' },
    ],
    sql: `
      SELECT COALESCE(c.name,'Uncategorised') AS category_name,
             COALESCE(sc.name,'-') AS subcategory_name,
             t.category_id, t.subcategory_id,
             count(*)::int AS incidents,
             count(*) FILTER (WHERE t.priority IN ('P1','P2'))::int AS high_impact,
             count(DISTINCT t.affected_asset_id)::int AS distinct_assets,
             count(DISTINCT t.requester_employee_id)::int AS distinct_requesters,
             max(t.opened_at) AS last_seen
        FROM service_tickets t
        LEFT JOIN service_categories c ON c.id = t.category_id
        LEFT JOIN service_subcategories sc ON sc.id = t.subcategory_id
       WHERE t.tenant_id = $1 AND t.company_id = $2
         AND t.ticket_type IN ('INCIDENT','SECURITY_INCIDENT')
         AND t.opened_at >= $3::timestamptz
       GROUP BY 1, 2, t.category_id, t.subcategory_id
      HAVING count(*) >= 2
       ORDER BY incidents DESC, last_seen DESC
       LIMIT 200`,
  },
  asset_incidents: {
    title: 'Asset incidents',
    groupBy: 'asset',
    columns: [
      { key: 'asset_no', label: 'Asset', type: 'text' },
      { key: 'asset_name', label: 'Name', type: 'text' },
      { key: 'category_name', label: 'Asset category', type: 'text' },
      { key: 'tickets', label: 'Tickets', type: 'number' },
      { key: 'critical', label: 'P1', type: 'number' },
      { key: 'open_tickets', label: 'Open', type: 'number' },
      { key: 'avg_resolution_minutes', label: 'Avg resolution', ...minutes },
    ],
    sql: `
      SELECT a.asset_no, a.name AS asset_name, ac.name AS category_name,
             a.id AS asset_id,
             count(*)::int AS tickets,
             count(*) FILTER (WHERE t.priority = 'P1')::int AS critical,
             count(*) FILTER (WHERE t.status = ANY($4::text[]))::int AS open_tickets,
             round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.opened_at)) / 60.0)::numeric, 1) AS avg_resolution_minutes
        FROM service_tickets t
        JOIN asset_register a ON a.id = t.affected_asset_id
        LEFT JOIN asset_categories ac ON ac.id = a.category_id
       WHERE t.tenant_id = $1 AND t.company_id = $2 AND t.opened_at >= $3::timestamptz
       GROUP BY 1, 2, 3, a.id
       ORDER BY tickets DESC
       LIMIT 200`,
  },
  service_trends: {
    title: 'Service trends',
    groupBy: 'day',
    columns: [
      { key: 'day', label: 'Day', type: 'date' },
      { key: 'opened', label: 'Opened', type: 'number' },
      { key: 'resolved', label: 'Resolved', type: 'number' },
      { key: 'critical', label: 'P1', type: 'number' },
      { key: 'breaches', label: 'Breaches', type: 'number' },
      { key: 'avg_first_response_minutes', label: 'Avg first response', ...minutes },
    ],
    sql: `
      SELECT to_char(date_trunc('day', t.opened_at), 'YYYY-MM-DD') AS day,
             count(*)::int AS opened,
             count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved,
             count(*) FILTER (WHERE t.priority = 'P1')::int AS critical,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM sla_breaches b WHERE b.ticket_id = t.id))::int AS breaches,
             round(avg(EXTRACT(EPOCH FROM (t.first_response_at - t.opened_at)) / 60.0)::numeric, 1) AS avg_first_response_minutes
        FROM service_tickets t
       WHERE t.tenant_id = $1 AND t.company_id = $2 AND t.opened_at >= $3::timestamptz
       GROUP BY 1
       ORDER BY 1`,
  },
};

export interface ServiceDeskReportRequest extends Record<string, unknown> {
  report?: string;
  from?: string;
  to?: string;
  days?: number | string;
}

/**
 * One read path for all eleven reports (spec section 25) so FILTER, GROUP,
 * DRILL DOWN and the three export formats all behave identically: the filters
 * are applied in SQL, the scope predicate is applied in SQL, and the caller
 * receives `columns` so the renderer never has to know the shape in advance.
 */
export async function runServiceDeskReport(
  client: pg.PoolClient,
  ctx: Ctx,
  q: ServiceDeskReportRequest = {}
) {
  const code = String(q.report ?? 'service_trends').toLowerCase() as ServiceDeskReportCode;
  const def = REPORT_DEFINITIONS[code];
  if (!def) {
    throw badRequest(`Unknown report '${q.report}'. Expected one of: ${SERVICE_DESK_REPORTS.join(', ')}`);
  }

  const days = dashboardWindow(q.days, 30);
  const from = s(q.from) ?? new Date(Date.now() - days * 86_400_000).toISOString();
  const to = s(q.to);

  // $1 is the tenant, $2 the company and $3 the window start. Only some of the
  // reports reference $4 (the active-status list used by their open-ticket
  // filters), so it is bound conditionally. Binding it unconditionally made the
  // five reports that never mention $4 fail with "bind message supplies 4
  // parameters, but prepared statement requires 3".
  const params: unknown[] = [ctx.tenantId, ctx.companyId, from];
  if (def.sql.includes('$4')) params.push(ACTIVE_STATUSES as unknown as string[]);
  let sql = def.sql;
  const extra: string[] = [];

  const scope = await resolveScope(client, ctx);
  const pred = scopePredicate(scope, 't');
  if (pred.sql !== 'true') {
    extra.push(bindAfter(pred.sql, params.length));
    params.push(...pred.params);
  }
  if (to) extra.push(`t.opened_at < $${pushParam(params, to)}::timestamptz`);
  const deptId = nn(q.departmentId ?? q.department_id);
  if (deptId) extra.push(`t.department_id = $${pushParam(params, deptId)}`);
  const catId = nn(q.categoryId ?? q.category_id);
  if (catId) extra.push(`t.category_id = $${pushParam(params, catId)}`);
  const prio = strList(q.priority).map((x) => x.toUpperCase());
  if (prio.length) extra.push(`t.priority = ANY($${pushParam(params, prio)}::text[])`);

  if (extra.length) {
    // Reports are written with a single WHERE clause, so the extra predicates
    // are appended to it rather than restated per report.
    const marker = sql.lastIndexOf(' GROUP BY');
    const head = marker === -1 ? sql : sql.slice(0, marker);
    const tail = marker === -1 ? '' : sql.slice(marker);
    sql = `${head} AND ${extra.join(' AND ')} ${tail}`;
  }

  const res = await client.query(sql, params);

  const totals: Record<string, number> = {};
  for (const col of def.columns) {
    if (col.type === 'number' || col.type === 'minutes') {
      totals[col.key] = res.rows.reduce((sum, r) => sum + (Number(r[col.key]) || 0), 0);
    }
  }

  return {
    report: code,
    title: def.title,
    groupBy: def.groupBy,
    columns: def.columns,
    rows: res.rows,
    rowCount: res.rows.length,
    totals,
    filters: {
      from,
      to: to ?? null,
      days,
      departmentId: deptId,
      categoryId: catId,
      priority: prio,
    },
    scope: { isAgent: scope.isAgent, isAdmin: scope.isAdmin, isManager: scope.isManager },
    generatedAt: new Date().toISOString(),
  };
}

export function serviceDeskReportCatalogue() {
  return (Object.keys(REPORT_DEFINITIONS) as ServiceDeskReportCode[]).map((code) => ({
    code,
    title: REPORT_DEFINITIONS[code].title,
    groupBy: REPORT_DEFINITIONS[code].groupBy,
    columns: REPORT_DEFINITIONS[code].columns,
  }));
}
