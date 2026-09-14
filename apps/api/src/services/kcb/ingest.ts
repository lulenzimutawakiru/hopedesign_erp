/**
 * KCB inbound payment-notification ingest.
 *
 * One pipeline, run in this order, for every message KCB pushes at us:
 *
 *   Signature   The RSA signature over the RAW request body is the
 *               authentication. Every configured public key is tried; the key
 *               that verifies is also the attribution, because it names the
 *               company the message belongs to. Nothing is written before it.
 *   Resolve     creditAccountIdentifier / tillNumber / organizationShortCode
 *               are resolved to a bank account through a read-only SECURITY
 *               DEFINER helper. That has to work before any tenant context
 *               exists, because the message is what tells us the tenant.
 *   Stage       An idempotent insert into kcb_payment_notifications, with the
 *               company the signature verified against pinned as a hint, so a
 *               notification signed with one company key can never resolve
 *               into another company ledger.
 *   Post        Exactly one bank_transactions line, idempotent, and never for
 *               a VALIDATION leg - that leg authorises, it does not move money.
 *   Match       A best-effort link to an open customer invoice. The payment is
 *               never applied to the invoice here: applying money stays a human
 *               reconciliation step.
 *
 * All three published legs - account notification, till notification and the
 * optional OTC bill validation - authenticate through the same
 * verifyAndAttribute() helper. The validation leg deliberately gets no separate
 * code path: a second way to satisfy the signature check is a second way to get
 * it wrong.
 *
 * A message that cannot be attributed to a company is written nowhere at all.
 * It is refused, and the refusal is recorded best-effort - RLS will
 * legitimately decline to store an audit row that has no tenant, and losing
 * that log line is acceptable where a phantom ledger line would not be.
 *
 * KCB is the actor throughout: no user id is ever attached to the context.
 */
import pg from 'pg';
import { Ctx, detach, pool, query, tx } from '../../db.js';
import { logAudit } from '../audit.js';
import { normalizeIp, verifySignature } from './security.js';
import { KcbNotification, KcbNotificationType, normalizeKcbNotification } from './payload.js';
import { verificationKeys } from './config.js';

export interface KcbIngestResult {
  accepted: boolean;
  /** Stored status (RECEIVED / POSTED / MATCHED) or REJECTED on a refusal. */
  status: string;
  notificationId: number | null;
  duplicate: boolean;
  resolved: boolean;
  bankTransactionId: number | null;
  matchedInvoiceId: number | null;
  companyId: number | null;
  /** Refusal reason; null on an accepted message. */
  reason: string | null;
}

export interface KcbBillValidationResult {
  accepted: boolean;
  reason: string | null;
  /** The stored VALIDATION message, so the check itself is auditable. */
  notificationId: number | null;
  companyId: number | null;
  customerName: string | null;
  billAmount: number | null;
  currency: string | null;
  billType: string | null;
  creditAccountIdentifier: string | null;
  customerReference: string | null;
}

interface StageRow {
  notification_id: string | number | null;
  resolved: boolean | null;
  is_duplicate: boolean | null;
  tenant_id: string | number | null;
  company_id: string | number | null;
  branch_id: string | number | null;
  integration_id: string | number | null;
  bank_account_id: string | number | null;
  notification_status: string | null;
  reject_reason: string | null;
}

interface ResolveRow {
  tenant_id: number | string | null;
  company_id: number | string | null;
  bank_account_id: number | string | null;
  integration_id: number | string | null;
}

interface BillRow {
  id: string | number;
  invoice_no: string | null;
  outstanding: string | number | null;
  currency: string | null;
  customer_name: string | null;
  credit_account_no: string | null;
}

interface PersistInput {
  notification: KcbNotification;
  body: unknown;
  tenantId: number | null;
  companyId: number;
  ip: string;
  userAgent: string | null;
  keySource: string;
}

interface PersistOutcome {
  notificationId: number;
  status: string;
  duplicate: boolean;
  resolved: boolean;
  bankTransactionId: number | null;
  matchedInvoiceId: number | null;
}

/** A notification whose signature verified and whose company is known. */
interface Attribution {
  notification: KcbNotification;
  companyId: number;
  tenantId: number | null;
  keySource: string;
  ip: string;
  userAgent: string | null;
  rawBody?: Buffer | string | null;
}

