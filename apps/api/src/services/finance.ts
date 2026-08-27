import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';

export interface JournalLine {
  account_id: number;
  debit?: number;
  credit?: number;
  cost_centre_id?: number | null;
  profit_centre_id?: number | null;
  description?: string;
}

const COA = {
  AR: '1400',
  AP: '2100',
  VAT: '2110',
  REVENUE: '4000',
  RAW_INV: '1310',
  FG_INV: '1320',
  WIP: '1330',
  COGS: '5000',
  DIRECT_PROD: '5100',
  ADMIN_EXP: '6100',
  DEFAULT_BANK: '1100',
  ACCRUAL: '2210',
  PAYE: '2120',
  OTHER_RECV: '1510',
} as const;

/** Map a product to its inventory GL account by product type. */
export function inventoryAccountForType(type: string | null | undefined): string {
  switch (type) {
    case 'JUMBO_ROLL':
    case 'PAPER_BOBBIN':
    case 'PACKAGING':
    case 'CONSUMABLE':
      return COA.RAW_INV;
    case 'FINISHED_GOODS':
    case 'REAM':
    case 'SECURITY_ITEM':
      return COA.FG_INV;
    default:
      return COA.RAW_INV;
  }
}

export async function getAccountId(client: pg.PoolClient, ctx: Ctx, code: string): Promise<number> {
  const res = await client.query(
    'SELECT id FROM chart_of_accounts WHERE company_id = $1 AND code = $2 AND is_active = true',
    [ctx.companyId, code]
  );
  if (res.rows.length === 0) throw badRequest(`Chart of accounts code ${code} not found`);
  return Number(res.rows[0].id);
}

function renderAmount(tpl: unknown, vars: Record<string, number>): number {
  const raw = String(tpl ?? '0').replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? 0));
  const v = Number(raw);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

/**
 * If an active posting rule exists for the business event, render it into
 * journal lines. Returns null when no rule applies or the rule cannot post
 * (missing account, unbalanced, fewer than two lines) so callers keep their
 * hardcoded double-entry fallback. Live postings never fail open to an
 * unbalanced journal.
 */
export async function resolveEventLines(
  client: pg.PoolClient,
  ctx: Ctx,
  event: string,
  vars: { amount: number; net?: number; tax?: number },
  opts: { substitute?: Record<string, number>; description?: string } = {}
): Promise<JournalLine[] | null> {
  const res = await client.query(
    `SELECT * FROM posting_rules
     WHERE company_id = $1 AND event = $2 AND is_active = true
     ORDER BY id LIMIT 1`,
    [ctx.companyId, event]
  );
  if (!res.rows.length) return null;
  const lines = Array.isArray(res.rows[0].lines) ? res.rows[0].lines : [];
  const amounts = { amount: n(vars.amount), net: n(vars.net ?? vars.amount), tax: n(vars.tax) };
  const rendered: JournalLine[] = [];
  for (const ln of lines as Array<Record<string, unknown>>) {
    const code = String(ln.account_code ?? ln.accountCode ?? '').trim();
    if (!code) return null;
    const mapped = opts.substitute?.[code];
    let account_id: number;
    if (mapped) {
      account_id = mapped;
    } else {
      const acct = await client.query(
        'SELECT id FROM chart_of_accounts WHERE company_id = $1 AND code = $2 AND is_active = true',
        [ctx.companyId, code]
      );
      if (!acct.rows.length) return null;
      account_id = Number(acct.rows[0].id);
    }
    const debit = renderAmount(ln.debit, amounts);
    const credit = renderAmount(ln.credit, amounts);
    if (debit === 0 && credit === 0) continue;
    rendered.push({ account_id, debit, credit, description: opts.description });
  }
  if (rendered.length < 2) return null;
  const dr = rendered.reduce((s, l) => s + n(l.debit), 0);
  const cr = rendered.reduce((s, l) => s + n(l.credit), 0);
  if (Math.round(dr * 100) !== Math.round(cr * 100)) return null;
  return rendered;
}

export interface BudgetPosition {
  result: 'NONE' | 'ALLOW' | 'WARNING' | 'BLOCK';
  approved: number;
  committed: number;
  actual: number;
  available: number;
  budgetId: number | null;
  budgetNo: string | null;
}

/** Approved − committed − actual spend on a GL account for the current period. */
export async function budgetPosition(
  client: pg.PoolClient,
  ctx: Ctx,
  accountId: number
): Promise<BudgetPosition> {
  const res = await client.query(
    `SELECT
       (SELECT COALESCE(SUM(bl.amount),0)::numeric
          FROM budget_lines bl
          JOIN budgets b ON b.id = bl.budget_id
         WHERE b.company_id = $1 AND b.tenant_id = $2
           AND b.status IN ('APPROVED','ACTIVE')
           AND bl.account_id = $3
           AND b.period_start <= CURRENT_DATE AND b.period_end >= CURRENT_DATE) AS approved,
       (SELECT COALESCE(SUM(c.amount),0)::numeric
          FROM budget_commitments c
         WHERE c.tenant_id = $2 AND c.account_id = $3 AND c.status = 'COMMITTED') AS committed,
       (SELECT COALESCE(SUM(jl.debit - jl.credit),0)::numeric
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
         WHERE je.tenant_id = $2 AND jl.account_id = $3) AS actual,
       (SELECT b.id FROM budgets b
          JOIN budget_lines bl ON bl.budget_id = b.id
         WHERE b.company_id = $1 AND b.tenant_id = $2
           AND b.status IN ('APPROVED','ACTIVE')
           AND bl.account_id = $3
           AND b.period_start <= CURRENT_DATE AND b.period_end >= CURRENT_DATE
         ORDER BY b.id DESC LIMIT 1) AS budget_id,
       (SELECT b.budget_no FROM budgets b
          JOIN budget_lines bl ON bl.budget_id = b.id
         WHERE b.company_id = $1 AND b.tenant_id = $2
           AND b.status IN ('APPROVED','ACTIVE')
           AND bl.account_id = $3
           AND b.period_start <= CURRENT_DATE AND b.period_end >= CURRENT_DATE
         ORDER BY b.id DESC LIMIT 1) AS budget_no`,
    [ctx.companyId, ctx.tenantId, accountId]
  );
  const row = res.rows[0] ?? {};
  const approved = n(row.approved);
  const committed = n(row.committed);
  const actual = n(row.actual);
  const available = round2(approved - committed - actual);
  let result: BudgetPosition['result'] = 'NONE';
  if (approved > 0) {
    result = available >= 0 ? 'ALLOW' : 'BLOCK';
  }
  return {
    result,
    approved,
    committed,
    actual,
    available,
    budgetId: row.budget_id != null ? Number(row.budget_id) : null,
    budgetNo: row.budget_no != null ? String(row.budget_no) : null,
  };
}

export async function assertBudgetAllows(
  client: pg.PoolClient,
  ctx: Ctx,
  accountId: number,
  amount: number
): Promise<BudgetPosition> {
  const pos = await budgetPosition(client, ctx, accountId);
  if (pos.result === 'NONE') return pos;
  if (pos.available + 0.005 < n(amount)) {
    throw badRequest(
      `Budget exceeded on ${pos.budgetNo ?? 'account'}: available ${pos.available.toFixed(2)}, requested ${n(amount).toFixed(2)} (approved ${pos.approved.toFixed(2)} − committed ${pos.committed.toFixed(2)} − actual ${pos.actual.toFixed(2)})`
    );
  }
  return pos;
}

interface PostJournalInput {
  entryDate: string;
  journalType: string;
  description: string;
  lines: JournalLine[];
  refType?: string | null;
  refId?: number | null;
  refCode?: string | null;
  currency?: string;
  rate?: number;
}

const JOURNAL_TYPE_MAP: Record<string, string> = {
  GOODS_RECEIPT: 'GRN_RECEIPT',
  GRN: 'GRN_RECEIPT',
  INVENTORY: 'INVENTORY_ADJUSTMENT',
  ADJUSTMENT: 'INVENTORY_ADJUSTMENT',
  PURCHASE_RETURN: 'INVENTORY_ADJUSTMENT',
};

function journalType(raw: string): string {
  return JOURNAL_TYPE_MAP[raw] ?? raw;
}

function isoDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

export async function assertPeriodOpen(client: pg.PoolClient, ctx: Ctx, entryDate: string) {
  const res = await client.query(
    `SELECT id, code, status FROM financial_periods
     WHERE company_id = $1 AND start_date <= $2::date AND end_date >= $2::date
     ORDER BY start_date LIMIT 1`,
    [ctx.companyId, entryDate]
  );
  if (!res.rows.length) throw badRequest(`No financial period covers ${entryDate}`);
  if (res.rows[0].status !== 'OPEN') {
    throw badRequest(`Period ${res.rows[0].code} is ${res.rows[0].status} — posting is blocked`);
  }
  return Number(res.rows[0].id);
}

/** Call the double-entry post_journal SQL function and return the entry id. */
export async function postJournalLines(client: pg.PoolClient, ctx: Ctx, input: PostJournalInput): Promise<number> {
  const companyId = ctx.companyId;
  if (!companyId) throw badRequest('Company context required');
  await assertPeriodOpen(client, ctx, input.entryDate);
  const lines = input.lines.map((l) => ({
    account_id: l.account_id,
    debit: l.debit ?? 0,
    credit: l.credit ?? 0,
    cost_centre_id: l.cost_centre_id ?? null,
    profit_centre_id: l.profit_centre_id ?? null,
    description: l.description ?? input.description,
  }));
  const res = await client.query(
    `SELECT post_journal($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) AS entry_id`,
    [
      companyId,
      ctx.tenantId,
      ctx.branchId ?? null,
      input.entryDate,
      journalType(input.journalType),
      input.description,
      JSON.stringify(lines),
      input.refType ?? null,
      input.refId ?? null,
      input.refCode ?? null,
      ctx.userId ?? null,
      null,
      input.currency ?? 'UGX',
      input.rate ?? 1,
    ]
  );
  return Number(res.rows[0].entry_id);
}

async function markPosted(client: pg.PoolClient, table: string, id: number, journalId: number, extra: Record<string, unknown> = {}) {
  const entries = Object.entries(extra).filter(([, v]) => v !== undefined);
  const sets: string[] = [];
  const values: unknown[] = [journalId];
  for (const [k, v] of entries) {
    if (v === null) {
      sets.push(`${k} = NULL`);
    } else {
      values.push(v);
      sets.push(`${k} = $${values.length}`);
    }
  }
  values.push(id);
  const setSql = sets.length ? `, ${sets.join(', ')}` : '';
  await client.query(
    `UPDATE ${table} SET gl_posted = true, gl_journal_id = $1${setSql} WHERE id = $${values.length}`,
    values
  );
}

