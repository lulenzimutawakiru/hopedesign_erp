/**
 * Equity operations surface: status, configuration and notification reconciliation
 * for the finance workspace.
 *
 * Everything in this module is a human, permissioned action. The inbound
 * receiver (services/equity/ingest.ts) is the only code that accepts money; this is
 * what an administrator uses to point the integration at the right account, to
 * confirm that a notification could actually be verified, and to reconcile what
 * arrived against the invoices it settles.
 *
 * A match records WHICH invoice a payment settles. It deliberately does not
 * apply the money: applying a payment moves `amount_paid` and the ledger, and
 * that stays a separate, deliberate finance action, so this module can never
 * quietly change what a customer owes.
 *
 * The self-test is deliberately local. Equity publishes no unauthenticated health
 * endpoint, and knocking on the gateway with a request we are not onboarded to
 * send would prove nothing except that it can say no. What the test does prove
 * is everything that can make a notification fail silently: whether a usable
 * verification key is loaded, whether the settlement account exists, is active,
 * and is denominated in the currency the integration claims.
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, notFound } from '../../utils.js';
import { auditConfig } from '../companyConfig.js';
import {
  EquityConfigPatch,
  EquityConfigView,
  EQUITY_CODE,
  getEquityIntegration,
  equityConfigView,
  markEquityTested,
  readEquityConfig,
  updateEquityConfig,
} from './config.js';

/** Statuses an invoice has to be in before a payment may be reconciled to it. */
const OPEN_INVOICE_STATUSES = ['POSTED', 'SUBMITTED', 'PARTIALLY_PAID'];

const requireCompany = (ctx: Ctx): number => {
  if (ctx.companyId == null) throw badRequest('A company context is required');
  return ctx.companyId;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Money, rounded to the cent so a float never surfaces as 12.340000000001. */
const money = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n * 100) / 100;
};

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** ISO instant, whatever pg handed us (a Date, or a string from a cast). */
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

type Row = Record<string, unknown>;

/** The safe projection of one notification, as the finance workspace sees it. */
export interface EquityNotificationView {
  id: number;
  notificationType: string;
  equityTransactionId: string | null;
  requestId: string | null;
  transactionReference: string | null;
  customerName: string | null;
  customerReference: string | null;
  customerMsisdn: string | null;
  amount: number | null;
  currency: string | null;
  narration: string | null;
  tillNumber: string | null;
  organizationShortCode: string | null;
  creditAccountIdentifier: string | null;
  transactionAt: string | null;
  status: string;
  rejectReason: string | null;
  bankTransactionId: number | null;
  bankAccountId: number | null;
  bankAccountCode: string | null;
  bankAccountName: string | null;
  matchedInvoiceId: number | null;
  matchedInvoiceNo: string | null;
  matchedAt: string | null;
  matchedBy: number | null;
  createdAt: string | null;
}

export function equityNotificationView(row: Row): EquityNotificationView {
  return {
    id: Number(row.id),
    notificationType: String(row.notification_type ?? ''),
    equityTransactionId: text(row.equity_transaction_id),
    requestId: text(row.request_id),
    transactionReference: text(row.transaction_reference),
    customerName: text(row.customer_name),
    customerReference: text(row.customer_reference),
    customerMsisdn: text(row.customer_msisdn),
    amount: money(row.amount),
    currency: text(row.currency),
    narration: text(row.narration),
    tillNumber: text(row.till_number),
    organizationShortCode: text(row.organization_short_code),
    creditAccountIdentifier: text(row.credit_account_identifier),
    transactionAt: iso(row.transaction_at),
    status: String(row.status ?? ''),
    rejectReason: text(row.reject_reason),
    bankTransactionId: num(row.bank_transaction_id),
    bankAccountId: num(row.bank_account_id),
    bankAccountCode: text(row.bank_account_code),
    bankAccountName: text(row.bank_account_name),
    matchedInvoiceId: num(row.matched_invoice_id),
    matchedInvoiceNo: text(row.matched_invoice_no),
    matchedAt: iso(row.matched_at),
    matchedBy: num(row.matched_by),
    createdAt: iso(row.created_at),
  };
}

