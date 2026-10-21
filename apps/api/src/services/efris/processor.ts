/**
 * EFRIS background fiscalization worker (spec 79-92, 102-103).
 *
 * Claims due fiscal transactions through the SECURITY DEFINER bridge
 * (efris_claim_fiscal_batch) so it can run without an end-user session, then
 * processes each claimed transaction in its own transaction with app context
 * applied manually. FISCALIZED is ONLY ever written after the URA gateway
 * returns a confirmed FDN + verification code; anything short of that is
 * recorded in efris_integration_errors and retried with backoff (or marked
 * FAILED once the configured attempt budget is exhausted).
 */
import pg from 'pg';
import { pool } from '../../db.js';
import { toISODate } from '../../utils.js';
import { logAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { notifyRoleAdvanced } from '../communication.js';
import { resolveCredentials, notificationRoleCodes, type EfrisConfigurationRow } from './config.js';
import { buildSubmitPayload, type EfrisTaxpayerLite, type FiscalLine, type FiscalParty, type StockSource } from './builders.js';
import { submitFiscalDocument, extractFiscalIdentifiers, EfrisClientError, queryCreditNoteApplication, fetchCreditNoteDocument } from './client.js';
import { digFirst, isStockDocType, uraAdjustmentType } from './protocol.js';

/** Row returned by efris_claim_fiscal_batch(). */
export interface ClaimedFiscalTransaction {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
  taxpayer_id: number | null;
  config_id: number;
  config_code: string;
  fiscal_mode: 'TEST' | 'ACTIVE';
  base_url: string | null;
  token_url: string | null;
  auth_grant_type: string;
  client_id_ref: string | null;
  credentials_ref: string | null;
  timeout_seconds: number;
  max_attempts: number;
  retry_backoff_seconds: number;
  duplicate_window_seconds: number;
  doc_type: string;
  doc_ref_type: string;
  doc_ref_id: number;
  doc_ref_code: string;
  txn_date: string;
  currency: string;
  gross_amount: number;
  tax_amount: number;
  attempts: number;
  request_ref: string | null;
  request_payload: Record<string, unknown> | null;
}

interface WorkerRowMeta {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function applyWorkerContext(client: pg.PoolClient, row: WorkerRowMeta): Promise<void> {
  await client.query('SELECT set_app_context($1,$2,$3,$4)', [
    row.tenant_id,
    row.company_id,
    row.branch_id ?? null,
    null,
  ]);
  await client.query('SELECT set_config($1,$2,true)', ['app.correlation_id', `efris-${row.id}`]);
  await client.query('SELECT set_config($1,$2,true)', ['app.ip', '']);
  await client.query('SELECT set_config($1,$2,true)', ['app.user_agent', 'efris-worker']);
  await client.query('SELECT set_config($1,$2,true)', ['app.device', 'efris-worker']);
}

function errCode(err: unknown): string {
  if (err instanceof EfrisClientError) return err.code;
  if (err instanceof Error && (err as Error & { code?: string }).code) {
    return String((err as Error & { code?: string }).code);
  }
  return 'EFRIS_PROCESSING_ERROR';
}

function errPayload(err: unknown): unknown {
  return err instanceof EfrisClientError ? err.payload ?? null : null;
}

/** T110 credit notes are applied via a two-step application workflow. */
function isCreditNoteDocType(docType: string): boolean {
  const kind = (docType ?? '').trim().toUpperCase();
  return kind === 'CREDIT_NOTE' || kind === 'CREDIT';
}

/** Persist a failure outside the rolled-back processing transaction. */
async function recordFailure(row: ClaimedFiscalTransaction, err: unknown): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyWorkerContext(client, row);
    const message = errMsg(err).slice(0, 2000);
    const code = errCode(err);
    const payload = errPayload(err);
    const configRes = await client.query(
      `SELECT * FROM efris_configurations WHERE id = $1 AND tenant_id = $2`,
      [row.config_id, row.tenant_id]
    );
    const config = configRes.rows[0] as EfrisConfigurationRow | undefined;
    const maxAttempts = config ? Number(config.max_attempts) : Number(row.max_attempts);
    const backoff = config ? Number(config.retry_backoff_seconds) : Number(row.retry_backoff_seconds);
    const nonRetryable = err instanceof EfrisClientError ? !err.retryable : false;
    const stageConfig = err instanceof EfrisClientError && err.stage === 'config';
    const attempts = Number(row.attempts);
    const terminal = stageConfig || nonRetryable || attempts >= maxAttempts;
    const targetStatus = terminal ? 'FAILED' : 'RETRYING';
    const backoffSeconds = Math.min(Math.max(backoff, 5) * Math.max(attempts, 1), 3600);

    await client.query(
      `INSERT INTO efris_integration_errors
         (tenant_id, company_id, efris_transaction_id, taxpayer_id, config_id, stage,
          error_code, error_message, request_payload, response_payload, retry_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
      [
        row.tenant_id,
        row.company_id,
        row.id,
        row.taxpayer_id,
        row.config_id,
        err instanceof EfrisClientError ? err.stage : 'submit',
        code,
        message,
        JSON.stringify(row.request_payload ?? {}),
        JSON.stringify(payload ?? {}),
        attempts,
      ]
    );
    await client.query(
      `UPDATE efris_transactions
          SET status = $2, claimed_at = NULL, last_error = $3, error_code = $4,
              next_attempt_at = $5::timestamptz, updated_at = now()
        WHERE id = $1`,
      [row.id, targetStatus, message, code, terminal ? 'infinity' : new Date(Date.now() + backoffSeconds * 1000)]
    );
    await client.query(
      `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, request_payload, response_payload, error)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
      [
        row.tenant_id,
        row.id,
        targetStatus,
        JSON.stringify(row.request_payload ?? {}),
        JSON.stringify(payload ?? {}),
        message,
      ]
    );
    await logAudit(client, { tenantId: row.tenant_id, companyId: row.company_id, branchId: row.branch_id }, {
      action: terminal ? 'efris.fiscalization.failed' : 'efris.fiscalization.retrying',
      resource: 'efris_transactions',
      recordId: row.id,
      recordCode: row.doc_ref_code,
      metadata: { errorCode: code, error: message.slice(0, 500), attempts, terminal },
    });

    if (terminal && config && config.notify_on_failure) {
      try {
        await notifyRoleAdvanced(
          client,
          { tenantId: row.tenant_id, companyId: row.company_id },
          notificationRoleCodes(config).length ? notificationRoleCodes(config) : ['cfo', 'finance_manager', 'chief_accountant', 'tax_officer'],
          {
            type: 'efris.fiscalization_failed',
            title: 'EFRIS fiscalization failed',
            body: `${row.doc_ref_code} (${row.doc_type}) could not be fiscalized after ${attempts} attempt(s): ${code}`,
            link: '/finance/efris',
            entityType: 'EFRIS_TRANSACTION',
            entityId: row.id,
            severity: 'ERROR',
            priority: 'HIGH',
            data: { transactionId: row.id, docRefCode: row.doc_ref_code, errorCode: code },
          }
        );
      } catch (notifyErr) {
        console.error('[efris][worker] failure notification error', errMsg(notifyErr));
      }
    }
    await client.query('COMMIT');
  } catch (inner) {
    await client.query('ROLLBACK');
    console.error('[efris][worker] failure-logging error', errMsg(inner));
  } finally {
    client.release();
  }
}

