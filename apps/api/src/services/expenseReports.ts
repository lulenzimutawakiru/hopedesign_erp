import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { startWorkflow } from './workflow.js';
import * as finance from './finance.js';
import { logAudit } from './audit.js';

const round2 = (v: number) => Math.round(v * 100) / 100;
const num0 = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const isoDate = (v: unknown): string => toISODate(v) ?? new Date().toISOString().slice(0, 10);

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

function companyId(ctx: Ctx): number {
  if (!ctx.companyId) throw badRequest('Company context required');
  return ctx.companyId;
}

/**
 * The report is a batch sheet of employee expense claims. Its total is the sum
 * of its member claims; it is not a maintained column, so it can never drift
 * from the claims it groups.
 */
const REPORT_SELECT = `
  SELECT r.*, e.employee_no, e.first_name, e.last_name,
         (e.first_name || ' ' || e.last_name) AS employee_name,
         (u.first_name || ' ' || u.last_name) AS created_by_name,
         (a.first_name || ' ' || a.last_name) AS approved_by_name,
         (rb.first_name || ' ' || rb.last_name) AS reimbursed_by_name,
         COALESCE((
           SELECT SUM(c.amount) FROM employee_expense_claims c
           WHERE c.report_id = r.id
         ), 0) AS total_amount,
         (SELECT COUNT(*) FROM employee_expense_claims c WHERE c.report_id = r.id) AS claim_count
  FROM expense_reports r
  LEFT JOIN employees e ON e.id = r.employee_id
  LEFT JOIN users u ON u.id = r.created_by
  LEFT JOIN users a ON a.id = r.approved_by
  LEFT JOIN users rb ON rb.id = r.reimbursed_by
`;

export async function reportsMeta(client: pg.PoolClient, ctx: Ctx) {
  const employees = await client.query(
    `SELECT id, employee_no, first_name, last_name, (first_name || ' ' || last_name) AS name
     FROM employees
     WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
     ORDER BY first_name LIMIT 500`,
    [companyId(ctx), ctx.tenantId]
  );
  // Claims eligible to be grouped: approved, not yet in a report, not reimbursed.
  const openClaims = await client.query(
    `SELECT c.id, c.claim_no, c.amount, c.expense_date, c.description, c.trip,
            e.employee_no, e.first_name, e.last_name
     FROM employee_expense_claims c
     LEFT JOIN employees e ON e.id = c.employee_id
     WHERE c.company_id = $1 AND c.tenant_id = $2
       AND c.status = 'APPROVED' AND c.report_id IS NULL
     ORDER BY c.expense_date DESC LIMIT 500`,
    [companyId(ctx), ctx.tenantId]
  );
  return { employees: toCamelRows(employees.rows), openClaims: toCamelRows(openClaims.rows) };
}

export async function createReport(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const title = String(b.title ?? '').trim();
  if (!title) throw badRequest('Report title is required');
  const mode = String(b.reimbursementMode ?? 'DIRECT');
  const employeeId = n(b.employeeId);
  if (mode === 'PAYSLIP' && employeeId == null) {
    throw badRequest('A payslip reimbursement needs an employee to attach the report to');
  }
  const reportNo = await nextDoc(client, ctx, 'RPT');
  const ins = await client.query(
    `INSERT INTO expense_reports
       (company_id, tenant_id, branch_id, report_no, employee_id, title, description,
        reimbursement_mode, currency, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10) RETURNING id`,
    [companyId(ctx), ctx.tenantId, ctx.branchId ?? null, reportNo, employeeId, title,
     s(b.description), mode, String(b.currency ?? 'UGX'), ctx.userId ?? null]
  );
  const reportId = Number(ins.rows[0].id);
  await logAudit(client, ctx, { action: 'create', resource: 'expenses.expense_reports', recordId: reportId, recordCode: reportNo, newValues: { title } });
  return getReport(client, ctx, reportId);
}

export async function getReport(client: pg.PoolClient, ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const res = await client.query(
    `${REPORT_SELECT} WHERE r.id = $1 AND r.tenant_id = $2 AND r.company_id = $3`,
    [id, ctx.tenantId, companyId(ctx)]
  );
  if (!res.rows.length) throw notFound('Expense report not found');
  const claims = await client.query(
    `SELECT c.*, e.employee_no, e.first_name, e.last_name
     FROM employee_expense_claims c
     LEFT JOIN employees e ON e.id = c.employee_id
     WHERE c.report_id = $1 ORDER BY c.expense_date, c.id`,
    [id]
  );
  return { ...toCamelRow(res.rows[0]), claims: toCamelRows(claims.rows) };
}

