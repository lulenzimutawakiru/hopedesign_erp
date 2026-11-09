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
import * as assets from './assets.js';
import * as loans from './loans.js';
import * as sales from './sales.js';
import * as advanced from './finance-advanced.js';
import * as efrisReports from './efris/reports.js';
import * as expenses from './expenses.js';

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

const depreciationScheduleBuilder: ReportBuilder = async (client, ctx) => {
  const r = await assets.listDepreciations(client, ctx, { pageSize: 500 });
  const totals = r.rows.reduce(
    (acc, x) => ({
      cost: acc.cost + num(x.purchase_cost),
      accumulated: acc.accumulated + num(x.accumulated_depreciation),
      book: acc.book + num(x.current_book_value),
    }),
    { cost: 0, accumulated: 0, book: 0 }
  );
  return {
    title: 'Depreciation Schedule',
    subtitle: `${r.total} asset${r.total === 1 ? '' : 's'} under depreciation`,
    kicker: 'Assets report',
    columns: [
      { key: 'assetNo', label: 'Asset no.' },
      { key: 'asset', label: 'Asset' },
      { key: 'method', label: 'Method' },
      { key: 'capitalized', label: 'Capitalized' },
      { key: 'usefulLife', label: 'Life (mths)' },
      { key: 'residual', label: 'Residual', align: RIGHT },
      { key: 'cost', label: 'Cost', align: RIGHT },
      { key: 'accumulated', label: 'Acc. depr.', align: RIGHT },
      { key: 'bookValue', label: 'Book value', align: RIGHT },
      { key: 'lastPosted', label: 'Last posted' },
    ],
    rows: r.rows.map((x) => ({
      assetNo: str(x.asset_no),
      asset: str(x.asset_name),
      method: str(x.method),
      capitalized: date(x.capitalization_date),
      usefulLife: str(x.useful_life_months),
      residual: money(x.residual_value),
      cost: money(x.purchase_cost),
      accumulated: money(x.accumulated_depreciation),
      bookValue: money(x.current_book_value),
      lastPosted: date(x.last_posted_period),
    })),
    facts: [
      ['Assets', String(r.total)],
      ['Total cost', money(totals.cost)],
      ['Accumulated depreciation', money(totals.accumulated)],
      ['Net book value', money(totals.book)],
    ],
  };
};

const loansAnalysisBuilder: ReportBuilder = async (client, ctx) => {
  const r = await loans.listLoans(client, ctx, { pageSize: 200 });
  const principal = r.items.reduce((s, x) => s + num(x.amount), 0);
  const outstanding = r.items.reduce((s, x) => s + num(x.outstandingBalance), 0);
  return {
    title: 'Loans Analysis',
    subtitle: `${r.total} employee loan${r.total === 1 ? '' : 's'}`,
    kicker: 'Payroll report',
    columns: [
      { key: 'loanNo', label: 'Loan no.' },
      { key: 'employeeNo', label: 'Employee no.' },
      { key: 'employee', label: 'Employee' },
      { key: 'position', label: 'Position' },
      { key: 'amount', label: 'Principal', align: RIGHT },
      { key: 'outstanding', label: 'Outstanding', align: RIGHT },
      { key: 'interestRate', label: 'Interest %' },
      { key: 'tenure', label: 'Tenure (mths)' },
      { key: 'monthlyDeduction', label: 'Monthly deduction', align: RIGHT },
      { key: 'startDate', label: 'Start' },
      { key: 'endDate', label: 'End' },
      { key: 'status', label: 'Status' },
    ],
    rows: r.items.map((x) => ({
      loanNo: str(x.loanNo),
      employeeNo: str(x.employeeNo),
      employee: `${str(x.firstName)} ${str(x.lastName)}`.trim(),
      position: str(x.position),
      amount: money(x.amount),
      outstanding: money(x.outstandingBalance),
      interestRate: str(x.interestRate),
      tenure: str(x.tenureMonths),
      monthlyDeduction: money(x.monthlyDeduction),
      startDate: date(x.startDate),
      endDate: date(x.endDate),
      status: str(x.status),
    })),
    facts: [
      ['Loans', String(r.total)],
      ['Principal', money(principal)],
      ['Repaid', money(principal - outstanding)],
      ['Outstanding', money(outstanding)],
    ],
  };
};

