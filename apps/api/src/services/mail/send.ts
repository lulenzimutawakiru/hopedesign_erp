import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { Ctx } from '../../db.js';
import { config } from '../../config.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils.js';
import { sendEmail, type EmailAttachmentInput } from '../bird.js';
import { auditComms, renderEmailForSend } from '../communication.js';
import {
  assertExternalAllowed,
  hasExternalRecipient,
  loadClassification,
  type MailClassification,
} from './policy.js';
import { applySignature, defaultSignature, resolveSignature } from './signatures.js';
import {
  assertMailboxPermission,
  listMailboxesForUser,
  resolveMailboxAccess,
  type MailboxAccess,
} from './access.js';
import { recordDeliveryEvent } from './delivery.js';

/**
 * The single outbound mail pipeline.
 *
 * Every path that puts a message on the wire - the composer, an approval
 * decision, a scheduled run, an outbox retry - funnels through
 * `sendStoredEmail`. Nothing else in the codebase calls `sendEmail` for mail,
 * so authorisation, classification policy, signature resolution, attachment
 * release and delivery recording cannot be skipped by reaching a different
 * endpoint.
 *
 * Failure mode is deliberate: when the provider cannot be reached the message
 * is parked in OUTBOX with an outbox row so it is retryable (AC-MAIL-015). We
 * never write SENT without a provider response (AC-MAIL-011).
 */

/** Resend accepts ~40 MB of base64; base64 inflates ~33%, so cap the raw bytes. */
const MAX_ATTACHMENT_TOTAL_BYTES = 18 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

/** Extensions we are willing to relay. Anything else is rejected, not silently dropped. */
const ALLOWED_ATTACHMENT_EXT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'rtf',
  'png', 'jpg', 'jpeg', 'gif', 'webp',
  'zip', 'eml', 'msg',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SendOutcome = 'SENT' | 'FAILED' | 'SCHEDULED' | 'PENDING_APPROVAL';

export interface SendStoredEmailOptions {
  /** Mailbox to send from. Defaults to the mailbox already on the message. */
  mailboxId?: number | null;
  /** Signature to apply. Defaults to the mailbox's default signature. */
  signatureId?: number | null;
  /** Extra HTML body part supplied by the caller (composer rich text). */
  html?: string | null;
  /** Bypass the future `scheduled_at` check (used by the scheduler itself). */
  forceNow?: boolean;
  /** Extra attachments supplied inline by the caller. */
  attachments?: EmailAttachmentInput[];
  /**
   * Set only by the approval pipeline, to release a message authored by someone
   * else. The precondition is re-verified against `email_approvals` here, so a
   * route cannot use this to send without a real, decided approval.
   */
  release?: { approvalId: number };
}

export interface SendStoredEmailResult {
  outcome: SendOutcome;
  emailId: number;
  mailboxId: number | null;
  providerMessageId: string | null;
  provider: string | null;
  error: string | null;
  classification: string;
  recipientCount: number;
  attachmentCount: number;
}

/**
 * Domains that belong to this tenant. Recipients outside them are "external"
 * and are subject to the classification's `allow_external` rule.
 *
 * There is no tenant-scoped domain setting yet, so the mailboxes the tenant
 * actually operates are the source of truth. Deriving the list is safer than a
 * hardcoded constant: a tenant that has not configured a mailbox domain ends up
 * with an empty list, and `hasExternalRecipient` then treats every recipient as
 * external - the restrictive direction.
 */