/** Sales invoice: Dr AR, Cr Revenue, Cr VAT. */
export async function postSalesInvoice(client: pg.PoolClient, ctx: Ctx, invoiceId: number) {
  const res = await client.query(
    `SELECT * FROM customer_invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [invoiceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Invoice not found');
  const inv = res.rows[0];
  if (inv.gl_posted) return Number(inv.gl_journal_id);
  if (inv.status !== 'APPROVED' && inv.status !== 'POSTED') {
    throw badRequest(`Invoice must be APPROVED before posting (current: ${inv.status})`);
  }
  const arId = await getAccountId(client, ctx, COA.AR);
  const revId = await getAccountId(client, ctx, COA.REVENUE);
  const vatId = await getAccountId(client, ctx, COA.VAT);
  const revenue = Number(inv.subtotal) - Number(inv.discount_amount);
  const tax = Number(inv.tax_amount);
  const total = Number(inv.total);
  const desc = `Invoice ${inv.invoice_no}`;
  const fromRule = await resolveEventLines(client, ctx, 'SALES_INVOICE', { amount: total, net: revenue, tax }, { description: desc });
  const lines: JournalLine[] = fromRule ?? [
    { account_id: arId, debit: total, description: desc },
    { account_id: revId, credit: revenue, description: `Revenue ${inv.invoice_no}` },
    ...(tax > 0 ? [{ account_id: vatId, credit: tax, description: `VAT ${inv.invoice_no}` } as JournalLine] : []),
  ];
  const entryId = await postJournalLines(client, ctx, {
    entryDate: isoDate(inv.invoice_date),
    journalType: 'SALES_INVOICE',
    description: `Customer invoice ${inv.invoice_no}`,
    lines,
    refType: 'customer_invoices',
    refId: invoiceId,
    refCode: String(inv.invoice_no),
  });
  await markPosted(client, 'customer_invoices', invoiceId, entryId, { status: 'POSTED', approved_at: inv.approved_at });
  await emitEvent(client, ctx, {
    eventType: 'finance.invoice_posted',
    entityType: 'customer_invoices',
    entityId: invoiceId,
    entityCode: String(inv.invoice_no),
    payload: { journalId: entryId, total },
  });
  await logAudit(client, ctx, { action: 'post', resource: 'customer_invoices', recordId: invoiceId, recordCode: String(inv.invoice_no), newValues: { gl_journal_id: entryId } });
  return entryId;
}

/** Customer receipt: Dr Bank/Cash, Cr AR. */
export async function postReceipt(client: pg.PoolClient, ctx: Ctx, receiptId: number) {
  const res = await client.query(
    `SELECT r.*, b.gl_account_id AS bank_gl FROM receipts r
     LEFT JOIN bank_accounts b ON b.id = r.bank_account_id
     WHERE r.id = $1 AND r.tenant_id = $2 FOR UPDATE OF r`,
    [receiptId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Receipt not found');
  const rc = res.rows[0];
  if (rc.gl_posted) return Number(rc.gl_journal_id);
  const arId = await getAccountId(client, ctx, COA.AR);
  const bankId = rc.bank_gl ? Number(rc.bank_gl) : await getAccountId(client, ctx, COA.DEFAULT_BANK);
  const amount = Number(rc.amount);
  const desc = `Receipt ${rc.receipt_no}`;
  const fromRule = await resolveEventLines(
    client, ctx, 'CUSTOMER_RECEIPT', { amount },
    { substitute: { [COA.DEFAULT_BANK]: bankId }, description: desc }
  );
  const entryId = await postJournalLines(client, ctx, {
    entryDate: isoDate(rc.receipt_date),
    journalType: 'CUSTOMER_RECEIPT',
    description: `Receipt ${rc.receipt_no} from customer`,
    lines: fromRule ?? [
      { account_id: bankId, debit: amount, description: desc },
      { account_id: arId, credit: amount, description: desc },
    ],
    refType: 'receipts',
    refId: receiptId,
    refCode: String(rc.receipt_no),
  });
  await markPosted(client, 'receipts', receiptId, entryId);
  let allocs = await client.query(
    `SELECT invoice_id, amount FROM receipt_allocations WHERE receipt_id = $1`,
    [receiptId]
  );
  if (allocs.rows.length === 0 && rc.invoice_id != null) {
    await client.query(
      `INSERT INTO receipt_allocations (receipt_id, invoice_id, amount) VALUES ($1,$2,$3)
       ON CONFLICT (receipt_id, invoice_id) DO UPDATE SET amount = EXCLUDED.amount`,
      [receiptId, Number(rc.invoice_id), amount]
    );
    allocs = await client.query(
      `SELECT invoice_id, amount FROM receipt_allocations WHERE receipt_id = $1`,
      [receiptId]
    );
  }
  let allocated = 0;
  for (const row of allocs.rows) {
    const part = Number(row.amount);
    allocated += part;
    await client.query(
      `UPDATE customer_invoices SET amount_paid = amount_paid + $1,
         status = CASE WHEN amount_paid + $1 >= total - 0.005 THEN 'PAID' ELSE 'PARTIALLY_PAID' END
       WHERE id = $2 AND status NOT IN ('VOID')`,
      [part, Number(row.invoice_id)]
    );
  }
  await client.query(
    `UPDATE receipts SET unallocated_amount = GREATEST($2::numeric - $3::numeric, 0) WHERE id = $1`,
    [receiptId, amount, allocated]
  );
  await emitEvent(client, ctx, {
    eventType: 'finance.receipt_posted',
    entityType: 'receipts',
    entityId: receiptId,
    entityCode: String(rc.receipt_no),
    payload: { journalId: entryId, amount },
  });
  return entryId;
}

/** Credit note: Dr Revenue (reversal), Cr AR. */
export async function postCreditNote(client: pg.PoolClient, ctx: Ctx, creditNoteId: number) {
  const res = await client.query(
    `SELECT * FROM credit_notes WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [creditNoteId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Credit note not found');
  const cn = res.rows[0];
  if (cn.gl_posted) return Number(cn.gl_journal_id);
  if (cn.status !== 'APPROVED') throw badRequest(`Credit note must be APPROVED (current: ${cn.status})`);
  const arId = await getAccountId(client, ctx, COA.AR);
  const revId = await getAccountId(client, ctx, COA.REVENUE);
  const amount = Number(cn.amount);
  const entryId = await postJournalLines(client, ctx, {
    entryDate: cn.credit_date,
    journalType: 'CREDIT_NOTE',
    description: `Credit note ${cn.credit_no}`,
    lines: [
      { account_id: revId, debit: amount, description: `Credit note ${cn.credit_no}` },
      { account_id: arId, credit: amount, description: `Credit note ${cn.credit_no}` },
    ],
    refType: 'credit_notes',
    refId: creditNoteId,
    refCode: String(cn.credit_no),
  });
  await markPosted(client, 'credit_notes', creditNoteId, entryId, { status: 'POSTED' });
  if (cn.invoice_id) {
    await client.query(
      `UPDATE customer_invoices SET amount_paid = amount_paid - $1 WHERE id = $2 AND status NOT IN ('VOID')`,
      [amount, cn.invoice_id]
    );
  }
  return entryId;
}

/** Debit note: Dr AR, Cr Revenue (additional amount owed). */
export async function postDebitNote(client: pg.PoolClient, ctx: Ctx, debitNoteId: number) {
  const res = await client.query(
    `SELECT * FROM debit_notes WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [debitNoteId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Debit note not found');
  const dn = res.rows[0];
  if (dn.gl_posted) return Number(dn.gl_journal_id);
  if (dn.status !== 'APPROVED') throw badRequest(`Debit note must be APPROVED (current: ${dn.status})`);
  const arId = await getAccountId(client, ctx, COA.AR);
  const revId = await getAccountId(client, ctx, COA.REVENUE);
  const amount = Number(dn.amount);
  const entryId = await postJournalLines(client, ctx, {
    entryDate: isoDate(dn.debit_date),
    journalType: 'DEBIT_NOTE',
    description: `Debit note ${dn.debit_no}`,
    lines: [
      { account_id: arId, debit: amount, description: `Debit note ${dn.debit_no}` },
      { account_id: revId, credit: amount, description: `Debit note ${dn.debit_no}` },
    ],
    refType: 'debit_notes',
    refId: debitNoteId,
    refCode: String(dn.debit_no),
  });
  await markPosted(client, 'debit_notes', debitNoteId, entryId, { status: 'POSTED' });
  if (dn.invoice_id) {
    await client.query(
      `UPDATE customer_invoices SET total = total + $1,
         status = CASE
           WHEN status = 'VOID' THEN status
           WHEN amount_paid >= total + $1 - 0.005 THEN 'PAID'
           ELSE 'PARTIALLY_PAID'
         END
       WHERE id = $2 AND status NOT IN ('VOID')`,
      [amount, dn.invoice_id]
    );
  }
  return entryId;
}

/** Supplier invoice: Dr Expense/Inventory, Dr VAT, Cr AP. */
export async function postSupplierInvoice(client: pg.PoolClient, ctx: Ctx, siId: number) {
  const res = await client.query(
    `SELECT si.* FROM supplier_invoices si WHERE si.id = $1 AND si.tenant_id = $2 FOR UPDATE`,
    [siId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Supplier invoice not found');
  const si = res.rows[0];
  if (si.gl_posted) return Number(si.gl_journal_id);
  if (si.status !== 'APPROVED' && si.status !== 'MATCHED') {
    throw badRequest(`Supplier invoice must be APPROVED before posting (current: ${si.status})`);
  }
  const items = await client.query(
    `SELECT sii.*, p.type AS product_type FROM supplier_invoice_items sii
     LEFT JOIN products p ON p.id = sii.product_id WHERE sii.invoice_id = $1`,
    [siId]
  );
  const apId = await getAccountId(client, ctx, COA.AP);
  const vatId = await getAccountId(client, ctx, COA.VAT);
  const accrualId = await getAccountId(client, ctx, COA.ACCRUAL);
  const lines: JournalLine[] = [];
  const viaGrn = si.grn_id != null;
  for (const it of items.rows) {
    const amount = Number(it.amount ?? it.quantity * (it.unit_price ?? 0));
    if (amount === 0) continue;
    // GRN already Dr inventory / Cr GR-IR. The invoice clears the accrual into AP.
    const acct = viaGrn
      ? accrualId
      : it.account_id
        ? Number(it.account_id)
        : await getAccountId(client, ctx, inventoryAccountForType(it.product_type));
    lines.push({ account_id: acct, debit: amount, description: it.description ?? `Line ${it.id}` });
  }
  const tax = Number(si.tax_amount);
  if (tax > 0) lines.push({ account_id: vatId, debit: tax, description: `VAT ${si.supplier_invoice_no}` });
  lines.push({ account_id: apId, credit: Number(si.total), description: `Supplier invoice ${si.supplier_invoice_no}` });
  const entryId = await postJournalLines(client, ctx, {
    entryDate: si.invoice_date,
    journalType: 'PURCHASE_INVOICE',
    description: `Supplier invoice ${si.supplier_invoice_no}`,
    lines,
    refType: 'supplier_invoices',
    refId: siId,
    refCode: String(si.supplier_invoice_no),
  });
  await markPosted(client, 'supplier_invoices', siId, entryId, { status: 'MATCHED' });
  await emitEvent(client, ctx, {
    eventType: 'finance.supplier_invoice_posted',
    entityType: 'supplier_invoices',
    entityId: siId,
    entityCode: String(si.supplier_invoice_no),
    payload: { journalId: entryId, total: Number(si.total) },
  });
  return entryId;
}

/** Supplier payment: Dr AP, Cr Bank. */
export async function postSupplierPayment(client: pg.PoolClient, ctx: Ctx, paymentId: number) {
  const res = await client.query(
    `SELECT p.*, b.gl_account_id AS bank_gl FROM supplier_payments p
     LEFT JOIN bank_accounts b ON b.id = p.bank_account_id
     WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE`,
    [paymentId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Supplier payment not found');
  const p = res.rows[0];
  if (p.gl_posted) return Number(p.gl_journal_id);
  if (p.status !== 'RELEASED' && p.status !== 'APPROVED') {
    throw badRequest(`Supplier payment must be RELEASED before posting (current: ${p.status})`);
  }
  const apId = await getAccountId(client, ctx, COA.AP);
  const bankId = p.bank_gl ? Number(p.bank_gl) : await getAccountId(client, ctx, COA.DEFAULT_BANK);
  const amount = Number(p.amount);
  const entryId = await postJournalLines(client, ctx, {
    entryDate: p.payment_date,
    journalType: 'SUPPLIER_PAYMENT',
    description: `Supplier payment ${p.payment_no}`,
    lines: [
      { account_id: apId, debit: amount, description: `Payment ${p.payment_no}` },
      { account_id: bankId, credit: amount, description: `Payment ${p.payment_no}` },
    ],
    refType: 'supplier_payments',
    refId: paymentId,
    refCode: String(p.payment_no),
  });
  await markPosted(client, 'supplier_payments', paymentId, entryId, { status: 'RELEASED' });
  if (p.supplier_invoice_id) {
    await client.query(
      `UPDATE supplier_invoices SET amount_paid = amount_paid + $1,
         status = CASE WHEN amount_paid + $1 >= total THEN 'PAID' ELSE 'PARTIALLY_PAID' END
       WHERE id = $2 AND status NOT IN ('VOID')`,
      [amount, p.supplier_invoice_id]
    );
  }
  await emitEvent(client, ctx, {
    eventType: 'finance.supplier_payment_posted',
    entityType: 'supplier_payments',
    entityId: paymentId,
    entityCode: String(p.payment_no),
    payload: { journalId: entryId, amount },
  });
  return entryId;
}

/** Payroll release: Dr expense (gross), Cr PAYE, Cr NSSF accrual, Cr loan recoveries, Cr bank (net). */
export async function postPayroll(client: pg.PoolClient, ctx: Ctx, payrollId: number) {
  const res = await client.query(
    `SELECT * FROM payrolls WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [payrollId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Payroll not found');
  const run = res.rows[0];
  if (run.gl_posted) return Number(run.gl_journal_id);
  if (!['APPROVED', 'RELEASED'].includes(String(run.status))) {
    throw badRequest(`Payroll must be APPROVED before posting (current: ${run.status})`);
  }
  const items = await client.query(`SELECT * FROM payroll_items WHERE payroll_id = $1`, [payrollId]);
  if (items.rows.length === 0) throw badRequest('Payroll has no lines');
  let gross = 0;
  let paye = 0;
  let nssf = 0;
  let loans = 0;
  let advances = 0;
  let other = 0;
  let lst = 0;
  let net = 0;
  for (const it of items.rows) {
    gross += Number(it.gross_pay);
    paye += Number(it.paye);
    nssf += Number(it.nssf);
    loans += Number(it.loans);
    advances += Number(it.advances);
    other += Number(it.other_deductions);
    lst += Number(it.lst);
    net += Number(it.net_pay);
  }
  const expId = await getAccountId(client, ctx, COA.ADMIN_EXP);
  const payeId = await getAccountId(client, ctx, COA.PAYE);
  const nssfId = await getAccountId(client, ctx, COA.ACCRUAL);
  const loanId = await getAccountId(client, ctx, COA.OTHER_RECV);
  const bankId = await getAccountId(client, ctx, COA.DEFAULT_BANK);
  const lines: JournalLine[] = [
    { account_id: expId, debit: round2(gross), description: `Payroll ${run.payroll_no} gross` },
  ];
  if (paye > 0) lines.push({ account_id: payeId, credit: round2(paye), description: `PAYE ${run.payroll_no}` });
  if (nssf > 0) lines.push({ account_id: nssfId, credit: round2(nssf), description: `NSSF ${run.payroll_no}` });
  if (lst > 0) lines.push({ account_id: nssfId, credit: round2(lst), description: `LST ${run.payroll_no}` });
  if (loans + advances + other > 0) {
    lines.push({ account_id: loanId, credit: round2(loans + advances + other), description: `Staff recoveries ${run.payroll_no}` });
  }
  if (net > 0) lines.push({ account_id: bankId, credit: round2(net), description: `Net pay ${run.payroll_no}` });
  const entryId = await postJournalLines(client, ctx, {
    entryDate: isoDate(run.period_end),
    journalType: 'PAYROLL',
    description: `Payroll ${run.payroll_no}`,
    lines,
    refType: 'payrolls',
    refId: payrollId,
    refCode: String(run.payroll_no),
  });
  await markPosted(client, 'payrolls', payrollId, entryId, { status: 'RELEASED', released_by: ctx.userId ?? null, released_at: new Date().toISOString() });
  await emitEvent(client, ctx, {
    eventType: 'finance.payroll_posted',
    entityType: 'payrolls',
    entityId: payrollId,
    entityCode: String(run.payroll_no),
    payload: { journalId: entryId, net: round2(net) },
  });
  return entryId;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export interface InventoryValueInput {
  productId: number;
  productType?: string | null;
  amount: number;            // positive = debit stock (increase), negative = credit stock (decrease)
  entryDate: string;
  description: string;
  journalType: string;
  refType?: string | null;
  refId?: number | null;
  refCode?: string | null;
  contraAccountCode?: string; // defaults to WIP for production, expense otherwise
}

/** Post an inventory valuation change (GRN receipt, production output, scrap, adjustment). */
export async function postInventoryValueChange(client: pg.PoolClient, ctx: Ctx, input: InventoryValueInput) {
  if (input.amount === 0) return null;
  const stockId = await getAccountId(client, ctx, inventoryAccountForType(input.productType));
  const contraCode = input.contraAccountCode ?? (input.journalType === 'PRODUCTION' ? COA.WIP : COA.ADMIN_EXP);
  const contraId = await getAccountId(client, ctx, contraCode);
  const abs = Math.abs(input.amount);
  const lines: JournalLine[] =
    input.amount > 0
      ? [
          { account_id: stockId, debit: abs, description: input.description },
          { account_id: contraId, credit: abs, description: input.description },
        ]
      : [
          { account_id: contraId, debit: abs, description: input.description },
          { account_id: stockId, credit: abs, description: input.description },
        ];
  return postJournalLines(client, ctx, {
    entryDate: input.entryDate,
    journalType: input.journalType,
    description: input.description,
    lines,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    refCode: input.refCode ?? null,
  });
}

/** Void a posted journal with a reversing entry. */
export async function voidJournal(client: pg.PoolClient, ctx: Ctx, journalId: number, reason: string) {
  const res = await client.query(
    `SELECT * FROM journal_entries WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [journalId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Journal entry not found');
  const je = res.rows[0];
  if (je.status !== 'POSTED') throw badRequest(`Journal is ${je.status}, cannot void`);
  const linesRes = await client.query(
    `SELECT account_id, debit, credit, cost_centre_id, profit_centre_id FROM journal_lines WHERE entry_id = $1`,
    [journalId]
  );
  const lines: JournalLine[] = linesRes.rows.map((l) => ({
    account_id: Number(l.account_id),
    debit: Number(l.credit),
    credit: Number(l.debit),
    cost_centre_id: l.cost_centre_id ? Number(l.cost_centre_id) : null,
    profit_centre_id: l.profit_centre_id ? Number(l.profit_centre_id) : null,
  }));
  const reversal = await postJournalLines(client, ctx, {
    entryDate: new Date().toISOString().slice(0, 10),
    journalType: je.journal_type,
    description: `Reversal: ${je.description} (${reason})`,
    lines,
    refType: je.reference_type,
    refId: je.reference_id,
    refCode: je.reference_code,
  });
  await client.query(
    `UPDATE journal_entries SET status = 'VOID', voided_by = $2, voided_at = now(), reversal_of_id = NULL WHERE id = $1`,
    [journalId, ctx.userId ?? null]
  );
  await client.query(
    `UPDATE journal_entries SET reversal_of_id = $1 WHERE id = $2`,
    [journalId, reversal]
  );
  return reversal;
}

function n(v: unknown): number {
  return Number(v) || 0;
}

export async function listAccounts(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name, account_type, subtype, parent_id, is_posting, is_active, currency, opening_balance
     FROM chart_of_accounts WHERE tenant_id = $1 AND company_id = $2
     ORDER BY code`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function listJournals(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['je.tenant_id = $1', 'je.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(je.entry_no ILIKE $${params.length} OR je.description ILIKE $${params.length} OR je.reference_code ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`je.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT je.id, je.entry_no, je.entry_date, je.journal_type, je.description,
            je.reference_type, je.reference_code, je.total_debit, je.total_credit, je.status, je.currency
     FROM journal_entries je
     WHERE ${where.join(' AND ')}
     ORDER BY je.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = await client.query(
    `SELECT count(*)::int AS n FROM journal_entries je WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(res.rows), total: Number(total.rows[0].n), page, pageSize };
}

export async function getJournal(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT * FROM journal_entries WHERE id = $1 AND tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Journal entry not found');
  const lines = await client.query(
    `SELECT jl.*, a.code AS account_code, a.name AS account_name, a.account_type
     FROM journal_lines jl JOIN chart_of_accounts a ON a.id = jl.account_id
     WHERE jl.entry_id = $1 ORDER BY jl.id`,
    [id]
  );
  return { journal: toCamelRow(res.rows[0]), lines: toCamelRows(lines.rows) };
}

export async function createManualJournal(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    entryDate: string;
    description: string;
    journalType?: string;
    lines: Array<{ accountId: number; debit?: number; credit?: number; description?: string }>;
    post?: boolean;
  }
) {
  if (!input.lines || input.lines.length < 2) throw badRequest('A journal needs at least two lines');
  const debit = input.lines.reduce((s, l) => s + n(l.debit), 0);
  const credit = input.lines.reduce((s, l) => s + n(l.credit), 0);
  if (Math.round(debit * 100) !== Math.round(credit * 100)) {
    throw badRequest(`Journal does not balance: debit ${debit} vs credit ${credit}`);
  }
  if (debit <= 0) throw badRequest('Journal amount must be positive');
  if (input.post) {
    const entryId = await postJournalLines(client, ctx, {
      entryDate: input.entryDate,
      journalType: input.journalType ?? 'MANUAL',
      description: input.description,
      lines: input.lines.map((l) => ({
        account_id: Number(l.accountId),
        debit: n(l.debit),
        credit: n(l.credit),
        description: l.description,
      })),
    });
    return { entryId, status: 'POSTED' };
  }
  await assertPeriodOpen(client, ctx, input.entryDate);
  const no = await client.query(`SELECT next_doc_no($1,$2,8) AS code`, [ctx.tenantId, 'GL']);
  const ins = await client.query(
    `INSERT INTO journal_entries
       (company_id, tenant_id, branch_id, entry_no, entry_date, journal_type, description,
        currency, exchange_rate, total_debit, total_credit, status)
     VALUES ($1,$2,$3,$4,$5,'MANUAL',$6,'UGX',1,$7,$8,'DRAFT') RETURNING id`,
    [ctx.companyId, ctx.tenantId, ctx.branchId ?? null, no.rows[0].code, input.entryDate, input.description, debit, credit]
  );
  const entryId = Number(ins.rows[0].id);
  for (const l of input.lines) {
    await client.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit, description)
       VALUES ($1,$2,$3,$4,$5)`,
      [entryId, Number(l.accountId), n(l.debit), n(l.credit), l.description ?? input.description]
    );
  }
  return { entryId, status: 'DRAFT' };
}

export async function postDraftJournal(client: pg.PoolClient, ctx: Ctx, id: number) {
  const { journal, lines } = await getJournal(client, ctx, id);
  if (journal.status !== 'DRAFT') throw badRequest(`Journal is ${journal.status}`);
  const entryId = await postJournalLines(client, ctx, {
    entryDate: isoDate(journal.entryDate),
    journalType: String(journal.journalType ?? 'MANUAL'),
    description: String(journal.description),
    lines: lines.map((l) => ({
      account_id: Number(l.accountId),
      debit: n(l.debit),
      credit: n(l.credit),
      description: l.description != null ? String(l.description) : undefined,
    })),
    refType: 'journal_entries',
    refId: id,
    refCode: String(journal.entryNo),
  });
  await client.query(`UPDATE journal_entries SET status = 'VOID', voided_by = $2, voided_at = now() WHERE id = $1`, [id, ctx.userId ?? null]);
  return { entryId, status: 'POSTED', replacedDraft: id };
}

export async function trialBalance(client: pg.PoolClient, ctx: Ctx, from?: string, to?: string) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let dateFilter = '';
  if (from) {
    params.push(from);
    dateFilter += ` AND je.entry_date >= $${params.length}::date`;
  }
  if (to) {
    params.push(to);
    dateFilter += ` AND je.entry_date <= $${params.length}::date`;
  }
  const res = await client.query(
    `SELECT a.id, a.code, a.name, a.account_type, a.opening_balance,
            COALESCE(sum(jl.debit),0)::numeric AS debit,
            COALESCE(sum(jl.credit),0)::numeric AS credit,
            (a.opening_balance + COALESCE(sum(jl.debit - jl.credit),0))::numeric AS balance
     FROM chart_of_accounts a
     LEFT JOIN journal_lines jl ON jl.account_id = a.id
     LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED' AND je.tenant_id = $1 ${dateFilter}
     WHERE a.tenant_id = $1 AND a.company_id = $2 AND a.is_active = true
     GROUP BY a.id
     HAVING a.opening_balance <> 0 OR COALESCE(sum(jl.debit),0) <> 0 OR COALESCE(sum(jl.credit),0) <> 0
     ORDER BY a.code`,
    params
  );
  const rows = toCamelRows(res.rows);
  const totals = { debit: 0, credit: 0, balance: 0 };
  for (const r of rows) {
    totals.debit += n(r.debit);
    totals.credit += n(r.credit);
    totals.balance += n(r.balance);
  }
  return { rows, totals };
}

export async function profitAndLoss(client: pg.PoolClient, ctx: Ctx, from: string, to: string) {
  const res = await client.query(
    `SELECT a.id, a.code, a.name, a.account_type,
            COALESCE(sum(jl.debit),0)::numeric AS debit,
            COALESCE(sum(jl.credit),0)::numeric AS credit,
            CASE WHEN a.account_type = 'REVENUE'
                 THEN COALESCE(sum(jl.credit - jl.debit),0)
                 ELSE COALESCE(sum(jl.debit - jl.credit),0)
            END::numeric AS amount
     FROM chart_of_accounts a
     JOIN journal_lines jl ON jl.account_id = a.id
     JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
     WHERE a.tenant_id = $1 AND a.company_id = $2
       AND a.account_type IN ('REVENUE','EXPENSE','CONTRA_REVENUE','CONTRA_EXPENSE')
       AND je.entry_date BETWEEN $3::date AND $4::date
     GROUP BY a.id
     ORDER BY a.code`,
    [ctx.tenantId, ctx.companyId, from, to]
  );
  const rows = toCamelRows(res.rows);
  const revenue = rows.filter((r) => String(r.accountType) === 'REVENUE').reduce((s, r) => s + n(r.amount), 0);
  const expense = rows.filter((r) => String(r.accountType) === 'EXPENSE').reduce((s, r) => s + n(r.amount), 0);
  return { rows, revenue, expense, profit: revenue - expense, from, to };
}

export async function balanceSheet(client: pg.PoolClient, ctx: Ctx, asOf: string) {
  const res = await client.query(
    `SELECT a.id, a.code, a.name, a.account_type,
            (a.opening_balance + COALESCE(sum(jl.debit - jl.credit),0))::numeric AS raw
     FROM chart_of_accounts a
     LEFT JOIN journal_lines jl ON jl.account_id = a.id
     LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED' AND je.entry_date <= $3::date
     WHERE a.tenant_id = $1 AND a.company_id = $2 AND a.is_active = true
       AND a.account_type IN ('ASSET','LIABILITY','EQUITY','CONTRA_ASSET','CONTRA_LIABILITY','CONTRA_EQUITY')
     GROUP BY a.id
     HAVING a.opening_balance <> 0 OR COALESCE(sum(jl.debit),0) <> 0 OR COALESCE(sum(jl.credit),0) <> 0
     ORDER BY a.code`,
    [ctx.tenantId, ctx.companyId, asOf]
  );
  const rows = toCamelRows(res.rows).map((r) => {
    const raw = n(r.raw);
    const type = String(r.accountType);
    const amount = type === 'ASSET' || type === 'CONTRA_LIABILITY' || type === 'CONTRA_EQUITY' ? raw : -raw;
    return { id: r.id, code: r.code, name: r.name, accountType: type, amount };
  });
  const assets = rows.filter((r) => r.accountType === 'ASSET').reduce((s, r) => s + r.amount, 0);
  const liabilities = rows.filter((r) => r.accountType === 'LIABILITY').reduce((s, r) => s + r.amount, 0);
  const equity = rows.filter((r) => r.accountType === 'EQUITY').reduce((s, r) => s + r.amount, 0);
  return { rows, assets, liabilities, equity, totalLAndE: liabilities + equity, asOf };
}

export const AGING_BUCKETS = ['CURRENT', 'AGING_1_30', 'AGING_31_60', 'AGING_61_90', 'AGING_91_120', 'AGING_120_PLUS'] as const;

function agingBuckets(rows: Record<string, unknown>[]) {
  const buckets: Record<string, number> = {};
  for (const b of AGING_BUCKETS) buckets[b] = 0;
  for (const r of rows) {
    const b = String(r.bucket);
    if (b in buckets) buckets[b] += n(r.balance);
  }
  return buckets;
}

export async function arLedger(client: pg.PoolClient, ctx: Ctx, opts: { bucket?: string } = {}) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['tenant_id = $1', 'company_id = $2', 'balance > 0'];
  if (opts.bucket && AGING_BUCKETS.includes(opts.bucket as (typeof AGING_BUCKETS)[number])) {
    params.push(opts.bucket);
    where.push(`bucket = $${params.length}`);
  }
  const res = await client.query(
    `SELECT id, invoice_no, customer_id, customer_name, invoice_date, due_date,
            total, amount_paid, balance, bucket, days_overdue, is_overdue
     FROM v_ar_aging
     WHERE ${where.join(' AND ')}
     ORDER BY due_date NULLS LAST, invoice_no`,
    params
  );
  const rows = toCamelRows(res.rows);
  const buckets = agingBuckets(rows);
  return {
    rows,
    buckets,
    total: rows.reduce((s, r) => s + n(r.balance), 0),
    overdue: rows.filter((r) => Boolean(r.isOverdue)).reduce((s, r) => s + n(r.balance), 0),
  };
}

export async function apLedger(client: pg.PoolClient, ctx: Ctx, opts: { bucket?: string } = {}) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['tenant_id = $1', 'company_id = $2', 'balance > 0'];
  if (opts.bucket && AGING_BUCKETS.includes(opts.bucket as (typeof AGING_BUCKETS)[number])) {
    params.push(opts.bucket);
    where.push(`bucket = $${params.length}`);
  }
  const res = await client.query(
    `SELECT id, supplier_invoice_no, supplier_id, supplier_name, invoice_date, due_date,
            total, amount_paid, balance, bucket, days_overdue, is_overdue
     FROM v_ap_aging
     WHERE ${where.join(' AND ')}
     ORDER BY due_date NULLS LAST, supplier_invoice_no`,
    params
  );
  const rows = toCamelRows(res.rows);
  const buckets = agingBuckets(rows);
  return {
    rows,
    buckets,
    total: rows.reduce((s, r) => s + n(r.balance), 0),
    overdue: rows.filter((r) => Boolean(r.isOverdue)).reduce((s, r) => s + n(r.balance), 0),
  };
}

export async function listPeriods(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM financial_periods WHERE tenant_id = $1 AND company_id = $2 ORDER BY start_date`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function setPeriodStatus(client: pg.PoolClient, ctx: Ctx, id: number, status: 'OPEN' | 'LOCKED' | 'CLOSED') {
  const res = await client.query(
    `UPDATE financial_periods SET status = $3,
       closed_by = CASE WHEN $3 = 'CLOSED' THEN $4 ELSE closed_by END,
       closed_at = CASE WHEN $3 = 'CLOSED' THEN now() ELSE closed_at END
     WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId, status, ctx.userId ?? null]
  );
  if (!res.rows.length) throw notFound('Period not found');
  await logAudit(client, ctx, { action: status.toLowerCase(), resource: 'financial_periods', recordId: id, recordCode: String(res.rows[0].code), newValues: { status } });
  return toCamelRow(res.rows[0]);
}

export async function bankPosition(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT b.id, b.code, b.name, b.bank_name, b.account_no, b.account_type, b.currency, b.opening_balance,
            a.code AS gl_code,
            (b.opening_balance + COALESCE((
              SELECT sum(jl.debit - jl.credit) FROM journal_lines jl
              JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
              WHERE jl.account_id = b.gl_account_id
            ),0))::numeric AS book_balance,
            (SELECT count(*)::int FROM bank_transactions bt
              WHERE bt.bank_account_id = b.id AND bt.reconciled = false) AS unreconciled_count
     FROM bank_accounts b
     LEFT JOIN chart_of_accounts a ON a.id = b.gl_account_id
     WHERE b.tenant_id = $1 AND b.company_id = $2 AND b.is_active = true
     ORDER BY b.code`,
    [ctx.tenantId, ctx.companyId]
  );
  const rows = toCamelRows(res.rows);
  return {
    rows,
    cash: rows.reduce((s, r) => s + n(r.bookBalance), 0),
    unreconciled: rows.reduce((s, r) => s + n(r.unreconciledCount), 0),
  };
}

export async function taxSummary(client: pg.PoolClient, ctx: Ctx, from: string, to: string) {
  const vat = await getAccountId(client, ctx, COA.VAT);
  const res = await client.query(
    `SELECT COALESCE(sum(jl.credit),0)::numeric AS output_vat,
            COALESCE(sum(jl.debit),0)::numeric AS input_vat
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
     WHERE jl.account_id = $1 AND je.tenant_id = $2
       AND je.entry_date BETWEEN $3::date AND $4::date`,
    [vat, ctx.tenantId, from, to]
  );
  const outputVat = n(res.rows[0].output_vat);
  const inputVat = n(res.rows[0].input_vat);
  return { from, to, outputVat, inputVat, netVat: outputVat - inputVat };
}

export async function financeSummary(client: pg.PoolClient, ctx: Ctx) {
  const asOf = new Date().toISOString().slice(0, 10);
  const monthStart = asOf.slice(0, 8) + '01';
  const [tb, pl, ar, ap, banks, extras] = await Promise.all([
    trialBalance(client, ctx),
    profitAndLoss(client, ctx, monthStart, asOf),
    arLedger(client, ctx),
    apLedger(client, ctx),
    bankPosition(client, ctx),
    client.query(
      `SELECT
         (SELECT count(*)::int FROM journal_entries
           WHERE tenant_id = $1 AND company_id = $2 AND status IN ('DRAFT','SUBMITTED','PENDING_APPROVAL')) AS draft_journals,
         (SELECT COALESCE(SUM(balance),0)::numeric FROM v_ar_aging
           WHERE tenant_id = $1 AND company_id = $2 AND balance > 0
             AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7) AS ar_due_7,
         (SELECT COALESCE(SUM(balance),0)::numeric FROM v_ap_aging
           WHERE tenant_id = $1 AND company_id = $2 AND balance > 0
             AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7) AS ap_due_7,
         (SELECT CASE WHEN COALESCE(SUM(balance),0) > 0
            THEN round(SUM(balance * GREATEST(CURRENT_DATE - invoice_date, 0)) / SUM(balance), 1)
            ELSE 0 END
          FROM v_ar_aging WHERE tenant_id = $1 AND company_id = $2 AND balance > 0) AS dso,
         (SELECT CASE WHEN COALESCE(SUM(balance),0) > 0
            THEN round(SUM(balance * GREATEST(CURRENT_DATE - invoice_date, 0)) / SUM(balance), 1)
            ELSE 0 END
          FROM v_ap_aging WHERE tenant_id = $1 AND company_id = $2 AND balance > 0) AS dpo`,
      [ctx.tenantId, ctx.companyId]
    ),
  ]);
  const x = extras.rows[0] ?? {};
  return {
    trialBalanceOk: Math.round(n(tb.totals.debit) * 100) === Math.round(n(tb.totals.credit) * 100),
    monthRevenue: pl.revenue,
    monthExpense: pl.expense,
    monthProfit: pl.profit,
    ar: ar.total,
    arOverdue: ar.overdue,
    arDue7: n(x.ar_due_7),
    ap: ap.total,
    apOverdue: ap.overdue,
    apDue7: n(x.ap_due_7),
    cash: banks.cash,
    unreconciledBanks: banks.unreconciled,
    draftJournals: n(x.draft_journals),
    dso: n(x.dso),
    dpo: n(x.dpo),
    journals: tb.rows.length,
  };
}

export async function postExpense(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { expenseDate: string; accountId: number; amount: number; vendor?: string | null; reference?: string | null; method?: string; description?: string }
) {
  if (!(input.amount > 0)) throw badRequest('Amount must be positive');
  await assertBudgetAllows(client, ctx, Number(input.accountId), input.amount);
  const no = await client.query(`SELECT next_doc_no($1,$2,8) AS code`, [ctx.tenantId, 'EXP']);
  const ins = await client.query(
    `INSERT INTO expenses
       (company_id, tenant_id, branch_id, expense_no, expense_date, account_id, amount, method, reference, vendor, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'POSTED',$11) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, ctx.branchId ?? null, no.rows[0].code, input.expenseDate,
      input.accountId, input.amount, input.method ?? 'CASH', input.reference ?? null, input.vendor ?? null, ctx.userId ?? null,
    ]
  );
  const expenseId = Number(ins.rows[0].id);
  const bankId = await getAccountId(client, ctx, input.method === 'BANK' ? COA.DEFAULT_BANK : '1200');
  const desc = input.description ?? `Expense ${no.rows[0].code}`;
  const fromRule = await resolveEventLines(
    client, ctx, 'EXPENSE', { amount: input.amount },
    { substitute: { EXPENSE: Number(input.accountId), '6100': Number(input.accountId) }, description: desc }
  );
  const entryId = await postJournalLines(client, ctx, {
    entryDate: input.expenseDate,
    journalType: 'EXPENSE',
    description: desc,
    lines: fromRule ?? [
      { account_id: input.accountId, debit: input.amount, description: desc },
      { account_id: bankId, credit: input.amount, description: desc },
    ],
    refType: 'expenses',
    refId: expenseId,
    refCode: String(no.rows[0].code),
  });
  await client.query(`UPDATE expenses SET gl_posted = true, gl_journal_id = $1 WHERE id = $2`, [entryId, expenseId]);
  return { expenseId, expenseNo: no.rows[0].code, journalId: entryId };
}

