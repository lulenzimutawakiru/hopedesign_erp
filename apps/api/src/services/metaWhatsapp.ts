/**
 * Meta WhatsApp Business Cloud API - the outbound sender and the inbound
 * webhook authentication primitives.
 *
 * The Cloud API is the primary WhatsApp provider. `sendWhatsAppViaMetaCloud`
 * posts a text or template message to the Graph API; delivery is *accepted*
 * here and the eventual sent/delivered/read/failed state arrives later on the
 * status webhook (services/whatsapp/ingest.ts). Nothing in this module claims a
 * message was delivered - the send response carries only the message id Meta
 * assigned it.
 *
 * Authentication of the inbound webhook is `X-Hub-Signature-256`: the hex
 * HMAC-SHA256 of the raw request body keyed with the app secret. The raw bytes
 * are the signed artefact, never a re-serialised copy of the parsed object, so
 * the check takes req.rawBody exactly as the caller captured it.
 *
 * Everything fails closed: a missing token/phone-number-id refuses every send,
 * and a missing secret or header refuses every webhook delivery.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import type { BirdSendResult } from './bird.js';
import { normalizeE164 } from './africastalking.js';

export interface MetaWhatsAppTemplate {
  name: string;
  language: { code: string };
  components?: unknown[];
}

export interface SendMetaWhatsAppInput {
  to: string;
  /** Plain-text message body. Mutually exclusive with `template`. */
  text?: string;
  /** Approved message template. Mutually exclusive with `text`. */
  template?: MetaWhatsAppTemplate;
}

/** True when the Meta Cloud API is configured well enough to send. */
export function isMetaWhatsappConfigured(): boolean {
  return Boolean(config.whatsapp.accessToken.trim() && config.whatsapp.phoneNumberId.trim());
}

const META_BASE_URL = 'https://graph.facebook.com';

/** Attempts per send, mirroring the bounded retry in resend.ts. */
const META_MAX_ATTEMPTS = 3;
const META_RETRY_BASE_MS = 400;
const META_MAX_RETRY_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pull the provider's message out of a failed Graph API response body. */
function extractMetaError(data: Record<string, unknown> | null, status: number): string {
  const err = data?.error as { message?: unknown } | undefined;
  if (typeof err?.message === 'string' && err.message.trim()) return err.message;
  return 'Meta WhatsApp error ' + status;
}

/**
 * Send one message through the Graph API.
 *
 * Retry policy: a 5xx or a 429 is transient and retried a bounded number of
 * times; any other 4xx is terminal (a bad template, an un-recipient, a revoked
 * token) and returned at once. Retrying a 429 costs a small wait and is exactly
 * what restores delivery after a per-second rate limit.
 */
export async function sendWhatsAppViaMetaCloud(
  input: SendMetaWhatsAppInput
): Promise<BirdSendResult> {
  const { accessToken, phoneNumberId, apiVersion } = config.whatsapp;
  if (!accessToken.trim() || !phoneNumberId.trim()) {
    return {
      ok: false,
      error: 'Meta WhatsApp not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing)',
    };
  }
  const to = normalizeE164(input.to);
  if (!to) return { ok: false, error: 'WhatsApp recipient missing' };

  const hasText = typeof input.text === 'string' && input.text.trim().length > 0;
  const hasTemplate = Boolean(input.template?.name?.trim());
  if (hasText === hasTemplate) {
    return { ok: false, error: 'Provide exactly one of text or template' };
  }

  const message = hasText
    ? { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: input.text!.trim() } }
    : {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: input.template,
      };

  const url = `${META_BASE_URL}/${apiVersion.trim()}/${phoneNumberId.trim()}/messages`;
  const body = JSON.stringify(message);

  let lastError = 'Meta WhatsApp error';
  for (let attempt = 1; attempt <= META_MAX_ATTEMPTS; attempt += 1) {
    const backoffMs = Math.min(META_RETRY_BASE_MS * 2 ** (attempt - 1), META_MAX_RETRY_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken.trim(),
          'Content-Type': 'application/json',
        },
        body,
      });
      const data = (await res.json().catch(() => null)) as
        | { messages?: { id?: unknown }[]; error?: { message?: unknown } }
        | null;
      if (res.ok) {
        const first = Array.isArray(data?.messages) ? data!.messages![0] : undefined;
        return {
          ok: true,
          provider: 'meta',
          providerMessageId: first?.id != null ? String(first.id) : undefined,
          status: 'accepted',
        };
      }

      lastError = extractMetaError(data as Record<string, unknown> | null, res.status);
      const retryable = res.status >= 500 || res.status === 429;
      if (!retryable || attempt === META_MAX_ATTEMPTS) return { ok: false, error: lastError };

      await sleep(backoffMs);
    } catch (err) {
      // A thrown fetch is a transport failure (DNS, reset, timeout): retryable.
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === META_MAX_ATTEMPTS) return { ok: false, error: lastError };
      await sleep(backoffMs);
    }
  }
  return { ok: false, error: lastError };
}

export interface MetaSignatureCheck {
  ok: boolean;
  /** Machine-readable refusal reason; null when the signature verified. */
  reason: string | null;
}

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify the `X-Hub-Signature-256` header against the raw request body.
 *
 * The header is `sha256=<hex>`; the digest is HMAC-SHA256 over the exact body
 * bytes, keyed with the WhatsApp app secret. A missing secret, a missing
 * header, an unparsable hex value or any crypto error is a refusal, never a
 * pass.
 */
export function verifyMetaSignature(opts: {
  rawBody?: Buffer | string | null;
  signatureHeader?: string | null;
  appSecret?: string | null;
}): MetaSignatureCheck {
  const secret = String(opts.appSecret ?? config.whatsapp.appSecret ?? '').trim();
  if (!secret) return { ok: false, reason: 'SECRET_NOT_CONFIGURED' };

  const header = String(opts.signatureHeader ?? '').trim();
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header);
  if (!m) return { ok: false, reason: 'SIGNATURE_HEADER_MISSING' };

  if (opts.rawBody == null) return { ok: false, reason: 'RAW_BODY_MISSING' };
  const body = Buffer.isBuffer(opts.rawBody) ? opts.rawBody : Buffer.from(String(opts.rawBody), 'utf8');
  if (body.length === 0) return { ok: false, reason: 'RAW_BODY_MISSING' };

  let received: Buffer;
  try {
    received = Buffer.from(m[1], 'hex');
  } catch {
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }

  const expected = createHmac('sha256', Buffer.from(secret, 'utf8')).update(body).digest();
  return safeEqual(received, expected) ? { ok: true, reason: null } : { ok: false, reason: 'SIGNATURE_INVALID' };
}

/**
 * Echo the hub challenge back only when the subscription handshake is valid:
 * `hub.mode === 'subscribe'` and `hub.verify_token` matches the configured
 * token. Everything else is refused so a scanner cannot complete a handshake
 * against a token nobody set.
 */
export function verifyHubChallenge(opts: {
  mode?: unknown;
  token?: unknown;
  challenge?: unknown;
}): { ok: boolean; challenge?: string } {
  const configured = config.whatsapp.verifyToken.trim();
  if (!configured) return { ok: false };
  if (String(opts.mode ?? '') !== 'subscribe') return { ok: false };
  if (String(opts.token ?? '') !== configured) return { ok: false };
  const challenge = String(opts.challenge ?? '');
  if (!challenge) return { ok: false };
  return { ok: true, challenge };
}