export async function tenantMailDomains(
  client: pg.PoolClient,
  tenantId: number
): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT DISTINCT lower(split_part(address, '@', 2)) AS domain
       FROM mailboxes
      WHERE tenant_id = $1 AND is_active = true AND address LIKE '%@%'
      UNION
     SELECT DISTINCT lower(split_part(from_address, '@', 2)) AS domain
       FROM email_provider_configs
      WHERE tenant_id = $1 AND from_address LIKE '%@%'`,
    [tenantId]
  );
  return rows
    .map((r) => String(r.domain ?? '').trim())
    .filter((d) => d.length > 0);
}

interface ResolvedRecipient {
  id: number | null;
  email: string;
  kind: 'TO' | 'CC' | 'BCC';
}

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t || t === '[]') return [];
    try {
      const parsed = JSON.parse(t) as unknown;
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [t];
    }
  }
  return [v];
}

/** Accepts `"a@b.c"` or `{ email: "a@b.c" }` - both shapes exist in older rows. */
function addressOf(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object' && 'email' in entry) {
    const v = (entry as { email?: unknown }).email;
    if (typeof v === 'string') return v.trim();
  }
  return '';
}

/** Read the message's recipients, falling back to the legacy JSON columns. */
async function loadRecipients(
  client: pg.PoolClient,
  tenantId: number,
  email: Record<string, unknown>
): Promise<ResolvedRecipient[]> {
  const emailId = Number(email.id);
  const { rows } = await client.query(
    `SELECT id, email, kind FROM email_recipients
      WHERE tenant_id = $1 AND email_id = $2
      ORDER BY id ASC`,
    [tenantId, emailId]
  );
  const out: ResolvedRecipient[] = rows.map((r) => ({
    id: Number(r.id),
    email: String(r.email ?? '').trim(),
    kind: (String(r.kind ?? 'TO').toUpperCase() as 'TO' | 'CC' | 'BCC') ?? 'TO',
  }));
  if (out.length > 0) return out.filter((r) => r.email.length > 0);

  const fallback: ResolvedRecipient[] = [];
  const push = (raw: unknown, kind: 'TO' | 'CC' | 'BCC') => {
    for (const entry of asList(raw)) {
      const addr = addressOf(entry);
      if (addr) fallback.push({ id: null, email: addr, kind });
    }
  };
  push(email.to, 'TO');
  push(email.cc, 'CC');
  push(email.bcc, 'BCC');
  return fallback;
}

interface PreparedAttachment {
  filename: string;
  content: string;
  size: number;
}

/**
 * Release attachments for sending.
 *
 * The schema records `scan_status`, but no malware scanner is deployed in this
 * API. Rather than silently relaying unscanned bytes, or silently flip the
 * column to CLEAN (which would manufacture a security assertion we do not
 * hold), the policy is:
 *
 *   - INFECTED / FAILED  -> refuse the send outright.
 *   - CLEAN              -> relay.
 *   - anything else      -> relay only when the bytes never came from an
 *                           untrusted upload, i.e. the attachment is a document
 *                           already held in the ERP that the caller is
 *                           authorised to read. That decision is recorded as
 *                           SKIPPED with an explicit reason, and audited.
 *
 * A user-uploaded attachment with no scanner keeps failing closed, and the
 * error says exactly why. Closing that gap needs a scanning service, not a UI
 * change.
 */
async function prepareAttachments(
  client: pg.PoolClient,
  ctx: Ctx,
  emailId: number,
  inline: EmailAttachmentInput[] | undefined
): Promise<{ attachments: EmailAttachmentInput[]; count: number }> {
  const tenantId = ctx.tenantId ?? 0;
  const { rows } = await client.query(
    `SELECT id, file_name, file_type, file_size, storage_path, source, scan_status
       FROM email_attachments
      WHERE tenant_id = $1 AND email_id = $2 AND deleted_at IS NULL
      ORDER BY id ASC`,
    [tenantId, emailId]
  );

  const prepared: PreparedAttachment[] = [];

  for (const row of rows) {
    const id = Number(row.id);
    const fileName = String(row.file_name ?? 'attachment.bin');
    const source = String(row.source ?? 'UPLOAD').toUpperCase();
    const scanStatus = String(row.scan_status ?? 'NOT_SCANNED').toUpperCase();

    if (scanStatus === 'INFECTED') {
      throw forbidden(
        `Attachment "${fileName}" failed malware scanning and cannot be sent.`
      );
    }
    if (scanStatus !== 'CLEAN' && scanStatus !== 'SKIPPED' && source !== 'ERP_DOCUMENT') {
      throw conflict(
        `Attachment "${fileName}" has not been scanned for malware. ` +
          'Attachment scanning is not configured for this mailbox, so uploaded files cannot be released.'
      );
    }
    if (scanStatus === 'NOT_SCANNED' || scanStatus === 'PENDING' || scanStatus === 'FAILED') {
      await client.query(
        `UPDATE email_attachments
            SET scan_status = 'SKIPPED', updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      await auditComms(client, ctx, 'EMAIL_ATTACHMENT_SCAN_SKIPPED', 'email', emailId, {
        attachmentId: id,
        fileName,
        reason: 'Internal ERP document; no malware scanner is configured, scanning is not applicable',
      });
    }

    const rel = String(row.storage_path ?? '').trim();
    if (!rel || rel.includes('..')) {
      throw notFound(`No file is stored for attachment "${fileName}"`);
    }
    const abs = path.join(config.storageRoot, rel);
    if (!existsSync(abs)) {
      throw notFound(`Stored file for attachment "${fileName}" is missing`);
    }
    let size = Number(row.file_size ?? 0);
    try {
      size = statSync(abs).size;
    } catch {
      /* fall back to the recorded size */
    }
    const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
    if (!ALLOWED_ATTACHMENT_EXT.has(ext)) {
      throw badRequest(`File type ".${ext}" is not permitted as an email attachment.`);
    }
    prepared.push({
      filename: fileName,
      content: readFileSync(abs).toString('base64'),
      size,
    });
  }

  for (const extra of inline ?? []) {
    const ext = path.extname(extra.filename).replace(/^\./, '').toLowerCase();
    if (!ALLOWED_ATTACHMENT_EXT.has(ext)) {
      throw badRequest(`File type ".${ext}" is not permitted as an email attachment.`);
    }
    prepared.push({
      filename: extra.filename,
      content: extra.content,
      size: Math.floor((extra.content.length * 3) / 4),
    });
  }

  if (prepared.length > MAX_ATTACHMENTS) {
    throw badRequest(`An email may carry at most ${MAX_ATTACHMENTS} attachments.`);
  }
  const total = prepared.reduce((sum, a) => sum + a.size, 0);
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw badRequest(
      `Attachments total ${Math.round(total / 1024 / 1024)} MB, above the ${Math.round(
        MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024
      )} MB limit.`
    );
  }

  return {
    attachments: prepared.map((a) => ({ filename: a.filename, content: a.content })),
    count: prepared.length,
  };
}