// ============================================================
// Master data CRUD
// ============================================================

const ACCOUNT_TYPES = new Set([
  'ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE',
  'CONTRA_ASSET', 'CONTRA_LIABILITY', 'CONTRA_EQUITY', 'CONTRA_REVENUE', 'CONTRA_EXPENSE',
]);
const BANK_TYPES = new Set(['CURRENT', 'SAVINGS', 'MOBILE_MONEY', 'CASH']);
const TAX_TYPES = new Set(['VAT', 'WHT', 'EXCISE', 'WITHHOLDING_VAT']);
const PERIOD_STATUSES = new Set(['OPEN', 'LOCKED', 'CLOSED']);

function cleanCode(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

/** Build an UPDATE ... SET from an allow-list of column values. */
function buildSet(columns: Array<[string, unknown]>, offset: number): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [col, v] of columns) {
    if (v !== undefined) {
      values.push(v);
      sets.push(`${col} = $${values.length + offset}`);
    }
  }
  return { sets, values };
}

export async function createAccount(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    code: string; name: string; accountType: string; subtype?: string | null;
    parentId?: number | null; isPosting?: boolean; currency?: string; openingBalance?: number;
  }
) {
  const code = cleanCode(input.code);
  const name = String(input.name ?? '').trim();
  const type = String(input.accountType ?? '').toUpperCase();
  if (!code || !name) throw badRequest('Account code and name are required');
  if (!ACCOUNT_TYPES.has(type)) throw badRequest(`Unknown account type: ${type}`);
  const dup = await client.query('SELECT id FROM chart_of_accounts WHERE company_id = $1 AND code = $2', [ctx.companyId, code]);
  if (dup.rows.length) throw badRequest(`Account ${code} already exists`);
  if (input.parentId != null) {
    const p = await client.query('SELECT id FROM chart_of_accounts WHERE id = $1 AND tenant_id = $2', [input.parentId, ctx.tenantId]);
    if (!p.rows.length) throw badRequest('Parent account not found');
  }
  const res = await client.query(
    `INSERT INTO chart_of_accounts
       (company_id, tenant_id, code, name, account_type, subtype, parent_id, is_posting, currency, opening_balance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [ctx.companyId, ctx.tenantId, code, name, type, input.subtype ?? null, input.parentId ?? null,
     input.isPosting ?? true, input.currency ?? 'UGX', n(input.openingBalance)]
  );
  const row = toCamelRow(res.rows[0]);
  await logAudit(client, ctx, { action: 'create', resource: 'chart_of_accounts', recordId: Number(row.id), recordCode: code, newValues: { code, name, accountType: type } });
  return row;
}

export async function updateAccount(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: {
    name?: string; subtype?: string | null; parentId?: number | null; isPosting?: boolean;
    currency?: string; openingBalance?: number; isActive?: boolean;
  }
) {
  const cur = await client.query('SELECT * FROM chart_of_accounts WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  if (!cur.rows.length) throw notFound('Account not found');
  const { sets, values } = buildSet([
    ['name', input.name !== undefined ? String(input.name).trim() : undefined],
    ['subtype', input.subtype === undefined ? undefined : (input.subtype || null)],
    ['parent_id', input.parentId === undefined ? undefined : (input.parentId || null)],
    ['is_posting', input.isPosting === undefined ? undefined : Boolean(input.isPosting)],
    ['currency', input.currency === undefined ? undefined : String(input.currency)],
    ['opening_balance', input.openingBalance === undefined ? undefined : n(input.openingBalance)],
    ['is_active', input.isActive === undefined ? undefined : Boolean(input.isActive)],
  ], 2);
  if (!sets.length) return toCamelRow(cur.rows[0]);
  const res = await client.query(
    `UPDATE chart_of_accounts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId, ...values]
  );
  await logAudit(client, ctx, { action: 'update', resource: 'chart_of_accounts', recordId: id, recordCode: String(res.rows[0].code), newValues: { isActive: input.isActive } });
  return toCamelRow(res.rows[0]);
}

