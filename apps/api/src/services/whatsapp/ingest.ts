/**
 * Meta WhatsApp inbound webhook ingest.
 *
 * One pipeline, run for every webhook Meta pushes at us:
 *
 *   Verify     The `X-Hub-Signature-256` over the RAW request body is the
 *              authentication. Nothing is resolved or written before it passes.
 *   Resolve    The business phone number Meta delivered to is mapped onto a
 *              tenant through a read-only SECURITY DEFINER helper (0197), the
 *              same attribution pattern as inbound mail. That has to work
 *              before any tenant context exists, because the message is what
 *              tells us the tenant.
 *   File       Each inbound `messages[]` entry becomes one INBOUND
 *              `whatsapp_messages` row; each `statuses[]` entry updates the
 *              matching outbound row to SENT/DELIVERED/READ/FAILED.
 *
 * Meta pushes the full message body, so unlike Resend there is no fetch-back:
 * a permanent refusal (bad signature, no tenant owns the number) is answered
 * HTTP 200 to end Meta's retry loop, and only a transient database fault is
 * answered 503 so Meta redelivers. Every delivery is recorded in
 * `whatsapp_webhook_events` regardless of the outcome.
 *
 * Meta is the actor throughout: no user id is ever attached to the context. An
 * inbound message has a sender, not an author in our system.
 */
import { Ctx, detach, tx } from '../../db.js';
import { verifyMetaSignature } from '../metaWhatsapp.js';

export interface IngestOptions {
  rawBody?: Buffer | string | null;
  headers?: Record<string, unknown>;
  /** The parsed webhook body, stored verbatim on the event rows. */
  payload: unknown;
  ip: string;
  userAgent: string | null;
}

export interface IngestResult {
  accepted: boolean;
  reason: string | null;
  /** Counts of what this delivery did, for the acknowledgement body. */
  inboundMessages: number;
  statusUpdates: number;
  retryable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s.length === 0 ? null : s;
}

/** Resolve the tenant that owns a business phone number, before any tenant ctx. */
async function resolveNumber(displayPhone: string): Promise<{
  tenantId: number | null;
  companyId: number | null;
  branchId: number | null;
}> {
  try {
    return await detach(async (client) => {
      const res = await client.query<{
        tenant_id: string | number;
        company_id: string | number | null;
        branch_id: string | number | null;
      }>(`SELECT tenant_id, company_id, branch_id FROM whatsapp_inbound_resolve_number($1)`, [
        displayPhone,
      ]);
      const row = res.rows[0];
      if (!row) return { tenantId: null, companyId: null, branchId: null };
      return {
        tenantId: Number(row.tenant_id) || null,
        companyId: Number(row.company_id) || null,
        branchId: Number(row.branch_id) || null,
      };
    }, {});
  } catch (err) {
    console.error('[whatsapp][inbound] number resolution failed', err instanceof Error ? err.message : err);
    return { tenantId: null, companyId: null, branchId: null };
  }
}