interface VerifyOptions {
  body: unknown;
  rawBody?: Buffer | string | null;
  signature?: string | null;
  notificationType?: KcbNotificationType;
  ip?: string | null;
  userAgent?: string | null;
}

const toNum = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const errorCode = (err: unknown): string | null =>
  err && typeof err === 'object' ? ((err as { code?: string }).code ?? null) : null;

/** Header names KCB (and its gateway) have been seen to use. */
const SIGNATURE_HEADERS = ['signature', 'x-kcb-signature', 'x-signature'];

/**
 * Pull the signature out of the request headers. Header lookup is
 * case-insensitive here rather than relying on Node normalisation, because the
 * published contract spells the header `Signature`.
 */
export function readSignatureHeader(headers: Record<string, unknown>): string | null {
  for (const name of SIGNATURE_HEADERS) {
    const raw = headers[name];
    if (raw === undefined || raw === null) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = String(value ?? '').trim();
    if (trimmed !== '') return trimmed;
  }
  return null;
}

const refusal = (reason: string, extra: Partial<KcbIngestResult> = {}): KcbIngestResult => ({
  accepted: false,
  status: 'REJECTED',
  notificationId: null,
  duplicate: false,
  resolved: false,
  bankTransactionId: null,
  matchedInvoiceId: null,
  companyId: null,
  reason,
  ...extra,
});

const rejected = (reason: string, companyId: number | null = null): KcbIngestResult =>
  refusal(reason, { companyId });

/**
 * Best-effort record of a refused message. The console line is the durable
 * record when - as is usually the case - the message cannot be attributed to a
 * tenant and the audit insert is therefore rejected by row security.
 */
async function recordRefusal(opts: {
  ip: string;
  userAgent: string | null;
  reason: string;
  keySource: string | null;
  notificationType: string | null;
}): Promise<void> {
  console.warn(
    `[kcb][ipn] refused ${opts.reason} from ${opts.ip || 'unknown'} type=${opts.notificationType ?? 'n/a'}`
  );
  try {
    await detach(
      async (client, ctx) => {
        await logAudit(client, ctx, {
          action: 'kcb.notification.rejected',
          resource: 'kcb_payment_notifications',
          metadata: {
            reason: opts.reason,
            keySource: opts.keySource,
            notificationType: opts.notificationType,
            signatureVerified: false,
            source: 'KCB_IPN',
          },
        });
      },
      { tenantId: null, companyId: null, ip: opts.ip, userAgent: opts.userAgent }
    );
  } catch {
    /* no tenant to attribute the record to; the console line stands. */
  }
}