export async function deactivateAccount(client: pg.PoolClient, ctx: Ctx, id: number) {
  const used = await client.query(
    `SELECT count(*)::int AS n FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
     WHERE jl.account_id = $1 AND je.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (used.rows[0].n > 0) throw badRequest('Account has posted activity and cannot be deactivated');
  const res = await client.query(
    `UPDATE chart_of_accounts SET is_active = false, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Account not found');
  await logAudit(client, ctx, { action: 'deactivate', resource: 'chart_of_accounts', recordId: id, recordCode: String(res.rows[0].code), newValues: { is_active: false } });
  return toCamelRow(res.rows[0]);
}

export async function createBankAccount(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    code: string; name: string; bankName?: string | null; accountNo?: string | null;
    accountType?: string; currency?: string; openingBalance?: number; glAccountId?: number | null;
  }
) {
  const code = cleanCode(input.code);
  const name = String(input.name ?? '').trim();
  const type = String(input.accountType ?? 'CURRENT').toUpperCase();
  if (!code || !name) throw badRequest('Bank code and name are required');
  if (!BANK_TYPES.has(type)) throw badRequest(`Unknown bank account type: ${type}`);
  const dup = await client.query('SELECT id FROM bank_accounts WHERE company_id = $1 AND code = $2', [ctx.companyId, code]);
  if (dup.rows.length) throw badRequest(`Bank account ${code} already exists`);
  if (input.glAccountId != null) {
    const g = await client.query('SELECT id FROM chart_of_accounts WHERE id = $1 AND tenant_id = $2', [input.glAccountId, ctx.tenantId]);
    if (!g.rows.length) throw badRequest('Linked GL account not found');
  }
  const res = await client.query(
    `INSERT INTO bank_accounts
       (company_id, tenant_id, code, name, bank_name, account_no, account_type, currency, opening_balance, gl_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [ctx.companyId, ctx.tenantId, code, name, input.bankName ?? null, input.accountNo ?? null,
     type, input.currency ?? 'UGX', n(input.openingBalance), input.glAccountId ?? null]
  );
  const row = toCamelRow(res.rows[0]);
  await logAudit(client, ctx, { action: 'create', resource: 'bank_accounts', recordId: Number(row.id), recordCode: code, newValues: { code, name, accountType: type } });
  return row;
}

export async function updateBankAccount(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: {
    name?: string; bankName?: string | null; accountNo?: string | null; accountType?: string;
    currency?: string; openingBalance?: number; glAccountId?: number | null; isActive?: boolean;
  }
) {
  const cur = await client.query('SELECT * FROM bank_accounts WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  if (!cur.rows.length) throw notFound('Bank account not found');
  if (input.accountType !== undefined) {
    const type = String(input.accountType).toUpperCase();
    if (!BANK_TYPES.has(type)) throw badRequest(`Unknown bank account type: ${type}`);
  }
  const { sets, values } = buildSet([
    ['name', input.name !== undefined ? String(input.name).trim() : undefined],
    ['bank_name', input.bankName === undefined ? undefined : (input.bankName || null)],
    ['account_no', input.accountNo === undefined ? undefined : (input.accountNo || null)],
    ['account_type', input.accountType === undefined ? undefined : String(input.accountType).toUpperCase()],
    ['currency', input.currency === undefined ? undefined : String(input.currency)],
    ['opening_balance', input.openingBalance === undefined ? undefined : n(input.openingBalance)],
    ['gl_account_id', input.glAccountId === undefined ? undefined : (input.glAccountId || null)],
    ['is_active', input.isActive === undefined ? undefined : Boolean(input.isActive)],
  ], 2);
  if (!sets.length) return toCamelRow(cur.rows[0]);
  const res = await client.query(
    `UPDATE bank_accounts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId, ...values]
  );
  await logAudit(client, ctx, { action: 'update', resource: 'bank_accounts', recordId: id, recordCode: String(res.rows[0].code), newValues: { isActive: input.isActive } });
  return toCamelRow(res.rows[0]);
}