export async function listReports(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const params: unknown[] = [ctx.tenantId, companyId(ctx)];
  const where = ['r.tenant_id = $1', 'r.company_id = $2'];
  if (s(q.status)) { params.push(s(q.status)); where.push(`r.status = $${params.length}`); }
  if (n(q.employeeId) != null) { params.push(n(q.employeeId)); where.push(`r.employee_id = $${params.length}`); }
  if (s(q.q)) { params.push(`%${s(q.q)}%`); where.push(`(r.report_no ILIKE $${params.length} OR r.title ILIKE $${params.length})`); }
  const page = q.page != null ? Math.max(1, Number(q.page)) : 1;
  const pageSize = q.pageSize != null ? Math.max(1, Number(q.pageSize)) : 30;
  params.push(pageSize, (page - 1) * pageSize);
  const rows = await client.query(
    `${REPORT_SELECT} WHERE ${where.join(' AND ')}
     ORDER BY r.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const totalRes = await client.query(
    `SELECT COUNT(*)::int AS total FROM expense_reports r WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(rows.rows), total: Number(totalRes.rows[0].total) };
}

export async function updateReport(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown>) {
  const cur = await getReport(client, ctx, id);
  if (cur.status !== 'DRAFT') throw badRequest(`Only draft reports can be edited (current: ${cur.status})`);
  const title = b.title != null ? String(b.title).trim() : String(cur.title ?? '');
  if (!title) throw badRequest('Report title is required');
  await client.query(
    `UPDATE expense_reports
        SET title = $2, description = $3, reimbursement_mode = $4, employee_id = $5, updated_by = $6, updated_at = now()
      WHERE id = $1`,
    [id, title, b.description != null ? s(b.description) : s(cur.description),
     String(b.reimbursementMode ?? cur.reimbursementMode), b.employeeId != null ? n(b.employeeId) : n(cur.employeeId), ctx.userId ?? null]
  );
  await logAudit(client, ctx, { action: 'update', resource: 'expenses.expense_reports', recordId: id, recordCode: String(cur.reportNo), newValues: { title } });
  return getReport(client, ctx, id);
}

