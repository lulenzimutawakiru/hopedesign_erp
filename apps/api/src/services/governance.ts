import pg from 'pg';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Ctx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../utils.js';
import { toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';
import { notifyUsers } from './communication.js';

// Roles with full governance administration authority. The System
// Administrator is intentionally absent: technical staff receive traceability
// (view/verify) but never business approval or signing authority.
const GOVERNANCE_ADMIN_ROLES = new Set([
  'super_administrator',
  'managing_director',
  'ceo',
  'executive_director',
  'general_manager',
  'hr_director',
  'hr_manager',
  'security_administrator',
]);

const DELEGATION_EDITABLE = new Set(['DRAFT', 'PENDING_APPROVAL']);

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);
const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeVerifyToken(): { token: string; hash: string } {
  const token = randomBytes(18).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

function makeVerificationCode(): string {
  return 'VER-' + randomBytes(6).toString('hex').toUpperCase();
}

async function userRoleCodes(client: pg.PoolClient, ctx: Ctx, userId: number): Promise<string[]> {
  if (!userId) return [];
  const { rows } = await client.query(
    'SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id' +
      ' WHERE ur.user_id = $1 AND r.tenant_id = $2',
    [userId, ctx.tenantId]
  );
  return rows.map((r) => String(r.code));
}

async function isGovernanceAdmin(client: pg.PoolClient, ctx: Ctx): Promise<boolean> {
  const codes = await userRoleCodes(client, ctx, ctx.userId ?? 0);
  return codes.some((c) => GOVERNANCE_ADMIN_ROLES.has(c));
}

async function userMeta(client: pg.PoolClient, ctx: Ctx, userId: number): Promise<{
  id: number; first_name: string; last_name: string; email: string; employee_id: number | null;
}> {
  const { rows } = await client.query(
    'SELECT id, first_name, last_name, email, employee_id FROM users' +
      ' WHERE id = $1 AND tenant_id = $2',
    [userId, ctx.tenantId]
  );
  if (rows.length === 0) throw badRequest('User ' + userId + ' not found or not in tenant');
  return rows[0];
}

async function roleMeta(client: pg.PoolClient, ctx: Ctx, roleId: number): Promise<{
  id: number; code: string; name: string;
}> {
  const { rows } = await client.query(
    'SELECT id, code, name FROM roles WHERE id = $1 AND tenant_id = $2',
    [roleId, ctx.tenantId]
  );
  if (rows.length === 0) throw badRequest('Role ' + roleId + ' not found or not in tenant');
  return rows[0];
}

async function getDelegation(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  opts: { forUpdate?: boolean; expected?: string } = {}
) {
  const lock = opts.forUpdate ? ' FOR UPDATE' : '';
  const { rows } = await client.query(
    'SELECT d.*,' +
      ' du.first_name AS delegator_first_name, du.last_name AS delegator_last_name,' +
      ' de.first_name AS delegate_first_name, de.last_name AS delegate_last_name,' +
      ' r1.code AS original_role_code, r1.name AS original_role_name,' +
      ' r2.code AS temporary_role_code, r2.name AS temporary_role_name' +
      ' FROM delegations d' +
      ' JOIN users du ON du.id = d.delegator_user_id' +
      ' JOIN users de ON de.id = d.delegate_user_id' +
      ' JOIN roles r1 ON r1.id = d.original_role_id' +
      ' JOIN roles r2 ON r2.id = d.temporary_role_id' +
      ' WHERE d.id = $1 AND d.tenant_id = $2' + lock,
    [id, ctx.tenantId]
  );
  if (rows.length === 0) throw notFound('Delegation not found');
  const d = rows[0];
  if (opts.expected && String(d.status) !== opts.expected) {
    throw badRequest('Delegation must be ' + opts.expected + ' (current: ' + d.status + ')');
  }
  return d;
}

async function getSignatureProfile(client: pg.PoolClient, ctx: Ctx, id: number, forUpdate = false) {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  const { rows } = await client.query(
    'SELECT p.*, u.first_name, u.last_name, u.email, u.employee_id' +
      ' FROM signature_profiles p JOIN users u ON u.id = p.user_id' +
      ' WHERE p.id = $1 AND p.tenant_id = $2' + lock,
    [id, ctx.tenantId]
  );
  if (rows.length === 0) throw notFound('Signature profile not found');
  return rows[0];
}

async function ownerOrAdmin(
  client: pg.PoolClient,
  ctx: Ctx,
  rowUserId: number,
  label = 'record'
): Promise<void> {
  const admin = await isGovernanceAdmin(client, ctx);
  if (Number(rowUserId) !== ctx.userId && !admin) {
    throw forbidden('Only the owner or a governance administrator can modify this ' + label);
  }
}

async function audit(
  client: pg.PoolClient,
  ctx: Ctx,
  entry: {
    action: string; resource: string; recordId: number; recordCode?: string | null;
    oldValues?: Record<string, unknown>; newValues?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await logAudit(client, ctx, {
    action: entry.action,
    resource: entry.resource,
    recordId: entry.recordId,
    recordCode: entry.recordCode ?? null,
    oldValues: entry.oldValues ?? null,
    newValues: entry.newValues ?? null,
    metadata: entry.metadata ?? {},
  });
}

async function notify(
  client: pg.PoolClient,
  ctx: Ctx,
  userIds: number[],
  input: {
    type: string; title: string; body?: string; link?: string;
    priority?: string; severity?: string; data?: Record<string, unknown>;
  }
): Promise<void> {
  const ids = userIds.filter((n) => Number.isFinite(n) && n > 0 && n !== ctx.userId);
  if (ids.length === 0) return;
  await notifyUsers(
    client,
    ctx,
    {
      type: input.type,
      title: input.title,
      body: input.body ?? '',
      link: input.link ?? '',
      severity: (input.severity as 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR') ?? 'INFO',
      priority: (input.priority as 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | 'CRITICAL') ?? 'NORMAL',
      actionLabel: 'Review',
      actionTarget: input.link ?? '',
      channels: ['IN_APP'],
      data: input.data ?? {},
    },
    ids
  );
}

function withinWindow(start: Date, end: Date | null): boolean {
  const now = Date.now();
  return start.getTime() <= now && (end === null || end.getTime() > now);
}

// ===========================================================================
// Delegation & acting authority
// ===========================================================================

const DELEGATION_JOIN =
  ' du.first_name AS delegator_first_name, du.last_name AS delegator_last_name,' +
  ' de.first_name AS delegate_first_name, de.last_name AS delegate_last_name,' +
  ' r1.code AS original_role_code, r1.name AS original_role_name,' +
  ' r2.code AS temporary_role_code, r2.name AS temporary_role_name' +
  ' FROM delegations d' +
  ' JOIN users du ON du.id = d.delegator_user_id' +
  ' JOIN users de ON de.id = d.delegate_user_id' +
  ' JOIN roles r1 ON r1.id = d.original_role_id' +
  ' JOIN roles r2 ON r2.id = d.temporary_role_id';

export async function listDelegations(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { status?: string | null; mine?: boolean } = {}
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [ctx.tenantId];
  const conds = ['d.tenant_id = $1'];
  let i = 2;
  if (opts.status) { conds.push('d.status = $' + i); params.push(opts.status); i += 1; }
  if (ctx.companyId) { conds.push('d.company_id = $' + i); params.push(ctx.companyId); i += 1; }
  if (opts.mine) {
    conds.push('(d.delegator_user_id = $' + i + ' OR d.delegate_user_id = $' + i + ')');
    params.push(ctx.userId);
    i += 1;
  }
  const { rows } = await client.query(
    'SELECT d.*,' + DELEGATION_JOIN +
      ' WHERE ' + conds.join(' AND ') + ' ORDER BY d.id DESC LIMIT 200',
    params
  );
  return toCamelRows(rows);
}

export async function getDelegationDetail(client: pg.PoolClient, ctx: Ctx, id: number) {
  const d = await getDelegation(client, ctx, id);
  const [authRes, histRes] = await Promise.all([
    client.query(
      'SELECT * FROM delegation_authorities WHERE delegation_id = $1 AND tenant_id = $2' +
        ' ORDER BY transaction_type',
      [id, ctx.tenantId]
    ),
    client.query(
      'SELECT * FROM delegation_status_history WHERE delegation_id = $1 AND tenant_id = $2' +
        ' ORDER BY created_at DESC, id DESC LIMIT 100',
      [id, ctx.tenantId]
    ),
  ]);
  return {
    delegation: toCamelRow(d),
    authorities: toCamelRows(authRes.rows),
    history: toCamelRows(histRes.rows),
  };
}

async function defaultCompanyId(client: pg.PoolClient, ctx: Ctx): Promise<number | null> {
  if (ctx.companyId) return ctx.companyId;
  const { rows } = await client.query(
    'SELECT id FROM companies WHERE tenant_id = $1 AND code = $2',
    [ctx.tenantId, 'HDG']
  );
  return rows.length ? Number(rows[0].id) : null;
}

async function resolveWindow(startsAt: unknown, expiresAt: unknown): Promise<{ starts: Date; expires: Date }> {
  const starts = new Date(str(startsAt) ?? '');
  const expires = new Date(str(expiresAt) ?? '');
  if (Number.isNaN(starts.getTime()) || Number.isNaN(expires.getTime())) {
    throw badRequest('startsAt and expiresAt must be valid ISO timestamps');
  }
  if (expires.getTime() <= starts.getTime()) throw badRequest('expiresAt must be after startsAt');
  return { starts, expires };
}

export async function createDelegation(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
) {
  const delegateUserId = num(body.delegateUserId);
  const originalRoleId = num(body.originalRoleId);
  const temporaryRoleId = num(body.temporaryRoleId);
  if (!delegateUserId || !originalRoleId || !temporaryRoleId) {
    throw badRequest('delegateUserId, originalRoleId and temporaryRoleId are required');
  }
  if (delegateUserId === ctx.userId) throw badRequest('A user cannot delegate to themselves');
  if (originalRoleId === temporaryRoleId) {
    throw badRequest('The temporary role must differ from the original role');
  }
  const reason = str(body.reason);
  if (!reason || reason.trim().length === 0) throw badRequest('A delegation reason is required');
  const companyId = (await defaultCompanyId(client, ctx)) ?? num(body.companyId);
  if (!companyId) throw badRequest('A company scope is required for the delegation');
  const { starts, expires } = await resolveWindow(body.startsAt, body.expiresAt);
  await roleMeta(client, ctx, originalRoleId);
  await roleMeta(client, ctx, temporaryRoleId);
  await userMeta(client, ctx, delegateUserId);
  const scope = body.scope && typeof body.scope === 'object' ? body.scope : {};
  const { rows } = await client.query(
    'INSERT INTO delegations' +
      ' (tenant_id, company_id, branch_id, department_id, delegator_user_id, delegate_user_id,' +
      '  original_role_id, temporary_role_id, reason, scope, approval_limit,' +
      '  starts_at, expires_at, status, created_by, updated_by)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)' +
      ' RETURNING *',
    [
      ctx.tenantId, companyId, num(body.branchId), num(body.departmentId),
      ctx.userId, delegateUserId, originalRoleId, temporaryRoleId, reason,
      JSON.stringify(scope), num(body.approvalLimit), starts, expires, 'DRAFT', ctx.userId,
    ]
  );
  const d = rows[0];
  await audit(client, ctx, {
    action: 'create', resource: 'governance.delegation', recordId: Number(d.id),
    recordCode: String(d.code), newValues: toCamelRow(d) as Record<string, unknown>,
  });
  const created = await getDelegation(client, ctx, Number(d.id));
  return toCamelRow(created);
}

export async function updateDelegation(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const d = await getDelegation(client, ctx, id, { forUpdate: true, expected: 'DRAFT' });
  await ownerOrAdmin(client, ctx, Number(d.delegator_user_id), 'delegation');
  const before = toCamelRow(d);
  const fields: string[] = [];
  const vals: unknown[] = [Number(d.id)];
  const push = (col: string, val: unknown) => {
    if (val !== undefined) { fields.push(col + ' = $' + (fields.length + 2)); vals.push(val); }
  };
  push('branch_id', num(body.branchId));
  push('department_id', num(body.departmentId));
  push('reason', str(body.reason));
  push('approval_limit', num(body.approvalLimit));
  if (body.scope && typeof body.scope === 'object') push('scope', JSON.stringify(body.scope));
  if (body.startsAt || body.expiresAt) {
    const cur = await client.query(
      'SELECT starts_at, expires_at FROM delegations WHERE id = $1', [Number(d.id)]
    );
    const merged = await resolveWindow(
      body.startsAt ?? cur.rows[0].starts_at,
      body.expiresAt ?? cur.rows[0].expires_at
    );
    push('starts_at', merged.starts);
    push('expires_at', merged.expires);
  }
  if (fields.length === 0) throw badRequest('Nothing to update');
  fields.push('updated_by = $' + (fields.length + 2));
  vals.push(ctx.userId);
  const { rows } = await client.query(
    'UPDATE delegations SET ' + fields.join(', ') + ' WHERE id = $1 RETURNING *',
    vals
  );
  const after = toCamelRow(rows[0]);
  await audit(client, ctx, {
    action: 'update', resource: 'governance.delegation', recordId: Number(d.id),
    recordCode: String(d.code), oldValues: before, newValues: after,
  });
  return after;
}

async function applyDelegationStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  opts: {
    from: string[];
    to: string;
    reason?: string | null;
    fields?: Record<string, unknown>;
    auditAction: string;
  }
) {
  const d = await getDelegation(client, ctx, id, { forUpdate: true });
  if (!opts.from.includes(String(d.status))) {
    throw conflict('Delegation ' + d.code + ' cannot move from ' + d.status + ' to ' + opts.to);
  }
  const fromStatus = String(d.status);
  const sets = ['status = $1', 'updated_at = now()', 'updated_by = $2'];
  const vals: unknown[] = [opts.to, ctx.userId];
  const fields = opts.fields ?? {};
  Object.keys(fields).forEach((k) => {
    sets.push(k + ' = $' + (vals.length + 1));
    vals.push(fields[k]);
  });
  await client.query(
    'UPDATE delegations SET ' + sets.join(', ') + ' WHERE id = $' + (vals.length + 1),
    [...vals, Number(d.id)]
  );
  await client.query(
    'INSERT INTO delegation_status_history' +
      ' (tenant_id, company_id, delegation_id, from_status, to_status, changed_by, reason, metadata)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      ctx.tenantId, d.company_id, Number(d.id), fromStatus, opts.to, ctx.userId,
      opts.reason ?? null, JSON.stringify({}),
    ]
  );
  const fresh = await getDelegation(client, ctx, Number(d.id));
  await audit(client, ctx, {
    action: opts.auditAction, resource: 'governance.delegation', recordId: Number(d.id),
    recordCode: String(d.code), oldValues: { status: fromStatus },
    newValues: { status: opts.to, reason: opts.reason ?? null },
    metadata: { fromStatus, toStatus: opts.to },
  });
  return fresh;
}

async function userIdsWithPermission(client: pg.PoolClient, ctx: Ctx, permissionCode: string): Promise<number[]> {
  const { rows } = await client.query(
    'SELECT DISTINCT ur.user_id AS id FROM user_roles ur' +
      ' JOIN role_permissions rp ON rp.role_id = ur.role_id' +
      ' JOIN permissions p ON p.id = rp.permission_id' +
      ' JOIN roles r ON r.id = ur.role_id' +
      ' WHERE p.code = $1 AND r.tenant_id = $2',
    [permissionCode, ctx.tenantId]
  );
  return rows.map((x) => Number(x.id));
}

export async function submitDelegation(client: pg.PoolClient, ctx: Ctx, id: number, reason?: string | null) {
  const d = await getDelegation(client, ctx, id);
  await ownerOrAdmin(client, ctx, Number(d.delegator_user_id), 'delegation');
  const fresh = await applyDelegationStatus(client, ctx, id, {
    from: ['DRAFT'],
    to: 'PENDING_APPROVAL',
    reason: reason ?? 'Submitted for approval',
    auditAction: 'submit',
  });
  const approvers = await userIdsWithPermission(client, ctx, 'governance.delegations.approve');
  await notify(client, ctx, approvers, {
    type: 'governance.delegation.submitted',
    title: 'Delegation submitted for approval',
    body: fresh.delegator_first_name + ' ' + fresh.delegator_last_name +
      ' delegated ' + fresh.temporary_role_name + ' to ' + fresh.delegate_first_name + ' ' +
      fresh.delegate_last_name + ' (' + fresh.code + ').',
    link: '/admin/delegations/' + Number(d.id),
    priority: 'HIGH',
    severity: 'INFO',
    data: { delegationCode: fresh.code, delegateUserId: Number(d.delegate_user_id) },
  });
  return toCamelRow(fresh);
}

export async function approveDelegation(client: pg.PoolClient, ctx: Ctx, id: number, reason?: string | null) {
  const d = await getDelegation(client, ctx, id, { forUpdate: true });
  if (Number(d.delegator_user_id) === ctx.userId || Number(d.delegate_user_id) === ctx.userId) {
    throw forbidden('A delegation cannot be approved by its delegator or delegate');
  }
  if (!['PENDING_APPROVAL', 'APPROVED'].includes(String(d.status))) {
    throw conflict('Only a pending or approved delegation can be approved');
  }
  if (new Date(d.expires_at).getTime() <= Date.now()) {
    throw conflict('Delegation window has already ended; create a new delegation');
  }
  const target = withinWindow(new Date(d.starts_at), new Date(d.expires_at)) ? 'ACTIVE' : 'APPROVED';
  const fresh = await applyDelegationStatus(client, ctx, id, {
    from: ['PENDING_APPROVAL', 'APPROVED'],
    to: target,
    reason: reason ?? 'Delegation approved',
    fields: { approver_user_id: ctx.userId, approved_at: new Date() },
    auditAction: 'approve',
  });
  await notify(client, ctx, [Number(d.delegate_user_id)], {
    type: 'governance.delegation.approved',
    title: target === 'ACTIVE' ? 'Acting authority is now active' : 'Delegation approved',
    body: 'You are acting as ' + fresh.temporary_role_name + ' until ' +
      new Date(d.expires_at).toISOString() + ' (ref ' + fresh.code + ').',
    link: '/admin/delegations/' + Number(d.id),
    priority: 'HIGH',
    severity: 'SUCCESS',
    data: { delegationCode: fresh.code, actingRole: fresh.temporary_role_code, expiresAt: d.expires_at },
  });
  return toCamelRow(fresh);
}

export async function rejectDelegation(client: pg.PoolClient, ctx: Ctx, id: number, reason?: string | null) {
  const d = await getDelegation(client, ctx, id);
  if (Number(d.delegator_user_id) === ctx.userId) {
    throw forbidden('A delegator cannot reject their own delegation');
  }
  const fresh = await applyDelegationStatus(client, ctx, id, {
    from: ['PENDING_APPROVAL'],
    to: 'REJECTED',
    reason: reason ?? 'Rejected',
    fields: { rejected_by: ctx.userId, rejected_at: new Date(), rejected_reason: reason ?? null },
    auditAction: 'reject',
  });
  await notify(client, ctx, [Number(d.delegator_user_id)], {
    type: 'governance.delegation.rejected',
    title: 'Delegation rejected',
    body: 'Your delegation ' + fresh.code + ' was rejected' + (reason ? ': ' + reason : '.'),
    link: '/admin/delegations/' + Number(d.id),
    severity: 'ERROR',
  });
  return toCamelRow(fresh);
}

export async function suspendDelegation(client: pg.PoolClient, ctx: Ctx, id: number, reason?: string | null) {
  const d = await getDelegation(client, ctx, id);
  await ownerOrAdmin(client, ctx, Number(d.delegator_user_id), 'delegation');
  const fresh = await applyDelegationStatus(client, ctx, id, {
    from: ['ACTIVE'],
    to: 'SUSPENDED',
    reason: reason ?? 'Suspended',
    fields: { suspended_by: ctx.userId, suspended_at: new Date(), suspended_reason: reason ?? null },
    auditAction: 'suspend',
  });
  await notify(client, ctx, [Number(d.delegate_user_id), Number(d.delegator_user_id)], {
    type: 'governance.delegation.suspended',
    title: 'Acting authority suspended',
    body: 'Delegation ' + fresh.code + ' has been suspended' + (reason ? ': ' + reason : '.'),
    link: '/admin/delegations/' + Number(d.id),
    severity: 'WARN',
  });
  return toCamelRow(fresh);
}

export async function resumeDelegation(client: pg.PoolClient, ctx: Ctx, id: number, reason?: string | null) {
  const d = await getDelegation(client, ctx, id);
  await ownerOrAdmin(client, ctx, Number(d.delegator_user_id), 'delegation');
  if (new Date(d.expires_at).getTime() <= Date.now()) {
    throw conflict('Delegation window has ended; it cannot be resumed');
  }
  const target = withinWindow(new Date(d.starts_at), new Date(d.expires_at)) ? 'ACTIVE' : 'APPROVED';
  const fresh = await applyDelegationStatus(client, ctx, id, {
    from: ['SUSPENDED'],
    to: target,
    reason: reason ?? 'Resumed',
    auditAction: 'resume',
  });
  await notify(client, ctx, [Number(d.delegate_user_id)], {
    type: 'governance.delegation.resumed',
    title: 'Acting authority resumed',
    body: 'Delegation ' + fresh.code + ' is ' + target + ' again.',
    link: '/admin/delegations/' + Number(d.id),
    severity: 'SUCCESS',
  });
  return toCamelRow(fresh);
}

export async function revokeDelegation(client: pg.PoolClient, ctx: Ctx, id: number, reason?: string | null) {
  const d = await getDelegation(client, ctx, id);
  await ownerOrAdmin(client, ctx, Number(d.delegator_user_id), 'delegation');
  const fresh = await applyDelegationStatus(client, ctx, id, {
    from: ['PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'SUSPENDED'],
    to: 'REVOKED',
    reason: reason ?? 'Revoked',
    fields: { revoked_by: ctx.userId, revoked_at: new Date(), revoked_reason: reason ?? null },
    auditAction: 'revoke',
  });
  await notify(client, ctx, [Number(d.delegate_user_id), Number(d.delegator_user_id)], {
    type: 'governance.delegation.revoked',
    title: 'Acting authority revoked',
    body: 'Delegation ' + fresh.code + ' was revoked' + (reason ? ': ' + reason : '.'),
    link: '/admin/delegations/' + Number(d.id),
    severity: 'ERROR',
    priority: 'HIGH',
  });
  return toCamelRow(fresh);
}

export async function expireDelegation(client: pg.PoolClient, ctx: Ctx, id: number, reason?: string | null) {
  const d = await getDelegation(client, ctx, id);
  await ownerOrAdmin(client, ctx, Number(d.delegator_user_id), 'delegation');
  const fresh = await applyDelegationStatus(client, ctx, id, {
    from: ['ACTIVE', 'APPROVED'],
    to: 'EXPIRED',
    reason: reason ?? 'Window closed',
    auditAction: 'expire',
  });
  await notify(client, ctx, [Number(d.delegate_user_id), Number(d.delegator_user_id)], {
    type: 'governance.delegation.expired',
    title: 'Acting authority expired',
    body: 'Delegation ' + fresh.code + ' has expired. Normal authority is restored.',
    link: '/admin/delegations/' + Number(d.id),
    severity: 'INFO',
  });
  return toCamelRow(fresh);
}

export async function cancelDelegation(client: pg.PoolClient, ctx: Ctx, id: number, reason?: string | null) {
  const d = await getDelegation(client, ctx, id);
  await ownerOrAdmin(client, ctx, Number(d.delegator_user_id), 'delegation');
  const fresh = await applyDelegationStatus(client, ctx, id, {
    from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'],
    to: 'CANCELLED',
    reason: reason ?? 'Cancelled',
    auditAction: 'cancel',
  });
  return toCamelRow(fresh);
}

async function editableDelegation(client: pg.PoolClient, ctx: Ctx, delegationId: number) {
  const d = await getDelegation(client, ctx, delegationId, { forUpdate: true });
  if (!DELEGATION_EDITABLE.has(String(d.status))) {
    throw conflict('Authorities can only change while the delegation is DRAFT or PENDING_APPROVAL');
  }
  await ownerOrAdmin(client, ctx, Number(d.delegator_user_id), 'delegation');
  return d;
}

export async function addDelegationAuthority(
  client: pg.PoolClient,
  ctx: Ctx,
  delegationId: number,
  body: Record<string, unknown>
) {
  const d = await editableDelegation(client, ctx, delegationId);
  const transactionType = str(body.transactionType);
  if (!transactionType || transactionType.trim().length === 0) {
    throw badRequest('transactionType is required');
  }
  const type = transactionType.trim().toUpperCase();
  const exists = await client.query(
    'SELECT 1 FROM delegation_authorities WHERE delegation_id = $1 AND transaction_type = $2',
    [delegationId, type]
  );
  if (exists.rows.length > 0) throw conflict('Authority for ' + type + ' already exists');
  const { rows } = await client.query(
    'INSERT INTO delegation_authorities' +
      ' (tenant_id, company_id, delegation_id, transaction_type, can_approve, can_create,' +
      '  max_amount, created_by)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [
      ctx.tenantId, d.company_id, delegationId, type,
      body.canApprove === false || body.canApprove === 'false' ? false : true,
      body.canCreate === true || body.canCreate === 'true' ? true : false,
      num(body.maxAmount), ctx.userId,
    ]
  );
  const a = rows[0];
  await audit(client, ctx, {
    action: 'create', resource: 'governance.delegation_authority', recordId: Number(a.id),
    recordCode: String(d.code), newValues: toCamelRow(a) as Record<string, unknown>,
  });
  return toCamelRow(a);
}

export async function updateDelegationAuthority(
  client: pg.PoolClient,
  ctx: Ctx,
  delegationId: number,
  authorityId: number,
  body: Record<string, unknown>
) {
  const d = await editableDelegation(client, ctx, delegationId);
  const { rows } = await client.query(
    'SELECT * FROM delegation_authorities WHERE id = $1 AND delegation_id = $2 AND tenant_id = $3',
    [authorityId, delegationId, ctx.tenantId]
  );
  if (rows.length === 0) throw notFound('Delegation authority not found');
  const before = toCamelRow(rows[0]);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.canApprove !== undefined) { sets.push('can_approve = $' + (vals.length + 1)); vals.push(body.canApprove === true || body.canApprove === 'true'); }
  if (body.canCreate !== undefined) { sets.push('can_create = $' + (vals.length + 1)); vals.push(body.canCreate === true || body.canCreate === 'true'); }
  if (body.maxAmount !== undefined) { sets.push('max_amount = $' + (vals.length + 1)); vals.push(num(body.maxAmount)); }
  if (sets.length === 0) throw badRequest('Nothing to update');
  const upd = await client.query(
    'UPDATE delegation_authorities SET ' + sets.join(', ') +
      ' WHERE id = $' + (vals.length + 1) + ' RETURNING *',
    [...vals, authorityId]
  );
  const after = toCamelRow(upd.rows[0]);
  await audit(client, ctx, {
    action: 'update', resource: 'governance.delegation_authority', recordId: authorityId,
    recordCode: String(d.code), oldValues: before, newValues: after,
  });
  return after;
}