/** Column list every notification read shares, so the projection stays whole. */
const NOTIFICATION_SELECT = `
  n.id, n.notification_type, n.equity_transaction_id, n.request_id, n.transaction_reference,
  n.customer_name, n.customer_reference, n.customer_msisdn, n.amount, n.currency, n.narration,
  n.till_number, n.organization_short_code, n.credit_account_identifier, n.transaction_at,
  n.status, n.reject_reason, n.bank_transaction_id, n.bank_account_id,
  n.matched_invoice_id, n.matched_at, n.matched_by, n.created_at,
  ba.code AS bank_account_code, ba.name AS bank_account_name,
  ci.invoice_no AS matched_invoice_no`;

const NOTIFICATION_FROM = `
  FROM equity_payment_notifications n
  LEFT JOIN bank_accounts ba ON ba.id = n.bank_account_id
  LEFT JOIN customer_invoices ci ON ci.id = n.matched_invoice_id`;

const readNotification = async (client: pg.PoolClient, companyId: number, id: number): Promise<EquityNotificationView> => {
  const res = await client.query(
    `SELECT ${NOTIFICATION_SELECT} ${NOTIFICATION_FROM} WHERE n.id = $1 AND n.company_id = $2`,
    [id, companyId]
  );
  if (res.rows.length === 0) throw notFound('Notification not found');
  return equityNotificationView(res.rows[0] as Row);
};

/** The settlement account an integration is pointed at, with its currency. */
export interface EquitySettlementAccount {
  id: number;
  code: string;
  name: string;
  currency: string;
  isActive: boolean;
}

async function settlementAccount(
  client: pg.PoolClient,
  companyId: number,
  id: number | null
): Promise<EquitySettlementAccount | null> {
  if (id === null) return null;
  const res = await client.query(
    'SELECT id, code, name, currency, is_active FROM bank_accounts WHERE id = $1 AND company_id = $2',
    [id, companyId]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as Row;
  return {
    id: Number(r.id),
    code: String(r.code ?? ''),
    name: String(r.name ?? ''),
    currency: String(r.currency ?? ''),
    isActive: r.is_active === true,
  };
}

/**
 * Everything that would stop an inbound notification from being trusted or
 * resolved, expressed the way an administrator can act on it.
 */
function configWarnings(config: EquityConfigView, account: EquitySettlementAccount | null): string[] {
  const warnings: string[] = [];
  if (config.publicKeyFingerprint === null && !config.envKeyPresent) {
    warnings.push('No usable Equity public key is stored, so every inbound notification will be refused.');
  } else if (config.publicKeyPresent && config.publicKeyFingerprint === null) {
    warnings.push('The stored Equity public key could not be read as an RSA public key. Paste the full PEM block.');
  }
  if (config.bankAccountId === null) {
    warnings.push('No settlement account is linked, so a notification cannot be resolved to this company ledger.');
  } else if (account === null) {
    warnings.push('The linked settlement account no longer exists for this company.');
  } else {
    if (!account.isActive) warnings.push(`Settlement account ${account.code} is inactive.`);
    if (account.currency !== config.currency) {
      warnings.push(
        `The integration is configured for ${config.currency} but settlement account ${account.code} is in ${account.currency}.`
      );
    }
  }
  if (config.tillNumber === null && config.organizationShortCode === null) {
    warnings.push('No till number or organisation short code is set, so a till notification cannot be attributed.');
  }
  return warnings;
}

/** Public configuration for the acting company. Never contains key material. */
export async function equityConfig(client: pg.PoolClient, ctx: Ctx): Promise<EquityConfigView> {
  return equityConfigView(await getEquityIntegration(client, ctx));
}

export interface EquityConfigSaveResult {
  config: EquityConfigView;
  warnings: string[];
}

/** Coerce an administrator's payload into the config patch the service applies. */
export function equityConfigPatchFrom(body: Record<string, unknown>): EquityConfigPatch {
  const optionalText = (v: unknown): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  };
  const patch: EquityConfigPatch = {};
  if (body.environment !== undefined) patch.environment = String(body.environment ?? '').trim();
  const country = optionalText(body.country);
  if (country !== undefined) patch.country = country;
  const currency = optionalText(body.currency);
  if (currency !== undefined) patch.currency = currency;
  for (const field of ['organizationShortCode', 'tillNumber', 'gatewayBaseUrl', 'publicKey', 'privateKey', 'consumerKey', 'consumerSecret'] as const) {
    const value = optionalText(body[field]);
    if (value !== undefined) patch[field] = value;
  }
  if (body.bankAccountId !== undefined) {
    if (body.bankAccountId === null || String(body.bankAccountId).trim() === '') patch.bankAccountId = null;
    else patch.bankAccountId = Number(body.bankAccountId);
  }
  if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;
  return patch;
}