const invoiceAnalysisBuilder: ReportBuilder = async (client, ctx) => {
  const rows0 = await sales.listInvoices(client, ctx, {});
  const totals = rows0.reduce<{ total: number; paid: number }>(
    (acc, x) => ({ total: acc.total + num(x.total), paid: acc.paid + num(x.amountPaid) }),
    { total: 0, paid: 0 }
  );
  return {
    title: 'Invoice Analysis',
    subtitle: `${rows0.length} recent invoice${rows0.length === 1 ? '' : 's'}`,
    kicker: 'Sales report',
    columns: [
      { key: 'invoiceNo', label: 'Invoice' },
      { key: 'customer', label: 'Customer' },
      { key: 'code', label: 'Customer code' },
      { key: 'invoiceDate', label: 'Invoice date' },
      { key: 'dueDate', label: 'Due date' },
      { key: 'total', label: 'Total', align: RIGHT },
      { key: 'paid', label: 'Paid', align: RIGHT },
      { key: 'balance', label: 'Balance', align: RIGHT },
      { key: 'status', label: 'Status' },
      { key: 'orderNo', label: 'Order' },
    ],
    rows: rows0.map((x) => ({
      invoiceNo: str(x.invoiceNo),
      customer: str(x.customerName),
      code: str(x.customerCode),
      invoiceDate: date(x.invoiceDate),
      dueDate: date(x.dueDate),
      total: money(x.total),
      paid: money(x.amountPaid),
      balance: money(num(x.total) - num(x.amountPaid)),
      status: str(x.status),
      orderNo: str(x.orderNo),
    })),
    facts: [
      ['Invoices', String(rows0.length)],
      ['Invoiced', money(totals.total)],
      ['Collected', money(totals.paid)],
      ['Outstanding', money(totals.total - totals.paid)],
    ],
  };
};

const fiscalReportBuilder: ReportBuilder = async (client, ctx, q) => {
  const from = q.from != null ? String(q.from) : null;
  const to = q.to != null ? String(q.to) : null;
  const r = await efrisReports.dailyFiscalizedSales(client, ctx, { from, to });
  return {
    title: 'Fiscal Report',
    subtitle: `Fiscalised sales ${periodLabel(r.range.from, r.range.to)}`,
    kicker: 'EFRIS report',
    columns: [
      { key: 'txnDate', label: 'Date' },
      { key: 'docCount', label: 'Documents' },
      { key: 'withFdn', label: 'With FDN' },
      { key: 'gross', label: 'Gross', align: RIGHT },
      { key: 'tax', label: 'Tax', align: RIGHT },
    ],
    rows: r.days.map((x) => ({
      txnDate: date(x.txnDate),
      docCount: str(x.docCount),
      withFdn: str(x.withFdn),
      gross: money(x.grossTotal),
      tax: money(x.taxTotal),
    })),
    facts: [
      ['Period', periodLabel(r.range.from, r.range.to)],
      ['Documents', String(r.totals.docCount)],
      ['Gross total', money(r.totals.grossTotal)],
      ['Tax total', money(r.totals.taxTotal)],
      ['Scope', 'FISCALIZED sales documents only'],
    ],
  };
};

const analyticReportBuilder: ReportBuilder = async (client, ctx, q) => {
  const filters = {
    from: q.from != null ? String(q.from) : undefined,
    to: q.to != null ? String(q.to) : undefined,
  };
  const r = await advanced.costCentreActivity(client, ctx, filters);
  const col = (budget: boolean) => {
    const cols: BrandedTableColumn[] = [
      { key: 'code', label: 'Code' },
      { key: 'name', label: 'Cost centre' },
      { key: 'status', label: 'Status' },
      { key: 'debit', label: 'Charges', align: RIGHT },
      { key: 'credit', label: 'Recoveries', align: RIGHT },
      { key: 'net', label: 'Net', align: RIGHT },
      { key: 'entries', label: 'Entries', align: RIGHT },
    ];
    if (budget) cols.push({ key: 'budget', label: 'Budget', align: RIGHT });
    return cols;
  };
  return {
    title: 'Cost Centre Analysis',
    subtitle: periodLabel(r.from, r.to),
    kicker: 'Analytic accounting',
    columns: col(true),
    rows: r.rows.map((x) => ({
      code: str(x.code),
      name: str(x.name),
      status: str(x.status),
      debit: money(x.debit),
      credit: money(x.credit),
      net: money(x.net),
      entries: str(x.entries),
      budget: x.budget == null ? '' : money(x.budget),
    })),
    facts: [
      ['Period', periodLabel(r.from, r.to)],
      ['Total charges', money(r.totals.debit)],
      ['Total recoveries', money(r.totals.credit)],
      ['Net', money(r.totals.net)],
      ['Unallocated net', money(r.unallocated.net)],
    ],
  };
};