interface FiscalSource {
  buyer: FiscalParty | null;
  lines: FiscalLine[];
  oriInvoiceNo: string | null;
  oriInvoiceId: string | null;
  remarks: string | null;
  reasonCode: string | null;
  reason: string | null;
  /** Present for stock doc types (T131); null otherwise. */
  stock: StockSource | null;
}

/** Original invoice's FDN (invoiceNo) and internal invoiceId, for a T110 credit note. */
async function originalInvoiceRef(
  client: pg.PoolClient,
  tenantId: number,
  invoiceId: number
): Promise<{ oriInvoiceNo: string | null; oriInvoiceId: string | null }> {
  if (!Number.isFinite(invoiceId) || invoiceId <= 0) return { oriInvoiceNo: null, oriInvoiceId: null };
  const res = await client.query(
    `SELECT d.fdn, d.response_payload
       FROM efris_documents d
       JOIN efris_transactions t ON t.id = d.efris_transaction_id
      WHERE t.tenant_id = $1
        AND t.doc_ref_type = 'customer_invoices'
        AND t.doc_ref_id = $2
        AND t.status = 'FISCALIZED'
        AND d.fdn IS NOT NULL
      ORDER BY d.id DESC
      LIMIT 1`,
    [tenantId, invoiceId]
  );
  const row = res.rows[0];
  const fdn = row?.fdn != null ? String(row.fdn).trim() : null;
  const invoiceIdRaw = digFirst(row?.response_payload ?? null, ['invoiceId']);
  const invoiceIdVal = typeof invoiceIdRaw === 'string' && invoiceIdRaw.trim() ? invoiceIdRaw.trim() : null;
  return { oriInvoiceNo: fdn || null, oriInvoiceId: invoiceIdVal };
}

/**
 * Map the ERP's credit-note reason_code to a URA T110 reason code. URA's option
 * list is fixed (101 return of products, 102 cancellation of the purchase, 103
 * wrongly-stated amount, 104 waive off, 105 others); the ERP enum maps onto it
 * without inventing any URA code.
 */
function uraCreditNoteReason(
  code: string | null | undefined,
  reason: string | null | undefined
): { reasonCode: string; reason: string } {
  const map: Record<string, string> = {
    RETURNED_GOODS: '101',
    DAMAGED_GOODS: '101',
    CANCELLATION: '102',
    PRICING_CORRECTION: '103',
    OVERBILLING: '103',
    QUANTITY_CORRECTION: '103',
    TAX_CORRECTION: '103',
    DISCOUNT: '104',
    OTHER: '105',
  };
  const reasonCode = map[(code ?? '').trim().toUpperCase()] ?? '102';
  const reasonText = reason && reason.trim() ? reason.trim() : '';
  return { reasonCode, reason: reasonText };
}

