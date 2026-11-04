import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';

export const TAX_FILING_TYPES = ['VAT_RETURN', 'WHT_RETURN'] as const;
export type TaxFilingType = (typeof TAX_FILING_TYPES)[number];

export const TAX_FILING_STATUSES = ['OPEN', 'PREPARED', 'SUBMITTED', 'FILED', 'CLOSED', 'CANCELLED'] as const;
export type TaxFilingStatus = (typeof TAX_FILING_STATUSES)[number];

const n = (v: unknown): number => Number(v) || 0;
const round2 = (v: number): number => Math.round(v * 100) / 100;

// VAT output/input classification derived from the actual doc_type values the
// ERP records in tax_transactions (see recordTaxTransaction). Credit-note
// amounts are stored positive and reduce output VAT.
const OUTPUT_DOC_TYPES = new Set(['SALES_INVOICE', 'DEBIT_NOTE']);
const INPUT_DOC_TYPES = new Set(['PURCHASE_RECEIPT']);

export interface PrepareTaxFilingInput {
  filingType?: string;
  period?: string;
  periodStart: string;
  periodEnd: string;
}

function assertPeriod(input: PrepareTaxFilingInput): { filingType: string; period: string; periodStart: string; periodEnd: string } {
  const filingType = String(input.filingType ?? 'VAT_RETURN').toUpperCase();
  if (!(TAX_FILING_TYPES as readonly string[]).includes(filingType)) {
    throw badRequest(`Invalid filingType "${filingType}"; expected one of: ${TAX_FILING_TYPES.join(', ')}`);
  }
  const periodStart = String(input.periodStart ?? '').trim();
  const periodEnd = String(input.periodEnd ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    throw badRequest('periodStart and periodEnd must be YYYY-MM-DD dates');
  }
  if (periodStart > periodEnd) throw badRequest('periodStart must not be after periodEnd');
  const period = String(input.period ?? periodStart.slice(0, 7)).trim();
  if (!period) throw badRequest('period is required');
  return { filingType, period, periodStart, periodEnd };
}

/** Compute VAT output/input from posted tax_transactions for a date range. */
export async function computeVat(client: pg.PoolClient, ctx: Ctx, periodStart: string, periodEnd: string) {
  const rows = await client.query(
    `SELECT tt.doc_type,
            SUM(tt.base_amount)::numeric AS base_amount,
            SUM(tt.tax_amount)::numeric AS tax_amount
       FROM tax_transactions tt
       JOIN taxes t ON t.id = tt.tax_id
      WHERE tt.tenant_id = $1 AND tt.company_id = $2
        AND tt.status = 'POSTED'
        AND t.tax_type = 'VAT'
        AND tt.txn_date >= $3::date AND tt.txn_date <= $4::date
      GROUP BY tt.doc_type
      ORDER BY tt.doc_type`,
    [ctx.tenantId, ctx.companyId, periodStart, periodEnd]
  );

  let outputBase = 0;
  let outputVat = 0;
  let inputBase = 0;
  let inputVat = 0;
  const breakdown = rows.rows.map((r: Record<string, unknown>) => {
    const docType = String(r.doc_type);
    const base = n(r.base_amount);
    const tax = n(r.tax_amount);
    let kind: 'OUTPUT' | 'INPUT' | 'CREDIT_NOTE' | 'OTHER';
    if (OUTPUT_DOC_TYPES.has(docType)) {
      kind = 'OUTPUT';
      outputBase += base;
      outputVat += tax;
    } else if (docType === 'CREDIT_NOTE') {
      kind = 'CREDIT_NOTE';
      outputBase -= base;
      outputVat -= tax;
    } else if (INPUT_DOC_TYPES.has(docType)) {
      kind = 'INPUT';
      inputBase += base;
      inputVat += tax;
    } else {
      kind = 'OTHER';
    }
    return { docType, kind, baseAmount: round2(base), taxAmount: round2(tax) };
  });

  const netVatPayable = round2(outputVat - inputVat);
  return {
    periodStart,
    periodEnd,
    outputVatBase: round2(outputBase),
    outputVat: round2(outputVat),
    inputVatBase: round2(inputBase),
    inputVat: round2(inputVat),
    netVatPayable,
    breakdown,
  };
}

