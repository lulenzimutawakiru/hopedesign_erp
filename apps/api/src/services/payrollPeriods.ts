import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, conflict, notFound, parsePagination, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { logAudit } from './audit.js';

/**
 * Payroll periods: the calendar that a payroll run hangs off.
 *
 * A period is the approved window (start, end, cut-off, pay date) a run is
 * calculated inside. Keeping the calendar as data - rather than letting each
 * operator type dates into a run - is what makes "one regular payroll per
 * period" enforceable and lets the statutory calendar be reported on.
 */

const FREQUENCIES = ['MONTHLY', 'SEMI_MONTHLY', 'BIWEEKLY', 'WEEKLY', 'QUARTERLY', 'ANNUAL'] as const;
const PERIOD_TYPES = ['NORMAL', 'OFF_CYCLE', 'FINAL', 'ADJUSTMENT', 'REVERSAL', 'ARREARS'] as const;
const PERIOD_STATUSES = ['OPEN', 'LOCKED', 'CLOSED', 'CANCELLED'] as const;

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const requireDate = (v: unknown, label: string): string => {
  const s = iso(v);
  if (!s) throw badRequest(`${label} must be a date in YYYY-MM-DD form`);
  return s;
};

const optionalDate = (v: unknown, label: string): string | null => {
  if (v == null || v === '') return null;
  const s = iso(v);
  if (!s) throw badRequest(`${label} must be a date in YYYY-MM-DD form`);
  return s;
};

/** A date column read back from Postgres, shaped as YYYY-MM-DD. */
const dateOnly = (v: unknown): string => String(toISODate(v) ?? String(v).slice(0, 10));

const optionalText = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/**
 * Resolve the payroll group a period belongs to.
 *
 * `payroll_group_id` is mandatory on the calendar, so when the caller does not
 * name a group we fall back to the group this company most recently ran
 * payroll with, and failing that the oldest active group - never a hard-coded
 * id, and never an arbitrary pick between equally plausible groups.
 */
