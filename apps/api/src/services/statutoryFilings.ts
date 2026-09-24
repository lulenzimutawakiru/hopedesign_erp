import pg from 'pg';
import { Ctx } from '../db.js';
import {
  badRequest,
  conflict,
  notFound,
  parsePagination,
  toCamelRow,
  toCamelRows,
  toISODate,
} from '../utils.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';

/**
 * Statutory returns: the record of what an employer declared and paid to URA
 * (PAYE, LST), NSSF and any other configured obligation.
 *
 * A payroll run calculates a liability. A return is the separate, deliberate
 * act of declaring that liability and then settling it, and an enterprise
 * payroll must be able to answer, for each obligation: what did we owe, what
 * did we declare, what did we pay, and does the difference reconcile? Those
 * are four different numbers and conflating them is how statutory arrears go
 * unnoticed, so they are stored separately here: `employee_contribution` +
 * `employer_contribution` carry the declaration, `reconciled_amount` carries
 * what was actually settled, and `variance_amount` carries the difference.
 *
 * Statutory filing is a financial act, so it is gated by its own permissions
 * (hr.statutory.create / update / approve), every transition writes an audit
 * entry, and a cancelled return can never be silently un-cancelled.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Obligations the engine can compute a liability for. */
export const STATUTORY_CATEGORIES = [
  'PAYE', 'NSSF', 'LST', 'SDI', 'WHT', 'SEVERANCE', 'MINIMUM_WAGE', 'OTHER',
] as const;

/** Return states. LATE is derived on read, never stored. */
export const FILING_STATUSES = ['PENDING', 'PREPARED', 'SUBMITTED', 'ACCEPTED', 'PAID', 'CANCELLED'] as const;

/** States that represent money actually declared to the authority. */
const DECLARED_STATUSES = ['SUBMITTED', 'ACCEPTED', 'PAID'];

function assertCategory(value: unknown): string {
  const category = String(value ?? '').trim().toUpperCase();
  if (!(STATUTORY_CATEGORIES as readonly string[]).includes(category)) {
    throw badRequest(`Unknown statutory category '${value}'. Expected one of ${STATUTORY_CATEGORIES.join(', ')}.`);
  }
  return category;
}

function isoOrNull(value: unknown): string | null {
  if (value == null || value === '') return null;
  const iso = toISODate(value);
  if (!iso) throw badRequest(`'${String(value)}' is not a valid date (expected YYYY-MM-DD).`);
  return iso;
}

/**
 * The liability a payroll run actually calculated for one obligation.
 *
 * This is the number a return must reconcile against, so it is always read
 * back from the persisted payroll items rather than re-run: a return that
 * disagreed with the payroll it was raised from would be a defect, and this
 * makes that disagreement visible instead of hiding it behind a recalculation.
 */
