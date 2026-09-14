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

/**
 * HOPE DESIGN Service Desk - Problem management (spec section 18).
 *
 * Multiple incidents -> pattern detected -> problem created -> root cause
 * investigation -> known error -> permanent fix -> problem closed.
 *
 * Incidents stay in service_tickets; problem_incidents is the many-to-many
 * bridge so one incident can feed several problems. Known errors are the
 * agent-facing workaround record; root_cause_analyses hold the investigation
 * including approved corrective and preventive actions.
 */

export const PROBLEM_STATUSES = [
  'NEW',
  'INVESTIGATING',
  'ROOT_CAUSE_IDENTIFIED',
  'KNOWN_ERROR',
  'RESOLVED',
  'CLOSED',
  'CANCELLED',
] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

/**
 * Legal problem transitions. CLOSED and CANCELLED are terminal apart from a
 * reopen to INVESTIGATING, because a closed problem that recurs is exactly the
 * case this module exists to catch.
 */
export const PROBLEM_TRANSITIONS: Record<ProblemStatus, ProblemStatus[]> = {
  NEW: ['INVESTIGATING', 'KNOWN_ERROR', 'CANCELLED'],
  INVESTIGATING: ['NEW', 'ROOT_CAUSE_IDENTIFIED', 'KNOWN_ERROR', 'CANCELLED'],
  ROOT_CAUSE_IDENTIFIED: ['INVESTIGATING', 'KNOWN_ERROR', 'RESOLVED', 'CANCELLED'],
  KNOWN_ERROR: ['INVESTIGATING', 'ROOT_CAUSE_IDENTIFIED', 'RESOLVED', 'CANCELLED'],
  RESOLVED: ['CLOSED', 'INVESTIGATING', 'KNOWN_ERROR'],
  CLOSED: ['INVESTIGATING'],
  CANCELLED: ['INVESTIGATING'],
};

export function assertProblemTransition(from: string, to: string): void {
  const allowed = PROBLEM_TRANSITIONS[from as ProblemStatus];
  if (!allowed) throw conflict('Unknown problem status: ' + from);
  if (from === to) return;
  if (!allowed.includes(to as ProblemStatus)) {
    throw conflict('Problem cannot move from ' + from + ' to ' + to);
  }
}

export const KNOWN_ERROR_STATUSES = ['ACTIVE', 'FIX_PENDING', 'RESOLVED', 'ARCHIVED'] as const;
export const RCA_METHODS = ['FIVE_WHYS', 'FISHBONE', 'FAULT_TREE', 'KEPNER_TREGOE', 'OTHER'] as const;
export const RCA_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED'] as const;
export const PROBLEM_LINK_TYPES = ['TRIGGERING', 'MATCHED', 'MANUAL'] as const;
export const PROBLEM_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export const PROBLEM_IMPACTS = ['ENTERPRISE', 'DEPARTMENT', 'INDIVIDUAL', 'MINOR'] as const;

export interface ProblemScope extends TicketScope {
  canCreate: boolean;
  canUpdate: boolean;
  canInvestigate: boolean;
  canResolve: boolean;
  canClose: boolean;
  canManageKnownErrors: boolean;
  canApproveRca: boolean;
}

export async function resolveProblemScope(client: pg.PoolClient, ctx: Ctx): Promise<ProblemScope> {
  const base = await resolveScope(client, ctx);
  const perms = base.permissions;
  return {
    ...base,
    canCreate: base.isAdmin || hasPerm(perms, 'service_desk.problems.create'),
    canUpdate: base.isAdmin || hasPerm(perms, 'service_desk.problems.update'),
    canInvestigate: base.isAdmin || hasPerm(perms, 'service_desk.problems.investigate'),
    canResolve: base.isAdmin || hasPerm(perms, 'service_desk.problems.resolve'),
    canClose: base.isAdmin || hasPerm(perms, 'service_desk.problems.close'),
    canManageKnownErrors:
      base.isAdmin ||
      hasPerm(perms, 'service_desk.known_errors.create') ||
      hasPerm(perms, 'service_desk.known_errors.update'),
    canApproveRca: base.isAdmin || hasPerm(perms, 'service_desk.problems.resolve'),
  };
}

export interface ProblemRow {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
  problem_number: string;
  title: string;
  description: string | null;
  category_id: number | null;
  subcategory_id: number | null;
  status: string;
  priority: string;
  impact: string | null;
  incident_count: number;
  assigned_to_user_id: number | null;
  assigned_team_id: number | null;
  root_cause: string | null;
  workaround: string | null;
  permanent_fix: string | null;
  identified_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  closed_by: number | null;
  created_by: number | null;
}

/**
 * Publish ABAC facts for a problem. Tenant policies match on module
 * service_desk, so problems inherit SD-READONLY, SD-OUT-OF-SCOPE and
 * SD-CLASSIFIED with no extra policy set. owner_user_id feeds
 * ABAC-NO-SELF-APPROVE so an author cannot approve their own corrective plan.
 */
export function problemResourceAttributes(
  scope: ProblemScope,
  p: ProblemRow,
  action: string
): Record<string, unknown> {
  const isOwner = sameId(p.created_by, scope.userId);
  const inReach =
    scope.isAdmin ||
    scope.isAgent ||
    isOwner ||
    sameId(p.assigned_to_user_id, scope.userId);
  const attrs: Record<string, unknown> = {
    module: 'service_desk',
    resource: 'problems',
    action,
    problem_id: p.id,
    problem_number: p.problem_number,
    priority: p.priority,
    status: p.status,
    owner_user_id: p.created_by,
    assigned_to_user_id: p.assigned_to_user_id,
    service_desk_agent: scope.isAgent,
    service_desk_internal_notes: scope.canViewInternalNotes,
    service_desk_readonly: false,
    classified_denied: false,
  };
  if (!inReach) attrs.scope_denied = true;
  return attrs;
}

export async function loadProblem(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string
): Promise<ProblemRow | null> {
  const res =
    isNumericRef(ref)
      ? await client.query<ProblemRow>(
          'SELECT p.* FROM problems p WHERE p.id = $1 AND p.tenant_id = $2 AND p.company_id = $3',
          [Number(ref), ctx.tenantId, ctx.companyId]
        )
      : await client.query<ProblemRow>(
          'SELECT p.* FROM problems p WHERE p.problem_number = $1 AND p.tenant_id = $2 AND p.company_id = $3',
          [ref, ctx.tenantId, ctx.companyId]
        );
  return res.rows[0] ?? null;
}

/**
 * Resolve a problem reference - a surrogate id or a HDG-PRB-YYYY-NNNNNN
 * document number - to its numeric primary key. State-machine handlers are
 * keyed on the id, so route layers normalise through here first.
 */
export async function resolveProblemId(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string
): Promise<number> {
  const problem = await loadProblem(client, ctx, ref);
  if (!problem) throw notFound('Problem not found');
  return Number(problem.id);
}
export interface ProblemActionContext {
  problem: ProblemRow;
  scope: ProblemScope;
  attributes: Record<string, unknown>;
}

/** Load a problem, resolve reach, publish ABAC facts, and refuse out-of-scope. */
export async function problemActionContext(
  client: pg.PoolClient,
  ctx: Ctx,
  ref: number | string,
  action: string
): Promise<ProblemActionContext> {
  const problem = await loadProblem(client, ctx, ref);
  if (!problem) throw notFound('Problem not found');
  const scope = await resolveProblemScope(client, ctx);
  const attributes = problemResourceAttributes(scope, problem, action);
  ctx.resourceAttributes = { ...(ctx.resourceAttributes ?? {}), ...attributes };
  if (attributes.scope_denied === true) {
    throw forbidden('This problem is outside your service desk scope');
  }
  return { problem, scope, attributes };
}

const label = (p: ProblemRow) => p.problem_number + ' - ' + p.title;