const profitCentreBuilder: ReportBuilder = async (client, ctx, q) => {
  const filters = {
    from: q.from != null ? String(q.from) : undefined,
    to: q.to != null ? String(q.to) : undefined,
  };
  const r = await advanced.profitCentreActivity(client, ctx, filters);
  return {
    title: 'Profit Centre Analysis',
    subtitle: periodLabel(r.from, r.to),
    kicker: 'Analytic accounting',
    columns: [
      { key: 'code', label: 'Code' },
      { key: 'name', label: 'Profit centre' },
      { key: 'status', label: 'Status' },
      { key: 'debit', label: 'Charges', align: RIGHT },
      { key: 'credit', label: 'Recoveries', align: RIGHT },
      { key: 'net', label: 'Net', align: RIGHT },
      { key: 'entries', label: 'Entries', align: RIGHT },
    ],
    rows: r.rows.map((x) => ({
      code: str(x.code),
      name: str(x.name),
      status: str(x.status),
      debit: money(x.debit),
      credit: money(x.credit),
      net: money(x.net),
      entries: str(x.entries),
    })),
    facts: [
      ['Period', periodLabel(r.from, r.to)],
      ['Total charges', money(r.totals.debit)],
      ['Total recoveries', money(r.totals.credit)],
      ['Net', money(r.totals.net)],
      ['Unallocated net', money(r.unallocated.net)],
    ],
  };
};

const executiveSummaryBuilder: ReportBuilder = async (client, ctx) => {
  const r = await fin.financeSummary(client, ctx);
  return {
    title: 'Executive Summary',
    subtitle: `As at ${formatDate(r.asOf)}`,
    kicker: 'Management report',
    columns: [
      { key: 'month', label: 'Month' },
      { key: 'revenue', label: 'Revenue', align: RIGHT },
      { key: 'expense', label: 'Expense', align: RIGHT },
      { key: 'profit', label: 'Profit', align: RIGHT },
    ],
    rows: r.trend.map((t) => ({
      month: str(t.month),
      revenue: money(t.revenue),
      expense: money(t.expense),
      profit: money(t.profit),
    })),
    facts: [
      ['As at', formatDate(r.asOf)],
      ['Month revenue', money(r.monthRevenue)],
      ['Month expense', money(r.monthExpense)],
      ['Month profit', money(r.monthProfit)],
      ['Receivables', money(r.ar)],
      ['Payables', money(r.ap)],
      ['Cash', money(r.cash)],
      ['AR overdue', money(r.arOverdue)],
      ['AP overdue', money(r.apOverdue)],
      ['DSO (days)', str(r.dso)],
      ['DPO (days)', str(r.dpo)],
      ['Trial balance', r.trialBalanceOk ? 'Balanced' : 'OUT OF BALANCE'],
    ],
  };
};

// ---------------------------------------------------------------------------
// Employee expense / reimbursement reports (reuse the spend module services)
// ---------------------------------------------------------------------------

const EXPENSE_GROUP_LABEL: Record<string, string> = {
  category: 'Category',
  department: 'Department',
  costCentre: 'Cost centre',
  project: 'Project',
  supplier: 'Supplier',
  employee: 'Employee',
  paymentMethod: 'Payment method',
};

