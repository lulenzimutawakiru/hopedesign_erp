// ============================================================
// Equity bank integration - inbound payment notifications.
//
// These endpoints are unauthenticated by design: the bank is the
// caller. The RSA signature over the raw request body is therefore
// the only thing standing between the open internet and the bank
// ledger, so most of what follows is about refusal:
//
//   * a tampered body, a foreign signing key, a missing header and an
//     unparsable payload are all refused, and a refusal stores nothing,
//   * an integration with no usable key fails closed,
//   * a replay of a genuinely signed message produces exactly one
//     ledger line, never two,
//   * a message whose destination account cannot be resolved is held
//     and never posted against a null account,
//   * a VALIDATION leg authorises but never posts,
//   * key material is returned by neither the configuration view nor
//     the write echo, an omitted secret is left alone, and '' clears it,
//   * an acknowledgement echoes identifiers only - never an amount or
//     a customer name - so a response cannot reflect supplied content.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { api, auth, loginAs, pool } from './helpers.js';

const TENANT_ID = 2;
const COMPANY_ID = 2;

/** Unique per run, so a row left by an earlier run cannot satisfy a test. */
const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const ref = (suffix: string) => `EQUITYTEST-${RUN}-${suffix}`;
const PREFIX = `EQUITYTEST-${RUN}%`;

/** A throwaway pair standing in for the key Equity would hold. */
const bankKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const EQUITY_PUBLIC_PEM = bankKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const EQUITY_PRIVATE_PEM = bankKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** The foreign key: a pair that must never be accepted. */
const foreignKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const FOREIGN_PRIVATE_PEM = foreignKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** The exact bytes Equity would sign, signed the way Equity would sign them. */
const sign = (raw: string, key: string = EQUITY_PRIVATE_PEM) =>
  createSign('sha256').update(Buffer.from(raw, 'utf8')).sign(key, 'base64');

/** Deliver a body exactly as Equity would, as raw bytes under a raw signature. */
function deliver(path: string, raw: string, signature: string | null = sign(raw), header = 'Signature') {
  const req = api.post(`/api/integrations/equity${path}`).set('Content-Type', 'application/json');
  if (signature !== null) req.set(header, signature);
  return req.send(raw);
}

