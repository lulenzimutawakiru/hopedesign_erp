/**
 * EFRIS reporting (GAP-5).
 *
 * Section 14 of the mandate lists reports the integration must produce. These
 * queries read the fiscal records the worker has already persisted — every
 * number comes from a URA-confirmed outcome (status FISCALIZED / ACCEPTED), never
 * from a submission attempt that has not yet been acknowledged.
 *
 * Honesty note: the per-line URA taxCategoryCode (01/02/…) is only materialised
 * at build time inside the submission payload; the persisted `efris_transactions`
 * row carries the document totals. The tax-category splits below are therefore
 * TRANSACTION-level ("taxable" vs "zero-rated" by tax amount), not a claim about
 * each line's URA code. Exempt supplies are not separately identifiable here
 * until the GAP-2 tax-category model is configured.
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { toCamelRows } from '../../utils.js';

const SALES_DOC_TYPES = ['SALES_INVOICE', 'DEBIT_NOTE', 'RECEIPT'];

interface DateWindow {
  from: string;
  to: string;
}

function windowOf(from?: string | null, to?: string | null): DateWindow {
  const now = new Date();
  const toDate = /^\d{4}-\d{2}-\d{2}$/.test(to ?? '') ? (to as string) : now.toISOString().slice(0, 10);
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '')
    ? (from as string)
    : new Date(now.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  return { from: fromDate, to: toDate };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Daily fiscalised sales. One row per day for every sales-side document URA
 * confirmed (FISCALIZED), with the count of FDNs actually issued.
 */
export async function dailyFiscalizedSales(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { from?: string | null; to?: string | null } = {}
) {
  const win = windowOf(opts.from, opts.to);
  const params: unknown[] = [ctx.tenantId, ctx.companyId, win.from, win.to];
  const rows = await client.query(
    `SELECT t.txn_date,
            COUNT(*)::int AS doc_count,
            COUNT(d.fdn)::int AS with_fdn,
            COALESCE(SUM(t.gross_amount), 0) AS gross_total,
            COALESCE(SUM(t.tax_amount), 0) AS tax_total
       FROM efris_transactions t
       LEFT JOIN efris_documents d ON d.efris_transaction_id = t.id
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.status = 'FISCALIZED'
        AND t.doc_type = ANY($5::text[])
        AND t.txn_date >= $3::date AND t.txn_date <= $4::date
      GROUP BY t.txn_date
      ORDER BY t.txn_date`,
    [ctx.tenantId, ctx.companyId, win.from, win.to, SALES_DOC_TYPES]
  );
  const totals = await client.query(
    `SELECT COUNT(*)::int AS doc_count,
            COALESCE(SUM(t.gross_amount), 0) AS gross_total,
            COALESCE(SUM(t.tax_amount), 0) AS tax_total
       FROM efris_transactions t
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.status = 'FISCALIZED'
        AND t.doc_type = ANY($5::text[])
        AND t.txn_date >= $3::date AND t.txn_date <= $4::date`,
    [ctx.tenantId, ctx.companyId, win.from, win.to, SALES_DOC_TYPES]
  );
  return {
    range: win,
    generatedAt: new Date().toISOString(),
    days: toCamelRows(rows.rows),
    totals: toCamelRows(totals.rows)[0] ?? { docCount: 0, grossTotal: 0, taxTotal: 0 },
    scope: { transactionLevel: true, docTypes: SALES_DOC_TYPES },
  };
}

/**
 * Fiscalised sales by tax category, transaction level. A document with tax is
 * "taxable" (standard); a document with no tax is "zero-rated". Exempt supplies
 * are not distinguishable here until the GAP-2 model is configured.
 */
export async function salesByTaxCategory(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { from?: string | null; to?: string | null } = {}
) {
  const win = windowOf(opts.from, opts.to);
  const rows = await client.query(
    `SELECT CASE WHEN t.tax_amount > 0 THEN 'TAXABLE' ELSE 'ZERO_RATED' END AS category,
            COUNT(*)::int AS doc_count,
            COALESCE(SUM(t.gross_amount), 0) AS gross_total,
            COALESCE(SUM(t.tax_amount), 0) AS tax_total
       FROM efris_transactions t
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.status = 'FISCALIZED'
        AND t.doc_type = ANY($3::text[])
        AND t.txn_date >= $4::date AND t.txn_date <= $5::date
      GROUP BY 1
      ORDER BY 1`,
    [ctx.tenantId, ctx.companyId, SALES_DOC_TYPES, win.from, win.to]
  );
  return {
    range: win,
    generatedAt: new Date().toISOString(),
    categories: toCamelRows(rows.rows),
    note: 'Transaction-level split (taxable = tax_amount > 0, zero-rated = tax_amount = 0). Per-line URA taxCategoryCode lives only in the submission payload and is not persisted.',
  };
}