async function notifyProblemWatchers(
  client: pg.PoolClient,
  ctx: Ctx,
  p: ProblemRow,
  payload: { type: string; title: string; body?: string; severity?: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' }
) {
  const assignees = await usersWithPermission(client, ctx, 'service_desk.problems.investigate');
  await notifyUsers(client, ctx, uniq([p.assigned_to_user_id, p.created_by, ...assignees.slice(0, 25)]), {
    type: payload.type,
    title: payload.title,
    body: payload.body,
    link: '/service-desk/problems/' + p.id,
    entityType: 'service_problem',
    entityId: p.id,
    severity: payload.severity ?? 'INFO',
  });
}

// ------------------------------------------------------------ problem records

const PROBLEM_SORTS: Record<string, string> = {
  newest: 'p.created_at DESC, p.id DESC',
  oldest: 'p.created_at ASC, p.id ASC',
  priority: "CASE p.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END, p.created_at DESC",
  incidents: 'p.incident_count DESC, p.created_at DESC',
  number: 'p.problem_number ASC',
};

export interface ListProblemsQuery extends Record<string, unknown> {
  status?: string;
  statuses?: string;
  priority?: string;
  categoryId?: number;
  assignedTo?: number;
  mine?: boolean;
  search?: string;
  linkedTicketId?: number;
  sortBy?: string;
  page?: number;
  pageSize?: number;
}

export async function listProblems(client: pg.PoolClient, ctx: Ctx, q: ListProblemsQuery = {}) {
  const scope = await resolveProblemScope(client, ctx);
  const { page, pageSize: limit, offset } = parsePagination(q as Record<string, unknown>);
  const where: string[] = ['p.tenant_id = $1', 'p.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  // Replace every marker in one clause with the same placeholder so a compound
  // ILIKE clause can reuse a single bound value.
  const push = (sql: string, ...values: unknown[]) => {
    const first = params.length + 1;
    for (const v of values) params.push(v);
    const token = '$' + String(first);
    where.push(sql.split('?').join(token));
  };

  const status = oneOf(q.status, PROBLEM_STATUSES);
  if (status) push('p.status = ?', status);
  const statusList = strList(q.statuses)
    ?.map((x) => x.toUpperCase())
    .filter((x) => (PROBLEM_STATUSES as readonly string[]).includes(x));
  if (!status && statusList && statusList.length) push('p.status = ANY(?)', statusList);
  const priority = oneOf(q.priority, PROBLEM_PRIORITIES);
  if (priority) push('p.priority = ?', priority);
  if (q.categoryId) push('p.category_id = ?', Number(q.categoryId));
  if (q.assignedTo) push('p.assigned_to_user_id = ?', Number(q.assignedTo));
  if (truthy(q.mine) && scope.userId) push('p.assigned_to_user_id = ?', scope.userId);
  const search = s(q.search);
  if (search) {
    push(
      '(p.title ILIKE ? OR p.problem_number ILIKE ? OR p.description ILIKE ?)',
      '%' + search + '%'
    );
  }
  if (q.linkedTicketId) {
    push(
      'EXISTS (SELECT 1 FROM problem_incidents pi WHERE pi.problem_id = p.id AND pi.ticket_id = ?)',
      Number(q.linkedTicketId)
    );
  }
  // Employees only ever reach problems they raised or that touch their tickets.
  if (!scope.isAgent) {
    const userRef = '$' + String(params.length + 1);
    const empRef = '$' + String(params.length + 2);
    params.push(scope.userId ?? -1, scope.employeeId ?? -1);
    where.push(
      '(p.created_by = ' +
        userRef +
        ' OR EXISTS (SELECT 1 FROM problem_incidents pi JOIN service_tickets t ON t.id = pi.ticket_id ' +
        'WHERE pi.problem_id = p.id AND (t.requester_user_id = ' +
        userRef +
        ' OR t.requester_employee_id = ' +
        empRef +
        ')))'
    );
  }

  // String(q.sortBy) would yield the literal string "undefined" when the
  // caller omits sortBy, producing `ORDER BY undefined` and a 500 (42703).
  // The default has to be applied to the value, not only to the guard.
  const sortKey = Object.keys(PROBLEM_SORTS).includes(String(q.sortBy ?? 'newest'))
    ? String(q.sortBy ?? 'newest')
    : 'newest';
  const whereSql = where.join(' AND ');
  const totalRes = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM problems p WHERE ' + whereSql,
    params
  );
  const rows = await client.query(
    'SELECT p.*, c.name AS category_name, sc.name AS subcategory_name, ' +
      "u.first_name || ' ' || u.last_name AS assigned_to_name, " +
      "cu.first_name || ' ' || cu.last_name AS created_by_name, " +
      "(SELECT count(*)::int FROM known_errors ke WHERE ke.problem_id = p.id AND ke.status <> 'ARCHIVED') AS known_error_count, " +
      '(SELECT count(*)::int FROM root_cause_analyses r WHERE r.problem_id = p.id) AS rca_count ' +
      'FROM problems p ' +
      'LEFT JOIN service_categories c ON c.id = p.category_id ' +
      'LEFT JOIN service_subcategories sc ON sc.id = p.subcategory_id ' +
      'LEFT JOIN users u ON u.id = p.assigned_to_user_id ' +
      'LEFT JOIN users cu ON cu.id = p.created_by ' +
      'WHERE ' + whereSql + ' ORDER BY ' + PROBLEM_SORTS[sortKey] + ' LIMIT ' + String(limit) + ' OFFSET ' + String(offset),
    params
  );
  return paged(rows.rows, Number(totalRes.rows[0]?.count ?? 0), page, limit, offset);
}

export interface ProblemDetail {
  problem: Record<string, unknown>;
  incidents: unknown[];
  knownErrors: unknown[];
  analyses: unknown[];
  history: unknown[];
  permissions: Record<string, boolean>;
}

export async function getProblem(client: pg.PoolClient, ctx: Ctx, id: number): Promise<ProblemDetail> {
  const { problem, scope } = await problemActionContext(client, ctx, id, 'view');
  const detail = await client.query(
    'SELECT p.*, c.name AS category_name, sc.name AS subcategory_name, ' +
      "u.first_name || ' ' || u.last_name AS assigned_to_name, t.name AS assigned_team_name, " +
      "cb.first_name || ' ' || cb.last_name AS closed_by_name " +
      'FROM problems p ' +
      'LEFT JOIN service_categories c ON c.id = p.category_id ' +
      'LEFT JOIN service_subcategories sc ON sc.id = p.subcategory_id ' +
      'LEFT JOIN users u ON u.id = p.assigned_to_user_id ' +
      'LEFT JOIN service_teams t ON t.id = p.assigned_team_id ' +
      'LEFT JOIN users cb ON cb.id = p.closed_by WHERE p.id = $1',
    [problem.id]
  );
  const incidents = await client.query(
    'SELECT pi.id AS link_id, pi.link_type, pi.ticket_id, pi.created_at AS linked_at, ' +
      't.ticket_number, t.subject, t.status, t.priority, t.ticket_type, t.opened_at, t.resolved_at, t.closed_at ' +
      'FROM problem_incidents pi LEFT JOIN service_tickets t ON t.id = pi.ticket_id ' +
      'WHERE pi.problem_id = $1 ORDER BY t.opened_at DESC NULLS LAST, pi.id DESC',
    [problem.id]
  );
  const knownErrors = await client.query(
    'SELECT ke.*, u.first_name || ' + "''" + ' AS created_by_name FROM known_errors ke ' +
      'LEFT JOIN users u ON u.id = ke.created_by WHERE ke.problem_id = $1 ORDER BY ke.id DESC',
    [problem.id]
  );
  const analyses = await client.query(
    'SELECT r.*, u.first_name AS created_by_name, a.first_name AS approved_by_name ' +
      'FROM root_cause_analyses r LEFT JOIN users u ON u.id = r.created_by ' +
      'LEFT JOIN users a ON a.id = r.approved_by WHERE r.problem_id = $1 ORDER BY r.created_at DESC',
    [problem.id]
  );
  const history = await client.query(
    "SELECT a.id, a.action, a.user_id, a.old_values, a.new_values, a.created_at, u.first_name AS actor_name " +
      "FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id " +
      "WHERE a.resource = 'problems' AND a.record_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 200",
    [problem.id]
  );
  return {
    problem: detail.rows[0] ?? problem,
    incidents: incidents.rows,
    knownErrors: knownErrors.rows,
    analyses: analyses.rows,
    history: history.rows,
    permissions: {
      update: scope.canUpdate,
      investigate: scope.canInvestigate,
      resolve: scope.canResolve,
      close: scope.canClose,
      knownErrors: scope.canManageKnownErrors,
      approveRca: scope.canApproveRca,
    },
  };
}

// ------------------------------------------------------------ problem mutations

const PROBLEM_STATUS_STAMPS: Record<ProblemStatus, { at?: string; actor?: string }> = {
  NEW: {},
  INVESTIGATING: {},
  ROOT_CAUSE_IDENTIFIED: { at: 'identified_at' },
  KNOWN_ERROR: {},
  RESOLVED: { at: 'resolved_at' },
  CLOSED: { at: 'closed_at', actor: 'closed_by' },
  CANCELLED: {},
};

/**
 * Single gate for every problem status change. It validates the edge, stamps the
 * matching lifecycle columns, audits, emits and notifies in one place so that no
 * caller can move a problem without leaving the same trail behind it.
 */
async function applyProblemStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  to: ProblemStatus,
  opts: {
    note?: string | null;
    eventType: string;
    notify?: boolean;
    extraSets?: Record<string, unknown>;
    severity?: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
  }
) {
  const problem = requireRow(await loadProblem(client, ctx, id), 'Problem not found');
  assertProblemTransition(problem.status, to);

  const sets: string[] = ['status = $4', 'updated_by = $5'];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId, to, ctx.userId ?? null];

  const stamp = PROBLEM_STATUS_STAMPS[to];
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
    'UPDATE problems SET ' + sets.join(', ') + ' WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    params
  );

  await logAudit(client, ctx, {
    action: opts.eventType.split('.').pop() ?? 'update',
    resource: 'problems',
    recordId: id,
    recordCode: problem.problem_number,
    oldValues: { status: problem.status },
    newValues: { status: to, note: opts.note ?? null },
  });
  await emitEvent(client, ctx, {
    eventType: opts.eventType,
    entityType: 'service_problem',
    entityId: id,
    entityCode: problem.problem_number,
    payload: { from: problem.status, to, title: problem.title },
    severity: opts.severity === 'SUCCESS' ? 'INFO' : opts.severity ?? 'INFO',
  });

  if (opts.notify !== false) {
    await notifyProblemWatchers(client, ctx, problem, {
      type: opts.eventType,
      title: 'Problem ' + problem.problem_number + ' is now ' + to,
      body: opts.note ?? problem.title,
      severity: opts.severity ?? (to === 'CLOSED' ? 'SUCCESS' : 'INFO'),
    });
  }
  return { id, problem_number: problem.problem_number, status: to };
}