async function claimById(client: pg.PoolClient, ctx: Ctx, claimId: number): Promise<Record<string, unknown>> {
  const res = await client.query(
    `SELECT * FROM employee_expense_claims WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [claimId, ctx.tenantId, companyId(ctx)]
  );
  if (!res.rows.length) throw notFound('Claim not found');
  return toCamelRow(res.rows[0]);
}

export async function addClaimToReport(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown>) {
  const report = await getReport(client, ctx, id);
  if (report.status !== 'DRAFT') throw badRequest(`Only draft reports can be changed (current: ${report.status})`);
  const claimId = Number(b.claimId);
  if (!Number.isFinite(claimId) || claimId <= 0) throw badRequest('A claim id is required');
  const claim = await claimById(client, ctx, claimId);
  if (claim.status !== 'APPROVED') throw badRequest(`Only approved claims can be grouped (current: ${claim.status})`);
  if (claim.reportId != null && Number(claim.reportId) !== id) throw badRequest('Claim is already in another report');
  if (claim.reimbursementPayrollId != null) throw badRequest('Claim is already queued for a payroll run');
  if (report.employeeId != null && claim.employeeId != null && Number(report.employeeId) !== Number(claim.employeeId)) {
    throw badRequest('The claim belongs to a different employee than the report');
  }
  await client.query(`UPDATE employee_expense_claims SET report_id = $2 WHERE id = $1`, [claimId, id]);
  await logAudit(client, ctx, { action: 'add_claim', resource: 'expenses.expense_reports', recordId: id, recordCode: String(report.reportNo), newValues: { claimId } });
  return getReport(client, ctx, id);
}

export async function removeClaimFromReport(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown>) {
  const report = await getReport(client, ctx, id);
  if (report.status !== 'DRAFT') throw badRequest(`Only draft reports can be changed (current: ${report.status})`);
  const claimId = Number(b.claimId);
  if (!Number.isFinite(claimId) || claimId <= 0) throw badRequest('A claim id is required');
  await client.query(`UPDATE employee_expense_claims SET report_id = NULL WHERE id = $1 AND report_id = $2`, [claimId, id]);
  await logAudit(client, ctx, { action: 'remove_claim', resource: 'expenses.expense_reports', recordId: id, recordCode: String(report.reportNo), newValues: { claimId } });
  return getReport(client, ctx, id);
}

export async function submitReport(client: pg.PoolClient, ctx: Ctx, id: number) {
  const cur = await getReport(client, ctx, id);
  if (cur.status !== 'DRAFT') throw badRequest(`Only draft reports can be submitted (current: ${cur.status})`);
  const count = Number(cur.claimCount ?? 0);
  if (count === 0) throw badRequest('Add at least one approved claim before submitting');
  await client.query(`UPDATE expense_reports SET status = 'SUBMITTED', submitted_by = $2, submitted_at = now() WHERE id = $1`, [id, ctx.userId ?? null]);
  const instanceId = await startWorkflow(client, ctx, {
    entityType: 'ops.expense_reports', entityId: id, entityCode: String(cur.reportNo),
    amount: num0(cur.totalAmount), companyId: ctx.companyId ?? null, branchId: ctx.branchId ?? null,
  });
  await client.query(
    `INSERT INTO approval_actions (company_id, tenant_id, entity_type, entity_id, entity_code, action, actor_user_id, metadata)
     VALUES ($1,$2,'ops.expense_reports',$3,$4,'SUBMIT',$5,$6::jsonb)`,
    [companyId(ctx), ctx.tenantId, id, String(cur.reportNo), ctx.userId ?? null, JSON.stringify({ amount: num0(cur.totalAmount), instanceId })]
  );
  await logAudit(client, ctx, { action: 'submit', resource: 'expenses.expense_reports', recordId: id, recordCode: String(cur.reportNo), newValues: { status: 'SUBMITTED' } });
  return getReport(client, ctx, id);
}

/**
 * Settle an APPROVED report. DIRECT mode posts a reimbursement journal now;
 * PAYSLIP mode is settled by the next payroll run (the report stays APPROVED
 * until `postPayrollRun` marks it REIMBURSED) and is never settled here.
 */
export async function reimburseReport(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown> = {}) {
  const cur = await getReport(client, ctx, id);
  if (cur.status !== 'APPROVED') throw badRequest(`Only approved reports can be reimbursed (current: ${cur.status})`);
  if (String(cur.reimbursementMode) === 'PAYSLIP') {
    throw badRequest('This report is set to reimburse via payslip — it is settled automatically by the next payroll run.');
  }
  const amount = num0(cur.totalAmount);
  if (amount <= 0) throw badRequest('Report has no amount to reimburse');
  const journalId = await finance.postJournalLines(client, ctx, {
    entryDate: new Date().toISOString().slice(0, 10),
    journalType: 'EXPENSE',
    description: `Employee expense report reimbursement ${cur.reportNo}`,
    lines: [
      { account_id: await finance.getAccountId(client, ctx, '10254500'), debit: amount, credit: 0, description: `Report ${cur.reportNo}` },
      { account_id: await finance.getAccountId(client, ctx, '10111200'), debit: 0, credit: amount, description: `Reimbursement ${cur.reportNo}` },
    ],
    refType: 'claim', refId: id, refCode: String(cur.reportNo),
  });
  await client.query(
    `UPDATE expense_reports
        SET status = 'REIMBURSED', reimbursed_by = $2, reimbursed_at = now(), gl_posted = true, gl_journal_id = $3
      WHERE id = $1`,
    [id, ctx.userId ?? null, journalId]
  );
  // The member claims are settled with the report.
  await client.query(
    `UPDATE employee_expense_claims
        SET status = 'REIMBURSED', reimbursed_by = $2, reimbursed_at = now(), gl_posted = true, gl_journal_id = $3
      WHERE report_id = $1 AND status = 'APPROVED'`,
    [id, ctx.userId ?? null, journalId]
  );
  await logAudit(client, ctx, { action: 'reimburse', resource: 'expenses.expense_reports', recordId: id, recordCode: String(cur.reportNo), newValues: { status: 'REIMBURSED', journalId } });
  return getReport(client, ctx, id);
}