/** `Display Name <address>` for the provider's `from` header. */
function formatSender(mailbox: Record<string, unknown>): { address: string; name: string; header: string } {
  const address = String(mailbox.address ?? '').trim();
  const name = String(mailbox.default_sender_name ?? mailbox.display_name ?? '').trim();
  const header = name ? `${name} <${address}>` : address;
  return { address, name, header };
}

/** Kinds ranked for the implicit sender: personal first, system last. */
const SENDER_KIND_RANK: Record<string, number> = {
  INDIVIDUAL: 0,
  DEPARTMENT: 1,
  SHARED: 2,
  SYSTEM: 3,
};
const senderRank = (access: MailboxAccess): number =>
  SENDER_KIND_RANK[String(access.mailbox.kind ?? '').toUpperCase()] ?? 4;

/**
 * True when the caller holds an explicit grant on the mailbox - owned,
 * membership, or delegation. A global administrator resolves every mailbox in
 * the tenant; that must never silently pick one on the admin's behalf, because
 * the sent message records the mailbox it left from. Admins choose a mailbox.
 */
const holdsRealGrant = (access: MailboxAccess, userId: number): boolean =>
  access.viaDelegation ||
  access.memberRole !== null ||
  Number(access.mailbox.owner_user_id ?? 0) === userId;

/**
 * Resolve which mailbox a message is sent from.
 *
 * An explicit choice wins; otherwise the mailbox already stamped on the
 * message; otherwise the caller's best granted mailbox - their own individual
 * mailbox first, then a department or shared mailbox they are a member of or
 * hold a live delegation for. A caller with no grant at all is told what to do
 * rather than silently sending from an address they cannot account for.
 */
export async function resolveSendMailbox(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  email: Record<string, unknown>,
  requestedId?: number | null
): Promise<MailboxAccess> {
  const tenantId = ctx.tenantId ?? 0;
  const userId = ctx.userId ?? 0;
  const explicit = requestedId ?? (email.mailbox_id == null ? null : Number(email.mailbox_id));
  if (explicit) return resolveMailboxAccess(client, ctx, permissions, explicit);

  // Access is resolved through the same grant model as the inbox: ownership,
  // an active mailbox_members row, or a live delegation (AC-MAIL-005). A user
  // whose only relationship to a mailbox is a payroll record is not a member
  // and is not considered here.
  const candidates = (await listMailboxesForUser(client, ctx, permissions))
    .filter((m) => m.canSend && holdsRealGrant(m, userId))
    .sort((a, b) => senderRank(a) - senderRank(b) || a.mailboxId - b.mailboxId);
  if (candidates.length === 0) {
    throw badRequest(
      'No sending mailbox is configured for your account. Ask an administrator to assign you a mailbox.'
    );
  }
  // Re-resolve so the caller gets a fully audited access record rather than the
  // listing projection.
  return resolveMailboxAccess(client, ctx, permissions, candidates[0].mailboxId);
}