export async function deleteDelegationAuthority(
  client: pg.PoolClient,
  ctx: Ctx,
  delegationId: number,
  authorityId: number
) {
  const d = await editableDelegation(client, ctx, delegationId);
  const { rows } = await client.query(
    'DELETE FROM delegation_authorities WHERE id = $1 AND delegation_id = $2 AND tenant_id = $3 RETURNING *',
    [authorityId, delegationId, ctx.tenantId]
  );
  if (rows.length === 0) throw notFound('Delegation authority not found');
  await audit(client, ctx, {
    action: 'delete', resource: 'governance.delegation_authority', recordId: authorityId,
    recordCode: String(d.code), oldValues: toCamelRow(rows[0]) as Record<string, unknown>,
  });
  return { deleted: true };
}

export async function listActingRoles(client: pg.PoolClient, ctx: Ctx) {
  const { rows } = await client.query(
    'SELECT d.id, d.code, d.company_id, d.delegator_user_id, d.starts_at, d.expires_at,' +
      ' du.first_name AS delegator_first_name, du.last_name AS delegator_last_name,' +
      ' r.code AS role_code, r.name AS role_name, r.id AS role_id' +
      ' FROM delegations d' +
      ' JOIN users du ON du.id = d.delegator_user_id' +
      ' JOIN roles r ON r.id = d.temporary_role_id' +
      ' WHERE d.tenant_id = $1 AND d.delegate_user_id = $2 AND d.status = $3' +
      '   AND d.starts_at <= now() AND d.expires_at > now()' +
      ' ORDER BY d.expires_at ASC',
    [ctx.tenantId, ctx.userId, 'ACTIVE']
  );
  return toCamelRows(rows);
}