/** Shared shape for a grouped expense report (by category, department, …). */
function expenseGroupBuilder(groupBy: string, title: string): ReportBuilder {
  return async (client, ctx, q) => {
    const r = await expenses.expenseReports(client, ctx, { from: q.from, to: q.to, groupBy });
    const rows = (r.grouped ?? []) as Record<string, unknown>[];
    const grand = rows.reduce((s, x) => s + num(x.total), 0);
    return {
      title,
      subtitle: periodLabel(str(q.from), str(q.to)),
      kicker: 'Expense report',
      columns: [
        { key: 'dimension', label: EXPENSE_GROUP_LABEL[groupBy] ?? 'Group' },
        { key: 'count', label: 'Count', align: RIGHT },
        { key: 'total', label: 'Total', align: RIGHT },
      ],
      rows: rows.map((x) => ({
        dimension: str(x.label),
        count: str(x.count),
        total: money(x.total),
      })),
      facts: [
        ['Scope', periodLabel(str(q.from), str(q.to))],
        ['Groups', String(rows.length)],
        ['Grand total', money(grand)],
      ],
    };
  };
}

const expenseRegisterBuilder: ReportBuilder = async (client, ctx, q) => {
  const r = await expenses.listExpenses(client, ctx, {
    from: q.from,
    to: q.to,
    status: q.status,
    pageSize: 500,
  });
  const rows = (r.rows ?? []) as Record<string, unknown>[];
  const grand = rows.reduce((s, x) => s + num(x.amount), 0);
  return {
    title: 'Expense Register',
    subtitle: `${r.total} expense${r.total === 1 ? '' : 's'}${q.status ? ` · ${str(q.status)}` : ''}`,
    kicker: 'Expense report',
    columns: [
      { key: 'expNo', label: 'Expense no.' },
      { key: 'expDate', label: 'Date' },
      { key: 'employee', label: 'Employee' },
      { key: 'department', label: 'Department' },
      { key: 'category', label: 'Category' },
      { key: 'description', label: 'Description' },
      { key: 'payee', label: 'Payee / supplier' },
      { key: 'reference', label: 'Reference' },
      { key: 'amount', label: 'Amount', align: RIGHT },
      { key: 'status', label: 'Status' },
      { key: 'paymentStatus', label: 'Payment' },
    ],
    rows: rows.map((x) => ({
      expNo: str(x.expNo),
      expDate: date(x.expDate),
      employee: `${str(x.firstName)} ${str(x.lastName)}`.trim() || str(x.employeeNo),
      department: str(x.departmentName),
      category: str(x.categoryName),
      description: str(x.description),
      payee: str(x.payee) || str(x.supplierName),
      reference: str(x.reference),
      amount: money(x.amount),
      status: str(x.status),
      paymentStatus: str(x.paymentStatus),
    })),
    facts: [
      ['Scope', periodLabel(str(q.from), str(q.to))],
      ['Expenses', String(r.total)],
      ['Total value', money(grand)],
    ],
  };
};

const expenseCashBankBuilder: ReportBuilder = async (client, ctx, q) => {
  const r = await expenses.expenseReports(client, ctx, { from: q.from, to: q.to });
  const rows = (r.cashVsBank ?? []) as Record<string, unknown>[];
  const grand = rows.reduce((s, x) => s + num(x.total), 0);
  return {
    title: 'Expenses by Payment Method',
    subtitle: periodLabel(str(q.from), str(q.to)),
    kicker: 'Expense report',
    columns: [
      { key: 'method', label: 'Payment method' },
      { key: 'total', label: 'Total', align: RIGHT },
    ],
    rows: rows.map((x) => ({ method: str(x.methodType).replace(/_/g, ' '), total: money(x.total) })),
    facts: [
      ['Scope', periodLabel(str(q.from), str(q.to))],
      ['Grand total', money(grand)],
    ],
  };
};

