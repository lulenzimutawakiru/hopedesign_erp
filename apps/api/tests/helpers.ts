import request from 'supertest';
import pg from 'pg';
import { app } from '../src/app.js';
import { authenticator } from 'otplib';

export const api = request(app);
export const PASSWORD = 'ChangeMe!2026';

export const auth = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

export async function loginAs(username: string) {
  const res = await api.post('/api/auth/login').send({ identifier: username, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  if (res.body.accessToken) {
    return { token: res.body.accessToken as string, user: res.body.user as Record<string, unknown> };
  }
  const loginBody = res.body as {
    mfaRequired?: boolean;
    enrollmentRequired?: boolean;
    loginToken?: string;
    user?: Record<string, unknown>;
  };
  if (!loginBody.loginToken || !loginBody.mfaRequired) {
    throw new Error(`login ${username} unexpected response: ${JSON.stringify(res.body)}`);
  }
  const verifySecret = async (secret: string) => {
    const attempt = async () =>
      api.post('/api/auth/mfa/verify').send({ loginToken: loginBody.loginToken, code: authenticator.generate(secret) });
    let v = await attempt();
    // TOTP is time-based: under slow/parallel CI the 30s window can roll over
    // between code generation and verification. Retry once with a fresh code
    // before failing so a boundary rollover is not reported as an auth bug.
    if (v.status !== 200) {
      await new Promise((r) => setTimeout(r, 1100));
      v = await attempt();
    }
    if (v.status !== 200) {
      throw new Error(`mfa verify ${username} failed: ${v.status} ${JSON.stringify(v.body)}`);
    }
    if (!v.body.accessToken) throw new Error(`mfa verify ${username} returned no accessToken`);
    return { token: v.body.accessToken as string, user: (v.body.user ?? loginBody.user) as Record<string, unknown> };
  };
  if (loginBody.enrollmentRequired) {
    const es = await api.post('/api/auth/mfa/enroll-start').send({ loginToken: loginBody.loginToken });
    if (es.status !== 200) {
      throw new Error(`mfa enroll-start ${username} failed: ${es.status} ${JSON.stringify(es.body)}`);
    }
    const secret = String(es.body?.secret ?? '');
    if (!secret) throw new Error(`mfa enroll-start ${username} returned no secret`);
    const code = authenticator.generate(secret);
    const ev = await api.post('/api/auth/mfa/enroll-verify').send({ loginToken: loginBody.loginToken, code, secret });
    if (ev.status !== 200) {
      throw new Error(`mfa enroll-verify ${username} failed: ${ev.status} ${JSON.stringify(ev.body)}`);
    }
    if (!ev.body.accessToken) throw new Error(`mfa enroll-verify ${username} returned no accessToken`);
    return { token: ev.body.accessToken as string, user: (ev.body.user ?? loginBody.user) as Record<string, unknown> };
  }
  const secretRes = await pool.query<{ mfa_secret: string | null }>(
    `SELECT mfa_secret FROM users WHERE email = $1 OR username = $1`
    , [username]
  );
  const secret = secretRes.rows[0]?.mfa_secret ?? '';
  if (!secret) throw new Error(`mfa verify ${username}: no mfa_secret found in database`);
  return verifySecret(secret);
}
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: num(process.env.POSTGRES_PORT, 5432),
  user: process.env.POSTGRES_USER ?? 'hopedesign',
  password: process.env.POSTGRES_PASSWORD ?? 'hopedesign_dev',
  database: process.env.POSTGRES_DB ?? 'hopedesign_erp',
});

export async function db(sql: string, params: unknown[] = []) {
  return pool.query(sql, params);
}

/** Tables whose FK to employees has no ON DELETE action. Cleared before the
 * employee row is removed so cleanup never trips a constraint â€” this matters
 * when test files share one database (parallel root-level vitest runs, where
 * a group-scoped payroll run's validation flags employees from other files). */
const EMPLOYEE_CHILD_TABLES = [
  'asset_assignments',
  'attendance',
  'benefit_claims',
  'benefit_enrollments',
  'bonus_records',
  'commission_records',
  'disciplinary_actions',
  'disciplinary_cases',
  'employee_benefits',
  'employee_competencies',
  'employee_deductions',
  'employee_earnings',
  'employee_loans',
  'employee_movements',
  'employee_payroll_components',
  'employee_requests',
  'employee_salaries',
  'final_settlements',
  'fraud_alerts',
  'grievances',
  'leave_balances',
  'leave_requests',
  'offboarding_instances',
  'overtime_records',
  'onboarding_instances',
  'overtime_requests',
  'payment_batch_items',
  'payment_transactions',
  'payroll_adjustments',
  'payroll_arrears',
  'payroll_calculations',
  'payroll_component_entries',
  'payroll_documents',
  'payroll_exceptions',
  'payroll_items',
  'payroll_run_employees',
  'payslips',
  'performance_goals',
  'performance_improvement_plans',
  'performance_kpis',
  'performance_reviews',
  'position_assignments',
  'practitioners',
  'salary_histories',
  'shift_assignments',
  'statutory_calculations',
  'timesheets',
  'training_certificates',
  'training_enrollments',
  'training_requests',
  'warnings',
];

/** Delete test employees and every row referencing them (FK-safe). */
export async function deleteEmployees(ids: number[]) {
  const clean = [...new Set(ids.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
  if (clean.length === 0) return;
  const placeholders = clean.map((_, i) => `$${i + 1}`).join(', ');
  await pool.query(`UPDATE users SET employee_id = NULL WHERE employee_id IN (${placeholders})`, clean);
  await pool.query(`DELETE FROM user_employment_links WHERE employee_id IN (${placeholders})`, clean);
  for (const table of EMPLOYEE_CHILD_TABLES) {
    await pool.query(`DELETE FROM ${table} WHERE employee_id IN (${placeholders})`, clean);
  }
  await pool.query(`DELETE FROM employees WHERE id IN (${placeholders})`, clean);
}

/** Find a PENDING approval task for an entity in the current user's approval queue. */
export async function findPendingTask(token: string, entityType: string, entityId: number, stepSeq: number) {
  const res = await api.get('/api/approvals').set(auth(token));
  if (res.status !== 200) throw new Error(`approvals queue failed: ${res.status} ${JSON.stringify(res.body)}`);
  const row = res.body.data.find(
    (t: { entity_type: string; entity_id: unknown; step_seq: unknown; status: string }) =>
      t.entity_type === entityType &&
      Number(t.entity_id) === entityId &&
      Number(t.step_seq) === stepSeq &&
      t.status === 'PENDING'
  );
  return row ? Number(row.task_id) : null;
}