/** Resolve the destination account read-only, before any row is stored. */
async function resolveAccount(notification: KcbNotification): Promise<ResolveRow | null> {
  try {
    return await detach(async (client) => {
      const res = await client.query<ResolveRow>(
        `SELECT tenant_id, company_id, bank_account_id, integration_id
           FROM kcb_ipn_resolve_account($1,$2,$3)`,
        [
          notification.creditAccountIdentifier,
          notification.tillNumber,
          notification.organizationShortCode,
        ]
      );
      return res.rows.length > 0 ? res.rows[0] : null;
    }, {});
  } catch (err) {
    console.error('[kcb][ipn] account resolution failed', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * The single authentication gate. Verifies the signature over the raw body,
 * then binds the message to the company the verifying key belongs to.
 *
 * The account lookup is a cross-check, not a second source of authority: when
 * the payload resolves to a different company than the key that signed it, the
 * message is refused rather than trusted, so a key issued for one company can
 * never push money into another company ledger.
 */
async function verifyAndAttribute(
  opts: VerifyOptions
): Promise<{ ok: true; value: Attribution } | { ok: false; result: KcbIngestResult }> {
  const ip = normalizeIp(opts.ip);
  const userAgent = opts.userAgent ?? null;
  const signature = opts.signature ?? null;

  const notification = normalizeKcbNotification(opts.body, {
    notificationType: opts.notificationType,
  });
  if (!notification) {
    await recordRefusal({
      ip,
      userAgent,
      reason: 'UNPARSABLE_PAYLOAD',
      keySource: null,
      notificationType: opts.notificationType ?? null,
    });
    return { ok: false, result: rejected('UNPARSABLE_PAYLOAD') };
  }
  const type = notification.notificationType;

  let candidates: Awaited<ReturnType<typeof verificationKeys>> = [];
  try {
    candidates = await verificationKeys(pool);
  } catch (err) {
    console.error('[kcb][ipn] key lookup failed', err instanceof Error ? err.message : err);
    candidates = [];
  }
  if (candidates.length === 0) {
    // Fail closed: an integration with no usable key cannot accept anything.
    await recordRefusal({
      ip,
      userAgent,
      reason: 'NO_VERIFICATION_KEY',
      keySource: null,
      notificationType: type,
    });
    return { ok: false, result: rejected('NO_VERIFICATION_KEY') };
  }

  let matchedKey: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (
      verifySignature({ rawBody: opts.rawBody ?? null, signature, publicKeyPem: candidate.publicKey })
    ) {
      matchedKey = candidate;
      break;
    }
  }
  if (!matchedKey) {
    await recordRefusal({
      ip,
      userAgent,
      reason: 'INVALID_SIGNATURE',
      keySource: null,
      notificationType: type,
    });
    return { ok: false, result: rejected('INVALID_SIGNATURE') };
  }
  const keySource = matchedKey.source;

  const resolved = await resolveAccount(notification);
  let companyId = toNum(resolved?.company_id);
  let tenantId = toNum(resolved?.tenant_id);

  if (companyId !== null && matchedKey.companyId !== null && companyId !== matchedKey.companyId) {
    await recordRefusal({
      ip,
      userAgent,
      reason: 'KEY_SCOPE_MISMATCH',
      keySource,
      notificationType: type,
    });
    return { ok: false, result: rejected('KEY_SCOPE_MISMATCH') };
  }
  if (companyId === null) {
    // Platform environment key, or an account match: fall back to the company
    // the key itself belongs to.
    companyId = matchedKey.companyId;
    tenantId = matchedKey.tenantId ?? tenantId;
  }
  if (companyId === null) {
    await recordRefusal({
      ip,
      userAgent,
      reason: 'UNMAPPED_ACCOUNT',
      keySource,
      notificationType: type,
    });
    return { ok: false, result: rejected('UNMAPPED_ACCOUNT') };
  }

  return {
    ok: true,
    value: { notification, companyId, tenantId, keySource, ip, userAgent, rawBody: opts.rawBody },
  };
}

/**
 * Find the single open customer invoice a credit belongs to, or nothing.
 *
 * The amount has to land on the outstanding balance to the cent and the
 * currency has to agree. A reference hit on the invoice number wins, but only
 * when it is unique - two plausible invoices mean a human decides, and a
 * duplicate reference must never silently pick one.
 */
async function findInvoiceMatch(
  client: pg.PoolClient,
  companyId: number,
  notification: KcbNotification
): Promise<number | null> {
  const amount = notification.amount;
  if (amount === null || !(amount > 0)) return null;
  const res = await client.query<{ id: string | number; ref_hit: boolean }>(
    `SELECT id,
            (NULLIF($4, '') IS NOT NULL AND upper(invoice_no) = upper($4)) AS ref_hit
       FROM customer_invoices
      WHERE company_id = $1
        AND status IN ('POSTED','SUBMITTED','PARTIALLY_PAID')
        AND (NULLIF($2, '') IS NULL OR upper(currency) = upper($2))
        AND abs((COALESCE(total, 0) - COALESCE(amount_paid, 0)) - $3) <= 0.01
      ORDER BY ref_hit DESC, invoice_date DESC NULLS LAST, id DESC
      LIMIT 2`,
    [companyId, notification.currency, amount, notification.customerReference]
  );
  if (res.rows.length === 0) return null;
  if (res.rows.length === 1) return toNum(res.rows[0].id);
  return res.rows[0].ref_hit && !res.rows[1].ref_hit ? toNum(res.rows[0].id) : null;
}

/** Stage, post and match one notification inside a single transaction. */
async function persist(input: PersistInput): Promise<PersistOutcome | null> {
  const ctx: Ctx = {
    tenantId: input.tenantId,
    companyId: input.companyId,
    ip: input.ip,
    userAgent: input.userAgent,
  };
  const n = input.notification;

  return tx(async (client) => {
    const staged = await client.query<StageRow>(
      `SELECT notification_id, resolved, is_duplicate, tenant_id, company_id, branch_id,
              integration_id, bank_account_id, notification_status, reject_reason
         FROM kcb_ipn_stage($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        n.notificationType, n.kcbTransactionId, n.requestId, n.transactionReference,
        n.customerName, n.customerReference, n.customerMsisdn, n.amount, n.currency,
        n.narration, n.channelCode, n.tillNumber, n.organizationShortCode,
        n.creditAccountIdentifier, n.balance, n.transactionAt, JSON.stringify(input.body ?? {}),
        true, input.ip === '' ? null : input.ip, input.companyId,
      ]
    );
    const row = staged.rows[0];
    const notificationId = toNum(row?.notification_id);
    if (!row || notificationId === null) return null;

    const duplicate = row.is_duplicate === true;
    const bankAccountId = toNum(row.bank_account_id);

    // Idempotent: on a replay this returns the already-linked ledger line. A
    // VALIDATION leg and an unresolved account both return null, which is the
    // correct answer for "nothing was posted".
    const posted = await client.query<{ bank_transaction_id: string | number | null }>(
      'SELECT bank_transaction_id FROM kcb_ipn_post_transaction($1)',
      [notificationId]
    );
    const bankTransactionId = toNum(posted.rows[0]?.bank_transaction_id);

    let matchedInvoiceId: number | null = null;
    if (n.notificationType !== 'VALIDATION' && bankTransactionId !== null) {
      const candidate = await findInvoiceMatch(client, input.companyId, n);
      if (candidate !== null) {
        const updated = await client.query(
          `UPDATE kcb_payment_notifications
              SET status = 'MATCHED', matched_at = now(), matched_invoice_id = $2, updated_at = now()
            WHERE id = $1 AND status = 'POSTED'
            RETURNING id`,
          [notificationId, candidate]
        );
        if (updated.rows.length > 0) matchedInvoiceId = candidate;
      }
    }

    const status =
      matchedInvoiceId !== null
        ? 'MATCHED'
        : bankTransactionId !== null
          ? 'POSTED'
          : row.notification_status ?? 'RECEIVED';

    await logAudit(client, ctx, {
      action: duplicate ? 'kcb.notification.duplicate' : 'kcb.notification.received',
      resource: 'kcb_payment_notifications',
      recordId: notificationId,
      recordCode: n.kcbTransactionId ?? n.requestId ?? null,
      newValues: {
        notificationType: n.notificationType,
        amount: n.amount,
        currency: n.currency,
        transactionReference: n.transactionReference,
        bankAccountId,
        bankTransactionId,
        status,
      },
      metadata: {
        keySource: input.keySource,
        duplicate,
        signatureVerified: true,
        matchedInvoiceId,
        source: 'KCB_IPN',
      },
    });

    return {
      notificationId,
      status,
      duplicate,
      resolved: bankAccountId !== null,
      bankTransactionId,
      matchedInvoiceId,
    };
  }, ctx);
}

/**
 * KCB retries on timeout, so two copies of one message can genuinely race. The
 * unique index rejects the loser; re-running finds the stored row and reports
 * it as the duplicate it is, instead of failing the callback.
 */
async function persistWithRetry(input: PersistInput): Promise<PersistOutcome | null> {
  try {
    return await persist(input);
  } catch (err) {
    if (errorCode(err) === '23505') return persist(input);
    throw err;
  }
}

/** Ingest one inbound account / till notification. */
export async function ingestKcbNotification(opts: VerifyOptions): Promise<KcbIngestResult> {
  const attributed = await verifyAndAttribute(opts);
  if (!attributed.ok) return attributed.result;
  const { notification, companyId, tenantId, keySource, ip, userAgent } = attributed.value;

  const outcome = await persistWithRetry({
    notification,
    body: opts.body,
    tenantId,
    companyId,
    ip,
    userAgent,
    keySource,
  });

  if (!outcome) {
    await recordRefusal({
      ip,
      userAgent,
      reason: 'NOT_STORED',
      keySource,
      notificationType: notification.notificationType,
    });
    return rejected('NOT_STORED', companyId);
  }

  return {
    accepted: true,
    status: outcome.status,
    notificationId: outcome.notificationId,
    duplicate: outcome.duplicate,
    resolved: outcome.resolved,
    bankTransactionId: outcome.bankTransactionId,
    matchedInvoiceId: outcome.matchedInvoiceId,
    companyId,
    reason: null,
  };
}

/**
 * Answer an OTC / agency bill validation: is this reference valid, whose is it,
 * and what does it still owe?
 *
 * The message itself is stored as a VALIDATION row (so every check is
 * auditable) but it is never posted to the ledger - authorising a payment is
 * not receiving one. The amount answered back is read from our own invoice
 * record, never echoed from the request.
 */
export async function validateKcbBill(opts: VerifyOptions): Promise<KcbBillValidationResult> {
  const plain = (reason: string, companyId: number | null = null): KcbBillValidationResult => ({
    accepted: false,
    reason,
    notificationId: null,
    companyId,
    customerName: null,
    billAmount: null,
    currency: null,
    billType: null,
    creditAccountIdentifier: null,
    customerReference: null,
  });

  const attributed = await verifyAndAttribute({ ...opts, notificationType: 'VALIDATION' });
  if (!attributed.ok) return plain(attributed.result.reason ?? 'REJECTED');
  const { notification, companyId, tenantId, keySource, ip, userAgent } = attributed.value;

  const outcome = await persistWithRetry({
    notification,
    body: opts.body,
    tenantId,
    companyId,
    ip,
    userAgent,
    keySource,
  });
  if (!outcome) return plain('NOT_STORED', companyId);

  const reference = notification.customerReference;
  const ctx: Ctx = { tenantId, companyId, ip, userAgent };

  const bill = await tx(async (client) => {
    const found =
      reference === null
        ? null
        : ((
            await client.query<BillRow>(
              `SELECT ci.id, ci.invoice_no,
                      (COALESCE(ci.total, 0) - COALESCE(ci.amount_paid, 0)) AS outstanding,
                      ci.currency,
                      cu.name AS customer_name,
                      (SELECT ba.account_no
                         FROM company_integrations k
                         JOIN bank_accounts ba
                           ON k.config->>'bank_account_id' ~ '^[0-9]+$'
                          AND ba.id = (k.config->>'bank_account_id')::bigint
                          AND ba.is_active
                        WHERE k.code = 'KCB'
                          AND k.category = 'payments'
                          AND k.company_id = ci.company_id
                        ORDER BY k.is_active DESC, k.id
                        LIMIT 1) AS credit_account_no
                 FROM customer_invoices ci
                 LEFT JOIN customers cu ON cu.id = ci.customer_id
                WHERE ci.company_id = $1
                  AND upper(ci.invoice_no) = upper($2)
                  AND ci.status IN ('POSTED','SUBMITTED','PARTIALLY_PAID')
                ORDER BY ci.invoice_date DESC NULLS LAST, ci.id DESC
                LIMIT 1`,
              [companyId, reference]
            )
          ).rows[0] ?? null);

    await logAudit(client, ctx, {
      action: 'kcb.validation.checked',
      resource: 'kcb_payment_notifications',
      recordId: outcome.notificationId,
      recordCode: reference,
      metadata: {
        keySource,
        billFound: found !== null,
        invoiceNo: found?.invoice_no ?? null,
        outstanding: found ? toNum(found.outstanding) : null,
        source: 'KCB_IPN',
      },
    });
    return found;
  }, ctx);

  return {
    accepted: bill !== null,
    reason: bill !== null ? null : 'UNKNOWN_BILL',
    notificationId: outcome.notificationId,
    companyId,
    customerName: bill?.customer_name ?? null,
    billAmount: bill ? toNum(bill.outstanding) : null,
    currency: bill?.currency ?? notification.currency,
    billType: bill !== null ? 'INVOICE' : null,
    creditAccountIdentifier: bill?.credit_account_no ?? notification.creditAccountIdentifier,
    customerReference: reference,
  };
}