const expenseTrendBuilder: ReportBuilder = async (client, ctx, q) => {
  const r = await expenses.expenseReports(client, ctx, { from: q.from, to: q.to });
  const daily = (r.dailyTrend ?? []) as Record<string, unknown>[];
  const monthly = (r.monthlyTrend ?? []) as Record<string, unknown>[];
  const dailyTotal = daily.reduce((s, x) => s + num(x.total), 0);
  const monthlyTotal = monthly.reduce((s, x) => s + num(x.total), 0);
  return {
    title: 'Expense Trend',
    subtitle: periodLabel(str(q.from), str(q.to)),
    kicker: 'Expense report',
    columns: [
      { key: 'period', label: 'Period' },
      { key: 'total', label: 'Total', align: RIGHT },
    ],
    rows: [
      ...daily.map((x) => ({ period: `Daily · ${date(x.day)}`, total: money(x.total) })),
      ...monthly.map((x) => ({ period: `Monthly · ${str(x.month)}`, total: money(x.total) })),
    ],
    facts: [
      ['Scope', periodLabel(str(q.from), str(q.to))],
      ['Daily total (14 days)', money(dailyTotal)],
      ['Monthly total (6 months)', money(monthlyTotal)],
    ],
  };
};

const expensePlannedBuilder: ReportBuilder = async (client, ctx, q) => {
  const r = await expenses.expenseReports(client, ctx, { from: q.from, to: q.to });
  const rows = (r.plannedVsUnplanned ?? []) as Record<string, unknown>[];
  const grand = rows.reduce((s, x) => s + num(x.total), 0);
  return {
    title: 'Planned vs Unplanned Expenses',
    subtitle: periodLabel(str(q.from), str(q.to)),
    kicker: 'Expense report',
    columns: [
      { key: 'type', label: 'Type' },
      { key: 'count', label: 'Count', align: RIGHT },
      { key: 'total', label: 'Total', align: RIGHT },
    ],
    rows: rows.map((x) => ({
      type: x.isPlanned === true ? 'Planned' : 'Unplanned / emergency',
      count: str(x.count),
      total: money(x.total),
    })),
    facts: [
      ['Scope', periodLabel(str(q.from), str(q.to))],
      ['Grand total', money(grand)],
    ],
  };
};