/**
 * Zero-rated supplies in the window: confirmed sales documents with no VAT.
 * This is the zero-rated slice only — exempt supplies need the GAP-2 model.
 */
export async function zeroRatedSupplies(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { from?: string | null; to?: string | null } = {}
) {
  const win = windowOf(opts.from, opts.to);
  const rows = await client.query(
    `SELECT t.id, t.doc_ref_code, t.doc_ref_type, t.txn_date, t.currency,
            t.gross_amount, t.tax_amount, d.fdn, d.verification_code, t.fiscalized_at
       FROM efris_transactions t
       LEFT JOIN efris_documents d ON d.efris_transaction_id = t.id
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.status = 'FISCALIZED'
        AND t.doc_type = ANY($3::text[])
        AND t.tax_amount = 0
        AND t.txn_date >= $4::date AND t.txn_date <= $5::date
      ORDER BY t.txn_date DESC, t.id DESC`,
    [ctx.tenantId, ctx.companyId, SALES_DOC_TYPES, win.from, win.to]
  );
  const totals = await client.query(
    `SELECT COUNT(*)::int AS doc_count,
            COALESCE(SUM(t.gross_amount), 0) AS gross_total
       FROM efris_transactions t
      WHERE t.tenant_id = $1 AND t.company_id = $2
        AND t.status = 'FISCALIZED'
        AND t.doc_type = ANY($3::text[])
        AND t.tax_amount = 0
        AND t.txn_date >= $4::date AND t.txn_date <= $5::date`,
    [ctx.tenantId, ctx.companyId, SALES_DOC_TYPES, win.from, win.to]
  );
  return {
    range: win,
    generatedAt: new Date().toISOString(),
    items: toCamelRows(rows.rows),
    totals: toCamelRows(totals.rows)[0] ?? { docCount: 0, grossTotal: 0 },
    note: 'Zero-rated supplies only. Exempt supplies are not modelled until security_flags.taxCategories.exempt is configured.',
  };
}

/**
 * Daily ERP vs EFRIS reconciliation. Joins each day's non-voided customer
 * invoices against what URA actually fiscalised for that day and surfaces the
 * variance rather than smoothing it over.
 */
export async function dailyReconciliation(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { from?: string | null; to?: string | null } = {}
) {
  const win = windowOf(opts.from, opts.to);
  const erp = await client.query(
    `SELECT invoice_date AS day,
            COUNT(*)::int AS invoice_count,
            COALESCE(SUM(total), 0) AS sales_total,
            COALESCE(SUM(tax_amount), 0) AS tax_total
       FROM customer_invoices
      WHERE tenant_id = $1 AND company_id = $2
        AND status <> 'VOID'
        AND invoice_date >= $3::date AND invoice_date <= $4::date
      GROUP BY invoice_date`,
    [ctx.tenantId, ctx.companyId, win.from, win.to]
  );
  const efris = await client.query(
    `SELECT txn_date AS day,
            COUNT(*)::int AS fiscalized_count,
            COALESCE(SUM(gross_amount), 0) AS sales_total,
            COALESCE(SUM(tax_amount), 0) AS tax_total
       FROM efris_transactions
      WHERE tenant_id = $1 AND company_id = $2
        AND status = 'FISCALIZED'
        AND doc_ref_type = 'customer_invoices'
        AND txn_date >= $3::date AND txn_date <= $4::date
      GROUP BY txn_date`,
    [ctx.tenantId, ctx.companyId, win.from, win.to]
  );

  const erpByDay = new Map<string, { invoiceCount: number; salesTotal: number; taxTotal: number }>();
  for (const r of erp.rows as Array<Record<string, unknown>>) {
    const day = String(r.day).slice(0, 10);
    erpByDay.set(day, {
      invoiceCount: Number(r.invoice_count ?? 0),
      salesTotal: Number(r.sales_total ?? 0),
      taxTotal: Number(r.tax_total ?? 0),
    });
  }
  const efrisByDay = new Map<string, { fiscalizedCount: number; salesTotal: number; taxTotal: number }>();
  for (const r of efris.rows as Array<Record<string, unknown>>) {
    const day = String(r.day).slice(0, 10);
    efrisByDay.set(day, {
      fiscalizedCount: Number(r.fiscalized_count ?? 0),
      salesTotal: Number(r.sales_total ?? 0),
      taxTotal: Number(r.tax_total ?? 0),
    });
  }

  const days = [...new Set([...erpByDay.keys(), ...efrisByDay.keys()])].sort();
  const rows = days.map((day) => {
    const e = erpByDay.get(day);
    const f = efrisByDay.get(day);
    const salesVariance = round2((e?.salesTotal ?? 0) - (f?.salesTotal ?? 0));
    const taxVariance = round2((e?.taxTotal ?? 0) - (f?.taxTotal ?? 0));
    return {
      day,
      erp: e ?? { invoiceCount: 0, salesTotal: 0, taxTotal: 0 },
      efris: f ?? { fiscalizedCount: 0, salesTotal: 0, taxTotal: 0 },
      variance: { sales: salesVariance, tax: taxVariance },
      balanced: salesVariance === 0 && taxVariance === 0,
    };
  });

  return {
    range: win,
    generatedAt: new Date().toISOString(),
    days: rows,
    totals: {
      salesVariance: round2(rows.reduce((s, r) => s + r.variance.sales, 0)),
      taxVariance: round2(rows.reduce((s, r) => s + r.variance.tax, 0)),
    },
  };
}