/** Buyer, lines and the original FDN for a credit or debit note. Missing rows fall back to the transaction totals. */
async function loadFiscalSource(client: pg.PoolClient, row: ClaimedFiscalTransaction): Promise<FiscalSource> {
  const empty: FiscalSource = { buyer: null, lines: [], oriInvoiceNo: null, oriInvoiceId: null, remarks: null, reasonCode: null, reason: null, stock: null };
  try {
    if (row.doc_ref_type === 'customer_invoices') {
      const inv = await client.query(
        `SELECT c.name AS customer_name, c.tin AS customer_tin, c.address AS customer_address,
                c.email AS customer_email, c.phone AS customer_phone, i.notes
           FROM customer_invoices i
           JOIN customers c ON c.id = i.customer_id
          WHERE i.id = $1 AND i.tenant_id = $2`,
        [row.doc_ref_id, row.tenant_id]
      );
      const items = await client.query(
        `SELECT ii.description, ii.quantity, ii.unit_price, ii.tax_percent, ii.line_total,
                p.code AS product_code,
                p.efris_goods_code, p.efris_unit_of_measure,
                p.efris_goods_category_id, p.efris_goods_category_name
           FROM invoice_items ii
           LEFT JOIN products p ON p.id = ii.product_id
          WHERE ii.invoice_id = $1
          ORDER BY ii.id`,
        [row.doc_ref_id]
      );
      const party = inv.rows[0] as Record<string, unknown> | undefined;
      return {
        buyer: party ? {
          legalName: party.customer_name != null ? String(party.customer_name) : null,
          tin: party.customer_tin != null ? String(party.customer_tin) : null,
          address: party.customer_address != null ? String(party.customer_address) : null,
          email: party.customer_email != null ? String(party.customer_email) : null,
          phone: party.customer_phone != null ? String(party.customer_phone) : null,
        } : null,
        lines: (items.rows as Array<Record<string, unknown>>).map((item) => {
          const taxPercent = Number(item.tax_percent ?? 0);
          return {
            // URA resolves goods by its registered goodsCode, not the ERP SKU, so
            // prefer the URA goods code and fall back to the product code.
            itemCode: item.efris_goods_code != null ? String(item.efris_goods_code)
              : (item.product_code != null ? String(item.product_code) : null),
            description: String(item.description ?? ''),
            quantity: Number(item.quantity ?? 0),
            unitPrice: Number(item.unit_price ?? 0),
            taxPercent,
            lineGross: Number(item.line_total ?? 0),
            unitOfMeasure: item.efris_unit_of_measure != null ? String(item.efris_unit_of_measure) : null,
            goodsCategoryId: item.efris_goods_category_id != null ? String(item.efris_goods_category_id) : null,
            goodsCategoryName: item.efris_goods_category_name != null ? String(item.efris_goods_category_name) : null,
            vatApplicableFlag: taxPercent > 0 ? '1' : '0',
          };
        }),
        oriInvoiceNo: null,
        oriInvoiceId: null,
        remarks: party?.notes != null ? String(party.notes) : null,
        reasonCode: null,
        reason: null,
        stock: null,
      };
    }
    if (row.doc_ref_type === 'credit_notes' || row.doc_ref_type === 'debit_notes') {
      const table = row.doc_ref_type === 'credit_notes' ? 'credit_notes' : 'debit_notes';
      const note = await client.query(
        `SELECT n.invoice_id, n.reason, n.reason_code, c.name AS customer_name, c.tin AS customer_tin,
                c.address AS customer_address, c.email AS customer_email, c.phone AS customer_phone
           FROM ${table} n
           JOIN customers c ON c.id = n.customer_id
          WHERE n.id = $1 AND n.tenant_id = $2`,
        [row.doc_ref_id, row.tenant_id]
      );
      const party = note.rows[0] as Record<string, unknown> | undefined;
      const invoiceId = party ? Number(party.invoice_id) : NaN;

      // A note carries the original invoice's registered good, not a synthetic
      // 'ITEM1' line (URA rejects a bare itemCode with 2122 "not configured with
      // URA"). Notes store only a single amount + tax, so map that total onto the
      // first original line's goods identity.
      const items = await client.query(
        `SELECT ii.description, ii.tax_percent,
                p.code AS product_code,
                p.efris_goods_code, p.efris_unit_of_measure,
                p.efris_goods_category_id, p.efris_goods_category_name
           FROM invoice_items ii
           LEFT JOIN products p ON p.id = ii.product_id
          WHERE ii.invoice_id = $1
          ORDER BY ii.id
          LIMIT 1`,
        [invoiceId]
      );
      const item = items.rows[0] as Record<string, unknown> | undefined;
      const taxPercent = item != null ? Number(item.tax_percent ?? 0)
        : (Number(row.tax_amount) > 0 ? 18 : 0);
      const lines: FiscalLine[] = item != null ? [{
        itemCode: item.efris_goods_code != null ? String(item.efris_goods_code)
          : (item.product_code != null ? String(item.product_code) : null),
        description: String(item.description ?? ''),
        quantity: 1,
        unitPrice: Number(row.gross_amount) || 0,
        taxPercent,
        lineGross: Number(row.gross_amount) || 0,
        unitOfMeasure: item.efris_unit_of_measure != null ? String(item.efris_unit_of_measure) : null,
        goodsCategoryId: item.efris_goods_category_id != null ? String(item.efris_goods_category_id) : null,
        goodsCategoryName: item.efris_goods_category_name != null ? String(item.efris_goods_category_name) : null,
        vatApplicableFlag: taxPercent > 0 ? '1' : '0',
      }] : [];

      // Only a credit note (T110 red invoice) references the original invoice via
      // oriInvoiceNo + oriInvoiceId. A debit note is a standalone positive invoice
      // and must not carry an original reference (URA would treat it as a reversal).
      const ref = row.doc_ref_type === 'credit_notes'
        ? await originalInvoiceRef(client, row.tenant_id, invoiceId)
        : { oriInvoiceNo: null, oriInvoiceId: null };
      const reason = row.doc_ref_type === 'credit_notes'
        ? uraCreditNoteReason(party?.reason_code != null ? String(party.reason_code) : null, party?.reason != null ? String(party.reason) : null)
        : { reasonCode: null, reason: null };

      return {
        buyer: party ? {
          legalName: party.customer_name != null ? String(party.customer_name) : null,
          tin: party.customer_tin != null ? String(party.customer_tin) : null,
          address: party.customer_address != null ? String(party.customer_address) : null,
          email: party.customer_email != null ? String(party.customer_email) : null,
          phone: party.customer_phone != null ? String(party.customer_phone) : null,
        } : null,
        lines,
        oriInvoiceNo: ref.oriInvoiceNo,
        oriInvoiceId: ref.oriInvoiceId,
        remarks: party?.reason != null ? String(party.reason) : null,
        reasonCode: reason.reasonCode,
        reason: reason.reason,
        stock: null,
      };
    }
    if (row.doc_ref_type === 'goods_receipts') {
      return await loadGoodsReceiptStockSource(client, row);
    }
    if (row.doc_ref_type === 'inventory_adjustments') {
      return await loadAdjustmentStockSource(client, row);
    }
    if (row.doc_ref_type === 'receipts') {
      return await loadReceiptFiscalSource(client, row);
    }
  } catch (err) {
    console.error('[efris][worker] source document lookup failed', err instanceof Error ? err.message : err);
  }
  return empty;
}