const expenseBudgetBuilder: ReportBuilder = async (client, ctx, q) => {
  const from = str(q.from);
  const to = str(q.to);
  // Distinct GL accounts used by expenses in range, joined to the chart of
  // accounts for a legible label. Budget math comes from finance.budgetPosition.
  const params: unknown[] = [ctx.tenantId, ctx.companyId ?? null];
  const where = ['et.tenant_id = $1', 'et.company_id = $2', "et.status NOT IN ('VOID','REJECTED')", 'et.account_id IS NOT NULL'];
  if (from) { params.push(from); where.push(`et.exp_date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`et.exp_date <= $${params.length}`); }
  const accs = await client.query(
    `SELECT DISTINCT et.account_id, a.code AS account_code, a.name AS account_name
       FROM expense_transactions et
       JOIN chart_of_accounts a ON a.id = et.account_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.code`,
    params
  );
  const rows: Array<Record<string, unknown>> = [];
  for (const a of accs.rows) {
    const pos = await fin.budgetPosition(client, ctx, Number(a.account_id));
    if (pos.budgetId == null) continue;
    rows.push({
      accountCode: str(a.account_code),
      account: str(a.account_name),
      budgetNo: str(pos.budgetNo),
      result: str(pos.result),
      approved: money(pos.approved),
      committed: money(pos.committed),
      actual: money(pos.actual),
      available: money(pos.available),
    });
  }
  return {
    title: 'Budget vs Actual — Expenses',
    subtitle: periodLabel(str(q.from), str(q.to)),
    kicker: 'Expense report',
    columns: [
      { key: 'accountCode', label: 'Account' },
      { key: 'account', label: 'Account name' },
      { key: 'budgetNo', label: 'Budget' },
      { key: 'result', label: 'Position' },
      { key: 'approved', label: 'Approved', align: RIGHT },
      { key: 'committed', label: 'Committed', align: RIGHT },
      { key: 'actual', label: 'Actual', align: RIGHT },
      { key: 'available', label: 'Available', align: RIGHT },
    ],
    rows,
    facts: [
      ['Scope', periodLabel(str(q.from), str(q.to))],
      ['Budgeted accounts', String(rows.length)],
    ],
  };
};

const expenseClaimsBuilder: ReportBuilder = async (client, ctx) => {
  const r = await expenses.expenseReports(client, ctx, {});
  const rows = (r.claims ?? []) as Record<string, unknown>[];
  const count = rows.reduce((s, x) => s + num(x.count), 0);
  const grand = rows.reduce((s, x) => s + num(x.total), 0);
  return {
    title: 'Expense Claims Register',
    subtitle: 'Employee expense claims by status',
    kicker: 'Expense report',
    columns: [
      { key: 'status', label: 'Status' },
      { key: 'count', label: 'Count', align: RIGHT },
      { key: 'total', label: 'Total', align: RIGHT },
    ],
    rows: rows.map((x) => ({ status: str(x.status), count: str(x.count), total: money(x.total) })),
    facts: [
      ['Claims', String(count)],
      ['Total value', money(grand)],
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
  'cashflow-analysis': { key: 'cashflow-analysis', label: 'Cash Flow Analysis', builder: cashFlowBuilder },
  'general-ledger': { key: 'general-ledger', label: 'General Ledger', builder: generalLedgerBuilder },
  'partner-ledger': { key: 'partner-ledger', label: 'Partner Ledger', builder: partnerLedgerBuilder },
  'customer-statement': { key: 'customer-statement', label: 'Customer Statement', builder: customerStatementBuilder },
  ar: { key: 'ar', label: 'Aged Receivables', builder: arBuilder },
  ap: { key: 'ap', label: 'Aged Payables', builder: apBuilder },
  tax: { key: 'tax', label: 'Tax Summary', builder: taxBuilder },
  'depreciation-schedule': { key: 'depreciation-schedule', label: 'Depreciation Schedule', builder: depreciationScheduleBuilder },
  'loans-analysis': { key: 'loans-analysis', label: 'Loans Analysis', builder: loansAnalysisBuilder },
  'invoice-analysis': { key: 'invoice-analysis', label: 'Invoice Analysis', builder: invoiceAnalysisBuilder },
  'fiscal-report': { key: 'fiscal-report', label: 'Fiscal Report', builder: fiscalReportBuilder },
  'analytic-report': { key: 'analytic-report', label: 'Cost Centre Analysis', builder: analyticReportBuilder },
  'profit-centre': { key: 'profit-centre', label: 'Profit Centre Analysis', builder: profitCentreBuilder },
  'executive-summary': { key: 'executive-summary', label: 'Executive Summary', builder: executiveSummaryBuilder },
  'expense-register': { key: 'expense-register', label: 'Expense Register', builder: expenseRegisterBuilder },
  'expense-by-category': { key: 'expense-by-category', label: 'Expenses by Category', builder: expenseGroupBuilder('category', 'Expenses by Category') },
  'expense-by-department': { key: 'expense-by-department', label: 'Expenses by Department', builder: expenseGroupBuilder('department', 'Expenses by Department') },
  'expense-by-cost-centre': { key: 'expense-by-cost-centre', label: 'Expenses by Cost Centre', builder: expenseGroupBuilder('costCentre', 'Expenses by Cost Centre') },
  'expense-by-project': { key: 'expense-by-project', label: 'Expenses by Project', builder: expenseGroupBuilder('project', 'Expenses by Project') },
  'expense-by-supplier': { key: 'expense-by-supplier', label: 'Expenses by Supplier', builder: expenseGroupBuilder('supplier', 'Expenses by Supplier') },
  'expense-by-employee': { key: 'expense-by-employee', label: 'Expenses by Employee', builder: expenseGroupBuilder('employee', 'Expenses by Employee') },
  'expense-cash-bank': { key: 'expense-cash-bank', label: 'Expenses by Payment Method', builder: expenseCashBankBuilder },
  'expense-trend': { key: 'expense-trend', label: 'Expense Trend', builder: expenseTrendBuilder },
  'expense-planned-vs-unplanned': { key: 'expense-planned-vs-unplanned', label: 'Planned vs Unplanned', builder: expensePlannedBuilder },
  'expense-budget-vs-actual': { key: 'expense-budget-vs-actual', label: 'Budget vs Actual', builder: expenseBudgetBuilder },
  'expense-claims': { key: 'expense-claims', label: 'Expense Claims Register', builder: expenseClaimsBuilder },
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