/** Best-effort record of a webhook delivery through the SECURITY DEFINER helper. */
async function recordEvent(opts: {
  tenantId: number | null;
  eventType: string;
  providerMessageId: string | null;
  whatsappMessageId: number | null;
  fromNumber: string | null;
  payload: unknown;
  signatureValid: boolean;
  error: string | null;
}): Promise<void> {
  try {
    await detach(async (client) => {
      await client.query(
        `SELECT whatsapp_webhook_record_event($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          opts.tenantId,
          opts.eventType,
          opts.providerMessageId,
          opts.whatsappMessageId,
          opts.fromNumber,
          JSON.stringify(opts.payload ?? {}),
          opts.signatureValid,
          opts.error,
        ]
      );
    }, {});
  } catch (err) {
    console.error('[whatsapp][inbound] event record failed', err instanceof Error ? err.message : err);
  }
}

/** A unix epoch (seconds) string or number -> Date, or now() when unusable. */
function epochToDate(value: unknown): Date {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

/** Dedupe + insert one inbound message inside a tenant transaction. */
async function fileInbound(opts: {
  tenantId: number;
  companyId: number | null;
  branchId: number | null;
  businessPhone: string;
  from: string;
  messageId: string;
  messageType: string;
  body: string;
  timestamp: Date;
  meta: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ id: number; duplicate: boolean }> {
  const ctx: Ctx = {
    tenantId: opts.tenantId,
    companyId: opts.companyId,
    branchId: opts.branchId,
    ip: opts.ip,
    userAgent: opts.userAgent,
  };
  return tx(async (client) => {
    const existing = await client.query<{ id: string | number }>(
      `SELECT id FROM whatsapp_messages
        WHERE tenant_id = $1 AND provider_message_id = $2 AND direction = 'INBOUND'
        LIMIT 1`,
      [opts.tenantId, opts.messageId]
    );
    if (existing.rows.length > 0) {
      return { id: Number(existing.rows[0].id), duplicate: true };
    }
    const inserted = await client.query<{ id: string | number }>(
      `INSERT INTO whatsapp_messages
         (tenant_id, recipient, body, provider, status, provider_message_id,
          direction, from_number, message_type, meta, created_at)
       VALUES ($1,$2,$3,'META','DELIVERED',$4,'INBOUND',$5,$6,$7::jsonb,$8)
       RETURNING id`,
      [
        opts.tenantId,
        opts.businessPhone,
        opts.body,
        opts.messageId,
        opts.from,
        opts.messageType,
        JSON.stringify(opts.meta),
        opts.timestamp,
      ]
    );
    return { id: Number(inserted.rows[0].id), duplicate: false };
  }, ctx);
}

const STATUS_TO_COLUMN: Record<string, { status: string; column: string }> = {
  sent: { status: 'SENT', column: 'sent_at' },
  delivered: { status: 'DELIVERED', column: 'delivered_at' },
  read: { status: 'READ', column: 'read_at' },
  failed: { status: 'FAILED', column: 'failed_at' },
};

/** Update one outbound row from a delivery-status callback. */
async function applyStatus(opts: {
  tenantId: number;
  messageId: string;
  status: string;
  timestamp: Date;
}): Promise<number | null> {
  const mapping = STATUS_TO_COLUMN[opts.status.toLowerCase()];
  if (!mapping) return null;
  const ctx: Ctx = { tenantId: opts.tenantId };
  return tx(async (client) => {
    const res = await client.query<{ id: string | number }>(
      `UPDATE whatsapp_messages
          SET status = $1,
              ${mapping.column} = $2
        WHERE tenant_id = $3 AND provider_message_id = $4 AND direction = 'OUTBOUND'
        RETURNING id`,
      [mapping.status, opts.timestamp, opts.tenantId, opts.messageId]
    );
    return res.rows.length > 0 ? Number(res.rows[0].id) : null;
  }, ctx);
}

/**
 * Ingest one Meta webhook delivery.
 *
 * Never throws: a webhook handler that throws makes Meta redeliver something a
 * retry cannot repair. Every outcome is an IngestResult, and the caller answers
 * HTTP 200 for all of them except a transient database fault.
 */
export async function ingestWhatsAppEvent(opts: IngestOptions): Promise<IngestResult> {
  const signature = verifyMetaSignature({
    rawBody: opts.rawBody,
    signatureHeader: opts.headers?.['x-hub-signature-256'] != null
      ? String(opts.headers['x-hub-signature-256'])
      : null,
  });
  if (!signature.ok) {
    console.warn(`[whatsapp][inbound] refused ${signature.reason} from ${opts.ip || 'unknown'}`);
    await recordEvent({
      tenantId: null,
      eventType: 'signature',
      providerMessageId: null,
      whatsappMessageId: null,
      fromNumber: null,
      payload: opts.payload,
      signatureValid: false,
      error: signature.reason,
    });
    return { accepted: false, reason: signature.reason, inboundMessages: 0, statusUpdates: 0, retryable: false };
  }

  const root = isRecord(opts.payload) ? opts.payload : {};
  const entries = Array.isArray(root.entry) ? root.entry : [];

  let inboundMessages = 0;
  let statusUpdates = 0;

  for (const entryRaw of entries) {
    if (!isRecord(entryRaw)) continue;
    const changes = Array.isArray(entryRaw.changes) ? entryRaw.changes : [];
    for (const changeRaw of changes) {
      if (!isRecord(changeRaw)) continue;
      const value = isRecord(changeRaw.value) ? changeRaw.value : {};
      const metadata = isRecord(value.metadata) ? value.metadata : {};
      const businessPhone = text(metadata.display_phone_number);
      if (!businessPhone) continue;
      const resolved = await resolveNumber(businessPhone);
      if (!resolved.tenantId) {
        console.warn(`[whatsapp][inbound] refused NO_TENANT for number ${businessPhone}`);
        await recordEvent({
          tenantId: null,
          eventType: text(changeRaw.field) ?? 'unknown',
          providerMessageId: null,
          whatsappMessageId: null,
          fromNumber: null,
          payload: value,
          signatureValid: true,
          error: 'NO_TENANT',
        });
        continue;
      }

      // Inbound messages: one row each.
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const msgRaw of messages) {
        if (!isRecord(msgRaw)) continue;
        const from = text(msgRaw.from);
        const messageId = text(msgRaw.id);
        if (!from || !messageId) continue;
        const messageType = text(msgRaw.type) ?? 'text';
        const body =
          typeof msgRaw.text === 'object' && msgRaw.text !== null
            ? String((msgRaw.text as Record<string, unknown>).body ?? '').trim()
            : '';
        const timestamp = epochToDate(msgRaw.timestamp);
        try {
          const filed = await fileInbound({
            tenantId: resolved.tenantId,
            companyId: resolved.companyId,
            branchId: resolved.branchId,
            businessPhone,
            from,
            messageId,
            messageType,
            body: body.length > 0 ? body : '(no text)',
            timestamp,
            meta: { wa_id: text(metadata.phone_number_id), profile: msgRaw.contacts },
            ip: opts.ip,
            userAgent: opts.userAgent,
          });
          if (!filed.duplicate) inboundMessages += 1;
          await recordEvent({
            tenantId: resolved.tenantId,
            eventType: 'inbound',
            providerMessageId: messageId,
            whatsappMessageId: filed.id,
            fromNumber: from,
            payload: msgRaw,
            signatureValid: true,
            error: null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[whatsapp][inbound] message file failed', message);
          await recordEvent({
            tenantId: resolved.tenantId,
            eventType: 'inbound',
            providerMessageId: messageId,
            whatsappMessageId: null,
            fromNumber: from,
            payload: msgRaw,
            signatureValid: true,
            error: message,
          });
          return { accepted: false, reason: 'DB_ERROR', inboundMessages, statusUpdates, retryable: true };
        }
      }

      // Delivery statuses: correlate and update the outbound row.
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const statusRaw of statuses) {
        if (!isRecord(statusRaw)) continue;
        const messageId = text(statusRaw.id);
        const status = text(statusRaw.status);
        if (!messageId || !status) continue;
        const timestamp = epochToDate(statusRaw.timestamp);
        try {
          const updatedId = await applyStatus({
            tenantId: resolved.tenantId,
            messageId,
            status,
            timestamp,
          });
          await recordEvent({
            tenantId: resolved.tenantId,
            eventType: 'status',
            providerMessageId: messageId,
            whatsappMessageId: updatedId,
            fromNumber: text(statusRaw.recipient_id),
            payload: statusRaw,
            signatureValid: true,
            error: updatedId === null ? 'NOT_FOUND' : null,
          });
          if (updatedId !== null) statusUpdates += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[whatsapp][inbound] status update failed', message);
          await recordEvent({
            tenantId: resolved.tenantId,
            eventType: 'status',
            providerMessageId: messageId,
            whatsappMessageId: null,
            fromNumber: text(statusRaw.recipient_id),
            payload: statusRaw,
            signatureValid: true,
            error: message,
          });
          return { accepted: false, reason: 'DB_ERROR', inboundMessages, statusUpdates, retryable: true };
        }
      }
    }
  }

  return { accepted: true, reason: null, inboundMessages, statusUpdates, retryable: false };
}