/** Run a statement as the test tenant/company so RLS permits the write. */
async function asTenant(text: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_app_context($1,$2,NULL,NULL)', [TENANT_ID, COMPANY_ID]);
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const one = async <T>(text: string, params: unknown[] = []): Promise<T | null> => {
  const res = await pool.query(text, params);
  return res.rows.length > 0 ? (res.rows[0] as T) : null;
};

const count = async (text: string, params: unknown[] = []): Promise<number> =>
  Number((await pool.query(text, params)).rows[0].count);

/** How many stored notifications carry a given bank transaction id. */
const storedCount = (txnId: string) =>
  count('SELECT count(*)::int AS count FROM equity_payment_notifications WHERE equity_transaction_id = $1', [txnId]);

/** How many ledger lines the integration produced for a given bank reference. */
const ledgerLines = (txnId: string) =>
  count('SELECT count(*)::int AS count FROM bank_transactions WHERE statement_ref = $1', [`EQUITY:${txnId}`]);

const stored = (txnId: string) =>
  one<{
    id: number;
    status: string;
    reject_reason: string | null;
    bank_account_id: string | number | null;
    bank_transaction_id: string | number | null;
    integration_id: string | number | null;
    signature_verified: boolean;
    amount: string | null;
    currency: string | null;
    notification_type: string;
    customer_name: string | null;
    customer_msisdn: string | null;
    request_id: string | null;
    matched_invoice_id: string | number | null;
    transaction_at: string | null;
  }>(
    `SELECT id, status, reject_reason, bank_account_id, bank_transaction_id, integration_id,
            signature_verified, amount, currency, notification_type, customer_name,
            customer_msisdn, request_id, matched_invoice_id, transaction_at
       FROM equity_payment_notifications WHERE equity_transaction_id = $1`,
    [txnId]
  );

let integrationId = 0;
let bankAccountId = 0;
let bankAccountNo = '';
/**
 * The currency of the linked settlement account. The fixture, the integration
 * config, the invoices and every notification agree on this one currency, so a
 * currency mismatch can only ever be something a test asked for.
 */
let accountCurrency = 'UGX';
let matchInvoiceId = 0;
let matchInvoiceNo = '';
let validateInvoiceId = 0;
let validateInvoiceNo = '';

/** The integration config as it stands, so a test can perturb and restore it. */
const configOf = async (): Promise<Record<string, unknown>> =>
  (await one<{ config: Record<string, unknown> }>('SELECT config FROM company_integrations WHERE id = $1', [integrationId]))
    ?.config ?? {};

beforeAll(async () => {
  const acct = await one<{ id: number; account_no: string; currency: string }>(
    'SELECT id, account_no, currency FROM bank_accounts WHERE company_id = $1 AND is_active ORDER BY id LIMIT 1',
    [COMPANY_ID]
  );
  if (!acct) throw new Error('no active bank account to settle into');
  bankAccountId = Number(acct.id);
  bankAccountNo = String(acct.account_no);
  accountCurrency = String(acct.currency ?? 'UGX').toUpperCase();

  const customer = await one<{ id: number }>(
    'SELECT id FROM customers WHERE company_id = $1 ORDER BY id LIMIT 1',
    [COMPANY_ID]
  );
  if (!customer) throw new Error('no customer to raise a test invoice for');

  // Two invoices with amounts no other test touches, so the automatic match
  // and the bill validation can be driven without racing the rest of the file.
  matchInvoiceNo = ref('INV-MATCH');
  validateInvoiceNo = ref('INV-VALIDATE');
  const invoices = await asTenant(
    `INSERT INTO customer_invoices (tenant_id, company_id, invoice_no, customer_id, invoice_date, currency, status, subtotal, total, amount_paid)
     VALUES ($1,$2,$3,$4,CURRENT_DATE,$8,'POSTED',$5,$5,0),
            ($1,$2,$6,$4,CURRENT_DATE,$8,'POSTED',$7,$7,0)
     RETURNING id, invoice_no`,
    [TENANT_ID, COMPANY_ID, matchInvoiceNo, Number(customer.id), 77777.77, validateInvoiceNo, 88888.88, accountCurrency]
  );
  for (const row of invoices.rows as { id: number; invoice_no: string }[]) {
    if (row.invoice_no === matchInvoiceNo) matchInvoiceId = Number(row.id);
    if (row.invoice_no === validateInvoiceNo) validateInvoiceId = Number(row.id);
  }

  const ci = await asTenant(
    `INSERT INTO company_integrations (tenant_id, company_id, code, category, name, description, config, secrets, status, is_active)
     VALUES ($1,$2,'EQUITY','payments','Equity Bank Notifications','Integration test fixture',$3::jsonb,'{}'::jsonb,'CONNECTED',true)
     ON CONFLICT (tenant_id, company_id, code)
     DO UPDATE SET is_active = true, status = 'CONNECTED', config = EXCLUDED.config
     RETURNING id`,
    [
      TENANT_ID,
      COMPANY_ID,
      JSON.stringify({
        equity_public_key: EQUITY_PUBLIC_PEM,
        bank_account_id: String(bankAccountId),
        till_number: `TILL-${RUN}`,
        organization_short_code: `ORG-${RUN}`,
        environment: 'SANDBOX',
        country: 'UG',
        currency: accountCurrency,
      }),
    ]
  );
  integrationId = Number(ci.rows[0].id);
});

afterAll(async () => {
  await asTenant('DELETE FROM equity_payment_notifications WHERE company_id = $1 AND (equity_transaction_id LIKE $2 OR transaction_reference LIKE $2)', [COMPANY_ID, PREFIX]);
  await pool.query("DELETE FROM bank_transactions WHERE statement_ref LIKE $1", [`EQUITY:EQUITYTEST-${RUN}%`]);
  await asTenant('DELETE FROM customer_invoices WHERE company_id = $1 AND invoice_no LIKE $2', [COMPANY_ID, PREFIX]);
  await asTenant('DELETE FROM company_integrations WHERE id = $1', [integrationId]);
});
/** A flat account-notification body, as Equity publishes it. */
const accountBody = (txnId: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    transactionReference: txnId,
    requestId: `${txnId}-REQ`,
    channelCode: 'EQUITY',
    timestamp: '20260914120000',
    transactionAmount: '125000.00',
    currency: accountCurrency,
    customerReference: 'REF-NONE',
    customerName: 'Nile Stationery Co',
    customerMobileNumber: '254700000001',
    balance: '900000.00',
    narration: 'Payment received',
    creditAccountIdentifier: bankAccountNo,
    organizationShortCode: `ORG-${RUN}`,
    tillNumber: `TILL-${RUN}`,
    ...over,
  });