/**
 * Product-registration status report: how the catalogue maps onto URA goods and
 * where each product sits in the registration lifecycle.
 */
export async function productRegistrationReport(client: pg.PoolClient, ctx: Ctx) {
  const rows = await client.query(
    `SELECT efris_registration_status AS status,
            COUNT(*)::int AS product_count
       FROM products
      WHERE tenant_id = $1 AND company_id = $2
      GROUP BY efris_registration_status
      ORDER BY efris_registration_status`,
    [ctx.tenantId, ctx.companyId]
  );
  const unregistered = await client.query(
    `SELECT p.id, p.code, p.name, p.efris_goods_code, p.efris_registration_status
       FROM products p
      WHERE p.tenant_id = $1 AND p.company_id = $2
        AND p.efris_registration_status <> 'REGISTERED'
      ORDER BY p.efris_registration_status, p.code`,
    [ctx.tenantId, ctx.companyId]
  );
  return {
    generatedAt: new Date().toISOString(),
    byStatus: toCamelRows(rows.rows),
    notRegistered: toCamelRows(unregistered.rows),
  };
}

/**
 * Integration-health summary: aggregates the scheduled health checks so the
 * operator sees, per configuration, how many probes passed/failed and when the
 * latest check ran. Offline-enabler configs (TCS-owned key) are recorded
 * `ok = NULL` and reported as "manual verification".
 */
export async function integrationHealthReport(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { configId?: number | null } = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let cfg = '';
  if (opts.configId != null && Number.isFinite(Number(opts.configId))) {
    params.push(Math.trunc(Number(opts.configId)));
    cfg = `AND h.config_id = $${params.length}`;
  }
  const rows = await client.query(
    `SELECT h.config_id, c.code AS config_code, c.name AS config_name, h.mode, h.protocol,
            COUNT(*)::int AS check_count,
            COUNT(*) FILTER (WHERE h.ok = true)::int AS ok_count,
            COUNT(*) FILTER (WHERE h.ok = false)::int AS fail_count,
            COUNT(*) FILTER (WHERE h.ok IS NULL)::int AS manual_count,
            MAX(h.checked_at) AS last_checked_at,
            MAX(h.return_code) FILTER (WHERE h.ok = false) AS last_failure_code
       FROM efris_health_checks h
       LEFT JOIN efris_configurations c ON c.id = h.config_id
      WHERE h.tenant_id = $1 AND h.company_id = $2 ${cfg}
      GROUP BY h.config_id, c.code, c.name, h.mode, h.protocol
      ORDER BY c.code`,
    params
  );
  return {
    generatedAt: new Date().toISOString(),
    configurations: toCamelRows(rows.rows),
    note: 'ok_count = passing probes, fail_count = failing probes, manual_count = offline-enabler configs (TCS-owned key, verify the device locally).',
  };
}