export async function delegationDashboard(client: pg.PoolClient, ctx: Ctx) {
  const params: unknown[] = [ctx.tenantId];
  let companySql = '';
  if (ctx.companyId) { companySql = ' AND company_id = $2'; params.push(ctx.companyId); }
  const { rows } = await client.query(
    'SELECT status, count(*)::int AS total FROM delegations' +
      ' WHERE tenant_id = $1' + companySql + ' GROUP BY status',
    params
  );
  const byStatus: Record<string, number> = {};
  let total = 0;
  let active = 0;
  let pendingApproval = 0;
  for (const r of rows) {
    const st = String(r.status);
    const n = Number(r.total);
    byStatus[st] = n;
    total += n;
    if (st === 'ACTIVE') active += n;
    if (st === 'PENDING_APPROVAL') pendingApproval += n;
  }
  const mineRes = await client.query(
    'SELECT count(*)::int AS total FROM delegations WHERE tenant_id = $1' +
      ' AND (delegator_user_id = $2 OR delegate_user_id = $2)',
    [ctx.tenantId, ctx.userId]
  );
  return {
    total,
    active,
    pendingApproval,
    byStatus,
    mine: Number(mineRes.rows[0]?.total ?? 0),
  };
}

// ===========================================================================
// Digital signature profiles
// ===========================================================================