export async function listTaxFilings(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { filingType?: string; status?: string; page?: number; pageSize?: number } = {}
) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? 100), 500);
  const offset = (page - 1) * pageSize;
  const params: unknown[] = [ctx.tenantId];
  let where = 'f.tenant_id = $1';
  if (opts.filingType && String(opts.filingType).trim()) {
    params.push(String(opts.filingType).trim().toUpperCase());
    where += ` AND f.filing_type = $${params.length}`;
  }
  if (opts.status && String(opts.status).trim()) {
    params.push(String(opts.status).trim().toUpperCase());
    where += ` AND f.status = $${params.length}`;
  }
  const total = await client.query(`SELECT COUNT(*)::int AS n FROM tax_filings f WHERE ${where}`, params);
  params.push(pageSize, offset);
  const rows = await client.query(
    `SELECT f.*, cb.username AS created_by_name, sb.username AS submitted_by_name,
            fb.username AS filed_by_name
       FROM tax_filings f
       LEFT JOIN users cb ON cb.id = f.created_by
       LEFT JOIN users sb ON sb.id = f.submitted_by
       LEFT JOIN users fb ON fb.id = f.filed_by
      WHERE ${where}
      ORDER BY f.period_end DESC, f.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: toCamelRows(rows.rows), pagination: { page, pageSize, total: Number(total.rows[0].n) } };
}

export async function getTaxFiling(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT f.*, cb.username AS created_by_name, sb.username AS submitted_by_name,
            fb.username AS filed_by_name
       FROM tax_filings f
       LEFT JOIN users cb ON cb.id = f.created_by
       LEFT JOIN users sb ON sb.id = f.submitted_by
       LEFT JOIN users fb ON fb.id = f.filed_by
      WHERE f.id = $1 AND f.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Tax filing not found');
  return toCamelRow(res.rows[0]);
}

/**
 * Compute VAT for a period and create/refresh a PREPARED filing. This is an
 * ERP-side computation only — it never contacts URA and never marks anything
 * submitted.
 */
export async function prepareTaxFiling(client: pg.PoolClient, ctx: Ctx, input: PrepareTaxFilingInput) {
  const { filingType, period, periodStart, periodEnd } = assertPeriod(input);
  const existing = await client.query(
    `SELECT * FROM tax_filings WHERE company_id = $1 AND filing_type = $2 AND period = $3 FOR UPDATE`,
    [ctx.companyId, filingType, period]
  );
  if (existing.rows.length) {
    const cur = existing.rows[0];
    if (!['OPEN', 'PREPARED'].includes(String(cur.status))) {
      throw badRequest(`Filing for ${filingType} ${period} is already ${cur.status} and cannot be re-prepared`);
    }
  }

  const vat = await computeVat(client, ctx, periodStart, periodEnd);
  const summary = { ...vat, computedAt: new Date().toISOString(), filingType };

  if (existing.rows.length) {
    const upd = await client.query(
      `UPDATE tax_filings SET
         period_start = $4, period_end = $5, status = 'PREPARED',
         output_vat_base = $6, output_vat = $7, input_vat_base = $8, input_vat = $9,
         net_vat_payable = $10, summary = $11, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND company_id = $3
       RETURNING *`,
      [existing.rows[0].id, ctx.tenantId, ctx.companyId, periodStart, periodEnd,
       vat.outputVatBase, vat.outputVat, vat.inputVatBase, vat.inputVat, vat.netVatPayable, JSON.stringify(summary)]
    );
    await logAudit(client, ctx, {
      action: 'prepare', resource: 'tax_filings', recordId: Number(existing.rows[0].id),
      recordCode: `${filingType} ${period}`, newValues: { netVatPayable: vat.netVatPayable, status: 'PREPARED' },
    });
    return toCamelRow(upd.rows[0]);
  }

  const ins = await client.query(
    `INSERT INTO tax_filings
       (company_id, tenant_id, filing_type, period, period_start, period_end, status,
        output_vat_base, output_vat, input_vat_base, input_vat, net_vat_payable, summary, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'PREPARED',$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [ctx.companyId, ctx.tenantId, filingType, period, periodStart, periodEnd,
     vat.outputVatBase, vat.outputVat, vat.inputVatBase, vat.inputVat, vat.netVatPayable,
     JSON.stringify(summary), ctx.userId]
  );
  await logAudit(client, ctx, {
    action: 'prepare', resource: 'tax_filings', recordId: Number(ins.rows[0].id),
    recordCode: `${filingType} ${period}`, newValues: { netVatPayable: vat.netVatPayable, status: 'PREPARED' },
  });
  return toCamelRow(ins.rows[0]);
}