export interface CreateProblemInput extends Record<string, unknown> {
  title?: string;
  description?: string;
  categoryId?: number;
  subcategoryId?: number;
  priority?: string;
  impact?: string;
  assignedToUserId?: number;
  assignedTeamId?: number;
  rootCause?: string;
  workaround?: string;
  permanentFix?: string;
  /** Tickets that exposed or match this problem. */
  ticketIds?: number[];
  /** TRIGGERING for the first incident, MATCHED for the rest (default MANUAL). */
  linkType?: string;
}

export async function createProblem(client: pg.PoolClient, ctx: Ctx, b: CreateProblemInput = {}) {
  const scope = await resolveProblemScope(client, ctx);
  if (!scope.canCreate) throw forbidden('You cannot create problems');

  const title = s(b.title);
  if (!title) throw badRequest('title is required');
  const priority = oneOf(b.priority, PROBLEM_PRIORITIES) ?? 'P3';
  const impact = oneOf(b.impact, PROBLEM_IMPACTS) ?? 'DEPARTMENT';
  const linkType = oneOf(b.linkType, PROBLEM_LINK_TYPES) ?? 'MANUAL';

  const numRes = await client.query<{ no: string }>('SELECT next_problem_no($1, $2) AS no', [
    ctx.tenantId,
    ctx.companyId,
  ]);
  const problemNumber = numRes.rows[0]?.no;
  if (!problemNumber) throw conflict('Could not allocate a problem number');

  const ins = await client.query<{ id: number }>(
    'INSERT INTO problems ' +
      '(tenant_id, company_id, branch_id, problem_number, title, description, category_id, subcategory_id, ' +
      'status, priority, impact, assigned_to_user_id, assigned_team_id, root_cause, workaround, permanent_fix, ' +
      'created_by, updated_by) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'NEW',$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING id",
    [
      ctx.tenantId,
      ctx.companyId,
      ctx.branchId ?? null,
      problemNumber,
      title,
      s(b.description) ?? null,
      n(b.categoryId) ?? null,
      n(b.subcategoryId) ?? null,
      priority,
      impact,
      n(b.assignedToUserId) ?? null,
      n(b.assignedTeamId) ?? null,
      s(b.rootCause) ?? null,
      s(b.workaround) ?? null,
      s(b.permanentFix) ?? null,
      ctx.userId ?? null,
    ]
  );
  const id = ins.rows[0].id;

  const ticketIds = uniq(
    (Array.isArray(b.ticketIds) ? b.ticketIds : []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
  );
  for (const ticketId of ticketIds) {
    await linkIncidentToProblemInner(client, ctx, id, ticketId, linkType);
  }

  const problem = requireRow(await loadProblem(client, ctx, id), 'Problem not found');
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'problems',
    recordId: id,
    recordCode: problemNumber,
    newValues: { title, priority, impact, ticketIds },
  });
  await emitEvent(client, ctx, {
    eventType: 'service_desk.problem.created',
    entityType: 'service_problem',
    entityId: id,
    entityCode: problemNumber,
    payload: { title, priority, impact, incident_count: ticketIds.length },
    severity: priority === 'P1' ? 'WARN' : 'INFO',
  });
  await notifyProblemWatchers(client, ctx, problem, {
    type: 'service_desk.problem.created',
    title: 'Problem raised: ' + problemNumber,
    body: title,
    severity: priority === 'P1' ? 'WARN' : 'INFO',
  });
  return getProblem(client, ctx, id);
}

export async function updateProblem(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  const { problem, scope } = await problemActionContext(client, ctx, id, 'update');
  if (!scope.canUpdate) throw forbidden('You cannot update problems');

  const sets: string[] = ['updated_by = $4'];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId, ctx.userId ?? null];
  const assign = (col: string, val: unknown) => {
    params.push(val);
    sets.push(col + ' = $' + String(params.length));
  };

  const title = s(b.title);
  if (title) assign('title', title);
  if (b.description !== undefined) assign('description', s(b.description) ?? null);
  if (b.categoryId !== undefined) assign('category_id', n(b.categoryId) ?? null);
  if (b.subcategoryId !== undefined) assign('subcategory_id', n(b.subcategoryId) ?? null);
  const priority = oneOf(b.priority, PROBLEM_PRIORITIES);
  if (priority) assign('priority', priority);
  const impact = oneOf(b.impact, PROBLEM_IMPACTS);
  if (impact) assign('impact', impact);
  if (b.assignedToUserId !== undefined) assign('assigned_to_user_id', n(b.assignedToUserId) ?? null);
  if (b.assignedTeamId !== undefined) assign('assigned_team_id', n(b.assignedTeamId) ?? null);
  if (b.rootCause !== undefined) assign('root_cause', s(b.rootCause) ?? null);
  if (b.workaround !== undefined) assign('workaround', s(b.workaround) ?? null);
  if (b.permanentFix !== undefined) assign('permanent_fix', s(b.permanentFix) ?? null);

  const nextAssignee = b.assignedToUserId !== undefined ? n(b.assignedToUserId) ?? null : problem.assigned_to_user_id;

  await client.query(
    'UPDATE problems SET ' + sets.join(', ') + ' WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    params
  );

  await logAudit(client, ctx, {
    action: 'update',
    resource: 'problems',
    recordId: id,
    recordCode: problem.problem_number,
    oldValues: { title: problem.title, priority: problem.priority, status: problem.status },
    newValues: { ...b, updated_by: ctx.userId ?? null },
  });
  await emitEvent(client, ctx, {
    eventType: 'service_desk.problem.updated',
    entityType: 'service_problem',
    entityId: id,
    entityCode: problem.problem_number,
    payload: { changed: Object.keys(b) },
  });

  if (nextAssignee && !sameId(nextAssignee, problem.assigned_to_user_id)) {
    await notifyUsers(client, ctx, [nextAssignee], {
      type: 'service_desk.problem.assigned',
      title: 'Problem assigned to you: ' + problem.problem_number,
      body: problem.title,
      link: '/service-desk/problems/' + id,
      entityType: 'service_problem',
      entityId: id,
    });
  }
  return getProblem(client, ctx, id);
}

