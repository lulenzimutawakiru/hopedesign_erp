import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, conflict, notFound, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { logAudit } from './audit.js';
import { emitEvent } from './events.js';
import * as hr from './hr.js';

/**
 * Payroll lifecycle: the controlled transitions that turn a draft run into a
 * released, paid, posted and finally closed financial record.
 *
 * Every transition is executed by `transition()` so that the four records an
 * enterprise payroll must leave behind - status history, an approval decision,
 * the run lock and the append-only payroll audit trail - are written in the
 * same transaction as the status change itself. A payroll therefore cannot be
 * APPROVED without evidence of who approved it, from which role, and when.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sentinel for a timestamp set to the database's own clock. */
const SQL_NOW = '@@now';

/** Columns a transition is allowed to touch; anything else is a programming error. */
const TRANSITION_COLUMNS = new Set([
  'approved_by', 'approved_at', 'reviewed_by', 'reviewed_at',
  'released_by', 'released_at', 'closed_by', 'closed_at',
  'reopened_by', 'reopened_at', 'reopen_count', 'locked_at',
  'gl_posted', 'gl_journal_id',
]);

export type LifecycleAction =
  | 'SUBMIT' | 'REVIEW' | 'APPROVE' | 'REJECT' | 'RETURN'
  | 'LOCK' | 'UNLOCK' | 'POST' | 'RELEASE' | 'PAY'
  | 'CLOSE' | 'REOPEN' | 'REVERSE' | 'CANCEL';

export interface TransitionInput {
  payrollId: number;
  /** Statuses this action may be applied from. */
  from: string[];
  to: string;
  action: LifecycleAction;
  stage: string;
  label: string;
  reason?: string | null;
  comment?: string | null;
  /** Extra whitelisted columns to write; SQL_NOW resolves to now(). */
  set?: Record<string, string | number | boolean | null | undefined>;
  lock?: 'LOCK' | 'UNLOCK' | null;
}

/** The role the acting user held, recorded on the decision itself. */
async function actorRoleCode(client: pg.PoolClient, ctx: Ctx): Promise<string> {
  if (ctx.userId == null) return 'UNKNOWN';
  const res = await client.query(
    `SELECT r.code
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND (ur.company_id IS NULL OR ur.company_id = $2)
      ORDER BY r.id
      LIMIT 1`,
    [ctx.userId, ctx.companyId ?? null]
  );
  return res.rows[0] ? String(res.rows[0].code) : 'UNKNOWN';
}

export interface TransitionResult {
  id: number;
  payrollNo: string;
  fromStatus: string;
  status: string;
  roleCode: string;
}

/**
 * Apply one status transition atomically, recording history, decision, lock and
 * audit. Locks the run row first so two operators cannot race the same
 * transition, and rejects any transition that is not legal from the current
 * status.
 */