export async function payrollLiability(
  client: pg.PoolClient,
  ctx: Ctx,
  payrollId: number,
  category: string
) {
  const run = await client.query(
    `SELECT id, payroll_no, period_start, period_end, currency
       FROM payrolls WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [payrollId, ctx.tenantId, ctx.companyId]
  );
  if (run.rows.length === 0) throw notFound('Payroll not found');
  const totals = await client.query(
    `SELECT
        COALESCE(SUM(gross_pay),0) AS gross,
        COALESCE(SUM(taxable_income),0) AS taxable,
        COALESCE(SUM(paye),0) AS paye,
        COALESCE(SUM(nssf),0) AS employee_nssf,
        COALESCE(SUM(employer_nssf),0) AS employer_nssf,
        COALESCE(SUM(lst),0) AS lst
       FROM payroll_items WHERE payroll_id = $1`,
    [payrollId]
  );
  const t = totals.rows[0] ?? {};
  const n = (v: unknown) => round2(Number(v) || 0);
  let grossAmount = 0;
  let employeeContribution = 0;
  let employerContribution = 0;
  switch (category) {
    case 'PAYE':
      grossAmount = n(t.taxable);
      employeeContribution = n(t.paye);
      break;
    case 'NSSF':
      grossAmount = n(t.gross);
      employeeContribution = n(t.employee_nssf);
      employerContribution = n(t.employer_nssf);
      break;
    case 'LST':
      grossAmount = n(t.taxable);
      employeeContribution = n(t.lst);
      break;
    default:
      break;
  }
  return {
    payrollId: Number(run.rows[0].id),
    payrollNo: String(run.rows[0].payroll_no),
    periodStart: toISODate(run.rows[0].period_start),
    periodEnd: toISODate(run.rows[0].period_end),
    currency: String(run.rows[0].currency ?? 'UGX'),
    category,
    grossAmount,
    employeeContribution,
    employerContribution,
    total: round2(employeeContribution + employerContribution),
  };
}

/** Fields decorate() derives on top of the stored filing columns. */
type DecoratedFiling = Record<string, unknown> & {
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string | null;
  paymentDate: string | null;
  declaredTotal: number;
  settledTotal: number | null;
  outstanding: number;
  variance: number | null;
  overdue: boolean;
  daysToDue: number | null;
  declared: boolean;
};

/** Decorate a stored filing with the derived state a client needs. */
function decorate(row: Record<string, unknown>): DecoratedFiling {
  const out = toCamelRow(row) as DecoratedFiling;
  out.periodStart = toISODate(row.period_start);
  out.periodEnd = toISODate(row.period_end);
  out.dueDate = toISODate(row.due_date);
  out.paymentDate = toISODate(row.payment_date);
  const declared = round2((Number(row.employee_contribution) || 0) + (Number(row.employer_contribution) || 0));
  const status = String(row.status ?? 'PENDING');
  const settled = row.reconciled_amount == null ? null : round2(Number(row.reconciled_amount) || 0);
  out.declaredTotal = declared;
  out.settledTotal = settled;
  out.outstanding = settled == null ? declared : round2(declared - settled);
  out.variance = settled == null ? null : round2(declared - settled);
  const due = row.due_date ? toISODate(row.due_date) : null;
  const today = new Date().toISOString().slice(0, 10);
  out.overdue = Boolean(due && due < today && !['PAID', 'CANCELLED'].includes(status));
  out.daysToDue = due
    ? Math.round((Date.parse(due + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000)
    : null;
  out.declared = DECLARED_STATUSES.includes(status);
  return out;
}

async function loadFiling(client: pg.PoolClient, ctx: Ctx, filingId: number) {
  const res = await client.query(
    `SELECT * FROM statutory_submissions
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [filingId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Statutory filing not found');
  return res.rows[0] as Record<string, unknown>;
}

export async function listStatutoryFilings(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: {
    status?: string;
    category?: string;
    payrollId?: number;
    overdueOnly?: boolean;
    q?: string;
    page?: number;
    pageSize?: number;
  } = {}
) {
  const { page, pageSize, offset } = parsePagination({ page: filters.page, pageSize: filters.pageSize });
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['s.tenant_id = $1', 's.company_id = $2'];
  if (filters.status) {
    params.push(filters.status);
    where.push('s.status = $' + params.length);
  }
  if (filters.category) {
    params.push(assertCategory(filters.category));
    where.push('s.category = $' + params.length);
  }
  if (filters.payrollId) {
    params.push(filters.payrollId);
    where.push('s.payroll_id = $' + params.length);
  }
  if (filters.overdueOnly) {
    where.push("s.due_date IS NOT NULL AND s.due_date < CURRENT_DATE AND s.status NOT IN ('PAID','CANCELLED')");
  }
  if (filters.q?.trim()) {
    params.push('%' + filters.q.trim() + '%');
    where.push('(s.filing_no ILIKE $' + params.length + ' OR s.category ILIKE $' + params.length + ' OR s.tax_period ILIKE $' + params.length + ')');
  }
  params.push(pageSize, offset);
  const res = await client.query(
    `SELECT s.*, p.payroll_no
       FROM statutory_submissions s
       LEFT JOIN payrolls p ON p.id = s.payroll_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.period_end DESC, s.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const count = await client.query(
    `SELECT count(*)::int AS n, COALESCE(SUM(s.employee_contribution + s.employer_contribution),0) AS declared
       FROM statutory_submissions s
      WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return {
    items: res.rows.map(decorate),
    page,
    pageSize,
    totalCount: Number(count.rows[0]?.n) || 0,
    declaredTotal: round2(Number(count.rows[0]?.declared) || 0),
  };
}

export async function getStatutoryFiling(client: pg.PoolClient, ctx: Ctx, filingId: number) {
  const row = await loadFiling(client, ctx, filingId);
  const filing = decorate(row);
  const category = row.category == null ? null : String(row.category);
  let liability: Awaited<ReturnType<typeof payrollLiability>> | null = null;
  if (row.payroll_id != null && category) {
    liability = await payrollLiability(client, ctx, Number(row.payroll_id), category);
  }
  const history = await client.query(
    `SELECT action, user_id, old_values, new_values, metadata, created_at
       FROM audit_logs
      WHERE tenant_id = $1 AND resource = 'statutory_submissions' AND record_id = $2
      ORDER BY id DESC LIMIT 50`,
    [ctx.tenantId, filingId]
  );
  return {
    filing,
    liability,
    reconciliation: {
      declared: filing.declaredTotal,
      settled: filing.settledTotal,
      outstanding: filing.outstanding,
      variance: filing.variance,
      expected: liability ? liability.total : null,
      liabilityVariance: liability ? round2(liability.total - filing.declaredTotal) : null,
      reconciled: filing.variance != null && Math.abs(filing.variance) < 0.01,
    },
    history: toCamelRows(history.rows),
  };
}

/**
 * Every filing transition writes its audit entry and its event here, so no
 * path can move a return without leaving evidence of who moved it.
 */
async function transitionFiling(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    filingId: number;
    from: string[];
    to: string;
    action: string;
    label: string;
    reason?: string | null;
    set?: Record<string, unknown>;
  }
) {
  const row = await loadFiling(client, ctx, input.filingId);
  const fromStatus = String(row.status);
  if (!input.from.includes(fromStatus)) {
    throw conflict(
      `${input.label}: filing ${row.filing_no ?? input.filingId} is ${fromStatus}; this action requires ${input.from.join(' or ')}`
    );
  }
  const columns: string[] = ['status = $2', 'updated_at = now()'];
  const params: unknown[] = [input.filingId, input.to];
  const allowed = new Set([
    'statutory_config_id', 'payroll_id', 'category', 'currency', 'tax_period',
    'due_date', 'filing_no', 'employee_contribution', 'employer_contribution',
    'gross_amount', 'submitted_at', 'submitted_by', 'prepared_at', 'prepared_by',
    'accepted_at', 'paid_at', 'payment_date', 'payment_reference',
    'reconciled_amount', 'variance_amount', 'notes', 'evidence_document_id',
    'approved_by', 'approved_at',
  ]);
  for (const [column, value] of Object.entries(input.set ?? {})) {
    if (!allowed.has(column)) throw new Error(`statutory filing cannot set ${column}`);
    if (value === undefined) continue;
    if (value === null) { columns.push(`${column} = NULL`); continue; }
    params.push(value);
    columns.push(`${column} = $${params.length}`);
  }
  await client.query(`UPDATE statutory_submissions SET ${columns.join(', ')} WHERE id = $1`, params);
  await logAudit(client, ctx, {
    action: input.action,
    resource: 'statutory_submissions',
    recordId: input.filingId,
    recordCode: row.filing_no == null ? null : String(row.filing_no),
    oldValues: { status: fromStatus },
    newValues: { status: input.to, ...(input.set ?? {}) },
    metadata: { label: input.label, reason: input.reason ?? null, category: row.category ?? null },
  });
  await emitEvent(client, ctx, {
    eventType: `hr.statutory.${input.action}`,
    entityType: 'statutory_submissions',
    entityId: input.filingId,
    entityCode: row.filing_no == null ? null : String(row.filing_no),
    payload: { from: fromStatus, to: input.to, category: row.category ?? null },
  });
  return { filingId: input.filingId, fromStatus, status: input.to };
}

/**
 * Raise a return. When it is tied to a payroll run the liability is read from
 * that run rather than typed in, so a return can never be raised for an amount
 * the payroll did not compute.
 */
export async function createStatutoryFiling(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    category: string;
    payrollId?: number;
    periodStart: string;
    periodEnd: string;
    dueDate?: string | null;
    taxPeriod?: string | null;
    currency?: string | null;
    notes?: string | null;
  }
) {
  const category = assertCategory(input.category);
  const periodStart = isoOrNull(input.periodStart);
  const periodEnd = isoOrNull(input.periodEnd);
  if (!periodStart || !periodEnd) throw badRequest('A statutory filing needs a period start and end date.');
  if (periodEnd < periodStart) throw badRequest('The filing period end cannot be before its start.');
  let grossAmount = 0;
  let employeeContribution = 0;
  let employerContribution = 0;
  let currency = input.currency ? String(input.currency) : null;
  let statutoryConfigId: number | null = null;
  if (input.payrollId) {
    const liability = await payrollLiability(client, ctx, input.payrollId, category);
    grossAmount = liability.grossAmount;
    employeeContribution = liability.employeeContribution;
    employerContribution = liability.employerContribution;
    currency = currency ?? liability.currency;
  }
  const configRes = await client.query(
    `SELECT id FROM statutory_configs
      WHERE tenant_id = $1 AND category = $2
        AND (company_id = $3 OR company_id IS NULL)
        AND effective_from <= $4
        AND (effective_to IS NULL OR effective_to >= $4)
      ORDER BY company_id NULLS LAST, effective_from DESC, version DESC
      LIMIT 1`,
    [ctx.tenantId, category, ctx.companyId, periodEnd]
  );
  if (configRes.rows[0]) statutoryConfigId = Number(configRes.rows[0].id);
  const inserted = await client.query(
    `INSERT INTO statutory_submissions
       (company_id, tenant_id, statutory_config_id, category, payroll_id,
        period_start, period_end, due_date, tax_period, currency,
        gross_amount, employee_contribution, employer_contribution, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'UGX'),$11,$12,$13,'PENDING',$14)
     RETURNING id, category, period_start, period_end, status, employee_contribution, employer_contribution`,
    [ctx.companyId, ctx.tenantId, statutoryConfigId, category, input.payrollId ?? null,
     periodStart, periodEnd, isoOrNull(input.dueDate), input.taxPeriod ? String(input.taxPeriod) : null,
     currency, grossAmount, employeeContribution, employerContribution,
     input.notes ? String(input.notes) : null]
  ).catch((err: unknown) => {
    // The unique index is (company, category, period). Declaring the same
    // obligation twice for one period is a real-world double-declaration, so it
    // is surfaced as an actionable conflict rather than a raw driver error.
    if ((err as { code?: string } | null)?.code === '23505') {
      throw conflict(
        `A ${category} return already exists for ${periodStart} to ${periodEnd}. ` +
          'Open that return and reconcile it instead of filing a second one for the same period.'
      );
    }
    throw err;
  });
  const filingId = Number(inserted.rows[0].id);
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'statutory_submissions',
    recordId: filingId,
    newValues: {
      category, periodStart, periodEnd, payrollId: input.payrollId ?? null,
      employeeContribution, employerContribution,
    },
    metadata: { statutoryConfigId },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.statutory.created',
    entityType: 'statutory_submissions',
    entityId: filingId,
    payload: { category, periodEnd },
  });
  return getStatutoryFiling(client, ctx, filingId);
}