// ------------------------------------------------------------ incident linking

/**
 * Attach a ticket to a problem. `xmax = 0` distinguishes a fresh insert from an
 * ON CONFLICT no-op so incident_count is only recomputed when the link is new.
 */
async function linkIncidentToProblemInner(
  client: pg.PoolClient,
  ctx: Ctx,
  problemId: number,
  ticketId: number,
  linkType: string
): Promise<boolean> {
  const res = await client.query<{ id: number; inserted: boolean }>(
    'INSERT INTO problem_incidents ' +
      '(tenant_id, company_id, problem_id, incident_id, ticket_id, link_type, linked_by) ' +
      'VALUES ($1,$2,$3,' +
      '(SELECT i.id FROM incidents i WHERE i.ticket_id = $4 AND i.company_id = $2),$4,$5,$6) ' +
      'ON CONFLICT (problem_id, ticket_id) DO NOTHING RETURNING id, (xmax = 0) AS inserted',
    [ctx.tenantId, ctx.companyId, problemId, ticketId, linkType, ctx.userId ?? null]
  );
  if (!res.rows.length) return false;
  await client.query(
    'UPDATE problems SET incident_count = ' +
      '(SELECT count(*) FROM problem_incidents WHERE problem_id = $1), updated_at = now() WHERE id = $1',
    [problemId]
  );
  return true;
}

export async function linkIncidentToProblem(
  client: pg.PoolClient,
  ctx: Ctx,
  problemRef: number | string,
  ticketRef: number | string,
  linkTypeRaw?: unknown
) {
  const { problem, scope } = await problemActionContext(client, ctx, problemRef, 'update');
  if (!scope.canInvestigate && !scope.canUpdate) throw forbidden('You cannot link incidents to problems');

  // `ticketRef` reaches us either as a surrogate id or as an HDG-SD number,
  // because the route advertises both `ticketId` and `ticketNumber`. Resolve
  // whichever was supplied; an id that does not exist can never match.
  const ticketRefText = String(ticketRef).trim();
  const ticketRefId = /^\d+$/.test(ticketRefText) ? Number(ticketRefText) : null;
  const ticketRes = await client.query<{ id: number; ticket_number: string; subject: string }>(
    `SELECT id, ticket_number, subject FROM service_tickets
      WHERE tenant_id = $1 AND company_id = $2
        AND (ticket_number = $3 OR id = $4)
      ORDER BY (ticket_number = $3) DESC
      LIMIT 1`,
    [ctx.tenantId, ctx.companyId, ticketRefText, ticketRefId]
  );
  const ticket = ticketRes.rows[0];
  if (!ticket) throw notFound('Ticket not found');

  const linkType = oneOf(linkTypeRaw, PROBLEM_LINK_TYPES) ?? 'MANUAL';
  const inserted = await linkIncidentToProblemInner(client, ctx, problem.id, ticket.id, linkType);
  if (!inserted) throw conflict('That ticket is already linked to this problem');

  await logAudit(client, ctx, {
    action: 'link_incident',
    resource: 'problems',
    recordId: problem.id,
    recordCode: problem.problem_number,
    newValues: { ticket_id: ticket.id, ticket_number: ticket.ticket_number, link_type: linkType },
  });
  await emitEvent(client, ctx, {
    eventType: 'service_desk.problem.incident_linked',
    entityType: 'service_problem',
    entityId: problem.id,
    entityCode: problem.problem_number,
    payload: { ticket_id: ticket.id, ticket_number: ticket.ticket_number, link_type: linkType },
  });
  return { problem_id: problem.id, ticket_id: ticket.id, link_type: linkType };
}

export async function unlinkIncidentFromProblem(
  client: pg.PoolClient,
  ctx: Ctx,
  problemRef: number | string,
  ticketId: number
) {
  const { problem, scope } = await problemActionContext(client, ctx, problemRef, 'update');
  if (!scope.canInvestigate && !scope.canUpdate) throw forbidden('You cannot unlink incidents from problems');

  const del = await client.query(
    'DELETE FROM problem_incidents WHERE problem_id = $1 AND ticket_id = $2 AND tenant_id = $3 AND company_id = $4 RETURNING id',
    [problem.id, ticketId, ctx.tenantId, ctx.companyId]
  );
  if (!del.rows.length) throw notFound('That ticket is not linked to this problem');

  await client.query(
    'UPDATE problems SET incident_count = ' +
      '(SELECT count(*) FROM problem_incidents WHERE problem_id = $1), updated_at = now() WHERE id = $1',
    [problem.id]
  );
  await logAudit(client, ctx, {
    action: 'unlink_incident',
    resource: 'problems',
    recordId: problem.id,
    recordCode: problem.problem_number,
    oldValues: { ticket_id: ticketId },
  });
  return { problem_id: problem.id, ticket_id: ticketId, unlinked: true };
}

export async function listProblemIncidents(
  client: pg.PoolClient,
  ctx: Ctx,
  problemRef: number | string
) {
  const { problem } = await problemActionContext(client, ctx, problemRef, 'view');
  const res = await client.query(
    'SELECT pi.id AS link_id, pi.link_type, pi.ticket_id, pi.created_at AS linked_at, ' +
      "u.first_name || ' ' || u.last_name AS linked_by_name, " +
      't.ticket_number, t.subject, t.status, t.priority, t.ticket_type, t.opened_at, t.resolved_at, t.closed_at ' +
      'FROM problem_incidents pi ' +
      'LEFT JOIN service_tickets t ON t.id = pi.ticket_id ' +
      'LEFT JOIN users u ON u.id = pi.linked_by ' +
      'WHERE pi.problem_id = $1 ORDER BY t.opened_at DESC NULLS LAST, pi.id DESC',
    [problem.id]
  );
  return { items: res.rows, total: res.rows.length };
}

// ------------------------------------------------------------ lifecycle verbs

export async function startProblemInvestigation(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  const { problem, scope } = await problemActionContext(client, ctx, id, 'investigate');
  if (!scope.canInvestigate) throw forbidden('You cannot investigate problems');

  const assignedTo =
    b.assignedToUserId !== undefined
      ? n(b.assignedToUserId) ?? null
      : problem.assigned_to_user_id ?? scope.userId ?? null;

  const out = await applyProblemStatus(client, ctx, id, 'INVESTIGATING', {
    note: s(b.note ?? b.reason) ?? null,
    eventType: 'service_desk.problem.investigating',
    extraSets: {
      assigned_to_user_id: assignedTo,
      root_cause: s(b.rootCause) ?? problem.root_cause,
    },
  });

  if (assignedTo && !sameId(assignedTo, problem.assigned_to_user_id)) {
    await notifyUsers(client, ctx, [assignedTo], {
      type: 'service_desk.problem.assigned',
      title: 'Problem assigned to you: ' + problem.problem_number,
      body: problem.title,
      link: '/service-desk/problems/' + id,
      entityType: 'service_problem',
      entityId: id,
    });
  }
  return out;
}

export async function identifyRootCause(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  const { scope } = await problemActionContext(client, ctx, id, 'investigate');
  if (!scope.canInvestigate) throw forbidden('You cannot investigate problems');

  const rootCause = s(b.rootCause);
  if (!rootCause) throw badRequest('rootCause is required to identify the root cause');

  return applyProblemStatus(client, ctx, id, 'ROOT_CAUSE_IDENTIFIED', {
    note: rootCause,
    eventType: 'service_desk.problem.root_cause_identified',
    extraSets: {
      root_cause: rootCause,
      workaround: s(b.workaround) ?? undefined,
    },
  });
}

/**
 * Promote a problem to a known error so repeat incidents become first-time
 * fixes. A known error without a workaround is useless to the desk, so the
 * workaround is mandatory here.
 */