/** Stock-in source: a goods receipt (GRN) received from a supplier. */
async function loadGoodsReceiptStockSource(client: pg.PoolClient, row: ClaimedFiscalTransaction): Promise<FiscalSource> {
  const base: FiscalSource = { buyer: null, lines: [], oriInvoiceNo: null, oriInvoiceId: null, remarks: null, reasonCode: null, reason: null, stock: null };
  const grn = await client.query(
    `SELECT g.grn_no, g.received_at, g.branch_id, s.name AS supplier_name, s.tin AS supplier_tin
       FROM goods_receipts g
       JOIN suppliers s ON s.id = g.supplier_id
      WHERE g.id = $1 AND g.tenant_id = $2`,
    [row.doc_ref_id, row.tenant_id]
  );
  const head = grn.rows[0] as Record<string, unknown> | undefined;
  if (!head) return base;
  const items = await client.query(
    `SELECT gi.quantity_received, gi.unit_cost,
            p.code AS product_code, p.efris_goods_code, p.efris_unit_of_measure
       FROM goods_receipt_items gi
       LEFT JOIN products p ON p.id = gi.product_id
      WHERE gi.grn_id = $1
      ORDER BY gi.id`,
    [row.doc_ref_id]
  );
  const lines = (items.rows as Array<Record<string, unknown>>)
    .filter((it) => String(it.efris_goods_code ?? it.product_code ?? '').trim())
    .map((it) => ({
      goodsCode: String(it.efris_goods_code ?? it.product_code),
      measureUnit: String(it.efris_unit_of_measure ?? ''),
      quantity: Number(it.quantity_received ?? 0),
      unitPrice: Number(it.unit_cost ?? 0),
      remarks: null as string | null,
    }));
  const received = toISODate(head.received_at) ?? toISODate(row.txn_date) ?? new Date().toISOString().slice(0, 10);
  base.stock = {
    operationType: '101',
    stockInType: '102',
    adjustType: '',
    supplierTin: head.supplier_tin != null ? String(head.supplier_tin) : null,
    supplierName: head.supplier_name != null ? String(head.supplier_name) : null,
    branchId: head.branch_id != null ? String(head.branch_id) : null,
    // The reference client leaves invoiceNo empty on a purchase receipt; the
    // supplier's e-invoice number is not carried until it is matched.
    invoiceNo: null,
    stockInDate: received,
    remarks: null,
    lines,
  };
  return base;
}