/** Apply an administrator's changes and report what still needs attention. */
export async function updateEquityFromPatch(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<EquityConfigSaveResult> {
  const config = await updateEquityConfig(client, ctx, equityConfigPatchFrom(body));
  const account = await settlementAccount(client, requireCompany(ctx), config.bankAccountId);
  return { config, warnings: configWarnings(config, account) };
}

export interface EquityConnectionCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** True when a failure here means notifications cannot be trusted or resolved. */
  critical: boolean;
}

export interface EquityConnectionTestResult {
  ok: boolean;
  status: 'CONNECTED' | 'ERROR';
  testedAt: string;
  checks: EquityConnectionCheck[];
  config: EquityConfigView;
}

/**
 * Confirm, as far as it can be confirmed from this side, that the integration
 * is in a state where a notification would be verified and resolved. The result
 * is recorded on the integration row and in the audit trail.
 */
export async function testEquityConnection(client: pg.PoolClient, ctx: Ctx): Promise<EquityConnectionTestResult> {
  const companyId = requireCompany(ctx);
  const row = await getEquityIntegration(client, ctx);
  const config = equityConfigView(row);
  const stored = readEquityConfig(row);
  const account = await settlementAccount(client, companyId, config.bankAccountId);

  const checks: EquityConnectionCheck[] = [
    {
      key: 'integration',
      label: 'Integration record',
      ok: config.configured,
      detail: config.configured ? `Configured for company ${companyId}` : 'No Equity integration exists for this company yet',
      critical: true,
    },
    {
      key: 'signing_key',
      label: 'Notification signing key',
      ok: config.publicKeyFingerprint !== null || config.envKeyPresent,
      detail: config.publicKeyFingerprint !== null
        ? `Loaded from this integration (${config.publicKeyFingerprint})`
        : config.envKeyPresent
          ? 'Loaded from the platform EQUITY_IPN_PUBLIC_KEY environment variable'
          : config.publicKeyPresent
            ? 'A key is stored but it does not parse as an RSA public key'
            : 'No public key stored; Equity notifications cannot be verified',
      critical: true,
    },
    {
      key: 'settlement_account',
      label: 'Settlement account',
      ok: account !== null && account.isActive,
      detail:
        account === null
          ? 'No active bank account is linked to this integration'
          : `${account.code} - ${account.name} (${account.currency})${account.isActive ? '' : ' inactive'}`,
      critical: true,
    },
    {
      key: 'currency',
      label: 'Currency alignment',
      ok: account !== null && account.currency === stored.currency,
      detail:
        account === null
          ? 'Cannot be checked without a settlement account'
          : account.currency === stored.currency
            ? `Integration and account both settle in ${stored.currency}`
            : `Integration says ${stored.currency}, account ${account.code} is ${account.currency}`,
      critical: true,
    },
    {
      key: 'attribution',
      label: 'Till / short code',
      ok: config.tillNumber !== null || config.organizationShortCode !== null,
      detail:
        config.tillNumber !== null || config.organizationShortCode !== null
          ? `Till ${config.tillNumber ?? '-'} / short code ${config.organizationShortCode ?? '-'}`
          : 'Only account notifications that carry the account number can be attributed',
      critical: false,
    },
    {
      key: 'gateway',
      label: 'Outbound gateway',
      ok: config.gatewayBaseUrl !== null,
      detail: config.gatewayBaseUrl ?? 'Not set. Outbound transfers are not enabled, so this is informational only',
      critical: false,
    },
  ];

  const ok = checks.every((check) => !check.critical || check.ok);
  const status: 'CONNECTED' | 'ERROR' = ok ? 'CONNECTED' : 'ERROR';
  await markEquityTested(client, ctx, status);
  await auditConfig(
    client,
    ctx,
    'test',
    'finance.equity.config',
    config.integrationId,
    null,
    { ok, checks },
    { code: EQUITY_CODE, environment: config.environment }
  );
  return { ok, status, testedAt: new Date().toISOString(), checks, config: await equityConfig(client, ctx) };
}

