import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils.js';
import * as fin from '../../services/finance.js';
import * as finAdv from '../../services/finance-advanced.js';

export const financeOpsRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string | string[], fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

const runGet = (permission: string | string[], fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

financeOpsRouter.get('/summary', ...runGet('finance.journals.view', (c, ctx) => fin.financeSummary(c, ctx)));
financeOpsRouter.get('/accounts', ...runGet('finance.chart_of_accounts.view', (c, ctx) => fin.listAccounts(c, ctx)));
financeOpsRouter.get('/journals', ...runGet('finance.journals.view', (c, ctx, q) => fin.listJournals(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
financeOpsRouter.get('/journals/:id', ...runGet('finance.journals.view', (c, ctx, _q, p) => fin.getJournal(c, ctx, Number(p.id))));
financeOpsRouter.post('/journals', ...run('finance.journals.create', (c, ctx, b) => fin.createManualJournal(c, ctx, {
  entryDate: String(b.entryDate),
  description: String(b.description),
  journalType: b.journalType != null ? String(b.journalType) : 'MANUAL',
  lines: b.lines ?? [],
  post: Boolean(b.post),
})));
financeOpsRouter.post('/journals/:id/post', ...run('finance.journals.post', (c, ctx, _b, p) => fin.postDraftJournal(c, ctx, Number(p.id))));
financeOpsRouter.post('/journals/:id/void', ...run('finance.journals.void', (c, ctx, b, p) => fin.voidJournal(c, ctx, Number(p.id), String(b.reason ?? 'Voided'))));

financeOpsRouter.get('/trial-balance', ...runGet(['finance.journals.view', 'finance.reports.view'], (c, ctx, q) =>
  fin.trialBalance(c, ctx, q.from != null ? String(q.from) : undefined, q.to != null ? String(q.to) : undefined)));
financeOpsRouter.get('/profit-loss', ...runGet(['finance.journals.view', 'finance.reports.view'], (c, ctx, q) => {
  const to = q.to != null ? String(q.to) : new Date().toISOString().slice(0, 10);
  const from = q.from != null ? String(q.from) : `${to.slice(0, 4)}-01-01`;
  return fin.profitAndLoss(c, ctx, from, to);
}));
financeOpsRouter.get('/balance-sheet', ...runGet(['finance.journals.view', 'finance.reports.view'], (c, ctx, q) =>
  fin.balanceSheet(c, ctx, q.asOf != null ? String(q.asOf) : new Date().toISOString().slice(0, 10))));

financeOpsRouter.get('/ar', ...runGet(['finance.journals.view', 'sales.invoices.view'], (c, ctx, q) =>
  fin.arLedger(c, ctx, { bucket: q.bucket != null ? String(q.bucket) : undefined })));
financeOpsRouter.get('/ap', ...runGet(['finance.journals.view', 'procurement.supplier_invoices.view'], (c, ctx, q) =>
  fin.apLedger(c, ctx, { bucket: q.bucket != null ? String(q.bucket) : undefined })));
financeOpsRouter.get('/banks', ...runGet('finance.banks.view', (c, ctx) => fin.bankPosition(c, ctx)));
financeOpsRouter.get('/banks/exchange-rate', ...runGet('finance.banks.view', (c, ctx, q) => fin.getLatestExchangeRate(c, ctx, q.code != null ? String(q.code) : '')));
financeOpsRouter.get('/tax', ...runGet(['finance.taxes.view', 'finance.reports.view'], (c, ctx, q) => {
  const to = q.to != null ? String(q.to) : new Date().toISOString().slice(0, 10);
  const from = q.from != null ? String(q.from) : `${to.slice(0, 4)}-01-01`;
  return fin.taxSummary(c, ctx, from, to);
}));

financeOpsRouter.get('/periods', ...runGet('finance.periods.view', (c, ctx) => fin.listPeriods(c, ctx)));
financeOpsRouter.post('/periods/:id/lock', ...run('finance.periods.lock', (c, ctx, _b, p) => fin.setPeriodStatus(c, ctx, Number(p.id), 'LOCKED')));
financeOpsRouter.post('/periods/:id/close', ...run('finance.periods.close', (c, ctx, _b, p) => fin.setPeriodStatus(c, ctx, Number(p.id), 'CLOSED')));
financeOpsRouter.post('/periods/:id/open', ...run('finance.periods.open', (c, ctx, _b, p) => fin.setPeriodStatus(c, ctx, Number(p.id), 'OPEN')));

financeOpsRouter.post('/expenses', ...run('finance.expenses.create', (c, ctx, b) => fin.postExpense(c, ctx, {
  expenseDate: String(b.expenseDate ?? new Date().toISOString().slice(0, 10)),
  accountId: Number(b.accountId),
  amount: Number(b.amount),
  vendor: b.vendor != null ? String(b.vendor) : null,
  reference: b.reference != null ? String(b.reference) : null,
  method: b.method != null ? String(b.method) : 'CASH',
  description: b.description != null ? String(b.description) : undefined,
})));

financeOpsRouter.post('/invoices/:id/post', ...run(['finance.journals.post', 'sales.invoices.post'], (c, ctx, _b, p) => fin.postSalesInvoice(c, ctx, Number(p.id))));

// ---- Chart of accounts CRUD ----
financeOpsRouter.post('/accounts', ...run('finance.chart_of_accounts.create', (c, ctx, b) => fin.createAccount(c, ctx, {
  code: String(b.code),
  name: String(b.name),
  accountType: b.accountType != null ? String(b.accountType) : '',
  subtype: b.subtype != null ? String(b.subtype) : undefined,
  parentId: b.parentId != null ? Number(b.parentId) : undefined,
  isPosting: b.isPosting !== undefined ? Boolean(b.isPosting) : undefined,
  currency: b.currency != null ? String(b.currency) : undefined,
  openingBalance: b.openingBalance != null ? Number(b.openingBalance) : undefined,
})));
financeOpsRouter.patch('/accounts/:id', ...run('finance.chart_of_accounts.update', (c, ctx, b, p) => fin.updateAccount(c, ctx, Number(p.id), {
  name: b.name !== undefined ? String(b.name) : undefined,
  subtype: b.subtype !== undefined ? (b.subtype == null ? null : String(b.subtype)) : undefined,
  parentId: b.parentId !== undefined ? (b.parentId == null ? null : Number(b.parentId)) : undefined,
  isPosting: b.isPosting !== undefined ? Boolean(b.isPosting) : undefined,
  currency: b.currency !== undefined ? String(b.currency) : undefined,
  openingBalance: b.openingBalance !== undefined ? Number(b.openingBalance) : undefined,
  isActive: b.isActive !== undefined ? Boolean(b.isActive) : undefined,
})));
financeOpsRouter.post('/accounts/:id/deactivate', ...run('finance.chart_of_accounts.delete', (c, ctx, _b, p) => fin.deactivateAccount(c, ctx, Number(p.id))));

// ---- Bank accounts CRUD + reconciliation ----
financeOpsRouter.post('/banks', ...run('finance.banks.create', (c, ctx, b) => fin.createBankAccount(c, ctx, {
  code: String(b.code),
  name: String(b.name),
  bankName: b.bankName != null ? String(b.bankName) : undefined,
  accountNo: b.accountNo != null ? String(b.accountNo) : undefined,
  accountType: b.accountType != null ? String(b.accountType) : undefined,
  currency: b.currency != null ? String(b.currency) : undefined,
  openingBalance: b.openingBalance != null ? Number(b.openingBalance) : undefined,
  glAccountId: b.glAccountId != null ? Number(b.glAccountId) : undefined,
})));
financeOpsRouter.patch('/banks/:id', ...run('finance.banks.update', (c, ctx, b, p) => fin.updateBankAccount(c, ctx, Number(p.id), {
  name: b.name !== undefined ? String(b.name) : undefined,
  bankName: b.bankName !== undefined ? (b.bankName == null ? null : String(b.bankName)) : undefined,
  accountNo: b.accountNo !== undefined ? (b.accountNo == null ? null : String(b.accountNo)) : undefined,
  accountType: b.accountType !== undefined ? String(b.accountType) : undefined,
  currency: b.currency !== undefined ? String(b.currency) : undefined,
  openingBalance: b.openingBalance !== undefined ? Number(b.openingBalance) : undefined,
  glAccountId: b.glAccountId !== undefined ? (b.glAccountId == null ? null : Number(b.glAccountId)) : undefined,
  isActive: b.isActive !== undefined ? Boolean(b.isActive) : undefined,
})));
financeOpsRouter.post('/banks/:id/deactivate', ...run('finance.banks.update', (c, ctx, _b, p) => fin.deactivateBankAccount(c, ctx, Number(p.id))));
financeOpsRouter.get('/banks/:id/transactions', ...runGet('finance.banks.view', (c, ctx, q, p) => fin.listBankTransactions(c, ctx, Number(p.id), {
  reconciled: q.reconciled != null ? String(q.reconciled) : undefined,
  limit: q.limit != null ? Number(q.limit) : undefined,
})));
financeOpsRouter.post('/banks/:id/transactions', ...run('finance.banks.reconcile', (c, ctx, b, p) => fin.addBankStatementLine(c, ctx, Number(p.id), {
  txnDate: b.txnDate != null ? String(b.txnDate) : undefined,
  reference: b.reference != null ? String(b.reference) : null,
  description: b.description != null ? String(b.description) : null,
  debit: b.debit != null ? Number(b.debit) : 0,
  credit: b.credit != null ? Number(b.credit) : 0,
})));
financeOpsRouter.post('/banks/:id/transactions/:txnId/reconcile', ...run('finance.banks.reconcile', (c, ctx, b, p) => fin.setBankTransactionReconciled(c, ctx, Number(p.id), Number(p.txnId), b.reconciled !== undefined ? Boolean(b.reconciled) : true)));
financeOpsRouter.get('/banks/:id/recon', ...runGet('finance.banks.view', (c, ctx, _q, p) => fin.getBankRecon(c, ctx, Number(p.id))));
financeOpsRouter.post('/banks/:id/recon/auto-match', ...run('finance.banks.reconcile', (c, ctx, _b, p) => fin.autoMatchBankRecon(c, ctx, Number(p.id))));
financeOpsRouter.post('/banks/:id/recon/match', ...run('finance.banks.reconcile', (c, ctx, b, p) => fin.matchBankRecon(c, ctx, Number(p.id), {
  statementId: Number(b.statementId),
  journalLineId: Number(b.journalLineId),
})));
financeOpsRouter.post('/banks/:id/recon/unmatch', ...run('finance.banks.reconcile', (c, ctx, b, p) => fin.unmatchBankRecon(c, ctx, Number(p.id), Number(b.matchId))));
financeOpsRouter.post('/banks/:id/recon/submit', ...run('finance.banks.reconcile', (c, ctx, _b, p) => fin.submitBankRecon(c, ctx, Number(p.id))));
financeOpsRouter.post('/banks/:id/recon/approve', ...run('finance.banks.reconcile', (c, ctx, b, p) => fin.approveBankRecon(c, ctx, Number(p.id), {
  statementBalance: b.statementBalance != null ? Number(b.statementBalance) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));

// ---- Internal cash / bank transfers ----
financeOpsRouter.post('/banks/transfer', ...run('finance.banks.update', (c, ctx, b) => fin.createCashTransfer(c, ctx, {
  fromBankId: Number(b.fromBankId),
  toBankId: Number(b.toBankId),
  amount: Number(b.amount),
  transferDate: b.transferDate != null ? String(b.transferDate) : undefined,
  reference: b.reference != null ? String(b.reference) : undefined,
  notes: b.notes != null ? String(b.notes) : undefined,
  exchangeRate: b.exchangeRate !== undefined ? Number(b.exchangeRate) : undefined,
})));
financeOpsRouter.get('/banks/transfers', ...runGet('finance.banks.view', (c, ctx, q) => fin.listCashTransfers(c, ctx, {
  limit: q.limit != null ? Number(q.limit) : undefined,
})));

// ---- Staff cash advances / imprest ----
financeOpsRouter.get('/advances', ...runGet('finance.advances.view', (c, ctx, q) => fin.listCashAdvances(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
financeOpsRouter.get('/advances/:id', ...runGet('finance.advances.view', (c, ctx, _q, p) => fin.getCashAdvance(c, ctx, Number(p.id))));
financeOpsRouter.post('/advances', ...run('finance.advances.create', (c, ctx, b) => fin.createCashAdvance(c, ctx, {
  advanceDate: b.advanceDate != null ? String(b.advanceDate) : undefined,
  employeeId: b.employeeId != null && Number(b.employeeId) > 0 ? Number(b.employeeId) : null,
  holderName: b.holderName != null ? String(b.holderName) : null,
  bankId: Number(b.bankId),
  amount: Number(b.amount),
  purpose: b.purpose != null ? String(b.purpose) : null,
  reference: b.reference != null ? String(b.reference) : null,
  exchangeRate: b.exchangeRate !== undefined ? Number(b.exchangeRate) : undefined,
})));
financeOpsRouter.post('/advances/:id/settle', ...run('finance.advances.settle', (c, ctx, b, p) => fin.settleCashAdvance(c, ctx, Number(p.id), {
  settlementDate: b.settlementDate != null ? String(b.settlementDate) : undefined,
  amount: Number(b.amount),
  accountId: Number(b.accountId),
  method: b.method != null ? String(b.method) : undefined,
  reference: b.reference != null ? String(b.reference) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));
financeOpsRouter.post('/advances/:id/void', ...run('finance.advances.void', (c, ctx, b, p) => fin.voidCashAdvance(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : 'Advance voided')));

// ---- Periods ----
financeOpsRouter.post('/periods', ...run('finance.periods.create', (c, ctx, b) => fin.createPeriod(c, ctx, {
  code: String(b.code),
  name: String(b.name),
  startDate: String(b.startDate),
  endDate: String(b.endDate),
  status: b.status != null ? String(b.status) : undefined,
})));

// ---- Draft journal editing ----
financeOpsRouter.patch('/journals/:id', ...run('finance.journals.create', (c, ctx, b, p) => fin.updateJournal(c, ctx, Number(p.id), {
  entryDate: b.entryDate !== undefined ? String(b.entryDate) : undefined,
  description: b.description !== undefined ? String(b.description) : undefined,
  lines: b.lines !== undefined ? b.lines : undefined,
})));

// ---- Tax codes CRUD ----
financeOpsRouter.get('/taxes', ...runGet('finance.taxes.view', (c, ctx) => fin.listTaxes(c, ctx)));
financeOpsRouter.post('/taxes', ...run('finance.taxes.create', (c, ctx, b) => fin.createTax(c, ctx, {
  code: String(b.code),
  name: String(b.name),
  taxType: b.taxType != null ? String(b.taxType) : undefined,
  rate: Number(b.rate),
  accountId: b.accountId != null ? Number(b.accountId) : undefined,
})));
financeOpsRouter.patch('/taxes/:id', ...run('finance.taxes.update', (c, ctx, b, p) => fin.updateTax(c, ctx, Number(p.id), {
  name: b.name !== undefined ? String(b.name) : undefined,
  taxType: b.taxType !== undefined ? String(b.taxType) : undefined,
  rate: b.rate !== undefined ? Number(b.rate) : undefined,
  accountId: b.accountId !== undefined ? (b.accountId == null ? null : Number(b.accountId)) : undefined,
  isActive: b.isActive !== undefined ? Boolean(b.isActive) : undefined,
})));

// ---- Expenses ----
financeOpsRouter.get('/expenses', ...runGet('finance.expenses.view', (c, ctx, q) => fin.listExpenses(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
financeOpsRouter.get('/expenses/:id', ...runGet('finance.expenses.view', (c, ctx, _q, p) => fin.getExpense(c, ctx, Number(p.id))));
financeOpsRouter.post('/expenses/:id/void', ...run('finance.expenses.void', (c, ctx, b, p) => fin.voidExpense(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : 'Expense voided')));

// ---- Budgets ----
financeOpsRouter.get('/budgets', ...runGet('finance.budgets.view', (c, ctx, q) => fin.listBudgets(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
financeOpsRouter.get('/budgets/:id', ...runGet('finance.budgets.view', (c, ctx, _q, p) => fin.getBudget(c, ctx, Number(p.id))));
financeOpsRouter.post('/budgets', ...run('finance.budgets.create', (c, ctx, b) => fin.createBudget(c, ctx, {
  periodStart: String(b.periodStart),
  periodEnd: String(b.periodEnd),
  amount: b.amount != null ? Number(b.amount) : undefined,
  status: b.status != null ? String(b.status) : undefined,
  lines: b.lines ?? [],
})));
financeOpsRouter.patch('/budgets/:id', ...run('finance.budgets.update', (c, ctx, b, p) => fin.updateBudget(c, ctx, Number(p.id), {
  periodStart: b.periodStart !== undefined ? String(b.periodStart) : undefined,
  periodEnd: b.periodEnd !== undefined ? String(b.periodEnd) : undefined,
  amount: b.amount !== undefined ? Number(b.amount) : undefined,
  lines: b.lines !== undefined ? b.lines : undefined,
})));
financeOpsRouter.post('/budgets/:id/submit', ...run('finance.budgets.submit', (c, ctx, _b, p) => fin.setBudgetStatus(c, ctx, Number(p.id), 'submit')));
financeOpsRouter.post('/budgets/:id/approve', ...run('finance.budgets.approve', (c, ctx, _b, p) => fin.setBudgetStatus(c, ctx, Number(p.id), 'approve')));
financeOpsRouter.post('/budgets/:id/close', ...run('finance.budgets.close', (c, ctx, _b, p) => fin.setBudgetStatus(c, ctx, Number(p.id), 'close')));
// ===================== Advanced Finance & Accounting =====================
financeOpsRouter.get('/advanced/summary', ...runGet('finance.journals.view', (c, ctx) => finAdv.financeAdvancedSummary(c, ctx)));

// ---- Journal workflow lifecycle (submit / approve / reject / reverse) ----
financeOpsRouter.post('/journals/:id/submit', ...run('finance.journals.submit', (c, ctx, _b, p) => finAdv.submitJournal(c, ctx, Number(p.id))));
financeOpsRouter.post('/journals/:id/approve', ...run('finance.journals.approve', (c, ctx, _b, p) => finAdv.approveJournal(c, ctx, Number(p.id))));
financeOpsRouter.post('/journals/:id/reject', ...run('finance.journals.reject', (c, ctx, b, p) => finAdv.rejectJournal(c, ctx, Number(p.id), String(b.reason ?? 'Rejected'))));
financeOpsRouter.post('/journals/:id/reverse', ...run('finance.journals.post', (c, ctx, b, p) => finAdv.reverseJournalWorkflow(c, ctx, Number(p.id), String(b.reason ?? 'Reversal'))));

// ---- Journal templates ----
financeOpsRouter.get('/templates', ...runGet('finance.templates.view', (c, ctx) => finAdv.listJournalTemplates(c, ctx)));
financeOpsRouter.post('/templates', ...run('finance.templates.create', (c, ctx, b) => finAdv.createJournalTemplate(c, ctx, {
  code: String(b.code),
  name: String(b.name),
  journalType: b.journalType != null ? String(b.journalType) : undefined,
  description: b.description != null ? String(b.description) : undefined,
  lines: b.lines ?? [],
})));

// ---- Configurable posting rules engine ----
financeOpsRouter.get('/posting-rules', ...runGet('finance.posting_rules.view', (c, ctx, q) => finAdv.listPostingRules(c, ctx, { event: q.event != null ? String(q.event) : undefined })));
financeOpsRouter.post('/posting-rules', ...run('finance.posting_rules.create', (c, ctx, b) => finAdv.createPostingRule(c, ctx, {
  event: String(b.event),
  code: String(b.code),
  name: String(b.name),
  journalType: b.journalType != null ? String(b.journalType) : undefined,
  lines: b.lines ?? [],
})));
financeOpsRouter.post('/posting-rules/apply', ...run('finance.posting_rules.post', (c, ctx, b) => finAdv.applyPostingRule(c, ctx, {
  event: String(b.event),
  code: b.code != null ? String(b.code) : undefined,
  amount: Number(b.amount),
  net: b.net !== undefined ? Number(b.net) : undefined,
  tax: b.tax !== undefined ? Number(b.tax) : undefined,
  entryDate: b.entryDate != null ? String(b.entryDate) : undefined,
  description: b.description != null ? String(b.description) : undefined,
  refType: b.refType != null ? String(b.refType) : null,
  refId: b.refId != null ? Number(b.refId) : null,
  refCode: b.refCode != null ? String(b.refCode) : null,
})));// ---- Tax engine: jurisdictions, rules, transactions, compliance ----
financeOpsRouter.get('/tax/jurisdictions', ...runGet('finance.tax_jurisdictions.view', (c, ctx) => finAdv.listTaxJurisdictions(c, ctx)));
financeOpsRouter.post('/tax/jurisdictions', ...run('finance.tax_jurisdictions.create', (c, ctx, b) => finAdv.createTaxJurisdiction(c, ctx, {
  code: String(b.code),
  name: String(b.name),
  country: b.country != null ? String(b.country) : undefined,
})));
financeOpsRouter.get('/tax/rules', ...runGet('finance.tax_rules.view', (c, ctx) => finAdv.listTaxRules(c, ctx)));
financeOpsRouter.post('/tax/rules', ...run('finance.tax_rules.create', (c, ctx, b) => finAdv.createTaxRule(c, ctx, {
  jurisdictionId: Number(b.jurisdictionId),
  taxId: Number(b.taxId),
  appliesTo: b.appliesTo != null ? String(b.appliesTo) : undefined,
  rateOverride: b.rateOverride !== undefined && b.rateOverride != null ? Number(b.rateOverride) : null,
  thresholdAmount: b.thresholdAmount !== undefined && b.thresholdAmount != null ? Number(b.thresholdAmount) : null,
})));
financeOpsRouter.get('/tax/transactions', ...runGet('finance.tax_transactions.view', (c, ctx, q) => finAdv.listTaxTransactions(c, ctx, {
  from: q.from != null ? String(q.from) : undefined,
  to: q.to != null ? String(q.to) : undefined,
})));
financeOpsRouter.post('/tax/transactions', ...run('finance.tax_transactions.create', (c, ctx, b) => finAdv.recordTaxTransaction(c, ctx, {
  taxId: Number(b.taxId),
  jurisdictionId: b.jurisdictionId != null ? Number(b.jurisdictionId) : null,
  docType: String(b.docType),
  docRefType: b.docRefType != null ? String(b.docRefType) : null,
  docRefId: b.docRefId != null ? Number(b.docRefId) : null,
  docRefCode: b.docRefCode != null ? String(b.docRefCode) : null,
  txnDate: b.txnDate != null ? String(b.txnDate) : undefined,
  baseAmount: Number(b.baseAmount),
  taxAmount: b.taxAmount !== undefined ? Number(b.taxAmount) : undefined,
  rate: b.rate !== undefined && b.rate != null ? Number(b.rate) : null,
})));
financeOpsRouter.get('/tax/compliance', ...runGet(['finance.tax_transactions.view', 'finance.taxes.view'], (c, ctx, q) => {
  const to = q.to != null ? String(q.to) : new Date().toISOString().slice(0, 10);
  const from = q.from != null ? String(q.from) : `${to.slice(0, 4)}-01-01`;
  return finAdv.taxComplianceSummary(c, ctx, from, to);
}));// ---- URA EFRIS fiscal compliance adapter ----
financeOpsRouter.get('/efris', ...runGet('finance.efris.view', (c, ctx, q) => finAdv.listEfrisTransactions(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  from: q.from != null ? String(q.from) : undefined,
  to: q.to != null ? String(q.to) : undefined,
})));
financeOpsRouter.post('/efris', ...run('finance.efris.create', (c, ctx, b) => finAdv.registerEfrisDocument(c, ctx, {
  docType: String(b.docType),
  docRefType: String(b.docRefType),
  docRefId: Number(b.docRefId),
  docRefCode: String(b.docRefCode),
  txnDate: b.txnDate != null ? String(b.txnDate) : undefined,
  currency: b.currency != null ? String(b.currency) : undefined,
  grossAmount: Number(b.grossAmount),
  taxAmount: b.taxAmount !== undefined ? Number(b.taxAmount) : undefined,
  idempotencyKey: String(b.idempotencyKey),
})));
financeOpsRouter.post('/efris/:id/sync', ...run('finance.efris.sync', (c, ctx, _b, p) => finAdv.syncEfrisTransaction(c, ctx, Number(p.id))));
financeOpsRouter.post('/efris/:id/cancel', ...run('finance.efris.cancel', (c, ctx, b, p) => finAdv.cancelEfrisTransaction(c, ctx, Number(p.id), String(b.reason ?? 'Cancelled'))));
financeOpsRouter.get('/efris/documents', ...runGet('finance.efris.view', (c, ctx, q) => finAdv.listEfrisDocuments(c, ctx, q.efrisTransactionId != null ? Number(q.efrisTransactionId) : undefined)));
financeOpsRouter.get('/efris/logs', ...runGet('finance.efris.view', (c, ctx, q) => finAdv.listEfrisSyncLogs(c, ctx, q.efrisTransactionId != null ? Number(q.efrisTransactionId) : undefined)));// ---- Budget control: revisions, commitments, availability ----
financeOpsRouter.get('/budget/revisions', ...runGet('finance.budget_revisions.view', (c, ctx, q) => finAdv.listBudgetRevisions(c, ctx, q.budgetId != null ? Number(q.budgetId) : undefined)));
financeOpsRouter.post('/budget/revisions', ...run('finance.budget_revisions.create', (c, ctx, b) => finAdv.createBudgetRevision(c, ctx, {
  budgetId: Number(b.budgetId),
  amount: Number(b.amount),
  reason: b.reason != null ? String(b.reason) : undefined,
})));
financeOpsRouter.get('/commitments', ...runGet('finance.budget_commitments.view', (c, ctx, q) => finAdv.listBudgetCommitments(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  docType: q.docType != null ? String(q.docType) : undefined,
})));
financeOpsRouter.post('/commitments', ...run('finance.budget_commitments.create', (c, ctx, b) => finAdv.createBudgetCommitment(c, ctx, {
  budgetId: Number(b.budgetId),
  accountId: b.accountId != null ? Number(b.accountId) : null,
  accountCode: b.accountCode != null ? String(b.accountCode) : null,
  docType: String(b.docType),
  docRefType: b.docRefType != null ? String(b.docRefType) : null,
  docRefId: b.docRefId != null ? Number(b.docRefId) : null,
  docRefCode: b.docRefCode != null ? String(b.docRefCode) : null,
  amount: Number(b.amount),
})));
financeOpsRouter.post('/commitments/:id/release', ...run('finance.budget_commitments.release', (c, ctx, _b, p) => finAdv.releaseBudgetCommitment(c, ctx, Number(p.id))));
financeOpsRouter.get('/budget/check', ...runGet('finance.budget_commitments.view', (c, ctx, q) => finAdv.checkBudget(c, ctx, {
  accountId: q.accountId != null ? Number(q.accountId) : null,
  accountCode: q.accountCode != null ? String(q.accountCode) : null,
  amount: Number(q.amount ?? 0),
  docType: String(q.docType ?? 'GENERAL'),
  docRefType: q.docRefType != null ? String(q.docRefType) : null,
  docRefId: q.docRefId != null ? Number(q.docRefId) : null,
})));// ---- Manufacturing costing: allocation rules, production costs, WIP ----
financeOpsRouter.get('/allocation-rules', ...runGet('finance.allocation_rules.view', (c, ctx) => finAdv.listAllocationRules(c, ctx)));
financeOpsRouter.post('/allocation-rules', ...run('finance.allocation_rules.create', (c, ctx, b) => finAdv.createAllocationRule(c, ctx, {
  code: String(b.code),
  name: String(b.name),
  sourceCostCentreId: b.sourceCostCentreId != null ? Number(b.sourceCostCentreId) : null,
  driver: b.driver != null ? String(b.driver) : undefined,
  rate: b.rate !== undefined ? Number(b.rate) : undefined,
})));
financeOpsRouter.get('/costing/production', ...runGet('finance.production_costs.view', (c, ctx, q) => finAdv.listProductionCosts(c, ctx, {
  status: q.status != null ? String(q.status) : undefined,
  from: q.from != null ? String(q.from) : undefined,
  to: q.to != null ? String(q.to) : undefined,
})));
financeOpsRouter.post('/costing/production', ...run('finance.production_costs.create', (c, ctx, b) => finAdv.captureProductionCost(c, ctx, {
  workOrderId: b.workOrderId != null ? Number(b.workOrderId) : null,
  productId: b.productId != null ? Number(b.productId) : null,
  costDate: b.costDate != null ? String(b.costDate) : undefined,
  quantity: Number(b.quantity),
  expectedCost: Number(b.expectedCost),
  expectedByType: b.expectedByType ?? undefined,
  components: b.components ?? [],
})));
financeOpsRouter.get('/costing/production/:id', ...runGet('finance.production_costs.view', (c, ctx, _q, p) => finAdv.getProductionCost(c, ctx, Number(p.id))));
financeOpsRouter.post('/costing/production/:id/post', ...run('finance.production_costs.post', (c, ctx, _b, p) => finAdv.postProductionCost(c, ctx, Number(p.id))));
financeOpsRouter.get('/costing/wip', ...runGet('finance.production_costs.view', (c, ctx, q) => finAdv.listWipLedger(c, ctx, q.workOrderId != null ? Number(q.workOrderId) : undefined)));
financeOpsRouter.post('/costing/wip', ...run('finance.production_costs.create', (c, ctx, b) => finAdv.recordWipMovement(c, ctx, {
  workOrderId: b.workOrderId != null ? Number(b.workOrderId) : null,
  txnType: String(b.txnType),
  txnDate: b.txnDate != null ? String(b.txnDate) : undefined,
  amount: Number(b.amount),
  accountId: b.accountId != null ? Number(b.accountId) : null,
  journalId: b.journalId != null ? Number(b.journalId) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));// ---- Intercompany accounting ----
financeOpsRouter.get('/companies', ...runGet('finance.intercompany.view', (c, ctx) => finAdv.listCompanies(c, ctx)));
financeOpsRouter.get('/intercompany', ...runGet('finance.intercompany.view', (c, ctx, q) => finAdv.listIntercompanyTransactions(c, ctx, {
  from: q.from != null ? String(q.from) : undefined,
  to: q.to != null ? String(q.to) : undefined,
})));
financeOpsRouter.post('/intercompany', ...run('finance.intercompany.create', (c, ctx, b) => finAdv.createIntercompanyTransfer(c, ctx, {
  fromCompanyId: Number(b.fromCompanyId),
  toCompanyId: Number(b.toCompanyId),
  txnDate: b.txnDate != null ? String(b.txnDate) : undefined,
  currency: b.currency != null ? String(b.currency) : undefined,
  exchangeRate: b.exchangeRate !== undefined ? Number(b.exchangeRate) : undefined,
  amount: Number(b.amount),
  description: b.description != null ? String(b.description) : undefined,
  fromAccountCode: b.fromAccountCode != null ? String(b.fromAccountCode) : undefined,
  toAccountCode: b.toAccountCode != null ? String(b.toAccountCode) : undefined,
  dueFromAccountCode: b.dueFromAccountCode != null ? String(b.dueFromAccountCode) : undefined,
  dueToAccountCode: b.dueToAccountCode != null ? String(b.dueToAccountCode) : undefined,
})));

// ---- Financial consolidation ----
financeOpsRouter.get('/consolidation/runs', ...runGet('finance.consolidation.view', (c, ctx) => finAdv.listConsolidationRuns(c, ctx)));
financeOpsRouter.post('/consolidation/runs', ...run('finance.consolidation.run', (c, ctx, b) => finAdv.runConsolidation(c, ctx, {
  periodStart: String(b.periodStart),
  periodEnd: String(b.periodEnd),
  targetCurrency: b.targetCurrency != null ? String(b.targetCurrency) : undefined,
})));
financeOpsRouter.get('/consolidation/runs/:id', ...runGet('finance.consolidation.view', (c, ctx, _q, p) => finAdv.getConsolidationRun(c, ctx, Number(p.id))));

// ---- Period close cockpit ----
financeOpsRouter.get('/close-tasks', ...runGet('finance.close_tasks.view', (c, ctx, q) => finAdv.listCloseTasks(c, ctx, q.periodId != null ? Number(q.periodId) : undefined)));
financeOpsRouter.patch('/close-tasks/:id', ...run('finance.close_tasks.update', (c, ctx, b, p) => finAdv.updateCloseTask(c, ctx, Number(p.id), {
  status: b.status !== undefined ? String(b.status) : undefined,
  notes: b.notes != null ? String(b.notes) : undefined,
})));
financeOpsRouter.post('/periods/:id/close-run', ...run('finance.periods.close', (c, ctx, _b, p) => finAdv.runPeriodClose(c, ctx, Number(p.id))));

// ---- Financial audit trail ----
financeOpsRouter.get('/audit', ...runGet('finance.audit.view', (c, ctx, q) => finAdv.listFinancialAudit(c, ctx, {
  limit: q.limit != null ? Number(q.limit) : undefined,
  module: q.module != null ? String(q.module) : undefined,
  docType: q.docType != null ? String(q.docType) : undefined,
})));