function assertTransition(cur: string, to: TaxFilingStatus, allowed: Record<string, TaxFilingStatus[]>) {
  const ok = (allowed[cur] ?? []).includes(to);
  if (!ok) throw badRequest(`Cannot transition a ${cur} filing to ${to}`);
}

/**
 * Mark a PREPARED filing as SUBMITTED. This is a controlled manual action: the
 * operator confirms they have filed the return on the URA portal and records
 * the reference. URA exposes no authorised filing API.
 */
export async function submitFiling(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: { uraReference?: string; notes?: string }
) {
  const cur = await lockFiling(client, ctx, id);
  assertTransition(String(cur.status), 'SUBMITTED', { PREPARED: ['SUBMITTED'] });
  const uraReference = String(input?.uraReference ?? '').trim() || null;
  const notes = input?.notes != null ? String(input.notes) : null;
  const upd = await client.query(
    `UPDATE tax_filings SET status = 'SUBMITTED', submitted_at = now(), submitted_by = $3,
            ura_reference = COALESCE($4, ura_reference), notes = COALESCE($5, notes), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId, ctx.userId, uraReference, notes]
  );
  await logAudit(client, ctx, {
    action: 'submit', resource: 'tax_filings', recordId: id,
    recordCode: `${cur.filing_type} ${cur.period}`,
    oldValues: { status: cur.status }, newValues: { status: 'SUBMITTED', uraReference },
  });
  return toCamelRow(upd.rows[0]);
}

/** Mark a SUBMITTED filing as FILED after URA acknowledges acceptance. */
export async function fileFiling(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: { uraReference?: string; notes?: string }
) {
  const cur = await lockFiling(client, ctx, id);
  assertTransition(String(cur.status), 'FILED', { SUBMITTED: ['FILED'] });
  const uraReference = String(input?.uraReference ?? '').trim() || null;
  const notes = input?.notes != null ? String(input.notes) : null;
  const upd = await client.query(
    `UPDATE tax_filings SET status = 'FILED', filed_at = now(), filed_by = $3,
            ura_reference = COALESCE($4, ura_reference), notes = COALESCE($5, notes), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId, ctx.userId, uraReference, notes]
  );
  await logAudit(client, ctx, {
    action: 'file', resource: 'tax_filings', recordId: id,
    recordCode: `${cur.filing_type} ${cur.period}`,
    oldValues: { status: cur.status }, newValues: { status: 'FILED', uraReference },
  });
  return toCamelRow(upd.rows[0]);
}

export async function closeFiling(client: pg.PoolClient, ctx: Ctx, id: number) {
  const cur = await lockFiling(client, ctx, id);
  assertTransition(String(cur.status), 'CLOSED', { FILED: ['CLOSED'] });
  const upd = await client.query(
    `UPDATE tax_filings SET status = 'CLOSED', closed_at = now(), closed_by = $3, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId, ctx.userId]
  );
  await logAudit(client, ctx, {
    action: 'close', resource: 'tax_filings', recordId: id,
    recordCode: `${cur.filing_type} ${cur.period}`,
    oldValues: { status: cur.status }, newValues: { status: 'CLOSED' },
  });
  return toCamelRow(upd.rows[0]);
}

export async function cancelFiling(client: pg.PoolClient, ctx: Ctx, id: number, input: { notes?: string }) {
  const cur = await lockFiling(client, ctx, id);
  if (['CLOSED', 'CANCELLED'].includes(String(cur.status))) {
    throw badRequest(`Cannot cancel a ${cur.status} filing`);
  }
  const notes = input?.notes != null ? String(input.notes) : null;
  const upd = await client.query(
    `UPDATE tax_filings SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $3,
            notes = COALESCE($4, notes), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId, ctx.userId, notes]
  );
  await logAudit(client, ctx, {
    action: 'cancel', resource: 'tax_filings', recordId: id,
    recordCode: `${cur.filing_type} ${cur.period}`,
    oldValues: { status: cur.status }, newValues: { status: 'CANCELLED' },
  });
  return toCamelRow(upd.rows[0]);
}

async function lockFiling(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT * FROM tax_filings WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Tax filing not found');
  return res.rows[0];
}