export async function listSignatureProfiles(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { status?: string | null; userId?: number | null } = {}
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [ctx.tenantId];
  const conds = ['p.tenant_id = $1'];
  let i = 2;
  if (opts.status) { conds.push('p.status = $' + i); params.push(opts.status); i += 1; }
  if (opts.userId) { conds.push('p.user_id = $' + i); params.push(opts.userId); i += 1; }
  if (ctx.companyId) { conds.push('p.company_id = $' + i); params.push(ctx.companyId); i += 1; }
  const { rows } = await client.query(
    'SELECT p.*, u.first_name, u.last_name, u.email,' +
      ' (SELECT count(*)::int FROM signature_authority_scopes s' +
      '   WHERE s.profile_id = p.id AND s.status = $' + i + ') AS approved_scopes' +
      ' FROM signature_profiles p JOIN users u ON u.id = p.user_id' +
      ' WHERE ' + conds.join(' AND ') + ' ORDER BY p.id DESC LIMIT 200',
    [...params, 'APPROVED']
  );
  return toCamelRows(rows);
}

export async function getSignatureProfileDetail(client: pg.PoolClient, ctx: Ctx, id: number) {
  const p = await getSignatureProfile(client, ctx, id);
  const { rows } = await client.query(
    'SELECT * FROM signature_authority_scopes WHERE profile_id = $1 AND tenant_id = $2' +
      ' ORDER BY document_type, transaction_type NULLS LAST',
    [id, ctx.tenantId]
  );
  return { profile: toCamelRow(p), scopes: toCamelRows(rows) };
}

async function resolveProfileWindow(effectiveFrom: unknown, expiresAt: unknown): Promise<{ from: Date; to: Date | null }> {
  const from = new Date(str(effectiveFrom) ?? new Date().toISOString());
  if (Number.isNaN(from.getTime())) throw badRequest('effectiveFrom must be a valid ISO timestamp');
  const rawTo = str(expiresAt);
  const to = rawTo ? new Date(rawTo) : null;
  if (to && Number.isNaN(to.getTime())) throw badRequest('expiresAt must be a valid ISO timestamp');
  if (to && to.getTime() <= from.getTime()) throw badRequest('expiresAt must be after effectiveFrom');
  return { from, to };
}

export async function createSignatureProfile(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
) {
  const admin = await isGovernanceAdmin(client, ctx);
  const ownerId = admin ? (num(body.userId) ?? ctx.userId) : ctx.userId;
  if (!ownerId) throw badRequest('A user is required for the signature profile');
  const user = await userMeta(client, ctx, ownerId);
  const fullName = str(body.fullName) ?? (user.first_name + ' ' + user.last_name).trim();
  const positionTitle = str(body.positionTitle) ?? str(body.jobTitle) ?? user.first_name + ' ' + user.last_name;
  const authorityLevel = str(body.authorityLevel) ?? 'OTHER';
  const window = await resolveProfileWindow(body.effectiveFrom, body.expiresAt);
  const companyId = (await defaultCompanyId(client, ctx)) ?? num(body.companyId);
  if (!companyId) throw badRequest('A company scope is required for the signature profile');
  const { rows } = await client.query(
    'INSERT INTO signature_profiles' +
      ' (tenant_id, company_id, branch_id, department_id, user_id, employee_id, full_name,' +
      '  position_title, authority_level, effective_from, expires_at, status,' +
      '  created_by, updated_by)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *',
    [
      ctx.tenantId, companyId, num(body.branchId), num(body.departmentId), ownerId,
      num(body.employeeId) ?? user.employee_id, fullName, positionTitle, authorityLevel,
      window.from, window.to, 'DRAFT', ctx.userId,
    ]
  );
  const p = rows[0];
  await audit(client, ctx, {
    action: 'create', resource: 'governance.signature_profile', recordId: Number(p.id),
    recordCode: 'PROFILE-' + p.id, newValues: toCamelRow(p) as Record<string, unknown>,
  });
  return toCamelRow(p);
}

export async function updateSignatureProfile(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const p = await getSignatureProfile(client, ctx, id, true);
  if (!['DRAFT', 'PENDING', 'SUSPENDED', 'REJECTED'].includes(String(p.status))) {
    throw conflict('Only a non-active signature profile can be edited');
  }
  await ownerOrAdmin(client, ctx, Number(p.user_id), 'signature profile');
  const before = toCamelRow(p);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, val: unknown) => {
    if (val !== undefined) { sets.push(col + ' = $' + (vals.length + 1)); vals.push(val); }
  };
  push('full_name', str(body.fullName));
  push('position_title', str(body.positionTitle));
  push('authority_level', str(body.authorityLevel));
  push('branch_id', num(body.branchId));
  push('department_id', num(body.departmentId));
  if (body.effectiveFrom || body.expiresAt !== undefined) {
    const win = await resolveProfileWindow(body.effectiveFrom ?? p.effective_from, body.expiresAt ?? p.expires_at);
    push('effective_from', win.from);
    push('expires_at', win.to);
  }
  if (sets.length === 0) throw badRequest('Nothing to update');
  sets.push('updated_by = $' + (vals.length + 1));
  vals.push(ctx.userId);
  const upd = await client.query(
    'UPDATE signature_profiles SET ' + sets.join(', ') + ' WHERE id = $' + (vals.length + 1) +
      ' RETURNING *',
    [...vals, id]
  );
  const after = toCamelRow(upd.rows[0]);
  await audit(client, ctx, {
    action: 'update', resource: 'governance.signature_profile', recordId: id,
    oldValues: before, newValues: after,
  });
  return after;
}

