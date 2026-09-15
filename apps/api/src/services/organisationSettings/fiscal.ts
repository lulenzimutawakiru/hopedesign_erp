import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows, toISODate } from '../../utils.js';
import { logAudit } from '../audit.js';
import { createPeriod, listPeriods } from '../finance.js';

/**
 * Fiscal configuration: the financial year, and the accounting periods inside
 * it.
 *
 * The period lifecycle is the part that matters. A period is the unit the
 * ledger refuses to write into once it is shut, so every transition out of OPEN
 * is a control, and every transition back into OPEN is a control being lifted.
 * Both directions are audited with the reason attached, because "who reopened
 * March and why" is exactly the question an auditor asks (AC-ORG-004).
 *
 * The escalation ladder is deliberately one-way:
 *
 *   OPEN -> SOFT_CLOSE -> CLOSED -> LOCKED
 *
 * Walking back up the ladder is possible - reopening a closed month is a real
 * operational need - but it requires a reason and is counted, so a period that
 * has been reopened eleven times is visible rather than silent.
 */

export const FISCAL_YEAR_STATUSES = ['ACTIVE', 'CLOSED', 'LOCKED'] as const;
export type FiscalYearStatus = (typeof FISCAL_YEAR_STATUSES)[number];

export const PERIOD_ACTIONS = ['open', 'soft_close', 'close', 'reopen', 'lock', 'unlock'] as const;
export type PeriodAction = (typeof PERIOD_ACTIONS)[number];

/** Where each action is allowed to start from. */
const ALLOWED_FROM: Record<PeriodAction, readonly string[]> = {
  open: ['SOFT_CLOSE'],
  soft_close: ['OPEN'],
  close: ['OPEN', 'SOFT_CLOSE'],
  reopen: ['CLOSED', 'LOCKED'],
  lock: ['OPEN', 'SOFT_CLOSE', 'CLOSED'],
  unlock: ['LOCKED'],
};

/** Actions that lift a control and therefore require a stated reason. */
const REASON_REQUIRED: ReadonlySet<string> = new Set(['reopen', 'unlock']);

export interface PeriodMove {
  action: PeriodAction;
  reason?: string | null;
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

function isoDate(value: unknown, field: string): string {
  const s = text(value);
  if (!s) throw badRequest(field + ' is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest(field + ' must be an ISO date (YYYY-MM-DD)');
  return s;
}

// ---------------------------------------------------------------------------
// Financial years
// ---------------------------------------------------------------------------

export async function listFiscalYears(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM fiscal_years
      WHERE tenant_id = $1 AND company_id = $2
      ORDER BY is_current DESC, fiscal_year_start DESC`,
    [ctx.tenantId ?? null, ctx.companyId ?? null]
  );
  return toCamelRows(res.rows);
}

export async function createFiscalYear(
  client: pg.PoolClient,
  ctx: Ctx,
  input: Record<string, unknown>
) {
  const code = text(input.code);
  if (!code) throw badRequest('Fiscal year code is required');
  const name = text(input.name) ?? code;
  const start = isoDate(input.fiscalYearStart ?? input.startDate, 'Financial year start');
  const end = isoDate(input.fiscalYearEnd ?? input.endDate, 'Financial year end');
  if (start >= end) throw badRequest('Financial year start must be before the end date');

  const dup = await client.query(
    'SELECT id FROM fiscal_years WHERE tenant_id = $1 AND company_id = $2 AND code = $3',
    [ctx.tenantId ?? null, ctx.companyId ?? null, code]
  );
  if (dup.rows.length > 0) throw badRequest('Fiscal year ' + code + ' already exists');

  const overlap = await client.query(
    `SELECT code FROM fiscal_years
      WHERE tenant_id = $1 AND company_id = $2
        AND fiscal_year_start <= $3::date AND fiscal_year_end >= $4::date
      LIMIT 1`,
    [ctx.tenantId ?? null, ctx.companyId ?? null, end, start]
  );
  if (overlap.rows.length > 0) {
    throw badRequest('Fiscal year overlaps the existing year ' + overlap.rows[0].code);
  }

  const res = await client.query(
    `INSERT INTO fiscal_years
        (tenant_id, company_id, code, name, fiscal_year_start, fiscal_year_end, status, is_current)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      ctx.tenantId ?? null, ctx.companyId ?? null, code, name, start, end,
      'ACTIVE', input.isCurrent === true,
    ]
  );
  const row = toCamelRow(res.rows[0]);
  if (input.isCurrent === true) await markCurrent(client, ctx, Number(row.id));