export async function transition(
  client: pg.PoolClient,
  ctx: Ctx,
  input: TransitionInput
): Promise<TransitionResult> {
  if (ctx.userId == null) {
    throw badRequest('An authenticated user is required to change payroll status');
  }
  const run = await client.query(
    `SELECT id, payroll_no, status, run_type FROM payrolls
      WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [input.payrollId, ctx.tenantId]
  );
  if (run.rows.length === 0) throw notFound('Payroll not found');
  const row = run.rows[0];
  const fromStatus = String(row.status);
  if (!input.from.includes(fromStatus)) {
    throw conflict(
      `${input.label}: payroll ${row.payroll_no} is ${fromStatus}; this action requires ${input.from.join(' or ')}`
    );
  }
  const roleCode = await actorRoleCode(client, ctx);

  const params: unknown[] = [input.payrollId, input.to];
  const sets: string[] = ['status = $2', 'updated_at = now()'];
  for (const [col, value] of Object.entries(input.set ?? {})) {
    if (!TRANSITION_COLUMNS.has(col)) throw new Error(`payroll transition cannot set ${col}`);
    if (value === SQL_NOW) sets.push(`${col} = now()`);
    else if (value === undefined || value === null) sets.push(`${col} = NULL`);
    else { params.push(value); sets.push(`${col} = ${params.length}`); }
  }
  await client.query(`UPDATE payrolls SET ${sets.join(', ')} WHERE id = $1`, params);

  await client.query(
    `INSERT INTO payroll_status_history
       (company_id, tenant_id, payroll_id, from_status, to_status, changed_by, changed_at, comment, reason, ip)
     VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8,$9)`,
    [ctx.companyId, ctx.tenantId, input.payrollId, fromStatus, input.to,
     ctx.userId, input.comment ?? null, input.reason ?? null, ctx.ip ?? null]
  );

  await client.query(
    `INSERT INTO payroll_approvals
       (company_id, tenant_id, payroll_id, approver_user_id, role_code, action, comment, decided_at,
        ip, user_agent, approval_stage, previous_status, new_status, device)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11,$12,$13)`,
    [ctx.companyId, ctx.tenantId, input.payrollId, ctx.userId, roleCode, input.action,
     input.comment ?? null, ctx.ip ?? null, ctx.userAgent ?? null,
     input.stage, fromStatus, input.to, ctx.device ?? null]
  );

  if (input.lock === 'LOCK') {
    await client.query(
      `UPDATE payroll_locks SET status = 'UNLOCKED', unlocked_by = $1, unlocked_at = now(), unlock_reason = $2
        WHERE payroll_id = $3 AND status = 'LOCKED'`,
      [ctx.userId, `Superseded by ${input.action}`, input.payrollId]
    );
    await client.query(
      `INSERT INTO payroll_locks (company_id, tenant_id, payroll_id, status, locked_by, locked_at, reason)
       VALUES ($1,$2,$3,'LOCKED',$4,now(),$5)`,
      [ctx.companyId, ctx.tenantId, input.payrollId, ctx.userId, input.reason ?? input.label]
    );
  } else if (input.lock === 'UNLOCK') {
    await client.query(
      `UPDATE payroll_locks SET status = 'UNLOCKED', unlocked_by = $1, unlocked_at = now(), unlock_reason = $2
        WHERE payroll_id = $3 AND status = 'LOCKED'`,
      [ctx.userId, input.reason ?? input.label, input.payrollId]
    );
  }

  await client.query(
    `INSERT INTO payroll_audit_logs
       (company_id, tenant_id, payroll_id, action, resource, previous_value, new_value,
        reason, user_id, ip, user_agent, device, correlation_id)
     VALUES ($1,$2,$3,$4,'payroll',$5,$6,$7,$8,$9,$10,$11,$12)`,
    [ctx.companyId, ctx.tenantId, input.payrollId, input.action,
     JSON.stringify({ status: fromStatus }), JSON.stringify({ status: input.to }),
     input.reason ?? null, ctx.userId, ctx.ip ?? null, ctx.userAgent ?? null,
     ctx.device ?? null, ctx.correlationId ?? null]
  );

  await logAudit(client, ctx, {
    action: `hr.payroll.${input.action.toLowerCase()}`,
    resource: 'hr.payrolls',
    recordId: input.payrollId,
    recordCode: String(row.payroll_no),
    oldValues: { status: fromStatus },
    newValues: { status: input.to },
    metadata: { stage: input.stage, reason: input.reason ?? null, roleCode },
  });

  return { id: input.payrollId, payrollNo: String(row.payroll_no), fromStatus, status: input.to, roleCode };
}

/**
 * Statuses from which an approval decision is meaningful. A run that has moved
 * past this window (for example one that was already released) must not be
 * dragged back by a stale task decision.
 */
export const PAYROLL_APPROVAL_STATUSES = ['SUBMITTED', 'VALIDATING', 'REVIEW', 'PENDING_APPROVAL'];

/**
 * Record an approval decision taken through the generic workflow engine.
 *
 * Payroll approvals are decided from the shared approvals queue
 * (POST /api/approvals/:taskId/decide), which completes or rejects a workflow
 * instance. Routing that decision through transition() preserves the guarantee
 * made at the top of this file: a payroll can never reach APPROVED - or be
 * returned to the preparer - without a status-history row, a decision row, the
 * run lock and an append-only audit event, all written atomically.
 *
 * Returns null when the run is missing or has already moved past the approval
 * window, so the caller can fall back to its own status handling.
 */
export async function recordWorkflowDecision(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { payrollId: number; approved: boolean; comment?: string | null }
): Promise<TransitionResult | null> {
  const current = await client.query(
    `SELECT status FROM payrolls WHERE id = $1 AND tenant_id = $2`,
    [input.payrollId, ctx.tenantId]
  );
  if (current.rows.length === 0) return null;
  if (!PAYROLL_APPROVAL_STATUSES.includes(String(current.rows[0].status))) return null;
  return transition(client, ctx, {
    payrollId: input.payrollId,
    from: PAYROLL_APPROVAL_STATUSES,
    to: input.approved ? 'APPROVED' : 'DRAFT',
    action: input.approved ? 'APPROVE' : 'RETURN',
    stage: input.approved ? 'MANAGEMENT_APPROVAL' : 'HR_REVIEW',
    label: input.approved ? 'Approve payroll' : 'Return payroll for correction',
    comment: input.comment ?? null,
    reason: input.approved ? null : input.comment ?? 'Returned for correction',
    set: input.approved ? { approved_by: ctx.userId, approved_at: SQL_NOW } : undefined,
  });
}

// ===========================================================================
// Run-level operations
// ===========================================================================

/** APPROVED -> RELEASED. The last control point before money leaves the bank. */
export async function releasePayroll(
  client: pg.PoolClient,
  ctx: Ctx,
  payrollId: number,
  opts: { comment?: string | null } = {}
) {
  const result = await transition(client, ctx, {
    payrollId,
    from: ['APPROVED'],
    to: 'RELEASED',
    action: 'RELEASE',
    stage: 'PAYMENT_AUTHORIZATION',
    label: 'Release payroll',
    comment: opts.comment ?? null,
    set: { released_by: ctx.userId, released_at: SQL_NOW, locked_at: SQL_NOW },
    lock: 'LOCK',
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.payroll.released',
    entityType: 'hr.payrolls',
    entityId: payrollId,
    entityCode: result.payrollNo,
    payload: { releasedBy: ctx.userId ?? null },
  });
  return result;
}

/**
 * RELEASED -> PAID.
 *
 * A payment file is not a payment. The run may only be marked PAID once a
 * payment batch for it has actually been confirmed against the bank/mobile
 * response, so the payroll's paid status always reflects disbursed funds.
 */
export async function markPayrollPaid(
  client: pg.PoolClient,
  ctx: Ctx,
  payrollId: number,
  opts: { comment?: string | null } = {}
) {
  const batches = await client.query(
    `SELECT status FROM payment_batches
      WHERE payroll_id = $1 AND tenant_id = $2 AND company_id = $3`,
    [payrollId, ctx.tenantId, ctx.companyId]
  );
  if (batches.rows.length === 0) {
    throw badRequest('No payment batch exists for this payroll. Create, export and confirm a payment batch before marking it paid.');
  }
  const confirmed = batches.rows.some((b) => ['CONFIRMED', 'RECONCILED'].includes(String(b.status)));
  if (!confirmed) {
    throw badRequest('The payment batch for this payroll has not been confirmed. Confirm the bank/mobile transactions before marking the payroll paid.');
  }
  const result = await transition(client, ctx, {
    payrollId,
    from: ['RELEASED'],
    to: 'PAID',
    action: 'PAY',
    stage: 'PAYMENT',
    label: 'Mark payroll paid',
    comment: opts.comment ?? null,
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.payroll.paid',
    entityType: 'hr.payrolls',
    entityId: payrollId,
    entityCode: result.payrollNo,
    payload: {},
  });
  return result;
}

/**
 * PAID/POSTED -> CLOSED. Closing is terminal: the run is locked, the linked
 * payroll period may be closed, and only an authorised reopen can undo it.
 */
export async function closePayroll(
  client: pg.PoolClient,
  ctx: Ctx,
  payrollId: number,
  opts: { comment?: string | null; varianceExplanation?: string | null } = {}
) {
  const result = await transition(client, ctx, {
    payrollId,
    from: ['PAID', 'POSTED'],
    to: 'CLOSED',
    action: 'CLOSE',
    stage: 'CLOSE',
    label: 'Close payroll',
    comment: opts.comment ?? null,
    set: {
      closed_by: ctx.userId,
      closed_at: SQL_NOW,
      variance_explanation: opts.varianceExplanation ?? null,
    },
    lock: 'LOCK',
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.payroll.closed',
    entityType: 'hr.payrolls',
    entityId: payrollId,
    entityCode: result.payrollNo,
    payload: {},
  });
  return result;
}

/**
 * Reopen an approved, released, paid or closed run. Requires an authorised
 * justification, increments the reopen counter, clears the previous approvals
 * so the run must be approved again, and optionally recalculates immediately.
 *
 * A GL-posted run cannot be reopened: the ledger already carries the entry, and
 * silently re-posting it would double-count the cost. It must be reversed first.
 */
export async function reopenPayroll(
  client: pg.PoolClient,
  ctx: Ctx,
  payrollId: number,
  opts: { reason: string; recalculate?: boolean }
) {
  const reason = String(opts.reason ?? '').trim();
  if (reason.length < 10) {
    throw badRequest('Reopening payroll requires a written reason of at least 10 characters for the audit record.');
  }
  const current = await client.query(
    `SELECT id, payroll_no, status, gl_posted, reopen_count FROM payrolls
      WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [payrollId, ctx.tenantId]
  );
  if (current.rows.length === 0) throw notFound('Payroll not found');
  const row = current.rows[0];
  if (row.gl_posted) {
    throw conflict(
      `Payroll ${row.payroll_no} is posted to the general ledger. Reverse the GL posting before reopening it, otherwise the cost would be posted twice.`
    );
  }
  const from = String(row.status);
  if (!['APPROVED', 'RELEASED', 'PAID', 'POSTED', 'CLOSED', 'LOCKED'].includes(from)) {
    throw conflict(`Payroll ${row.payroll_no} is ${from} and cannot be reopened`);
  }
  const reopenCount = Number(row.reopen_count ?? 0) + 1;

  await transition(client, ctx, {
    payrollId,
    from: [from],
    to: 'REOPENED',
    action: 'REOPEN',
    stage: 'REOPEN',
    label: 'Reopen payroll',
    reason,
    set: { reopened_by: ctx.userId, reopened_at: SQL_NOW, reopen_count: reopenCount, locked_at: null },
    lock: 'UNLOCK',
  });
  const result = await transition(client, ctx, {
    payrollId,
    from: ['REOPENED'],
    to: 'DRAFT',
    action: 'REOPEN',
    stage: 'REOPEN',
    label: 'Reopen payroll',
    reason,
    set: {
      approved_by: null, approved_at: null,
      reviewed_by: null, reviewed_at: null,
      released_by: null, released_at: null,
      closed_by: null, closed_at: null,
    },
  });

  await emitEvent(client, ctx, {
    eventType: 'hr.payroll.reopened',
    entityType: 'hr.payrolls',
    entityId: payrollId,
    entityCode: result.payrollNo,
    payload: { reason, reopenCount, previousStatus: from },
  });

  if (opts.recalculate !== false) {
    const calc = await hr.calculatePayroll(client, ctx, payrollId);
    return { ...result, recalculated: true, calculation: calc };
  }
  return { ...result, recalculated: false };
}
/**
 * Void a run that should never have existed - created against the wrong
 * period, the wrong group, or duplicated by a retry.
 *
 * Void is deliberately narrower than reopen. It is refused once money has
 * actually left the bank (a confirmed or reconciled payment batch) or once
 * the cost is in the general ledger, because reversing those is a financial
 * correction rather than a cancellation and must go through reverse/reopen.
 * The run is locked and kept for audit; it is never deleted.
 */