export async function attachSignatureArtwork(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const p = await getSignatureProfile(client, ctx, id, true);
  await ownerOrAdmin(client, ctx, Number(p.user_id), 'signature profile');
  const before = toCamelRow(p);
  const { rows } = await client.query(
    'UPDATE signature_profiles SET signature_asset_key = $1, signature_url = $2,' +
      ' signature_data = $3, updated_by = $4, updated_at = now()' +
      ' WHERE id = $5 RETURNING *',
    [
      str(body.assetKey) ?? p.signature_asset_key,
      str(body.url) ?? p.signature_url,
      body.data && typeof body.data === 'object'
        ? JSON.stringify(body.data)
        : JSON.stringify(p.signature_data ?? {}),
      ctx.userId,
      id,
    ]
  );
  const after = toCamelRow(rows[0]);
  await audit(client, ctx, {
    action: 'upload', resource: 'governance.signature_profile', recordId: id,
    oldValues: before, newValues: after,
    metadata: { hasAssetKey: !!after.signatureAssetKey, hasUrl: !!after.signatureUrl },
  });
  return after;
}

async function applySignatureStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  opts: {
    from: string[];
    to: string;
    reason?: string | null;
    fields?: Record<string, unknown>;
    auditAction: string;
    ownerOrAdminUserId?: number | null;
  }
) {
  const p = await getSignatureProfile(client, ctx, id, true);
  if (!opts.from.includes(String(p.status))) {
    throw conflict('Signature profile cannot move from ' + p.status + ' to ' + opts.to);
  }
  if (opts.ownerOrAdminUserId !== undefined && opts.ownerOrAdminUserId !== null) {
    await ownerOrAdmin(client, ctx, Number(opts.ownerOrAdminUserId), 'signature profile');
  }
  const fromStatus = String(p.status);
  const sets = ['status = $1', 'updated_at = now()', 'updated_by = $2'];
  const vals: unknown[] = [opts.to, ctx.userId];
  const fields = opts.fields ?? {};
  Object.keys(fields).forEach((k) => {
    sets.push(k + ' = $' + (vals.length + 1));
    vals.push(fields[k]);
  });
  const upd = await client.query(
    'UPDATE signature_profiles SET ' + sets.join(', ') + ' WHERE id = $' + (vals.length + 1) +
      ' RETURNING *',
    [...vals, id]
  );
  const fresh = upd.rows[0];
  await audit(client, ctx, {
    action: opts.auditAction, resource: 'governance.signature_profile', recordId: id,
    oldValues: { status: fromStatus }, newValues: { status: opts.to, reason: opts.reason ?? null },
    metadata: { fromStatus, toStatus: opts.to },
  });
  return fresh;
}

export async function submitSignatureProfile(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  reason?: string | null
) {
  const p = await getSignatureProfile(client, ctx, id);
  const fresh = await applySignatureStatus(client, ctx, id, {
    from: ['DRAFT'],
    to: 'PENDING',
    reason: reason ?? 'Submitted for signature approval',
    auditAction: 'submit',
    ownerOrAdminUserId: Number(p.user_id),
  });
  const approvers = await userIdsWithPermission(client, ctx, 'governance.signature_profiles.approve');
  await notify(client, ctx, approvers, {
    type: 'governance.signature.submitted',
    title: 'Signature profile submitted for approval',
    body: fresh.full_name + ' submitted signature profile for ' + fresh.position_title + '.',
    link: '/admin/signatures/' + Number(id),
    priority: 'HIGH',
    severity: 'INFO',
  });
  return toCamelRow(fresh);
}

async function assertNoConflictingActiveProfile(
  client: pg.PoolClient,
  ctx: Ctx,
  profileId: number,
  userId: number,
  companyId: number | null
): Promise<void> {
  const { rows } = await client.query(
    'SELECT 1 FROM signature_profiles WHERE user_id = $1 AND company_id = $2' +
      ' AND status = $3 AND id <> $4 LIMIT 1',
    [userId, companyId, 'ACTIVE', profileId]
  );
  if (rows.length > 0) throw conflict('An active signature profile already exists for this user');
}

export async function approveSignatureProfile(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  reason?: string | null
) {
  const p = await getSignatureProfile(client, ctx, id, true);
  if (String(p.status) !== 'PENDING') throw conflict('Only a pending signature profile can be approved');
  if (Number(p.user_id) === ctx.userId) throw forbidden('A signature profile cannot be approved by its owner');
  await assertNoConflictingActiveProfile(client, ctx, id, Number(p.user_id), num(p.company_id));
  const nowWithin = withinWindow(new Date(p.effective_from), p.expires_at ? new Date(p.expires_at) : null);
  const target = nowWithin ? 'ACTIVE' : 'PENDING';
  const fresh = await applySignatureStatus(client, ctx, id, {
    from: ['PENDING'],
    to: target,
    reason: reason ?? 'Signature profile approved',
    fields: {
      approver_user_id: ctx.userId,
      approved_at: new Date(),
      activated_at: nowWithin ? new Date() : null,
    },
    auditAction: 'approve',
  });
  await notify(client, ctx, [Number(p.user_id)], {
    type: 'governance.signature.approved',
    title: target === 'ACTIVE' ? 'Your signature profile is active' : 'Signature profile approved',
    body: 'Your signature profile (' + fresh.full_name + ') can now be applied to authorized documents.',
    link: '/admin/signatures/' + Number(id),
    severity: 'SUCCESS',
    priority: 'HIGH',
  });
  return toCamelRow(fresh);
}

export async function rejectSignatureProfile(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  reason?: string | null
) {
  const p = await getSignatureProfile(client, ctx, id);
  if (Number(p.user_id) === ctx.userId) throw forbidden('A signature profile cannot be rejected by its owner');
  const fresh = await applySignatureStatus(client, ctx, id, {
    from: ['PENDING'],
    to: 'REJECTED',
    reason: reason ?? 'Rejected',
    fields: { rejected_by: ctx.userId, rejected_at: new Date(), rejected_reason: reason ?? null },
    auditAction: 'reject',
  });
  await notify(client, ctx, [Number(p.user_id)], {
    type: 'governance.signature.rejected',
    title: 'Signature profile rejected',
    body: 'Your signature profile was rejected' + (reason ? ': ' + reason : '.'),
    link: '/admin/signatures/' + Number(id),
    severity: 'ERROR',
  });
  return toCamelRow(fresh);
}

export async function activateSignatureProfile(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  reason?: string | null
) {
  const p = await getSignatureProfile(client, ctx, id, true);
  const st = String(p.status);
  if (!['PENDING', 'SUSPENDED', 'REJECTED'].includes(st)) {
    throw conflict('Only a pending, suspended or rejected signature profile can be activated');
  }
  if (st === 'PENDING' && !p.approved_at) {
    throw conflict('The signature profile must be approved before it can be activated');
  }
  if (st !== 'PENDING') {
    const admin = await isGovernanceAdmin(client, ctx);
    if (!admin) {
      throw forbidden('Only a governance administrator can reactivate a signature profile');
    }
  }
  if (!withinWindow(new Date(p.effective_from), p.expires_at ? new Date(p.expires_at) : null)) {
    throw conflict('The signature profile is outside its effective window; adjust effectiveFrom or expiresAt first');
  }
  await assertNoConflictingActiveProfile(client, ctx, id, Number(p.user_id), num(p.company_id));
  const fresh = await applySignatureStatus(client, ctx, id, {
    from: ['PENDING', 'SUSPENDED', 'REJECTED'],
    to: 'ACTIVE',
    reason: reason ?? 'Signature profile activated',
    fields: {
      activated_at: new Date(),
      rejected_reason: null,
      rejected_at: null,
      suspended_by: null,
      suspended_at: null,
      suspended_reason: null,
    },
    auditAction: 'activate',
  });
  await notify(client, ctx, [Number(p.user_id)], {
    type: 'governance.signature.activated',
    title: 'Your signature is now active',
    body: 'Your signature profile (' + fresh.full_name + ') is active and may sign authorized documents.',
    link: '/admin/signatures/' + Number(id),
    severity: 'SUCCESS',
    priority: 'HIGH',
  });
  return toCamelRow(fresh);
}

