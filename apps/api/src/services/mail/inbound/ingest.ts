/**
 * Resend inbound mail ingest - the company mailing system's inbound half.
 *
 * One pipeline, run in this order, for every `email.received` webhook Resend
 * pushes at us:
 *
 *   Verify     The Svix signature over the RAW request body is the
 *              authentication. Nothing is fetched, resolved or written before
 *              it passes.
 *   Resolve    The addresses the message was delivered to are mapped onto an
 *              active mailbox through a read-only SECURITY DEFINER helper
 *              (0171). That has to work before any tenant context exists,
 *              because the message is what tells us the tenant.
 *   Fetch      Resend's webhook carries metadata only, so the body and headers
 *              are pulled back from the Received-emails API.
 *   File       One `emails` row in the resolved mailbox's INBOX, with its
 *              recipients, its attachment descriptors, an audit line and one
 *              `email_webhook_events` row recording the delivery.
 *
 * The mailbox is the attribution. A message delivered to an address that no
 * active mailbox owns is written nowhere at all: it is refused, the console
 * line and the webhook-event row are the trace, and no mail is invented into
 * an arbitrary tenant.
 *
 * Dedupe is application-level, on `provider_message_id`, because
 * idx_emails_provider_msg is not unique and Resend retries. The check and the
 * insert share one transaction, so a concurrent redelivery cannot slip between
 * them.
 *
 * Resend is the actor throughout: no user id is ever attached to the context.
 * An inbound message has a sender, not an author in our system.
 */
import { Ctx, detach, tx } from '../../../db.js';
import { logAudit } from '../../audit.js';
import {
  ReceivedEmail,
  fetchReceivedEmail,
  headerValue,
  isEmailAddress,
  parseFromHeader,
  verifyResendSignature,
} from './resend.js';

export interface IngestOptions {
  /** Resend's id for the received message. */
  emailId: string;
  /** Provider message id from the webhook envelope, when it carries one. */
  providerMessageId: string | null;
  eventType: string;
  /** Addresses in priority order: received_for first, then the To header. */
  recipients: string[];
  rawBody?: Buffer | string | null;
  headers?: Record<string, unknown>;
  /** The webhook payload, stored verbatim on the event row. */
  payload: unknown;
  ip: string;
  userAgent: string | null;
}

export interface IngestResult {
  accepted: boolean;
  /** Refusal reason, or null on an accepted delivery. */
  reason: string | null;
  /** The stored `emails` row, when one was written. */
  emailRowId: number | null;
  /** True when this delivery was already filed. */
  duplicate: boolean;
  mailboxId: number | null;
  tenantId: number | null;
  /**
   * True when the refusal was a transient fault rather than a permanent one, so
   * the caller may ask the provider to deliver the message again. A permanent
   * refusal - a bad signature, an address no mailbox owns - is never retryable:
   * a retry cannot repair it and only repeats the work.
   */
  retryable: boolean;
}

interface MailboxRow {
  tenant_id: string | number;
  company_id: string | number | null;
  branch_id: string | number | null;
  mailbox_id: string | number;
  mailbox_address: string;
  default_classification: string | null;
}