async function resolvePayrollGroup(client: pg.PoolClient, ctx: Ctx, requested?: number | null): Promise<number> {
  if (requested != null && String(requested) !== '') {
    const id = Number(requested);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Payroll group must be a valid id');
    const found = await client.query(
      `SELECT id FROM payroll_groups WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
      [id, ctx.tenantId, ctx.companyId]
    );
    if (found.rows.length === 0) throw badRequest('Payroll group not found for this company');
    return id;
  }
  const recent = await client.query(
    `SELECT payroll_group_id
       FROM payrolls
      WHERE tenant_id = $1 AND company_id = $2 AND payroll_group_id IS NOT NULL
        AND status NOT IN ('VOID','CANCELLED')
      ORDER BY period_end DESC, id DESC
      LIMIT 1`,
    [ctx.tenantId, ctx.companyId]
  );
  if (recent.rows.length > 0) return Number(recent.rows[0].payroll_group_id);
  const fallback = await client.query(
    `SELECT id FROM payroll_groups
      WHERE tenant_id = $1 AND company_id = $2 AND status = 'ACTIVE'
      ORDER BY id LIMIT 1`,
    [ctx.tenantId, ctx.companyId]
  );
  if (fallback.rows.length === 0) {
    throw badRequest('No payroll group exists for this company. Create a payroll group before defining a payroll period.');
  }
  return Number(fallback.rows[0].id);
}

/** Build a period code that is unique for the company and group. */
async function buildPeriodCode(
  client: pg.PoolClient,
  ctx: Ctx,
  groupId: number,
  frequency: string,
  periodStart: string,
  periodEnd: string
): Promise<string> {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const year = start.getUTCFullYear();
  const base =
    frequency === 'ANNUAL'
      ? `FY-${year}`
      : frequency === 'QUARTERLY'
        ? `Q${Math.floor(start.getUTCMonth() / 3) + 1}-${year}`
        : frequency === 'MONTHLY'
          ? `${year}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`
          : `${periodStart}_${periodEnd}`;
  let code = base;
  for (let n = 2; n < 200; n += 1) {
    const clash = await client.query(
      `SELECT 1 FROM payroll_periods WHERE company_id = $1 AND payroll_group_id = $2 AND code = $3`,
      [ctx.companyId, groupId, code]
    );
    if (clash.rows.length === 0) return code;
    code = `${base}-${n}`;
  }
  throw conflict('Unable to allocate a unique payroll period code');
}

const PERIOD_COLUMNS = `pp.id, pp.company_id, pp.branch_id, pp.payroll_group_id, pp.code, pp.period_start, pp.period_end,
  pp.cutoff_date, pp.processing_date, pp.approval_deadline, pp.payment_date, pp.payslip_publish_date,
  pp.frequency, pp.period_type, pp.status, pp.fiscal_year, pp.month, pp.statutory_rule_version, pp.notes,
  pp.created_by, pp.created_at, pp.updated_at,
  pp.reviewed_by, pp.reviewed_at, pp.approved_by, pp.approved_at, pp.released_by, pp.released_at,
  pp.closed_by, pp.closed_at, pg.name AS payroll_group_name,
  (SELECT COUNT(*)::int FROM payrolls p WHERE p.payroll_period_id = pp.id AND p.status NOT IN ('VOID','CANCELLED')) AS run_count`;
export async function listPayrollPeriods(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { status?: string; frequency?: string; fiscalYear?: number; periodType?: string; q?: string; page?: number; pageSize?: number } = {}
) {
  const { page, pageSize, offset } = parsePagination(opts as Record<string, unknown>);
  const where: string[] = ['pp.tenant_id = $1', 'pp.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  if (opts.status) {
    const s = String(opts.status).toUpperCase();
    if (!(PERIOD_STATUSES as readonly string[]).includes(s)) throw badRequest('Unsupported payroll period status');
    params.push(s);
    where.push(`pp.status = $${params.length}`);
  }
  if (opts.frequency) {
    params.push(String(opts.frequency).toUpperCase());
    where.push(`pp.frequency = $${params.length}`);
  }
  if (opts.periodType) {
    params.push(String(opts.periodType).toUpperCase());
    where.push(`pp.period_type = $${params.length}`);
  }
  if (opts.fiscalYear != null && Number.isFinite(Number(opts.fiscalYear))) {
    params.push(Number(opts.fiscalYear));
    where.push(`pp.fiscal_year = $${params.length}`);
  }
  if (opts.q) {
    params.push(`%${String(opts.q).trim()}%`);
    where.push(`(pp.code ILIKE $${params.length} OR pg.name ILIKE $${params.length})`);
  }
  const clause = where.join(' AND ');

  const totalRes = await client.query(
    `SELECT COUNT(*)::int AS total FROM payroll_periods pp
       LEFT JOIN payroll_groups pg ON pg.id = pp.payroll_group_id
      WHERE ${clause}`,
    params
  );
  const rows = await client.query(
    `SELECT ${PERIOD_COLUMNS}
       FROM payroll_periods pp
       LEFT JOIN payroll_groups pg ON pg.id = pp.payroll_group_id
      WHERE ${clause}
      ORDER BY pp.period_start DESC, pp.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  return {
    items: toCamelRows(rows.rows),
    page,
    pageSize,
    total: Number(totalRes.rows[0]?.total ?? 0),
  };
}

export async function getPayrollPeriod(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT ${PERIOD_COLUMNS}
       FROM payroll_periods pp
       LEFT JOIN payroll_groups pg ON pg.id = pp.payroll_group_id
      WHERE pp.id = $1 AND pp.tenant_id = $2 AND pp.company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Payroll period not found');
  const runs = await client.query(
    `SELECT id, payroll_no, run_type, status, period_start, period_end, gross_total, net_total, currency
       FROM payrolls
      WHERE payroll_period_id = $1 AND tenant_id = $2
      ORDER BY id DESC`,
    [id, ctx.tenantId]
  );
  return { period: toCamelRow(res.rows[0]), runs: toCamelRows(runs.rows) };
}
export interface PayrollPeriodInput {
  periodStart: string;
  periodEnd: string;
  frequency?: string;
  periodType?: string;
  payrollGroupId?: number | null;
  branchId?: number | null;
  paymentDate?: string | null;
  cutoffDate?: string | null;
  processingDate?: string | null;
  approvalDeadline?: string | null;
  payslipPublishDate?: string | null;
  month?: number | null;
  fiscalYear?: number | null;
  statutoryRuleVersion?: string | null;
  notes?: string | null;
}

export async function createPayrollPeriod(client: pg.PoolClient, ctx: Ctx, input: PayrollPeriodInput) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const periodStart = requireDate(input.periodStart, 'Period start');
  const periodEnd = requireDate(input.periodEnd, 'Period end');
  if (periodEnd < periodStart) throw badRequest('Period end is before period start');

  const frequency = String(input.frequency ?? 'MONTHLY').toUpperCase();
  if (!(FREQUENCIES as readonly string[]).includes(frequency)) {
    throw badRequest(`Unsupported payroll frequency. Use one of ${FREQUENCIES.join(', ')}.`);
  }
  const periodType = String(input.periodType ?? 'NORMAL').toUpperCase();
  if (!(PERIOD_TYPES as readonly string[]).includes(periodType)) {
    throw badRequest(`Unsupported payroll period type. Use one of ${PERIOD_TYPES.join(', ')}.`);
  }

  const groupId = await resolvePayrollGroup(client, ctx, input.payrollGroupId);

  const duplicate = await client.query(
    `SELECT code FROM payroll_periods
      WHERE tenant_id = $1 AND company_id = $2 AND payroll_group_id = $3
        AND period_type = $4 AND period_start <= $6 AND period_end >= $5`,
    [ctx.tenantId, ctx.companyId, groupId, periodType, periodStart, periodEnd]
  );
  if (duplicate.rows.length > 0) {
    throw conflict(`A ${periodType} period (${duplicate.rows[0].code}) already covers this window for the payroll group.`);
  }

  const end = new Date(`${periodEnd}T00:00:00Z`);
  const month = input.month != null && input.month !== ('' as unknown as number)
    ? Number(input.month)
    : end.getUTCMonth() + 1;
  if (!Number.isInteger(month) || month < 1 || month > 12) throw badRequest('Month must be between 1 and 12');
  const fiscalYear = input.fiscalYear != null && String(input.fiscalYear) !== ''
    ? Number(input.fiscalYear)
    : end.getUTCFullYear();
  if (!Number.isInteger(fiscalYear)) throw badRequest('Fiscal year must be a whole number');

  const code = await buildPeriodCode(client, ctx, groupId, frequency, periodStart, periodEnd);

  const ins = await client.query(
    `INSERT INTO payroll_periods
       (company_id, tenant_id, branch_id, payroll_group_id, code, period_start, period_end, cutoff_date,
        processing_date, approval_deadline, payment_date, payslip_publish_date, frequency, period_type,
        status, fiscal_year, month, statutory_rule_version, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'OPEN',$15,$16,$17,$18,$19)
     RETURNING id`,
    [
      ctx.companyId, ctx.tenantId,
      input.branchId != null && String(input.branchId) !== '' ? Number(input.branchId) : ctx.branchId ?? null,
      groupId, code, periodStart, periodEnd,
      optionalDate(input.cutoffDate, 'Cut-off date'),
      optionalDate(input.processingDate, 'Processing date'),
      optionalDate(input.approvalDeadline, 'Approval deadline'),
      optionalDate(input.paymentDate, 'Payment date'),
      optionalDate(input.payslipPublishDate, 'Payslip publish date'),
      frequency, periodType, fiscalYear, month,
      optionalText(input.statutoryRuleVersion),
      optionalText(input.notes),
      ctx.userId ?? null,
    ]
  );
  const periodId = Number(ins.rows[0].id);
  await logAudit(client, ctx, {
    action: 'hr.payroll_period.create',
    resource: 'hr.payroll_periods',
    recordId: periodId,
    recordCode: code,
    newValues: { periodStart, periodEnd, frequency, periodType, payrollGroupId: groupId, status: 'OPEN' },
  });
  return getPayrollPeriod(client, ctx, periodId);
}

export async function updatePayrollPeriod(client: pg.PoolClient, ctx: Ctx, id: number, input: PayrollPeriodInput) {
  const current = await client.query(
    `SELECT id, code, status, period_start, period_end, frequency, period_type FROM payroll_periods
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (current.rows.length === 0) throw notFound('Payroll period not found');
  const row = current.rows[0];
  if (String(row.status) === 'CLOSED') throw conflict(`Period ${row.code} is closed and cannot be edited`);
  if (String(row.status) === 'CANCELLED') throw conflict(`Period ${row.code} is cancelled`);

  const sets: string[] = [];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId];
  const add = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };

  const newStart = input.periodStart ? requireDate(input.periodStart, 'Period start') : dateOnly(row.period_start);
  const newEnd = input.periodEnd ? requireDate(input.periodEnd, 'Period end') : dateOnly(row.period_end);
  if (newEnd < newStart) throw badRequest('Period end is before period start');

  const hasRuns = await client.query(
    `SELECT 1 FROM payrolls WHERE payroll_period_id = $1 AND status NOT IN ('VOID','CANCELLED') LIMIT 1`,
    [id]
  );
  const started = hasRuns.rows.length > 0;

  if (input.periodStart !== undefined || input.periodEnd !== undefined) {
    if (started) throw conflict(`Period ${row.code} already has payroll runs; its dates can no longer be changed`);
    add('period_start', newStart);
    add('period_end', newEnd);
  }
  if (started && (input.payrollGroupId !== undefined || input.frequency !== undefined || input.periodType !== undefined)) {
    throw conflict(`Period ${row.code} already has payroll runs; its group, frequency and type can no longer be changed`);
  }
  if (input.payrollGroupId !== undefined && String(input.payrollGroupId) !== '') {
    add('payroll_group_id', await resolvePayrollGroup(client, ctx, input.payrollGroupId));
  }
  if (input.frequency !== undefined) {
    const f = String(input.frequency).toUpperCase();
    if (!(FREQUENCIES as readonly string[]).includes(f)) throw badRequest('Unsupported payroll frequency');
    add('frequency', f);
  }
  if (input.periodType !== undefined) {
    const p = String(input.periodType).toUpperCase();
    if (!(PERIOD_TYPES as readonly string[]).includes(p)) throw badRequest('Unsupported payroll period type');
    add('period_type', p);
  }
  if (input.branchId !== undefined) add('branch_id', input.branchId == null || String(input.branchId) === '' ? null : Number(input.branchId));
  for (const [col, label] of [
    ['cutoff_date', 'Cut-off date'],
    ['processing_date', 'Processing date'],
    ['approval_deadline', 'Approval deadline'],
    ['payment_date', 'Payment date'],
    ['payslip_publish_date', 'Payslip publish date'],
  ] as Array<[string, string]>) {
    const key = col.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()) as keyof PayrollPeriodInput;
    if (input[key] !== undefined) add(col, optionalDate(input[key], label));
  }
  if (input.month !== undefined) {
    if (input.month == null || String(input.month) === '') add('month', null);
    else {
      const m = Number(input.month);
      if (!Number.isInteger(m) || m < 1 || m > 12) throw badRequest('Month must be between 1 and 12');
      add('month', m);
    }
  }
  if (input.fiscalYear !== undefined) {
    if (input.fiscalYear == null || String(input.fiscalYear) === '') add('fiscal_year', null);
    else {
      const y = Number(input.fiscalYear);
      if (!Number.isInteger(y)) throw badRequest('Fiscal year must be a whole number');
      add('fiscal_year', y);
    }
  }
  if (input.statutoryRuleVersion !== undefined) add('statutory_rule_version', optionalText(input.statutoryRuleVersion));
  if (input.notes !== undefined) add('notes', optionalText(input.notes));

  if (sets.length === 0) return getPayrollPeriod(client, ctx, id);
  sets.push('updated_at = now()');
  await client.query(
    `UPDATE payroll_periods SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    params
  );
  await logAudit(client, ctx, {
    action: 'hr.payroll_period.update',
    resource: 'hr.payroll_periods',
    recordId: id,
    recordCode: String(row.code),
    newValues: Object.fromEntries(sets.filter((s) => !s.startsWith('updated_at')).map((s) => s.split(' = '))),
  });
  return getPayrollPeriod(client, ctx, id);
}
/**
 * Decide which payroll period a run belongs to.
 *
 * A run may name its period explicitly, in which case the link is validated
 * (open, right group, dates inside the window, compatible type). A NORMAL run
 * that names no period is attached to the open NORMAL period covering its
 * dates when one exists, so the calendar stays authoritative instead of every
 * operator retyping dates. Off-cycle style runs stay unlinked unless asked.
 */
export async function resolvePeriodForRun(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: {
    payrollPeriodId?: number | null;
    periodStart: string;
    periodEnd: string;
    payrollGroupId: number | null;
    runType: string;
  }
): Promise<{ id: number; code: string } | null> {
  const compatible: Record<string, string[]> = {
    NORMAL: ['NORMAL'],
    ARREARS: ['ARREARS', 'NORMAL'],
    OFF_CYCLE: ['OFF_CYCLE', 'ADJUSTMENT', 'NORMAL'],
    ADJUSTMENT: ['ADJUSTMENT', 'OFF_CYCLE', 'NORMAL'],
    FINAL: ['FINAL', 'OFF_CYCLE', 'NORMAL'],
    REVERSAL: ['REVERSAL', 'ADJUSTMENT'],
  };
  if (opts.payrollPeriodId != null && String(opts.payrollPeriodId) !== '') {
    const id = Number(opts.payrollPeriodId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Payroll period must be a valid id');
    const res = await client.query(
      `SELECT id, code, status, period_type, period_start, period_end, payroll_group_id
         FROM payroll_periods
        WHERE id = $1 AND tenant_id = $2 AND company_id = $3
        FOR UPDATE`,
      [id, ctx.tenantId, ctx.companyId]
    );
    if (res.rows.length === 0) throw badRequest('Payroll period not found for this company');
    const p = res.rows[0];
    if (String(p.status) !== 'OPEN') {
      throw conflict(`Payroll period ${p.code} is ${String(p.status).toLowerCase()} and cannot accept new runs`);
    }
    const start = dateOnly(p.period_start);
    const end = dateOnly(p.period_end);
    if (opts.periodStart < start || opts.periodEnd > end) {
      throw badRequest(`Run dates ${opts.periodStart} to ${opts.periodEnd} fall outside payroll period ${p.code} (${start} to ${end})`);
    }
    const allowed = compatible[opts.runType] ?? [];
    if (!allowed.includes(String(p.period_type))) {
      throw badRequest(`Payroll period ${p.code} is a ${p.period_type} period and cannot carry a ${opts.runType} run`);
    }
    if (opts.payrollGroupId != null && Number(p.payroll_group_id) !== Number(opts.payrollGroupId)) {
      throw badRequest(`Payroll period ${p.code} belongs to a different payroll group`);
    }
    return { id, code: String(p.code) };
  }
  if (opts.runType !== 'NORMAL') return null;
  const auto = await client.query(
    `SELECT id, code FROM payroll_periods
      WHERE tenant_id = $1 AND company_id = $2 AND status = 'OPEN' AND period_type = 'NORMAL'
        AND period_start <= $3::date AND period_end >= $4::date
        AND ($5::int IS NULL OR payroll_group_id = $5::int)
      ORDER BY period_start DESC, id DESC
      LIMIT 1`,
    [ctx.tenantId, ctx.companyId, opts.periodStart, opts.periodEnd, opts.payrollGroupId]
  );
  if (auto.rows.length === 0) return null;
  return { id: Number(auto.rows[0].id), code: String(auto.rows[0].code) };
}
/** Run states that still have work left; a period cannot close over one of these. */
const LIVE_RUN_STATUSES = [
  'DRAFT', 'VALIDATING', 'REVIEW', 'PENDING_APPROVAL', 'SUBMITTED',
  'APPROVED', 'RELEASED', 'PAID', 'POSTED', 'REOPENED', 'LOCKED',
];

async function loadPeriodForUpdate(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT id, code, status, period_start, period_end FROM payroll_periods
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Payroll period not found');
  return res.rows[0];
}

/**
 * Close a period once every run hanging off it is final.
 *
 * Closing is the point after which the statutory and cost reports for the
 * window are deemed settled, so it refuses to run over a payroll that is still
 * being prepared, approved, paid or posted.
 */
export async function closePayrollPeriod(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: { reason?: string } = {}
) {
  const row = await loadPeriodForUpdate(client, ctx, id);
  if (String(row.status) === 'CLOSED') throw conflict(`Payroll period ${row.code} is already closed`);
  if (String(row.status) === 'CANCELLED') throw conflict(`Payroll period ${row.code} is cancelled`);

  const live = await client.query(
    `SELECT payroll_no, status FROM payrolls
      WHERE payroll_period_id = $1 AND tenant_id = $2 AND status = ANY($3::text[])
      ORDER BY id LIMIT 5`,
    [id, ctx.tenantId, LIVE_RUN_STATUSES]
  );
  if (live.rows.length > 0) {
    const list = live.rows.map((r) => `${r.payroll_no} (${r.status})`).join(', ');
    throw conflict(`Payroll period ${row.code} still has runs in progress: ${list}. Close or cancel them first.`);
  }

  await client.query(
    `UPDATE payroll_periods SET status = 'CLOSED', closed_by = $4, closed_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [id, ctx.tenantId, ctx.companyId, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'hr.payroll_period.close',
    resource: 'hr.payroll_periods',
    recordId: id,
    recordCode: String(row.code),
    oldValues: { status: String(row.status) },
    newValues: { status: 'CLOSED' },
    metadata: input.reason ? { reason: String(input.reason).trim() } : undefined,
  });
  return getPayrollPeriod(client, ctx, id);
}

/** Cancel an unused period. Only runs already cancelled or voided may remain. */
export async function cancelPayrollPeriod(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: { reason: string }
) {
  const reason = String(input?.reason ?? '').trim();
  if (reason.length < 5) throw badRequest('A reason of at least 5 characters is required to cancel a payroll period');
  const row = await loadPeriodForUpdate(client, ctx, id);
  if (String(row.status) === 'CANCELLED') throw conflict(`Payroll period ${row.code} is already cancelled`);
  if (String(row.status) === 'CLOSED') throw conflict(`Payroll period ${row.code} is closed and cannot be cancelled`);

  const runs = await client.query(
    `SELECT payroll_no, status FROM payrolls
      WHERE payroll_period_id = $1 AND tenant_id = $2 AND status NOT IN ('CANCELLED','VOID')
      ORDER BY id LIMIT 5`,
    [id, ctx.tenantId]
  );
  if (runs.rows.length > 0) {
    const list = runs.rows.map((r) => `${r.payroll_no} (${r.status})`).join(', ');
    throw conflict(`Payroll period ${row.code} is linked to runs that are not cancelled: ${list}`);
  }

  await client.query(
    `UPDATE payroll_periods SET status = 'CANCELLED', notes = COALESCE(notes || E'\n', '') || $4, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [id, ctx.tenantId, ctx.companyId, `Cancelled: ${reason}`]
  );
  await logAudit(client, ctx, {
    action: 'hr.payroll_period.cancel',
    resource: 'hr.payroll_periods',
    recordId: id,
    recordCode: String(row.code),
    oldValues: { status: String(row.status) },
    newValues: { status: 'CANCELLED' },
    metadata: { reason },
  });
  return getPayrollPeriod(client, ctx, id);
}

/** Freeze or reopen the calendar of a period without touching its runs. */
export async function setPayrollPeriodLock(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  locked: boolean,
  input: { reason?: string } = {}
) {
  const row = await loadPeriodForUpdate(client, ctx, id);
  const status = String(row.status);
  const target = locked ? 'LOCKED' : 'OPEN';
  if (status === target) return getPayrollPeriod(client, ctx, id);
  if (status === 'CLOSED' || status === 'CANCELLED') {
    throw conflict(`Payroll period ${row.code} is ${status.toLowerCase()} and cannot be ${locked ? 'locked' : 'reopened'}`);
  }
  await client.query(
    `UPDATE payroll_periods SET status = $4, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [id, ctx.tenantId, ctx.companyId, target]
  );
  await logAudit(client, ctx, {
    action: locked ? 'hr.payroll_period.lock' : 'hr.payroll_period.unlock',
    resource: 'hr.payroll_periods',
    recordId: id,
    recordCode: String(row.code),
    oldValues: { status },
    newValues: { status: target },
    metadata: input.reason ? { reason: String(input.reason).trim() } : undefined,
  });
  return getPayrollPeriod(client, ctx, id);
}