export async function deactivateBankAccount(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `UPDATE bank_accounts SET is_active = false, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Bank account not found');
  await logAudit(client, ctx, { action: 'deactivate', resource: 'bank_accounts', recordId: id, recordCode: String(res.rows[0].code), newValues: { is_active: false } });
  return toCamelRow(res.rows[0]);
}

export async function listBankTransactions(
  client: pg.PoolClient,
  ctx: Ctx,
  bankId: number,
  opts: { reconciled?: string; limit?: number } = {}
) {
  const params: unknown[] = [bankId, ctx.tenantId];
  const where = ['bt.bank_account_id = $1', 'ba.tenant_id = $2'];
  if (opts.reconciled !== undefined && opts.reconciled !== '') {
    params.push(opts.reconciled === 'true');
    where.push(`bt.reconciled = $${params.length}`);
  }
  params.push(Math.min(200, Math.max(1, opts.limit ?? 100)));
  const res = await client.query(
    `SELECT bt.*, ba.code AS bank_code, ba.name AS bank_name
     FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id
     WHERE ${where.join(' AND ')}
     ORDER BY bt.txn_date DESC, bt.id DESC LIMIT $${params.length}`,
    params
  );
  return toCamelRows(res.rows);
}

export async function setBankTransactionReconciled(
  client: pg.PoolClient,
  ctx: Ctx,
  bankId: number,
  txnId: number,
  reconciled: boolean
) {
  const res = await client.query(
    `UPDATE bank_transactions bt SET reconciled = $3
     FROM bank_accounts ba
     WHERE bt.id = $1 AND bt.bank_account_id = $2 AND ba.id = bt.bank_account_id AND ba.tenant_id = $4
     RETURNING bt.*`,
    [txnId, bankId, Boolean(reconciled), ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Bank transaction not found');
  await logAudit(client, ctx, { action: reconciled ? 'reconcile' : 'unreconcile', resource: 'bank_transactions', recordId: txnId, recordCode: String(res.rows[0].reference ?? txnId), newValues: { reconciled: Boolean(reconciled) } });
  return toCamelRow(res.rows[0]);
}

async function loadBankAccount(client: pg.PoolClient, ctx: Ctx, bankId: number) {
  const res = await client.query(
    `SELECT b.*, a.code AS gl_code,
            (b.opening_balance + COALESCE((
              SELECT sum(jl.debit - jl.credit) FROM journal_lines jl
              JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
              WHERE jl.account_id = b.gl_account_id
            ),0))::numeric AS book_balance
     FROM bank_accounts b
     LEFT JOIN chart_of_accounts a ON a.id = b.gl_account_id
     WHERE b.id = $1 AND b.tenant_id = $2`,
    [bankId, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Bank account not found');
  return res.rows[0];
}

async function openBankRecon(client: pg.PoolClient, ctx: Ctx, bankId: number) {
  const bank = await loadBankAccount(client, ctx, bankId);
  const existing = await client.query(
    `SELECT * FROM bank_reconciliations
     WHERE bank_account_id = $1 AND tenant_id = $2 AND status IN ('OPEN','SUBMITTED')
     ORDER BY id DESC LIMIT 1`,
    [bankId, ctx.tenantId]
  );
  if (existing.rows.length) return { bank, recon: existing.rows[0] };
  const no = await client.query(`SELECT next_doc_no($1,$2,8) AS code`, [ctx.tenantId, 'BRC']);
  const ins = await client.query(
    `INSERT INTO bank_reconciliations
       (company_id, tenant_id, bank_account_id, recon_no, statement_date, book_balance, status, created_by)
     VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,'OPEN',$6) RETURNING *`,
    [ctx.companyId, ctx.tenantId, bankId, String(no.rows[0].code), n(bank.book_balance), ctx.userId ?? null]
  );
  return { bank, recon: ins.rows[0] };
}

function reconLocked(status: string) {
  return status === 'APPROVED' || status === 'VOID';
}

export async function addBankStatementLine(
  client: pg.PoolClient,
  ctx: Ctx,
  bankId: number,
  input: { txnDate?: string; reference?: string | null; description?: string | null; debit?: number; credit?: number }
) {
  await loadBankAccount(client, ctx, bankId);
  const debit = round2(n(input.debit));
  const credit = round2(n(input.credit));
  if (debit < 0 || credit < 0) throw badRequest('Debit and credit cannot be negative');
  if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
    throw badRequest('Enter either an inflow (debit) or an outflow (credit)');
  }
  const res = await client.query(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, reference, description, debit, credit, reconciled)
     VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING *`,
    [
      bankId,
      isoDate(input.txnDate),
      input.reference != null ? String(input.reference).trim() || null : null,
      input.description != null ? String(input.description).trim() || null : null,
      debit,
      credit,
    ]
  );
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'bank_transactions',
    recordId: Number(res.rows[0].id),
    recordCode: String(res.rows[0].reference ?? res.rows[0].id),
    newValues: { debit, credit },
  });
  return toCamelRow(res.rows[0]);
}

export async function getBankRecon(client: pg.PoolClient, ctx: Ctx, bankId: number) {
  const { bank, recon } = await openBankRecon(client, ctx, bankId);
  const statement = await client.query(
    `SELECT bt.* FROM bank_transactions bt
     WHERE bt.bank_account_id = $1
     ORDER BY bt.txn_date DESC, bt.id DESC
     LIMIT 200`,
    [bankId]
  );
  const book = bank.gl_account_id
    ? await client.query(
        `SELECT jl.id, jl.debit, jl.credit, jl.description, jl.reconciled, jl.bank_transaction_id,
                je.id AS entry_id, je.entry_no, je.entry_date, je.reference_code, je.journal_type
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
         WHERE jl.account_id = $1 AND je.tenant_id = $2
         ORDER BY je.entry_date DESC, jl.id DESC
         LIMIT 200`,
        [bank.gl_account_id, ctx.tenantId]
      )
    : { rows: [] as Record<string, unknown>[] };
  const matches = await client.query(
    `SELECT m.id, m.bank_transaction_id, m.journal_line_id, m.match_method, m.amount
     FROM bank_reconciliation_matches m
     WHERE m.reconciliation_id = $1
     ORDER BY m.id`,
    [recon.id]
  );
  const unmatchedStatement = statement.rows.filter((r) => !r.reconciled).length;
  const unmatchedBook = book.rows.filter((r) => !r.reconciled).length;
  return {
    bank: toCamelRow(bank),
    recon: toCamelRow(recon),
    statement: toCamelRows(statement.rows),
    book: toCamelRows(book.rows),
    matches: toCamelRows(matches.rows),
    unmatchedStatement,
    unmatchedBook,
  };
}

async function applyMatch(
  client: pg.PoolClient,
  reconId: number,
  stmtId: number,
  lineId: number | null,
  method: string,
  amount: number
) {
  await client.query(
    `INSERT INTO bank_reconciliation_matches
       (reconciliation_id, bank_transaction_id, journal_line_id, match_method, amount)
     VALUES ($1,$2,$3,$4,$5)`,
    [reconId, stmtId, lineId, method, amount]
  );
  await client.query(`UPDATE bank_transactions SET reconciled = true WHERE id = $1`, [stmtId]);
  if (lineId) {
    await client.query(
      `UPDATE journal_lines SET reconciled = true, bank_transaction_id = $2 WHERE id = $1`,
      [lineId, stmtId]
    );
  }
}

export async function autoMatchBankRecon(client: pg.PoolClient, ctx: Ctx, bankId: number) {
  const { recon } = await openBankRecon(client, ctx, bankId);
  if (reconLocked(String(recon.status))) throw badRequest(`Reconciliation ${recon.recon_no} is ${recon.status}`);
  const workspace = await getBankRecon(client, ctx, bankId);
  const usedStmt = new Set<number>();
  const usedLine = new Set<number>();
  for (const m of workspace.matches) {
    usedStmt.add(Number(m.bankTransactionId));
    if (m.journalLineId != null) usedLine.add(Number(m.journalLineId));
  }
  const openStmt = workspace.statement.filter((s) => !s.reconciled && !usedStmt.has(Number(s.id)));
  const openBook = workspace.book.filter((b) => !b.reconciled && !usedLine.has(Number(b.id)));
  let matched = 0;
  for (const stmt of openStmt) {
    const debit = round2(n(stmt.debit));
    const credit = round2(n(stmt.credit));
    const stmtDate = isoDate(stmt.txnDate);
    const ref = String(stmt.reference ?? '').trim().toLowerCase();
    const candidates = openBook.filter((b) => {
      if (usedLine.has(Number(b.id))) return false;
      if (round2(n(b.debit)) !== debit || round2(n(b.credit)) !== credit) return false;
      const bookDate = isoDate(b.entryDate);
      const days = Math.abs((Date.parse(stmtDate) - Date.parse(bookDate)) / 86400000);
      return days <= 3;
    });
    if (!candidates.length) continue;
    const scored = candidates.map((b) => {
      const bookRef = String(b.referenceCode ?? '').trim().toLowerCase();
      const desc = `${String(b.description ?? '')} ${String(b.entryNo ?? '')}`.toLowerCase();
      let score = 1;
      let method = 'DATE';
      if (ref && (ref === bookRef || desc.includes(ref))) {
        score += 100;
        method = 'REFERENCE';
      }
      if (isoDate(b.entryDate) === stmtDate) {
        score += 10;
        if (method === 'DATE') method = 'EXACT';
      }
      return { line: b, score, method };
    });
    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 1 && scored[0].score === scored[1].score) continue;
    const pick = scored[0];
    await applyMatch(
      client,
      Number(recon.id),
      Number(stmt.id),
      Number(pick.line.id),
      pick.method,
      debit || credit
    );
    usedStmt.add(Number(stmt.id));
    usedLine.add(Number(pick.line.id));
    matched += 1;
  }
  await logAudit(client, ctx, {
    action: 'auto_match',
    resource: 'bank_reconciliations',
    recordId: Number(recon.id),
    recordCode: String(recon.recon_no),
    newValues: { matched },
  });
  const next = await getBankRecon(client, ctx, bankId);
  return { ...next, matched };
}

