import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, conflict, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';

async function loadUser(client: pg.PoolClient, ctx: Ctx, userId: number) {
  const res = await client.query(`SELECT * FROM users WHERE id = $1 AND tenant_id = $2`, [userId, ctx.tenantId]);
  if (!res.rows.length) throw notFound('User not found');
  return res.rows[0];
}

async function loadEmployee(client: pg.PoolClient, ctx: Ctx, employeeId: number) {
  const res = await client.query(`SELECT * FROM employees WHERE id = $1 AND tenant_id = $2`, [employeeId, ctx.tenantId]);
  if (!res.rows.length) throw notFound('Employee not found');
  return res.rows[0];
}

export async function getLinkedEmployee(client: pg.PoolClient, ctx: Ctx, userId: number) {
  const res = await client.query(
    `SELECT e.id, e.employee_no, e.first_name, e.last_name, e.position, e.status, e.email, e.phone,
            e.department_id, e.branch_id, e.company_id, d.name AS department_name
     FROM users u
     JOIN employees e ON e.id = u.employee_id AND e.tenant_id = u.tenant_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE u.id = $1 AND u.tenant_id = $2`,
    [userId, ctx.tenantId]
  );
  return res.rows[0] ? toCamelRow(res.rows[0]) : null;
}

export async function getLinkedUser(client: pg.PoolClient, ctx: Ctx, employeeId: number) {
  const res = await client.query(
    `SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.status, u.job_title, u.last_login_at
     FROM employees e
     JOIN users u ON u.id = e.user_id AND u.tenant_id = e.tenant_id
     WHERE e.id = $1 AND e.tenant_id = $2`,
    [employeeId, ctx.tenantId]
  );
  return res.rows[0] ? toCamelRow(res.rows[0]) : null;
}

export async function suggestEmployeesForUser(client: pg.PoolClient, ctx: Ctx, userId: number, q?: string) {
  const user = await loadUser(client, ctx, userId);
  const term = q?.trim() ?? '';
  const res = await client.query(
    `SELECT e.id, e.employee_no, e.first_name, e.last_name, e.position, e.status, e.email
     FROM employees e
     WHERE e.tenant_id = $1 AND e.user_id IS NULL
       AND (
         ($2::text <> '' AND (e.employee_no ILIKE $3 OR e.first_name ILIKE $3 OR e.last_name ILIKE $3 OR e.email ILIKE $3))
         OR ($2::text = '' AND (
              lower(COALESCE(e.email,'')) = lower(COALESCE($4::text,''))
              OR (e.first_name ILIKE $5 AND e.last_name ILIKE $6)
         ))
       )
     ORDER BY CASE WHEN lower(COALESCE(e.email,'')) = lower(COALESCE($4::text,'')) THEN 0 ELSE 1 END,
              e.last_name, e.first_name
     LIMIT 12`,
    [
      ctx.tenantId,
      term,
      `%${term}%`,
      String(user.email ?? ''),
      `%${String(user.first_name ?? '')}%`,
      `%${String(user.last_name ?? '')}%`,
    ]
  );
  return toCamelRows(res.rows);
}

export async function suggestUsersForEmployee(client: pg.PoolClient, ctx: Ctx, employeeId: number, q?: string) {
  const emp = await loadEmployee(client, ctx, employeeId);
  const term = q?.trim() ?? '';
  const res = await client.query(
    `SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.status, u.job_title
     FROM users u
     WHERE u.tenant_id = $1 AND u.employee_id IS NULL
       AND (
         ($2::text <> '' AND (u.username ILIKE $3 OR u.email ILIKE $3 OR u.first_name ILIKE $3 OR u.last_name ILIKE $3))
         OR ($2::text = '' AND lower(COALESCE(u.email,'')) = lower(COALESCE($4::text,'')))
       )
     ORDER BY u.last_name, u.first_name
     LIMIT 12`,
    [ctx.tenantId, term, `%${term}%`, String(emp.email ?? '')]
  );
  return toCamelRows(res.rows);
}

export async function searchEmployees(
  client: pg.PoolClient,
  ctx: Ctx,
  q: string,
  opts?: { unlinkedOnly?: boolean }
) {
  const term = `%${(q || '').trim()}%`;
  const res = await client.query(
    `SELECT e.id, e.employee_no, e.first_name, e.last_name, e.position, e.status, e.email, e.user_id
     FROM employees e
     WHERE e.tenant_id = $1
       AND ($3::boolean IS NOT TRUE OR e.user_id IS NULL)
       AND (
         $2 = '%%'
         OR e.employee_no ILIKE $2 OR e.first_name ILIKE $2 OR e.last_name ILIKE $2 OR e.email ILIKE $2
       )
     ORDER BY e.last_name, e.first_name
     LIMIT 20`,
    [ctx.tenantId, term, Boolean(opts?.unlinkedOnly)]
  );
  return toCamelRows(res.rows);
}

