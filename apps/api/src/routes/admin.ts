import { Router } from 'express';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { tx, Ctx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { asyncHandler, badRequest, notFound, conflict, nowIso, parsePagination, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from '../services/audit.js';
import { hashPassword, hashToken } from '../auth.js';
import { SETTINGS, SETTING_CATEGORIES } from './settings.js';
import * as identityLink from '../services/identityLink.js';

export const adminRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
const run = (permission: string | string[], fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

type QueryFn = (client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;
const runGet = (permission: string | string[], fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

const s = (v: unknown) => (v === undefined || v === null ? null : String(v));
const n = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));
const b = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';

const USER_STATUSES = ['INVITED', 'PENDING_ACTIVATION', 'ACTIVE', 'INACTIVE', 'SUSPENDED', 'LOCKED', 'DISABLED', 'TERMINATED'];

const USER_LIST_SQL = `
  SELECT u.id, u.email, u.username, u.first_name, u.last_name, u.job_title, u.phone, u.status,
         u.company_id, u.branch_id, u.department_id, u.employee_id, u.must_change_password,
         u.mfa_enabled, u.last_login_at, u.locked_until, u.created_at, u.updated_at,
         c.code AS company_code, c.name AS company_name,
         b.code AS branch_code, b.name AS branch_name,
         d.code AS department_code, d.name AS department_name,
         emp.employee_no, emp.first_name AS employee_first_name, emp.last_name AS employee_last_name,
         emp.position AS employee_position, emp.status AS employee_status
  FROM users u
  LEFT JOIN companies c ON c.id = u.company_id
  LEFT JOIN branches b ON b.id = u.branch_id
  LEFT JOIN departments d ON d.id = u.department_id
  LEFT JOIN employees emp ON emp.id = u.employee_id
`;

async function recordStatusChange(
  client: pg.PoolClient,
  ctx: Ctx,
  userId: number,
  toStatus: string,
  reason: string,
  resource = 'users'
) {
  const prev = await client.query('SELECT status, email FROM users WHERE id = $1 AND tenant_id = $2', [userId, ctx.tenantId]);
  if (prev.rows.length === 0) throw notFound('User not found');
  const fromStatus = prev.rows[0].status;
  if (fromStatus !== toStatus) {
    await client.query('UPDATE users SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3', [toStatus, userId, ctx.tenantId]);
    await client.query(
      `INSERT INTO user_status_history (tenant_id, user_id, from_status, to_status, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.tenantId, userId, fromStatus, toStatus, reason, ctx.userId ?? null]
    );
  }
  await logAudit(client, ctx, {
    action: 'status_change',
    resource,
    recordId: userId,
    recordCode: prev.rows[0].email ?? String(userId),
    oldValues: { status: fromStatus },
    newValues: { status: toStatus },
    metadata: { reason },
  });
  return { from: fromStatus, to: toStatus };
}

// ---- Administration dashboard ----
adminRouter.get('/dashboard', ...runGet(['admin.dashboard.view', 'admin.users.view'], async (c, ctx) => {
  const tenantId = ctx.tenantId;
  const users = await c.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
            COUNT(*) FILTER (WHERE status = 'SUSPENDED')::int AS suspended,
            COUNT(*) FILTER (WHERE status = 'DISABLED')::int AS disabled,
            COUNT(*) FILTER (WHERE status IN ('INVITED','PENDING_ACTIVATION'))::int AS pending,
            COUNT(*) FILTER (WHERE status = 'LOCKED' OR locked_until > now())::int AS locked,
            COUNT(*) FILTER (WHERE mfa_enabled = true)::int AS mfa_enrolled
     FROM users WHERE tenant_id = $1`,
    [tenantId]
  );
  const sessions = await c.query(
    `SELECT COUNT(*)::int AS active_sessions
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE u.tenant_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [tenantId]
  );
  const failed = await c.query(
    `SELECT COUNT(*)::int AS failed_24h FROM login_attempts WHERE success = false AND created_at > now() - interval '24 hours'`
  );
  const roles = await c.query('SELECT COUNT(*)::int AS total FROM roles WHERE tenant_id = $1', [tenantId]);
  const policies = await c.query('SELECT COUNT(*)::int AS active FROM policies WHERE tenant_id = $1 AND is_active = true', [tenantId]);
  const sod = await c.query(
    "SELECT COUNT(*)::int AS active FROM sod_conflicts WHERE tenant_id = $1 AND status = 'ACTIVE_CONFLICT'",
    [tenantId]
  );
  const audits = await c.query(
    `SELECT a.id, a.action, a.resource, a.record_code, a.created_at,
            COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS actor
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.tenant_id = $1 ORDER BY a.created_at DESC LIMIT 8`,
    [tenantId]
  );
  return {
    users: toCamelRow(users.rows[0] ?? {}),
    sessions: toCamelRow(sessions.rows[0] ?? {}),
    failedLogins24h: failed.rows[0]?.failed_24h ?? 0,
    roles: roles.rows[0]?.total ?? 0,
    activePolicies: policies.rows[0]?.active ?? 0,
    sodConflicts: sod.rows[0]?.active ?? 0,
    recentAudit: toCamelRows(audits.rows as Record<string, unknown>[]),
  };
}));

// ---- Users ----
adminRouter.get('/users', ...runGet('admin.users.view', async (c, ctx, q) => {
  const { page, pageSize, offset } = parsePagination(q);
  const conds: string[] = ['u.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (q.status && String(q.status) !== '') {
    params.push(String(q.status));
    conds.push(`u.status = $${params.length}`);
  }
  if (q.search && String(q.search) !== '') {
    params.push(`%${String(q.search).toLowerCase()}%`);
    conds.push(
      `(lower(u.email) LIKE $${params.length} OR lower(u.username) LIKE $${params.length}
        OR lower(u.first_name) LIKE $${params.length} OR lower(u.last_name) LIKE $${params.length}
        OR lower(emp.employee_no) LIKE $${params.length})`
    );
  }
  if (q.companyId && q.companyId !== '') {
    params.push(Number(q.companyId));
    conds.push(`u.company_id = $${params.length}`);
  }
  if (q.branchId && q.branchId !== '') {
    params.push(Number(q.branchId));
    conds.push(`u.branch_id = $${params.length}`);
  }
  if (q.departmentId && q.departmentId !== '') {
    params.push(Number(q.departmentId));
    conds.push(`u.department_id = $${params.length}`);
  }
  const where = conds.join(' AND ');
  const total = await c.query(
    `SELECT COUNT(*)::int AS total FROM users u LEFT JOIN employees emp ON emp.id = u.employee_id WHERE ${where}`,
    params
  );
  params.push(pageSize, offset);
  const rows = await c.query(
    `${USER_LIST_SQL} WHERE ${where} ORDER BY u.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const ids = rows.rows.map((r) => Number(r.id));
  const roleCounts = ids.length
    ? await c.query(
        'SELECT user_id, COUNT(*)::int AS role_count FROM user_roles WHERE user_id = ANY($1::bigint[]) GROUP BY user_id',
        [ids]
      )
    : { rows: [] as { user_id: unknown; role_count: unknown }[] };
  const counts = new Map(roleCounts.rows.map((r) => [Number(r.user_id), r.role_count]));
  const data = toCamelRows(rows.rows as Record<string, unknown>[]).map((r) => ({
    ...r,
    roleCount: counts.get(Number(r.id)) ?? 0,
  }));
  return { data, pagination: { page, pageSize, total: total.rows[0]?.total ?? 0 } };
}));

adminRouter.post('/users', ...run('admin.users.create', async (c, ctx, body) => {
  const email = String(body.email ?? '').trim().toLowerCase();
  const firstName = String(body.first_name ?? '').trim();
  const lastName = String(body.last_name ?? '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('A valid email address is required');
  if (!firstName || !lastName) throw badRequest('First and last name are required');
  const existing = await c.query('SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = $2', [ctx.tenantId, email]);
  if (existing.rows.length > 0) throw conflict(`A user with email ${email} already exists`);
  const username =
    body.username != null && String(body.username).trim() !== ''
      ? String(body.username).trim()
      : email.split('@')[0];
  const uname = await c.query('SELECT id FROM users WHERE tenant_id = $1 AND lower(username) = $2', [ctx.tenantId, username.toLowerCase()]);
  if (uname.rows.length > 0) throw conflict(`Username ${username} is already taken`);
  const inviteMode = b(body.invite) || String(body.status ?? '').toUpperCase() === 'INVITED';
  const rawStatus = inviteMode ? 'INVITED' : String(body.status ?? 'ACTIVE').toUpperCase();
  if (!USER_STATUSES.includes(rawStatus)) throw badRequest(`Invalid status ${rawStatus}`);
  const tempPassword = inviteMode ? null : randomBytes(9).toString('base64url');
  const effectiveHash = inviteMode
    ? await hashPassword(randomBytes(16).toString('hex'))
    : await hashPassword(tempPassword as string);
  const ins = await c.query(
    `INSERT INTO users (tenant_id, company_id, branch_id, department_id, employee_id, email, username,
                        password_hash, first_name, last_name, job_title, phone, status,
                        must_change_password, mfa_enabled)
     VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13,false)
     RETURNING id, email, username, first_name, last_name, job_title, phone, status,
               must_change_password, mfa_enabled, company_id, branch_id, department_id, created_at`,
    [
      ctx.tenantId, n(body.company_id) ?? ctx.companyId ?? null, n(body.branch_id) ?? ctx.branchId ?? null, n(body.department_id),
      email, username, effectiveHash, firstName, lastName, s(body.job_title), s(body.phone),
      rawStatus, inviteMode ? false : true,
    ]
  );
  const userId = Number(ins.rows[0].id);
  const requestedEmployeeId = n(body.employee_id) ?? n(body.employeeId);
  const matchedEmployeeId = requestedEmployeeId ?? await identityLink.findUnlinkedEmployeeByEmail(c, ctx, email);
  if (matchedEmployeeId) {
    await identityLink.linkUserEmployee(c, ctx, { userId, employeeId: Number(matchedEmployeeId) });
  }
  await c.query(
    `INSERT INTO user_status_history (tenant_id, user_id, from_status, to_status, reason, changed_by)
     VALUES ($1,$2,NULL,$3,$4,$5)`,
    [ctx.tenantId, userId, rawStatus, inviteMode ? 'Account created pending invitation acceptance' : 'Account provisioned', ctx.userId ?? null]
  );
  const roleIds = Array.isArray(body.role_ids)
    ? body.role_ids.map((r: unknown) => Number(r)).filter((r: number) => Number.isFinite(r) && r > 0)
    : [];
  for (const rid of roleIds) {
    await c.query(
      `INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
       SELECT $1, r.id, r.company_id, $3 FROM roles r WHERE r.id = $2 AND r.tenant_id = $4
       ON CONFLICT DO NOTHING`,
      [userId, rid, n(body.branch_id), ctx.tenantId]
    );
  }
  let invitationToken: string | null = null;
  if (inviteMode) {
    invitationToken = randomBytes(32).toString('base64url');
    await c.query(
      `INSERT INTO user_invitations (tenant_id, user_id, email, token_hash, company_id, branch_id, department_id, role_id, invited_by, expires_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + interval '7 days', 'PENDING')`,
      [
        ctx.tenantId, userId, email, hashToken(invitationToken),
        n(body.company_id), n(body.branch_id), n(body.department_id),
        roleIds[0] ?? null, ctx.userId ?? null,
      ]
    );
  }
  await logAudit(c, ctx, {
    action: inviteMode ? 'invite' : 'create',
    resource: 'users',
    recordId: userId,
    recordCode: email,
    metadata: { username, invite: inviteMode, roleIds },
  });
  return { user: toCamelRow(ins.rows[0] as Record<string, unknown>), tempPassword, invitationToken };
}));

adminRouter.get('/users/:id', ...runGet('admin.users.view', async (c, ctx, _q, p) => {
  const userId = Number(p.id);
  const user = await c.query(`${USER_LIST_SQL} WHERE u.id = $2 AND u.tenant_id = $1`, [ctx.tenantId, userId]);
  if (user.rows.length === 0) throw notFound('User not found');
  const row = user.rows[0] as Record<string, unknown>;
  const roles = await c.query(
    `SELECT r.id, r.code, r.name, ur.company_id, ur.branch_id
     FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 ORDER BY r.name`,
    [userId]
  );
  const profile = await c.query('SELECT * FROM user_profiles WHERE tenant_id = $1 AND user_id = $2', [ctx.tenantId, userId]);
  const history = await c.query(
    `SELECT hs.*, COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS changed_by_name
     FROM user_status_history hs LEFT JOIN users u ON u.id = hs.changed_by
     WHERE hs.tenant_id = $1 AND hs.user_id = $2 ORDER BY hs.created_at DESC LIMIT 20`,
    [ctx.tenantId, userId]
  );
  const sessions = await c.query(
    `SELECT id, ip, user_agent, device, mfa_verified_at, expires_at, revoked_at, created_at
     FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [userId]
  );
  const employee = await identityLink.getLinkedEmployee(c, ctx, userId);
  const matches = employee ? [] : await identityLink.suggestEmployeesForUser(c, ctx, userId);
  return {
    user: toCamelRow(row),
    employee,
    employeeMatches: matches,
    roles: toCamelRows(roles.rows as Record<string, unknown>[]),
    profile: profile.rows[0] ? toCamelRow(profile.rows[0] as Record<string, unknown>) : null,
    history: toCamelRows(history.rows as Record<string, unknown>[]),
    sessions: toCamelRows(sessions.rows as Record<string, unknown>[]),
  };
}));

adminRouter.get('/employees', ...runGet('admin.users.view', (c, ctx, q) => identityLink.searchEmployees(
  c,
  ctx,
  q.q != null ? String(q.q) : '',
  { unlinkedOnly: q.unlinked === '1' || q.unlinked === 'true' }
)));
adminRouter.post('/users/:id/link-employee', ...run('admin.users.update', (c, ctx, b, p) => identityLink.linkUserEmployee(c, ctx, {
  userId: Number(p.id),
  employeeId: Number(b.employeeId),
})));
adminRouter.post('/users/:id/unlink-employee', ...run('admin.users.update', (c, ctx, _b, p) => identityLink.unlinkUserEmployee(c, ctx, { userId: Number(p.id) })));

adminRouter.patch('/users/:id', ...run('admin.users.update', async (c, ctx, body, p) => {
  const userId = Number(p.id);
  const prev = await c.query('SELECT * FROM users WHERE id = $1 AND tenant_id = $2', [userId, ctx.tenantId]);
  if (prev.rows.length === 0) throw notFound('User not found');
  const prevRow = prev.rows[0] as Record<string, unknown>;
  const fields: string[] = [];
  const params: unknown[] = [userId, ctx.tenantId];
  const oldVals: Record<string, unknown> = {};
  const newVals: Record<string, unknown> = {};
  const textCols: [string, string][] = [
    ['first_name', 'first_name'],
    ['last_name', 'last_name'],
    ['job_title', 'job_title'],
    ['phone', 'phone'],
  ];
  const idCols: [string, string][] = [
    ['company_id', 'company_id'],
    ['branch_id', 'branch_id'],
    ['department_id', 'department_id'],
  ];
  for (const [k, col] of textCols) {
    if (body[k] !== undefined) {
      const val = s(body[k]);
      fields.push(`${col} = $${params.length + 1}`);
      params.push(val);
      oldVals[col] = prevRow[col] ?? null;
      newVals[col] = val;
    }
  }
  for (const [k, col] of idCols) {
    if (body[k] !== undefined) {
      const val = n(body[k]);
      fields.push(`${col} = $${params.length + 1}`);
      params.push(val);
      oldVals[col] = prevRow[col] ?? null;
      newVals[col] = val;
    }
  }
  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('A valid email address is required');
    const dup = await c.query('SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = $2 AND id <> $3', [ctx.tenantId, email, userId]);
    if (dup.rows.length > 0) throw conflict(`Email ${email} is already in use`);
    fields.push(`email = $${params.length + 1}`);
    params.push(email);
    oldVals.email = prevRow.email ?? null;
    newVals.email = email;
  }
  if (body.username !== undefined) {
    const username = String(body.username).trim();
    const dup = await c.query('SELECT id FROM users WHERE tenant_id = $1 AND lower(username) = $2 AND id <> $3', [ctx.tenantId, username.toLowerCase(), userId]);
    if (dup.rows.length > 0) throw conflict(`Username ${username} is already in use`);
    fields.push(`username = $${params.length + 1}`);
    params.push(username);
    oldVals.username = prevRow.username ?? null;
    newVals.username = username;
  }
  if (fields.length > 0) {
    fields.push('updated_at = now()');
    await c.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $1 AND tenant_id = $2`, params);
    await logAudit(c, ctx, {
      action: 'update',
      resource: 'users',
      recordId: userId,
      recordCode: String(prevRow.email ?? userId),
      oldValues: oldVals,
      newValues: newVals,
    });
  }
  const fresh = await c.query(`${USER_LIST_SQL} WHERE u.id = $2 AND u.tenant_id = $1`, [ctx.tenantId, userId]);
  return toCamelRow(fresh.rows[0] as Record<string, unknown>);
}));

adminRouter.post('/users/:id/activate', ...run('admin.users.activate', async (c, ctx, body, p) => {
  const userId = Number(p.id);
  await c.query('UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE id = $1 AND tenant_id = $2', [userId, ctx.tenantId]);
  const out = await recordStatusChange(c, ctx, userId, 'ACTIVE', s(body.reason) ?? 'Activated by administrator');
  return { ok: true, ...out };
}));

adminRouter.post('/users/:id/suspend', ...run('admin.users.suspend', async (c, ctx, body, p) => {
  const userId = Number(p.id);
  const out = await recordStatusChange(c, ctx, userId, 'SUSPENDED', s(body.reason) ?? 'Suspended by administrator');
  await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  return { ok: true, ...out };
}));

adminRouter.post('/users/:id/disable', ...run('admin.users.disable', async (c, ctx, body, p) => {
  const userId = Number(p.id);
  const out = await recordStatusChange(c, ctx, userId, 'DISABLED', s(body.reason) ?? 'Disabled by administrator');
  await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  return { ok: true, ...out };
}));

adminRouter.post('/users/:id/unlock', ...run('admin.users.activate', async (c, ctx, body, p) => {
  const userId = Number(p.id);
  const u = await c.query('SELECT status FROM users WHERE id = $1 AND tenant_id = $2', [userId, ctx.tenantId]);
  if (u.rows.length === 0) throw notFound('User not found');
  await c.query('UPDATE users SET locked_until = NULL, failed_attempts = 0, updated_at = now() WHERE id = $1', [userId]);
  const toStatus = u.rows[0].status === 'LOCKED' ? 'ACTIVE' : String(u.rows[0].status);
  await c.query(
    `INSERT INTO user_status_history (tenant_id, user_id, from_status, to_status, reason, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.tenantId, userId, String(u.rows[0].status), toStatus, s(body.reason) ?? 'Account unlocked', ctx.userId ?? null]
  );
  await logAudit(c, ctx, {
    action: 'unlock',
    resource: 'users',
    recordId: userId,
    oldValues: { locked_until: true },
    newValues: { locked_until: null },
    metadata: { reason: s(body.reason) ?? 'Account unlocked' },
  });
  return { ok: true, status: toStatus };
}));

adminRouter.post('/users/:id/reset_password', ...run('admin.users.reset_password', async (c, ctx, _body, p) => {
  const userId = Number(p.id);
  const u = await c.query('SELECT email, username FROM users WHERE id = $1 AND tenant_id = $2', [userId, ctx.tenantId]);
  if (u.rows.length === 0) throw notFound('User not found');
  const token = randomBytes(24).toString('base64url');
  await c.query(
    `INSERT INTO password_reset_tokens (tenant_id, user_id, token_hash, expires_at, created_by)
     VALUES ($1,$2,$3, now() + interval '24 hours', $4)`,
    [ctx.tenantId, userId, hashToken(token), ctx.userId ?? null]
  );
  await logAudit(c, ctx, {
    action: 'reset_password',
    resource: 'users',
    recordId: userId,
    recordCode: u.rows[0].email,
    metadata: { expires_in_hours: 24 },
  });
  return { token, expiresInHours: 24, email: u.rows[0].email, username: u.rows[0].username };
}));

adminRouter.post('/users/:id/mfa/reset', ...run('admin.users.update', async (c, ctx, _body, p) => {
  const userId = Number(p.id);
  const u = await c.query('SELECT email, mfa_enabled FROM users WHERE id = $1 AND tenant_id = $2', [userId, ctx.tenantId]);
  if (u.rows.length === 0) throw notFound('User not found');
  await c.query('UPDATE users SET mfa_enabled = false, mfa_secret = NULL, mfa_method = NULL, updated_at = now() WHERE id = $1', [userId]);
  await c.query('UPDATE mfa_methods SET is_active = false, verified_at = NULL WHERE user_id = $1', [userId]);
  await logAudit(c, ctx, {
    action: 'mfa_reset',
    resource: 'users',
    recordId: userId,
    recordCode: u.rows[0].email,
    oldValues: { mfa_enabled: u.rows[0].mfa_enabled },
    newValues: { mfa_enabled: false },
  });
  return { ok: true };
}));

adminRouter.post('/users/:id/roles', ...run('admin.users.assign_roles', async (c, ctx, body, p) => {
  const userId = Number(p.id);
  const u = await c.query('SELECT email FROM users WHERE id = $1 AND tenant_id = $2', [userId, ctx.tenantId]);
  if (u.rows.length === 0) throw notFound('User not found');
  const roleIds = Array.isArray(body.role_ids)
    ? body.role_ids.map((r: unknown) => Number(r)).filter((r: number) => Number.isFinite(r) && r > 0)
    : [];
  const single = n(body.role_id);
  if (single) roleIds.push(single);
  const unique = [...new Set(roleIds)];
  if (unique.length === 0) throw badRequest('role_id or role_ids is required');
  const roles = await c.query('SELECT id, code FROM roles WHERE id = ANY($1::int[]) AND tenant_id = $2', [unique, ctx.tenantId]);
  if (roles.rows.length !== unique.length) throw badRequest('One or more roles were not found');
  for (const rid of unique) {
    await c.query(
      `INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
       SELECT $1, r.id, r.company_id, $3 FROM roles r WHERE r.id = $2 AND r.tenant_id = $4
       ON CONFLICT DO NOTHING`,
      [userId, rid, n(body.branch_id), ctx.tenantId]
    );
  }
  await logAudit(c, ctx, {
    action: 'role_assign',
    resource: 'user_roles',
    recordId: userId,
    recordCode: u.rows[0].email,
    metadata: { role_ids: unique, role_codes: roles.rows.map((r: { code: string }) => r.code) },
  });
  return { ok: true, assigned: unique };
}));

adminRouter.delete('/users/:id/roles/:roleId', ...run('admin.users.assign_roles', async (c, ctx, _body, p) => {
  const userId = Number(p.id);
  const roleId = Number(p.roleId);
  const u = await c.query('SELECT email FROM users WHERE id = $1 AND tenant_id = $2', [userId, ctx.tenantId]);
  if (u.rows.length === 0) throw notFound('User not found');
  const res = await c.query(
    `DELETE FROM user_roles ur USING roles r
     WHERE r.id = ur.role_id AND r.tenant_id = $3 AND ur.user_id = $1 AND ur.role_id = $2`,
    [userId, roleId, ctx.tenantId]
  );
  await logAudit(c, ctx, {
    action: 'role_remove',
    resource: 'user_roles',
    recordId: userId,
    recordCode: u.rows[0].email,
    metadata: { role_id: roleId, removed: res.rowCount ?? 0 },
  });
  return { ok: true, removed: res.rowCount ?? 0 };
}));

// ---- Invitations ----
adminRouter.get('/invitations', ...runGet('admin.users.view', async (c, ctx, q) => {
  const { page, pageSize, offset } = parsePagination(q);
  const params: unknown[] = [ctx.tenantId];
  let where = 'i.tenant_id = $1';
  if (q.status && String(q.status) !== '') {
    params.push(String(q.status));
    where += ` AND i.status = $${params.length}`;
  }
  params.push(pageSize, offset);
  const total = await c.query(`SELECT COUNT(*)::int AS total FROM user_invitations i WHERE ${where}`, params.slice(0, -2));
  const rows = await c.query(
    `SELECT i.id, i.email, i.status, i.expires_at, i.accepted_at, i.revoked_at, i.created_at,
            COALESCE(NULLIF(TRIM(inv.first_name || ' ' || inv.last_name), ''), inv.email) AS invited_by_name,
            COALESCE(NULLIF(TRIM(usr.first_name || ' ' || usr.last_name), ''), usr.email) AS user_name
     FROM user_invitations i
     LEFT JOIN users inv ON inv.id = i.invited_by
     LEFT JOIN users usr ON usr.id = i.user_id
     WHERE ${where}
     ORDER BY i.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    data: toCamelRows(rows.rows as Record<string, unknown>[]),
    pagination: { page, pageSize, total: total.rows[0]?.total ?? 0 },
  };
}));

adminRouter.post('/invitations/:id/revoke', ...run('admin.users.invite', async (c, ctx, _body, p) => {
  const invitationId = Number(p.id);
  const inv = await c.query('SELECT * FROM user_invitations WHERE id = $1 AND tenant_id = $2', [invitationId, ctx.tenantId]);
  if (inv.rows.length === 0) throw notFound('Invitation not found');
  if (inv.rows[0].status === 'ACCEPTED') throw conflict('An accepted invitation cannot be revoked');
  await c.query('UPDATE user_invitations SET status = $1, revoked_at = now() WHERE id = $2', ['REVOKED', invitationId]);
  await logAudit(c, ctx, {
    action: 'revoke',
    resource: 'user_invitations',
    recordId: invitationId,
    recordCode: inv.rows[0].email,
    metadata: { user_id: inv.rows[0].user_id },
  });
  return { ok: true };
}));

// ---- Roles ----
adminRouter.get('/roles', ...runGet('admin.roles.view', async (c, ctx, q) => {
  const { page, pageSize, offset } = parsePagination(q);
  const params: unknown[] = [ctx.tenantId];
  let where = 'r.tenant_id = $1';
  if (q.companyId && q.companyId !== '') {
    params.push(Number(q.companyId));
    where += ` AND (r.company_id IS NULL OR r.company_id = $${params.length})`;
  }
  if (q.search && String(q.search) !== '') {
    params.push(`%${String(q.search).toLowerCase()}%`);
    where += ` AND (lower(r.name) LIKE $${params.length} OR lower(r.code) LIKE $${params.length})`;
  }
  params.push(pageSize, offset);
  const total = await c.query(`SELECT COUNT(*)::int AS total FROM roles r WHERE ${where}`, params.slice(0, -2));
  const rows = await c.query(
    `SELECT r.id, r.code, r.name, r.description, r.is_system, r.is_customizable, r.company_id,
            c.code AS company_code, c.name AS company_name, r.created_at, r.updated_at,
            (SELECT COUNT(*)::int FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count,
            (SELECT COUNT(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS user_count
     FROM roles r LEFT JOIN companies c ON c.id = r.company_id
     WHERE ${where}
     ORDER BY r.is_system DESC, r.name LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    data: toCamelRows(rows.rows as Record<string, unknown>[]),
    pagination: { page, pageSize, total: total.rows[0]?.total ?? 0 },
  };
}));

adminRouter.post('/roles', ...run('admin.roles.create', async (c, ctx, body) => {
  const code = String(body.code ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const name = String(body.name ?? '').trim();
  if (!code || !name) throw badRequest('code and name are required');
  const dup = await c.query('SELECT id FROM roles WHERE tenant_id = $1 AND lower(code) = $2', [ctx.tenantId, code]);
  if (dup.rows.length > 0) throw conflict(`Role code ${code} already exists`);
  const ins = await c.query(
    `INSERT INTO roles (tenant_id, company_id, code, name, description, is_system, is_customizable)
     VALUES ($1,$2,$3,$4,$5,false,true)
     RETURNING id, code, name, description, is_system, is_customizable, company_id, created_at`,
    [ctx.tenantId, n(body.company_id), code, name, s(body.description)]
  );
  await logAudit(c, ctx, {
    action: 'create',
    resource: 'roles',
    recordId: Number(ins.rows[0].id),
    recordCode: code,
    newValues: { code, name },
  });
  return toCamelRow(ins.rows[0] as Record<string, unknown>);
}));

adminRouter.patch('/roles/:id', ...run('admin.roles.update', async (c, ctx, body, p) => {
  const roleId = Number(p.id);
  const prev = await c.query('SELECT * FROM roles WHERE id = $1 AND tenant_id = $2', [roleId, ctx.tenantId]);
  if (prev.rows.length === 0) throw notFound('Role not found');
  const prevRow = prev.rows[0] as Record<string, unknown>;
  const fields: string[] = [];
  const params: unknown[] = [roleId, ctx.tenantId];
  const oldVals: Record<string, unknown> = {};
  const newVals: Record<string, unknown> = {};
  if (body.name !== undefined) {
    fields.push(`name = $${params.length + 1}`);
    params.push(String(body.name));
    oldVals.name = prevRow.name;
    newVals.name = String(body.name);
  }
  if (body.description !== undefined) {
    fields.push(`description = $${params.length + 1}`);
    params.push(s(body.description));
    oldVals.description = prevRow.description;
    newVals.description = s(body.description);
  }
  if (fields.length > 0) {
    fields.push('updated_at = now()');
    await c.query(`UPDATE roles SET ${fields.join(', ')} WHERE id = $1 AND tenant_id = $2`, params);
    await logAudit(c, ctx, {
      action: 'update',
      resource: 'roles',
      recordId: roleId,
      recordCode: String(prevRow.code),
      oldValues: oldVals,
      newValues: newVals,
    });
  }
  const fresh = await c.query('SELECT * FROM roles WHERE id = $1', [roleId]);
  return toCamelRow(fresh.rows[0] as Record<string, unknown>);
}));

adminRouter.get('/roles/:id/permissions', ...runGet('admin.roles.view', async (c, ctx, _q, p) => {
  const roleId = Number(p.id);
  const role = await c.query('SELECT id, code FROM roles WHERE id = $1 AND tenant_id = $2', [roleId, ctx.tenantId]);
  if (role.rows.length === 0) throw notFound('Role not found');
  const rows = await c.query(
    `SELECT p.id, p.code, p.module, p.resource, p.action, p.description
     FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = $1 ORDER BY p.module, p.resource, p.action`,
    [roleId]
  );
  return toCamelRows(rows.rows as Record<string, unknown>[]);
}));

adminRouter.post('/roles/:id/permissions', ...run('admin.permissions.assign', async (c, ctx, body, p) => {
  const roleId = Number(p.id);
  const role = await c.query('SELECT id, code FROM roles WHERE id = $1 AND tenant_id = $2', [roleId, ctx.tenantId]);
  if (role.rows.length === 0) throw notFound('Role not found');
  const codes = Array.isArray(body.permissions)
    ? body.permissions.map((x: unknown) => String(x)).filter((x: string) => x.length > 0)
    : [];
  const permRows = codes.length
    ? await c.query('SELECT id, code FROM permissions WHERE code = ANY($1::text[])', [codes])
    : { rows: [] as { id: unknown; code: string }[] };
  const permIds = permRows.rows.map((r) => Number(r.id));
  await c.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
  for (const pid of permIds) {
    await c.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [roleId, pid]);
  }
  await logAudit(c, ctx, {
    action: 'permissions_set',
    resource: 'roles',
    recordId: roleId,
    recordCode: role.rows[0].code,
    metadata: { permissions: permRows.rows.map((r) => r.code) },
  });
  return { ok: true, assigned: permRows.rows.map((r) => r.code) };
}));

// ---- Permissions catalogue ----
adminRouter.get('/permissions', ...runGet('admin.permissions.view', async (c, ctx, q) => {
  const params: unknown[] = [];
  let where = '1=1';
  if (q.module && String(q.module) !== '') {
    params.push(String(q.module));
    where += ` AND module = $${params.length}`;
  }
  if (q.search && String(q.search) !== '') {
    params.push(`%${String(q.search).toLowerCase()}%`);
    where += ` AND lower(code) LIKE $${params.length}`;
  }
  const rows = await c.query(
    `SELECT id, code, module, resource, action, description
     FROM permissions WHERE ${where} ORDER BY module, resource, action`,
    params
  );
  return toCamelRows(rows.rows as Record<string, unknown>[]);
}));

// ---- ABAC policies ----
adminRouter.get('/policies', ...runGet('admin.policies.view', async (c, ctx, q) => {
  const { page, pageSize, offset } = parsePagination(q);
  const params: unknown[] = [ctx.tenantId];
  let where = 'p.tenant_id = $1';
  if (q.active === '1' || q.active === 'true') where += ' AND p.is_active = true';
  if (q.search && String(q.search) !== '') {
    params.push(`%${String(q.search).toLowerCase()}%`);
    where += ` AND (lower(p.code) LIKE $${params.length} OR lower(p.name) LIKE $${params.length})`;
  }
  params.push(pageSize, offset);
  const total = await c.query(`SELECT COUNT(*)::int AS total FROM policies p WHERE ${where}`, params.slice(0, -2));
  const rows = await c.query(
    `SELECT p.id, p.code, p.name, p.description, p.effect, p.priority, p.is_active, p.created_at, p.updated_at,
            COALESCE(
              (SELECT jsonb_agg(jsonb_build_object(
                 'id', pc.id, 'attributeType', pc.attribute_type, 'attribute', pc.attribute,
                 'operator', pc.operator, 'value', pc.value) ORDER BY pc.id)
               FROM policy_conditions pc WHERE pc.policy_id = p.id), '[]'::jsonb) AS conditions
     FROM policies p WHERE ${where}
     ORDER BY p.priority, p.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const data = (toCamelRows(rows.rows as Record<string, unknown>[]) as Record<string, unknown>[]).map((row) => {
    if (typeof row.effect === 'string') row.effect = row.effect.toUpperCase();
    return row;
  });
  return {
    data,
    pagination: { page, pageSize, total: total.rows[0]?.total ?? 0 },
  };
}));

async function writePolicyConditions(client: pg.PoolClient, tenantId: number | null | undefined, policyId: number, conditions: unknown) {
  await client.query('DELETE FROM policy_conditions WHERE policy_id = $1', [policyId]);
  const attrs: Record<'SUBJECT' | 'RESOURCE' | 'ENVIRONMENT', Record<string, unknown>> = {
    SUBJECT: {},
    RESOURCE: {},
    ENVIRONMENT: {},
  };
  if (Array.isArray(conditions)) {
    const validOps = ['EQUALS', 'NOT_EQUALS', 'IN', 'NOT_IN', 'GREATER_THAN', 'LESS_THAN', 'BETWEEN', 'EXISTS', 'NOT_EXISTS'];
    const validTypes = ['SUBJECT', 'RESOURCE', 'ENVIRONMENT'];
    for (const cond of conditions) {
      const c2 = (cond ?? {}) as Record<string, unknown>;
      const attributeType = String(c2.attributeType ?? c2.attribute_type ?? '').toUpperCase();
      const operator = String(c2.operator ?? '').toUpperCase();
      const attribute = String(c2.attribute ?? '');
      if (!validTypes.includes(attributeType)) throw badRequest(`Invalid condition attribute type: ${attributeType}`);
      if (!validOps.includes(operator)) throw badRequest(`Invalid condition operator: ${operator}`);
      if (!attribute) throw badRequest('Each condition requires an attribute');
      const value = c2.value === undefined ? null : (c2.value as unknown);
      await client.query(
        `INSERT INTO policy_conditions (tenant_id, policy_id, attribute_type, attribute, operator, value)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [tenantId ?? null, policyId, attributeType, attribute, operator, value === null ? null : JSON.stringify(value)]
      );
      // Keep the JSONB form consumed by the ABAC engine (middleware/authorize.ts)
      // in sync with the policy_conditions rows so UI-configured rules are enforced.
      const target = attrs[attributeType as 'SUBJECT' | 'RESOURCE' | 'ENVIRONMENT'];
      switch (operator) {
        case 'EQUALS': target[attribute] = { $eq: value }; break;
        case 'NOT_EQUALS': target[attribute] = { $ne: value }; break;
        case 'IN': target[attribute] = { $in: value }; break;
        case 'NOT_IN': target[attribute] = { $outside: value }; break;
        case 'GREATER_THAN': target[attribute] = { $gt: value }; break;
        case 'LESS_THAN': target[attribute] = { $lt: value }; break;
        case 'BETWEEN': target[attribute] = { $between: value }; break;
        case 'EXISTS': target[attribute] = { $exists: value ?? true }; break;
        case 'NOT_EXISTS': target[attribute] = { $missing: true }; break;
      }
    }
  }
  await client.query(
    `UPDATE policies SET subject_attributes = $1, resource_attributes = $2, environment_attributes = $3,
            updated_at = now()
     WHERE id = $4`,
    [JSON.stringify(attrs.SUBJECT), JSON.stringify(attrs.RESOURCE), JSON.stringify(attrs.ENVIRONMENT), policyId]
  );
}

adminRouter.post('/policies', ...run('admin.policies.create', async (c, ctx, body) => {
  const code = String(body.code ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const name = String(body.name ?? '').trim();
  const effect = String(body.effect ?? 'allow').toLowerCase();
  if (!code || !name) throw badRequest('code and name are required');
  if (!['allow', 'deny'].includes(effect)) throw badRequest('effect must be ALLOW or DENY');
  if (effect === 'deny' && !(Array.isArray(body.conditions) && body.conditions.length > 0)) {
    throw badRequest('A DENY policy with no conditions would block all access. Add at least one condition before saving.');
  }
  const dup = await c.query('SELECT id FROM policies WHERE tenant_id = $1 AND lower(code) = $2', [ctx.tenantId, code]);
  if (dup.rows.length > 0) throw conflict(`Policy code ${code} already exists`);
  const ins = await c.query(
    `INSERT INTO policies (tenant_id, code, name, description, effect, priority, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,true)
     RETURNING id, code, name, effect, priority, is_active`,
    [ctx.tenantId, code, name, s(body.description), effect, n(body.priority) ?? 100]
  );
  const policyId = Number(ins.rows[0].id);
  await writePolicyConditions(c, ctx.tenantId, policyId, body.conditions);
  await logAudit(c, ctx, {
    action: 'create',
    resource: 'policies',
    recordId: policyId,
    recordCode: code,
    newValues: { name, effect },
  });
  const created = toCamelRow(ins.rows[0] as Record<string, unknown>) as Record<string, unknown>;
  created.effect = String(created.effect ?? '').toUpperCase();
  return created;
}));

adminRouter.patch('/policies/:id', ...run('admin.policies.update', async (c, ctx, body, p) => {
  const policyId = Number(p.id);
  const prev = await c.query('SELECT * FROM policies WHERE id = $1 AND tenant_id = $2', [policyId, ctx.tenantId]);
  if (prev.rows.length === 0) throw notFound('Policy not found');
  const prevRow = prev.rows[0] as Record<string, unknown>;
  const fields: string[] = [];
  const params: unknown[] = [policyId, ctx.tenantId];
  const oldVals: Record<string, unknown> = {};
  const newVals: Record<string, unknown> = {};
  const updates: [string, unknown][] = [
    ['name', body.name !== undefined ? String(body.name) : undefined],
    ['description', body.description !== undefined ? s(body.description) : undefined],
    ['effect', body.effect !== undefined ? String(body.effect).toLowerCase() : undefined],
    ['priority', body.priority !== undefined ? n(body.priority) : undefined],
    ['is_active', body.is_active !== undefined ? b(body.is_active) : undefined],
  ];
  for (const [col, val] of updates) {
    if (val !== undefined) {
      fields.push(`${col} = $${params.length + 1}`);
      params.push(val);
      oldVals[col] = prevRow[col] ?? null;
      newVals[col] = val;
    }
  }
  if (fields.length > 0) {
    fields.push('updated_at = now()');
    await c.query(`UPDATE policies SET ${fields.join(', ')} WHERE id = $1 AND tenant_id = $2`, params);
  }
  const nextEffect = body.effect !== undefined ? String(body.effect).toLowerCase() : String(prevRow.effect).toLowerCase();
  if (nextEffect === 'deny') {
    const hasConditions =
      body.conditions !== undefined
        ? Array.isArray(body.conditions) && body.conditions.length > 0
        : (await c.query('SELECT COUNT(*)::int AS n FROM policy_conditions WHERE policy_id = $1', [policyId])).rows[0].n > 0;
    if (!hasConditions) {
      throw badRequest('A DENY policy with no conditions would block all access. Add at least one condition before saving.');
    }
  }
  if (body.conditions !== undefined) {
    await writePolicyConditions(c, ctx.tenantId, policyId, body.conditions);
  }
  await logAudit(c, ctx, {
    action: 'update',
    resource: 'policies',
    recordId: policyId,
    recordCode: String(prevRow.code),
    oldValues: oldVals,
    newValues: newVals,
  });
  const fresh = await c.query('SELECT * FROM policies WHERE id = $1', [policyId]);
  const updated = toCamelRow(fresh.rows[0] as Record<string, unknown>) as Record<string, unknown>;
  updated.effect = String(updated.effect ?? '').toUpperCase();
  return updated;
}));

adminRouter.post('/policies/:id/activate', ...run('admin.policies.update', async (c, ctx, body, p) => {
  const policyId = Number(p.id);
  const prev = await c.query('SELECT code, is_active FROM policies WHERE id = $1 AND tenant_id = $2', [policyId, ctx.tenantId]);
  if (prev.rows.length === 0) throw notFound('Policy not found');
  const active = b(body.is_active) ?? !prev.rows[0].is_active;
  await c.query('UPDATE policies SET is_active = $1, updated_at = now() WHERE id = $2', [active, policyId]);
  await logAudit(c, ctx, {
    action: active ? 'activate' : 'deactivate',
    resource: 'policies',
    recordId: policyId,
    recordCode: prev.rows[0].code,
    oldValues: { is_active: prev.rows[0].is_active },
    newValues: { is_active: active },
  });
  return { ok: true, is_active: active };
}));

// ---- Segregation of duties ----
adminRouter.get('/sod/rules', ...runGet('admin.sod.view', async (c, ctx) => {
  const rows = await c.query(
    `SELECT s.*, p1.code AS primary_label, p2.code AS conflicting_label
     FROM sod_rules s
     LEFT JOIN permissions p1 ON p1.code = s.primary_permission
     LEFT JOIN permissions p2 ON p2.code = s.conflicting_permission
     WHERE s.tenant_id = $1 ORDER BY s.is_active DESC, s.name`,
    [ctx.tenantId]
  );
  return toCamelRows(rows.rows as Record<string, unknown>[]);
}));

adminRouter.post('/sod/rules', ...run('admin.sod.create', async (c, ctx, body) => {
  const code = String(body.code ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const name = String(body.name ?? '').trim();
  const primary = String(body.primary_permission ?? '').trim();
  const conflicting = String(body.conflicting_permission ?? '').trim();
  if (!code || !name || !primary || !conflicting) throw badRequest('code, name, primary_permission and conflicting_permission are required');
  if (primary === conflicting) throw badRequest('Primary and conflicting permissions must differ');
  const dup = await c.query('SELECT id FROM sod_rules WHERE tenant_id = $1 AND lower(code) = $2', [ctx.tenantId, code]);
  if (dup.rows.length > 0) throw conflict(`SoD rule ${code} already exists`);
  const enforcement = String(body.enforcement ?? 'hard').toLowerCase() === 'soft' ? 'soft' : 'hard';
  const ins = await c.query(
    `INSERT INTO sod_rules (tenant_id, code, name, description, primary_permission, conflicting_permission, enforcement, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true)
     RETURNING id, code, name, primary_permission, conflicting_permission, enforcement, is_active`,
    [ctx.tenantId, code, name, s(body.description), primary, conflicting, enforcement]
  );
  await logAudit(c, ctx, {
    action: 'create',
    resource: 'sod_rules',
    recordId: Number(ins.rows[0].id),
    recordCode: code,
    newValues: { primary_permission: primary, conflicting_permission: conflicting, enforcement },
  });
  return toCamelRow(ins.rows[0] as Record<string, unknown>);
}));

adminRouter.get('/sod/conflicts', ...runGet('admin.sod.view', async (c, ctx) => {
  const activeRules = await c.query(
    'SELECT * FROM sod_rules WHERE tenant_id = $1 AND is_active = true',
    [ctx.tenantId]
  );
  for (const rule of activeRules.rows) {
    const hits = await c.query(
      `SELECT ur.user_id
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE p.code = $1
       INTERSECT
       SELECT ur2.user_id
       FROM user_roles ur2
       JOIN role_permissions rp2 ON rp2.role_id = ur2.role_id
       JOIN permissions p2 ON p2.id = rp2.permission_id
       WHERE p2.code = $2`,
      [rule.primary_permission, rule.conflicting_permission]
    );
    for (const hit of hits.rows) {
      await c.query(
        `INSERT INTO sod_conflicts (tenant_id, user_id, sod_rule_id, severity, status, details, detected_at)
         SELECT $1, $2, $3, 'HIGH', 'ACTIVE_CONFLICT', jsonb_build_object('rule_code', $4::text, 'rule_name', $5::text), now()
         WHERE NOT EXISTS (
           SELECT 1 FROM sod_conflicts sc
           WHERE sc.tenant_id = $1 AND sc.user_id = $2 AND sc.sod_rule_id = $3 AND sc.status = 'ACTIVE_CONFLICT'
         )`,
        [ctx.tenantId, Number(hit.user_id), Number(rule.id), rule.code, rule.name]
      );
    }
  }
  const rows = await c.query(
    `SELECT sc.id, sc.user_id, sc.sod_rule_id, sc.severity, sc.status, sc.details, sc.detected_at, sc.resolved_at,
            COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS user_name,
            u.email AS user_email,
            sr.code AS rule_code, sr.name AS rule_name,
            sr.primary_permission, sr.conflicting_permission, sr.enforcement
     FROM sod_conflicts sc
     JOIN users u ON u.id = sc.user_id
     JOIN sod_rules sr ON sr.id = sc.sod_rule_id
     WHERE sc.tenant_id = $1
     ORDER BY CASE sc.status WHEN 'ACTIVE_CONFLICT' THEN 0 WHEN 'POTENTIAL_CONFLICT' THEN 1 ELSE 2 END, sc.detected_at DESC`,
    [ctx.tenantId]
  );
  return toCamelRows(rows.rows as Record<string, unknown>[]);
}));

// ---- Security events ----
adminRouter.get('/security/events', ...runGet('admin.security.view', async (c, ctx, q) => {
  const { page, pageSize } = parsePagination(q);
  const where = ['e.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (typeof q.severity === 'string' && q.severity) {
    params.push(q.severity);
    where.push(`e.severity = $${params.length}`);
  }
  if (typeof q.event_type === 'string' && q.event_type) {
    params.push(q.event_type);
    where.push(`e.event_type = $${params.length}`);
  }
  if (typeof q.user_id === 'string' && q.user_id) {
    params.push(Number(q.user_id));
    where.push(`e.user_id = $${params.length}`);
  }
  const cond = where.join(' AND ');
  const total = await c.query(`SELECT count(*)::int AS n FROM security_events e WHERE ${cond}`, params);
  params.push(pageSize, (page - 1) * pageSize);
  const rows = await c.query(
    `SELECT e.id, e.event_type, e.severity, e.ip, e.user_agent, e.device, e.details, e.created_at,
            COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS user_name,
            u.email AS user_email
     FROM security_events e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE ${cond}
     ORDER BY e.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: toCamelRows(rows.rows as Record<string, unknown>[]), pagination: { page, pageSize, total: total.rows[0].n } };
}));

// ---- Feature management ----
adminRouter.get('/features', ...runGet('admin.feature_flags.view', async (c, ctx) => {
  const rows = await c.query(
    `SELECT f.id, f.module, f.feature, f.enabled, f.environment, f.rollout, f.effective_from, f.effective_to,
            f.created_at, f.updated_at,
            c.code AS company_code, c.name AS company_name,
            b.code AS branch_code, b.name AS branch_name
     FROM feature_flags f
     LEFT JOIN companies c ON c.id = f.company_id
     LEFT JOIN branches b ON b.id = f.branch_id
     WHERE f.tenant_id = $1
     ORDER BY f.module, f.feature`,
    [ctx.tenantId]
  );
  return toCamelRows(rows.rows as Record<string, unknown>[]);
}));

adminRouter.post('/features', ...run('admin.feature_flags.update', async (c, ctx, body) => {
  const module = String(body.module ?? '').trim();
  const feature = String(body.feature ?? '').trim();
  if (!module || !feature) throw badRequest('module and feature are required');
  const companyId = n(body.company_id);
  const branchId = n(body.branch_id);
  const enabled = b(body.enabled) ?? true;
  const rollout = Math.max(0, Math.min(100, Number(body.rollout) || 100));
  const environment = s(body.environment);
  const effectiveFrom = s(body.effective_from);
  const effectiveTo = s(body.effective_to);
  const existing = await c.query(
    `SELECT id FROM feature_flags
     WHERE tenant_id = $1 AND module = $2 AND feature = $3
       AND (company_id = $4 OR (company_id IS NULL AND $4 IS NULL))
       AND (branch_id = $5 OR (branch_id IS NULL AND $5 IS NULL))`,
    [ctx.tenantId, module, feature, companyId, branchId]
  );
  let flagId: number;
  if (existing.rows.length > 0) {
    flagId = Number(existing.rows[0].id);
    await c.query(
      `UPDATE feature_flags
       SET enabled = $1, environment = $2, rollout = $3, effective_from = $4, effective_to = $5, updated_at = now()
       WHERE id = $6`,
      [enabled, environment, rollout, effectiveFrom, effectiveTo, flagId]
    );
  } else {
    const ins = await c.query(
      `INSERT INTO feature_flags (tenant_id, company_id, branch_id, module, feature, enabled, environment, rollout, effective_from, effective_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [ctx.tenantId, companyId, branchId, module, feature, enabled, environment, rollout, effectiveFrom, effectiveTo, ctx.userId ?? null]
    );
    flagId = Number(ins.rows[0].id);
  }
  await logAudit(c, ctx, {
    action: 'update',
    resource: 'feature_flags',
    recordId: flagId,
    recordCode: `${module}.${feature}`,
    newValues: { enabled, rollout, environment },
  });
  return { id: flagId, module, feature, enabled, rollout, environment };
}));

// ---- Platform health ----
adminRouter.get('/health', ...runGet('admin.health.view', async (c, ctx) => {
  const [components, jobs, dbStats] = await Promise.all([
    c.query(
      `SELECT DISTINCT ON (component) component, status, detail, checked_at
       FROM system_health_logs WHERE tenant_id = $1
       ORDER BY component, checked_at DESC`,
      [ctx.tenantId]
    ),
    c.query(
      `SELECT status, count(*)::int AS n FROM background_jobs WHERE tenant_id = $1 GROUP BY status`,
      [ctx.tenantId]
    ),
    c.query(
      `SELECT (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS tables,
              (SELECT count(*)::int FROM pg_stat_activity) AS connections,
              (SELECT pg_size_pretty(pg_database_size(current_database()))) AS db_size`
    ),
  ]);
  const jobMap: Record<string, number> = {};
  for (const r of jobs.rows) jobMap[String(r.status)] = Number(r.n);
  return {
    components: toCamelRows(components.rows as Record<string, unknown>[]),
    jobs: jobMap,
    database: toCamelRow(dbStats.rows[0] as Record<string, unknown>),
    checked_at: nowIso(),
  };
}));

// ---- Backups & restore ----
adminRouter.get('/backups', ...runGet('admin.backups.view', async (c, ctx) => {
  const rows = await c.query(
    `SELECT id, backup_id, backup_type, scope, started_at, completed_at, status, size_bytes,
            retention_days, encrypted, created_at
     FROM backup_records WHERE tenant_id = $1
     ORDER BY started_at DESC LIMIT 200`,
    [ctx.tenantId]
  );
  return toCamelRows(rows.rows as Record<string, unknown>[]);
}));

adminRouter.post('/backups/:id/restore', ...run('admin.backups.restore', async (c, ctx, body, p) => {
  const backupId = Number(p.id);
  const bk = await c.query('SELECT backup_id FROM backup_records WHERE id = $1 AND tenant_id = $2', [backupId, ctx.tenantId]);
  if (bk.rows.length === 0) throw notFound('Backup record not found');
  const reason = String(body.reason ?? '').trim();
  if (!reason) throw badRequest('A restore reason is required');
  const ins = await c.query(
    `INSERT INTO restore_requests (tenant_id, requested_by, backup_id, reason, risk_confirmed_at, status)
     VALUES ($1, $2, $3, $4, now(), 'PENDING') RETURNING id`,
    [ctx.tenantId, ctx.userId ?? null, backupId, reason]
  );
  await logAudit(c, ctx, {
    action: 'request_restore',
    resource: 'restore_requests',
    recordId: Number(ins.rows[0].id),
    recordCode: bk.rows[0].backup_id,
    metadata: { reason },
  });
  return { id: Number(ins.rows[0].id), status: 'PENDING', backupId: bk.rows[0].backup_id };
}));

// ---- System settings (reuses the settings catalogue, writes configuration history) ----
const ADMIN_SETTINGS_SQL = `
  SELECT a.category, a.key, a.value, a.updated_at,
         COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS updated_by
  FROM app_settings a
  LEFT JOIN users u ON u.id = a.updated_by
  WHERE a.tenant_id = $1 AND (a.company_id = $2 OR (a.company_id IS NULL AND $2 IS NULL))
  ORDER BY a.category, a.updated_at DESC
`;

function adminSettingsPayload(categoryId: string, rows: Record<string, unknown>[]) {
  const catDef = SETTINGS[categoryId] ?? {};
  const catRows = rows.filter((r) => r.category === categoryId);
  const stored = new Map(catRows.map((r) => [String(r.key), r]));
  const latest = catRows[0] ?? null;
  return {
    category: categoryId,
    label: SETTING_CATEGORIES.find((c) => c.id === categoryId)?.label ?? categoryId,
    blurb: SETTING_CATEGORIES.find((c) => c.id === categoryId)?.blurb ?? '',
    meta: { updated_at: latest?.updated_at ?? null, updated_by: latest?.updated_by ?? null },
    settings: Object.fromEntries(
      Object.entries(catDef).map(([key, def]) => {
        const row = stored.get(key);
        return [
          key,
          {
            value: row ? row.value : (def.default ?? null),
            default: def.default ?? null,
            label: def.label,
            help: def.help ?? null,
            type: def.type,
            options: def.options ?? null,
            secret: def.secret ?? false,
            group: def.group ?? null,
            saved: Boolean(row),
          },
        ];
      })
    ),
  };
}

adminRouter.get('/settings', ...runGet('admin.settings.view', async (c, ctx) => {
  const companyId = ctx.companyId ?? null;
  const stored = await c.query(ADMIN_SETTINGS_SQL, [ctx.tenantId, companyId]);
  return SETTING_CATEGORIES.map((cat) => adminSettingsPayload(cat.id, stored.rows as Record<string, unknown>[]));
}));

adminRouter.patch('/settings', ...run('admin.settings.update', async (c, ctx, body) => {
  const category = String(body.category ?? '').trim();
  const values = body.values;
  const catDef = SETTINGS[category];
  if (!catDef) throw badRequest(`Unknown settings category: ${category}`);
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw badRequest('Expected { category, values }');
  const companyId = ctx.companyId ?? null;
  const changes: { key: string; old: unknown; new: unknown }[] = [];
  for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
    const def = catDef[key];
    if (!def) throw badRequest(`Unknown setting: ${category}.${key}`);
    let val: unknown;
    if (def.type === 'boolean') {
      if (typeof raw !== 'boolean') throw badRequest(`Setting ${category}.${key} must be a boolean`);
      val = raw;
    } else if (def.type === 'number') {
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (raw === null || raw === undefined || raw === '' || !Number.isFinite(num)) {
        throw badRequest(`Setting ${category}.${key} must be a number`);
      }
      val = num;
    } else {
      val = raw == null ? '' : String(raw);
    }
    const prev = await c.query(
      `SELECT value FROM app_settings
       WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
         AND category = $3 AND key = $4
       ORDER BY (company_id IS NOT NULL) DESC LIMIT 1`,
      [ctx.tenantId, companyId, category, key]
    );
    const oldValue = prev.rows[0]?.value ?? def.default ?? null;
    await c.query(
      `INSERT INTO app_settings (tenant_id, company_id, category, key, value, is_secret, updated_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (tenant_id, company_id, category, key)
       DO UPDATE SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret,
                     updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ctx.tenantId, companyId, category, key, JSON.stringify(val), def.secret ?? false, ctx.userId ?? null]
    );
    const histOld = def.secret ? '[REDACTED]' : oldValue;
    const histNew = def.secret ? '[REDACTED]' : val;
    await c.query(
      `INSERT INTO configuration_history (tenant_id, user_id, category, config_key, old_value, new_value, ip)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [ctx.tenantId, ctx.userId ?? null, `settings.${category}`, key, JSON.stringify(histOld), JSON.stringify(histNew), ctx.ip ?? null]
    );
    changes.push({ key, old: oldValue, new: val });
  }
  await logAudit(c, ctx, {
    action: 'update',
    resource: `settings.${category}`,
    metadata: { keys: changes.map((ch) => ch.key) },
    oldValues: Object.fromEntries(changes.map((ch) => [ch.key, ch.old])),
    newValues: Object.fromEntries(changes.map((ch) => [ch.key, ch.new])),
  });
  const stored = await c.query(ADMIN_SETTINGS_SQL, [ctx.tenantId, companyId]);
  return adminSettingsPayload(category, stored.rows as Record<string, unknown>[]);
}));

// ---- Sessions ----
adminRouter.get('/sessions', ...runGet('admin.sessions.view', async (c, ctx, q) => {
  const { page, pageSize } = parsePagination(q);
  const where = ['u.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (typeof q.user_id === 'string' && q.user_id) {
    params.push(Number(q.user_id));
    where.push(`s.user_id = $${params.length}`);
  }
  if (q.active === true || q.active === 'true') where.push('s.revoked_at IS NULL AND s.expires_at > now()');
  const cond = where.join(' AND ');
  const total = await c.query(
    `SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE ${cond}`,
    params
  );
  params.push(pageSize, (page - 1) * pageSize);
  const rows = await c.query(
    `SELECT s.id, s.user_id, s.device, s.ip, s.user_agent, s.mfa_verified_at, s.expires_at, s.revoked_at, s.created_at,
            COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS user_name,
            u.email AS user_email,
            (s.revoked_at IS NULL AND s.expires_at > now()) AS is_active
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE ${cond}
     ORDER BY s.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: toCamelRows(rows.rows as Record<string, unknown>[]), pagination: { page, pageSize, total: total.rows[0].n } };
}));

adminRouter.post('/sessions/:id/revoke', ...run('admin.sessions.revoke', async (c, ctx, _b, p) => {
  const sessionId = Number(p.id);
  const res = await c.query(
    `UPDATE sessions s SET revoked_at = now()
     FROM users u
     WHERE u.id = s.user_id AND u.tenant_id = $1 AND s.id = $2 AND s.revoked_at IS NULL`,
    [ctx.tenantId, sessionId]
  );
  if ((res.rowCount ?? 0) === 0) throw notFound('Active session not found');
  await logAudit(c, ctx, { action: 'revoke', resource: 'sessions', recordId: sessionId });
  return { ok: true, id: sessionId };
}));

adminRouter.post('/sessions/revoke-all', ...run('admin.users.revoke_sessions', async (c, ctx, body) => {
  const userId = n(body.user_id);
  const params: unknown[] = [ctx.tenantId];
  let userClause = '';
  if (userId) {
    params.push(userId);
    userClause = ` AND s.user_id = $${params.length}`;
  }
  const res = await c.query(
    `UPDATE sessions s SET revoked_at = now()
     FROM users u
     WHERE u.id = s.user_id AND u.tenant_id = $1 AND s.revoked_at IS NULL${userClause}`,
    params
  );
  await logAudit(c, ctx, {
    action: 'revoke_all',
    resource: 'sessions',
    metadata: { user_id: userId ?? null, count: res.rowCount ?? 0 },
  });
  return { ok: true, revoked: res.rowCount ?? 0 };
}));

// ---- Audit logs ----
adminRouter.get('/audit-logs', ...runGet('admin.audit_logs.view', async (c, ctx, q) => {
  const { page, pageSize } = parsePagination(q);
  const where = ['a.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (typeof q.user_id === 'string' && q.user_id) {
    params.push(Number(q.user_id));
    where.push(`a.user_id = $${params.length}`);
  }
  if (typeof q.action === 'string' && q.action) {
    params.push(q.action);
    where.push(`a.action = $${params.length}`);
  }
  if (typeof q.resource === 'string' && q.resource) {
    params.push(q.resource);
    where.push(`a.resource = $${params.length}`);
  }
  if (typeof q.from === 'string' && q.from) {
    params.push(q.from);
    where.push(`a.created_at >= $${params.length}::timestamptz`);
  }
  if (typeof q.to === 'string' && q.to) {
    params.push(q.to);
    where.push(`a.created_at < ($${params.length}::timestamptz + interval '1 day')`);
  }
  const cond = where.join(' AND ');
  const total = await c.query(`SELECT count(*)::int AS n FROM audit_logs a WHERE ${cond}`, params);
  params.push(pageSize, (page - 1) * pageSize);
  const rows = await c.query(
    `SELECT a.id, a.action, a.resource, a.record_id, a.record_code, a.old_values, a.new_values,
            a.ip, a.metadata, a.created_at,
            COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS actor,
            u.email AS actor_email
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE ${cond}
     ORDER BY a.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: toCamelRows(rows.rows as Record<string, unknown>[]), pagination: { page, pageSize, total: total.rows[0].n } };
}));