/**
 * Send a message that already exists as an `emails` row.
 *
 * The caller must hold the RBAC permission for the action (`communication.emails.send`
 * for a first send). Mailbox-level authorisation, classification policy and the
 * approval gate are enforced here so no route can bypass them.
 */
export async function sendStoredEmail(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  emailId: number,
  options: SendStoredEmailOptions = {}
): Promise<SendStoredEmailResult> {
  const tenantId = ctx.tenantId ?? 0;

  const found = await client.query(
    `SELECT * FROM emails WHERE id = $1 AND tenant_id = $2`,
    [emailId, tenantId]
  );
  if (found.rows.length === 0) throw notFound('Email not found');
  const email = found.rows[0] as Record<string, unknown>;

  // Releasing an approved message acts for its author: mailbox authorisation is
  // evaluated for the owner, while the audit trail still names the approver.
  let actorCtx = ctx;
  let releasedOnBehalfOf: number | null = null;
  if (options.release) {
    const ownerId = Number(email.created_by ?? 0);
    if (!ownerId) throw forbidden('This message has no owner, so it cannot be released.');
    const pending = await client.query(
      `SELECT count(*)::int AS outstanding FROM email_approvals
        WHERE tenant_id = $1 AND email_id = $2 AND status = 'PENDING'`,
      [tenantId, emailId]
    );
    if (Number(pending.rows[0]?.outstanding ?? 0) > 0) {
      throw conflict('This message still has approvals outstanding.');
    }
    const decided = await client.query(
      `SELECT id FROM email_approvals
        WHERE tenant_id = $1 AND email_id = $2 AND id = $3
          AND status = 'APPROVED' AND decided_by = $4`,
      [tenantId, emailId, options.release.approvalId, ctx.userId ?? 0]
    );
    if (decided.rows.length === 0) {
      throw forbidden('This message was not approved by you, so you cannot release it.');
    }
    if (ownerId !== (ctx.userId ?? 0)) {
      actorCtx = { ...ctx, userId: ownerId };
      releasedOnBehalfOf = ownerId;
    }
  }

  const access = await resolveSendMailbox(client, actorCtx, permissions, email, options.mailboxId);
  assertMailboxPermission(
    access,
    'canSend',
    'You do not have permission to send from this mailbox.'
  );

  const base: SendStoredEmailResult = {
    outcome: 'FAILED',
    emailId,
    mailboxId: access.mailboxId,
    providerMessageId: null,
    provider: null,
    error: null,
    classification: String(email.classification ?? 'INTERNAL'),
    recipientCount: 0,
    attachmentCount: 0,
  };

  // --- Scheduling ---------------------------------------------------------
  const scheduledAt = email.scheduled_at ? new Date(String(email.scheduled_at)) : null;
  if (!options.forceNow && scheduledAt && scheduledAt.getTime() > Date.now()) {
    await client.query(
      `UPDATE emails
          SET status = 'SCHEDULED', folder = 'SCHEDULED', mailbox_id = $2, updated_at = now()
        WHERE id = $1 AND tenant_id = $3`,
      [emailId, access.mailboxId, tenantId]
    );
    await auditComms(client, ctx, 'EMAIL_SCHEDULED', 'email', emailId, {
      scheduledAt: scheduledAt.toISOString(),
      mailboxId: access.mailboxId,
    });
    return { ...base, outcome: 'SCHEDULED' };
  }

  // --- Approval gate ------------------------------------------------------
  const classification: MailClassification = await loadClassification(
    client,
    tenantId,
    String(email.classification ?? 'INTERNAL')
  );
  const approvalState = String(email.approval_state ?? 'NOT_REQUIRED');
  if (approvalState === 'REJECTED' || approvalState === 'RETURNED') {
    throw conflict(
      'This message was not approved for sending. Edit it and submit it for approval again.'
    );
  }
  if (approvalState === 'PENDING') {
    throw conflict('This message is awaiting approval and cannot be sent yet.');
  }
  if (classification.requireApproval && approvalState !== 'APPROVED') {
    await client.query(
      `UPDATE emails
          SET status = 'PENDING_APPROVAL', approval_state = 'PENDING', mailbox_id = $2, updated_at = now()
        WHERE id = $1 AND tenant_id = $3`,
      [emailId, access.mailboxId, tenantId]
    );
    await auditComms(client, ctx, 'EMAIL_APPROVAL_REQUIRED', 'email', emailId, {
      classification: classification.code,
      mailboxId: access.mailboxId,
    });
    return { ...base, outcome: 'PENDING_APPROVAL', classification: classification.code };
  }

  // --- Recipients ---------------------------------------------------------
  const recipients = await loadRecipients(client, tenantId, email);
  const seen = new Set<string>();
  const unique: ResolvedRecipient[] = [];
  for (const r of recipients) {
    if (!EMAIL_RE.test(r.email)) {
      throw badRequest(`"${r.email}" is not a valid email address.`);
    }
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  const to = unique.filter((r) => r.kind === 'TO');
  const cc = unique.filter((r) => r.kind === 'CC');
  const bcc = unique.filter((r) => r.kind === 'BCC');

  if (to.length === 0) {
    await client.query(
      `UPDATE emails SET status = 'FAILED', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [emailId, tenantId]
    );
    await client.query(
      `UPDATE email_recipients SET status = 'FAILED', error = $2, updated_at = now()
        WHERE email_id = $1 AND status <> 'SENT'`,
      [emailId, 'No recipients']
    );
    await auditComms(client, ctx, 'EMAIL_SEND_FAILED', 'email', emailId, {
      error: 'No recipients',
    });
    throw badRequest('Email has no recipients');
  }

  // --- Classification policy ---------------------------------------------
  const domains = await tenantMailDomains(client, tenantId);
  const all = unique.map((r) => r.email);
  const external = hasExternalRecipient(all, domains);
  assertExternalAllowed(classification, all, domains);
  if (external && access.mailbox.allow_external_send === false && !access.globalAdmin) {
    throw forbidden('This mailbox is not permitted to send to addresses outside the organisation.');
  }

  // --- Body, signature, template -----------------------------------------
  const rendered = await renderEmailForSend(client, email);
  const senderName = await displayName(client, actorCtx);
  const onBehalfOf = access.viaDelegation ? access.onBehalfOfName : null;
  const signature = options.signatureId
    ? await resolveSignature(client, ctx, options.signatureId, access.mailboxId)
    : await defaultSignature(client, ctx, access.mailboxId);

  const companyName = String(
    access.mailbox.display_name ?? email.from_name ?? 'HOPE DESIGN GROUP LTD'
  );
  const applied = applySignature(
    signature,
    rendered.body,
    options.html ?? (email.body_html == null ? null : String(email.body_html)),
    { senderName, onBehalfOfName: onBehalfOf, companyName }
  );

  // --- Attachments --------------------------------------------------------
  const prepared = await prepareAttachments(client, ctx, emailId, options.attachments);

  // --- Dispatch -----------------------------------------------------------
  const sender = formatSender(access.mailbox);
  if (!sender.address) {
    throw badRequest('The sending mailbox has no email address configured.');
  }
  const replyTo = email.reply_to == null ? sender.address : String(email.reply_to);

  await client.query(
    `UPDATE email_recipients
        SET status = 'QUEUED', error = NULL, updated_at = now()
      WHERE email_id = $1 AND status <> 'SENT'`,
    [emailId]
  );

  const result = await sendEmail({
    to: to.map((r) => r.email),
    cc: cc.length ? cc.map((r) => r.email) : undefined,
    bcc: bcc.length ? bcc.map((r) => r.email) : undefined,
    replyTo,
    from: sender.header,
    subject: rendered.subject,
    html: applied.html,
    text: applied.text,
    attachments: prepared.attachments.length ? prepared.attachments : undefined,
  });

  const recipientCount = unique.length;

  if (result.ok) {
    const providerMessageId = result.providerMessageId ?? null;
    await client.query(
      `UPDATE emails
          SET status = 'SENT', folder = 'SENT', sent_at = now(), sent_by = $2,
              on_behalf_of = $3, provider_message_id = $4, subject = $5, body = $6,
              body_html = $7, signature_id = $8, from_email = $9, from_name = $10,
              reply_to = $11, has_attachments = $12, mailbox_id = $13,
              updated_at = now(), version = COALESCE(version, 1) + 1
        WHERE id = $1 AND tenant_id = $14`,
      [
        emailId,
        ctx.userId ?? null,
        access.onBehalfOfUserId ?? releasedOnBehalfOf,
        providerMessageId,
        rendered.subject,
        rendered.body,
        applied.html,
        signature ? signature.id : null,
        sender.address,
        sender.name || null,
        replyTo,
        prepared.count > 0,
        access.mailboxId,
        tenantId,
      ]
    );
    await client.query(
      `UPDATE email_recipients
          SET status = 'SENT', sent_at = now(), provider_message_id = $1, error = NULL,
              updated_at = now()
        WHERE email_id = $2 AND status = 'QUEUED'`,
      [providerMessageId, emailId]
    );
    // Only the provider's acceptance is asserted here. Delivered/opened states
    // require a provider webhook (AC-MAIL-011).
    await recordDeliveryEvent(client, tenantId, {
      emailId,
      eventType: 'SENT',
      provider: result.provider ?? null,
      providerMessageId,
      confirmedByProvider: Boolean(providerMessageId),
      detail: { recipients: recipientCount, attachments: prepared.count },
    });
    await auditComms(client, ctx, 'EMAIL_SENT', 'email', emailId, {
      providerMessageId,
      mailboxId: access.mailboxId,
      onBehalfOfUserId: access.onBehalfOfUserId,
      classification: classification.code,
      recipients: recipientCount,
      attachments: prepared.count,
      releaseApprovalId: options.release?.approvalId ?? null,
      releasedOnBehalfOfUserId: releasedOnBehalfOf,
    });
    return {
      ...base,
      outcome: 'SENT',
      providerMessageId,
      provider: result.provider ?? null,
      classification: classification.code,
      recipientCount,
      attachmentCount: prepared.count,
    };
  }

  // --- Failure: park in OUTBOX so the message is retryable -----------------
  const error = result.error ?? 'Sending failed';
  await client.query(
    `UPDATE emails
        SET status = 'FAILED', folder = 'OUTBOX', mailbox_id = $2, subject = $3,
            body = $4, body_html = $5, signature_id = $6, from_email = $7,
            from_name = $8, has_attachments = $9, updated_at = now()
      WHERE id = $1 AND tenant_id = $10`,
    [
      emailId,
      access.mailboxId,
      rendered.subject,
      rendered.body,
      applied.html,
      signature ? signature.id : null,
      sender.address,
      sender.name || null,
      prepared.count > 0,
      tenantId,
    ]
  );
  await client.query(
    `UPDATE email_recipients SET status = 'FAILED', error = $2, updated_at = now()
      WHERE email_id = $1 AND status = 'QUEUED'`,
    [emailId, error]
  );
  await client.query(
    `INSERT INTO email_outbox
       (tenant_id, email_id, mailbox_id, status, attempts, last_error, provider, queued_by)
     VALUES ($1,$2,$3,'QUEUED',1,$4,$5,$6)
     ON CONFLICT (email_id) DO UPDATE
       SET status = 'QUEUED',
           attempts = email_outbox.attempts + 1,
           last_error = EXCLUDED.last_error,
           provider = EXCLUDED.provider,
           updated_at = now()`,
    [tenantId, emailId, access.mailboxId, error, null, ctx.userId ?? null]
  );
  await recordDeliveryEvent(client, tenantId, {
    emailId,
    eventType: 'FAILED',
    provider: null,
    detail: { error },
    confirmedByProvider: true,
  });
  await auditComms(client, ctx, 'EMAIL_SEND_FAILED', 'email', emailId, {
    error,
    mailboxId: access.mailboxId,
    classification: classification.code,
  });
  return { ...base, outcome: 'FAILED', error, recipientCount, attachmentCount: prepared.count };
}

/** Full name of the acting user, for signature rendering. */
async function displayName(client: pg.PoolClient, ctx: Ctx): Promise<string | null> {
  const userId = ctx.userId ?? 0;
  if (!userId) return null;
  const { rows } = await client.query(
    `SELECT first_name, last_name FROM users
      WHERE id = $1 AND tenant_id = COALESCE($2::bigint, tenant_id)`,
    [userId, ctx.tenantId ?? null]
  );
  if (rows.length === 0) return null;
  const name = [rows[0].first_name, rows[0].last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return name || null;
}