/** Stock-reconciliation source: an inventory adjustment's negative (loss) variance. */
async function loadAdjustmentStockSource(client: pg.PoolClient, row: ClaimedFiscalTransaction): Promise<FiscalSource> {
  const base: FiscalSource = { buyer: null, lines: [], oriInvoiceNo: null, oriInvoiceId: null, remarks: null, reasonCode: null, reason: null, stock: null };
  const adj = await client.query(
    `SELECT adjustment_no, adjustment_type, reason, branch_id, posted_at, updated_at
       FROM inventory_adjustments WHERE id = $1 AND tenant_id = $2`,
    [row.doc_ref_id, row.tenant_id]
  );
  const head = adj.rows[0] as Record<string, unknown> | undefined;
  if (!head) return base;
  const items = await client.query(
    `SELECT ai.variance_qty, ai.unit_cost,
            p.code AS product_code, p.efris_goods_code, p.efris_unit_of_measure
       FROM inventory_adjustment_items ai
       LEFT JOIN products p ON p.id = ai.product_id
      WHERE ai.adjustment_id = $1
      ORDER BY ai.id`,
    [row.doc_ref_id]
  );
  const lines: Array<{ goodsCode: string; measureUnit: string; quantity: number; unitPrice: number; remarks: string | null }> = [];
  for (const it of items.rows as Array<Record<string, unknown>>) {
    const variance = Number(it.variance_qty ?? 0);
    if (variance >= 0) continue; // URA only accepts negative (loss) adjustments via T131
    const goodsCode = String(it.efris_goods_code ?? it.product_code ?? '').trim();
    if (!goodsCode) continue;
    lines.push({
      goodsCode,
      measureUnit: String(it.efris_unit_of_measure ?? ''),
      quantity: Math.abs(Math.round(variance * 1000) / 1000),
      unitPrice: Number(it.unit_cost ?? 0),
      remarks: null,
    });
  }
  const effective = toISODate(head.posted_at ?? head.updated_at ?? row.txn_date) ?? new Date().toISOString().slice(0, 10);
  base.stock = {
    operationType: '102',
    stockInType: '',
    adjustType: uraAdjustmentType(head.adjustment_type != null ? String(head.adjustment_type) : null),
    supplierTin: null,
    supplierName: null,
    branchId: head.branch_id != null ? String(head.branch_id) : null,
    invoiceNo: null,
    stockInDate: effective,
    remarks: head.reason != null ? String(head.reason) : null,
    lines,
  };
  return base;
}

/** B2C e-receipt source: fiscalise a consumer payment as a tax invoice (buyerType 1). */
async function loadReceiptFiscalSource(client: pg.PoolClient, row: ClaimedFiscalTransaction): Promise<FiscalSource> {
  const base: FiscalSource = { buyer: null, lines: [], oriInvoiceNo: null, oriInvoiceId: null, remarks: null, reasonCode: null, reason: null, stock: null };
  const rcpt = await client.query(
    `SELECT r.invoice_id, c.name AS customer_name, c.tin AS customer_tin,
            c.address AS customer_address, c.email AS customer_email, c.phone AS customer_phone
       FROM receipts r
       JOIN customers c ON c.id = r.customer_id
      WHERE r.id = $1 AND r.tenant_id = $2`,
    [row.doc_ref_id, row.tenant_id]
  );
  const party = rcpt.rows[0] as Record<string, unknown> | undefined;
  if (!party) return base;
  const buyer: FiscalParty = {
    legalName: party.customer_name != null ? String(party.customer_name) : null,
    tin: party.customer_tin != null ? String(party.customer_tin) : null,
    address: party.customer_address != null ? String(party.customer_address) : null,
    email: party.customer_email != null ? String(party.customer_email) : null,
    phone: party.customer_phone != null ? String(party.customer_phone) : null,
  };
  let lines: FiscalLine[] = [];
  const invoiceId = Number(party.invoice_id);
  if (Number.isFinite(invoiceId) && invoiceId > 0) {
    const items = await client.query(
      `SELECT ii.description, ii.quantity, ii.unit_price, ii.tax_percent, ii.line_total,
              p.code AS product_code, p.efris_goods_code, p.efris_unit_of_measure,
              p.efris_goods_category_id, p.efris_goods_category_name
         FROM invoice_items ii
         LEFT JOIN products p ON p.id = ii.product_id
        WHERE ii.invoice_id = $1
        ORDER BY ii.id`,
      [invoiceId]
    );
    lines = (items.rows as Array<Record<string, unknown>>).map((item) => {
      const taxPercent = Number(item.tax_percent ?? 0);
      return {
        itemCode: item.efris_goods_code != null ? String(item.efris_goods_code)
          : (item.product_code != null ? String(item.product_code) : null),
        description: String(item.description ?? ''),
        quantity: Number(item.quantity ?? 0),
        unitPrice: Number(item.unit_price ?? 0),
        taxPercent,
        lineGross: Number(item.line_total ?? 0),
        unitOfMeasure: item.efris_unit_of_measure != null ? String(item.efris_unit_of_measure) : null,
        goodsCategoryId: item.efris_goods_category_id != null ? String(item.efris_goods_category_id) : null,
        goodsCategoryName: item.efris_goods_category_name != null ? String(item.efris_goods_category_name) : null,
        vatApplicableFlag: taxPercent > 0 ? '1' : '0',
      };
    });
  }
  return { ...base, buyer, lines };
}