export async function suspendSignatureProfile(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  reason?: string | null
) {
  const p = await getSignatureProfile(client, ctx, id, true);
  const admin = await isGovernanceAdmin(client, ctx);
  if (!admin) throw forbidden('Only a governance administrator can suspend a signature profile');
  const fresh = await applySignatureStatus(client, ctx, id, {
    from: ['ACTIVE'],
    to: 'SUSPENDED',
    reason: reason ?? 'Signature profile suspended',
    fields: { suspended_by: ctx.userId, suspended_at: new Date(), suspended_reason: reason ?? null },
    auditAction: 'suspend',
  });
  await notify(client, ctx, [Number(p.user_id)], {
    type: 'governance.signature.suspended',
    title: 'Your signature profile has been suspended',
    body: 'Your signature profile can no longer sign documents' + (reason ? ': ' + reason : '.'),
    link: '/admin/signatures/' + Number(id),
    severity: 'WARN',
  });
  return toCamelRow(fresh);
}

export async function revokeSignatureProfile(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  reason?: string | null
) {
  const p = await getSignatureProfile(client, ctx, id, true);
  const admin = await isGovernanceAdmin(client, ctx);
  if (!admin) throw forbidden('Only a governance administrator can revoke a signature profile');
  const fresh = await applySignatureStatus(client, ctx, id, {
    from: ['ACTIVE', 'PENDING', 'SUSPENDED', 'DRAFT'],
    to: 'REVOKED',
    reason: reason ?? 'Signature profile revoked',
    fields: { revoked_by: ctx.userId, revoked_at: new Date(), revoked_reason: reason ?? null },
    auditAction: 'revoke',
  });
  await notify(client, ctx, [Number(p.user_id)], {
    type: 'governance.signature.revoked',
    title: 'Your signature profile has been revoked',
    body: 'Your signature authority has been revoked' + (reason ? ': ' + reason : '.'),
    link: '/admin/signatures/' + Number(id),
    severity: 'ERROR',
    priority: 'HIGH',
  });
  return toCamelRow(fresh);
}

export async function expireSignatureProfile(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  reason?: string | null
) {
  const p = await getSignatureProfile(client, ctx, id, true);
  const admin = await isGovernanceAdmin(client, ctx);
  if (!admin) throw forbidden('Only a governance administrator can manually expire a signature profile');
  const fresh = await applySignatureStatus(client, ctx, id, {
    from: ['ACTIVE', 'PENDING'],
    to: 'EXPIRED',
    reason: reason ?? 'Signature profile expired',
    fields: { activated_at: null },
    auditAction: 'expire',
  });
  await notify(client, ctx, [Number(p.user_id)], {
    type: 'governance.signature.expired',
    title: 'Your signature profile has expired',
    body: 'Your signature profile is no longer inside its authorized window.',
    link: '/admin/signatures/' + Number(id),
    severity: 'WARN',
  });
  return toCamelRow(fresh);
}

async function getSignatureScope(
  client: pg.PoolClient,
  ctx: Ctx,
  profileId: number,
  scopeId: number,
  forUpdate = false
) {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  const { rows } = await client.query(
    'SELECT s.*, p.user_id AS profile_user_id, p.status AS profile_status' +
      ' FROM signature_authority_scopes s' +
      ' JOIN signature_profiles p ON p.id = s.profile_id' +
      ' WHERE s.id = $1 AND s.profile_id = $2 AND s.tenant_id = $3' + lock,
    [scopeId, profileId, ctx.tenantId]
  );
  if (rows.length === 0) throw notFound('Signature authority scope not found');
  return rows[0];
}

async function profileEditableForScopes(client: pg.PoolClient, ctx: Ctx, profileId: number) {
  const p = await getSignatureProfile(client, ctx, profileId);
  if (['REVOKED', 'EXPIRED'].includes(String(p.status))) {
    throw conflict('Signature authority scopes cannot be changed on a revoked or expired profile');
  }
  return p;
}

export async function listSignatureScopes(
  client: pg.PoolClient,
  ctx: Ctx,
  profileId: number
) {
  await getSignatureProfile(client, ctx, profileId);
  const { rows } = await client.query(
    'SELECT * FROM signature_authority_scopes WHERE profile_id = $1 AND tenant_id = $2' +
      ' ORDER BY document_type, transaction_type NULLS LAST, id',
    [profileId, ctx.tenantId]
  );
  return toCamelRows(rows);
}

export async function createSignatureScope(
  client: pg.PoolClient,
  ctx: Ctx,
  profileId: number,
  body: Record<string, unknown>
) {
  const p = await profileEditableForScopes(client, ctx, profileId);
  await ownerOrAdmin(client, ctx, Number(p.user_id), 'signature profile');
  const documentType = str(body.documentType);
  if (!documentType || documentType.trim().length === 0) {
    throw badRequest('documentType is required for a signature authority scope');
  }
  const transactionType = str(body.transactionType);
  const maxAmount = num(body.maxAmount);
  if (maxAmount !== null && maxAmount < 0) throw badRequest('maxAmount cannot be negative');
  const companyId = num(body.companyId) ?? num(p.company_id);
  if (!companyId) throw badRequest('A company scope is required for the signature authority scope');
  const exists = await client.query(
    'SELECT 1 FROM signature_authority_scopes' +
      ' WHERE profile_id = $1 AND document_type = $2 AND transaction_type IS NOT DISTINCT FROM $3' +
      ' AND tenant_id = $4 LIMIT 1',
    [profileId, documentType, transactionType, ctx.tenantId]
  );
  if (exists.rows.length > 0) {
    throw conflict('A signature authority scope already exists for this document type');
  }
  const { rows } = await client.query(
    'INSERT INTO signature_authority_scopes' +
      ' (tenant_id, company_id, branch_id, department_id, profile_id, document_type,' +
      '  transaction_type, max_amount, status, created_by, updated_by)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *',
    [
      ctx.tenantId, companyId, num(body.branchId) ?? num(p.branch_id),
      num(body.departmentId) ?? num(p.department_id), profileId, documentType,
      transactionType, maxAmount, 'PENDING', ctx.userId,
    ]
  );
  const scope = rows[0];
  await audit(client, ctx, {
    action: 'create', resource: 'governance.signature_authority_scope', recordId: Number(scope.id),
    recordCode: String(p.full_name) + '/' + documentType,
    newValues: toCamelRow(scope) as Record<string, unknown>,
  });
  return toCamelRow(scope);
}

export async function updateSignatureScope(
  client: pg.PoolClient,
  ctx: Ctx,
  profileId: number,
  scopeId: number,
  body: Record<string, unknown>
) {
  const p = await profileEditableForScopes(client, ctx, profileId);
  await ownerOrAdmin(client, ctx, Number(p.user_id), 'signature profile');
  const s = await getSignatureScope(client, ctx, profileId, scopeId, true);
  const before = toCamelRow(s);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, val: unknown) => {
    if (val !== undefined) { sets.push(col + ' = $' + (vals.length + 1)); vals.push(val); }
  };
  if (body.documentType !== undefined) {
    const dt = str(body.documentType);
    if (!dt || dt.trim().length === 0) throw badRequest('documentType cannot be empty');
    push('document_type', dt);
  }
  push('transaction_type', body.transactionType === undefined || body.transactionType === null
    ? (body.transactionType === null ? null : undefined)
    : str(body.transactionType));
  if (body.maxAmount !== undefined) {
    const amt = num(body.maxAmount);
    if (amt !== null && amt < 0) throw badRequest('maxAmount cannot be negative');
    push('max_amount', amt);
  }
  push('branch_id', num(body.branchId));
  push('department_id', num(body.departmentId));
  const reset = body.documentType !== undefined || body.transactionType !== undefined ||
    body.maxAmount !== undefined || body.branchId !== undefined || body.departmentId !== undefined;
  if (String(s.status) === 'APPROVED' && reset) {
    sets.push('status = $' + (vals.length + 1)); vals.push('PENDING');
    sets.push('approver_user_id = $' + (vals.length + 1)); vals.push(null);
    sets.push('approved_at = $' + (vals.length + 1)); vals.push(null);
    sets.push('rejected_reason = $' + (vals.length + 1)); vals.push(null);
  }
  if (sets.length === 0) throw badRequest('Nothing to update');
  sets.push('updated_by = $' + (vals.length + 1));
  vals.push(ctx.userId);
  const upd = await client.query(
    'UPDATE signature_authority_scopes SET ' + sets.join(', ') + ' WHERE id = $' + (vals.length + 1) +
      ' AND profile_id = $' + (vals.length + 2) + ' RETURNING *',
    [...vals, scopeId, profileId]
  );
  const after = toCamelRow(upd.rows[0]);
  await audit(client, ctx, {
    action: 'update', resource: 'governance.signature_authority_scope', recordId: scopeId,
    oldValues: before, newValues: after,
  });
  return after;
}

