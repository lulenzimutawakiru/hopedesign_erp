import pg from 'pg';
import { Ctx } from '../../db.js';
import { toCamelRows } from '../../utils.js';

/**
 * EFRIS stock-movement report (T131).
 *
 * Lists every stock movement the ERP has registered with URA — goods receipts
 * (stock-in, operationType 101) and negative inventory adjustments (stock
 * reconciliation) — together with the fiscal status URA actually returned.
 * T131 returns a stock acknowledgement, not an FDN, so a successfully accepted
 * movement carries an acknowledgement-backed ACCEPTED status and no FDN; FDN
 * fields are joined from efris_documents and only ever populated by the worker
 * from a confirmed URA response.
 */
const STOCK_DOC_REF_TYPES = ['goods_receipts', 'inventory_adjustments'];

export async function stockMovementReport(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { from?: string | null; to?: string | null; status?: string | null } = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId, STOCK_DOC_REF_TYPES];
  let where = `t.tenant_id = $1 AND t.company_id = $2 AND t.doc_ref_type = ANY($3::text[])`;
  if (opts.from) { params.push(opts.from); where += ` AND t.txn_date >= $${params.length}::date`; }
  if (opts.to) { params.push(opts.to); where += ` AND t.txn_date <= $${params.length}::date`; }
  if (opts.status) { params.push(opts.status); where += ` AND t.status = $${params.length}`; }

  const rows = await client.query(
    `SELECT t.id, t.doc_type, t.doc_ref_type, t.doc_ref_id, t.doc_ref_code, t.txn_date,
            t.currency, t.gross_amount, t.tax_amount, t.status, t.request_ref, t.created_at,
            d.fdn, d.verification_code, d.qr_ref, d.fiscalized_at,
            CASE t.doc_ref_type
              WHEN 'goods_receipts' THEN gr.grn_no
              WHEN 'inventory_adjustments' THEN ia.adjustment_no
            END AS source_no,
            CASE t.doc_ref_type
              WHEN 'goods_receipts' THEN gr.received_at
              WHEN 'inventory_adjustments' THEN ia.posted_at
            END AS source_date,
            CASE t.doc_ref_type
              WHEN 'goods_receipts' THEN 'STOCK_IN'
              WHEN 'inventory_adjustments' THEN COALESCE(ia.adjustment_type, 'ADJUSTMENT')
            END AS movement_kind,
            CASE WHEN t.doc_ref_type = 'goods_receipts' THEN s.name END AS counterparty,
            CASE WHEN t.doc_ref_type = 'goods_receipts' THEN s.tin END AS counterparty_tin
       FROM efris_transactions t
       LEFT JOIN efris_documents d ON d.efris_transaction_id = t.id
       LEFT JOIN goods_receipts gr
              ON t.doc_ref_type = 'goods_receipts' AND gr.id = t.doc_ref_id AND gr.tenant_id = t.tenant_id
       LEFT JOIN suppliers s ON s.id = gr.supplier_id
       LEFT JOIN inventory_adjustments ia
              ON t.doc_ref_type = 'inventory_adjustments' AND ia.id = t.doc_ref_id AND ia.tenant_id = t.tenant_id
      WHERE ${where}
      ORDER BY t.txn_date DESC, t.id DESC`,
    params
  );

  const summary = await client.query(
    `SELECT t.status, COUNT(*)::int AS count,
            COALESCE(SUM(t.gross_amount), 0) AS gross_total,
            COALESCE(SUM(t.tax_amount), 0) AS tax_total
       FROM efris_transactions t
      WHERE ${where}
      GROUP BY t.status
      ORDER BY t.status`,
    params
  );

  return {
    items: toCamelRows(rows.rows),
    summary: toCamelRows(summary.rows),
  };
}