/** Run one claimed transaction through submission inside its own transaction. */
async function processFiscalRow(row: ClaimedFiscalTransaction): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyWorkerContext(client, row);

    const configRes = await client.query(
      `SELECT * FROM efris_configurations WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
      [row.config_id, row.tenant_id]
    );
    const config = configRes.rows[0] as EfrisConfigurationRow | undefined;
    if (!config) {
      throw new EfrisClientError({
        code: 'EFRIS_CONFIG_INACTIVE',
        stage: 'config',
        message: 'EFRIS configuration is no longer active for this taxpayer',
        retryable: false,
      });
    }
    const creds = resolveCredentials(config);

    let taxpayer: EfrisTaxpayerLite | null = null;
    if (row.taxpayer_id != null) {
      const tp = await client.query(
        `SELECT id, legal_name, trading_name, tin, vat_registered, vat_number, taxpayer_type,
                business_sector, place_of_business, branch_id, address, contact_email, contact_phone
           FROM efris_taxpayers WHERE id = $1 AND tenant_id = $2`,
        [row.taxpayer_id, row.tenant_id]
      );
      taxpayer = tp.rows[0] ?? null;
    }

    const source = await loadFiscalSource(client, row);
    const built = buildSubmitPayload({
      docType: row.doc_type,
      docRefType: row.doc_ref_type,
      docRefCode: row.doc_ref_code,
      docRefId: row.doc_ref_id,
      txnDate: toISODate(row.txn_date) ?? new Date().toISOString().slice(0, 10),
      currency: row.currency,
      grossAmount: Number(row.gross_amount),
      taxAmount: Number(row.tax_amount),
      requestRef: row.request_ref,
      taxpayer,
      config,
      buyer: source.buyer,
      lines: source.lines,
      oriInvoiceNo: source.oriInvoiceNo,
      oriInvoiceId: source.oriInvoiceId,
      remarks: source.remarks,
      reasonCode: source.reasonCode,
      reason: source.reason,
      stock: source.stock,
    });
    const stored = row.request_payload && Object.keys(row.request_payload).length > 0 ? row.request_payload : null;
    const storedIsUra = Boolean(stored && (stored.goodsDetails || stored.sellerDetails || stored.goodsStockIn));

    const raw = await submitFiscalDocument({
      mode: config.mode,
      baseUrl: config.base_url ?? '',
      tokenUrl: config.token_url,
      grantType: config.auth_grant_type || 'client_credentials',
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      timeoutSeconds: Number(config.timeout_seconds || 20),
      payload: stored && !storedIsUra ? stored : built.payload,
      uraPayload: storedIsUra && stored ? stored : built.ura,
      docType: row.doc_type,
      tin: taxpayer?.tin ?? null,
      securityFlags: config.security_flags,
    });

    // A T110 credit note is an application: URA returns a referenceNo, not an FDN.
    // Record it as TRANSMITTED (awaiting URA approval) and let the polling worker
    // apply the red-invoice FDN once URA approves it.
    if (isCreditNoteDocType(row.doc_type)) {
      const referenceNoRaw = digFirst(raw, ['referenceNo', 'reference_no', 'applicationReferenceNo', 'applicationRefNo']);
      const referenceNo = typeof referenceNoRaw === 'string' && referenceNoRaw.trim() ? referenceNoRaw.trim() : null;
      if (!referenceNo) {
        throw new EfrisClientError({
          code: 'EFRIS_RESPONSE_INVALID',
          stage: 'response',
          message: 'URA accepted the credit note application but returned no referenceNo',
          payload: raw,
          retryable: false,
        });
      }
      await client.query(
        `UPDATE efris_transactions
            SET status = 'TRANSMITTED', claimed_at = NULL, next_attempt_at = NULL,
                transmitted_at = now(), last_error = NULL, error_code = NULL,
                request_payload = $2::jsonb, last_response = $3::jsonb,
                application_ref_no = $4, application_status = '102', updated_at = now()
          WHERE id = $1`,
        [row.id, JSON.stringify(built.payload ?? {}), JSON.stringify(raw ?? {}), referenceNo]
      );
      await client.query(
        `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, request_payload, response_payload)
         VALUES ($1,$2,'TRANSMITTED',$3::jsonb,$4::jsonb)`,
        [row.tenant_id, row.id, JSON.stringify(built.payload ?? {}), JSON.stringify(raw ?? {})]
      );
      await logAudit(client, { tenantId: row.tenant_id, companyId: row.company_id, branchId: row.branch_id }, {
        action: 'efris.fiscalization.submitted',
        resource: 'efris_transactions',
        recordId: row.id,
        recordCode: row.doc_ref_code,
        metadata: { referenceNo, docType: row.doc_type },
      });
      await client.query('COMMIT');
      return true;
    }

    // T131 stock movement returns a stock acknowledgement (returnCode 00), not a
    // fiscal document (FDN). Record it ACCEPTED once URA acknowledges the stock —
    // no efris_documents row, since there is no FDN to persist.
    if (isStockDocType(row.doc_type)) {
      await client.query(
        `UPDATE efris_transactions
            SET status = 'ACCEPTED', claimed_at = NULL, next_attempt_at = NULL,
                transmitted_at = now(), accepted_at = now(), last_error = NULL,
                error_code = NULL, request_payload = $2::jsonb, last_response = $3::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [row.id, JSON.stringify(built.payload ?? {}), JSON.stringify(raw ?? {})]
      );
      await client.query(
        `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, request_payload, response_payload)
         VALUES ($1,$2,'ACCEPTED',$3::jsonb,$4::jsonb)`,
        [row.tenant_id, row.id, JSON.stringify(built.payload ?? {}), JSON.stringify(raw ?? {})]
      );
      await logAudit(client, { tenantId: row.tenant_id, companyId: row.company_id, branchId: row.branch_id }, {
        action: 'efris.fiscalization.accepted',
        resource: 'efris_transactions',
        recordId: row.id,
        recordCode: row.doc_ref_code,
        metadata: { docType: row.doc_type, docRefType: row.doc_ref_type },
      });
      await client.query('COMMIT');
      return true;
    }

    const identifiers = extractFiscalIdentifiers(raw);
    if (!identifiers) {
      throw new EfrisClientError({
        code: 'EFRIS_RESPONSE_INVALID',
        stage: 'response',
        message: 'URA response did not include a confirmed FDN + verification code',
        payload: raw,
        retryable: false,
      });
    }
    const responsePayload = raw as Record<string, unknown>;

    await client.query(
      `INSERT INTO efris_documents
         (tenant_id, efris_transaction_id, erp_doc_no, fdn, verification_code, qr_ref,
          response_payload, transmitted_at, fiscalized_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now(),now())
       ON CONFLICT (efris_transaction_id) DO UPDATE
         SET fdn = EXCLUDED.fdn, verification_code = EXCLUDED.verification_code,
             qr_ref = EXCLUDED.qr_ref, response_payload = EXCLUDED.response_payload,
             transmitted_at = now(), fiscalized_at = now()`,
      [
        row.tenant_id,
        row.id,
        row.doc_ref_code,
        identifiers.fdn,
        identifiers.vrc,
        identifiers.qrRef ?? null,
        JSON.stringify(responsePayload ?? {}),
      ]
    );
    await client.query(
      `UPDATE efris_transactions
          SET status = 'FISCALIZED', claimed_at = NULL, next_attempt_at = NULL,
              transmitted_at = now(), fiscalized_at = now(), last_error = NULL,
              error_code = NULL, request_payload = $2::jsonb, last_response = $3::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [row.id, JSON.stringify(built.payload ?? {}), JSON.stringify(responsePayload ?? {})]
    );
    await client.query(
      `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, request_payload, response_payload)
       VALUES ($1,$2,'FISCALIZED',$3::jsonb,$4::jsonb)`,
      [
        row.tenant_id,
        row.id,
        JSON.stringify(built.payload ?? {}),
        JSON.stringify(responsePayload ?? {}),
      ]
    );
    await logAudit(client, { tenantId: row.tenant_id, companyId: row.company_id, branchId: row.branch_id }, {
      action: 'efris.fiscalization.fiscalized',
      resource: 'efris_transactions',
      recordId: row.id,
      recordCode: row.doc_ref_code,
      metadata: { fdn: identifiers.fdn, verificationCode: identifiers.vrc, qrRef: identifiers.qrRef ?? null },
    });
    await emitEvent(client, { tenantId: row.tenant_id, companyId: row.company_id, branchId: row.branch_id }, {
      eventType: 'efris.fiscalized',
      entityType: 'EFRIS_TRANSACTION',
      entityId: row.id,
      entityCode: row.doc_ref_code,
      payload: { status: 'FISCALIZED', fdn: identifiers.fdn, vrc: identifiers.vrc },
    });

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    await recordFailure(row, err);
    return false;
  } finally {
    client.release();
  }
}

let draining = false;

/** Claim and process a batch of due fiscal transactions. Single-flight safe. */
export async function drainEfrisQueue(batch = 10): Promise<{ claimed: number; processed: number; failed: number }> {
  if (draining) return { claimed: 0, processed: 0, failed: 0 };
  draining = true;
  try {
    const res = await pool.query('SELECT * FROM efris_claim_fiscal_batch($1, 300)', [batch]);
    const rows = res.rows as unknown as ClaimedFiscalTransaction[];
    let processed = 0;
    let failed = 0;
    for (const row of rows) {
      const ok = await processFiscalRow(row);
      if (ok) processed += 1;
      else failed += 1;
    }
    return { claimed: rows.length, processed, failed };
  } finally {
    draining = false;
  }
}

/** Single tick used by the API scheduler (idempotent, never throws). */
export async function runEfrisWorkerTick(): Promise<void> {
  try {
    await drainEfrisQueue(10);
  } catch (err) {
    console.error('[efris][worker]', err instanceof Error ? err.message : err);
  }
}

interface PendingCreditNoteApp {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
  taxpayer_id: number | null;
  config_id: number;
  doc_ref_code: string;
  application_ref_no: string;
}

/**
 * Poll submitted (TRANSMITTED) T110 credit-note applications for URA approval
 * and apply the red-invoice FDN when URA approves them. Pending applications
 * stay TRANSMITTED; rejected ones are marked REJECTED. Never throws.
 */
export async function pollCreditNoteApplications(batch = 10): Promise<{ polled: number; approved: number; pending: number; rejected: number }> {
  const res = await pool.query(
    `SELECT t.id, t.tenant_id, t.company_id, t.branch_id, t.taxpayer_id, c.id AS config_id,
            t.doc_ref_code, t.application_ref_no
       FROM efris_transactions t
       JOIN efris_configurations c
         ON c.id = (
              SELECT c2.id FROM efris_configurations c2
               WHERE c2.taxpayer_id = t.taxpayer_id
                 AND c2.is_active = true
                 AND c2.mode IN ('TEST','ACTIVE')
               ORDER BY c2.id DESC
               LIMIT 1
            )
      WHERE t.status = 'TRANSMITTED'
        AND t.doc_type IN ('CREDIT_NOTE','CREDIT')
        AND t.application_ref_no IS NOT NULL
      ORDER BY t.id
      LIMIT $1`,
    [batch]
  );
  const rows = res.rows as unknown as PendingCreditNoteApp[];
  let approved = 0;
  let pending = 0;
  let rejected = 0;
  for (const row of rows) {
    const client = await pool.connect();
    try {
      await applyWorkerContext(client, { id: row.id, tenant_id: row.tenant_id, company_id: row.company_id, branch_id: row.branch_id });
      const configRes = await client.query(
        `SELECT * FROM efris_configurations WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
        [row.config_id, row.tenant_id]
      );
      const config = configRes.rows[0] as EfrisConfigurationRow | undefined;
      if (!config) continue;
      const creds = resolveCredentials(config);
      let tin: string | null = null;
      if (row.taxpayer_id != null) {
        const tp = await client.query(`SELECT tin FROM efris_taxpayers WHERE id = $1 AND tenant_id = $2`, [row.taxpayer_id, row.tenant_id]);
        tin = tp.rows[0]?.tin != null ? String(tp.rows[0].tin) : null;
      }
      const opts = {
        mode: config.mode,
        baseUrl: config.base_url ?? '',
        tokenUrl: config.token_url,
        grantType: config.auth_grant_type || 'client_credentials',
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        timeoutSeconds: Number(config.timeout_seconds || 20),
        payload: {} as Record<string, unknown>,
        docType: 'CREDIT_NOTE',
        tin,
        securityFlags: config.security_flags,
      };
      const q = await queryCreditNoteApplication(opts, row.application_ref_no);
      const approveStatus = String(digFirst(q, ['approveStatus']) ?? '102');
      if (approveStatus === '103') {
        await client.query(
          `UPDATE efris_transactions
              SET status = 'REJECTED', application_status = '103', claimed_at = NULL, next_attempt_at = NULL, updated_at = now()
            WHERE id = $1`,
          [row.id]
        );
        await client.query(
          `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, response_payload)
           VALUES ($1,$2,'REJECTED',$3::jsonb)`,
          [row.tenant_id, row.id, JSON.stringify(q ?? {})]
        );
        rejected += 1;
        continue;
      }
      if (approveStatus !== '101') {
        pending += 1;
        continue;
      }
      const invoiceNoRaw = digFirst(q, ['invoiceNo']);
      const invoiceNo = typeof invoiceNoRaw === 'string' && invoiceNoRaw.trim() ? invoiceNoRaw.trim() : null;
      if (!invoiceNo) {
        pending += 1;
        continue;
      }
      const doc = await fetchCreditNoteDocument(opts, invoiceNo);
      const identifiers = extractFiscalIdentifiers(doc);
      if (!identifiers) {
        pending += 1;
        continue;
      }
      await client.query(
        `INSERT INTO efris_documents
           (tenant_id, efris_transaction_id, erp_doc_no, fdn, verification_code, qr_ref, response_payload, transmitted_at, fiscalized_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now(),now())
         ON CONFLICT (efris_transaction_id) DO UPDATE
           SET fdn = EXCLUDED.fdn, verification_code = EXCLUDED.verification_code,
               qr_ref = EXCLUDED.qr_ref, response_payload = EXCLUDED.response_payload,
               fiscalized_at = now()`,
        [row.tenant_id, row.id, row.doc_ref_code, identifiers.fdn, identifiers.vrc, identifiers.qrRef ?? null, JSON.stringify(doc ?? {})]
      );
      await client.query(
        `UPDATE efris_transactions
            SET status = 'FISCALIZED', application_status = '101', claimed_at = NULL,
                next_attempt_at = NULL, fiscalized_at = now(), last_error = NULL,
                error_code = NULL, last_response = $2::jsonb, updated_at = now()
          WHERE id = $1`,
        [row.id, JSON.stringify(doc ?? {})]
      );
      await client.query(
        `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, response_payload)
         VALUES ($1,$2,'FISCALIZED',$3::jsonb)`,
        [row.tenant_id, row.id, JSON.stringify(doc ?? {})]
      );
      await logAudit(client, { tenantId: row.tenant_id, companyId: row.company_id, branchId: row.branch_id }, {
        action: 'efris.fiscalization.fiscalized',
        resource: 'efris_transactions',
        recordId: row.id,
        recordCode: row.doc_ref_code,
        metadata: { fdn: identifiers.fdn, verificationCode: identifiers.vrc, qrRef: identifiers.qrRef ?? null },
      });
      approved += 1;
    } catch (err) {
      console.error('[efris][credit-note-poll]', err instanceof Error ? err.message : err);
    } finally {
      client.release();
    }
  }
  return { polled: rows.length, approved, pending, rejected };
}

/** Single tick for the credit-note approval poller (idempotent, never throws). */
export async function runEfrisCreditNotePollTick(): Promise<void> {
  try {
    await pollCreditNoteApplications(10);
  } catch (err) {
    console.error('[efris][credit-note-poll]', err instanceof Error ? err.message : err);
  }
}
