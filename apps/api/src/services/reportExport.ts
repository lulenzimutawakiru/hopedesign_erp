/**
 * Branded report export/print builders.
 *
 * Every accounting report in this registry is *computed* by the same service
 * functions that power the interactive JSON endpoints (`finance.ts`), then
 * flattened into a branded document shape for the shared export pipeline
 * (`brandedExport.ts`). Nothing here is derived or invented — each figure
 * resolves to a posted journal line or an aggregated ledger view, exactly as
 * the on-screen report does.
 *
 * `rows` cells are pre-formatted display strings (thousands separators, two
 * decimals for money) so the PDF / print renderers show accounting-grade
 * numbers, while the XLSX renderer re-coerces them back into numeric cells via
 * `toExcelValue`.
 */

import pg from 'pg';
import type { Ctx } from '../db.js';
import type { BrandedTableColumn } from './brandedExport.js';
import * as fin from './finance.js';

export interface ReportBuild {
  title: string;
  subtitle: string;
  kicker?: string;
  columns: BrandedTableColumn[];
  rows: Array<Record<string, unknown>>;
  facts: Array<[string, string]>;
}

export type ReportBuilder = (
  client: pg.PoolClient,
  ctx: Ctx,
  q: Record<string, unknown>
) => Promise<ReportBuild>;

export interface ReportDef {
  key: string;
  label: string;
  builder: ReportBuilder;
}