export async function markProblemAsKnownError(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  const { problem, scope } = await problemActionContext(client, ctx, id, 'update');
  if (!scope.canManageKnownErrors && !scope.canInvestigate) {
    throw forbidden('You cannot record known errors');
  }

  const workaround = s(b.workaround) ?? problem.workaround;
  if (!workaround) throw badRequest('A workaround is required before recording a known error');

  const out = await applyProblemStatus(client, ctx, id, 'KNOWN_ERROR', {
    note: workaround,
    eventType: 'service_desk.problem.known_error',
    severity: 'WARN',
    extraSets: {
      workaround,
      root_cause: s(b.rootCause) ?? problem.root_cause,
    },
  });

  // Offer to capture the agent-facing known error record in the same action.
  if (truthy(b.createKnownError) || s(b.errorCode) || s(b.title)) {
    await createKnownError(client, ctx, {
      problemId: id,
      errorCode: s(b.errorCode) ?? null,
      title: s(b.title) ?? problem.title,
      symptoms: s(b.symptoms) ?? problem.description ?? null,
      workaround,
    });
  }

  const agents = await usersWithPermission(client, ctx, 'service_desk.tickets.resolve');
  await notifyUsers(client, ctx, agents.slice(0, 50), {
    type: 'service_desk.problem.known_error',
    title: 'Known error published: ' + problem.problem_number,
    body: problem.title + ' - workaround available',
    link: '/service-desk/problems/' + id,
    entityType: 'service_problem',
    entityId: id,
    severity: 'WARN',
  });
  return out;
}

export async function resolveProblem(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  const { problem, scope } = await problemActionContext(client, ctx, id, 'resolve');
  if (!scope.canResolve) throw forbidden('You cannot resolve problems');

  const permanentFix = s(b.permanentFix);
  if (!permanentFix) throw badRequest('permanentFix is required to resolve a problem');

  const out = await applyProblemStatus(client, ctx, id, 'RESOLVED', {
    note: permanentFix,
    eventType: 'service_desk.problem.resolved',
    severity: 'SUCCESS',
    extraSets: {
      permanent_fix: permanentFix,
      root_cause: s(b.rootCause) ?? problem.root_cause,
      workaround: s(b.workaround) ?? problem.workaround,
    },
  });

  // A permanent fix retires the workaround record it replaces.
  if (truthy(b.resolveKnownErrors) !== false) {
    await client.query(
      "UPDATE known_errors SET status = 'RESOLVED', resolved_at = now(), updated_by = $2, updated_at = now() " +
        "WHERE problem_id = $1 AND status IN ('ACTIVE','FIX_PENDING')",
      [id, ctx.userId ?? null]
    );
  }
  return out;
}

export async function closeProblem(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  const { problem, scope } = await problemActionContext(client, ctx, id, 'close');
  if (!scope.canClose) throw forbidden('You cannot close problems');

  if (!truthy(b.force)) {
    const open = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM problem_incidents pi JOIN service_tickets t ON t.id = pi.ticket_id " +
        "WHERE pi.problem_id = $1 AND t.status NOT IN ('RESOLVED','CLOSED','CANCELLED')",
      [id]
    );
    const openCount = Number(open.rows[0]?.count ?? 0);
    if (openCount > 0) {
      throw conflict(
        openCount + ' linked incident(s) are still open. Resolve them or close with force: true.'
      );
    }
  }

  return applyProblemStatus(client, ctx, id, 'CLOSED', {
    note: s(b.note ?? b.closureNotes) ?? null,
    eventType: 'service_desk.problem.closed',
    severity: 'SUCCESS',
  });
}

export async function cancelProblem(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  const { scope } = await problemActionContext(client, ctx, id, 'update');
  if (!scope.canUpdate && !scope.canClose) throw forbidden('You cannot cancel problems');

  const reason = s(b.reason ?? b.note);
  if (!reason) throw badRequest('reason is required to cancel a problem');

  return applyProblemStatus(client, ctx, id, 'CANCELLED', {
    note: reason,
    eventType: 'service_desk.problem.cancelled',
    severity: 'WARN',
  });
}

export async function reopenProblem(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  const { problem, scope } = await problemActionContext(client, ctx, id, 'update');
  if (!scope.canInvestigate && !scope.canUpdate) throw forbidden('You cannot reopen problems');

  const out = await applyProblemStatus(client, ctx, id, 'INVESTIGATING', {
    note: s(b.reason ?? b.note) ?? 'Problem reopened',
    eventType: 'service_desk.problem.reopened',
    severity: 'WARN',
    extraSets: {
      // Clear the resolution stamps so the record does not read as closed.
      resolved_at: null,
      closed_at: null,
      closed_by: null,
      assigned_to_user_id: problem.assigned_to_user_id ?? scope.userId ?? null,
    },
  });
  await notifyProblemWatchers(client, ctx, problem, {
    type: 'service_desk.problem.reopened',
    title: 'Problem reopened: ' + problem.problem_number,
    body: s(b.reason ?? b.note) ?? problem.title,
    severity: 'WARN',
  });
  return out;
}

// ------------------------------------------------------------ pattern detection

export interface ProblemCandidateQuery extends Record<string, unknown> {
  days?: number;
  minCount?: number;
  categoryId?: number;
}

/**
 * Recurring-incident analysis (spec section 18). Groups recent incidents by
 * category and subcategory so the desk can see a pattern before a human
 * notices it, and reports whether a problem already covers that group.
 */
export async function detectProblemCandidates(
  client: pg.PoolClient,
  ctx: Ctx,
  q: ProblemCandidateQuery = {}
) {
  const scope = await resolveProblemScope(client, ctx);
  if (!scope.isAgent) throw forbidden('Pattern detection is available to service desk staff');

  const days = Math.min(Math.max(n(q.days) ?? 30, 1), 365);
  const minCount = Math.min(Math.max(n(q.minCount) ?? 3, 2), 100);
  const params: unknown[] = [ctx.tenantId, ctx.companyId, days, minCount];
  let categoryClause = '';
  if (q.categoryId) {
    params.push(Number(q.categoryId));
    categoryClause = ' AND t.category_id = $' + String(params.length);
  }

  const groups = await client.query<{
    category_id: number | null;
    subcategory_id: number | null;
    category_name: string | null;
    subcategory_name: string | null;
    incident_count: number;
    ticket_numbers: string[];
    priorities: string[];
    first_opened_at: string | null;
    last_opened_at: string | null;
  }>(
    'SELECT t.category_id, t.subcategory_id, c.name AS category_name, sc.name AS subcategory_name, ' +
      'count(*)::int AS incident_count, ' +
      'array_agg(t.ticket_number ORDER BY t.opened_at DESC) AS ticket_numbers, ' +
      'array_agg(DISTINCT t.priority) AS priorities, ' +
      'min(t.opened_at) AS first_opened_at, max(t.opened_at) AS last_opened_at ' +
      'FROM service_tickets t ' +
      'LEFT JOIN service_categories c ON c.id = t.category_id ' +
      'LEFT JOIN service_subcategories sc ON sc.id = t.subcategory_id ' +
      'WHERE t.tenant_id = $1 AND t.company_id = $2 ' +
      "AND t.ticket_type IN ('INCIDENT','SECURITY_INCIDENT') " +
      'AND t.opened_at >= now() - make_interval(days => $3::int) ' +
      'GROUP BY t.category_id, t.subcategory_id, c.name, sc.name ' +
      'HAVING count(*) >= $4' + categoryClause + ' ' +
      'ORDER BY count(*) DESC, max(t.opened_at) DESC LIMIT 50',
    params
  );

  const items = [];
  for (const g of groups.rows) {
    const existing = await client.query<{ id: number; problem_number: string; status: string }>(
      'SELECT id, problem_number, status FROM problems ' +
        'WHERE tenant_id = $1 AND company_id = $2 ' +
        'AND category_id IS NOT DISTINCT FROM $3 AND subcategory_id IS NOT DISTINCT FROM $4 ' +
        "AND status NOT IN ('CLOSED','CANCELLED') ORDER BY id DESC LIMIT 1",
      [ctx.tenantId, ctx.companyId, g.category_id, g.subcategory_id]
    );
    const linked = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM problem_incidents pi ' +
        'JOIN service_tickets t ON t.id = pi.ticket_id WHERE t.ticket_number = ANY($1)',
      [g.ticket_numbers ?? []]
    );
    const linkedCount = Number(linked.rows[0]?.count ?? 0);
    items.push({
      categoryId: g.category_id,
      subcategoryId: g.subcategory_id,
      categoryName: g.category_name,
      subcategoryName: g.subcategory_name,
      incidentCount: g.incident_count,
      ticketNumbers: (g.ticket_numbers ?? []).slice(0, 25),
      priorities: g.priorities ?? [],
      firstOpenedAt: g.first_opened_at,
      lastOpenedAt: g.last_opened_at,
      linkedIncidentCount: linkedCount,
      alreadyProblem: Boolean(existing.rows[0]),
      existingProblemId: existing.rows[0]?.id ?? null,
      existingProblemNumber: existing.rows[0]?.problem_number ?? null,
      existingProblemStatus: existing.rows[0]?.status ?? null,
    });
  }

  return {
    windowDays: days,
    minCount,
    items,
    total: items.length,
    suggested: items.filter((x) => !x.alreadyProblem).length,
  };
}