export async function deleteSignatureScope(
  client: pg.PoolClient,
  ctx: Ctx,
  profileId: number,
  scopeId: number
) {
  const p = await profileEditableForScopes(client, ctx, profileId);
  await ownerOrAdmin(client, ctx, Number(p.user_id), 'signature profile');
  const s = await getSignatureScope(client, ctx, profileId, scopeId, true);
  const before = toCamelRow(s);
  await client.query(
    'DELETE FROM signature_authority_scopes WHERE id = $1 AND profile_id = $2 AND tenant_id = $3',
    [scopeId, profileId, ctx.tenantId]
  );
  await audit(client, ctx, {
    action: 'delete', resource: 'governance.signature_authority_scope', recordId: scopeId,
    oldValues: before,
  });
  return { ok: true, id: scopeId };
}

export async function approveSignatureScope(
  client: pg.PoolClient,
  ctx: Ctx,
  profileId: number,
  scopeId: number,
  reason?: string | null
) {
  const s = await getSignatureScope(client, ctx, profileId, scopeId, true);
  if (String(s.status) !== 'PENDING') throw conflict('Only a pending signature authority scope can be approved');
  const p = await getSignatureProfile(client, ctx, profileId);
  if (Number(s.created_by) === ctx.userId) {
    throw forbidden('The creator of a signature authority scope cannot approve it');
  }
  const upd = await client.query(
    'UPDATE signature_authority_scopes SET status = $1, approver_user_id = $2, approved_at = now(),' +
      ' rejected_reason = NULL, updated_by = $2, updated_at = now()' +
      ' WHERE id = $3 AND profile_id = $4 RETURNING *',
    ['APPROVED', ctx.userId, scopeId, profileId]
  );
  const fresh = upd.rows[0];
  await audit(client, ctx, {
    action: 'approve', resource: 'governance.signature_authority_scope', recordId: scopeId,
    oldValues: { status: 'PENDING' }, newValues: { status: 'APPROVED', reason: reason ?? null },
    metadata: { profileId, documentType: String(s.document_type) },
  });
  await notify(client, ctx, [Number(p.user_id)], {
    type: 'governance.signature.scope_approved',
    title: 'Signature authority scope approved',
    body: 'Authority to sign ' + String(s.document_type) + ' documents was approved for ' + p.full_name + '.',
    link: '/admin/signatures/' + Number(profileId),
    severity: 'SUCCESS',
  });
  return toCamelRow(fresh);
}

export async function rejectSignatureScope(
  client: pg.PoolClient,
  ctx: Ctx,
  profileId: number,
  scopeId: number,
  reason?: string | null
) {
  const s = await getSignatureScope(client, ctx, profileId, scopeId, true);
  if (String(s.status) !== 'PENDING') throw conflict('Only a pending signature authority scope can be rejected');
  const p = await getSignatureProfile(client, ctx, profileId);
  if (Number(s.created_by) === ctx.userId) {
    throw forbidden('The creator of a signature authority scope cannot reject it');
  }
  const upd = await client.query(
    'UPDATE signature_authority_scopes SET status = $1, approver_user_id = $2, rejected_reason = $3,' +
      ' approved_at = NULL, updated_by = $2, updated_at = now()' +
      ' WHERE id = $4 AND profile_id = $5 RETURNING *',
    ['REJECTED', ctx.userId, reason ?? 'Rejected', scopeId, profileId]
  );
  const fresh = upd.rows[0];
  await audit(client, ctx, {
    action: 'reject', resource: 'governance.signature_authority_scope', recordId: scopeId,
    oldValues: { status: 'PENDING' }, newValues: { status: 'REJECTED', reason: reason ?? null },
    metadata: { profileId, documentType: String(s.document_type) },
  });
  await notify(client, ctx, [Number(p.user_id)], {
    type: 'governance.signature.scope_rejected',
    title: 'Signature authority scope rejected',
    body: 'Authority to sign ' + String(s.document_type) + ' documents was rejected' +
      (reason ? ': ' + reason : '.'),
    link: '/admin/signatures/' + Number(profileId),
    severity: 'ERROR',
  });
  return toCamelRow(fresh);
}

// ===========================================================================
// Applied document signatures (immutable, QR-verifiable snapshots)
// ===========================================================================

export async function listDocumentSignatures(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: {
    documentType?: string | null;
    entityType?: string | null;
    entityId?: number | null;
    documentCode?: string | null;
    userId?: number | null;
  } = {}
) {
  const params: unknown[] = [ctx.tenantId];
  const conds = ['r.tenant_id = $1'];
  let i = 2;
  if (ctx.companyId) { conds.push('r.company_id = $' + i); params.push(ctx.companyId); i += 1; }
  if (opts.documentType) { conds.push('r.document_type = $' + i); params.push(opts.documentType); i += 1; }
  if (opts.entityType) { conds.push('r.entity_type = $' + i); params.push(opts.entityType); i += 1; }
  if (opts.entityId) { conds.push('r.entity_id = $' + i); params.push(opts.entityId); i += 1; }
  if (opts.documentCode) { conds.push('r.document_code = $' + i); params.push(opts.documentCode); i += 1; }
  if (opts.userId) { conds.push('r.user_id = $' + i); params.push(opts.userId); i += 1; }
  const { rows } = await client.query(
    'SELECT r.*, u.first_name AS signer_first_name, u.last_name AS signer_last_name' +
      ' FROM document_signature_records r JOIN users u ON u.id = r.user_id' +
      ' WHERE ' + conds.join(' AND ') +
      ' ORDER BY r.id DESC LIMIT 200',
    params
  );
  return toCamelRows(rows).map((r) => {
    const clean = { ...r };
    delete (clean as Record<string, unknown>).tokenHash;
    return clean;
  });
}