export async function prepareStatutoryFiling(
  client: pg.PoolClient,
  ctx: Ctx,
  filingId: number,
  opts: { dueDate?: string | null; notes?: string | null; filingNo?: string | null } = {}
) {
  await transitionFiling(client, ctx, {
    filingId,
    from: ['PENDING'],
    to: 'PREPARED',
    action: 'prepare',
    label: 'Prepare statutory filing',
    set: {
      prepared_at: new Date(),
      prepared_by: ctx.userId ?? null,
      due_date: isoOrNull(opts.dueDate),
      filing_no: opts.filingNo ? String(opts.filingNo) : null,
      notes: opts.notes ? String(opts.notes) : null,
    },
  });
  return getStatutoryFiling(client, ctx, filingId);
}

export async function submitStatutoryFiling(
  client: pg.PoolClient,
  ctx: Ctx,
  filingId: number,
  opts: { filingNo?: string | null; notes?: string | null } = {}
) {
  await transitionFiling(client, ctx, {
    filingId,
    from: ['PENDING', 'PREPARED'],
    to: 'SUBMITTED',
    action: 'submit',
    label: 'Submit statutory return',
    set: {
      submitted_at: new Date(),
      submitted_by: ctx.userId ?? null,
      filing_no: opts.filingNo ? String(opts.filingNo) : null,
      notes: opts.notes ? String(opts.notes) : null,
    },
  });
  return getStatutoryFiling(client, ctx, filingId);
}