  await logAudit(client, ctx, {
    action: 'create',
    resource: 'fiscal_years',
    recordId: Number(row.id),
    recordCode: code,
    newValues: { code, name, start, end, status: 'ACTIVE' },
  });
  return toCamelRow((await client.query('SELECT * FROM fiscal_years WHERE id = $1', [row.id])).rows[0]);
}

export async function updateFiscalYear(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: Record<string, unknown>
) {
  const before = await loadFiscalYear(client, ctx, id);
  const name = text(input.name) ?? String(before.name);
  const start = input.fiscalYearStart ?? input.startDate
    ? isoDate(input.fiscalYearStart ?? input.startDate, 'Financial year start')
    : (toISODate(before.fiscal_year_start) as string);
  const end = input.fiscalYearEnd ?? input.endDate
    ? isoDate(input.fiscalYearEnd ?? input.endDate, 'Financial year end')
    : (toISODate(before.fiscal_year_end) as string);
  if (start >= end) throw badRequest('Financial year start must be before the end date');

  const status = (text(input.status) ?? String(before.status)).toUpperCase();
  if (!(FISCAL_YEAR_STATUSES as readonly string[]).includes(status)) {
    throw badRequest('status must be one of: ' + FISCAL_YEAR_STATUSES.join(', '));
  }

  // Dates of a year that already has a current marker are load-bearing for
  // every posted journal; only the label moves freely.
  if (before.is_current === true && (start !== toISODate(before.fiscal_year_start) || end !== toISODate(before.fiscal_year_end))) {
    throw badRequest('Close the current fiscal year before changing its dates');
  }

  const res = await client.query(
    `UPDATE fiscal_years
        SET name = $3, fiscal_year_start = $4, fiscal_year_end = $5, status = $6, updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, ctx.tenantId ?? null, name, start, end, status]
  );
  if (res.rows.length === 0) throw notFound('Fiscal year not found');

  if (input.isCurrent === true) await markCurrent(client, ctx, id);

  await logAudit(client, ctx, {
    action: 'update',
    resource: 'fiscal_years',
    recordId: id,
    recordCode: String(before.code),
    oldValues: before,
    newValues: res.rows[0],
  });
  return toCamelRow(res.rows[0]);
}

async function loadFiscalYear(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    'SELECT * FROM fiscal_years WHERE id = $1 AND tenant_id = $2',
    [id, ctx.tenantId ?? null]
  );
  if (res.rows.length === 0) throw notFound('Fiscal year not found');
  return res.rows[0];
}

/** Exactly one year is current at a time, enforced in the same statement pair
 *  so a concurrent request cannot leave two rows flagged. */
async function markCurrent(client: pg.PoolClient, ctx: Ctx, id: number) {
  await client.query(
    `UPDATE fiscal_years SET is_current = false, updated_at = now()
      WHERE tenant_id = $1 AND company_id = $2 AND id <> $3 AND is_current = true`,
    [ctx.tenantId ?? null, ctx.companyId ?? null, id]
  );
  await client.query(
    'UPDATE fiscal_years SET is_current = true, updated_at = now() WHERE id = $1',
    [id]
  );
}

// ---------------------------------------------------------------------------
// Accounting periods
// ---------------------------------------------------------------------------

export function listAccountingPeriods(client: pg.PoolClient, ctx: Ctx) {
  return listPeriods(client, ctx);
}

export function openAccountingPeriod(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { code: string; name: string; startDate: string; endDate: string; status?: string }
) {
  return createPeriod(client, ctx, input);
}

/**
 * Move a period along the lifecycle.
 *
 * The guard is checked against the row's status after a FOR UPDATE lock, so two
 * administrators pressing Close at the same moment cannot both succeed.
 */
export async function movePeriod(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: PeriodMove
) {
  const action = String(input.action ?? '').toLowerCase() as PeriodAction;
  if (!(PERIOD_ACTIONS as readonly string[]).includes(action)) {
    throw badRequest('action must be one of: ' + PERIOD_ACTIONS.join(', '));
  }
  const reason = text(input.reason);
  if (REASON_REQUIRED.has(action) && !reason) {
    throw badRequest('A reason is required to ' + action.replace('_', ' ') + ' a period');
  }

  const locked = await client.query(
    'SELECT * FROM financial_periods WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [id, ctx.tenantId ?? null]
  );
  if (locked.rows.length === 0) throw notFound('Accounting period not found');
  const before = locked.rows[0];

  const from = String(before.status);
  if (!ALLOWED_FROM[action].includes(from)) {
    throw badRequest('Cannot ' + action + ' a period that is ' + from + ' (allowed from: ' + ALLOWED_FROM[action].join(', ') + ')');
  }

  // A period cannot be shut while a later one is already open - that would
  // leave a hole in the ledger's timeline.
  if (action === 'close' || action === 'lock') {
    const later = await client.query(
      `SELECT code FROM financial_periods
        WHERE tenant_id = $1 AND company_id = $2 AND start_date > $3::date AND status = 'OPEN'
        LIMIT 1`,
      [ctx.tenantId ?? null, before.company_id, before.start_date]
    );
    if (later.rows.length > 0) {
      throw badRequest('Close period ' + later.rows[0].code + ' first - it starts after this one');
    }
  }

  const userId = ctx.userId ?? null;
  const res = await client.query(
    `UPDATE financial_periods
        SET status = $3,
            status_reason = $4,
            closed_by  = CASE WHEN $3 = 'CLOSED' THEN $5 ELSE closed_by END,
            closed_at  = CASE WHEN $3 = 'CLOSED' THEN now() ELSE closed_at END,
            locked_by  = CASE WHEN $3 = 'LOCKED' THEN $5 ELSE locked_by END,
            locked_at  = CASE WHEN $3 = 'LOCKED' THEN now() ELSE locked_at END,
            reopened_count   = CASE WHEN $3 = 'OPEN' THEN COALESCE(reopened_count,0) + 1 ELSE COALESCE(reopened_count,0) END,
            last_reopened_by = CASE WHEN $3 = 'OPEN' THEN $5 ELSE last_reopened_by END,
            last_reopened_at = CASE WHEN $3 = 'OPEN' THEN now() ELSE last_reopened_at END,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, ctx.tenantId ?? null, periodStatusFor(action), reason, userId]
  );

  await logAudit(client, ctx, {
    action: 'period.' + action,
    resource: 'financial_periods',
    recordId: id,
    recordCode: String(before.code),
    oldValues: { status: from },
    newValues: { status: res.rows[0].status, reason },
    metadata: { reason, reopenedCount: Number(res.rows[0].reopened_count ?? 0) },
  });
  return toCamelRow(res.rows[0]);
}

