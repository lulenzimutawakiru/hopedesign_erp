import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../auth.js';
import { query } from '../db.js';
import { AuthUser } from '../types.js';
import { unauthorized } from '../utils.js';
type ActingRoleSummary = NonNullable<AuthUser['actingRoles']>[number];

const USER_SQL = `
  SELECT u.id, u.tenant_id, u.company_id, u.default_company_id, u.default_branch_id, u.branch_id, u.department_id, u.division_id, u.requesting_location_id, u.cost_centre_id, u.project_id, u.budget_id, u.fiscal_year_id, u.employee_id, u.email, u.username,
         u.first_name, u.last_name, u.job_title, u.status, u.must_change_password,
         u.mfa_enabled, u.mfa_method, u.personal_email, u.personal_email_verified_at, u.attributes
  FROM users u WHERE u.id = $1
`;

const ROLES_SQL = `
  SELECT r.id AS role_id, r.code AS role_code, ur.company_id, ur.branch_id
  FROM user_roles ur JOIN roles r ON r.id = ur.role_id
  WHERE ur.user_id = $1
`;

const PERMS_SQL = `
  SELECT DISTINCT p.code
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
  JOIN user_roles ur ON ur.role_id = rp.role_id
  WHERE ur.user_id = $1
`;

export async function loadAuthUser(userId: number, tenantId: number): Promise<AuthUser> {
  const userRes = await query(USER_SQL, [userId], { tenantId });
  if (userRes.rows.length === 0) throw unauthorized('User no longer exists');
  const userRow = userRes.rows[0] as unknown as Record<string, unknown>;
  if (userRow.status !== 'ACTIVE') throw unauthorized('Account is not active');
  if (Number(userRow.tenant_id) !== tenantId) throw unauthorized('Tenant mismatch');
  const rolesRes = await query(ROLES_SQL, [userId], { tenantId });
  const permsRes = await query(PERMS_SQL, [userId], { tenantId });
  const delegationRes = await query(DELEGATIONS_SQL, [userId, tenantId], { tenantId });
  const actingRoles: ActingRoleSummary[] = [];
  const delegationPerms = new Set<string>();
  for (const row of delegationRes.rows as Record<string, unknown>[]) {
    const permCode = String(row.permission_code ?? '');
    if (permCode) delegationPerms.add(permCode);
  }
  const actingByDelegation = new Map<number, ActingRoleSummary>();
  for (const row of delegationRes.rows as Record<string, unknown>[]) {
    const delegationId = Number(row.delegation_id);
    if (!actingByDelegation.has(delegationId)) {
      actingByDelegation.set(delegationId, {
        delegation_id: delegationId,
        delegation_code: String(row.delegation_code ?? ''),
        delegation_company_id: row.delegation_company_id ?? null,
        delegator_user_id: row.delegator_user_id ?? null,
        delegator_name: row.delegator_first_name && row.delegator_last_name
          ? `${row.delegator_first_name} ${row.delegator_last_name}`
          : null,
        role_code: String(row.role_code ?? ''),
        role_name: String(row.role_name ?? ''),
        starts_at: row.starts_at ?? null,
        expires_at: row.expires_at ?? null,
      } as ActingRoleSummary);
    }
  }
  actingByDelegation.forEach((v) => actingRoles.push(v));
  const modsRes = await query('SELECT activate_modules FROM tenants WHERE id = $1', [tenantId], { tenantId });
  const activateModules = Array.isArray(modsRes.rows[0]?.activate_modules)
    ? (modsRes.rows[0].activate_modules as string[])
    : [];
  const scopeRes = await query(
    `SELECT t.code AS tenant_code, t.name AS tenant_name,
            c.code AS company_code,
            c.name AS company_name, b.code AS branch_code, b.name AS branch_name,
            d.code AS department_code, d.name AS department_name,
            dv.code AS division_code, dv.name AS division_name,
            COALESCE(emp.employee_no, u.username) AS requester_code,
            NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS requester_name,
            rl.code AS requesting_location_code, rl.name AS requesting_location_name,
            rl.address AS requesting_location_address,
            cc.code AS cost_centre_code, cc.name AS cost_centre_name,
            pj.code AS project_code, pj.name AS project_name,
            bg.budget_no AS budget_code, bg.amount AS budget_amount, bg.status AS budget_status,
            fy.code AS fiscal_year_code, fy.name AS fiscal_year_name,
            TO_CHAR(fy.fiscal_year_start, 'YYYY-MM-DD') AS fiscal_year_start,
            TO_CHAR(fy.fiscal_year_end, 'YYYY-MM-DD') AS fiscal_year_end,
            fy.status AS fiscal_year_status,
            TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS request_date,
            u.default_lead_days AS default_lead_days,
            TO_CHAR(CURRENT_DATE + COALESCE(u.default_lead_days, 7), 'YYYY-MM-DD') AS required_by_date,
            u.default_priority AS default_priority,
            u.default_procurement_category AS default_procurement_category,
            u.default_purpose AS default_purpose,
            u.default_business_justification AS default_business_justification,
            u.default_delivery_location AS default_delivery_location,
            u.default_currency_code AS default_currency_code,
            u.default_tax_code AS default_tax_code,
            u.default_expected_total::float8 AS default_expected_total,
            u.default_confidentiality_level AS default_confidentiality_level,
            u.default_emergency_purchase AS default_emergency_purchase,
            u.default_recurring_purchase AS default_recurring_purchase,
            u.default_company_id AS default_company_id,
            dc.code AS default_company_code,
            dc.name AS default_company_name,
            u.default_branch_id AS default_branch_id,
            db.code AS default_branch_code,
            db.name AS default_branch_name,
            u.default_fiscal_year_id AS default_fiscal_year_id,
            dfy.code AS default_fiscal_year_code,
            dfy.name AS default_fiscal_year_name
     FROM tenants t
     LEFT JOIN companies c ON c.id = $2 AND c.tenant_id = t.id
     LEFT JOIN branches b ON b.id = $3 AND b.tenant_id = t.id
     LEFT JOIN departments d ON d.id = $4 AND d.tenant_id = t.id
     LEFT JOIN divisions dv ON dv.id = $5 AND dv.tenant_id = t.id
     LEFT JOIN users u ON u.id = $6
     LEFT JOIN companies dc ON dc.id = u.default_company_id AND dc.tenant_id = t.id
     LEFT JOIN branches db ON db.id = u.default_branch_id AND db.tenant_id = t.id
     LEFT JOIN fiscal_years dfy ON dfy.id = u.default_fiscal_year_id AND dfy.tenant_id = t.id
     LEFT JOIN employees emp ON emp.id = u.employee_id
     LEFT JOIN warehouses rl ON rl.id = $7 AND rl.tenant_id = t.id
     LEFT JOIN cost_centres cc ON cc.id = $8 AND cc.tenant_id = t.id
     LEFT JOIN projects pj ON pj.id = $9 AND pj.tenant_id = t.id
     LEFT JOIN budgets bg ON bg.id = $10 AND bg.tenant_id = t.id
     LEFT JOIN fiscal_years fy ON fy.id = $11 AND fy.tenant_id = t.id
     WHERE t.id = $1`,
    [tenantId, userRow.company_id ?? null, userRow.branch_id ?? null, userRow.department_id ?? null, userRow.division_id ?? null, userRow.id, userRow.requesting_location_id ?? null, userRow.cost_centre_id ?? null, userRow.project_id ?? null, userRow.budget_id ?? null, userRow.fiscal_year_id ?? null],
    { tenantId }
  );
  return {
    ...(userRow as unknown as AuthUser),
    ...(scopeRes.rows[0] ?? {}),
    roles: rolesRes.rows as unknown as AuthUser['roles'],
    permissions: [...new Set([...permsRes.rows.map((r) => String(r.code)), ...delegationPerms])],
    activate_modules: activateModules,
    actingRoles: actingRoles.length > 0 ? actingRoles : undefined,
  };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());
  try {
    const payload = verifyAccessToken(token);
    req.ctx.tenantId = payload.tid;
    req.ctx.userId = payload.sub;
    // Enforce session lifecycle: revoked or expired sessions must not authenticate.
    if (!payload.sid) return next(unauthorized('Missing session'));
    const sess = await query(
      `SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
      [payload.sid, payload.sub],
      { tenantId: payload.tid, userId: payload.sub }
    );
    if (sess.rows.length === 0) return next(unauthorized('Session has been revoked or expired'));
    const user = await loadAuthUser(payload.sub, payload.tid);
    req.ctx.companyId = user.company_id;
    req.ctx.branchId = user.branch_id;
    req.auth = user;
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}
const DELEGATIONS_SQL = `
  SELECT d.id AS delegation_id, d.code AS delegation_code, d.delegator_user_id,
         d.company_id AS delegation_company_id,
         TO_CHAR(d.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
         TO_CHAR(d.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at,
         du.first_name AS delegator_first_name, du.last_name AS delegator_last_name,
         r.code AS role_code, r.name AS role_name,
         p.code AS permission_code
  FROM delegations d
  JOIN roles r ON r.id = d.temporary_role_id
  JOIN role_permissions rp ON rp.role_id = r.id
  JOIN permissions p ON p.id = rp.permission_id
  JOIN users du ON du.id = d.delegator_user_id
 WHERE d.delegate_user_id = $1
   AND d.tenant_id = $2
   AND d.status = 'ACTIVE'
   AND d.starts_at <= now() AND d.expires_at > now()
`;


