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

export type TaxDirection = 'OUTPUT' | 'INPUT' | 'OTHER';

/** One VAT or other-tax line the compliance screen and the VAT return share. Amounts for a credit note are already negative. */
export interface TaxActivityRow {
  id: string;
  docType: string;
  docRefType: string | null;
  docRefId: number | null;
  docRefCode: string | null;
  txnDate: string;
  baseAmount: number;
  taxAmount: number;
  rate: number;
  status: string;
  taxCode: string;
  taxName: string;
  taxType: string;
  direction: TaxDirection;
  jurisdictionCode: string | null;
}

export interface TaxSummaryRow {
  taxCode: string;
  taxName: string;
  taxType: string;
  direction: TaxDirection;
  txnCount: number;
  baseAmount: number;
  taxAmount: number;
}

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

const ACTIVITY_SQL = `
WITH activity AS (
  SELECT 'inv-' || i.id::text AS id,
         'SALES_INVOICE'::text AS doc_type,
         'customer_invoices'::text AS doc_ref_type,
         i.id AS doc_ref_id,
         i.invoice_no AS doc_ref_code,
         i.invoice_date AS txn_date,
         GREATEST(i.subtotal - i.discount_amount, 0) AS base_amount,
         i.tax_amount AS tax_amount,
         'VAT-OUT'::text AS tax_code,
         'Output VAT'::text AS tax_name,
         'VAT'::text AS tax_type,
         'OUTPUT'::text AS direction,
         NULL::text AS jurisdiction_code,
         'POSTED'::text AS status
    FROM customer_invoices i
   WHERE i.tenant_id = $1 AND i.company_id = $2
     AND i.gl_posted = true AND i.status <> 'VOID'
  UNION ALL
  SELECT 'cn-' || cn.id::text,
         'CREDIT_NOTE',
         'credit_notes',
         cn.id,
         cn.credit_no,
         cn.credit_date,
         -GREATEST(cn.amount - cn.tax_amount, 0),
         -cn.tax_amount,
         'VAT-OUT',
         'Output VAT',
         'VAT',
         'OUTPUT',
         NULL,
         'POSTED'
    FROM credit_notes cn
   WHERE cn.tenant_id = $1 AND cn.company_id = $2
     AND cn.gl_posted = true AND cn.status <> 'VOID'
  UNION ALL
  SELECT 'dn-' || dn.id::text,
         'DEBIT_NOTE',
         'debit_notes',
         dn.id,
         dn.debit_no,
         dn.debit_date,
         GREATEST(dn.amount - dn.tax_amount, 0),
         dn.tax_amount,
         'VAT-OUT',
         'Output VAT',
         'VAT',
         'OUTPUT',
         NULL,
         'POSTED'
    FROM debit_notes dn
   WHERE dn.tenant_id = $1 AND dn.company_id = $2
     AND dn.gl_posted = true AND dn.status <> 'VOID'
  UNION ALL
  SELECT 'si-' || si.id::text,
         'SUPPLIER_INVOICE',
         'supplier_invoices',
         si.id,
         si.supplier_invoice_no,
         si.invoice_date,
         GREATEST(si.subtotal, 0),
         si.tax_amount,
         'VAT-IN',
         'Input VAT',
         'VAT',
         'INPUT',
         NULL,
         'POSTED'
    FROM supplier_invoices si
   WHERE si.tenant_id = $1 AND si.company_id = $2
     AND si.gl_posted = true AND si.status <> 'VOID'
  UNION ALL
  SELECT 'tx-' || tt.id::text,
         tt.doc_type,
         tt.doc_ref_type,
         tt.doc_ref_id,
         tt.doc_ref_code,
         tt.txn_date,
         CASE WHEN tt.doc_type = 'CREDIT_NOTE' THEN -tt.base_amount ELSE tt.base_amount END,
         CASE WHEN tt.doc_type = 'CREDIT_NOTE' THEN -tt.tax_amount ELSE tt.tax_amount END,
         t.code,
         t.name,
         t.tax_type,
         CASE
           WHEN t.tax_type = 'VAT' AND tt.doc_type IN ('SUPPLIER_INVOICE', 'PURCHASE_INVOICE', 'PURCHASE_RECEIPT') THEN 'INPUT'
           WHEN t.tax_type = 'VAT' THEN 'OUTPUT'
           ELSE 'OTHER'
         END,
         tj.code,
         tt.status
    FROM tax_transactions tt
    JOIN taxes t ON t.id = tt.tax_id
    LEFT JOIN tax_jurisdictions tj ON tj.id = tt.jurisdiction_id
   WHERE tt.tenant_id = $1 AND tt.company_id = $2
     AND tt.status = 'POSTED'
     AND NOT (
       tt.doc_ref_id IS NOT NULL
       AND tt.doc_ref_type IN ('customer_invoices', 'credit_notes', 'debit_notes', 'supplier_invoices')
     )
)
SELECT * FROM activity
 WHERE ($3::date IS NULL OR txn_date >= $3::date)
   AND ($4::date IS NULL OR txn_date <= $4::date)
   AND NOT (base_amount = 0 AND tax_amount = 0)
 ORDER BY txn_date DESC, doc_ref_code DESC
`;