export interface EquityStatusTotals {
  total: number;
  received: number;
  posted: number;
  matched: number;
  rejected: number;
  validationChecks: number;
  /** Money received into the bank but not yet linked to an invoice. */
  unreconciledCount: number;
  unreconciledAmount: number;
  /** Notifications held because no bank account could be resolved for them. */
  unattributedCount: number;
}

export interface EquityStatusView {
  config: EquityConfigView;
  totals: EquityStatusTotals;
  warnings: string[];
  lastNotifiedAt: string | null;
}

export async function equityStatus(client: pg.PoolClient, ctx: Ctx): Promise<EquityStatusView> {
  const companyId = requireCompany(ctx);
  const row = await getEquityIntegration(client, ctx);
  const config = equityConfigView(row);

  const grouped = await client.query<{ status: string; is_validation: boolean; count: string | number; amount: string | number | null }>(
    `SELECT status,
            (notification_type = 'VALIDATION') AS is_validation,
            count(*)::int AS count,
            COALESCE(sum(amount), 0) AS amount
       FROM equity_payment_notifications
      WHERE company_id = $1
      GROUP BY status, is_validation`,
    [companyId]
  );

  const totals: EquityStatusTotals = {
    total: 0,
    received: 0,
    posted: 0,
    matched: 0,
    rejected: 0,
    validationChecks: 0,
    unreconciledCount: 0,
    unreconciledAmount: 0,
    unattributedCount: 0,
  };
  const amounts = new Map<string, number>();
  for (const r of grouped.rows) {
    const count = num(r.count) ?? 0;
    const amount = money(r.amount) ?? 0;
    if (r.is_validation === true) {
      totals.validationChecks += count;
      continue;
    }
    const status = String(r.status).toLowerCase();
    if (status === 'received') { totals.received += count; totals.unattributedCount += count; }
    else if (status === 'posted') { totals.posted += count; totals.unreconciledCount += count; }
    else if (status === 'matched') totals.matched += count;
    else if (status === 'rejected') totals.rejected += count;
    totals.total += count;
    amounts.set(status, (amounts.get(status) ?? 0) + amount);
  }
  totals.unreconciledAmount = Math.round((amounts.get('posted') ?? 0) * 100) / 100;

  const last = await client.query('SELECT max(created_at) AS last_at FROM equity_payment_notifications WHERE company_id = $1', [companyId]);
  const account = await settlementAccount(client, companyId, config.bankAccountId);
  return {
    config,
    totals,
    warnings: configWarnings(config, account),
    lastNotifiedAt: iso((last.rows[0] as Row | undefined)?.last_at),
  };
}

export interface EquityNotificationFilters {
  status?: string;
  notificationType?: string;
  bankAccountId?: number | null;
  /** true: linked to an invoice. false: money received but not yet reconciled. */
  matched?: boolean;
  search?: string;
  from?: string;
  to?: string;
  limit?: number | null;
  offset?: number | null;
}

export interface EquityNotificationPage {
  rows: EquityNotificationView[];
  total: number;
  limit: number;
  offset: number;
}

