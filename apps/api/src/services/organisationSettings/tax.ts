import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, conflict, notFound, toISODate } from '../../utils.js';
import { toCamelRow, toCamelRows } from '../../utils.js';
import { logAudit } from '../audit.js';

/**
 * Tax configuration, versioned.
 *
 * The rule this file exists to enforce is AC-ORG-005: a tax rate that has been
 * applied to a payroll run or an invoice must never be rewritten afterwards.
 * The database does the enforcing - tax_rates carries effective dating, a
 * no-overlap exclusion, a freeze trigger that makes a closed revision
 * immutable and a delete trigger that refuses to remove one:
 *
 *   - an OPEN revision (effective_to IS NULL) is the current rate and is freely
 *     editable, because nothing has been calculated against it yet;
 *   - closing a revision stamps effective_to, after which rate, dates and type
 *     are frozen and the row cannot be deleted.
 *
 * So "change the VAT rate" is modelled as: close the open revision at the
 * change-over date, open a new one. That is what createRateRevision does, and
 * why the previous rate remains readable for the period it applied to.
 *
 * Rates are never hard-coded in application logic; consumers call
 * resolveTaxRate(taxCode, onDate) so a Uganda Budget-night change is a
 * configuration change, not a deployment (AC-ORG-012).
 */

/** Postgres error codes raised by the versioning triggers. */
const EXCLUSION_VIOLATION = '23P01';
const RESTRICT_VIOLATION = '23001';
const UNIQUE_VIOLATION = '23505';

function pgCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

const TAX_TYPES = [
  'VAT', 'PAYE', 'NSSF', 'WHT', 'CORPORATE', 'EXCISE',
  'STAMP_DUTY', 'LOCAL_SERVICE', 'OTHER',
] as const;
const RATE_STATUSES = ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'REVOKED'] as const;
const BASES = ['MONTHLY', 'ANNUAL', 'DAILY'] as const;

function requireCompany(ctx: Ctx): number {
  if (ctx.companyId == null) {
    throw badRequest('An active company context is required to configure tax');
  }
  return Number(ctx.companyId);
}

function text(v: unknown, field: string, required = false): string | null {
  if (v === null || v === undefined) {
    if (required) throw badRequest(field + ' is required');
    return null;
  }
  const s = String(v).trim();
  if (s === '') {
    if (required) throw badRequest(field + ' is required');
    return null;
  }
  return s;
}