function asDirection(value: unknown): TaxDirection {
  const dir = String(value ?? '').toUpperCase();
  if (dir === 'OUTPUT' || dir === 'INPUT') return dir;
  return 'OTHER';
}

function rateOf(base: number, tax: number): number {
  const absBase = Math.abs(base);
  if (absBase === 0) return 0;
  return Math.round((Math.abs(tax) / absBase) * 10000) / 100;
}

function mapActivity(row: Record<string, unknown>): TaxActivityRow {
  const baseAmount = n(row.base_amount);
  const taxAmount = n(row.tax_amount);
  return {
    id: String(row.id),
    docType: String(row.doc_type ?? ''),
    docRefType: row.doc_ref_type != null ? String(row.doc_ref_type) : null,
    docRefId: row.doc_ref_id != null ? Number(row.doc_ref_id) : null,
    docRefCode: row.doc_ref_code != null ? String(row.doc_ref_code) : null,
    txnDate: String(row.txn_date ?? '').slice(0, 10),
    baseAmount,
    taxAmount,
    rate: rateOf(baseAmount, taxAmount),
    status: String(row.status ?? 'POSTED'),
    taxCode: String(row.tax_code ?? ''),
    taxName: String(row.tax_name ?? ''),
    taxType: String(row.tax_type ?? ''),
    direction: asDirection(row.direction),
    jurisdictionCode: row.jurisdiction_code != null ? String(row.jurisdiction_code) : null,
  };
}

/**
 * Posted sales, credit notes, debit notes and supplier invoices, plus manual
 * tax lines that do not repeat those documents. Credit notes are negative so
 * a straight sum is the net figure.
 */
export async function loadTaxActivity(
  client: pg.PoolClient,
  ctx: Ctx,
  from?: string | null,
  to?: string | null,
): Promise<TaxActivityRow[]> {
  const res = await client.query(ACTIVITY_SQL, [ctx.tenantId, ctx.companyId, from || null, to || null]);
  return res.rows.map((row: Record<string, unknown>) => mapActivity(row));
}

/** Group activity into the cards on the tax compliance screen. Input VAT stays positive; `direction` says it reduces the payable. */
export function summarizeTaxActivity(rows: TaxActivityRow[]): TaxSummaryRow[] {
  const buckets = new Map<string, TaxSummaryRow>();
  for (const row of rows) {
    const vat = row.direction === 'OUTPUT' || row.direction === 'INPUT';
    const key = vat ? row.direction : row.taxCode || row.taxType || 'OTHER';
    const current = buckets.get(key) ?? {
      taxCode: vat ? (row.direction === 'INPUT' ? 'VAT-IN' : 'VAT-OUT') : row.taxCode,
      taxName: vat ? (row.direction === 'INPUT' ? 'Input VAT' : 'Output VAT') : (row.taxName || row.taxCode),
      taxType: vat ? 'VAT' : row.taxType,
      direction: row.direction,
      txnCount: 0,
      baseAmount: 0,
      taxAmount: 0,
    };
    current.txnCount += 1;
    current.baseAmount += row.baseAmount;
    current.taxAmount += row.taxAmount;
    buckets.set(key, current);
  }
  return [...buckets.values()]
    .map((row) => ({ ...row, baseAmount: round2(row.baseAmount), taxAmount: round2(row.taxAmount) }))
    .sort((a, b) => a.taxCode.localeCompare(b.taxCode));
}