export async function listEquityNotifications(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: EquityNotificationFilters
): Promise<EquityNotificationPage> {
  const companyId = requireCompany(ctx);
  const where: string[] = ['n.company_id = $1'];
  const params: unknown[] = [companyId];
  const add = (clause: (index: number) => string, value: unknown): void => {
    params.push(value);
    where.push(clause(params.length));
  };

  if (filters.status) add((i) => `n.status = $${i}`, filters.status!.toUpperCase());
  if (filters.notificationType) add((i) => `n.notification_type = $${i}`, filters.notificationType!.toUpperCase());
  if (filters.bankAccountId != null) add((i) => `n.bank_account_id = $${i}`, filters.bankAccountId);
  if (filters.matched === true) where.push('n.matched_invoice_id IS NOT NULL');
  if (filters.matched === false) where.push("n.matched_invoice_id IS NULL AND n.status = 'POSTED'");
  if (filters.from) add((i) => `n.created_at >= $${i}::date`, filters.from);
  if (filters.to) add((i) => `n.created_at < ($${i}::date + INTERVAL '1 day')`, filters.to);
  if (filters.search) {
    add(
      (i) =>
        `(n.equity_transaction_id ILIKE '%' || $${i} || '%' OR n.transaction_reference ILIKE '%' || $${i} || '%'` +
        ` OR n.customer_reference ILIKE '%' || $${i} || '%' OR n.customer_name ILIKE '%' || $${i} || '%')`,
      filters.search
    );
  }

  const limit = Math.min(Math.max(num(filters.limit) ?? 50, 1), 200);
  const offset = Math.max(num(filters.offset) ?? 0, 0);
  const clause = where.join(' AND ');

  const rows = await client.query(
    `SELECT ${NOTIFICATION_SELECT} ${NOTIFICATION_FROM}
      WHERE ${clause}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const total = await client.query<{ count: string | number }>(
    `SELECT count(*)::int AS count FROM equity_payment_notifications n WHERE ${clause}`,
    params
  );
  return {
    rows: rows.rows.map((r) => equityNotificationView(r as Row)),
    total: num(total.rows[0]?.count) ?? 0,
    limit,
    offset,
  };
}

export interface EquityMatchResult {
  notification: EquityNotificationView;
  /** Outstanding on the invoice at the moment it was linked. */
  invoiceOutstanding: number | null;
  /** Payment minus outstanding: 0 when the payment settles the invoice exactly. */
  difference: number | null;
}

/**
 * Reconcile one received payment against one open invoice.
 *
 * The link is a statement of fact by a human: this money settles that invoice.
 * It does not post a receipt or move `amount_paid`, and the difference between
 * the payment and the outstanding balance is reported rather than enforced,
 * because part-payments and over-payments are real.
 */
export async function matchEquityNotification(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  invoiceId: number
): Promise<EquityMatchResult> {
  const companyId = requireCompany(ctx);
  const existing = await readNotification(client, companyId, id);
  if (existing.notificationType === 'VALIDATION') {
    throw badRequest('A validation check is not a payment and cannot be reconciled to an invoice');
  }
  if (existing.status === 'REJECTED') {
    throw badRequest('A rejected notification cannot be reconciled');
  }

  const invoiceRes = await client.query(
    `SELECT id, invoice_no, currency, status,
            (COALESCE(total, 0) - COALESCE(amount_paid, 0)) AS outstanding
       FROM customer_invoices
      WHERE id = $1 AND company_id = $2`,
    [invoiceId, companyId]
  );
  if (invoiceRes.rows.length === 0) throw notFound('Invoice not found');
  const invoice = invoiceRes.rows[0] as Row;
  const invoiceNo = String(invoice.invoice_no ?? '');
  const status = String(invoice.status ?? '');
  if (!OPEN_INVOICE_STATUSES.includes(status)) {
    throw badRequest(`Invoice ${invoiceNo} is ${status} and cannot be reconciled`);
  }
  const invoiceCurrency = text(invoice.currency);
  if (invoiceCurrency && existing.currency && invoiceCurrency.toUpperCase() !== existing.currency.toUpperCase()) {
    throw badRequest(`Invoice ${invoiceNo} is in ${invoiceCurrency} but the payment is in ${existing.currency}`);
  }

  if (existing.matchedInvoiceId !== invoiceId) {
    await client.query(
      `UPDATE equity_payment_notifications
          SET matched_invoice_id = $3, matched_at = now(), matched_by = $4, status = 'MATCHED', updated_at = now()
        WHERE id = $1 AND company_id = $2`,
      [id, companyId, invoiceId, ctx.userId ?? null]
    );
  }

  const creditedOutstanding = money(invoice.outstanding);
  const difference =
    creditedOutstanding !== null && existing.amount !== null
      ? Math.round((existing.amount - creditedOutstanding) * 100) / 100
      : null;

  await auditConfig(
    client,
    ctx,
    'match',
    'equity_payment_notifications',
    id,
    { matchedInvoiceId: existing.matchedInvoiceId, matchedInvoiceNo: existing.matchedInvoiceNo },
    { matchedInvoiceId: invoiceId, matchedInvoiceNo: invoiceNo },
    { code: EQUITY_CODE, amount: existing.amount, currency: existing.currency, difference }
  );

  return {
    notification: await readNotification(client, companyId, id),
    invoiceOutstanding: creditedOutstanding,
    difference,
  };
}

/** Undo a reconciliation. The payment line itself is never touched. */
export async function unmatchEquityNotification(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number
): Promise<EquityNotificationView> {
  const companyId = requireCompany(ctx);
  const existing = await readNotification(client, companyId, id);
  if (existing.matchedInvoiceId === null) return existing;

  // Back to POSTED when there is a ledger line, otherwise to the staged state.
  const restored = existing.bankTransactionId !== null ? 'POSTED' : 'RECEIVED';
  await client.query(
    `UPDATE equity_payment_notifications
        SET matched_invoice_id = NULL, matched_at = NULL, matched_by = NULL, status = $3, updated_at = now()
      WHERE id = $1 AND company_id = $2`,
    [id, companyId, restored]
  );

  await auditConfig(
    client,
    ctx,
    'unmatch',
    'equity_payment_notifications',
    id,
    { matchedInvoiceId: existing.matchedInvoiceId, matchedInvoiceNo: existing.matchedInvoiceNo },
    { matchedInvoiceId: null, matchedInvoiceNo: null, status: restored },
    { code: EQUITY_CODE }
  );

  return readNotification(client, companyId, id);
}

export interface EquityInvoiceCandidate {
  id: number;
  invoiceNo: string;
  customerName: string | null;
  currency: string | null;
  status: string;
  total: number | null;
  amountPaid: number | null;
  outstanding: number;
  invoiceDate: string | null;
}

/**
 * Open invoices a received payment could be reconciled against.
 *
 * The reconciliation screen has to offer a customer's invoice, not a database
 * id, so this is a bounded lookup by invoice number or customer name. It only
 * returns invoices the acting company owns, and only ones that are still open:
 * an invoice that is already PAID or VOID can never be the target of a match,
 * so offering it would only produce a refusal after the operator had picked it.
 */
export async function searchEquityInvoices(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { search?: string; limit?: number | null } = {}
): Promise<EquityInvoiceCandidate[]> {
  const companyId = requireCompany(ctx);
  const params: unknown[] = [companyId, OPEN_INVOICE_STATUSES];
  let clause = 'ci.company_id = $1 AND ci.status = ANY($2::text[])';
  const term = text(opts.search)?.trim();
  if (term) {
    params.push(`%${term}%`);
    clause += ` AND (ci.invoice_no ILIKE $${params.length} OR c.name ILIKE $${params.length})`;
  }
  const limit = Math.min(Math.max(num(opts.limit) ?? 20, 1), 50);
  const res = await client.query(
    `SELECT ci.id, ci.invoice_no, ci.currency, ci.status, ci.invoice_date,
            ci.total, ci.amount_paid,
            (COALESCE(ci.total, 0) - COALESCE(ci.amount_paid, 0)) AS outstanding,
            c.name AS customer_name
       FROM customer_invoices ci
       LEFT JOIN customers c ON c.id = ci.customer_id
      WHERE ${clause}
      ORDER BY ci.invoice_date DESC NULLS LAST, ci.id DESC
      LIMIT ${limit}`,
    params
  );
  return (res.rows as Row[]).map((r) => ({
    id: Number(r.id),
    invoiceNo: String(r.invoice_no ?? ''),
    customerName: text(r.customer_name),
    currency: text(r.currency),
    status: String(r.status ?? ''),
    total: money(r.total),
    amountPaid: money(r.amount_paid),
    outstanding: money(r.outstanding) ?? 0,
    invoiceDate: iso(r.invoice_date),
  }));
}
