import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import * as finance from './finance.js';

/** Uganda books are kept in whole shillings. */
const shilling = (n: number) => Math.round(Number(n) || 0);

const RECEIVABLE = '10111700';
const BANK = '10111300';
const PETTY = '10111200';
const IMPAIRMENT = '10251700';
const OTHER_INCOME = '10242200';

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

function kampalaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date());
}

function assertOtherPerson(actor: number | null | undefined, owner: unknown, message: string) {
  if (actor != null && owner != null && Number(owner) === Number(actor)) throw badRequest(message);
}

function installments(total: number, monthly: number, start: string) {
  const rows: Array<{ installment: number; dueDate: string; amount: number }> = [];
  let left = shilling(total);
  const step = Math.max(1, shilling(monthly));
  for (let i = 0; i < 60 && left > 0; i++) {
    const amount = Math.min(step, left);
    rows.push({ installment: i + 1, dueDate: addMonths(start, i), amount });
    left -= amount;
  }
  return rows;
}

function payoutAccount(method: string): string {
  return method === 'BANK' ? BANK : PETTY;
}

async function postPair(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { debit: string; credit: string; amount: number; description: string; refType: string; refId: number; refCode: string }
) {
  const amount = shilling(input.amount);
  if (amount <= 0) return null;
  const debitId = await finance.getAccountId(client, ctx, input.debit);
  const creditId = await finance.getAccountId(client, ctx, input.credit);
  return finance.postJournalLines(client, ctx, {
    entryDate: kampalaToday(),
    journalType: 'MANUAL',
    description: input.description,
    lines: [
      { account_id: debitId, debit: amount, description: input.description },
      { account_id: creditId, credit: amount, description: input.description },
    ],
    refType: input.refType,
    refId: input.refId,
    refCode: input.refCode,
  });
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
  const amount = shilling(Math.max(0, Number(input.amount) || 0));
  if (amount <= 0) throw badRequest('Loan amount must be positive');
  const tenureMonths = Math.max(1, Math.floor(Number(input.tenureMonths) || 1));
  const interestRate = Math.max(0, Number(input.interestRate) || 0);
  const startDate =
    input.startDate && /^\d{4}-\d{2}-\d{2}/.test(String(input.startDate)) ? String(input.startDate).slice(0, 10) : kampalaToday();
  // Simple interest over the term. A stated installment is kept; otherwise the loan clears over the term.
  const interest = shilling(amount * (interestRate / 100) * (tenureMonths / 12));
  const monthlyDeduction = shilling(
    Number(input.monthlyDeduction) > 0 ? Number(input.monthlyDeduction) : Math.max(1, Math.round((amount + interest) / tenureMonths))
  );
  const schedule = installments(amount + interest, monthlyDeduction, startDate);
  const endDate = schedule.length ? schedule[schedule.length - 1].dueDate : addMonths(startDate, tenureMonths);
  const loanNo = await nextDoc(client, ctx, 'LN');
  const ins = await client.query(
    `INSERT INTO employee_loans
       (company_id, tenant_id, employee_id, loan_no, amount, principal, balance, outstanding_balance,
        interest_rate, interest_outstanding, tenure_months, monthly_deduction, start_date, end_date,
        repayment_schedule, reason, status, applied_by)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,'PENDING',$15)
     RETURNING id, loan_no`,
    [ctx.companyId, ctx.tenantId, emp.id, loanNo, amount, amount + interest, interestRate, interest, tenureMonths, monthlyDeduction, startDate, endDate, JSON.stringify(schedule), input.reason ?? null, ctx.userId ?? null]
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
  return { loanId, loanNo, status: 'PENDING', employeeId: emp.id, amount, monthlyDeduction, interest, startDate, endDate };
}

export async function approveLoan(client: pg.PoolClient, ctx: Ctx, loanId: number) {
  const current = await client.query(
    `SELECT id, loan_no, applied_by, status FROM employee_loans WHERE id = $1 AND tenant_id = $2`,
    [loanId, ctx.tenantId]
  );
  if (current.rows.length === 0) throw badRequest('Loan not found or not awaiting approval');
  assertOtherPerson(ctx.userId, current.rows[0].applied_by, 'You cannot approve a loan you raised');
  const res = await client.query(
    `UPDATE employee_loans SET status = 'APPROVED', approved_by = $2, approved_at = now()
     WHERE id = $1 AND tenant_id = $3 AND status = 'PENDING'
     RETURNING id, loan_no, employee_id, amount`,
    [loanId, ctx.userId ?? null, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Loan not found or not awaiting approval');
  await logAudit(client, ctx, {
    action: 'approve',
    resource: 'loans',
    recordId: loanId,
    recordCode: String(res.rows[0].loan_no),
    newValues: { status: 'APPROVED' },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.loan.approved',
    entityType: 'hr.loans',
    entityId: loanId,
    entityCode: String(res.rows[0].loan_no),
    payload: { employeeId: Number(res.rows[0].employee_id) },
  });
  return { loanId, loanNo: res.rows[0].loan_no, status: 'APPROVED' };
}

export async function disburseLoan(
  client: pg.PoolClient,
  ctx: Ctx,
  loanId: number,
  paymentMethod?: string | null
) {
  const method = String(paymentMethod ?? 'BANK').toUpperCase();
  if (!['BANK', 'CASH', 'MOBILE_MONEY'].includes(method)) throw badRequest('Payment method must be bank, cash or mobile money');
  const current = await client.query(
    `SELECT * FROM employee_loans WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [loanId, ctx.tenantId]
  );
  if (current.rows.length === 0 || String(current.rows[0].status) !== 'APPROVED') {
    throw badRequest('Loan must be approved before it can be paid out');
  }
  assertOtherPerson(ctx.userId, current.rows[0].approved_by, 'The approver cannot pay out the same loan');
  const row = current.rows[0];
  const journalId = await postPair(client, ctx, {
    debit: RECEIVABLE,
    credit: payoutAccount(method),
    amount: Number(row.outstanding_balance ?? row.balance ?? row.amount),
    description: `Staff loan ${row.loan_no}`,
    refType: 'employee_loans',
    refId: loanId,
    refCode: String(row.loan_no),
  });
  await client.query(
    `UPDATE employee_loans
        SET status = 'ACTIVE', disbursed_at = now(), disbursed_by = $2, payment_method = $3, gl_journal_id = $4
      WHERE id = $1`,
    [loanId, ctx.userId ?? null, method, journalId]
  );
  await logAudit(client, ctx, {
    action: 'disburse',
    resource: 'loans',
    recordId: loanId,
    recordCode: String(row.loan_no),
    newValues: { status: 'ACTIVE', paymentMethod: method, journalId },
  });
  return { loanId, loanNo: row.loan_no, status: 'ACTIVE', journalId, paymentMethod: method };
}

export async function resumeLoan(client: pg.PoolClient, ctx: Ctx, loanId: number) {
  const res = await client.query(
    `UPDATE employee_loans SET status = 'ACTIVE'
     WHERE id = $1 AND tenant_id = $2 AND status = 'PAUSED'
     RETURNING id, loan_no`,
    [loanId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Loan not found or not paused');
  await logAudit(client, ctx, {
    action: 'resume',
    resource: 'loans',
    recordId: loanId,
    recordCode: String(res.rows[0].loan_no),
    newValues: { status: 'ACTIVE' },
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

export async function writeOffLoan(client: pg.PoolClient, ctx: Ctx, loanId: number, reason?: string | null) {
  const note = String(reason ?? '').trim();
  if (!note) throw badRequest('A write-off needs a reason');
  const current = await client.query(
    `SELECT * FROM employee_loans WHERE id = $1 AND tenant_id = $2 AND status IN ('ACTIVE','PAUSED') FOR UPDATE`,
    [loanId, ctx.tenantId]
  );
  if (current.rows.length === 0) throw badRequest('Loan not found or not active');
  const row = current.rows[0];
  const outstanding = shilling(Number(row.outstanding_balance ?? row.balance ?? 0));
  let journalId: number | null = null;
  if (outstanding > 0 && row.gl_journal_id != null) {
    journalId = await postPair(client, ctx, {
      debit: IMPAIRMENT,
      credit: RECEIVABLE,
      amount: outstanding,
      description: `Write off staff loan ${row.loan_no}`,
      refType: 'employee_loans',
      refId: loanId,
      refCode: String(row.loan_no),
    });
  }
  await client.query(
    `UPDATE employee_loans
        SET status = 'WRITTEN_OFF', balance = 0, outstanding_balance = 0, interest_outstanding = 0
      WHERE id = $1`,
    [loanId]
  );
  await logAudit(client, ctx, {
    action: 'write_off',
    resource: 'loans',
    recordId: loanId,
    recordCode: String(row.loan_no),
    newValues: { status: 'WRITTEN_OFF', outstanding, reason: note, journalId },
  });
  return { loanId, loanNo: row.loan_no, status: 'WRITTEN_OFF', journalId };
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
  const amount = shilling(Math.max(0, Number(input.amount) || 0));
  if (amount <= 0) throw badRequest('Advance amount must be positive');

  // One open request at a time: waiting, approved, or still being recovered.
  const open = await client.query(
    `SELECT advance_no FROM salary_advances
     WHERE employee_id = $1 AND tenant_id = $2
       AND status IN ('PENDING','APPROVED','ACTIVE')
       AND (status <> 'ACTIVE' OR outstanding_balance > 0)`,
    [input.employeeId, ctx.tenantId]
  );
  if (open.rows.length > 0) {
    throw badRequest(`Employee already has an outstanding salary advance (${open.rows[0].advance_no})`);
  }

  // Excessive policy: configurable ceiling as a ratio of monthly basic salary
  // (default 1 = up to one month's salary), stored in app_settings.
  const baseSalary = Math.max(0, Number(emp.base_salary) || 0);
  const maxRatio = Math.max(0, Number(await getSetting(client, ctx, 'payroll', 'advance.max_ratio_of_salary', '1')) || 0);
  const ceiling = shilling(baseSalary * maxRatio);
  if (baseSalary > 0 && amount > ceiling) {
    throw badRequest(`Advance of ${amount} exceeds the configured ceiling (${ceiling} for this employee)`);
  }

  const startDate =
    input.startDate && /^\d{4}-\d{2}-\d{2}/.test(String(input.startDate)) ? String(input.startDate).slice(0, 10) : kampalaToday();
  const monthlyDeduction = shilling(Math.max(0, Number(input.monthlyDeduction) || 0)) || amount;
  const schedule = installments(amount, monthlyDeduction, startDate);
  const advanceNo = await nextDoc(client, ctx, 'ADV');
  const ins = await client.query(
    `INSERT INTO salary_advances
       (company_id, tenant_id, employee_id, advance_no, amount, monthly_deduction, deduction_schedule,
        outstanding_balance, requested_by, reason, start_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$5,$8,$9,$10,'PENDING')
     RETURNING id, advance_no`,
    [ctx.companyId, ctx.tenantId, emp.id, advanceNo, amount, monthlyDeduction, JSON.stringify(schedule), ctx.userId ?? null, input.reason ?? null, startDate]
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
  const current = await client.query(
    `SELECT id, requested_by FROM salary_advances WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING'`,
    [advanceId, ctx.tenantId]
  );
  if (current.rows.length === 0) throw badRequest('Advance not found or not pending');
  assertOtherPerson(ctx.userId, current.rows[0].requested_by, 'You cannot approve an advance you raised');
  const res = await client.query(
    `UPDATE salary_advances SET status = 'APPROVED', approved_by = $2, approved_at = now()
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
    newValues: { status: 'APPROVED' },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.advance.approved',
    entityType: 'hr.advances',
    entityId: advanceId,
    entityCode: String(res.rows[0].advance_no),
    payload: { employeeId: Number(res.rows[0].employee_id) },
  });
  return { advanceId, advanceNo: res.rows[0].advance_no, status: 'APPROVED' };
}

export async function disburseAdvance(
  client: pg.PoolClient,
  ctx: Ctx,
  advanceId: number,
  paymentMethod?: string | null
) {
  const method = String(paymentMethod ?? 'BANK').toUpperCase();
  if (!['BANK', 'CASH', 'MOBILE_MONEY'].includes(method)) throw badRequest('Payment method must be bank, cash or mobile money');
  const current = await client.query(
    `SELECT * FROM salary_advances WHERE id = $1 AND tenant_id = $2 AND status = 'APPROVED' FOR UPDATE`,
    [advanceId, ctx.tenantId]
  );
  if (current.rows.length === 0) throw badRequest('Advance must be approved before it can be paid out');
  assertOtherPerson(ctx.userId, current.rows[0].approved_by, 'The approver cannot pay out the same advance');
  const row = current.rows[0];
  const journalId = await postPair(client, ctx, {
    debit: RECEIVABLE,
    credit: payoutAccount(method),
    amount: Number(row.outstanding_balance ?? row.amount),
    description: `Salary advance ${row.advance_no}`,
    refType: 'salary_advances',
    refId: advanceId,
    refCode: String(row.advance_no),
  });
  await client.query(
    `UPDATE salary_advances
        SET status = 'ACTIVE', disbursed_at = now(), disbursed_by = $2, payment_method = $3, gl_journal_id = $4
      WHERE id = $1`,
    [advanceId, ctx.userId ?? null, method, journalId]
  );
  await logAudit(client, ctx, {
    action: 'disburse',
    resource: 'advances',
    recordId: advanceId,
    recordCode: String(row.advance_no),
    newValues: { status: 'ACTIVE', paymentMethod: method, journalId },
  });
  return { advanceId, advanceNo: row.advance_no, status: 'ACTIVE', journalId, paymentMethod: method };
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
     WHERE id = $1 AND tenant_id = $2 AND status IN ('ACTIVE','PAID') AND outstanding_balance <= 0
     RETURNING id, advance_no`,
    [advanceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Advance can be closed only after the balance is recovered');
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'advances',
    recordId: advanceId,
    recordCode: String(res.rows[0].advance_no),
    newValues: { status: 'CLOSED' },
  });
  return { advanceId, advanceNo: res.rows[0].advance_no, status: 'CLOSED' };
}

export async function waiveAdvance(client: pg.PoolClient, ctx: Ctx, advanceId: number, reason?: string | null) {
  const note = String(reason ?? '').trim();
  if (!note) throw badRequest('A waiver needs a reason');
  const current = await client.query(
    `SELECT * FROM salary_advances WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE' FOR UPDATE`,
    [advanceId, ctx.tenantId]
  );
  if (current.rows.length === 0) throw badRequest('Advance not found or not active');
  const row = current.rows[0];
  const outstanding = shilling(Number(row.outstanding_balance ?? 0));
  let journalId: number | null = null;
  if (outstanding > 0 && row.gl_journal_id != null) {
    journalId = await postPair(client, ctx, {
      debit: IMPAIRMENT,
      credit: RECEIVABLE,
      amount: outstanding,
      description: `Waive salary advance ${row.advance_no}`,
      refType: 'salary_advances',
      refId: advanceId,
      refCode: String(row.advance_no),
    });
  }
  await client.query(
    `UPDATE salary_advances SET status = 'WAIVED', outstanding_balance = 0 WHERE id = $1`,
    [advanceId]
  );
  await logAudit(client, ctx, {
    action: 'waive',
    resource: 'advances',
    recordId: advanceId,
    recordCode: String(row.advance_no),
    newValues: { status: 'WAIVED', outstanding, reason: note, journalId },
  });
  return { advanceId, advanceNo: row.advance_no, status: 'WAIVED', journalId };
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

// ---------------------------------------------------------------------------
// Staff fines
// A fine is an authorised payroll recovery with a written reason. It is not
// one of the disciplinary penalties in the Employment Act. Approval by someone
// other than the requester raises the receivable; payroll clears it.
// ---------------------------------------------------------------------------

export async function createFine(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    employeeId: number;
    amount: number;
    monthlyDeduction?: number;
    reason?: string | null;
    incidentDate?: string | null;
    disciplinaryCaseId?: number | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const emp = await loadEmployee(client, ctx, Number(input.employeeId));
  const amount = shilling(Math.max(0, Number(input.amount) || 0));
  if (amount <= 0) throw badRequest('Fine amount must be positive');
  const reason = String(input.reason ?? '').trim();
  if (!reason) throw badRequest('A fine needs a written reason');
  const monthlyDeduction = shilling(Number(input.monthlyDeduction) > 0 ? Number(input.monthlyDeduction) : amount);
  const incidentDate =
    input.incidentDate && /^\d{4}-\d{2}-\d{2}/.test(String(input.incidentDate))
      ? String(input.incidentDate).slice(0, 10)
      : null;
  const fineNo = await nextDoc(client, ctx, 'FIN');
  const ins = await client.query(
    `INSERT INTO employee_fines
       (company_id, tenant_id, employee_id, disciplinary_case_id, fine_no, amount, outstanding_balance,
        monthly_deduction, reason, incident_date, requested_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,'PENDING')
     RETURNING id, fine_no`,
    [
      ctx.companyId,
      ctx.tenantId,
      emp.id,
      input.disciplinaryCaseId != null ? Number(input.disciplinaryCaseId) : null,
      fineNo,
      amount,
      monthlyDeduction,
      reason,
      incidentDate,
      ctx.userId ?? null,
    ]
  );
  const fineId = Number(ins.rows[0].id);
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'fines',
    recordId: fineId,
    recordCode: fineNo,
    newValues: { employeeId: emp.id, amount, monthlyDeduction, reason, incidentDate },
  });
  return { fineId, fineNo, status: 'PENDING', employeeId: emp.id, amount, monthlyDeduction };
}

export async function approveFine(client: pg.PoolClient, ctx: Ctx, fineId: number) {
  const current = await client.query(
    `SELECT * FROM employee_fines WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING' FOR UPDATE`,
    [fineId, ctx.tenantId]
  );
  if (current.rows.length === 0) throw badRequest('Fine not found or not awaiting approval');
  const row = current.rows[0];
  assertOtherPerson(ctx.userId, row.requested_by, 'You cannot approve a fine you raised');
  const journalId = await postPair(client, ctx, {
    debit: RECEIVABLE,
    credit: OTHER_INCOME,
    amount: Number(row.outstanding_balance ?? row.amount),
    description: `Staff fine ${row.fine_no}`,
    refType: 'employee_fines',
    refId: fineId,
    refCode: String(row.fine_no),
  });
  await client.query(
    `UPDATE employee_fines
        SET status = 'ACTIVE', approved_by = $2, approved_at = now(), gl_journal_id = $3
      WHERE id = $1`,
    [fineId, ctx.userId ?? null, journalId]
  );
  await logAudit(client, ctx, {
    action: 'approve',
    resource: 'fines',
    recordId: fineId,
    recordCode: String(row.fine_no),
    newValues: { status: 'ACTIVE', journalId },
  });
  return { fineId, fineNo: row.fine_no, status: 'ACTIVE', journalId };
}

export async function rejectFine(client: pg.PoolClient, ctx: Ctx, fineId: number) {
  const res = await client.query(
    `UPDATE employee_fines SET status = 'REJECTED', approved_by = $2, approved_at = now()
     WHERE id = $1 AND tenant_id = $3 AND status = 'PENDING'
     RETURNING id, fine_no`,
    [fineId, ctx.userId ?? null, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Fine not found or not pending');
  await logAudit(client, ctx, {
    action: 'reject',
    resource: 'fines',
    recordId: fineId,
    recordCode: String(res.rows[0].fine_no),
    newValues: { status: 'REJECTED' },
  });
  return { fineId, fineNo: res.rows[0].fine_no, status: 'REJECTED' };
}

export async function waiveFine(client: pg.PoolClient, ctx: Ctx, fineId: number, reason?: string | null) {
  const note = String(reason ?? '').trim();
  if (!note) throw badRequest('A waiver needs a reason');
  const current = await client.query(
    `SELECT * FROM employee_fines WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE' FOR UPDATE`,
    [fineId, ctx.tenantId]
  );
  if (current.rows.length === 0) throw badRequest('Fine not found or not active');
  const row = current.rows[0];
  const outstanding = shilling(Number(row.outstanding_balance ?? 0));
  let journalId: number | null = null;
  if (outstanding > 0 && row.gl_journal_id != null) {
    journalId = await postPair(client, ctx, {
      debit: IMPAIRMENT,
      credit: RECEIVABLE,
      amount: outstanding,
      description: `Waive staff fine ${row.fine_no}`,
      refType: 'employee_fines',
      refId: fineId,
      refCode: String(row.fine_no),
    });
  }
  await client.query(
    `UPDATE employee_fines SET status = 'WAIVED', outstanding_balance = 0 WHERE id = $1`,
    [fineId]
  );
  await logAudit(client, ctx, {
    action: 'waive',
    resource: 'fines',
    recordId: fineId,
    recordCode: String(row.fine_no),
    newValues: { status: 'WAIVED', outstanding, reason: note, journalId },
  });
  return { fineId, fineNo: row.fine_no, status: 'WAIVED', journalId };
}

export async function listFines(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { employeeId?: number; status?: string; q?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(filters.pageSize) || 25));
  const where = [
    'f.tenant_id = $1',
    'f.company_id = $2',
    '$3::bigint IS NULL OR f.employee_id = $3',
    '$4::text IS NULL OR f.status = $4',
    `$5::text IS NULL OR (e.first_name ILIKE '%'||$5||'%' OR e.last_name ILIKE '%'||$5||'%' OR f.fine_no ILIKE '%'||$5||'%' OR f.reason ILIKE '%'||$5||'%')`,
  ].join(' AND ');
  const params: unknown[] = [
    ctx.tenantId,
    ctx.companyId,
    filters.employeeId != null ? Number(filters.employeeId) : null,
    filters.status ? String(filters.status) : null,
    filters.q ? String(filters.q) : null,
  ];
  const count = await client.query(
    `SELECT count(*)::int AS total FROM employee_fines f JOIN employees e ON e.id = f.employee_id WHERE ${where}`,
    params
  );
  const res = await client.query(
    `SELECT f.id, f.fine_no, f.amount, f.monthly_deduction, f.outstanding_balance, f.reason,
            f.incident_date, f.status, f.approved_at, f.created_at,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name, e.position
     FROM employee_fines f JOIN employees e ON e.id = f.employee_id
     WHERE ${where}
     ORDER BY f.id DESC
     LIMIT $6 OFFSET $7`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  return { items: toCamelRows(res.rows), total: Number(count.rows[0].total), page, pageSize };
}

export async function getFine(client: pg.PoolClient, ctx: Ctx, fineId: number) {
  const res = await client.query(
    `SELECT f.*, e.employee_no, e.first_name, e.last_name, e.position
     FROM employee_fines f JOIN employees e ON e.id = f.employee_id
     WHERE f.id = $1 AND f.tenant_id = $2`,
    [fineId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Fine not found');
  const reps = await client.query(
    `SELECT id, payroll_run_id, amount, paid_at, created_at
     FROM fine_recoveries WHERE fine_id = $1 AND tenant_id = $2 ORDER BY id DESC`,
    [fineId, ctx.tenantId]
  );
  return { fine: toCamelRow(res.rows[0]), recoveries: toCamelRows(reps.rows) };
}