/** Net output and input VAT from an activity list. Credit notes are already signed. */
export function foldVat(rows: TaxActivityRow[]) {
  let outputBase = 0;
  let outputVat = 0;
  let inputBase = 0;
  let inputVat = 0;
  const byDoc = new Map<string, { docType: string; kind: 'OUTPUT' | 'INPUT'; baseAmount: number; taxAmount: number }>();
  for (const row of rows) {
    if (row.direction !== 'OUTPUT' && row.direction !== 'INPUT') continue;
    if (row.direction === 'INPUT') {
      inputBase += row.baseAmount;
      inputVat += row.taxAmount;
    } else {
      outputBase += row.baseAmount;
      outputVat += row.taxAmount;
    }
    const kind = row.direction === 'INPUT' ? 'INPUT' : 'OUTPUT';
    const current = byDoc.get(row.docType) ?? { docType: row.docType, kind, baseAmount: 0, taxAmount: 0 };
    current.baseAmount += row.baseAmount;
    current.taxAmount += row.taxAmount;
    byDoc.set(row.docType, current);
  }
  return {
    outputVatBase: round2(outputBase),
    outputVat: round2(outputVat),
    inputVatBase: round2(inputBase),
    inputVat: round2(inputVat),
    netVatPayable: round2(outputVat - inputVat),
    breakdown: [...byDoc.values()].map((row) => ({
      docType: row.docType,
      kind: row.kind,
      baseAmount: round2(row.baseAmount),
      taxAmount: round2(row.taxAmount),
    })),
  };
}

/** Compute VAT output/input from posted documents, with manual VAT adjustments that are not already on those documents. */
export async function computeVat(client: pg.PoolClient, ctx: Ctx, periodStart: string, periodEnd: string) {
  const rows = await loadTaxActivity(client, ctx, periodStart, periodEnd);
  return { periodStart, periodEnd, ...foldVat(rows) };
}

/** Withholding is not on the sales invoice. It comes from posted WHT tax transactions. */
export async function computeWht(client: pg.PoolClient, ctx: Ctx, periodStart: string, periodEnd: string) {
  const res = await client.query(
    `SELECT COALESCE(SUM(tt.base_amount), 0)::numeric AS base_amount,
            COALESCE(SUM(tt.tax_amount), 0)::numeric AS tax_amount
       FROM tax_transactions tt
       JOIN taxes t ON t.id = tt.tax_id
      WHERE tt.tenant_id = $1 AND tt.company_id = $2
        AND tt.status = 'POSTED'
        AND t.tax_type IN ('WHT', 'WITHHOLDING_VAT')
        AND tt.txn_date >= $3::date AND tt.txn_date <= $4::date`,
    [ctx.tenantId, ctx.companyId, periodStart, periodEnd]
  );
  const base = round2(n(res.rows[0]?.base_amount));
  const tax = round2(n(res.rows[0]?.tax_amount));
  return {
    periodStart,
    periodEnd,
    outputVatBase: base,
    outputVat: tax,
    inputVatBase: 0,
    inputVat: 0,
    netVatPayable: tax,
    breakdown: [{ docType: 'WHT', kind: 'WHT' as const, baseAmount: base, taxAmount: tax }],
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
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'f.tenant_id = $1 AND f.company_id = $2';
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
      WHERE f.id = $1 AND f.tenant_id = $2 AND f.company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
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

  const vat = filingType === 'WHT_RETURN'
    ? await computeWht(client, ctx, periodStart, periodEnd)
    : await computeVat(client, ctx, periodStart, periodEnd);
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
    `SELECT * FROM tax_filings WHERE id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Tax filing not found');
  return res.rows[0];
}