export async function acceptStatutoryFiling(
  client: pg.PoolClient,
  ctx: Ctx,
  filingId: number,
  opts: { notes?: string | null; filingNo?: string | null } = {}
) {
  await transitionFiling(client, ctx, {
    filingId,
    from: ['SUBMITTED'],
    to: 'ACCEPTED',
    action: 'accept',
    label: 'Record statutory acceptance',
    set: {
      accepted_at: new Date(),
      approved_by: ctx.userId ?? null,
      approved_at: new Date(),
      filing_no: opts.filingNo ? String(opts.filingNo) : null,
      notes: opts.notes ? String(opts.notes) : null,
    },
  });
  return getStatutoryFiling(client, ctx, filingId);
}

export async function recordStatutoryPayment(
  client: pg.PoolClient,
  ctx: Ctx,
  filingId: number,
  opts: { paymentDate?: string | null; paymentReference?: string | null; amount?: number | null; notes?: string | null }
) {
  const amount = opts.amount == null ? null : round2(Number(opts.amount));
  if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
    throw badRequest('A statutory payment amount must be a positive number.');
  }
  const current = await loadFiling(client, ctx, filingId);
  const declared = round2((Number(current.employee_contribution) || 0) + (Number(current.employer_contribution) || 0));
  const settled = amount == null ? declared : amount;
  await transitionFiling(client, ctx, {
    filingId,
    from: ['PREPARED', 'SUBMITTED', 'ACCEPTED'],
    to: 'PAID',
    action: 'pay',
    label: 'Record statutory payment',
    set: {
      paid_at: new Date(),
      payment_date: isoOrNull(opts.paymentDate) ?? new Date(),
      payment_reference: opts.paymentReference ? String(opts.paymentReference) : null,
      reconciled_amount: settled,
      variance_amount: round2(declared - settled),
      notes: opts.notes ? String(opts.notes) : null,
    },
  });
  return getStatutoryFiling(client, ctx, filingId);
}