export async function createProblemFromGroup(client: pg.PoolClient, ctx: Ctx, b: CreateProblemInput = {}) {
  const ticketIds = uniq(
    (Array.isArray(b.ticketIds) ? b.ticketIds : []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
  );
  if (!ticketIds.length) throw badRequest('ticketIds is required to raise a problem from a group');

  const scope = await resolveProblemScope(client, ctx);
  if (!scope.canCreate) throw forbidden('You cannot create problems');

  return createProblem(client, ctx, {
    ...b,
    ticketIds,
    linkType: oneOf(b.linkType, PROBLEM_LINK_TYPES) ?? 'MATCHED',
    title: s(b.title) ?? 'Recurring incidents',
  });
}

// ------------------------------------------------------------ known errors

export interface ListKnownErrorsQuery extends Record<string, unknown> {
  problemId?: number;
  status?: string;
  search?: string;
  agentVisibleOnly?: boolean;
  includeArchived?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listKnownErrors(client: pg.PoolClient, ctx: Ctx, q: ListKnownErrorsQuery = {}) {
  const scope = await resolveProblemScope(client, ctx);
  const { page, pageSize: limit, offset } = parsePagination(q as Record<string, unknown>);
  const where: string[] = ['ke.tenant_id = $1', 'ke.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const push = (sql: string, ...values: unknown[]) => {
    const first = params.length + 1;
    for (const v of values) params.push(v);
    where.push(sql.split('?').join('$' + String(first)));
  };

  if (q.problemId) push('ke.problem_id = ?', Number(q.problemId));
  const status = oneOf(q.status, KNOWN_ERROR_STATUSES);
  if (status) push('ke.status = ?', status);
  else if (!truthy(q.includeArchived)) where.push("ke.status <> 'ARCHIVED'");
  if (truthy(q.agentVisibleOnly)) where.push('ke.agent_visible');
  const search = s(q.search);
  if (search) {
    push(
      '(ke.title ILIKE ? OR ke.error_code ILIKE ? OR ke.symptoms ILIKE ? OR ke.workaround ILIKE ?)',
      '%' + search + '%'
    );
  }
  // Employees only see known errors attached to problems that touch their tickets.
  if (!scope.isAgent) {
    const userRef = '$' + String(params.length + 1);
    const empRef = '$' + String(params.length + 2);
    params.push(scope.userId ?? -1, scope.employeeId ?? -1);
    where.push(
      '(EXISTS (SELECT 1 FROM problems p WHERE p.id = ke.problem_id AND p.created_by = ' + userRef + ') ' +
        'OR EXISTS (SELECT 1 FROM problem_incidents pi JOIN service_tickets t ON t.id = pi.ticket_id ' +
        'WHERE pi.problem_id = ke.problem_id AND (t.requester_user_id = ' + userRef +
        ' OR t.requester_employee_id = ' + empRef + ')))'
    );
  }

  const whereSql = where.join(' AND ');
  const totalRes = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM known_errors ke WHERE ' + whereSql,
    params
  );
  const rows = await client.query(
    'SELECT ke.*, p.problem_number, p.title AS problem_title, p.status AS problem_status ' +
      'FROM known_errors ke LEFT JOIN problems p ON p.id = ke.problem_id ' +
      'WHERE ' + whereSql + ' ORDER BY ke.status ASC, ke.id DESC LIMIT ' + String(limit) +
      ' OFFSET ' + String(offset),
    params
  );
  return paged(rows.rows, Number(totalRes.rows[0]?.count ?? 0), page, limit, offset);
}

export async function getKnownError(client: pg.PoolClient, ctx: Ctx, id: number) {
  const scope = await resolveProblemScope(client, ctx);
  const res = await client.query(
    'SELECT ke.*, p.problem_number, p.title AS problem_title, p.status AS problem_status, ' +
      "cu.first_name || ' ' || cu.last_name AS created_by_name " +
      'FROM known_errors ke LEFT JOIN problems p ON p.id = ke.problem_id ' +
      'LEFT JOIN users cu ON cu.id = ke.created_by ' +
      'WHERE ke.id = $1 AND ke.tenant_id = $2 AND ke.company_id = $3',
    [id, ctx.tenantId, ctx.companyId]
  );
  const row = requireRow(res.rows[0], 'Known error not found');
  if (!scope.isAgent) {
    const reach = await client.query<{ ok: boolean }>(
      'SELECT true AS ok FROM problems p WHERE p.id = $1 AND p.created_by = $2 LIMIT 1',
      [row.problem_id, scope.userId ?? -1]
    );
    if (!reach.rows.length) throw forbidden('This known error is outside your service desk scope');
  }
  return row;
}

async function nextKnownErrorCode(client: pg.PoolClient, ctx: Ctx, base: string): Promise<string> {
  let candidate = base;
  for (let i = 1; i <= 50; i += 1) {
    const dup = await client.query('SELECT 1 FROM known_errors WHERE company_id = $1 AND error_code = $2 LIMIT 1', [
      ctx.companyId,
      candidate,
    ]);
    if (!dup.rows.length) return candidate;
    candidate = base + '-' + String(i + 1);
  }
  throw conflict('Could not allocate a unique known error code');
}

export async function createKnownError(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown> = {}) {
  const problemId = n(b.problemId);
  if (!problemId) throw badRequest('problemId is required');
  const { problem, scope } = await problemActionContext(client, ctx, problemId, 'update');
  if (!scope.canManageKnownErrors && !scope.canInvestigate) throw forbidden('You cannot record known errors');

  const title = s(b.title) ?? problem.title;
  const workaround = s(b.workaround) ?? problem.workaround;
  const errorCode =
    s(b.errorCode) ?? (await nextKnownErrorCode(client, ctx, 'KE-' + problem.problem_number));

  const ins = await client.query<{ id: number }>(
    'INSERT INTO known_errors ' +
      '(tenant_id, company_id, problem_id, error_code, title, symptoms, workaround, status, agent_visible, ' +
      'created_by, updated_by) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9,$9) RETURNING id",
    [
      ctx.tenantId,
      ctx.companyId,
      problem.id,
      errorCode,
      title,
      s(b.symptoms) ?? problem.description ?? null,
      workaround,
      truthy(b.agentVisible) === false ? false : true,
      ctx.userId ?? null,
    ]
  );
  const id = ins.rows[0].id;

  if (!problem.workaround && workaround) {
    await client.query('UPDATE problems SET workaround = $2, updated_at = now() WHERE id = $1', [problem.id, workaround]);
  }

  await logAudit(client, ctx, {
    action: 'create',
    resource: 'known_errors',
    recordId: id,
    recordCode: errorCode,
    newValues: { problem_id: problem.id, title, error_code: errorCode },
  });
  await emitEvent(client, ctx, {
    eventType: 'service_desk.known_error.created',
    entityType: 'known_error',
    entityId: id,
    entityCode: errorCode,
    payload: { problem_id: problem.id, problem_number: problem.problem_number, title },
    severity: 'WARN',
  });
  return getKnownError(client, ctx, id);
}

export async function updateKnownError(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  b: Record<string, unknown> = {}
) {
  const existing = await client.query<{ problem_id: number; error_code: string | null }>(
    'SELECT problem_id, error_code FROM known_errors WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    [id, ctx.tenantId, ctx.companyId]
  );
  const row = requireRow(existing.rows[0], 'Known error not found');
  const { scope } = await problemActionContext(client, ctx, row.problem_id, 'update');
  if (!scope.canManageKnownErrors && !scope.canInvestigate) throw forbidden('You cannot update known errors');

  const sets: string[] = ['updated_by = $4'];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId, ctx.userId ?? null];
  const assign = (col: string, val: unknown) => {
    params.push(val);
    sets.push(col + ' = $' + String(params.length));
  };
  const title = s(b.title);
  if (title) assign('title', title);
  if (b.symptoms !== undefined) assign('symptoms', s(b.symptoms) ?? null);
  if (b.workaround !== undefined) assign('workaround', s(b.workaround) ?? null);
  if (b.agentVisible !== undefined) assign('agent_visible', truthy(b.agentVisible));
  const status = oneOf(b.status, KNOWN_ERROR_STATUSES);
  if (status) {
    assign('status', status);
    assign('resolved_at', status === 'RESOLVED' ? new Date().toISOString() : null);
  }

  await client.query(
    'UPDATE known_errors SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    params
  );
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'known_errors',
    recordId: id,
    recordCode: row.error_code,
    newValues: { ...b },
  });
  await emitEvent(client, ctx, {
    eventType: 'service_desk.known_error.updated',
    entityType: 'known_error',
    entityId: id,
    entityCode: row.error_code,
    payload: { changed: Object.keys(b) },
  });
  return getKnownError(client, ctx, id);
}

