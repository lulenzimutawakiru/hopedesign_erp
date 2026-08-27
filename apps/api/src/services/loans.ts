import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

/** Add whole months to a YYYY-MM-DD date, clamping the day to month length. */
function addMonths(dateStr: string, months: number): string {
  const [y, m, day] = dateStr.slice(0, 10).split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

async function getSetting(client: pg.PoolClient, ctx: Ctx, category: string, key: string, fallback: string): Promise<string> {
  const res = await client.query(
    `SELECT value FROM app_settings
     WHERE tenant_id = $1 AND category = $2 AND key = $3
       AND (company_id = $4 OR (company_id IS NULL AND $4 IS NULL))
     ORDER BY (company_id IS NOT NULL) DESC LIMIT 1`,
    [ctx.tenantId, category, key, ctx.companyId ?? null]
  );
  return res.rows.length ? String(res.rows[0].value) : fallback;
}

async function loadEmployee(client: pg.PoolClient, ctx: Ctx, employeeId: number) {
  const res = await client.query(
    `SELECT id, base_salary FROM employees WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [employeeId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Employee not found');
  return res.rows[0];
}

// ---------------------------------------------------------------------------
// Employee loans
// ---------------------------------------------------------------------------

export async function createLoan(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    employeeId: number;
    amount: number;
    interestRate?: number;
    tenureMonths?: number;
    monthlyDeduction?: number;
    startDate?: string | null;
    reason?: string | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const emp = await loadEmployee(client, ctx, Number(input.employeeId));
  const amount = round2(Math.max(0, Number(input.amount) || 0));
  if (amount <= 0) throw badRequest('Loan amount must be positive');
  const tenureMonths = Math.max(1, Math.floor(Number(input.tenureMonths) || 1));
  const interestRate = round2(Math.max(0, Number(input.interestRate) || 0));
  const startDate =
    input.startDate && /^\d{4}-\d{2}-\d{2}/.test(String(input.startDate)) ? String(input.startDate).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const monthlyDeduction = round2(
    Number(input.monthlyDeduction) > 0 ? Number(input.monthlyDeduction) : amount / tenureMonths
  );
  const endDate = addMonths(startDate, tenureMonths);
  const loanNo = await nextDoc(client, ctx, 'LN');
  const ins = await client.query(
    `INSERT INTO employee_loans
       (company_id, tenant_id, employee_id, loan_no, amount, principal, balance, outstanding_balance,
        interest_rate, tenure_months, monthly_deduction, start_date, end_date, status, applied_by)
     VALUES ($1,$2,$3,$4,$5,$5,$5,$5,$6,$7,$8,$9,$10,'PENDING',$11)
     RETURNING id, loan_no`,
    [ctx.companyId, ctx.tenantId, emp.id, loanNo, amount, interestRate, tenureMonths, monthlyDeduction, startDate, endDate, ctx.userId ?? null]
  );
  const loanId = Number(ins.rows[0].id);
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'loans',
    recordId: loanId,
    recordCode: loanNo,
    newValues: { employeeId: emp.id, amount, interestRate, tenureMonths, monthlyDeduction, startDate, endDate, reason: input.reason ?? null },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.loan.created',
    entityType: 'hr.loans',
    entityId: loanId,
    entityCode: loanNo,
    payload: { employeeId: emp.id, amount, monthlyDeduction },
  });
  return { loanId, loanNo, status: 'PENDING', employeeId: emp.id, amount, monthlyDeduction, startDate, endDate };
}

export async function approveLoan(client: pg.PoolClient, ctx: Ctx, loanId: number) {
  const res = await client.query(
    `UPDATE employee_loans SET status = 'ACTIVE', approved_by = $2, approved_at = now()
     WHERE id = $1 AND tenant_id = $3 AND status IN ('PENDING','PAUSED')
     RETURNING id, loan_no, employee_id, amount`,
    [loanId, ctx.userId ?? null, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Loan not found or not awaiting approval');
  await logAudit(client, ctx, {
    action: 'approve',
    resource: 'loans',
    recordId: loanId,
    recordCode: String(res.rows[0].loan_no),
    newValues: { status: 'ACTIVE' },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.loan.approved',
    entityType: 'hr.loans',
    entityId: loanId,
    entityCode: String(res.rows[0].loan_no),
    payload: { employeeId: Number(res.rows[0].employee_id) },
  });
  return { loanId, loanNo: res.rows[0].loan_no, status: 'ACTIVE' };
}

export async function rejectLoan(client: pg.PoolClient, ctx: Ctx, loanId: number) {
  const res = await client.query(
    `UPDATE employee_loans SET status = 'REJECTED', approved_by = $2, approved_at = now()
     WHERE id = $1 AND tenant_id = $3 AND status = 'PENDING'
     RETURNING id, loan_no`,
    [loanId, ctx.userId ?? null, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Loan not found or not pending');
  await logAudit(client, ctx, {
    action: 'reject',
    resource: 'loans',
    recordId: loanId,
    recordCode: String(res.rows[0].loan_no),
    newValues: { status: 'REJECTED' },
  });
  return { loanId, loanNo: res.rows[0].loan_no, status: 'REJECTED' };
}

export async function pauseLoan(client: pg.PoolClient, ctx: Ctx, loanId: number) {
  const res = await client.query(
    `UPDATE employee_loans SET status = 'PAUSED'
     WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
     RETURNING id, loan_no`,
    [loanId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Loan not found or not active');
  await logAudit(client, ctx, {
    action: 'pause',
    resource: 'loans',
    recordId: loanId,
    recordCode: String(res.rows[0].loan_no),
    newValues: { status: 'PAUSED' },
  });
  return { loanId, loanNo: res.rows[0].loan_no, status: 'PAUSED' };
}

export async function writeOffLoan(client: pg.PoolClient, ctx: Ctx, loanId: number) {
  const res = await client.query(
    `UPDATE employee_loans SET status = 'WRITTEN_OFF', approved_by = $2, approved_at = now()
     WHERE id = $1 AND tenant_id = $3 AND status IN ('ACTIVE','PAUSED')
     RETURNING id, loan_no`,
    [loanId, ctx.userId ?? null, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Loan not found or not active');
  await logAudit(client, ctx, {
    action: 'write_off',
    resource: 'loans',
    recordId: loanId,
    recordCode: String(res.rows[0].loan_no),
    newValues: { status: 'WRITTEN_OFF' },
  });
  return { loanId, loanNo: res.rows[0].loan_no, status: 'WRITTEN_OFF' };
}

export async function listLoans(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { employeeId?: number; status?: string; q?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(filters.pageSize) || 25));
  const where = [
    'ln.tenant_id = $1',
    'ln.company_id = $2',
    '$3::bigint IS NULL OR ln.employee_id = $3',
    '$4::text IS NULL OR ln.status = $4',
    `$5::text IS NULL OR (e.first_name ILIKE '%'||$5||'%' OR e.last_name ILIKE '%'||$5||'%' OR ln.loan_no ILIKE '%'||$5||'%')`,
  ].join(' AND ');
  const params: unknown[] = [
    ctx.tenantId,
    ctx.companyId,
    filters.employeeId != null ? Number(filters.employeeId) : null,
    filters.status ? String(filters.status) : null,
    filters.q ? String(filters.q) : null,
  ];
  const count = await client.query(
    `SELECT count(*)::int AS total FROM employee_loans ln JOIN employees e ON e.id = ln.employee_id WHERE ${where}`,
    params
  );
  const res = await client.query(
    `SELECT ln.id, ln.loan_no, ln.amount, ln.balance, ln.outstanding_balance, ln.interest_rate,
            ln.tenure_months, ln.monthly_deduction, ln.start_date, ln.end_date, ln.status,
            ln.approved_at, ln.created_at,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name, e.position
     FROM employee_loans ln JOIN employees e ON e.id = ln.employee_id
     WHERE ${where}
     ORDER BY ln.id DESC
     LIMIT $6 OFFSET $7`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  return { items: toCamelRows(res.rows), total: Number(count.rows[0].total), page, pageSize };
}

export async function getLoan(client: pg.PoolClient, ctx: Ctx, loanId: number) {
  const res = await client.query(
    `SELECT ln.*, e.employee_no, e.first_name, e.last_name, e.position
     FROM employee_loans ln JOIN employees e ON e.id = ln.employee_id
     WHERE ln.id = $1 AND ln.tenant_id = $2`,
    [loanId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Loan not found');
  const reps = await client.query(
    `SELECT id, payroll_run_id, period_code, amount, principal_component, interest_component, paid_at, created_at
     FROM loan_repayments WHERE loan_id = $1 AND tenant_id = $2 ORDER BY id DESC`,
    [loanId, ctx.tenantId]
  );
  return { loan: toCamelRow(res.rows[0]), repayments: toCamelRows(reps.rows) };
}

// ---------------------------------------------------------------------------
// Salary advances
// ---------------------------------------------------------------------------

export async function createAdvance(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { employeeId: number; amount: number; monthlyDeduction?: number; startDate?: string | null; reason?: string | null }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const emp = await loadEmployee(client, ctx, Number(input.employeeId));
  const amount = round2(Math.max(0, Number(input.amount) || 0));
  if (amount <= 0) throw badRequest('Advance amount must be positive');

  // Duplicate policy: only one open (PENDING/ACTIVE) advance per employee.
  const open = await client.query(
    `SELECT advance_no FROM salary_advances
     WHERE employee_id = $1 AND tenant_id = $2 AND status IN ('PENDING','ACTIVE') AND outstanding_balance > 0`,
    [input.employeeId, ctx.tenantId]
  );
  if (open.rows.length > 0) {
    throw badRequest(`Employee already has an outstanding salary advance (${open.rows[0].advance_no})`);
  }

  // Excessive policy: configurable ceiling as a ratio of monthly basic salary
  // (default 1 = up to one month's salary), stored in app_settings.
  const baseSalary = Math.max(0, Number(emp.base_salary) || 0);
  const maxRatio = Math.max(0, Number(await getSetting(client, ctx, 'payroll', 'advance.max_ratio_of_salary', '1')) || 0);
  if (baseSalary > 0 && amount > round2(baseSalary * maxRatio)) {
    throw badRequest(`Advance of ${amount} exceeds the configured ceiling (${round2(baseSalary * maxRatio)} for this employee)`);
  }

  const startDate =
    input.startDate && /^\d{4}-\d{2}-\d{2}/.test(String(input.startDate)) ? String(input.startDate).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const monthlyDeduction = round2(Math.max(0, Number(input.monthlyDeduction) || 0)) || amount;
  const advanceNo = await nextDoc(client, ctx, 'ADV');
  const ins = await client.query(
    `INSERT INTO salary_advances
       (company_id, tenant_id, employee_id, advance_no, amount, monthly_deduction, deduction_schedule,
        outstanding_balance, requested_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,'[]'::jsonb,$5,$7,'PENDING')
     RETURNING id, advance_no`,
    [ctx.companyId, ctx.tenantId, emp.id, advanceNo, amount, monthlyDeduction, ctx.userId ?? null]
  );
  const advanceId = Number(ins.rows[0].id);
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'advances',
    recordId: advanceId,
    recordCode: advanceNo,
    newValues: { employeeId: emp.id, amount, monthlyDeduction, startDate, reason: input.reason ?? null },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.advance.requested',
    entityType: 'hr.advances',
    entityId: advanceId,
    entityCode: advanceNo,
    payload: { employeeId: emp.id, amount, monthlyDeduction },
  });
  return { advanceId, advanceNo, status: 'PENDING', employeeId: emp.id, amount, monthlyDeduction, startDate };
}

export async function approveAdvance(client: pg.PoolClient, ctx: Ctx, advanceId: number) {
  const res = await client.query(
    `UPDATE salary_advances SET status = 'ACTIVE', approved_by = $2, approved_at = now()
     WHERE id = $1 AND tenant_id = $3 AND status = 'PENDING'
     RETURNING id, advance_no, employee_id, amount`,
    [advanceId, ctx.userId ?? null, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Advance not found or not pending');
  await logAudit(client, ctx, {
    action: 'approve',
    resource: 'advances',
    recordId: advanceId,
    recordCode: String(res.rows[0].advance_no),
    newValues: { status: 'ACTIVE' },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.advance.approved',
    entityType: 'hr.advances',
    entityId: advanceId,
    entityCode: String(res.rows[0].advance_no),
    payload: { employeeId: Number(res.rows[0].employee_id) },
  });
  return { advanceId, advanceNo: res.rows[0].advance_no, status: 'ACTIVE' };
}

export async function rejectAdvance(client: pg.PoolClient, ctx: Ctx, advanceId: number) {
  const res = await client.query(
    `UPDATE salary_advances SET status = 'REJECTED', approved_by = $2, approved_at = now()
     WHERE id = $1 AND tenant_id = $3 AND status = 'PENDING'
     RETURNING id, advance_no`,
    [advanceId, ctx.userId ?? null, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Advance not found or not pending');
  await logAudit(client, ctx, {
    action: 'reject',
    resource: 'advances',
    recordId: advanceId,
    recordCode: String(res.rows[0].advance_no),
    newValues: { status: 'REJECTED' },
  });
  return { advanceId, advanceNo: res.rows[0].advance_no, status: 'REJECTED' };
}

export async function closeAdvance(client: pg.PoolClient, ctx: Ctx, advanceId: number) {
  const res = await client.query(
    `UPDATE salary_advances SET status = 'CLOSED'
     WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
     RETURNING id, advance_no`,
    [advanceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Advance not found or not active');
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'advances',
    recordId: advanceId,
    recordCode: String(res.rows[0].advance_no),
    newValues: { status: 'CLOSED' },
  });
  return { advanceId, advanceNo: res.rows[0].advance_no, status: 'CLOSED' };
}

export async function listAdvances(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { employeeId?: number; status?: string; q?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(filters.pageSize) || 25));
  const where = [
    'a.tenant_id = $1',
    'a.company_id = $2',
    '$3::bigint IS NULL OR a.employee_id = $3',
    '$4::text IS NULL OR a.status = $4',
    `$5::text IS NULL OR (e.first_name ILIKE '%'||$5||'%' OR e.last_name ILIKE '%'||$5||'%' OR a.advance_no ILIKE '%'||$5||'%')`,
  ].join(' AND ');
  const params: unknown[] = [
    ctx.tenantId,
    ctx.companyId,
    filters.employeeId != null ? Number(filters.employeeId) : null,
    filters.status ? String(filters.status) : null,
    filters.q ? String(filters.q) : null,
  ];
  const count = await client.query(
    `SELECT count(*)::int AS total FROM salary_advances a JOIN employees e ON e.id = a.employee_id WHERE ${where}`,
    params
  );
  const res = await client.query(
    `SELECT a.id, a.advance_no, a.amount, a.monthly_deduction, a.deduction_schedule,
            a.outstanding_balance, a.status, a.approved_at, a.created_at,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name, e.position
     FROM salary_advances a JOIN employees e ON e.id = a.employee_id
     WHERE ${where}
     ORDER BY a.id DESC
     LIMIT $6 OFFSET $7`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  return { items: toCamelRows(res.rows), total: Number(count.rows[0].total), page, pageSize };
}

export async function getAdvance(client: pg.PoolClient, ctx: Ctx, advanceId: number) {
  const res = await client.query(
    `SELECT a.*, e.employee_no, e.first_name, e.last_name, e.position
     FROM salary_advances a JOIN employees e ON e.id = a.employee_id
     WHERE a.id = $1 AND a.tenant_id = $2`,
    [advanceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Advance not found');
  const reps = await client.query(
    `SELECT id, payroll_run_id, amount, paid_at, created_at
     FROM advance_repayments WHERE advance_id = $1 AND tenant_id = $2 ORDER BY id DESC`,
    [advanceId, ctx.tenantId]
  );
  return { advance: toCamelRow(res.rows[0]), repayments: toCamelRows(reps.rows) };
}