describe('Equity inbound notifications - signature is the authentication', () => {
  it('accepts a correctly signed account notification and posts exactly one ledger line', async () => {
    const txnId = ref('ACCEPT');
    const res = await deliver('/account-notification', accountBody(txnId));

    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe('0');
    expect(res.body.transactionID).toBe(txnId);

    // The acknowledgement carries identifiers only: a response must never be
    // usable to reflect back an amount or a customer name.
    const echoed = JSON.stringify(res.body);
    expect(echoed).not.toContain('125000');
    expect(echoed).not.toContain('Nile Stationery');

    const row = await stored(txnId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('POSTED');
    expect(row!.signature_verified).toBe(true);
    expect(Number(row!.integration_id)).toBe(integrationId);
    expect(Number(row!.bank_account_id)).toBe(bankAccountId);
    expect(row!.bank_transaction_id).not.toBeNull();
    expect(row!.reject_reason).toBeNull();
    expect(Number(row!.amount)).toBe(125000);
    expect(row!.currency).toBe(accountCurrency);
    // Compact YYYYMMDDHHMMSS is stamped in EAT (UTC+3) and stored as an instant.
    expect(new Date(String(row!.transaction_at)).toISOString()).toBe('2026-09-14T09:00:00.000Z');

    expect(await ledgerLines(txnId)).toBe(1);
    const line = await one<{ credit: string; debit: string; statement_ref: string }>(
      'SELECT credit, debit, statement_ref FROM bank_transactions WHERE statement_ref = $1',
      [`EQUITY:${txnId}`]
    );
    expect(Number(line!.credit)).toBe(125000);
    expect(Number(line!.debit)).toBe(0);
  });

  it('accepts the signature under the documented header aliases', async () => {
    const txnId = ref('ALIAS');
    const raw = accountBody(txnId);
    const res = await deliver('/account-notification', raw, sign(raw), 'X-Equity-Signature');
    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe('0');
    expect(await ledgerLines(txnId)).toBe(1);
  });

  it('refuses a body that was edited after it was signed', async () => {
    const txnId = ref('TAMPER');
    const raw = accountBody(txnId);
    const signature = sign(raw);
    const tampered = raw.replace('125000.00', '925000.00');
    expect(tampered).not.toBe(raw);

    const res = await deliver('/account-notification', tampered, signature);
    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe('1');

    expect(await storedCount(txnId)).toBe(0);
    expect(await ledgerLines(txnId)).toBe(0);
  });

  it('refuses a signature made with a key that is not Equity\u2019s', async () => {
    const txnId = ref('FOREIGN');
    const raw = accountBody(txnId);
    const res = await deliver('/account-notification', raw, sign(raw, FOREIGN_PRIVATE_PEM));
    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe('1');
    expect(await storedCount(txnId)).toBe(0);
    expect(await ledgerLines(txnId)).toBe(0);
  });

  it('refuses a message with no signature at all', async () => {
    const txnId = ref('NOSIG');
    const res = await deliver('/account-notification', accountBody(txnId), null);
    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe('1');
    expect(await storedCount(txnId)).toBe(0);
  });

  it('fails closed when the integration has no usable key', async () => {
    const original = await configOf();
    await asTenant("UPDATE company_integrations SET config = config - 'equity_public_key' WHERE id = $1", [integrationId]);
    try {
      const txnId = ref('NOKEY');
      const res = await deliver('/account-notification', accountBody(txnId));
      expect(res.status).toBe(200);
      expect(res.body.statusCode).toBe('1');
      expect(await storedCount(txnId)).toBe(0);
      expect(await ledgerLines(txnId)).toBe(0);
    } finally {
      await asTenant('UPDATE company_integrations SET config = $2::jsonb WHERE id = $1', [integrationId, JSON.stringify(original)]);
    }
  });

  it('refuses a payload it cannot normalise', async () => {
    const raw = '[]';
    const res = await deliver('/account-notification', raw);
    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe('1');
  });

  it('answers a malformed body with 400 so a damaged delivery can be retried', async () => {
    const res = await api
      .post('/api/integrations/equity/account-notification')
      .set('Content-Type', 'application/json')
      .set('Signature', sign('{'))
      .send('{');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('turns a replayed notification into one ledger line, not two', async () => {
    const txnId = ref('REPLAY');
    const raw = accountBody(txnId);

    const first = await deliver('/account-notification', raw);
    const second = await deliver('/account-notification', raw);

    expect(first.body.statusCode).toBe('0');
    // A retry is answered as received: it must not be refused, or Equity keeps
    // retrying forever, and it must not post again, or the money doubles.
    expect(second.body.statusCode).toBe('0');
    expect(await storedCount(txnId)).toBe(1);
    expect(await ledgerLines(txnId)).toBe(1);
  });
});
/** The nested till envelope: the same money, in the shape the till leg uses. */
const tillBody = (txnId: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    header: {
      messageID: `MSG-${txnId}`,
      originatorConversationID: `CONV-${txnId}`,
      channelCode: 'EQUITY',
      timeStamp: '20260914133100',
    },
    requestPayload: {
      primaryData: { businessKey: `TILL-${RUN}`, businessKeyType: 'notifyBiller' },
      additionalData: {
        notificationData: {
          businessKey: `TILL-${RUN}`,
          businessKeyType: 'notifyBiller',
          debitMSISDN: '254700000002',
          transactionAmt: '150000.00',
          transactionDate: 'Mon Sep 14 13:30:54 EAT 2026',
          transactionID: txnId,
          firstName: 'Nile',
          middleName: '',
          lastName: 'Stationery',
          currency: accountCurrency,
          narration: 'Till payment',
          transactionType: 'PAYMENT',
          balance: '1050000.00',
          tillNumber: `TILL-${RUN}`,
          ...over,
        },
      },
    },
  });

describe('Equity published envelopes - one record, two shapes', () => {
  it('reads the nested till envelope into the same record as the flat one', async () => {
    const txnId = ref('TILL');
    const res = await deliver('/till-notification', tillBody(txnId));

    expect(res.status).toBe(200);
    expect(res.body.header.statusCode).toBe('0');
    expect(res.body.header.messageID).toBe(`MSG-${txnId}`);
    expect(res.body.responsePayload.transactionInfo.transactionId).toBe(txnId);

    const row = await stored(txnId);
    expect(row).not.toBeNull();
    expect(row!.notification_type).toBe('TILL');
    expect(Number(row!.amount)).toBe(150000);
    expect(row!.currency).toBe(accountCurrency);
    // This leg sends the payer's name in three parts and the MSISDN under a
    // different name than the account leg.
    expect(row!.customer_name).toBe('Nile Stationery');
    expect(row!.customer_msisdn).toBe('254700000002');
    expect(row!.request_id).toBe(`CONV-${txnId}`);
    expect(Number(row!.bank_account_id)).toBe(bankAccountId);
    expect(row!.reject_reason).toBeNull();
    expect(row!.status).toBe('POSTED');
    // "Mon Sep 14 13:30:54 EAT 2026" is a real instant, not an ISO string.
    expect(new Date(String(row!.transaction_at)).toISOString()).toBe('2026-09-14T10:30:54.000Z');
    expect(await ledgerLines(txnId)).toBe(1);
  });

  it('holds a notification it cannot attribute to an account, and posts nothing', async () => {
    const txnId = ref('UNMAPPED');
    const raw = accountBody(txnId, {
      creditAccountIdentifier: `NO-SUCH-ACCOUNT-${RUN}`,
      tillNumber: `TILL-NOSUCH-${RUN}`,
      organizationShortCode: `ORG-NOSUCH-${RUN}`,
    });
    const res = await deliver('/account-notification', raw);
    expect(res.status).toBe(200);

    // The message is durably recorded - that is what makes it reconcilable by a
    // human afterwards - but it is held, and money is never posted against a
    // null account.
    const row = await stored(txnId);
    expect(row).not.toBeNull();
    expect(row!.bank_account_id).toBeNull();
    expect(row!.bank_transaction_id).toBeNull();
    expect(row!.reject_reason).toBe('UNMAPPED_ACCOUNT');
    expect(row!.status).toBe('RECEIVED');
    expect(await ledgerLines(txnId)).toBe(0);
  });

  it('answers a bill validation from our own invoice record and never posts it', async () => {
    const txnId = ref('VALIDATE');
    const res = await deliver('/validation', accountBody(txnId, { customerReference: validateInvoiceNo }));

    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe('0');
    expect(res.body.CustomerName).toBe('Walk-In Counter Customer');
    expect(Number(res.body.billAmount)).toBe(88888.88);
    expect(res.body.billType).toBe('INVOICE');
    expect(res.body.creditAccountIdentifier).toBe(bankAccountNo);

    const row = await stored(txnId);
    expect(row!.notification_type).toBe('VALIDATION');
    expect(row!.bank_transaction_id).toBeNull();
    expect(await ledgerLines(txnId)).toBe(0);
  });

  it('declines a validation for a reference it does not hold', async () => {
    const txnId = ref('VALIDATE-MISS');
    const res = await deliver('/validation', accountBody(txnId, { customerReference: ref('NO-SUCH-INVOICE') }));

    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe('1');
    expect(res.body.CustomerName).toBe('');
    expect(res.body.billAmount).toBe(0);
  });
});

describe('Equity reconciliation of a received payment', () => {
  it('links a payment to the one invoice whose balance it settles, without touching the invoice', async () => {
    const txnId = ref('AUTOMATCH');
    const res = await deliver(
      '/account-notification',
      accountBody(txnId, { transactionAmount: '77777.77', customerReference: matchInvoiceNo })
    );
    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe('0');

    const row = await stored(txnId);
    expect(row!.status).toBe('MATCHED');
    expect(Number(row!.matched_invoice_id)).toBe(matchInvoiceId);
    expect(await ledgerLines(txnId)).toBe(1);

    // Linking says "this money settles that invoice". It is not a receipt, so
    // the invoice balance is untouched until someone posts the payment.
    const invoice = await one<{ amount_paid: string }>(
      'SELECT amount_paid FROM customer_invoices WHERE id = $1',
      [matchInvoiceId]
    );
    expect(Number(invoice!.amount_paid)).toBe(0);
  });

  it('leaves a payment that matches no invoice open for a human', async () => {
    const txnId = ref('NOMATCH');
    const res = await deliver(
      '/account-notification',
      accountBody(txnId, { transactionAmount: '33333.33', customerReference: ref('UNRELATED') })
    );
    expect(res.body.statusCode).toBe('0');

    const row = await stored(txnId);
    expect(row!.status).toBe('POSTED');
    expect(row!.matched_invoice_id).toBeNull();
    expect(await ledgerLines(txnId)).toBe(1);
  });
});

describe('Equity operator workspace', () => {
  let adminToken = '';
  let customerId = 0;
  let foreignInvoiceId = 0;
  /** A signed payment that matches nothing, so it stays open for reconciliation. */
  const openTxnId = ref('OP');
  let openNotificationId = 0;

  beforeAll(async () => {
    adminToken = (await loginAs('admin')).token;
    const customer = await one<{ id: number }>(
      'SELECT id FROM customers WHERE company_id = $1 ORDER BY id LIMIT 1',
      [COMPANY_ID]
    );
    if (!customer) throw new Error('no customer to raise the foreign-currency invoice for');
    customerId = Number(customer.id);

    // An invoice in a currency the payment cannot be in: the guard under test is
    // that money is never reconciled across currencies.
    const foreign = await asTenant(
      `INSERT INTO customer_invoices (tenant_id, company_id, invoice_no, customer_id, invoice_date, currency, status, subtotal, total, amount_paid)
       VALUES ($1,$2,$3,$4,CURRENT_DATE,'USD','POSTED',555.55,555.55,0)
       RETURNING id`,
      [TENANT_ID, COMPANY_ID, ref('INV-USD'), customerId]
    );
    foreignInvoiceId = Number((foreign.rows[0] as { id: number }).id);

    const delivered = await deliver(
      '/account-notification',
      accountBody(openTxnId, { transactionAmount: '33333.33', customerReference: ref('UNRELATED') })
    );
    if (delivered.body.statusCode !== '0') throw new Error('fixture payment was not accepted');
    openNotificationId = Number((await stored(openTxnId))!.id);
  });

  const getConfig = async () => {
    const res = await api.get('/api/ops/finance/equity/config').set(auth(adminToken));
    expect(res.status).toBe(200);
    return res.body.data as Record<string, unknown>;
  };

  it('never returns key material in the configuration view', async () => {
    const cfg = await getConfig();
    expect(cfg.integrationId).toBe(integrationId);
    expect(cfg.publicKeyPresent).toBe(true);
    expect(String(cfg.publicKeyFingerprint)).toMatch(/^[0-9A-F]{32}$/);
    expect(cfg.readyForNotifications).toBe(true);
    for (const secret of ['publicKey', 'privateKey', 'consumerKey', 'consumerSecret']) {
      expect(secret in cfg).toBe(false);
    }
    const serialised = JSON.stringify(cfg);
    expect(serialised).not.toContain('BEGIN PUBLIC KEY');
    expect(serialised).not.toContain('PRIVATE KEY');
  });

  it('leaves the signing key alone when an unrelated setting changes', async () => {
    const before = String((await getConfig()).publicKeyFingerprint);
    const res = await api
      .patch('/api/ops/finance/equity/config')
      .set(auth(adminToken))
      .send({ tillNumber: `TILL-${RUN}` });

    expect(res.status).toBe(200);
    const data = res.body.data as { config: Record<string, unknown>; warnings: string[] };
    expect(data.config.tillNumber).toBe(`TILL-${RUN}`);
    expect(data.config.publicKeyFingerprint).toBe(before);
  });

  it('clears a key on an explicit empty string, and trusts a replacement', async () => {
    const fingerprint = String((await getConfig()).publicKeyFingerprint);

    const cleared = await api
      .patch('/api/ops/finance/equity/config')
      .set(auth(adminToken))
      .send({ publicKey: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.config.publicKeyPresent).toBe(false);
    expect(cleared.body.data.config.publicKeyFingerprint).toBeNull();

    // No key means no trust: the receiver must fail closed, not fall back.
    const refusedTxnId = ref('CLEARED');
    const refused = await deliver('/account-notification', accountBody(refusedTxnId));
    expect(refused.body.statusCode).toBe('1');
    expect(await storedCount(refusedTxnId)).toBe(0);

    const restored = await api
      .patch('/api/ops/finance/equity/config')
      .set(auth(adminToken))
      .send({ publicKey: EQUITY_PUBLIC_PEM });
    expect(restored.status).toBe(200);
    expect(restored.body.data.config.publicKeyFingerprint).toBe(fingerprint);

    // The stored key is the one actually used, so the same signature verifies again.
    const acceptedTxnId = ref('RESTORED');
    const accepted = await deliver('/account-notification', accountBody(acceptedTxnId));
    expect(accepted.body.statusCode).toBe('0');
    expect(await ledgerLines(acceptedTxnId)).toBe(1);
  });

  it('stores a credential under the name it reads, so presence survives the round trip', async () => {
    const consumerKey = ref('CONSUMER-KEY');
    const consumerSecret = ref('CONSUMER-SECRET');

    const saved = await api
      .patch('/api/ops/finance/equity/config')
      .set(auth(adminToken))
      .send({ privateKey: EQUITY_PRIVATE_PEM, consumerKey, consumerSecret });
    expect(saved.status).toBe(200);

    const view = saved.body.data.config as Record<string, unknown>;
    expect(view.privateKeyPresent).toBe(true);
    expect(view.consumerKeyPresent).toBe(true);
    expect(view.consumerSecretPresent).toBe(true);
    // A credential is reported as present, never as itself.
    const serialised = JSON.stringify(saved.body);
    expect(serialised).not.toContain(consumerKey);
    expect(serialised).not.toContain(consumerSecret);
    expect(serialised).not.toContain('PRIVATE KEY');

    // A later read agrees - which it cannot do if the write and the read
    // disagree about the name the value was stored under.
    const read = await getConfig();
    expect(read.privateKeyPresent).toBe(true);
    expect(read.consumerKeyPresent).toBe(true);
    expect(read.consumerSecretPresent).toBe(true);

    const cleared = await api
      .patch('/api/ops/finance/equity/config')
      .set(auth(adminToken))
      .send({ privateKey: '', consumerKey: '', consumerSecret: '' });
    expect(cleared.status).toBe(200);
    const clearedView = cleared.body.data.config as Record<string, unknown>;
    expect(clearedView.privateKeyPresent).toBe(false);
    expect(clearedView.consumerKeyPresent).toBe(false);
    expect(clearedView.consumerSecretPresent).toBe(false);
    // The clear is durable, not just an echo of the request.
    expect((await getConfig()).consumerKeyPresent).toBe(false);
  });

  it('offers the invoices a payment could be reconciled against', async () => {
    const res = await api
      .get('/api/ops/finance/equity/invoices')
      .query({ search: matchInvoiceNo })
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    const rows = res.body.data as { invoiceNo: string; outstanding: number; status: string }[];
    const found = rows.find((r) => r.invoiceNo === matchInvoiceNo);
    expect(found).toBeDefined();
    expect(Number(found!.outstanding)).toBe(77777.77);
    expect(found!.status).toBe('POSTED');
  });

  it('reconciles a payment, refuses a cross-currency match, and undoes it', async () => {
    const unmatchFirst = await api
      .post(`/api/ops/finance/equity/notifications/${openNotificationId}/unmatch`)
      .set(auth(adminToken));
    expect(unmatchFirst.status).toBe(200);
    expect(unmatchFirst.body.data.matchedInvoiceId).toBeNull();
    expect(unmatchFirst.body.data.status).toBe('POSTED');

    const foreign = await api
      .post(`/api/ops/finance/equity/notifications/${openNotificationId}/match`)
      .set(auth(adminToken))
      .send({ invoiceId: foreignInvoiceId });
    expect(foreign.status).toBe(400);

    const matched = await api
      .post(`/api/ops/finance/equity/notifications/${openNotificationId}/match`)
      .set(auth(adminToken))
      .send({ invoiceId: matchInvoiceId });
    expect(matched.status).toBe(200);
    expect(matched.body.data.notification.status).toBe('MATCHED');
    expect(Number(matched.body.data.notification.matchedInvoiceId)).toBe(matchInvoiceId);
    expect(matched.body.data.notification.matchedInvoiceNo).toBe(matchInvoiceNo);
    expect(Number(matched.body.data.invoiceOutstanding)).toBe(77777.77);
    // The shortfall is reported, not enforced: part-payments are real.
    expect(Number(matched.body.data.difference)).toBeCloseTo(-44444.44, 2);

    const undone = await api
      .post(`/api/ops/finance/equity/notifications/${openNotificationId}/unmatch`)
      .set(auth(adminToken));
    expect(undone.status).toBe(200);
    expect(undone.body.data.matchedInvoiceId).toBeNull();
    // Back to POSTED, not RECEIVED: the ledger line is still there.
    expect(undone.body.data.status).toBe('POSTED');
    expect(undone.body.data.bankTransactionId).not.toBeNull();

    const restored = await api
      .post(`/api/ops/finance/equity/notifications/${openNotificationId}/match`)
      .set(auth(adminToken))
      .send({ invoiceId: matchInvoiceId });
    expect(restored.body.data.notification.status).toBe('MATCHED');
  });

  it('filters the notification log by text, type and reconciliation state', async () => {
    const byText = await api
      .get('/api/ops/finance/equity/notifications')
      .query({ search: `EQUITYTEST-${RUN}`, limit: 200 })
      .set(auth(adminToken));
    expect(byText.status).toBe(200);
    const rows = byText.body.data.rows as { equityTransactionId: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => String(r.equityTransactionId).startsWith(`EQUITYTEST-${RUN}`))).toBe(true);

    const validations = await api
      .get('/api/ops/finance/equity/notifications')
      .query({ notificationType: 'VALIDATION', search: `EQUITYTEST-${RUN}`, limit: 200 })
      .set(auth(adminToken));
    const vRows = validations.body.data.rows as { notificationType: string }[];
    expect(vRows.length).toBeGreaterThanOrEqual(2);
    expect(vRows.every((r) => r.notificationType === 'VALIDATION')).toBe(true);

    const matchedOnly = await api
      .get('/api/ops/finance/equity/notifications')
      .query({ matched: true, search: `EQUITYTEST-${RUN}`, limit: 200 })
      .set(auth(adminToken));
    const mRows = matchedOnly.body.data.rows as { matchedInvoiceId: number | null }[];
    expect(mRows.length).toBeGreaterThan(0);
    expect(mRows.every((r) => r.matchedInvoiceId !== null)).toBe(true);
  });

  it('reports that a notification would be verified and resolved', async () => {
    const res = await api.post('/api/ops/finance/equity/test-connection').set(auth(adminToken));
    expect(res.status).toBe(200);

    const data = res.body.data as {
      ok: boolean;
      status: string;
      checks: { key: string; ok: boolean; critical: boolean }[];
    };
    expect(data.ok).toBe(true);
    expect(data.status).toBe('CONNECTED');
    const byKey = new Map(data.checks.map((c) => [c.key, c]));
    for (const key of ['integration', 'signing_key', 'settlement_account', 'currency']) {
      expect(byKey.get(key)?.ok).toBe(true);
    }
    expect(data.checks.every((c) => !c.critical || c.ok)).toBe(true);
  });

  it('surfaces a currency that disagrees with the settlement account', async () => {
    // The real risk this guards: the integration is configured to expect one
    // currency while the settlement account is denominated in another, and a
    // mismatch means money lands in a ledger it does not belong to.
    const other = accountCurrency === 'UGX' ? 'KES' : 'UGX';

    const patched = await api
      .patch('/api/ops/finance/equity/config')
      .set(auth(adminToken))
      .send({ currency: other });
    expect(patched.status).toBe(200);
    const warnings = patched.body.data.warnings as string[];
    expect(warnings.some((w) => w.includes(other))).toBe(true);

    const tested = await api.post('/api/ops/finance/equity/test-connection').set(auth(adminToken));
    expect(tested.body.data.status).toBe('ERROR');
    const currencyCheck = (tested.body.data.checks as { key: string; ok: boolean }[]).find(
      (c) => c.key === 'currency'
    );
    expect(currencyCheck?.ok).toBe(false);

    const restored = await api
      .patch('/api/ops/finance/equity/config')
      .set(auth(adminToken))
      .send({ currency: accountCurrency });
    expect(restored.status).toBe(200);
    expect(restored.body.data.warnings).toEqual([]);
    const retested = await api.post('/api/ops/finance/equity/test-connection').set(auth(adminToken));
    expect(retested.body.data.status).toBe('CONNECTED');
  });

  it('refuses to serve the workspace without a session', async () => {
    const res = await api.get('/api/ops/finance/equity/status');
    expect(res.status).toBe(401);
  });
});