export async function matchBankRecon(
  client: pg.PoolClient,
  ctx: Ctx,
  bankId: number,
  input: { statementId: number; journalLineId: number }
) {
  const { recon } = await openBankRecon(client, ctx, bankId);
  if (reconLocked(String(recon.status))) throw badRequest(`Reconciliation ${recon.recon_no} is ${recon.status}`);
  const stmtId = Number(input.statementId);
  const lineId = Number(input.journalLineId);
  if (!stmtId || !lineId) throw badRequest('Statement line and journal line are required');
  const stmt = await client.query(
    `SELECT bt.* FROM bank_transactions bt
     JOIN bank_accounts ba ON ba.id = bt.bank_account_id
     WHERE bt.id = $1 AND bt.bank_account_id = $2 AND ba.tenant_id = $3`,
    [stmtId, bankId, ctx.tenantId]
  );
  if (!stmt.rows.length) throw notFound('Statement line not found');
  if (stmt.rows[0].reconciled) throw badRequest('Statement line is already matched');
  const line = await client.query(
    `SELECT jl.*, je.entry_no FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
     JOIN bank_accounts ba ON ba.gl_account_id = jl.account_id
     WHERE jl.id = $1 AND ba.id = $2 AND je.tenant_id = $3`,
    [lineId, bankId, ctx.tenantId]
  );
  if (!line.rows.length) throw notFound('Cashbook line not found on this bank GL');
  if (line.rows[0].reconciled) throw badRequest('Cashbook line is already matched');
  const amount = round2(n(stmt.rows[0].debit) || n(stmt.rows[0].credit));
  const bookAmt = round2(n(line.rows[0].debit) || n(line.rows[0].credit));
  if (amount !== bookAmt) throw badRequest(`Amounts do not match: statement ${amount} vs book ${bookAmt}`);
  await applyMatch(client, Number(recon.id), stmtId, lineId, 'MANUAL', amount);
  await logAudit(client, ctx, {
    action: 'match',
    resource: 'bank_reconciliations',
    recordId: Number(recon.id),
    recordCode: String(recon.recon_no),
    newValues: { statementId: stmtId, journalLineId: lineId },
  });
  return getBankRecon(client, ctx, bankId);
}

export async function unmatchBankRecon(client: pg.PoolClient, ctx: Ctx, bankId: number, matchId: number) {
  const { recon } = await openBankRecon(client, ctx, bankId);
  if (reconLocked(String(recon.status))) throw badRequest(`Reconciliation ${recon.recon_no} is ${recon.status}`);
  const m = await client.query(
    `SELECT * FROM bank_reconciliation_matches WHERE id = $1 AND reconciliation_id = $2`,
    [matchId, recon.id]
  );
  if (!m.rows.length) throw notFound('Match not found');
  const row = m.rows[0];
  await client.query(`DELETE FROM bank_reconciliation_matches WHERE id = $1`, [matchId]);
  await client.query(`UPDATE bank_transactions SET reconciled = false WHERE id = $1`, [row.bank_transaction_id]);
  if (row.journal_line_id) {
    await client.query(
      `UPDATE journal_lines SET reconciled = false, bank_transaction_id = NULL WHERE id = $1`,
      [row.journal_line_id]
    );
  }
  await logAudit(client, ctx, {
    action: 'unmatch',
    resource: 'bank_reconciliations',
    recordId: Number(recon.id),
    recordCode: String(recon.recon_no),
    newValues: { matchId },
  });
  return getBankRecon(client, ctx, bankId);
}

export async function submitBankRecon(client: pg.PoolClient, ctx: Ctx, bankId: number) {
  const { recon } = await openBankRecon(client, ctx, bankId);
  if (String(recon.status) !== 'OPEN') throw badRequest(`Reconciliation ${recon.recon_no} is ${recon.status}`);
  const res = await client.query(
    `UPDATE bank_reconciliations SET status = 'SUBMITTED', submitted_by = $3, submitted_at = now(), updated_at = now()
     WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [recon.id, ctx.tenantId, ctx.userId ?? null]
  );
  await logAudit(client, ctx, { action: 'submit', resource: 'bank_reconciliations', recordId: Number(recon.id), recordCode: String(recon.recon_no) });
  return toCamelRow(res.rows[0]);
}

export async function approveBankRecon(
  client: pg.PoolClient,
  ctx: Ctx,
  bankId: number,
  input: { statementBalance?: number | null; notes?: string | null } = {}
) {
  const { recon, bank } = await openBankRecon(client, ctx, bankId);
  if (!['OPEN', 'SUBMITTED'].includes(String(recon.status))) {
    throw badRequest(`Reconciliation ${recon.recon_no} is ${recon.status}`);
  }
  const statementBalance = input.statementBalance != null ? n(input.statementBalance) : n(recon.statement_balance);
  const res = await client.query(
    `UPDATE bank_reconciliations
        SET status = 'APPROVED', approved_by = $3, approved_at = now(),
            statement_balance = COALESCE($4, statement_balance),
            book_balance = $5,
            notes = COALESCE($6, notes),
            updated_at = now()
     WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [recon.id, ctx.tenantId, ctx.userId ?? null, statementBalance || null, n(bank.book_balance), input.notes ?? null]
  );
  await logAudit(client, ctx, { action: 'approve', resource: 'bank_reconciliations', recordId: Number(recon.id), recordCode: String(recon.recon_no) });
  return toCamelRow(res.rows[0]);
}

export async function listCashTransfers(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { limit?: number } = {}
) {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  const res = await client.query(
    `SELECT ct.*, f.code AS from_code, f.name AS from_name, t.code AS to_code, t.name AS to_name
     FROM cash_transfers ct
     JOIN bank_accounts f ON f.id = ct.from_bank_id
     JOIN bank_accounts t ON t.id = ct.to_bank_id
     WHERE ct.tenant_id = $1
     ORDER BY ct.transfer_date DESC, ct.id DESC
     LIMIT $2`,
    [ctx.tenantId, limit]
  );
  return toCamelRows(res.rows);
}

/** Latest stored exchange rate for a currency (UGX per 1 foreign unit). Returns rate: null when none is on file. */
export async function getLatestExchangeRate(client: pg.PoolClient, ctx: Ctx, currencyCode: string) {
  const code = String(currencyCode ?? '').trim().toUpperCase();
  if (!code) throw badRequest('Currency code is required');
  if (code === 'UGX') return { currencyCode: code, rate: 1, rateDate: null };
  const res = await client.query(
    `SELECT rate, rate_date FROM exchange_rates
     WHERE currency_code = $1 AND rate_date <= CURRENT_DATE
     ORDER BY rate_date DESC LIMIT 1`,
    [code]
  );
  if (!res.rows.length) return { currencyCode: code, rate: null, rateDate: null };
  return { currencyCode: code, rate: Number(res.rows[0].rate), rateDate: String(res.rows[0].rate_date) };
}

export async function createCashTransfer(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    fromBankId: number;
    toBankId: number;
    amount: number;
    transferDate?: string;
    reference?: string | null;
    notes?: string | null;
    exchangeRate?: number;
  }
) {
  const amount = n(input.amount);
  if (!(amount > 0)) throw badRequest('Transfer amount must be positive');
  const fromId = Number(input.fromBankId);
  const toId = Number(input.toBankId);
  if (!fromId || !toId) throw badRequest('Source and target accounts are required');
  if (fromId === toId) throw badRequest('Source and target accounts must be different');

  const banks = await client.query(
    `SELECT b.*, a.code AS gl_code FROM bank_accounts b
     LEFT JOIN chart_of_accounts a ON a.id = b.gl_account_id
     WHERE b.id = ANY($1::bigint[]) AND b.tenant_id = $2 AND b.is_active = true`,
    [[fromId, toId], ctx.tenantId]
  );
  if (banks.rows.length !== 2) throw badRequest('Both accounts must be active bank or cash accounts');
  const byId = new Map(banks.rows.map((r) => [Number(r.id), r]));
  const from = byId.get(fromId);
  const to = byId.get(toId);
  if (!from || !to) throw badRequest('Both accounts must be active bank or cash accounts');
  if (!from.gl_account_id || !to.gl_account_id) {
    throw badRequest(
      `Both accounts need a linked GL account to post a transfer (${String(from.code)} linked to ${String(from.gl_code ?? 'none')}, ${String(to.code)} linked to ${String(to.gl_code ?? 'none')})`
    );
  }

  const fromCurrency = String(from.currency ?? 'UGX');
  const toCurrency = String(to.currency ?? 'UGX');
  const transferDate = isoDate(input.transferDate);
  const reference = input.reference != null ? String(input.reference).trim() : null;
  const notes = input.notes != null ? String(input.notes).trim() : null;

  // Cross-currency conversion. exchange_rate follows the system convention:
  // base (UGX) units per 1 unit of the foreign currency (e.g. 3,800 UGX/USD).
  let exchangeRate = 1;
  let toAmount = amount;
  let baseAmount = amount;
  if (fromCurrency !== toCurrency) {
    exchangeRate = n(input.exchangeRate);
    if (!(exchangeRate > 0)) {
      const foreign = fromCurrency === 'UGX' ? toCurrency : fromCurrency;
      const stored = await client.query(
        `SELECT rate FROM exchange_rates WHERE currency_code = $1 AND rate_date <= CURRENT_DATE ORDER BY rate_date DESC LIMIT 1`,
        [foreign]
      );
      exchangeRate = stored.rows.length ? Number(stored.rows[0].rate) : 0;
    }
    if (!(exchangeRate > 0)) {
      throw badRequest(`Exchange rate required to transfer from ${fromCurrency} to ${toCurrency}`);
    }
    const rateFrom = fromCurrency === 'UGX' ? 1 : exchangeRate;
    const rateTo = toCurrency === 'UGX' ? 1 : exchangeRate;
    toAmount = round2((amount * rateFrom) / rateTo);
    baseAmount = round2(amount * rateFrom);
  }

  const no = await client.query(`SELECT next_doc_no($1,$2,8) AS code`, [ctx.tenantId, 'TRF']);
  const transferNo = String(no.rows[0].code);

  const ins = await client.query(
    `INSERT INTO cash_transfers
       (company_id, tenant_id, branch_id, transfer_no, transfer_date, from_bank_id, to_bank_id, amount, to_amount, exchange_rate, from_currency, to_currency, reference, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [ctx.companyId, ctx.tenantId, ctx.branchId ?? null, transferNo, transferDate, fromId, toId, amount, toAmount, exchangeRate, fromCurrency, toCurrency, reference, notes, ctx.userId ?? null]
  );
  const transferId = Number(ins.rows[0].id);

  const description = notes ?? `Internal transfer ${transferNo}: ${String(from.code)} \u2192 ${String(to.code)}${fromCurrency !== toCurrency ? ` @ ${exchangeRate} ${fromCurrency}/${toCurrency}` : ''}`;
  const entryId = await postJournalLines(client, ctx, {
    entryDate: transferDate,
    journalType: 'TRANSFER',
    description,
    lines: [
      { account_id: Number(to.gl_account_id), debit: baseAmount, description: `Transfer from ${String(from.code)} (${transferNo})` },
      { account_id: Number(from.gl_account_id), credit: baseAmount, description: `Transfer to ${String(to.code)} (${transferNo})` },
    ],
    refType: 'cash_transfers',
    refId: transferId,
    refCode: transferNo,
  });

  await client.query(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, reference, description, debit, credit, reconciled) VALUES
       ($1,$2,$3,$4,0,$5,false),
       ($6,$2,$3,$7,$8,0,false)`,
    [fromId, transferDate, transferNo, `Transfer to ${String(to.code)} (${transferNo})`, amount, toId, `Transfer from ${String(from.code)} (${transferNo})`, toAmount]
  );

  await client.query(`UPDATE cash_transfers SET journal_id = $1 WHERE id = $2`, [entryId, transferId]);
  await logAudit(client, ctx, { action: 'create', resource: 'cash_transfers', recordId: transferId, recordCode: transferNo, newValues: { transferDate, fromBankId: fromId, toBankId: toId, amount, toAmount, exchangeRate, fromCurrency, toCurrency, reference, journalId: entryId } });
  return { transferId, transferNo, journalId: entryId, transferDate, fromBankId: fromId, toBankId: toId, amount, toAmount, exchangeRate, fromCurrency, toCurrency };
}

// ============================================================
// Staff cash advances / imprest
// ============================================================