export async function voidPayroll(
  client: pg.PoolClient,
  ctx: Ctx,
  payrollId: number,
  opts: { reason: string }
) {
  const reason = String(opts.reason ?? '').trim();
  if (reason.length < 10) {
    throw badRequest('Voiding payroll requires a written reason of at least 10 characters for the audit record.');
  }
  const current = await client.query(
    `SELECT id, payroll_no, status, gl_posted FROM payrolls
      WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [payrollId, ctx.tenantId]
  );
  if (current.rows.length === 0) throw notFound('Payroll not found');
  const row = current.rows[0];
  if (row.gl_posted) {
    throw conflict(
      `Payroll ${row.payroll_no} is posted to the general ledger. Reverse the GL posting before voiding it.`
    );
  }
  const batches = await client.query(
    `SELECT status FROM payment_batches
      WHERE payroll_id = $1 AND tenant_id = $2 AND company_id = $3`,
    [payrollId, ctx.tenantId, ctx.companyId]
  );
  if (batches.rows.some((b) => ['CONFIRMED', 'RECONCILED'].includes(String(b.status)))) {
    throw conflict(
      `Payroll ${row.payroll_no} has confirmed payments. Money has already been disbursed; reverse or reopen the run instead of voiding it.`
    );
  }
  const result = await transition(client, ctx, {
    payrollId,
    from: ['DRAFT', 'VALIDATING', 'SUBMITTED', 'REVIEW', 'PENDING_APPROVAL', 'APPROVED', 'RELEASED', 'LOCKED'],
    to: 'VOID',
    action: 'CANCEL',
    stage: 'VOID',
    label: 'Void payroll',
    reason,
    set: { locked_at: SQL_NOW },
    lock: 'LOCK',
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.payroll.voided',
    entityType: 'hr.payrolls',
    entityId: payrollId,
    entityCode: result.payrollNo,
    payload: { reason, previousStatus: result.fromStatus },
  });
  return result;
}
// ===========================================================================
// Simulation and analysis
// ===========================================================================

const ITEM_COLUMNS = `i.id, i.employee_id, i.basic_pay, i.allowances, i.gross_pay, i.taxable_income,
  i.paye, i.nssf, i.employer_nssf, i.lst, i.loans, i.advances, i.other_deductions,
  i.total_deductions, i.net_pay, i.breakdown,
  e.employee_no, e.first_name, e.last_name, e.position, e.department_id, d.name AS department_name`;

function sumItems(rows: Array<Record<string, unknown>>) {
  const n = (v: unknown) => Number(v) || 0;
  const t = { gross: 0, taxable: 0, paye: 0, nssf: 0, employerNssf: 0, lst: 0, loans: 0, advances: 0, otherDeductions: 0, deductions: 0, net: 0, employerCost: 0 };
  for (const r of rows) {
    t.gross = round2(t.gross + n(r.gross_pay));
    t.taxable = round2(t.taxable + n(r.taxable_income));
    t.paye = round2(t.paye + n(r.paye));
    t.nssf = round2(t.nssf + n(r.nssf));
    t.employerNssf = round2(t.employerNssf + n(r.employer_nssf));
    t.lst = round2(t.lst + n(r.lst));
    t.loans = round2(t.loans + n(r.loans));
    t.advances = round2(t.advances + n(r.advances));
    t.otherDeductions = round2(t.otherDeductions + n(r.other_deductions));
    t.deductions = round2(t.deductions + n(r.total_deductions));
    t.net = round2(t.net + n(r.net_pay));
  }
  t.employerCost = round2(t.gross + t.employerNssf);
  return t;
}

async function previousComparableRun(client: pg.PoolClient, ctx: Ctx, run: Record<string, unknown>) {
  const res = await client.query(
    `SELECT id, payroll_no, period_start, period_end, gross_total, deduction_total, net_total
       FROM payrolls
      WHERE tenant_id = $1 AND company_id = $2 AND id <> $3
        AND run_type = $4
        AND period_end < $5
        AND status NOT IN ('VOID','CANCELLED')
      ORDER BY period_end DESC, id DESC
      LIMIT 1`,
    [ctx.tenantId, ctx.companyId, Number(run.id), String(run.run_type ?? 'NORMAL'), toISODate(run.period_start)]
  );
  return res.rows[0] ?? null;
}

async function runItems(client: pg.PoolClient, payrollId: number) {
  const res = await client.query(
    `SELECT ${ITEM_COLUMNS}
       FROM payroll_items i
       JOIN employees e ON e.id = i.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
      WHERE i.payroll_id = $1
      ORDER BY e.last_name, e.first_name`,
    [payrollId]
  );
  return res.rows as Array<Record<string, unknown>>;
}

/**
 * Preview a run without keeping the result.
 *
 * The simulation executes the real calculation engine inside a SAVEPOINT and
 * then rolls the savepoint back, so the numbers a simulator shows are by
 * construction the numbers the engine would persist - there is no second,
 * divergent "preview" formula to drift out of step. Nothing outside the
 * savepoint is touched and no accounting entry is created.
 */
export async function simulatePayroll(client: pg.PoolClient, ctx: Ctx, payrollId: number) {
  const run = await client.query(
    `SELECT * FROM payrolls WHERE id = $1 AND tenant_id = $2`,
    [payrollId, ctx.tenantId]
  );
  if (run.rows.length === 0) throw notFound('Payroll not found');
  const row = run.rows[0];
  const status = String(row.status);
  if (!['DRAFT', 'SUBMITTED'].includes(status)) {
    throw conflict(`Payroll ${row.payroll_no} is ${status}; simulation is only available before approval`);
  }

  await client.query('SAVEPOINT payroll_simulation');
  let lines: Array<Record<string, unknown>> = [];
  try {
    await hr.calculatePayroll(client, ctx, payrollId);
    lines = await runItems(client, payrollId);
    await client.query('ROLLBACK TO SAVEPOINT payroll_simulation');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT payroll_simulation');
    throw err;
  }

  const totals = sumItems(lines);
  const previous = await previousComparableRun(client, ctx, row);
  const diff = previous
    ? {
        payrollId: Number(previous.id),
        payrollNo: String(previous.payroll_no),
        periodStart: toISODate(previous.period_start),
        periodEnd: toISODate(previous.period_end),
        grossChange: round2(totals.gross - Number(previous.gross_total ?? 0)),
        deductionChange: round2(totals.deductions - Number(previous.deduction_total ?? 0)),
        netChange: round2(totals.net - Number(previous.net_total ?? 0)),
      }
    : null;

  return {
    payrollId,
    payrollNo: String(row.payroll_no),
    periodStart: toISODate(row.period_start),
    periodEnd: toISODate(row.period_end),
    headcount: lines.length,
    totals,
    previousRun: diff,
    lines: lines.map((l) => ({ ...toCamelRow(l) })),
    persisted: false,
  };
}
// ===========================================================================
// Analysis: variance, decisions, audit timeline
// ===========================================================================

/** Bucket payroll item rows by department for variance and cost reporting. */
function byDepartment(rows: Array<Record<string, unknown>>) {
  const out = new Map<
    string,
    { departmentId: number | null; department: string; headcount: number; gross: number; net: number; paye: number; nssf: number }
  >();
  for (const r of rows) {
    const key = r.department_id == null ? 'none' : String(r.department_id);
    const bucket =
      out.get(key) ?? {
        departmentId: r.department_id == null ? null : Number(r.department_id),
        department: r.department_name == null ? 'Unassigned' : String(r.department_name),
        headcount: 0,
        gross: 0,
        net: 0,
        paye: 0,
        nssf: 0,
      };
    bucket.headcount += 1;
    bucket.gross = round2(bucket.gross + (Number(r.gross_pay) || 0));
    bucket.net = round2(bucket.net + (Number(r.net_pay) || 0));
    bucket.paye = round2(bucket.paye + (Number(r.paye) || 0));
    bucket.nssf = round2(bucket.nssf + (Number(r.nssf) || 0));
    out.set(key, bucket);
  }
  return out;
}

/** current / previous / absolute change / percentage change for one measure. */
function delta(current: number, previous: number) {
  const change = round2(current - previous);
  const changePct = previous === 0 ? (current === 0 ? 0 : null) : round2(((current - previous) / previous) * 100);
  return { current, previous, change, changePct };
}

const VARIANCE_MEASURES: Array<[string, string]> = [
  ['gross', 'Gross pay'],
  ['taxable', 'Taxable income'],
  ['paye', 'PAYE'],
  ['nssf', 'Employee NSSF'],
  ['employerNssf', 'Employer NSSF'],
  ['lst', 'Local Service Tax'],
  ['loans', 'Loan recoveries'],
  ['advances', 'Salary advances'],
  ['otherDeductions', 'Other deductions'],
  ['deductions', 'Total deductions'],
  ['net', 'Net pay'],
  ['employerCost', 'Total employer cost'],
];

/**
 * Current period against the previous comparable run.
 *
 * The comparison is a report, not a mutation: nothing here changes payroll, it
 * surfaces the movements an approver is expected to look at - and flags the
 * ones that exceed the configured materiality threshold so they can be
 * explained before approval rather than discovered afterwards.
 */
export async function payrollVariance(
  client: pg.PoolClient,
  ctx: Ctx,
  payrollId: number,
  opts: { thresholdPct?: number } = {}
) {
  const run = await client.query(`SELECT * FROM payrolls WHERE id = $1 AND tenant_id = $2`, [payrollId, ctx.tenantId]);
  if (run.rows.length === 0) throw notFound('Payroll not found');
  const row = run.rows[0];
  const thresholdPct = Number.isFinite(Number(opts.thresholdPct)) ? Number(opts.thresholdPct) : 10;

  const lines = await runItems(client, payrollId);
  const current = sumItems(lines);
  const previousRun = await previousComparableRun(client, ctx, row);

  const header = {
    payrollId,
    payrollNo: String(row.payroll_no),
    periodStart: toISODate(row.period_start),
    periodEnd: toISODate(row.period_end),
    currency: String(row.currency ?? 'UGX'),
    thresholdPct,
  };

  if (!previousRun) {
    return {
      ...header,
      previousRun: null,
      headcount: delta(lines.length, 0),
      measures: [],
      departments: Array.from(byDepartment(lines).values()).map((d) => ({ ...d, change: null, changePct: null })),
      materialChanges: [],
      note: 'No earlier run of the same type exists for this company, so there is nothing to compare against.',
    };
  }

  const priorLines = await runItems(client, Number(previousRun.id));
  const previous = sumItems(priorLines);
  const currentTotals = current as unknown as Record<string, number>;
  const previousTotals = previous as unknown as Record<string, number>;

  const measures = VARIANCE_MEASURES.map(([key, label]) => ({ key, label, ...delta(currentTotals[key] ?? 0, previousTotals[key] ?? 0) }));
  const headcount = delta(lines.length, priorLines.length);

  const curDepts = byDepartment(lines);
  const prevDepts = byDepartment(priorLines);
  const deptKeys = new Set<string>([...curDepts.keys(), ...prevDepts.keys()]);
  const departments = Array.from(deptKeys).map((key) => {
    const c = curDepts.get(key);
    const p = prevDepts.get(key);
    const cur = c?.gross ?? 0;
    const prev = p?.gross ?? 0;
    return {
      departmentId: c?.departmentId ?? p?.departmentId ?? null,
      department: c?.department ?? p?.department ?? 'Unassigned',
      headcountCurrent: c?.headcount ?? 0,
      headcountPrevious: p?.headcount ?? 0,
      ...delta(cur, prev),
    };
  });
  departments.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.department.localeCompare(b.department));

  const materialChanges = [
    { key: 'headcount', label: 'Headcount', ...headcount },
    ...measures.filter((m) => m.key !== 'employerCost'),
  ].filter((m) => {
    if (m.previous === 0 && m.current === 0) return false;
    if (m.previous === 0) return true;
    return m.changePct !== null && Math.abs(m.changePct) >= thresholdPct;
  });

  return {
    ...header,
    previousRun: {
      payrollId: Number(previousRun.id),
      payrollNo: String(previousRun.payroll_no),
      periodStart: toISODate(previousRun.period_start),
      periodEnd: toISODate(previousRun.period_end),
    },
    headcount,
    measures,
    departments,
    materialChanges,
    note: null,
  };
}
/** Every approval decision recorded against a run, newest first. */
export async function listPayrollApprovals(client: pg.PoolClient, ctx: Ctx, payrollId: number) {
  const run = await client.query(`SELECT id, payroll_no FROM payrolls WHERE id = $1 AND tenant_id = $2`, [
    payrollId,
    ctx.tenantId,
  ]);
  if (run.rows.length === 0) throw notFound('Payroll not found');
  const res = await client.query(
    `SELECT a.id, a.action, a.approval_stage, a.previous_status, a.new_status, a.role_code,
            a.comment, a.decided_at, a.approver_user_id, a.delegated_from_user_id, a.ip, a.device,
            u.first_name, u.last_name, u.email
       FROM payroll_approvals a
       LEFT JOIN users u ON u.id = a.approver_user_id
      WHERE a.payroll_id = $1 AND a.tenant_id = $2
      ORDER BY a.decided_at DESC, a.id DESC`,
    [payrollId, ctx.tenantId]
  );
  const pending = await client.query(
    `SELECT task_id, step_seq, step_name, due_at, submitted_at
       FROM v_approvals_pending
      WHERE entity_type = 'hr.payrolls' AND entity_id = $1 AND tenant_id = $2
      ORDER BY step_seq`,
    [payrollId, ctx.tenantId]
  );
  return {
    payrollId,
    payrollNo: String(run.rows[0].payroll_no),
    decisions: res.rows.map((r) => {
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
      return {
        id: Number(r.id),
        action: String(r.action),
        stage: r.approval_stage == null ? null : String(r.approval_stage),
        fromStatus: r.previous_status == null ? null : String(r.previous_status),
        toStatus: r.new_status == null ? null : String(r.new_status),
        roleCode: String(r.role_code ?? 'UNKNOWN'),
        actorUserId: r.approver_user_id == null ? null : Number(r.approver_user_id),
        actorName: name || (r.email == null ? null : String(r.email)),
        delegatedFromUserId: r.delegated_from_user_id == null ? null : Number(r.delegated_from_user_id),
        comment: r.comment == null ? null : String(r.comment),
        ip: r.ip == null ? null : String(r.ip),
        device: r.device == null ? null : String(r.device),
        decidedAt: r.decided_at,
      };
    }),
    pendingSteps: toCamelRows(pending.rows),
  };
}

/**
 * One chronological record of everything that happened to a run: status
 * changes, approval decisions and the low-level audit events. This is the
 * evidence trail an auditor asks for, assembled from the tables that already
 * hold it rather than from a separate history table that could drift.
 */
export async function payrollAuditTimeline(
  client: pg.PoolClient,
  ctx: Ctx,
  payrollId: number,
  opts: { limit?: number } = {}
) {
  const run = await client.query(
    `SELECT id, payroll_no, status, run_type, created_at FROM payrolls WHERE id = $1 AND tenant_id = $2`,
    [payrollId, ctx.tenantId]
  );
  if (run.rows.length === 0) throw notFound('Payroll not found');
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);

  const history = await client.query(
    `SELECT h.id, h.from_status, h.to_status, h.changed_by, h.changed_at, h.comment, h.reason, h.ip,
            u.first_name, u.last_name, u.email
       FROM payroll_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.payroll_id = $1 AND h.tenant_id = $2
      ORDER BY h.changed_at DESC, h.id DESC
      LIMIT $3`,
    [payrollId, ctx.tenantId, limit]
  );
  const approvals = await client.query(
    `SELECT a.id, a.action, a.approval_stage, a.previous_status, a.new_status, a.role_code, a.comment,
            a.decided_at, a.ip, u.first_name, u.last_name, u.email
       FROM payroll_approvals a
       LEFT JOIN users u ON u.id = a.approver_user_id
      WHERE a.payroll_id = $1 AND a.tenant_id = $2
      ORDER BY a.decided_at DESC, a.id DESC
      LIMIT $3`,
    [payrollId, ctx.tenantId, limit]
  );
  const audits = await client.query(
    `SELECT l.id, l.action, l.resource, l.previous_value, l.new_value, l.reason, l.created_at,
            l.ip, l.device, l.correlation_id, l.user_id,
            u.first_name, u.last_name, u.email
       FROM payroll_audit_logs l
       LEFT JOIN users u ON u.id = l.user_id
      WHERE l.payroll_id = $1 AND l.tenant_id = $2
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $3`,
    [payrollId, ctx.tenantId, limit]
  );

  const who = (r: Record<string, unknown>) => {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
    return name || (r.email == null ? null : String(r.email));
  };

  type Entry = Record<string, unknown> & { at: string };
  const entries: Entry[] = [
    ...history.rows.map((r) => ({
      at: new Date(r.changed_at as string).toISOString(),
      kind: 'STATUS',
      id: Number(r.id),
      action: 'STATUS_CHANGE',
      fromStatus: r.from_status == null ? null : String(r.from_status),
      toStatus: String(r.to_status),
      stage: null,
      actor: who(r),
      roleCode: null,
      comment: r.comment == null ? null : String(r.comment),
      reason: r.reason == null ? null : String(r.reason),
      ip: r.ip == null ? null : String(r.ip),
      correlationId: null,
    })),
    ...approvals.rows.map((r) => ({
      at: new Date(r.decided_at as string).toISOString(),
      kind: 'DECISION',
      id: Number(r.id),
      action: String(r.action),
      fromStatus: r.previous_status == null ? null : String(r.previous_status),
      toStatus: r.new_status == null ? null : String(r.new_status),
      stage: r.approval_stage == null ? null : String(r.approval_stage),
      actor: who(r),
      roleCode: String(r.role_code ?? 'UNKNOWN'),
      comment: r.comment == null ? null : String(r.comment),
      reason: null,
      ip: r.ip == null ? null : String(r.ip),
      correlationId: null,
    })),
    ...audits.rows.map((r) => ({
      at: new Date(r.created_at as string).toISOString(),
      kind: 'AUDIT',
      id: Number(r.id),
      action: String(r.action),
      fromStatus: (r.previous_value as Record<string, unknown> | null)?.status ?? null,
      toStatus: (r.new_value as Record<string, unknown> | null)?.status ?? null,
      stage: null,
      actor: who(r),
      roleCode: null,
      comment: null,
      reason: r.reason == null ? null : String(r.reason),
      ip: r.ip == null ? null : String(r.ip),
      correlationId: r.correlation_id == null ? null : String(r.correlation_id),
    })),
  ];
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : Number(b.id) - Number(a.id)));

  return {
    payrollId,
    payrollNo: String(run.rows[0].payroll_no),
    status: String(run.rows[0].status),
    runType: String(run.rows[0].run_type ?? 'NORMAL'),
    createdAt: run.rows[0].created_at,
    entries: entries.slice(0, limit),
    counts: { statusChanges: history.rows.length, decisions: approvals.rows.length, auditEvents: audits.rows.length },
  };
}
// ===========================================================================
// Payroll command centre
// ===========================================================================

/** The canonical release pipeline, in order, as shown on the run timeline. */
export const PAYROLL_WORKFLOW: Array<{ status: string; label: string }> = [
  { status: 'DRAFT', label: 'Draft' },
  { status: 'VALIDATING', label: 'Data validation' },
  { status: 'SUBMITTED', label: 'Calculated' },
  { status: 'REVIEW', label: 'HR review' },
  { status: 'PENDING_APPROVAL', label: 'Management approval' },
  { status: 'APPROVED', label: 'Approved' },
  { status: 'RELEASED', label: 'Payment authorised' },
  { status: 'PAID', label: 'Paid' },
  { status: 'POSTED', label: 'GL posted' },
  { status: 'CLOSED', label: 'Closed' },
];

export function pipelineFor(status: string) {
  const index = PAYROLL_WORKFLOW.findIndex((s) => s.status === status);
  return PAYROLL_WORKFLOW.map((step, i) => ({
    status: step.status,
    label: step.label,
    state: index === -1 ? (status === 'CLOSED' ? 'DONE' : 'PENDING') : i < index ? 'DONE' : i === index ? 'CURRENT' : 'PENDING',
  }));
}

/**
 * The payroll control tower.
 *
 * Everything on this dashboard is read from payroll records themselves - the
 * current run's own line items, its own exceptions, its own payment batch and
 * its own GL state - so the headline numbers can never disagree with the run
 * they describe.
 */
export async function payrollCommandCentre(client: pg.PoolClient, ctx: Ctx) {
  const scope = [ctx.tenantId, ctx.companyId];

  const currentRes = await client.query(
    `SELECT p.*, pg.name AS payroll_group_name
       FROM payrolls p
       LEFT JOIN payroll_groups pg ON pg.id = p.payroll_group_id
      WHERE p.tenant_id = $1 AND p.company_id = $2
        AND p.status NOT IN ('VOID','CANCELLED')
      ORDER BY p.period_end DESC, p.id DESC
      LIMIT 1`,
    scope
  );
  const current = currentRes.rows[0] ?? null;

  const recentRes = await client.query(
    `SELECT id, payroll_no, period_start, period_end, run_type, status, currency,
            gross_total, deduction_total, net_total, gl_posted, payment_date
       FROM payrolls
      WHERE tenant_id = $1 AND company_id = $2 AND status NOT IN ('VOID','CANCELLED')
      ORDER BY period_end DESC, id DESC
      LIMIT 12`,
    scope
  );

  const totalsRes = await client.query(
    `SELECT
        COUNT(*)::int AS headcount,
        COALESCE(SUM(gross_pay),0) AS gross,
        COALESCE(SUM(taxable_income),0) AS taxable,
        COALESCE(SUM(paye),0) AS paye,
        COALESCE(SUM(nssf),0) AS employee_nssf,
        COALESCE(SUM(employer_nssf),0) AS employer_nssf,
        COALESCE(SUM(lst),0) AS lst,
        COALESCE(SUM(loans),0) AS loans,
        COALESCE(SUM(advances),0) AS advances,
        COALESCE(SUM(other_deductions),0) AS other_deductions,
        COALESCE(SUM(total_deductions),0) AS deductions,
        COALESCE(SUM(net_pay),0) AS net
       FROM payroll_items
      WHERE payroll_id = $1`,
    [current ? Number(current.id) : 0]
  );
  const t = totalsRes.rows[0] ?? {};
  const num = (v: unknown) => round2(Number(v) || 0);
  const totals = {
    headcount: Number(t.headcount ?? 0),
    gross: num(t.gross),
    taxable: num(t.taxable),
    paye: num(t.paye),
    employeeNssf: num(t.employee_nssf),
    employerNssf: num(t.employer_nssf),
    lst: num(t.lst),
    loans: num(t.loans),
    advances: num(t.advances),
    otherDeductions: num(t.other_deductions),
    deductions: num(t.deductions),
    net: num(t.net),
    employerCost: round2(num(t.gross) + num(t.employer_nssf) + num(t.lst)),
  };

  const exceptionsRes = await client.query(
    `SELECT
        COUNT(*) FILTER (WHERE status IN ('OPEN','ASSIGNED','UNDER_REVIEW'))::int AS open_total,
        COUNT(*) FILTER (WHERE status IN ('OPEN','ASSIGNED','UNDER_REVIEW') AND severity = 'ERROR')::int AS blocking,
        COUNT(*) FILTER (WHERE status IN ('OPEN','ASSIGNED','UNDER_REVIEW') AND severity = 'HIGH_RISK')::int AS high_risk,
        COUNT(*) FILTER (WHERE status IN ('OPEN','ASSIGNED','UNDER_REVIEW') AND severity = 'WARNING')::int AS warnings
       FROM payroll_exceptions
      WHERE tenant_id = $1 AND company_id = $2 AND ($3::int IS NULL OR payroll_id = $3)`,
    [ctx.tenantId, ctx.companyId, current ? Number(current.id) : null]
  );
  const ex = exceptionsRes.rows[0] ?? {};

  const paymentRes = await client.query(
    `SELECT id, batch_no, status, total_amount, currency, confirmed_at, exported_at
       FROM payment_batches
      WHERE tenant_id = $1 AND company_id = $2 AND ($3::int IS NULL OR payroll_id = $3)
      ORDER BY id DESC LIMIT 1`,
    [ctx.tenantId, ctx.companyId, current ? Number(current.id) : null]
  );

  const pendingRes = await client.query(
    `SELECT COUNT(*)::int AS pending
       FROM v_approvals_pending
      WHERE tenant_id = $1 AND company_id = $2 AND entity_type = 'hr.payrolls'`,
    scope
  );

  const submissionRes = await client.query(
    `SELECT filing_no, status, due_date, submitted_at, gross_amount, employee_contribution, employer_contribution,
            period_start, period_end
       FROM statutory_submissions
      WHERE tenant_id = $1 AND company_id = $2
      ORDER BY period_end DESC, id DESC
      LIMIT 10`,
    scope
  );

  const periodRes = await client.query(
    `SELECT id, code, period_start, period_end, payment_date, frequency, period_type, status, fiscal_year, month
       FROM payroll_periods
      WHERE tenant_id = $1 AND company_id = $2
      ORDER BY period_start DESC, id DESC
      LIMIT 10`,
    scope
  );

  const status = current ? String(current.status) : null;
  return {
    companyId: ctx.companyId,
    asOf: new Date().toISOString(),
    current: current
      ? {
          payrollId: Number(current.id),
          payrollNo: String(current.payroll_no),
          payrollGroupId: current.payroll_group_id == null ? null : Number(current.payroll_group_id),
          payrollGroupName: current.payroll_group_name == null ? null : String(current.payroll_group_name),
          periodStart: toISODate(current.period_start),
          periodEnd: toISODate(current.period_end),
          payDate: toISODate(current.payment_date),
          runType: String(current.run_type ?? 'NORMAL'),
          status,
          currency: String(current.currency ?? 'UGX'),
          validationScore: current.validation_score == null ? null : Number(current.validation_score),
          glPosted: Boolean(current.gl_posted),
          glJournalId: current.gl_journal_id == null ? null : Number(current.gl_journal_id),
          reopenCount: Number(current.reopen_count ?? 0),
          varianceExplanation: current.variance_explanation == null ? null : String(current.variance_explanation),
        }
      : null,
    totals,
    exceptions: {
      open: Number(ex.open_total ?? 0),
      blocking: Number(ex.blocking ?? 0),
      highRisk: Number(ex.high_risk ?? 0),
      warnings: Number(ex.warnings ?? 0),
    },
    pendingApprovals: Number(pendingRes.rows[0]?.pending ?? 0),
    payment: paymentRes.rows[0]
      ? {
          batchId: Number(paymentRes.rows[0].id),
          batchNo: String(paymentRes.rows[0].batch_no),
          status: String(paymentRes.rows[0].status),
          totalAmount: num(paymentRes.rows[0].total_amount),
          currency: String(paymentRes.rows[0].currency ?? 'UGX'),
          confirmedAt: paymentRes.rows[0].confirmed_at,
        }
      : null,
    statutory: {
      expected: {
        paye: totals.paye,
        employeeNssf: totals.employeeNssf,
        employerNssf: totals.employerNssf,
        totalNssf: round2(totals.employeeNssf + totals.employerNssf),
        lst: totals.lst,
      },
      filings: toCamelRows(submissionRes.rows),
    },
    workflow: status ? pipelineFor(status) : [],
    periods: toCamelRows(periodRes.rows),
    recentRuns: toCamelRows(recentRes.rows),
  };
}