export async function searchUsers(
  client: pg.PoolClient,
  ctx: Ctx,
  q: string,
  opts?: { unlinkedOnly?: boolean }
) {
  const term = `%${(q || '').trim()}%`;
  const res = await client.query(
    `SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.status, u.employee_id
     FROM users u
     WHERE u.tenant_id = $1
       AND ($3::boolean IS NOT TRUE OR u.employee_id IS NULL)
       AND (
         $2 = '%%'
         OR u.username ILIKE $2 OR u.email ILIKE $2 OR u.first_name ILIKE $2 OR u.last_name ILIKE $2
       )
     ORDER BY u.last_name, u.first_name
     LIMIT 20`,
    [ctx.tenantId, term, Boolean(opts?.unlinkedOnly)]
  );
  return toCamelRows(res.rows);
}

export async function findUnlinkedEmployeeByEmail(client: pg.PoolClient, ctx: Ctx, email?: string | null) {
  const value = String(email ?? '').trim().toLowerCase();
  if (!value) return null;
  const res = await client.query(
    `SELECT id FROM employees
      WHERE tenant_id = $1 AND user_id IS NULL
        AND email IS NOT NULL AND lower(btrim(email)) = $2
      LIMIT 2`,
    [ctx.tenantId, value]
  );
  return res.rows.length === 1 ? Number(res.rows[0].id) : null;
}

export async function findUnlinkedUserByEmail(client: pg.PoolClient, ctx: Ctx, email?: string | null) {
  const value = String(email ?? '').trim().toLowerCase();
  if (!value) return null;
  const res = await client.query(
    `SELECT id FROM users
      WHERE tenant_id = $1 AND employee_id IS NULL
        AND email IS NOT NULL AND lower(btrim(email)) = $2
      LIMIT 2`,
    [ctx.tenantId, value]
  );
  return res.rows.length === 1 ? Number(res.rows[0].id) : null;
}

export async function linkUserEmployee(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { userId: number; employeeId: number }
) {
  const userId = Number(input.userId);
  const employeeId = Number(input.employeeId);
  if (!userId || !employeeId) throw badRequest('User and employee are required');
  const user = await loadUser(client, ctx, userId);
  const emp = await loadEmployee(client, ctx, employeeId);

  if (user.employee_id && Number(user.employee_id) !== employeeId) {
    throw conflict(`This account is already linked to employee ${user.employee_id}. Unlink it first.`);
  }
  if (emp.user_id && Number(emp.user_id) !== userId) {
    throw conflict(`This employee is already linked to user ${emp.user_id}. Unlink it first.`);
  }

  await client.query(
    `UPDATE users SET employee_id = $3,
        company_id = COALESCE(company_id, $4),
        branch_id = COALESCE(branch_id, $5),
        department_id = COALESCE(department_id, $6),
        job_title = COALESCE(NULLIF(job_title, ''), $7),
        phone = COALESCE(NULLIF(phone, ''), $8),
        updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [userId, ctx.tenantId, employeeId, emp.company_id, emp.branch_id, emp.department_id, emp.position, emp.phone]
  );
  await client.query(
    `UPDATE employees SET user_id = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
    [employeeId, ctx.tenantId, userId]
  );
  await client.query(
    `UPDATE user_employment_links SET is_primary = false, updated_at = now()
     WHERE tenant_id = $1 AND user_id = $2 AND employee_id IS DISTINCT FROM $3`,
    [ctx.tenantId, userId, employeeId]
  );
  await client.query(
    `INSERT INTO user_employment_links (tenant_id, user_id, employee_id, is_primary, effective_from, employment_status)
     VALUES ($1,$2,$3,true,CURRENT_DATE,$4)
     ON CONFLICT (user_id, employee_id) DO UPDATE
       SET is_primary = true, effective_to = NULL, employment_status = EXCLUDED.employment_status, updated_at = now()`,
    [ctx.tenantId, userId, employeeId, emp.status]
  );
  await logAudit(client, ctx, {
    action: 'link',
    resource: 'user_employment_links',
    recordId: userId,
    recordCode: String(user.email),
    newValues: { userId, employeeId, employeeNo: emp.employee_no },
  });
  return {
    userId,
    employeeId,
    employeeNo: String(emp.employee_no),
    username: String(user.username ?? ''),
  };
}

export async function unlinkUserEmployee(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { userId?: number; employeeId?: number }
) {
  let userId = input.userId != null ? Number(input.userId) : 0;
  let employeeId = input.employeeId != null ? Number(input.employeeId) : 0;
  if (userId && !employeeId) {
    const user = await loadUser(client, ctx, userId);
    employeeId = Number(user.employee_id ?? 0);
  }
  if (employeeId && !userId) {
    const emp = await loadEmployee(client, ctx, employeeId);
    userId = Number(emp.user_id ?? 0);
  }
  if (!userId || !employeeId) throw badRequest('No user–employee link to remove');
  await loadUser(client, ctx, userId);
  const emp = await loadEmployee(client, ctx, employeeId);
  await client.query(`UPDATE users SET employee_id = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [userId, ctx.tenantId]);
  await client.query(`UPDATE employees SET user_id = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [employeeId, ctx.tenantId]);
  await client.query(
    `UPDATE user_employment_links
        SET is_primary = false, effective_to = CURRENT_DATE, updated_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND employee_id = $3`,
    [ctx.tenantId, userId, employeeId]
  );
  await logAudit(client, ctx, {
    action: 'unlink',
    resource: 'user_employment_links',
    recordId: userId,
    recordCode: String(emp.employee_no),
    oldValues: { userId, employeeId },
  });
  return { userId, employeeId };
}