const num = (v: unknown): number => {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Accounting-grade money string: 12,500.00 (empty for zero unless forced). */
const money = (v: unknown): string =>
  num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const str = (v: unknown): string => (v == null ? '' : String(v));

/** Date column values pass through untouched (the renderer formats Date/ISO). */
const date = (v: unknown): unknown => v ?? '';

const RIGHT = 'right' as const;

/** A labelled section header row for a two-column statement. */
const section = (key: string, label: string): Record<string, unknown> => ({ [key]: label.toUpperCase() });

// ---------------------------------------------------------------------------
// Statement / ledger builders
// ---------------------------------------------------------------------------

const trialBalanceBuilder: ReportBuilder = async (client, ctx, q) => {
  const from = q.from != null ? String(q.from) : undefined;
  const to = q.to != null ? String(q.to) : undefined;
  const { rows, totals } = await fin.trialBalance(client, ctx, from, to);
  return {
    title: 'Trial Balance',
    subtitle: periodLabel(from, to),
    kicker: 'Accounting report',
    columns: [
      { key: 'code', label: 'Code' },
      { key: 'name', label: 'Account' },
      { key: 'accountType', label: 'Type' },
      { key: 'debit', label: 'Debit', align: RIGHT },
      { key: 'credit', label: 'Credit', align: RIGHT },
      { key: 'balance', label: 'Balance', align: RIGHT },
    ],
    rows: rows.map((r) => ({
      code: str(r.code),
      name: str(r.name),
      accountType: str(r.accountType),
      debit: money(r.debit),
      credit: money(r.credit),
      balance: money(r.balance),
    })),
    facts: [
      ['Period', periodLabel(from, to)],
      ['Total Debit', money(totals.debit)],
      ['Total Credit', money(totals.credit)],
      ['Net', money(totals.balance)],
    ],
  };
};

const profitLossBuilder: ReportBuilder = async (client, ctx, q) => {
  const to = q.to != null ? String(q.to) : today();
  const from = q.from != null ? String(q.from) : `${to.slice(0, 4)}-01-01`;
  const r = await fin.profitAndLoss(client, ctx, from, to);
  const isRevenue = (t: string) => t === 'REVENUE' || t === 'CONTRA_REVENUE';
  const isExpense = (t: string) => t === 'EXPENSE' || t === 'CONTRA_EXPENSE';
  const revenueRows = r.rows.filter((x) => isRevenue(String(x.accountType)));
  const expenseRows = r.rows.filter((x) => isExpense(String(x.accountType)));
  const rows: Array<Record<string, unknown>> = [];
  rows.push(section('code', 'Revenue'));
  for (const x of revenueRows) rows.push({ code: str(x.code), name: str(x.name), amount: money(x.amount) });
  rows.push({ code: 'Total revenue', name: '', amount: money(r.revenue) });
  rows.push(section('code', 'Expenses'));
  for (const x of expenseRows) rows.push({ code: str(x.code), name: str(x.name), amount: money(x.amount) });
  rows.push({ code: 'Total expenses', name: '', amount: money(r.expense) });
  rows.push({ code: 'Net profit / (loss)', name: '', amount: money(r.profit) });
  return {
    title: 'Profit & Loss',
    subtitle: periodLabel(from, to),
    kicker: 'Accounting report',
    columns: [
      { key: 'code', label: 'Account' },
      { key: 'name', label: 'Account name' },
      { key: 'amount', label: 'Amount', align: RIGHT },
    ],
    rows,
    facts: [
      ['Period', periodLabel(from, to)],
      ['Revenue', money(r.revenue)],
      ['Expenses', money(r.expense)],
      ['Net profit', money(r.profit)],
    ],
  };
};

const balanceSheetBuilder: ReportBuilder = async (client, ctx, q) => {
  const asOf = q.asOf != null ? String(q.asOf) : today();
  const r = await fin.balanceSheet(client, ctx, asOf);
  const asset = (t: string) => t === 'ASSET' || t === 'CONTRA_ASSET';
  const liability = (t: string) => t === 'LIABILITY' || t === 'CONTRA_LIABILITY';
  const equity = (t: string) => t === 'EQUITY' || t === 'CONTRA_EQUITY';
  const assetRows = r.rows.filter((x) => asset(String(x.accountType)));
  const liabilityRows = r.rows.filter((x) => liability(String(x.accountType)));
  const equityRows = r.rows.filter((x) => equity(String(x.accountType)));
  // Liabilities and equity carry a negative sign from the ledger (credit
  // balances); display them as positive amounts for a conventional statement.
  const rows: Array<Record<string, unknown>> = [];
  rows.push(section('code', 'Assets'));
  for (const x of assetRows) rows.push({ code: str(x.code), name: str(x.name), amount: money(x.amount) });
  rows.push({ code: 'Total assets', name: '', amount: money(r.assets) });
  rows.push(section('code', 'Liabilities'));
  for (const x of liabilityRows) rows.push({ code: str(x.code), name: str(x.name), amount: money(-num(x.amount)) });
  rows.push({ code: 'Total liabilities', name: '', amount: money(-r.liabilities) });
  rows.push(section('code', 'Equity'));
  for (const x of equityRows) rows.push({ code: str(x.code), name: str(x.name), amount: money(-num(x.amount)) });
  rows.push({ code: 'Current period result', name: '', amount: money(r.currentResult) });
  rows.push({ code: 'Total equity', name: '', amount: money(-r.equity) });
  rows.push({ code: 'Total liabilities & equity', name: '', amount: money(-r.totalLAndE) });
  return {
    title: 'Balance Sheet',
    subtitle: `As at ${formatDate(asOf)}`,
    kicker: 'Accounting report',
    columns: [
      { key: 'code', label: 'Account' },
      { key: 'name', label: 'Account name' },
      { key: 'amount', label: 'Amount', align: RIGHT },
    ],
    rows,
    facts: [
      ['As at', formatDate(asOf)],
      ['Total assets', money(r.assets)],
      ['Total liabilities', money(-r.liabilities)],
      ['Total equity', money(-r.equity)],
      ['Liabilities & equity', money(-r.totalLAndE)],
    ],
  };
};

const cashFlowBuilder: ReportBuilder = async (client, ctx, q) => {
  const to = q.to != null ? String(q.to) : today();
  const from = q.from != null ? String(q.from) : `${to.slice(0, 4)}-01-01`;
  const r = await fin.cashFlowStatement(client, ctx, from, to);
  const rows: Array<Record<string, unknown>> = [];
  for (const s of r.sections) {
    rows.push(section('item', s.label));
    for (const l of s.lines) rows.push({ item: l.label, amount: money(l.amount) });
    rows.push({ item: `${s.label} — net`, amount: money(s.total) });
  }
  rows.push(section('item', 'Summary'));
  rows.push({ item: 'Net cash movement', amount: money(r.netCashChange) });
  rows.push({ item: 'Opening cash', amount: money(r.openingCash) });
  rows.push({ item: 'Closing cash', amount: money(r.closingCash) });
  return {
    title: 'Cash Flow Statement',
    subtitle: periodLabel(from, to),
    kicker: 'Accounting report',
    columns: [
      { key: 'item', label: 'Item' },
      { key: 'amount', label: 'Amount', align: RIGHT },
    ],
    rows,
    facts: [
      ['Period', periodLabel(from, to)],
      ['Opening cash', money(r.openingCash)],
      ['Net change', money(r.netCashChange)],
      ['Closing cash', money(r.closingCash)],
    ],
  };
};

const generalLedgerBuilder: ReportBuilder = async (client, ctx, q) => {
  const { rows, totals } = await fin.generalLedger(client, ctx, {
    accountId: q.accountId != null ? Number(q.accountId) : undefined,
    from: q.from != null ? String(q.from) : undefined,
    to: q.to != null ? String(q.to) : undefined,
  });
  return {
    title: 'General Ledger',
    subtitle: periodLabel(
      q.from != null ? String(q.from) : undefined,
      q.to != null ? String(q.to) : undefined
    ),
    kicker: 'Accounting report',
    columns: [
      { key: 'entryDate', label: 'Date' },
      { key: 'entryNo', label: 'Entry' },
      { key: 'accountCode', label: 'Account' },
      { key: 'accountName', label: 'Account name' },
      { key: 'description', label: 'Description' },
      { key: 'debit', label: 'Debit', align: RIGHT },
      { key: 'credit', label: 'Credit', align: RIGHT },
      { key: 'balance', label: 'Balance', align: RIGHT },
    ],
    rows: rows.map((r) => ({
      entryDate: date(r.entryDate),
      entryNo: str(r.entryNo),
      accountCode: str(r.accountCode),
      accountName: str(r.accountName),
      description: str(r.lineDescription || r.entryDescription),
      debit: money(r.debit),
      credit: money(r.credit),
      balance: money(r.balance),
    })),
    facts: [
      ['Total Debit', money(totals.debit)],
      ['Total Credit', money(totals.credit)],
      ['Movement', money(totals.movement)],
    ],
  };
};

const partnerLedgerBuilder: ReportBuilder = async (client, ctx, q) => {
  const partnerType = q.partnerType === 'supplier' ? 'supplier' : 'customer';
  const r = await fin.partnerLedger(client, ctx, {
    partnerType,
    partnerId: q.partnerId != null ? Number(q.partnerId) : undefined,
    from: q.from != null ? String(q.from) : undefined,
    to: q.to != null ? String(q.to) : undefined,
  });
  return {
    title: partnerType === 'supplier' ? 'Supplier Ledger' : 'Customer Ledger',
    subtitle: periodLabel(
      q.from != null ? String(q.from) : undefined,
      q.to != null ? String(q.to) : undefined
    ),
    kicker: 'Accounting report',
    columns: [
      { key: 'docDate', label: 'Date' },
      { key: 'partnerName', label: partnerType === 'supplier' ? 'Supplier' : 'Customer' },
      { key: 'docNo', label: 'Document' },
      { key: 'docType', label: 'Type' },
      { key: 'description', label: 'Description' },
      { key: 'debit', label: 'Debit', align: RIGHT },
      { key: 'credit', label: 'Credit', align: RIGHT },
      { key: 'balance', label: 'Balance', align: RIGHT },
    ],
    rows: r.rows.map((x) => ({
      docDate: date(x.docDate),
      partnerName: str(x.partnerName),
      docNo: str(x.docNo),
      docType: str(x.docType),
      description: str(x.label),
      debit: money(x.debit),
      credit: money(x.credit),
      balance: money(x.balance),
    })),
    facts: [
      ['Partners', String(r.partners.length)],
      ['Total Debit', money(r.totals.debit)],
      ['Total Credit', money(r.totals.credit)],
    ],
  };
};

const customerStatementBuilder: ReportBuilder = async (client, ctx, q) => {
  const partnerId = q.partnerId != null ? Number(q.partnerId) : undefined;
  const r = await fin.partnerLedger(client, ctx, {
    partnerType: 'customer',
    partnerId,
    from: q.from != null ? String(q.from) : undefined,
    to: q.to != null ? String(q.to) : undefined,
  });
  const partnerName = r.rows[0] ? str(r.rows[0].partnerName) : '';
  return {
    title: 'Customer Statement',
    subtitle: [
      partnerName,
      periodLabel(q.from != null ? String(q.from) : undefined, q.to != null ? String(q.to) : undefined),
    ]
      .filter(Boolean)
      .join(' · '),
    kicker: 'Account statement',
    columns: [
      { key: 'docDate', label: 'Date' },
      { key: 'docNo', label: 'Document' },
      { key: 'docType', label: 'Type' },
      { key: 'description', label: 'Description' },
      { key: 'debit', label: 'Debit', align: RIGHT },
      { key: 'credit', label: 'Credit', align: RIGHT },
      { key: 'balance', label: 'Balance', align: RIGHT },
    ],
    rows: r.rows.map((x) => ({
      docDate: date(x.docDate),
      docNo: str(x.docNo),
      docType: str(x.docType),
      description: str(x.label),
      debit: money(x.debit),
      credit: money(x.credit),
      balance: money(x.balance),
    })),
    facts: [
      ['Customer', partnerName || '—'],
      ['Total Debit', money(r.totals.debit)],
      ['Total Credit', money(r.totals.credit)],
      ['Outstanding', money(num(r.totals.debit) - num(r.totals.credit))],
    ],
  };
};

const arBuilder: ReportBuilder = async (client, ctx, q) => {
  const r = await fin.arLedger(client, ctx, { bucket: q.bucket != null ? String(q.bucket) : undefined });
  return {
    title: 'Aged Receivables',
    subtitle: `${r.rows.length} open invoice${r.rows.length === 1 ? '' : 's'}`,
    kicker: 'Accounting report',
    columns: [
      { key: 'invoiceNo', label: 'Invoice' },
      { key: 'customerName', label: 'Customer' },
      { key: 'invoiceDate', label: 'Invoice date' },
      { key: 'dueDate', label: 'Due date' },
      { key: 'total', label: 'Total', align: RIGHT },
      { key: 'amountPaid', label: 'Paid', align: RIGHT },
      { key: 'balance', label: 'Balance', align: RIGHT },
      { key: 'bucket', label: 'Aging bucket' },
      { key: 'daysOverdue', label: 'Days overdue', align: RIGHT },
    ],
    rows: r.rows.map((x) => ({
      invoiceNo: str(x.invoiceNo),
      customerName: str(x.customerName),
      invoiceDate: date(x.invoiceDate),
      dueDate: date(x.dueDate),
      total: money(x.total),
      amountPaid: money(x.amountPaid),
      balance: money(x.balance),
      bucket: str(x.bucket),
      daysOverdue: str(x.daysOverdue),
    })),
    facts: [
      ['Total outstanding', money(r.total)],
      ['Overdue', money(r.overdue)],
      ['Open invoices', String(r.rows.length)],
    ],
  };
};

const apBuilder: ReportBuilder = async (client, ctx, q) => {
  const r = await fin.apLedger(client, ctx, { bucket: q.bucket != null ? String(q.bucket) : undefined });
  return {
    title: 'Aged Payables',
    subtitle: `${r.rows.length} open bill${r.rows.length === 1 ? '' : 's'}`,
    kicker: 'Accounting report',
    columns: [
      { key: 'invoiceNo', label: 'Invoice' },
      { key: 'supplierName', label: 'Supplier' },
      { key: 'invoiceDate', label: 'Invoice date' },
      { key: 'dueDate', label: 'Due date' },
      { key: 'total', label: 'Total', align: RIGHT },
      { key: 'amountPaid', label: 'Paid', align: RIGHT },
      { key: 'balance', label: 'Balance', align: RIGHT },
      { key: 'bucket', label: 'Aging bucket' },
      { key: 'daysOverdue', label: 'Days overdue', align: RIGHT },
    ],
    rows: r.rows.map((x) => ({
      invoiceNo: str(x.supplierInvoiceNo),
      supplierName: str(x.supplierName),
      invoiceDate: date(x.invoiceDate),
      dueDate: date(x.dueDate),
      total: money(x.total),
      amountPaid: money(x.amountPaid),
      balance: money(x.balance),
      bucket: str(x.bucket),
      daysOverdue: str(x.daysOverdue),
    })),
    facts: [
      ['Total outstanding', money(r.total)],
      ['Overdue', money(r.overdue)],
      ['Open bills', String(r.rows.length)],
    ],
  };
};

const taxBuilder: ReportBuilder = async (client, ctx, q) => {
  const to = q.to != null ? String(q.to) : today();
  const from = q.from != null ? String(q.from) : `${to.slice(0, 4)}-01-01`;
  const r = await fin.taxSummary(client, ctx, from, to);
  return {
    title: 'Tax Summary',
    subtitle: periodLabel(from, to),
    kicker: 'Accounting report',
    columns: [
      { key: 'item', label: 'Item' },
      { key: 'amount', label: 'Amount', align: RIGHT },
    ],
    rows: [
      { item: 'Output VAT', amount: money(r.outputVat) },
      { item: 'Input VAT', amount: money(r.inputVat) },
      { item: 'Net VAT payable', amount: money(r.netVat) },
    ],
    facts: [
      ['Period', periodLabel(from, to)],
      ['Output VAT', money(r.outputVat)],
      ['Input VAT', money(r.inputVat)],
      ['Net VAT', money(r.netVat)],
    ],
  };
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const REPORT_DEFS: Record<string, ReportDef> = {
  'trial-balance': { key: 'trial-balance', label: 'Trial Balance', builder: trialBalanceBuilder },
  'profit-loss': { key: 'profit-loss', label: 'Profit & Loss', builder: profitLossBuilder },
  'balance-sheet': { key: 'balance-sheet', label: 'Balance Sheet', builder: balanceSheetBuilder },
  'cash-flow': { key: 'cash-flow', label: 'Cash Flow Statement', builder: cashFlowBuilder },
  'general-ledger': { key: 'general-ledger', label: 'General Ledger', builder: generalLedgerBuilder },
  'partner-ledger': { key: 'partner-ledger', label: 'Partner Ledger', builder: partnerLedgerBuilder },
  'customer-statement': { key: 'customer-statement', label: 'Customer Statement', builder: customerStatementBuilder },
  ar: { key: 'ar', label: 'Aged Receivables', builder: arBuilder },
  ap: { key: 'ap', label: 'Aged Payables', builder: apBuilder },
  tax: { key: 'tax', label: 'Tax Summary', builder: taxBuilder },
};

export function reportDef(key: string): ReportDef | undefined {
  return REPORT_DEFS[String(key ?? '').toLowerCase()];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function periodLabel(from?: string, to?: string): string {
  if (from && to) return `${formatDate(from)} — ${formatDate(to)}`;
  if (from) return `From ${formatDate(from)}`;
  if (to) return `To ${formatDate(to)}`;
  return 'All periods';
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function formatDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v;
  const mm = Number(m[2]);
  const mon = mm >= 1 && mm <= 12 ? MONTHS[mm - 1] : m[2];
  return `${Number(m[3])} ${mon} ${m[1]}`;
}
