import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../auth.js';
import { query } from '../db.js';
import { AuthUser } from '../types.js';
import { unauthorized } from '../utils.js';

const USER_SQL = `
  SELECT u.id, u.tenant_id, u.company_id, u.default_company_id, u.default_branch_id, u.branch_id, u.department_id, u.division_id, u.requesting_location_id, u.cost_centre_id, u.project_id, u.budget_id, u.fiscal_year_id, u.employee_id, u.email, u.username,
         u.first_name, u.last_name, u.job_title, u.status, u.must_change_password,
         u.mfa_enabled, u.attributes
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
    permissions: permsRes.rows.map((r) => String(r.code)),
    activate_modules: activateModules,
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