/**
 * Reconcile a filing against what was actually settled. This is the check
 * that stops an unexplained statutory difference from disappearing: the
 * variance is stored, not just displayed, so it survives into reporting.
 */
export async function reconcileStatutoryFiling(
  client: pg.PoolClient,
  ctx: Ctx,
  filingId: number,
  opts: { reconciledAmount: number; notes?: string | null; evidenceDocumentId?: number | null }
) {
  const reconciled = round2(Number(opts.reconciledAmount));
  if (!Number.isFinite(reconciled) || reconciled < 0) {
    throw badRequest('A reconciled amount must be a positive number.');
  }
  const current = await loadFiling(client, ctx, filingId);
  if (String(current.status) === 'CANCELLED') {
    throw conflict('A cancelled statutory filing cannot be reconciled.');
  }
  const declared = round2((Number(current.employee_contribution) || 0) + (Number(current.employer_contribution) || 0));
  await transitionFiling(client, ctx, {
    filingId,
    from: ['PENDING', 'PREPARED', 'SUBMITTED', 'ACCEPTED', 'PAID'],
    to: String(current.status),
    action: 'reconcile',
    label: 'Reconcile statutory filing',
    set: {
      reconciled_amount: reconciled,
      variance_amount: round2(declared - reconciled),
      evidence_document_id: opts.evidenceDocumentId ?? null,
      notes: opts.notes ? String(opts.notes) : null,
    },
  });
  return getStatutoryFiling(client, ctx, filingId);
}