/** Classifications the mail module understands; anything else falls back. */
const CLASSIFICATIONS = new Set(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET']);

/** Recipient kinds allowed on email_recipients; there is no FROM kind. */
type RecipientKind = 'TO' | 'CC' | 'BCC';

function num(value: string | number | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The References chain, bounded so one abusive header cannot bloat a row. */
function referenceHeader(email: ReceivedEmail): string | null {
  const raw = headerValue(email.headers, 'references');
  if (!raw) return null;
  return raw.length > 32000 ? raw.slice(0, 32000) : raw;
}

/**
 * The addresses a message was delivered to, in the order they should be tried
 * as a mailbox. received_for is what the provider actually delivered to; the
 * To header is what the sender typed, and the two disagree whenever a message
 * is addressed through an alias, a display name or a list.
 */
function candidateAddresses(email: ReceivedEmail | null, fallback: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of [...(email?.received_for ?? []), ...(email?.to ?? []), ...fallback]) {
    const key = String(address ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Local parts that only ever appear on machine-sent mail. Our own outbound
 * uses `noreply@` for security and alert mail and `notifications@` for the
 * notification fan-out; when one of those addresses sends to a mailbox that we
 * also receive on, Resend hands the message straight back to us and it is filed
 * as "received" mail that no human wrote.
 *
 * A foreign `no-reply@` is ordinary correspondence, so this only counts when
 * the sender is also on the receiving mailbox's own domain - see isSelfEcho.
 */
const MACHINE_SENDER_LOCAL_PARTS = new Set([
  'no-reply',
  'noreply',
  'no_reply',
  'do-not-reply',
  'donotreply',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'bounces',
  'notifications',
  'notification',
  'automated',
  'mailer',
  'alerts',
]);

/** The domain part of an address, lower-cased, or '' when it has none. */
function addressDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
}

/** The local part of an address, lower-cased, or '' when it has none. */
function addressLocalPart(address: string): string {
  const at = address.lastIndexOf('@');
  return (at < 0 ? address : address.slice(0, at)).trim().toLowerCase();
}

/**
 * True when a message is our own automation arriving back at a mailbox we also
 * receive on: a machine local part sending from the receiving mailbox's own
 * domain. Everything else - a reply from a person, or machine mail from a
 * foreign domain - is false and is filed normally.
 */
function isSelfEcho(sender: string, mailboxAddress: string): boolean {
  const local = addressLocalPart(sender);
  const domain = addressDomain(sender);
  if (!local || !domain) return false;
  if (!MACHINE_SENDER_LOCAL_PARTS.has(local)) return false;
  return domain === addressDomain(mailboxAddress);
}
/** Fold one address list into the JSONB envelope column and recipient rows. */
function recipientLists(email: ReceivedEmail): { to: string[]; cc: string[]; bcc: string[] } {
  const clean = (list: string[]) =>
    list.map((a) => String(a ?? '').trim()).filter((a) => a.length > 0);
  return { to: clean(email.to), cc: clean(email.cc), bcc: clean(email.bcc) };
}

const refused = (
  reason: string,
  tenantId: number | null = null,
  retryable = false
): IngestResult => ({
  accepted: false,
  reason,
  emailRowId: null,
  duplicate: false,
  mailboxId: null,
  tenantId,
  retryable,
});

/**
 * Best-effort record of a webhook delivery. The console line is the durable
 * record when the message cannot be attributed to a tenant; the event row is
 * written through the SECURITY DEFINER helper, which is the one insert that
 * legitimately has no tenant.
 */
async function recordEvent(opts: {
  tenantId: number | null;
  eventType: string;
  providerMessageId: string | null;
  emailId: string | null;
  recipient: string | null;
  payload: unknown;
  signatureValid: boolean;
  error: string | null;
}): Promise<void> {
  try {
    await detach(async (client) => {
      await client.query(
        `SELECT mail_inbound_record_event($1,$2,$3,NULL,$4,$5::jsonb,$6,$7)`,
        [
          opts.tenantId,
          opts.eventType,
          opts.providerMessageId ?? opts.emailId ?? null,
          opts.recipient,
          JSON.stringify(opts.payload ?? {}),
          opts.signatureValid,
          opts.error,
        ]
      );
    }, {});
  } catch (err) {
    console.error('[mail][inbound] event record failed', err instanceof Error ? err.message : err);
  }
}

/** Resolve a delivered address to its mailbox, read-only, before any tenant ctx. */
async function resolveMailbox(addresses: string[]): Promise<MailboxRow | null> {
  if (addresses.length === 0) return null;
  try {
    return await detach(async (client) => {
      const res = await client.query<MailboxRow>(
        `SELECT tenant_id, company_id, branch_id, mailbox_id, mailbox_address, default_classification
           FROM mail_inbound_resolve_mailbox($1::text[])`,
        [addresses]
      );
      return res.rows.length > 0 ? res.rows[0] : null;
    }, {});
  } catch (err) {
    console.error('[mail][inbound] mailbox resolution failed', err instanceof Error ? err.message : err);
    return null;
  }
}

interface FiledRow {
  id: string | number;
  duplicate: boolean;
}

/**
 * Insert the message, its recipients and its attachment descriptors.
 *
 * Attachment bytes are deliberately not downloaded: this pipeline has no
 * malware scanner, and storing an unscanned file behind a download link is the
 * one thing the outbound path already refuses to do. What is recorded is the
 * descriptor - name, type, inline placement - so the message is complete and
 * the operator can fetch the original from Resend.
 */
async function file(
  mailbox: MailboxRow,
  email: ReceivedEmail,
  ctx: Ctx,
  providerMessageId: string,
  backfilled: boolean
): Promise<FiledRow> {
  const tenantId = num(mailbox.tenant_id)!;
  const mailboxId = num(mailbox.mailbox_id)!;
  const sender = parseFromHeader(email.from ?? headerValue(email.headers, 'from'));
  const fromEmail = isEmailAddress(sender.email) ? sender.email : (email.from ?? null);
  const lists = recipientLists(email);
  const declaredClassification = (mailbox.default_classification ?? '').trim().toUpperCase();
  const classification = CLASSIFICATIONS.has(declaredClassification) ? declaredClassification : 'INTERNAL';
  const subject = (email.subject ?? '').trim() || '(no subject)';
  const parsed = email.created_at ? new Date(email.created_at) : new Date();
  const receivedAt = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  return tx(async (client) => {
    // Dedupe inside the transaction: idx_emails_provider_msg is not unique, so
    // a check-then-insert here is the only place a redelivery can be caught.
    const existing = await client.query<{ id: string | number }>(
      `SELECT id FROM emails
        WHERE tenant_id = $1 AND direction = 'IN' AND provider_message_id = $2
        LIMIT 1`,
      [tenantId, providerMessageId]
    );
    if (existing.rows.length > 0) return { id: existing.rows[0].id, duplicate: true };

    const inserted = await client.query<{ id: string | number }>(
      `INSERT INTO emails
         (tenant_id, company_id, branch_id, thread_id, direction, subject, body, body_html,
          "to", cc, bcc, status, folder, classification, priority, approval_state,
          mailbox_id, from_email, from_name, reply_to,
          is_read, is_spam, has_attachments,
          in_reply_to, references_header, rfc_message_id, provider_message_id,
          sent_at, created_at, source_ip)
       VALUES ($1,$2,$3,NULL,'IN',$4,$5,$6,
               $7::jsonb,$8::jsonb,$9::jsonb,'RECEIVED','INBOX',$10,'NORMAL','NOT_REQUIRED',
               $11,$12,$13,$14,
               false,false,$15,
               $16,$17,$18,$19,
               $20,$20,$21)
       RETURNING id`,
      [
        tenantId,
        num(mailbox.company_id),
        num(mailbox.branch_id),
        subject.slice(0, 500),
        email.text,
        email.html,
        JSON.stringify(lists.to),
        JSON.stringify(lists.cc),
        JSON.stringify(lists.bcc),
        classification,
        mailboxId,
        fromEmail,
        sender.name,
        email.reply_to.length > 0 ? email.reply_to[0] : null,
        email.attachments.length > 0,
        headerValue(email.headers, 'in-reply-to'),
        referenceHeader(email),
        email.message_id,
        providerMessageId,
        receivedAt,
        ctx.ip ?? null,
      ]
    );
    const emailRowId = Number(inserted.rows[0].id);

    let recipientCount = 0;
    for (const [kind, list] of [
      ['TO', lists.to],
      ['CC', lists.cc],
      ['BCC', lists.bcc],
    ] as [RecipientKind, string[]][]) {
      for (const address of list) {
        await client.query(
          `INSERT INTO email_recipients (tenant_id, email_id, kind, email, status, mailbox_id, is_read)
           VALUES ($1,$2,$3,$4,'DELIVERED',$5,false)`,
          [tenantId, emailRowId, kind, address, mailboxId]
        );
        recipientCount += 1;
      }
    }

    for (const attachment of email.attachments) {
      await client.query(
        `INSERT INTO email_attachments
           (tenant_id, email_id, file_name, file_type, file_size, storage_path,
            source, scan_status, is_inline, content_id)
         VALUES ($1,$2,$3,$4,NULL,NULL,'INBOUND','NOT_SCANNED',$5,$6)`,
        [
          tenantId,
          emailRowId,
          attachment.filename.slice(0, 500),
          attachment.content_type,
          (attachment.content_disposition ?? '').toLowerCase() === 'inline',
          attachment.content_id,
        ]
      );
    }

    await logAudit(client, ctx, {
      action: 'mail.inbound.received',
      resource: 'emails',
      recordId: emailRowId,
      recordCode: email.message_id,
      metadata: {
        mailboxId,
        mailboxAddress: mailbox.mailbox_address,
        from: fromEmail,
        subject,
        classification,
        recipientCount,
        attachmentCount: email.attachments.length,
        rfcMessageId: email.message_id,
        providerMessageId,
        source: 'RESEND_INBOUND',
        backfilled,
      },
    });

    // A backfilled message never came through the webhook, so it must not
    // appear in the webhook ledger - the audit line above is its provenance.
    if (!backfilled) {
      await client.query(
        `SELECT mail_inbound_record_event($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          tenantId,
          'email.received',
          providerMessageId,
          emailRowId,
          mailbox.mailbox_address,
          JSON.stringify({ id: email.id, from: email.from, to: email.to, subject: email.subject }),
          true,
          null,
        ]
      );
    }

    return { id: emailRowId, duplicate: false };
  }, ctx);
}

export interface DeliveryOptions {
  emailId: string;
  providerMessageId: string | null;
  eventType: string;
  recipients: string[];
  payload: unknown;
  ip: string;
  userAgent: string | null;
  /** True for an operator-run backfill; suppresses the webhook ledger row. */
  backfilled: boolean;
}

/**
 * Resolve, fetch and file one delivery. Shared by the webhook path (after its
 * signature check) and the backfill script, so both write byte-identical rows
 * and a message backfilled today dedupes against the webhook delivery of the
 * same message tomorrow.
 */
async function deliver(opts: DeliveryOptions): Promise<IngestResult> {
  const emailId = String(opts.emailId ?? '').trim();
  if (!emailId) return refused('MISSING_EMAIL_ID');

  // delivered_to is the authoritative record, but it lives on the message, so
  // the fetch comes first and the envelope addresses are only a fallback.
  const fetched = await fetchReceivedEmail(emailId);
  const email = fetched.ok ? fetched.email : null;
  const addresses = candidateAddresses(email, opts.recipients);
  const mailbox = await resolveMailbox(addresses);
  if (!mailbox) {
    console.warn(
      `[mail][inbound] refused NO_MAILBOX for ${addresses.join(',') || 'no recipient'} id=${emailId}`
    );
    await recordEvent({
      tenantId: null,
      eventType: opts.eventType,
      providerMessageId: opts.providerMessageId,
      emailId,
      recipient: addresses[0] ?? null,
      payload: opts.payload,
      signatureValid: !opts.backfilled,
      error: 'NO_MAILBOX',
    });
    return refused('NO_MAILBOX');
  }

  const tenantId = num(mailbox.tenant_id);
  if (email === null) {
    // A transient fault is worth handing back to Resend: the message is still in
    // the account, and a later delivery will file it. A permanent one is not.
    const retryable = !fetched.ok && fetched.retryable;
    console.warn(`[mail][inbound] refused FETCH_FAILED id=${emailId} retryable=${retryable}`);
    await recordEvent({
      tenantId,
      eventType: opts.eventType,
      providerMessageId: opts.providerMessageId,
      emailId,
      recipient: mailbox.mailbox_address,
      payload: opts.payload,
      signatureValid: !opts.backfilled,
      error: 'FETCH_FAILED',
    });
    return refused('FETCH_FAILED', tenantId, retryable);
  }

  // Our own alert and notification mail is addressed to role mailboxes we also
  // receive on, so Resend delivers it back to us. Filing it would duplicate the
  // in-app copy and fill the mailbox with mail no human sent, so it is refused
  // before the insert; the sender is the only thing that separates it from a
  // reply.
  const senderAddress = (() => {
    const parsed = parseFromHeader(email.from ?? headerValue(email.headers, 'from'));
    const address = parsed.email ?? '';
    return isEmailAddress(address) ? address.trim().toLowerCase() : '';
  })();
  if (senderAddress && isSelfEcho(senderAddress, String(mailbox.mailbox_address ?? ''))) {
    console.warn(
      `[mail][inbound] refused SELF_ECHO from ${senderAddress} to ${mailbox.mailbox_address} id=${emailId}`
    );
    await recordEvent({
      tenantId,
      eventType: opts.eventType,
      providerMessageId: opts.providerMessageId,
      emailId,
      recipient: mailbox.mailbox_address,
      payload: opts.payload,
      signatureValid: !opts.backfilled,
      error: 'SELF_ECHO',
    });
    return refused('SELF_ECHO', tenantId);
  }
  // The webhook's message_id is the same header the fetched message carries, so
  // preferring either yields the same key; the Resend id is the last resort for
  // a message that arrived without a Message-ID at all.
  const dedupeKey = opts.providerMessageId ?? email.message_id ?? emailId;

  const ctx: Ctx = {
    tenantId,
    companyId: num(mailbox.company_id),
    branchId: num(mailbox.branch_id),
    ip: opts.ip || null,
    userAgent: opts.userAgent,
  };

  const filed = await file(mailbox, email, ctx, dedupeKey, opts.backfilled);

  return {
    accepted: true,
    reason: null,
    emailRowId: num(filed.id),
    duplicate: filed.duplicate,
    mailboxId: num(mailbox.mailbox_id),
    tenantId,
    retryable: false,
  };
}

/**
 * Ingest one `email.received` delivery.
 *
 * Never throws: a webhook handler that throws makes Resend retry a delivery
 * that a retry cannot repair. Every outcome is an IngestResult, and the caller
 * answers HTTP 200 for all of them.
 */
export async function ingestResendEmail(opts: IngestOptions): Promise<IngestResult> {
  const emailId = String(opts.emailId ?? '').trim();
  if (!emailId) return refused('MISSING_EMAIL_ID');

  const signature = verifyResendSignature({ rawBody: opts.rawBody, headers: opts.headers });
  if (!signature.ok) {
    console.warn(
      `[mail][inbound] refused ${signature.reason} from ${opts.ip || 'unknown'} id=${emailId}`
    );
    await recordEvent({
      tenantId: null,
      eventType: opts.eventType,
      providerMessageId: opts.providerMessageId,
      emailId,
      recipient: opts.recipients[0] ?? null,
      payload: opts.payload,
      signatureValid: false,
      error: signature.reason,
    });
    return refused(signature.reason ?? 'SIGNATURE_INVALID');
  }

  return deliver({ ...opts, backfilled: false });
}

/**
 * File a message that is already sitting in the Resend account.
 *
 * This exists because mail can be received while no webhook is registered, and
 * those messages would otherwise be permanently invisible to the ERP. It skips
 * the signature check it cannot perform - there is no request to sign - and is
 * therefore only ever called by an operator-run script inside the API
 * container, never from a request path. The provider API key used to fetch the
 * message is what authenticates it, and the audit line records it as
 * backfilled. Because it shares `deliver()`, it cannot produce a row shape the
 * webhook path would not, and it dedupes against webhook deliveries.
 */
export async function backfillReceivedEmail(opts: {
  emailId: string;
  recipients?: string[];
  payload?: unknown;
}): Promise<IngestResult> {
  return deliver({
    emailId: opts.emailId,
    providerMessageId: null,
    eventType: 'email.received',
    recipients: opts.recipients ?? [],
    payload: opts.payload ?? { id: opts.emailId, backfill: true },
    ip: '',
    userAgent: null,
    backfilled: true,
  });
}