export async function createCashAdvance(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    advanceDate?: string;
    employeeId?: number | null;
    holderName?: string | null;
    bankId: number;
    amount: number;
    purpose?: string | null;
    reference?: string | null;
    exchangeRate?: number;
  }
) {
  const amount = n(input.amount);
  if (!(amount > 0)) throw badRequest('Advance amount must be positive');
  const bankId = Number(input.bankId);
  if (!bankId) throw badRequest('Source bank or cash account is required');

  const bankRes = await client.query(
    `SELECT b.*, a.code AS gl_code FROM bank_accounts b
     LEFT JOIN chart_of_accounts a ON a.id = b.gl_account_id
     WHERE b.id = $1 AND b.tenant_id = $2 AND b.is_active = true`,
    [bankId, ctx.tenantId]
  );
  if (!bankRes.rows.length) throw badRequest('Source account must be an active bank or cash account');
  const bank = bankRes.rows[0];
  if (!bank.gl_account_id) {
    throw badRequest(
      `Source account ${String(bank.code)} needs a linked GL account to post an advance (linked to ${String(bank.gl_code ?? 'none')})`
    );
  }

  let employeeId: number | null = null;
  let holderName = input.holderName != null ? String(input.holderName).trim() : '';
  if (input.employeeId != null && Number(input.employeeId) > 0) {
    const emp = await client.query(
      `SELECT id, employee_no, first_name, last_name FROM employees WHERE id = $1 AND tenant_id = $2`,
      [Number(input.employeeId), ctx.tenantId]
    );
    if (!emp.rows.length) throw badRequest('Employee not found');
    employeeId = Number(emp.rows[0].id);
    if (!holderName) {
      const e = emp.rows[0];
      holderName = `${String(e.first_name)} ${String(e.last_name)}`.trim();
    }
  }
  if (!holderName) throw badRequest('Holder name is required (or select an employee)');

  const currency = String(bank.currency ?? 'UGX');
  const advanceDate = isoDate(input.advanceDate);
  const purpose = input.purpose != null ? String(input.purpose).trim() : null;
  const reference = input.reference != null ? String(input.reference).trim() : null;

  // Cross-currency conversion: exchange_rate follows the system convention of
  // base (UGX) units per 1 foreign unit (e.g. 3,800 UGX/USD).
  let exchangeRate = 1;
  let baseAmount = amount;
  if (currency !== 'UGX') {
    exchangeRate = n(input.exchangeRate);
    if (!(exchangeRate > 0)) {
      const stored = await client.query(
        `SELECT rate FROM exchange_rates WHERE currency_code = $1 AND rate_date <= CURRENT_DATE ORDER BY rate_date DESC LIMIT 1`,
        [currency]
      );
      exchangeRate = stored.rows.length ? Number(stored.rows[0].rate) : 0;
    }
    if (!(exchangeRate > 0)) throw badRequest(`Exchange rate required to issue an advance in ${currency}`);
    baseAmount = round2(amount * exchangeRate);
  }

  const no = await client.query(`SELECT next_doc_no($1,$2,8) AS code`, [ctx.tenantId, 'ADV']);
  const advanceNo = String(no.rows[0].code);

  const ins = await client.query(
    `INSERT INTO cash_advances
       (company_id, tenant_id, branch_id, advance_no, advance_date, employee_id, holder_name, bank_id, currency, exchange_rate, base_amount, amount, purpose, reference, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'POSTED',$15) RETURNING id`,
    [ctx.companyId, ctx.tenantId, ctx.branchId ?? null, advanceNo, advanceDate, employeeId, holderName, bankId, currency, exchangeRate, baseAmount, amount, purpose, reference, ctx.userId ?? null]
  );
  const advanceId = Number(ins.rows[0].id);

  const description = purpose ?? `Staff advance ${advanceNo} to ${holderName}`;
  const entryId = await postJournalLines(client, ctx, {
    entryDate: advanceDate,
    journalType: 'CASH_ADVANCE',
    description,
    lines: [
      { account_id: Number(await getAccountId(client, ctx, COA.OTHER_RECV)), debit: baseAmount, description: `Advance to ${holderName} (${advanceNo})` },
      { account_id: Number(bank.gl_account_id), credit: baseAmount, description: `Advance ${advanceNo} to ${holderName}` },
    ],
    refType: 'cash_advances',
    refId: advanceId,
    refCode: advanceNo,
  });

  await client.query(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, reference, description, debit, credit, reconciled) VALUES ($1,$2,$3,$4,0,$5,false)`,
    [bankId, advanceDate, advanceNo, `Advance ${advanceNo} to ${holderName}`, amount]
  );

  await client.query(`UPDATE cash_advances SET gl_posted = true, gl_journal_id = $1 WHERE id = $2`, [entryId, advanceId]);
  await logAudit(client, ctx, { action: 'create', resource: 'cash_advances', recordId: advanceId, recordCode: advanceNo, newValues: { advanceDate, employeeId, holderName, bankId, amount, baseAmount, exchangeRate, currency, purpose, reference, journalId: entryId } });
  return { advanceId, advanceNo, journalId: entryId, advanceDate, employeeId, holderName, bankId, amount, baseAmount, exchangeRate, currency, status: 'POSTED' };
}

export async function listCashAdvances(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['a.tenant_id = $1', 'a.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(a.advance_no ILIKE $${params.length} OR a.holder_name ILIKE $${params.length} OR a.reference ILIKE $${params.length} OR a.purpose ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`a.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT a.*, b.code AS bank_code, b.name AS bank_name,
            (a.base_amount - a.settled_amount)::numeric AS outstanding
     FROM cash_advances a
     JOIN bank_accounts b ON b.id = a.bank_id
     WHERE ${where.join(' AND ')}
     ORDER BY a.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = await client.query(
    `SELECT count(*)::int AS n FROM cash_advances a WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(res.rows), total: Number(total.rows[0].n), page, pageSize };
}

export async function getCashAdvance(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT a.*, b.code AS bank_code, b.name AS bank_name,
            (a.base_amount - a.settled_amount)::numeric AS outstanding
     FROM cash_advances a JOIN bank_accounts b ON b.id = a.bank_id
     WHERE a.id = $1 AND a.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Advance not found');
  const advance = toCamelRow(res.rows[0]);
  const settlements = await client.query(
    `SELECT s.*, a.code AS account_code, a.name AS account_name
     FROM advance_settlements s JOIN chart_of_accounts a ON a.id = s.account_id
     WHERE s.advance_id = $1 ORDER BY s.id DESC`,
    [id]
  );
  let journal = null;
  if (advance.glJournalId != null) journal = await getJournal(client, ctx, Number(advance.glJournalId));
  return { advance, settlements: toCamelRows(settlements.rows), journal };
}

export async function settleCashAdvance(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: {
    settlementDate?: string;
    amount: number;
    accountId: number;
    method?: string;
    reference?: string | null;
    notes?: string | null;
  }
) {
  const res = await client.query('SELECT * FROM cash_advances WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, ctx.tenantId]);
  if (!res.rows.length) throw notFound('Advance not found');
  const adv = res.rows[0];
  if (adv.status === 'VOID') throw badRequest('A voided advance cannot be settled');
  if (adv.status === 'SETTLED') throw badRequest('Advance is already fully settled');
  const amount = n(input.amount);
  if (!(amount > 0)) throw badRequest('Settlement amount must be positive');
  const outstanding = n(adv.base_amount) - n(adv.settled_amount);
  if (amount > outstanding + 0.005) throw badRequest(`Settlement ${amount} exceeds the outstanding balance of ${outstanding}`);
  const accountId = Number(input.accountId);
  if (!accountId) throw badRequest('Expense or asset account is required');
  const acc = await client.query(
    'SELECT id FROM chart_of_accounts WHERE id = $1 AND tenant_id = $2 AND is_active = true',
    [accountId, ctx.tenantId]
  );
  if (!acc.rows.length) throw badRequest('Settlement account not found or inactive');

  const method = String(input.method ?? 'CASH').toUpperCase();
  if (!['CASH', 'BANK'].includes(method)) throw badRequest('Settlement method must be CASH or BANK');
  const settlementDate = isoDate(input.settlementDate);
  const reference = input.reference != null ? String(input.reference).trim() : null;
  const notes = input.notes != null ? String(input.notes).trim() : null;

  const no = await client.query(`SELECT next_doc_no($1,$2,8) AS code`, [ctx.tenantId, 'ADVS']);
  const settlementNo = String(no.rows[0].code);

  const ins = await client.query(
    `INSERT INTO advance_settlements
       (company_id, tenant_id, branch_id, advance_id, settlement_no, settlement_date, amount, account_id, method, reference, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [ctx.companyId, ctx.tenantId, ctx.branchId ?? null, id, settlementNo, settlementDate, amount, accountId, method, reference, notes, ctx.userId ?? null]
  );
  const settlementId = Number(ins.rows[0].id);

  const otherRecvId = await getAccountId(client, ctx, COA.OTHER_RECV);
  const description = notes ?? `Advance settlement ${settlementNo} for ${String(adv.advance_no)}`;
  const entryId = await postJournalLines(client, ctx, {
    entryDate: settlementDate,
    journalType: 'ADVANCE_SETTLEMENT',
    description,
    lines: [
      { account_id: accountId, debit: amount, description: `Settlement of ${String(adv.advance_no)}` },
      { account_id: otherRecvId, credit: amount, description: `Settlement ${settlementNo}` },
    ],
    refType: 'advance_settlements',
    refId: settlementId,
    refCode: settlementNo,
  });

  const newSettled = round2(n(adv.settled_amount) + amount);
  const fullySettled = newSettled >= n(adv.base_amount) - 0.005;
  const newStatus = fullySettled ? 'SETTLED' : String(adv.status);
  await client.query(
    `UPDATE cash_advances SET settled_amount = $1, status = $2, updated_at = now() WHERE id = $3`,
    [newSettled, newStatus, id]
  );
  await client.query(`UPDATE advance_settlements SET gl_posted = true, gl_journal_id = $1 WHERE id = $2`, [entryId, settlementId]);
  await logAudit(client, ctx, { action: 'settle', resource: 'cash_advances', recordId: id, recordCode: String(adv.advance_no), newValues: { settlementId, settlementNo, settlementDate, amount, accountId, method, reference, journalId: entryId, status: newStatus } });
  return { settlementId, settlementNo, journalId: entryId, advanceId: id, amount, status: newStatus, outstanding: fullySettled ? 0 : round2(n(adv.base_amount) - newSettled) };
}

export async function voidCashAdvance(client: pg.PoolClient, ctx: Ctx, id: number, reason: string) {
  const res = await client.query('SELECT * FROM cash_advances WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, ctx.tenantId]);
  if (!res.rows.length) throw notFound('Advance not found');
  const adv = res.rows[0];
  if (adv.status === 'VOID') throw badRequest('Advance is already void');
  if (n(adv.settled_amount) > 0) throw badRequest('An advance with settlements cannot be voided; settle or remove the settlements first');
  if (adv.gl_posted && adv.gl_journal_id) {
    await voidJournal(client, ctx, Number(adv.gl_journal_id), reason || 'Advance voided');
  }
  await client.query(
    `UPDATE cash_advances SET status = 'VOID', voided_by = $2, voided_at = now(), updated_at = now() WHERE id = $1`,
    [id, ctx.userId ?? null]
  );
  await logAudit(client, ctx, { action: 'void', resource: 'cash_advances', recordId: id, recordCode: String(adv.advance_no), newValues: { status: 'VOID', reason } });
  return { advanceId: id, advanceNo: String(adv.advance_no), status: 'VOID' };
}

export async function createPeriod(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { code: string; name: string; startDate: string; endDate: string; status?: string }
) {
  const code = cleanCode(input.code);
  const name = String(input.name ?? '').trim();
  const start = isoDate(input.startDate);
  const end = isoDate(input.endDate);
  if (!code || !name) throw badRequest('Period code and name are required');
  if (start > end) throw badRequest('Period start date must be before end date');
  const status = String(input.status ?? 'OPEN').toUpperCase();
  if (!PERIOD_STATUSES.has(status)) throw badRequest(`Unknown period status: ${status}`);
  const dup = await client.query('SELECT id FROM financial_periods WHERE company_id = $1 AND code = $2', [ctx.companyId, code]);
  if (dup.rows.length) throw badRequest(`Period ${code} already exists`);
  const overlap = await client.query(
    `SELECT code FROM financial_periods
     WHERE company_id = $1 AND start_date <= $2::date AND end_date >= $3::date LIMIT 1`,
    [ctx.companyId, end, start]
  );
  if (overlap.rows.length) throw badRequest(`Period overlaps existing period ${overlap.rows[0].code}`);
  const res = await client.query(
    `INSERT INTO financial_periods (company_id, tenant_id, code, name, start_date, end_date, status, opened_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [ctx.companyId, ctx.tenantId, code, name, start, end, status, ctx.userId ?? null]
  );
  const row = toCamelRow(res.rows[0]);
  await logAudit(client, ctx, { action: 'create', resource: 'financial_periods', recordId: Number(row.id), recordCode: code, newValues: { code, name, start, end, status } });
  return row;
}

export async function listTaxes(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT t.*, a.code AS account_code, a.name AS account_name
     FROM taxes t LEFT JOIN chart_of_accounts a ON a.id = t.account_id
     WHERE t.tenant_id = $1 AND t.company_id = $2
     ORDER BY t.code`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function createTax(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { code: string; name: string; taxType?: string; rate: number; accountId?: number | null }
) {
  const code = cleanCode(input.code);
  const name = String(input.name ?? '').trim();
  const type = String(input.taxType ?? 'VAT').toUpperCase();
  if (!code || !name) throw badRequest('Tax code and name are required');
  if (!TAX_TYPES.has(type)) throw badRequest(`Unknown tax type: ${type}`);
  if (!(n(input.rate) > 0)) throw badRequest('Tax rate must be positive');
  const dup = await client.query('SELECT id FROM taxes WHERE company_id = $1 AND code = $2', [ctx.companyId, code]);
  if (dup.rows.length) throw badRequest(`Tax ${code} already exists`);
  if (input.accountId != null) {
    const g = await client.query('SELECT id FROM chart_of_accounts WHERE id = $1 AND tenant_id = $2', [input.accountId, ctx.tenantId]);
    if (!g.rows.length) throw badRequest('Linked account not found');
  }
  const res = await client.query(
    `INSERT INTO taxes (company_id, tenant_id, code, name, tax_type, rate, account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [ctx.companyId, ctx.tenantId, code, name, type, n(input.rate), input.accountId ?? null]
  );
  const row = toCamelRow(res.rows[0]);
  await logAudit(client, ctx, { action: 'create', resource: 'taxes', recordId: Number(row.id), recordCode: code, newValues: { code, name, taxType: type, rate: n(input.rate) } });
  return row;
}

export async function updateTax(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: { name?: string; taxType?: string; rate?: number; accountId?: number | null; isActive?: boolean }
) {
  const cur = await client.query('SELECT * FROM taxes WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  if (!cur.rows.length) throw notFound('Tax not found');
  if (input.taxType !== undefined) {
    const type = String(input.taxType).toUpperCase();
    if (!TAX_TYPES.has(type)) throw badRequest(`Unknown tax type: ${type}`);
  }
  const { sets, values } = buildSet([
    ['name', input.name !== undefined ? String(input.name).trim() : undefined],
    ['tax_type', input.taxType === undefined ? undefined : String(input.taxType).toUpperCase()],
    ['rate', input.rate === undefined ? undefined : n(input.rate)],
    ['account_id', input.accountId === undefined ? undefined : (input.accountId || null)],
    ['is_active', input.isActive === undefined ? undefined : Boolean(input.isActive)],
  ], 2);
  if (!sets.length) return toCamelRow(cur.rows[0]);
  const res = await client.query(
    `UPDATE taxes SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, ctx.tenantId, ...values]
  );
  await logAudit(client, ctx, { action: 'update', resource: 'taxes', recordId: id, recordCode: String(res.rows[0].code), newValues: { isActive: input.isActive } });
  return toCamelRow(res.rows[0]);
}

// ============================================================
// Expenses
// ============================================================

export async function listExpenses(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['e.tenant_id = $1', 'e.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(e.expense_no ILIKE $${params.length} OR e.vendor ILIKE $${params.length} OR e.reference ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`e.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT e.*, a.code AS account_code, a.name AS account_name
     FROM expenses e JOIN chart_of_accounts a ON a.id = e.account_id
     WHERE ${where.join(' AND ')}
     ORDER BY e.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = await client.query(
    `SELECT count(*)::int AS n FROM expenses e WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(res.rows), total: Number(total.rows[0].n), page, pageSize };
}

export async function getExpense(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT e.*, a.code AS account_code, a.name AS account_name
     FROM expenses e JOIN chart_of_accounts a ON a.id = e.account_id
     WHERE e.id = $1 AND e.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Expense not found');
  const expense = toCamelRow(res.rows[0]);
  let journal = null;
  if (expense.glJournalId != null) {
    journal = await getJournal(client, ctx, Number(expense.glJournalId));
  }
  return { expense, journal };
}

export async function voidExpense(client: pg.PoolClient, ctx: Ctx, id: number, reason: string) {
  const res = await client.query('SELECT * FROM expenses WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, ctx.tenantId]);
  if (!res.rows.length) throw notFound('Expense not found');
  const ex = res.rows[0];
  if (ex.status === 'VOID') throw badRequest('Expense is already void');
  if (ex.gl_posted && ex.gl_journal_id) {
    await voidJournal(client, ctx, Number(ex.gl_journal_id), reason || 'Expense voided');
  }
  await client.query(`UPDATE expenses SET status = 'VOID' WHERE id = $1`, [id]);
  await logAudit(client, ctx, { action: 'void', resource: 'expenses', recordId: id, recordCode: String(ex.expense_no), newValues: { status: 'VOID' } });
  return { expenseId: id, expenseNo: String(ex.expense_no), status: 'VOID' };
}

// ============================================================
// Journal draft editing
// ============================================================

export async function updateJournal(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: {
    entryDate?: string;
    description?: string;
    lines?: Array<{ accountId: number; debit?: number; credit?: number; description?: string }>;
  }
) {
  const res = await client.query('SELECT * FROM journal_entries WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  if (!res.rows.length) throw notFound('Journal entry not found');
  if (res.rows[0].status !== 'DRAFT') {
    throw badRequest(`Only draft journals can be edited (current status: ${res.rows[0].status})`);
  }
  const entry = res.rows[0];
  const entryDate = input.entryDate !== undefined ? isoDate(input.entryDate) : String(entry.entry_date).slice(0, 10);
  const description = input.description !== undefined ? String(input.description).trim() : String(entry.description);
  if (!description) throw badRequest('Description is required');

  const curLines = await client.query('SELECT debit, credit FROM journal_lines WHERE entry_id = $1', [id]);
  const curDebit = curLines.rows.reduce((s, r) => s + n(r.debit), 0);
  const curCredit = curLines.rows.reduce((s, r) => s + n(r.credit), 0);
  const lines = input.lines ?? [];
  if (lines.length > 0) {
    if (lines.length < 2) throw badRequest('A journal needs at least two lines');
    const debit = lines.reduce((s, l) => s + n(l.debit), 0);
    const credit = lines.reduce((s, l) => s + n(l.credit), 0);
    if (Math.round(debit * 100) !== Math.round(credit * 100)) {
      throw badRequest(`Journal does not balance: debit ${debit} vs credit ${credit}`);
    }
    if (debit <= 0) throw badRequest('Journal amount must be positive');
  }

  await assertPeriodOpen(client, ctx, entryDate);
  const debit = lines.length ? lines.reduce((s, l) => s + n(l.debit), 0) : curDebit;
  const credit = lines.length ? lines.reduce((s, l) => s + n(l.credit), 0) : curCredit;
  await client.query(
    `UPDATE journal_entries
     SET entry_date = $1, description = $2, total_debit = $3, total_credit = $4, updated_at = now()
     WHERE id = $5`,
    [entryDate, description, debit, credit, id]
  );
  if (lines.length) {
    await client.query('DELETE FROM journal_lines WHERE entry_id = $1', [id]);
    for (const l of lines) {
      await client.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit, credit, description)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, Number(l.accountId), n(l.debit), n(l.credit), l.description ?? description]
      );
    }
  }
  await logAudit(client, ctx, { action: 'update', resource: 'journal_entries', recordId: id, recordCode: String(entry.entry_no), newValues: { entryDate, description } });
  return getJournal(client, ctx, id);
}

// ============================================================
// Budgets
// ============================================================

export async function listBudgets(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['b.tenant_id = $1', 'b.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`b.budget_no ILIKE $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`b.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT b.*,
            COALESCE(sum(bl.amount),0)::numeric AS lines_total,
            count(bl.id)::int AS line_count
     FROM budgets b LEFT JOIN budget_lines bl ON bl.budget_id = b.id
     WHERE ${where.join(' AND ')}
     GROUP BY b.id
     ORDER BY b.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = await client.query(
    `SELECT count(*)::int AS n FROM budgets b WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(res.rows), total: Number(total.rows[0].n), page, pageSize };
}

export async function getBudget(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT * FROM budgets WHERE id = $1 AND tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Budget not found');
  const lines = await client.query(
    `SELECT bl.*, a.code AS account_code, a.name AS account_name, a.account_type
     FROM budget_lines bl JOIN chart_of_accounts a ON a.id = bl.account_id
     WHERE bl.budget_id = $1 ORDER BY bl.id`,
    [id]
  );
  const enriched = [];
  let committed = 0;
  let actual = 0;
  for (const row of lines.rows) {
    const pos = await budgetPosition(client, ctx, Number(row.account_id));
    committed += pos.committed;
    actual += pos.actual;
    enriched.push({
      ...toCamelRow(row),
      committed: pos.committed,
      actual: pos.actual,
      available: pos.available,
      consumption: n(row.amount) > 0 ? round2(((pos.committed + pos.actual) / n(row.amount)) * 100) : 0,
    });
  }
  const approved = n(res.rows[0].amount);
  return {
    budget: {
      ...toCamelRow(res.rows[0]),
      committed: round2(committed),
      actual: round2(actual),
      available: round2(approved - committed - actual),
    },
    lines: enriched,
  };
}

interface BudgetLineInput {
  accountId: number;
  amount: number;
}

export async function createBudget(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    periodStart: string;
    periodEnd: string;
    amount?: number;
    status?: string;
    lines: BudgetLineInput[];
  }
) {
  const start = isoDate(input.periodStart);
  const end = isoDate(input.periodEnd);
  if (start > end) throw badRequest('Budget period start must be before end');
  const lines = (input.lines ?? []).filter((l) => Number(l.accountId) && n(l.amount) > 0);
  if (!lines.length) throw badRequest('At least one budget line with a positive amount is required');
  const amount = n(input.amount) || lines.reduce((s, l) => s + n(l.amount), 0);
  const status = String(input.status ?? 'DRAFT').toUpperCase();
  if (!['DRAFT', 'SUBMITTED'].includes(status)) throw badRequest(`Invalid budget status: ${status}`);
  const no = await client.query(`SELECT next_doc_no($1,$2,8) AS code`, [ctx.tenantId, 'BUD']);
  const budgetNo = String(no.rows[0].code);
  const ins = await client.query(
    `INSERT INTO budgets (company_id, tenant_id, budget_no, period_start, period_end, amount, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [ctx.companyId, ctx.tenantId, budgetNo, start, end, amount, status]
  );
  const budgetId = Number(ins.rows[0].id);
  for (const l of lines) {
    await client.query(
      `INSERT INTO budget_lines (budget_id, account_id, amount) VALUES ($1,$2,$3)`,
      [budgetId, Number(l.accountId), n(l.amount)]
    );
  }
  await logAudit(client, ctx, { action: 'create', resource: 'budgets', recordId: budgetId, recordCode: budgetNo, newValues: { start, end, amount, status } });
  return getBudget(client, ctx, budgetId);
}

export async function updateBudget(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: {
    periodStart?: string;
    periodEnd?: string;
    amount?: number;
    lines?: BudgetLineInput[];
  }
) {
  const cur = await client.query('SELECT * FROM budgets WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  if (!cur.rows.length) throw notFound('Budget not found');
  const b = cur.rows[0];
  if (!['DRAFT', 'SUBMITTED'].includes(String(b.status))) {
    throw badRequest(`Only DRAFT or SUBMITTED budgets can be edited (current status: ${b.status})`);
  }
  const start = input.periodStart !== undefined ? isoDate(input.periodStart) : isoDate(b.period_start);
  const end = input.periodEnd !== undefined ? isoDate(input.periodEnd) : isoDate(b.period_end);
  if (start > end) throw badRequest('Budget period start must be before end');
  const lines = input.lines === undefined
    ? undefined
    : input.lines.filter((l) => Number(l.accountId) && n(l.amount) > 0);
  if (lines !== undefined && !lines.length) throw badRequest('At least one budget line with a positive amount is required');
  const amount = lines !== undefined
    ? (n(input.amount) || lines.reduce((s, l) => s + n(l.amount), 0))
    : (n(input.amount) || n(b.amount));
  await client.query(
    `UPDATE budgets SET period_start = $1, period_end = $2, amount = $3, updated_at = now() WHERE id = $4`,
    [start, end, amount, id]
  );
  if (lines !== undefined) {
    await client.query('DELETE FROM budget_lines WHERE budget_id = $1', [id]);
    for (const l of lines) {
      await client.query(
        `INSERT INTO budget_lines (budget_id, account_id, amount) VALUES ($1,$2,$3)`,
        [id, Number(l.accountId), n(l.amount)]
      );
    }
  }
  await logAudit(client, ctx, { action: 'update', resource: 'budgets', recordId: id, recordCode: String(b.budget_no), newValues: { start, end, amount } });
  return getBudget(client, ctx, id);
}

const BUDGET_ACTIONS: Record<string, { from: string[]; to: string }> = {
  submit: { from: ['DRAFT'], to: 'SUBMITTED' },
  approve: { from: ['DRAFT', 'SUBMITTED'], to: 'APPROVED' },
  close: { from: ['APPROVED', 'ACTIVE'], to: 'CLOSED' },
};

export async function setBudgetStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  action: 'submit' | 'approve' | 'close'
) {
  const rule = BUDGET_ACTIONS[action];
  if (!rule) throw badRequest(`Unknown budget action: ${action}`);
  const res = await client.query('SELECT * FROM budgets WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, ctx.tenantId]);
  if (!res.rows.length) throw notFound('Budget not found');
  const b = res.rows[0];
  if (!rule.from.includes(String(b.status))) {
    throw badRequest(`Budget is ${b.status} and cannot be ${action}ed`);
  }
  await client.query(
    `UPDATE budgets SET status = $1, approved_by = $2, approved_at = CASE WHEN $1 = 'APPROVED' THEN now() ELSE approved_at END, updated_at = now()
     WHERE id = $3`,
    [rule.to, ctx.userId ?? null, id]
  );
  await logAudit(client, ctx, { action, resource: 'budgets', recordId: id, recordCode: String(b.budget_no), newValues: { status: rule.to } });
  return getBudget(client, ctx, id);
}