/** The lifecycle action and the stored status are not the same word. */
function periodStatusFor(action: PeriodAction): string {
  switch (action) {
    case 'open':
    case 'reopen':
    case 'unlock':
      return 'OPEN';
    case 'soft_close':
      return 'SOFT_CLOSE';
    case 'close':
      return 'CLOSED';
    case 'lock':
      return 'LOCKED';
    default:
      throw badRequest('Unsupported period action: ' + action);
  }
}

export async function fiscalOverview(client: pg.PoolClient, ctx: Ctx) {
  const years = await listFiscalYears(client, ctx);
  const periods = await listPeriods(client, ctx);
  const now = toISODate(new Date()) as string;
  return {
    years,
    periods,
    currentYear: years.find((y: Record<string, unknown>) => y.isCurrent === true) ?? null,
    openPeriod: periods.find((p: Record<string, unknown>) => {
      if (p.status !== 'OPEN') return false;
      const starts = toISODate(p.startDate);
      const ends = toISODate(p.endDate);
      return starts !== null && ends !== null && starts <= now && ends >= now;
    }) ?? null,
    closedCount: periods.filter((p: Record<string, unknown>) => p.status === 'CLOSED' || p.status === 'LOCKED').length,
    reopenedCount: periods.reduce((s: number, p: Record<string, unknown>) => s + Number(p.reopenedCount ?? 0), 0),
  };
}