function date(v: unknown, field: string, required = false): string | null {
  const s = text(v, field, required);
  if (s === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest(field + ' must be a YYYY-MM-DD date');
  return s;
}

function money(v: unknown, field: string, required = false): number | null {
  if (v === null || v === undefined || v === '') {
    if (required) throw badRequest(field + ' is required');
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(field + ' must be a number');
  return n;
}

function bool(v: unknown, dflt: boolean): boolean {
  if (v === null || v === undefined || v === '') return dflt;
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  throw badRequest('Expected a boolean value');
}

function pick<T extends readonly string[]>(v: unknown, allowed: T, field: string, required = false): string | null {
  const s = text(v, field, required);
  if (s === null) return null;
  if (!(allowed as readonly string[]).includes(s)) {
    throw badRequest(field + ' must be one of: ' + (allowed as readonly string[]).join(', '));
  }
  return s;
}

const scope = (ctx: Ctx): [number | null, number] => [ctx.tenantId ?? null, requireCompany(ctx)];

// ===========================================================================
// Tax categories
// ===========================================================================

export async function listTaxCategories(client: pg.PoolClient, ctx: Ctx) {
  const [tenantId, companyId] = scope(ctx);
  const { rows } = await client.query(
    `SELECT * FROM tax_categories
      WHERE tenant_id = $1 AND company_id = $2
      ORDER BY priority, code`,
    [tenantId, companyId]
  );
  return { rows: toCamelRows(rows) };
}

export async function createTaxCategory(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const [tenantId, companyId] = scope(ctx);
  const code = text(body.code, 'code', true) as string;
  const name = text(body.name, 'name', true) as string;
  const priority = money(body.priority, 'priority') ?? 100;
  try {
    const { rows } = await client.query(
      `INSERT INTO tax_categories
         (tenant_id, company_id, code, name, description, priority, is_active, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
      [
        tenantId, companyId, code, name,
        text(body.description, 'description'), priority,
        bool(body.is_active, true), ctx.userId ?? null,
      ]
    );
    await logAudit(client, ctx, {
      action: 'create',
      resource: 'organisation.settings.tax.category',
      recordId: Number(rows[0].id),
      recordCode: code,
      newValues: rows[0],
    });
    return toCamelRow(rows[0]);
  } catch (err) {
    if (pgCode(err) === UNIQUE_VIOLATION) throw conflict('Tax category ' + code + ' already exists');
    throw err;
  }
}

export async function updateTaxCategory(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const [tenantId, companyId] = scope(ctx);
  const before = await client.query(
    'SELECT * FROM tax_categories WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    [id, tenantId, companyId]
  );
  if (before.rows.length === 0) throw notFound('Tax category ' + id + ' not found');
  const { rows } = await client.query(
    `UPDATE tax_categories
        SET name = COALESCE($4, name),
            description = COALESCE($5, description),
            priority = COALESCE($6, priority),
            is_active = COALESCE($7, is_active),
            updated_by = $8
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3
      RETURNING *`,
    [
      id, tenantId, companyId,
      text(body.name, 'name'),
      text(body.description, 'description'),
      money(body.priority, 'priority'),
      body.is_active === undefined ? null : bool(body.is_active, true),
      ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'organisation.settings.tax.category',
    recordId: id,
    recordCode: String(rows[0].code),
    oldValues: before.rows[0],
    newValues: rows[0],
  });
  return toCamelRow(rows[0]);
}

// ===========================================================================
// Tax rates - the versioned part
// ===========================================================================

export interface TaxRateListOptions {
  taxCode?: string | null;
  includeHistory?: boolean;
}

export async function listTaxRates(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: TaxRateListOptions = {}
) {
  const [tenantId, companyId] = scope(ctx);
  const params: unknown[] = [tenantId, companyId];
  const conds = ['tenant_id = $1', 'company_id = $2'];
  if (opts.taxCode) {
    params.push(opts.taxCode);
    conds.push(`tax_code = $${params.length}`);
  }
  const { rows } = await client.query(
    `SELECT * FROM tax_rates WHERE ${conds.join(' AND ')}
      ORDER BY tax_code, effective_from DESC`,
    params
  );
  const all = toCamelRows(rows);
  if (opts.includeHistory) return { rows: all };
  // Default view: what is in force today, plus the open revision if one exists.
  const today = toISODate(new Date()) as string;
  const current = all.filter((r) => {
    const closes = toISODate(r.effectiveTo);
    return closes === null || closes > today;
  });
  return { rows: current, historyIncluded: false };
}

/**
 * Read the rate that applied to a tax code on a given date.
 *
 * This is the function every calculation path should call. Because it selects by
 * effective date, a payroll run for July keeps resolving July's rate even after
 * the rate changes in August - which is exactly TC-ORG-009.
 */
export async function resolveTaxRate(
  client: pg.PoolClient,
  ctx: Ctx,
  taxCode: string,
  onDate: string
) {
  const [tenantId, companyId] = scope(ctx);
  const { rows } = await client.query(
    `SELECT * FROM tax_rates
      WHERE tenant_id = $1 AND company_id = $2 AND tax_code = $3
        AND effective_from <= $4::date
        AND (effective_to IS NULL OR effective_to > $4::date)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [tenantId, companyId, taxCode, onDate]
  );
  return rows.length === 0 ? null : toCamelRow(rows[0]);
}

/** Every revision of one tax code, oldest first - the version history screen. */
export async function taxRateHistory(client: pg.PoolClient, ctx: Ctx, taxCode: string) {
  const [tenantId, companyId] = scope(ctx);
  const { rows } = await client.query(
    `SELECT * FROM tax_rates
      WHERE tenant_id = $1 AND company_id = $2 AND tax_code = $3
      ORDER BY effective_from`,
    [tenantId, companyId, taxCode]
  );
  return { taxCode, revisions: toCamelRows(rows) };
}

async function openRevision(client: pg.PoolClient, ctx: Ctx, taxCode: string) {
  const [tenantId, companyId] = scope(ctx);
  const { rows } = await client.query(
    `SELECT * FROM tax_rates
      WHERE tenant_id = $1 AND company_id = $2 AND tax_code = $3 AND effective_to IS NULL
      ORDER BY effective_from DESC LIMIT 1`,
    [tenantId, companyId, taxCode]
  );
  return rows[0] as Record<string, unknown> | undefined;
}

/**
 * Change a tax rate.
 *
 * Closes the open revision the day before the new one starts and opens the new
 * one. Order matters: the partial unique index permits only one open revision
 * per tax code, so the old row must be closed before the new row is inserted.
 */
export async function createTaxRateRevision(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
) {
  const [tenantId, companyId] = scope(ctx);
  const taxCode = text(body.tax_code ?? body.taxCode, 'tax_code', true) as string;
  const effectiveFrom = date(body.effective_from ?? body.effectiveFrom, 'effective_from', true) as string;
  const rate = money(body.rate, 'rate');
  if (rate !== null && (rate < 0 || rate > 100)) throw badRequest('rate must be between 0 and 100');

  const open = await openRevision(client, ctx, taxCode);
  if (open) {
    const openFrom = toISODate(open.effective_from);
    if (openFrom !== null && effectiveFrom <= openFrom) {
      throw conflict(
        'The new revision must start after the current open revision (' + openFrom + '); use PATCH to correct the open revision instead'
      );
    }
    await client.query(
      `UPDATE tax_rates SET effective_to = $2, status = 'SUPERSEDED', updated_by = $3
        WHERE id = $1`,
      [Number(open.id), effectiveFrom, ctx.userId ?? null]
    );
  }

  const taxName = text(body.tax_name ?? body.taxName, 'tax_name') ?? taxCode;
  try {
    const { rows } = await client.query(
      `INSERT INTO tax_rates
         (tenant_id, company_id, tax_code, tax_name, tax_type, category_id, rate,
          is_inclusive, is_compound, applies_to, account_id, effective_from, effective_to,
          source_reference, notes, status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14,$15,$16,$16)
       RETURNING *`,
      [
        tenantId, companyId, taxCode, taxName,
        pick(body.tax_type ?? body.taxType, TAX_TYPES, 'tax_type', true),
        money(body.category_id ?? body.categoryId, 'category_id'),
        rate,
        bool(body.is_inclusive ?? body.isInclusive, false),
        bool(body.is_compound ?? body.isCompound, false),
        text(body.applies_to ?? body.appliesTo, 'applies_to') ?? 'ALL',
        money(body.account_id ?? body.accountId, 'account_id'),
        effectiveFrom,
        text(body.source_reference ?? body.sourceReference, 'source_reference'),
        text(body.notes, 'notes'),
        pick(body.status, RATE_STATUSES, 'status') ?? 'ACTIVE',
        ctx.userId ?? null,
      ]
    );
    await logAudit(client, ctx, {
      action: 'create',
      resource: 'organisation.settings.tax.rate',
      recordId: Number(rows[0].id),
      recordCode: taxCode,
      newValues: rows[0],
      metadata: {
        supersededRevisionId: open ? Number(open.id) : null,
        effectiveFrom,
        reason: text(body.reason, 'reason'),
      },
    });
    return toCamelRow(rows[0]);
  } catch (err) {
    if (pgCode(err) === EXCLUSION_VIOLATION) {
      throw conflict('A revision for ' + taxCode + ' already covers ' + effectiveFrom);
    }
    if (pgCode(err) === UNIQUE_VIOLATION) {
      throw conflict('An open revision for ' + taxCode + ' already exists');
    }
    throw err;
  }
}

/**
 * Correct the open revision.
 *
 * Only the open revision is editable - the triggers refuse everything else - so
 * this is how a mistaken current rate is fixed without touching history.
 */
export async function updateTaxRate(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const [tenantId, companyId] = scope(ctx);
  const before = await client.query(
    'SELECT * FROM tax_rates WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    [id, tenantId, companyId]
  );
  if (before.rows.length === 0) throw notFound('Tax rate revision ' + id + ' not found');
  if (before.rows[0].effective_to !== null) {
    throw conflict(
      'Revision for ' + before.rows[0].tax_code + ' closed on ' + toISODate(before.rows[0].effective_to) +
        ' is immutable; create a new revision instead'
    );
  }
  const rate = money(body.rate, 'rate');
  if (rate !== null && (rate < 0 || rate > 100)) throw badRequest('rate must be between 0 and 100');

  try {
    const { rows } = await client.query(
      `UPDATE tax_rates
          SET rate = COALESCE($4, rate),
              tax_name = COALESCE($5, tax_name),
              notes = COALESCE($6, notes),
              status = COALESCE($7, status),
              is_inclusive = COALESCE($8, is_inclusive),
              is_compound = COALESCE($9, is_compound),
              updated_by = $10
        WHERE id = $1 AND tenant_id = $2 AND company_id = $3
        RETURNING *`,
      [
        id, tenantId, companyId, rate,
        text(body.tax_name ?? body.taxName, 'tax_name'),
        text(body.notes, 'notes'),
        pick(body.status, RATE_STATUSES, 'status'),
        body.is_inclusive === undefined && body.isInclusive === undefined
          ? null : bool(body.is_inclusive ?? body.isInclusive, false),
        body.is_compound === undefined && body.isCompound === undefined
          ? null : bool(body.is_compound ?? body.isCompound, false),
        ctx.userId ?? null,
      ]
    );
    await logAudit(client, ctx, {
      action: 'update',
      resource: 'organisation.settings.tax.rate',
      recordId: id,
      recordCode: String(rows[0].tax_code),
      oldValues: before.rows[0],
      newValues: rows[0],
    });
    return toCamelRow(rows[0]);
  } catch (err) {
    if (pgCode(err) === RESTRICT_VIOLATION || pgCode(err) === EXCLUSION_VIOLATION) {
      throw conflict('The revision could not be updated: ' + (err as Error).message);
    }
    throw err;
  }
}

/**
 * Close the open revision without opening a new one - for withdrawing a rate
 * that should not continue, e.g. a Budget measure that was reversed before it
 * took effect. From this point the revision is immutable.
 */
export async function closeTaxRate(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const [tenantId, companyId] = scope(ctx);
  const effectiveTo = date(body.effective_to ?? body.effectiveTo, 'effective_to', true) as string;
  const before = await client.query(
    'SELECT * FROM tax_rates WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    [id, tenantId, companyId]
  );
  if (before.rows.length === 0) throw notFound('Tax rate revision ' + id + ' not found');
  if (before.rows[0].effective_to !== null) {
    throw conflict('Revision ' + id + ' is already closed and is immutable');
  }
  const openFrom = toISODate(before.rows[0].effective_from);
  if (openFrom !== null && effectiveTo <= openFrom) {
    throw badRequest('effective_to must be after effective_from');
  }
  try {
    const { rows } = await client.query(
      `UPDATE tax_rates SET effective_to = $4, status = 'SUPERSEDED', updated_by = $5
        WHERE id = $1 AND tenant_id = $2 AND company_id = $3 RETURNING *`,
      [id, tenantId, companyId, effectiveTo, ctx.userId ?? null]
    );
    await logAudit(client, ctx, {
      action: 'close',
      resource: 'organisation.settings.tax.rate',
      recordId: id,
      recordCode: String(rows[0].tax_code),
      oldValues: before.rows[0],
      newValues: rows[0],
      metadata: { reason: text(body.reason, 'reason') },
    });
    return toCamelRow(rows[0]);
  } catch (err) {
    if (pgCode(err) === RESTRICT_VIOLATION || pgCode(err) === EXCLUSION_VIOLATION) {
      throw conflict('The revision could not be closed: ' + (err as Error).message);
    }
    throw err;
  }
}

/** Delete a revision that has not yet taken effect. Closed revisions are kept. */
export async function deleteTaxRate(client: pg.PoolClient, ctx: Ctx, id: number) {
  const [tenantId, companyId] = scope(ctx);
  const before = await client.query(
    'SELECT * FROM tax_rates WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    [id, tenantId, companyId]
  );
  if (before.rows.length === 0) throw notFound('Tax rate revision ' + id + ' not found');
  if (before.rows[0].effective_to !== null) {
    throw conflict(
      'Closed revision ' + id + ' is part of the tax record and cannot be deleted (AC-ORG-005)'
    );
  }
  await client.query('DELETE FROM tax_rates WHERE id = $1 AND tenant_id = $2 AND company_id = $3', [
    id, tenantId, companyId,
  ]);
  await logAudit(client, ctx, {
    action: 'delete',
    resource: 'organisation.settings.tax.rate',
    recordId: id,
    recordCode: String(before.rows[0].tax_code),
    oldValues: before.rows[0],
  });
  return { deleted: true, id };
}

// ===========================================================================
// Tax exemptions
// ===========================================================================

export async function listTaxExemptions(client: pg.PoolClient, ctx: Ctx) {
  const [tenantId, companyId] = scope(ctx);
  const { rows } = await client.query(
    `SELECT * FROM tax_exemptions
      WHERE tenant_id = $1 AND company_id = $2
      ORDER BY effective_from DESC, tax_code`,
    [tenantId, companyId]
  );
  return { rows: toCamelRows(rows) };
}

export async function createTaxExemption(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const [tenantId, companyId] = scope(ctx);
  const effectiveFrom = date(body.effective_from ?? body.effectiveFrom, 'effective_from') ??
    (toISODate(new Date()) as string);
  const effectiveTo = date(body.effective_to ?? body.effectiveTo, 'effective_to');
  if (effectiveTo !== null && effectiveTo <= effectiveFrom) {
    throw badRequest('effective_to must be after effective_from');
  }
  const { rows } = await client.query(
    `INSERT INTO tax_exemptions
       (tenant_id, company_id, tax_code, entity_type, entity_id, entity_reference, reason,
        certificate_reference, effective_from, effective_to, status, approved_by, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
     RETURNING *`,
    [
      tenantId, companyId,
      text(body.tax_code ?? body.taxCode, 'tax_code', true),
      pick(body.entity_type ?? body.entityType, ['CUSTOMER', 'SUPPLIER', 'ITEM', 'COMPANY'] as const, 'entity_type') ?? 'CUSTOMER',
      money(body.entity_id ?? body.entityId, 'entity_id'),
      text(body.entity_reference ?? body.entityReference, 'entity_reference'),
      text(body.reason, 'reason', true),
      text(body.certificate_reference ?? body.certificateReference, 'certificate_reference'),
      effectiveFrom, effectiveTo,
      text(body.status, 'status') ?? 'ACTIVE',
      ctx.userId ?? null,
      ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'organisation.settings.tax.exemption',
    recordId: Number(rows[0].id),
    recordCode: String(rows[0].tax_code),
    newValues: rows[0],
  });
  return toCamelRow(rows[0]);
}

export async function updateTaxExemption(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
) {
  const [tenantId, companyId] = scope(ctx);
  const before = await client.query(
    'SELECT * FROM tax_exemptions WHERE id = $1 AND tenant_id = $2 AND company_id = $3',
    [id, tenantId, companyId]
  );
  if (before.rows.length === 0) throw notFound('Tax exemption ' + id + ' not found');
  const effectiveTo = date(body.effective_to ?? body.effectiveTo, 'effective_to');
  const { rows } = await client.query(
    `UPDATE tax_exemptions
        SET reason = COALESCE($4, reason),
            certificate_reference = COALESCE($5, certificate_reference),
            effective_to = COALESCE($6::date, effective_to),
            status = COALESCE($7, status),
            updated_by = $8
      WHERE id = $1 AND tenant_id = $2 AND company_id = $3
      RETURNING *`,
    [
      id, tenantId, companyId,
      text(body.reason, 'reason'),
      text(body.certificate_reference ?? body.certificateReference, 'certificate_reference'),
      effectiveTo,
      text(body.status, 'status'),
      ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'organisation.settings.tax.exemption',
    recordId: id,
    recordCode: String(rows[0].tax_code),
    oldValues: before.rows[0],
    newValues: rows[0],
  });
  return toCamelRow(rows[0]);
}

// ===========================================================================
// Tax thresholds - banded rates (PAYE bands, NSSF tiers)
// ===========================================================================

export async function listTaxThresholds(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { taxCode?: string | null } = {}
) {
  const [tenantId, companyId] = scope(ctx);
  const params: unknown[] = [tenantId, companyId];
  const conds = ['tenant_id = $1', 'company_id = $2'];
  if (opts.taxCode) {
    params.push(opts.taxCode);
    conds.push(`tax_code = $${params.length}`);
  }
  const { rows } = await client.query(
    `SELECT * FROM tax_thresholds WHERE ${conds.join(' AND ')}
      ORDER BY tax_code, basis, effective_from DESC, seq`,
    params
  );
  return { rows: toCamelRows(rows) };
}

/**
 * Replace the band set for one tax code as of a date.
 *
 * Bands only make sense as a complete set - a missing band silently changes
 * someone's PAYE - so this is a replace, not a per-row upsert. Existing bands
 * for the same code/basis/date are superseded rather than mutated, keeping the
 * earlier set readable for the periods it applied to.
 */
export async function replaceTaxThresholds(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
) {
  const [tenantId, companyId] = scope(ctx);
  const taxCode = text(body.tax_code ?? body.taxCode, 'tax_code', true) as string;
  const basis = pick(body.basis, BASES, 'basis', true) as string;
  const effectiveFrom = date(body.effective_from ?? body.effectiveFrom, 'effective_from', true) as string;
  const bands = Array.isArray(body.bands) ? (body.bands as Array<Record<string, unknown>>) : null;
  if (!bands || bands.length === 0) throw badRequest('bands must be a non-empty array');

  const prepared = bands.map((b, i) => {
    const seq = money(b.seq, 'seq') ?? i + 1;
    return {
      seq,
      lower: money(b.lower_limit ?? b.lowerLimit, 'lower_limit') ?? 0,
      upper: money(b.upper_limit ?? b.upperLimit, 'upper_limit'),
      rate: money(b.rate, 'rate', true) as number,
      relief: money(b.relief_amount ?? b.reliefAmount, 'relief_amount') ?? 0,
    };
  });
  prepared.sort((a, b) => a.seq - b.seq);
  for (const band of prepared) {
    if (band.upper !== null && band.upper <= band.lower) {
      throw badRequest('Band ' + band.seq + ': upper_limit must exceed lower_limit');
    }
  }

  // Supersede the previous set rather than deleting it.
  await client.query(
    `UPDATE tax_thresholds SET effective_to = $4, updated_by = $5
      WHERE tenant_id = $1 AND company_id = $2 AND tax_code = $3 AND basis = $6
        AND effective_from < $4::date AND effective_to IS NULL`,
    [tenantId, companyId, taxCode, effectiveFrom, ctx.userId ?? null, basis]
  );

  const inserted: Record<string, unknown>[] = [];
  for (const band of prepared) {
    const { rows } = await client.query(
      `INSERT INTO tax_thresholds
         (tenant_id, company_id, tax_code, seq, lower_limit, upper_limit, rate, relief_amount,
          basis, effective_from, effective_to, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$11)
       ON CONFLICT (company_id, tax_code, basis, effective_from, seq)
       DO UPDATE SET lower_limit = EXCLUDED.lower_limit, upper_limit = EXCLUDED.upper_limit,
                     rate = EXCLUDED.rate, relief_amount = EXCLUDED.relief_amount,
                     effective_to = NULL, updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [
        tenantId, companyId, taxCode, band.seq, band.lower, band.upper, band.rate, band.relief,
        basis, effectiveFrom, ctx.userId ?? null,
      ]
    );
    inserted.push(rows[0]);
  }

  await logAudit(client, ctx, {
    action: 'replace',
    resource: 'organisation.settings.tax.thresholds',
    recordCode: taxCode,
    newValues: { taxCode, basis, effectiveFrom, bands: prepared },
    metadata: { effectiveFrom, basis, count: prepared.length },
  });
  return { taxCode, basis, effectiveFrom, rows: toCamelRows(inserted) };
}