export async function archiveKnownError(client: pg.PoolClient, ctx: Ctx, id: number) {
  return updateKnownError(client, ctx, id, { status: 'ARCHIVED' });
}

// ------------------------------------------------------------ root cause analysis

const RCA_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['IN_REVIEW'],
  IN_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['IN_REVIEW'],
  REJECTED: ['DRAFT', 'IN_REVIEW'],
};

function assertRcaTransition(from: string, to: string): void {
  const allowed = RCA_TRANSITIONS[from];
  if (!allowed) throw conflict('Unknown root cause analysis status: ' + from);
  if (from === to) return;
  if (!allowed.includes(to)) throw conflict('Root cause analysis cannot move from ' + from + ' to ' + to);
}

interface RcaRow {
  id: number;
  problem_id: number;
  method: string;
  root_cause: string | null;
  status: string;
  created_by: number | null;
  problem_number?: string;
}

async function loadRca(client: pg.PoolClient, ctx: Ctx, id: number): Promise<RcaRow> {
  const res = await client.query<RcaRow>(
    'SELECT r.*, p.problem_number, p.created_by AS problem_created_by FROM root_cause_analyses r ' +
      'JOIN problems p ON p.id = r.problem_id ' +
      'WHERE r.id = $1 AND r.tenant_id = $2 AND r.company_id = $3',
    [id, ctx.tenantId, ctx.companyId]
  );
  return requireRow(res.rows[0], 'Root cause analysis not found');
}

export async function listRcasForProblem(client: pg.PoolClient, ctx: Ctx, problemRef: number | string) {
  const { problem } = await problemActionContext(client, ctx, problemRef, 'view');
  const res = await client.query(
    'SELECT r.*, ' +
      "cu.first_name || ' ' || cu.last_name AS created_by_name, " +
      "au.first_name || ' ' || au.last_name AS approved_by_name " +
      'FROM root_cause_analyses r ' +
      'LEFT JOIN users cu ON cu.id = r.created_by ' +
      'LEFT JOIN users au ON au.id = r.approved_by ' +
      'WHERE r.problem_id = $1 ORDER BY r.created_at DESC',
    [problem.id]
  );
  return { items: res.rows, total: res.rows.length, problemId: problem.id };
}

export async function getRca(client: pg.PoolClient, ctx: Ctx, id: number) {
  const rca = await loadRca(client, ctx, id);
  await problemActionContext(client, ctx, rca.problem_id, 'view');
  const res = await client.query(
    'SELECT r.*, ' +
      "cu.first_name || ' ' || cu.last_name AS created_by_name, " +
      "au.first_name || ' ' || au.last_name AS approved_by_name " +
      'FROM root_cause_analyses r ' +
      'LEFT JOIN users cu ON cu.id = r.created_by ' +
      'LEFT JOIN users au ON au.id = r.approved_by WHERE r.id = $1',
    [id]
  );
  return res.rows[0];
}

export async function createRca(
  client: pg.PoolClient,
  ctx: Ctx,
  problemRef: number | string,
  b: Record<string, unknown> = {}
) {
  const { problem, scope } = await problemActionContext(client, ctx, problemRef, 'investigate');
  if (!scope.canInvestigate) throw forbidden('You cannot investigate problems');

  const method = oneOf(b.method, RCA_METHODS) ?? 'FIVE_WHYS';
  const rootCause = s(b.rootCause) ?? null;

  const ins = await client.query<{ id: number }>(
    'INSERT INTO root_cause_analyses ' +
      '(tenant_id, company_id, problem_id, method, incident_timeline, root_cause, contributing_factors, ' +
      'detection_gap, corrective_actions, preventive_actions, recommendation, status, created_by, updated_by) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DRAFT',$12,$12) RETURNING id",
    [
      ctx.tenantId,
      ctx.companyId,
      problem.id,
      method,
      s(b.incidentTimeline) ?? null,
      rootCause,
      s(b.contributingFactors) ?? null,
      s(b.detectionGap) ?? null,
      s(b.correctiveActions) ?? null,
      s(b.preventiveActions) ?? null,
      s(b.recommendation) ?? null,
      ctx.userId ?? null,
    ]
  );
  const id = ins.rows[0].id;

  await logAudit(client, ctx, {
    action: 'create',
    resource: 'root_cause_analyses',
    recordId: id,
    recordCode: problem.problem_number,
    newValues: { problem_id: problem.id, method },
  });
  await emitEvent(client, ctx, {
    eventType: 'service_desk.rca.created',
    entityType: 'root_cause_analysis',
    entityId: id,
    entityCode: problem.problem_number,
    payload: { problem_id: problem.id, method },
  });
  return getRca(client, ctx, id);
}

export async function updateRca(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown> = {}) {
  const rca = await loadRca(client, ctx, id);
  const { scope } = await problemActionContext(client, ctx, rca.problem_id, 'investigate');
  if (!scope.canInvestigate) throw forbidden('You cannot investigate problems');
  if (rca.status !== 'DRAFT' && !scope.isAdmin && !scope.canApproveRca) {
    throw conflict('Only a draft root cause analysis can be edited');
  }

  const sets: string[] = ['updated_by = $4'];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId, ctx.userId ?? null];
  const assign = (col: string, val: unknown) => {
    params.push(val);
    sets.push(col + ' = $' + String(params.length));
  };
  const method = oneOf(b.method, RCA_METHODS);
  if (method) assign('method', method);
  const textFields: Array<[string, string]> = [
    ['incident_timeline', 'incidentTimeline'],
    ['root_cause', 'rootCause'],
    ['contributing_factors', 'contributingFactors'],
    ['detection_gap', 'detectionGap'],
    ['corrective_actions', 'correctiveActions'],
    ['preventive_actions', 'preventiveActions'],
    ['recommendation', 'recommendation'],
  ];
  for (const [col, key] of textFields) {
    if (b[key] !== undefined) assign(col, s(b[key]) ?? null);
  }

  await client.query(
    'UPDATE root_cause_analyses SET ' + sets.join(', ') + ', updated_at = now() ' +
      'WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    params
  );
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'root_cause_analyses',
    recordId: id,
    recordCode: rca.problem_number ?? null,
    newValues: { ...b },
  });
  return getRca(client, ctx, id);
}