export async function applyDocumentSignature(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
) {
  const profileId = num(body.profileId);
  if (!profileId) throw badRequest('profileId is required to apply a signature');
  const documentType = str(body.documentType);
  const entityType = str(body.entityType);
  const entityId = num(body.entityId);
  const documentCode = str(body.documentCode);
  if (!documentType || !entityType || !entityId || !documentCode) {
    throw badRequest('documentType, entityType, entityId and documentCode are required');
  }
  const p = await getSignatureProfile(client, ctx, profileId, true);
  if (String(p.status) !== 'ACTIVE') {
    throw conflict('Only an ACTIVE signature profile can sign documents (current: ' + p.status + ')');
  }
  if (Number(p.user_id) !== ctx.userId) {
    throw forbidden('A user can only apply their own signature profile');
  }
  if (!withinWindow(new Date(p.effective_from), p.expires_at ? new Date(p.expires_at) : null)) {
    throw conflict('The signature profile is outside its effective window');
  }
  const companyId = num(p.company_id);
  if (!companyId) throw badRequest('The signature profile has no company scope');
  if (ctx.companyId && num(ctx.companyId) !== companyId) {
    throw forbidden('The signature profile belongs to another company');
  }
  const amount = num(body.amount);
  if (amount !== null && amount < 0) throw badRequest('amount cannot be negative');
  const transactionType = str(body.transactionType);
  const branchId = num(body.branchId) ?? num(p.branch_id);
  const departmentId = num(body.departmentId) ?? num(p.department_id);

  const scopeRes = await client.query(
    'SELECT s.* FROM signature_authority_scopes s' +
      ' WHERE s.profile_id = $1 AND s.tenant_id = $2' +
      '   AND s.document_type = $3' +
      '   AND s.transaction_type IS NOT DISTINCT FROM $4' +
      '   AND s.status IN ($5, $6)' +
      ' ORDER BY s.status, (s.max_amount IS NULL) ASC, s.max_amount ASC',
    [profileId, ctx.tenantId, documentType, transactionType, 'APPROVED', 'REJECTED']
  );
  const covers = (row: Record<string, unknown>): boolean => {
    if (row.branch_id !== null && row.branch_id !== undefined) {
      if (branchId === null || Number(row.branch_id) !== branchId) return false;
    }
    if (row.department_id !== null && row.department_id !== undefined) {
      if (departmentId === null || Number(row.department_id) !== departmentId) return false;
    }
    const cap = row.max_amount === null || row.max_amount === undefined
      ? null
      : Number(row.max_amount);
    if (amount !== null && cap !== null && amount > cap) return false;
    return true;
  };
  let scope: Record<string, unknown> | null = null;
  let denied = false;
  for (const raw of scopeRes.rows) {
    const row = raw as Record<string, unknown>;
    if (!covers(row)) continue;
    if (String(row.status) === 'REJECTED') denied = true;
    else if (!scope) scope = row;
  }
  if (!scope) {
    throw forbidden(
      denied
        ? 'Signature authority for this document type and amount was rejected'
        : 'No approved signature authority covers this document type and amount'
    );
  }

  let delegation: Record<string, unknown> | null = null;
  const delegationId = num(body.delegationId);
  if (delegationId) {
    const d = await getDelegation(client, ctx, delegationId, { forUpdate: true, expected: 'ACTIVE' });
    if (Number(d.delegate_user_id) !== ctx.userId) {
      throw forbidden('Only the active delegate can sign under this delegation');
    }
    if (num(d.company_id) !== companyId) {
      throw forbidden('The delegation and the signature profile must share the same company');
    }
    if (!withinWindow(new Date(d.starts_at), d.expires_at ? new Date(d.expires_at) : null)) {
      throw conflict('The delegation is outside its effective window');
    }
    delegation = d;
  }

  const signatorySnapshot = {
    user_id: ctx.userId,
    full_name: String(p.full_name),
    position_title: String(p.position_title),
    employee_id: p.employee_id === null || p.employee_id === undefined ? null : Number(p.employee_id),
    company_id: companyId,
    branch_id: branchId,
    department_id: departmentId,
  };
  const sigData = (p.signature_data ?? {}) as Record<string, unknown>;
  const signatureSnapshot = {
    profile_id: Number(p.id),
    authority_level: String(p.authority_level),
    signature_asset_key: p.signature_asset_key ?? null,
    signature_url: p.signature_url ?? null,
    has_signature_data: typeof sigData === 'object' && sigData !== null && Object.keys(sigData).length > 0,
    approved_at: p.approved_at ?? null,
  };
  const delegationSnapshot = delegation
    ? {
        delegation_id: Number(delegation.id),
        delegation_code: String(delegation.code),
        delegator_user_id: Number(delegation.delegator_user_id),
        delegator_name: String(delegation.delegator_first_name) + ' ' +
          String(delegation.delegator_last_name),
        original_role_code: delegation.original_role_code ?? null,
        original_role_name: delegation.original_role_name ?? null,
        temporary_role_code: delegation.temporary_role_code ?? null,
        temporary_role_name: delegation.temporary_role_name ?? null,
        starts_at: delegation.starts_at ?? null,
        expires_at: delegation.expires_at ?? null,
      }
    : null;
  const authoritySnapshot = {
    scope_id: Number(scope.id),
    document_type: documentType,
    transaction_type: scope.transaction_type ?? null,
    max_amount: scope.max_amount === null || scope.max_amount === undefined
      ? null
      : Number(scope.max_amount),
    amount,
    company_id: companyId,
    branch_id: branchId,
    department_id: departmentId,
    delegation: delegationSnapshot,
  };

  const token = makeVerifyToken();
  const verificationCode = makeVerificationCode();
  const versionRaw = str(body.version);
  const version = versionRaw && versionRaw.trim().length > 0 ? versionRaw.trim().slice(0, 20) : null;
  const cols: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => { cols.push(col); params.push(val); };
  push('tenant_id', ctx.tenantId);
  push('company_id', companyId);
  push('branch_id', branchId);
  push('department_id', departmentId);
  push('user_id', ctx.userId);
  push('profile_id', Number(p.id));
  if (delegation) push('delegation_id', Number(delegation.id));
  push('document_type', documentType);
  push('entity_type', entityType);
  push('entity_id', entityId);
  push('document_code', documentCode);
  if (version) push('version', version);
  push('amount', amount);
  push('signatory_snapshot', JSON.stringify(signatorySnapshot));
  push('signature_snapshot', JSON.stringify(signatureSnapshot));
  push('authority_snapshot', JSON.stringify(authoritySnapshot));
  push('verification_code', verificationCode);
  push('token_hash', token.hash);
  push('created_by', ctx.userId);
  const { rows } = await client.query(
    'INSERT INTO document_signature_records (' + cols.join(', ') + ') VALUES (' +
      cols.map((_, idx) => '$' + (idx + 1)).join(', ') + ') RETURNING *',
    params
  );
  const fresh = rows[0];
  await audit(client, ctx, {
    action: 'sign',
    resource: 'governance.document_signature',
    recordId: Number(fresh.id),
    recordCode: String(fresh.code),
    newValues: {
      documentType,
      entityType,
      entityId,
      documentCode,
      amount,
      profileId: Number(p.id),
      delegationId: delegation ? Number(delegation.id) : null,
      verificationCode,
    },
    metadata: { delegated: !!delegation, scopeId: Number(scope.id) },
  });
  const clean = toCamelRow(fresh) as Record<string, unknown>;
  delete clean.tokenHash;
  return { record: clean, verifyToken: token.token, delegated: !!delegation };
}

// ===========================================================================
// Document signature verification (QR-safe, constant-time, no oracles)
// ===========================================================================

export async function verifyDocumentSignature(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
) {
  const code = str(body.code);
  const verificationCode = str(body.verificationCode);
  const token = str(body.token);
  if (!verificationCode && !code) {
    throw badRequest('A verification code or signed document code is required');
  }
  let params: unknown[] = [ctx.tenantId];
  let where = 'r.tenant_id = $1';
  if (verificationCode) {
    where += ' AND r.verification_code = $2';
    params.push(verificationCode);
  } else {
    if (!ctx.companyId) throw badRequest('Resolving by document code requires a company context');
    where += ' AND r.company_id = $2 AND r.code = $3';
    params.push(ctx.companyId, code);
  }
  const { rows } = await client.query(
    'SELECT r.*, u.first_name AS signer_first_name, u.last_name AS signer_last_name' +
      ' FROM document_signature_records r JOIN users u ON u.id = r.user_id' +
      ' WHERE ' + where + ' LIMIT 1',
    params
  );
  if (rows.length === 0) throw badRequest('Invalid verification code or token');
  const r = rows[0];
  const record = toCamelRow(r) as Record<string, unknown>;
  if (token) {
    const expected = Buffer.from(String(record.tokenHash ?? ''), 'utf8');
    const actual = Buffer.from(sha256Hex(token), 'utf8');
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!ok) throw badRequest('Invalid verification code or token');
  }
  return {
    valid: true,
    tokenValidated: !!token,
    code: String(r.code),
    verificationCode: String(r.verification_code),
    documentType: String(r.document_type),
    entityType: String(r.entity_type),
    entityId: Number(r.entity_id),
    documentCode: String(r.document_code),
    version: String(r.version),
    amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    signedAt: r.signed_at,
    signatorySnapshot: record.signatorySnapshot ?? {},
    signatureSnapshot: record.signatureSnapshot ?? {},
    authoritySnapshot: record.authoritySnapshot ?? {},
    signer: {
      userId: Number(r.user_id),
      firstName: String(r.signer_first_name ?? ''),
      lastName: String(r.signer_last_name ?? ''),
    },
  };
}

export async function signatureDashboard(client: pg.PoolClient, ctx: Ctx) {
  const params: unknown[] = [ctx.tenantId];
  let companySql = '';
  if (ctx.companyId) { companySql = ' AND company_id = $2'; params.push(ctx.companyId); }
  const { rows } = await client.query(
    'SELECT status, count(*)::int AS total FROM signature_profiles' +
      ' WHERE tenant_id = $1' + companySql + ' GROUP BY status',
    params
  );
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const st = String(r.status);
    byStatus[st] = Number(r.total);
    total += Number(r.total);
  }
  const scopeParams: unknown[] = [ctx.tenantId, 'PENDING'];
  let idx = 3;
  let scopeCompany = '';
  if (ctx.companyId) {
    scopeCompany = ' AND p.company_id = $' + idx;
    scopeParams.push(ctx.companyId);
    idx += 1;
  }
  const scopeRes = await client.query(
    'SELECT count(*)::int AS total FROM signature_authority_scopes s' +
      ' JOIN signature_profiles p ON p.id = s.profile_id' +
      ' WHERE s.tenant_id = $1 AND s.status = $2' + scopeCompany,
    scopeParams
  );
  const expParams: unknown[] = [ctx.tenantId];
  let expCompany = '';
  if (ctx.companyId) { expCompany = ' AND company_id = $2'; expParams.push(ctx.companyId); }
  const expRes = await client.query(
    "SELECT count(*)::int AS total FROM signature_profiles" +
      " WHERE tenant_id = $1 AND status IN ('ACTIVE','PENDING') AND expires_at IS NOT NULL" +
      " AND expires_at <= now() + interval '14 days'" + expCompany,
    expParams
  );
  const mineRes = await client.query(
    'SELECT count(*)::int AS total FROM signature_profiles' +
      ' WHERE tenant_id = $1 AND user_id = $2',
    [ctx.tenantId, ctx.userId]
  );
  return {
    total,
    active: byStatus['ACTIVE'] ?? 0,
    pending: byStatus['PENDING'] ?? 0,
    pendingApproval: byStatus['PENDING'] ?? 0,
    byStatus,
    mine: Number(mineRes.rows[0]?.total ?? 0),
    pendingScopes: Number(scopeRes.rows[0]?.total ?? 0),
    expiringSoon: Number(expRes.rows[0]?.total ?? 0),
  };
}

export async function governanceSweep(client: pg.PoolClient, ctx: Ctx) {
  const del = await client.query('SELECT public.governance_expire_delegations() AS expired');
  const sig = await client.query('SELECT public.governance_expire_signature_profiles() AS expired');
  return {
    expiredDelegations: Number(del.rows[0]?.expired ?? 0),
    expiredSignatureProfiles: Number(sig.rows[0]?.expired ?? 0),
  };
}