export async function cancelStatutoryFiling(
  client: pg.PoolClient,
  ctx: Ctx,
  filingId: number,
  opts: { reason: string }
) {
  const reason = String(opts.reason ?? '').trim();
  if (reason.length < 10) {
    throw badRequest('Cancelling a statutory filing requires a written reason of at least 10 characters for the audit record.');
  }
  await transitionFiling(client, ctx, {
    filingId,
    from: ['PENDING', 'PREPARED', 'SUBMITTED', 'ACCEPTED'],
    to: 'CANCELLED',
    action: 'cancel',
    label: 'Cancel statutory filing',
    reason,
    set: { notes: reason },
  });
  return getStatutoryFiling(client, ctx, filingId);
}

/**
 * The compliance board: for each obligation, what the latest payroll run
 * calculated, what has been declared and what has actually been settled.
 *
 * `expected` comes from the payroll the employer most recently ran, which is
 * the liability the employer is holding on the authority's behalf. The gap
 * between it and what was declared, and between what was declared and what
 * was paid, is the whole point of the board.
 */
export async function statutoryComplianceBoard(client: pg.PoolClient, ctx: Ctx) {
  const runRes = await client.query(
    `SELECT id, payroll_no, period_start, period_end, status, currency
       FROM payrolls
      WHERE tenant_id = $1 AND company_id = $2 AND status NOT IN ('VOID','CANCELLED')
      ORDER BY period_end DESC, id DESC LIMIT 1`,
    [ctx.tenantId, ctx.companyId]
  );
  const run = runRes.rows[0] ?? null;
  const liabilities: Array<Record<string, unknown>> = [];
  if (run) {
    for (const category of ['PAYE', 'NSSF', 'LST']) {
      const liability = await payrollLiability(client, ctx, Number(run.id), category);
      liabilities.push({ ...liability, payrollNo: String(run.payroll_no), payrollStatus: String(run.status) });
    }
  }
  const aggregate = await client.query(
    `SELECT category,
            COUNT(*)::int AS filings,
            COUNT(*) FILTER (WHERE status IN ('SUBMITTED','ACCEPTED','PAID'))::int AS declared,
            COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid,
            COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
            COALESCE(SUM(employee_contribution + employer_contribution),0) AS declared_amount,
            COALESCE(SUM(COALESCE(reconciled_amount,0)),0) AS settled_amount,
            COALESCE(SUM(COALESCE(variance_amount,0)),0) AS variance_amount
       FROM statutory_submissions
      WHERE tenant_id = $1 AND company_id = $2 AND category IS NOT NULL
      GROUP BY category ORDER BY category`,
    [ctx.tenantId, ctx.companyId]
  );
  const dueRes = await client.query(
    `SELECT id, filing_no, category, period_start, period_end, due_date, status,
            (employee_contribution + employer_contribution) AS declared_amount
       FROM statutory_submissions
      WHERE tenant_id = $1 AND company_id = $2 AND due_date IS NOT NULL
        AND status NOT IN ('PAID','CANCELLED')
      ORDER BY due_date ASC LIMIT 12`,
    [ctx.tenantId, ctx.companyId]
  );
  const today = new Date().toISOString().slice(0, 10);
  const filingRes = await client.query(
    `SELECT s.*, p.payroll_no FROM statutory_submissions s
       LEFT JOIN payrolls p ON p.id = s.payroll_id
      WHERE s.tenant_id = $1 AND s.company_id = $2
      ORDER BY s.period_end DESC, s.id DESC LIMIT 12`,
    [ctx.tenantId, ctx.companyId]
  );
  return {
    asOf: new Date().toISOString(),
    payroll: run
      ? {
          payrollId: Number(run.id),
          payrollNo: String(run.payroll_no),
          periodStart: toISODate(run.period_start),
          periodEnd: toISODate(run.period_end),
          status: String(run.status),
        }
      : null,
    liabilities,
    categories: toCamelRows(aggregate.rows),
    upcoming: toCamelRows(dueRes.rows).map((r) => ({
      ...r,
      dueDate: toISODate(r.dueDate),
      periodStart: toISODate(r.periodStart),
      periodEnd: toISODate(r.periodEnd),
    })).map((r) => ({ ...r, overdue: r.dueDate != null && String(r.dueDate) < today })),
    filings: filingRes.rows.map(decorate),
    statuses: FILING_STATUSES,
  };
}