export async function submitRca(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown> = {}) {
  const rca = await loadRca(client, ctx, id);
  const { scope } = await problemActionContext(client, ctx, rca.problem_id, 'investigate');
  if (!scope.canInvestigate) throw forbidden('You cannot investigate problems');
  assertRcaTransition(rca.status, 'IN_REVIEW');
  if (rca.status === 'REJECTED') assertRcaTransition('REJECTED', 'IN_REVIEW');

  await client.query(
    "UPDATE root_cause_analyses SET status = 'IN_REVIEW', updated_by = $2, updated_at = now() WHERE id = $1",
    [id, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'submit',
    resource: 'root_cause_analyses',
    recordId: id,
    recordCode: rca.problem_number ?? null,
    oldValues: { status: rca.status },
    newValues: { status: 'IN_REVIEW', note: s(b.note ?? b.comment) ?? null },
  });
  await emitEvent(client, ctx, {
    eventType: 'service_desk.rca.submitted',
    entityType: 'root_cause_analysis',
    entityId: id,
    entityCode: rca.problem_number ?? null,
    payload: { problem_id: rca.problem_id },
  });

  const approvers = await usersWithPermission(client, ctx, 'service_desk.problems.resolve');
  await notifyUsers(client, ctx, approvers, {
    type: 'service_desk.rca.submitted',
    title: 'Root cause analysis awaiting approval: ' + (rca.problem_number ?? String(rca.problem_id)),
    body: s(b.note),
    link: '/service-desk/problems/' + rca.problem_id,
    entityType: 'root_cause_analysis',
    entityId: id,
  });
  return getRca(client, ctx, id);
}

/**
 * Approve or reject an investigation. Segregation of duties is enforced here as
 * well as in ABAC: the person who wrote the analysis cannot approve it, which is
 * exactly the ABAC-NO-SELF-APPROVE condition (owner_user_id == subject.id).
 */
export async function reviewRca(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown> = {}) {
  const rca = await loadRca(client, ctx, id);
  const { problem, scope } = await problemActionContext(client, ctx, rca.problem_id, 'approve');
  if (!scope.canApproveRca) throw forbidden('You cannot approve root cause analyses');

  ctx.resourceAttributes = {
    ...(ctx.resourceAttributes ?? {}),
    module: 'service_desk',
    resource: 'root_cause_analyses',
    action: 'approve',
    rca_id: id,
    owner_user_id: rca.created_by,
    service_desk_agent: scope.isAgent,
    service_desk_internal_notes: scope.canViewInternalNotes,
    service_desk_readonly: false,
    classified_denied: false,
  };

  if (!scope.isAdmin && sameId(rca.created_by, ctx.userId)) {
    throw forbidden('You cannot approve a root cause analysis you authored');
  }

  const approve = b.approve === undefined ? true : truthy(b.approve);
  const to = approve ? 'APPROVED' : 'REJECTED';
  assertRcaTransition(rca.status, to);

  await client.query(
    'UPDATE root_cause_analyses SET status = $2, approved_by = $3, approved_at = now(), ' +
      'updated_by = $3, updated_at = now() WHERE id = $1',
    [id, to, ctx.userId ?? null]
  );

  if (approve && s(rca.root_cause)) {
    // An approved investigation is authoritative: record it on the problem and
    // move the problem forward if it has not already been.
    if (problem.status === 'NEW' || problem.status === 'INVESTIGATING') {
      await applyProblemStatus(client, ctx, problem.id, 'ROOT_CAUSE_IDENTIFIED', {
        note: s(rca.root_cause),
        eventType: 'service_desk.problem.root_cause_identified',
        extraSets: { root_cause: s(rca.root_cause) ?? null },
      });
    } else if (!problem.root_cause) {
      await client.query('UPDATE problems SET root_cause = $2, updated_at = now() WHERE id = $1', [
        problem.id,
        s(rca.root_cause) ?? null,
      ]);
    }
  }

  await logAudit(client, ctx, {
    action: approve ? 'approve' : 'reject',
    resource: 'root_cause_analyses',
    recordId: id,
    recordCode: rca.problem_number ?? null,
    oldValues: { status: rca.status },
    newValues: { status: to, comments: s(b.comments ?? b.note) ?? null },
  });
  await emitEvent(client, ctx, {
    eventType: approve ? 'service_desk.rca.approved' : 'service_desk.rca.rejected',
    entityType: 'root_cause_analysis',
    entityId: id,
    entityCode: rca.problem_number ?? null,
    payload: { problem_id: problem.id, status: to },
    severity: approve ? 'INFO' : 'WARN',
  });
  await notifyUsers(client, ctx, [rca.created_by], {
    type: approve ? 'service_desk.rca.approved' : 'service_desk.rca.rejected',
    title: (approve ? 'Root cause analysis approved: ' : 'Root cause analysis rejected: ') +
      (rca.problem_number ?? String(problem.id)),
    body: s(b.comments ?? b.note),
    link: '/service-desk/problems/' + problem.id,
    entityType: 'root_cause_analysis',
    entityId: id,
    severity: approve ? 'SUCCESS' : 'WARN',
  });
  return getRca(client, ctx, id);
}

// ------------------------------------------------------------ dashboard

export async function problemDashboard(client: pg.PoolClient, ctx: Ctx) {
  const scope = await resolveProblemScope(client, ctx);
  const base = [ctx.tenantId, ctx.companyId];

  const byStatus = await client.query<{ status: string; count: string }>(
    'SELECT status, count(*)::text AS count FROM problems WHERE tenant_id = $1 AND company_id = $2 GROUP BY status',
    base
  );
  const byPriority = await client.query<{ priority: string; count: string }>(
    "SELECT priority, count(*)::text AS count FROM problems WHERE tenant_id = $1 AND company_id = $2 " +
      "AND status NOT IN ('CLOSED','CANCELLED') GROUP BY priority ORDER BY priority",
    base
  );
  const knownErrors = await client.query<{ status: string; count: string }>(
    'SELECT status, count(*)::text AS count FROM known_errors WHERE tenant_id = $1 AND company_id = $2 GROUP BY status',
    base
  );
  const unassigned = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM problems WHERE tenant_id = $1 AND company_id = $2 ' +
      "AND assigned_to_user_id IS NULL AND status NOT IN ('CLOSED','CANCELLED')",
    base
  );
  const recurring = await client.query(
    'SELECT p.id, p.problem_number, p.title, p.priority, p.status, p.incident_count, p.created_at, ' +
      'c.name AS category_name ' +
      'FROM problems p LEFT JOIN service_categories c ON c.id = p.category_id ' +
      'WHERE p.tenant_id = $1 AND p.company_id = $2 ' +
      "AND p.status NOT IN ('CLOSED','CANCELLED') ORDER BY p.incident_count DESC, p.created_at DESC LIMIT 10",
    base
  );
  const ageing = await client.query<{ avg_days: string | null }>(
    "SELECT round(avg(EXTRACT(EPOCH FROM (COALESCE(resolved_at, now()) - created_at)) / 86400)::numeric, 1)::text AS avg_days " +
      'FROM problems WHERE tenant_id = $1 AND company_id = $2',
    base
  );
  const mine = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM problems WHERE tenant_id = $1 AND company_id = $2 ' +
      "AND assigned_to_user_id = $3 AND status NOT IN ('CLOSED','CANCELLED')",
    [ctx.tenantId, ctx.companyId, scope.userId ?? -1]
  );

  const counts = (rows: Array<{ status: string; count: string }>) => {
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.count);
    return out;
  };

  const statusCounts = counts(byStatus.rows);
  const openProblems =
    (statusCounts.NEW ?? 0) +
    (statusCounts.INVESTIGATING ?? 0) +
    (statusCounts.ROOT_CAUSE_IDENTIFIED ?? 0) +
    (statusCounts.KNOWN_ERROR ?? 0) +
    (statusCounts.RESOLVED ?? 0);

  return {
    openProblems,
    resolvedAwaitingClosure: statusCounts.RESOLVED ?? 0,
    closedProblems: statusCounts.CLOSED ?? 0,
    cancelledProblems: statusCounts.CANCELLED ?? 0,
    knownErrors: counts(knownErrors.rows),
    activeKnownErrors:
      (counts(knownErrors.rows).ACTIVE ?? 0) + (counts(knownErrors.rows).FIX_PENDING ?? 0),
    unassignedProblems: Number(unassigned.rows[0]?.count ?? 0),
    myProblems: Number(mine.rows[0]?.count ?? 0),
    averageDaysToResolution: ageing.rows[0]?.avg_days ? Number(ageing.rows[0].avg_days) : null,
    byStatus: statusCounts,
    byPriority: Object.fromEntries(byPriority.rows.map((r) => [r.priority, Number(r.count)])),
    recurringProblems: recurring.rows,
    scope: {
      isAgent: scope.isAgent,
      isAdmin: scope.isAdmin,
      canCreate: scope.canCreate,
      canInvestigate: scope.canInvestigate,
    },
  };
}
