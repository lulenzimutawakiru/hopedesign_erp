/**
 * Resend inbound primitives: webhook authentication, the Received-emails API
 * client, and the RFC 5322 address parser.
 *
 * Resend does not POST the message. Its `email.received` webhook carries
 * metadata only - ids, addresses, subject, attachment descriptors - and the
 * body and headers have to be fetched back from the Received-emails API with
 * the account API key. That split is the reason this module has two halves:
 * one authenticates the caller, one retrieves the message it is telling us
 * about.
 *
 * Authentication is Svix (Resend's webhook transport). The signature covers
 *   `${svix-id}.${svix-timestamp}.${rawBody}`
 * where rawBody is the exact byte sequence Resend sent. Re-serialising the
 * parsed object would reorder keys and change whitespace, so the signature is
 * checked against req.rawBody and never against JSON.stringify(req.body).
 *
 * Everything here fails closed: a missing secret, a missing header, an
 * unparsable secret, a stale timestamp or any crypto error is a verification
 * failure, never a pass. A failed signature ends the request - nothing is
 * stored and no provider call is made.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../../config.js';

const RESEND_RECEIVING_URL = 'https://api.resend.com/emails/receiving';

/** Svix replay window. A signature older than this is refused outright. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export interface ReceivedEmailSummary {
  id: string;
  created_at: string | null;
  from: string | null;
  to: string[];
  subject: string | null;
}

export interface ReceivedAttachment {
  id: string;
  filename: string;
  content_type: string | null;
  content_disposition: string | null;
  content_id: string | null;
}

export interface ReceivedEmail {
  id: string;
  to: string[];
  from: string | null;
  created_at: string | null;
  subject: string | null;
  message_id: string | null;
  bcc: string[];
  cc: string[];
  reply_to: string[];
  html: string | null;
  text: string | null;
  headers: Record<string, string | string[] | null> | null;
  received_for: string[];
  attachments: ReceivedAttachment[];
}

/** Trim a header value; blank values become null. */
function clean(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s.length === 0 ? null : s;
}

/** Normalise an address list from either a string or an array of strings. */
function addressList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  return raw
    .map((v) => clean(v))
    .filter((v): v is string => v !== null);
}

/**
 * Decode a Svix signing secret into the raw HMAC key.
 *
 * The secret is published as `whsec_<base64>`; the key is the decoded bytes,
 * not the base64 text. A secret that is not base64-decodable is used verbatim
 * rather than silently producing an empty key.
 */
function decodeSecret(secret: string): Buffer | null {
  const trimmed = secret.trim();
  if (!trimmed) return null;
  const body = trimmed.startsWith('whsec_') ? trimmed.slice('whsec_'.length) : trimmed;
  if (!body) return null;
  const decoded = Buffer.from(body, 'base64');
  if (decoded.length > 0) return decoded;
  return Buffer.from(body, 'utf8');
}

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface SignatureCheck {
  ok: boolean;
  /** Machine-readable refusal reason; null when the signature verified. */
  reason: string | null;
}

/**
 * Verify the Svix signature headers against the raw request body.
 *
 * The header value is a space-separated list of `version,base64signature`
 * entries; any `v1` entry that matches accepts the message, because a secret
 * rotation legitimately publishes two valid signatures at once.
 */
export function verifyResendSignature(opts: {
  rawBody?: Buffer | string | null;
  headers?: Record<string, unknown>;
  secret?: string | null;
  now?: number;
}): SignatureCheck {
  const secret = clean(opts.secret ?? config.resend.webhookSecret);
  if (!secret) return { ok: false, reason: 'SECRET_NOT_CONFIGURED' };

  const headers = opts.headers ?? {};
  const svixId = clean(headers['svix-id']);
  const svixTimestamp = clean(headers['svix-timestamp']);
  const svixSignature = clean(headers['svix-signature']);
  if (!svixId || !svixTimestamp || !svixSignature) return { ok: false, reason: 'SIGNATURE_HEADERS_MISSING' };

  if (opts.rawBody == null) return { ok: false, reason: 'RAW_BODY_MISSING' };
  const body = Buffer.isBuffer(opts.rawBody) ? opts.rawBody : Buffer.from(String(opts.rawBody), 'utf8');
  if (body.length === 0) return { ok: false, reason: 'RAW_BODY_MISSING' };

  const sentAt = Number(svixTimestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'SIGNATURE_TIMESTAMP_INVALID' };
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - sentAt) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'SIGNATURE_TIMESTAMP_STALE' };
  }

  const key = decodeSecret(secret);
  if (!key) return { ok: false, reason: 'SECRET_NOT_CONFIGURED' };

  const signedContent = Buffer.concat([
    Buffer.from(`${svixId}.${svixTimestamp}.`, 'utf8'),
    body,
  ]);
  const expected = createHmac('sha256', key).update(signedContent).digest();

  for (const entry of svixSignature.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma < 0) continue;
    const version = entry.slice(0, comma).trim();
    const value = entry.slice(comma + 1).trim();
    if (version !== 'v1' || !value) continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(value, 'base64');
    } catch {
      continue;
    }
    if (candidate.length > 0 && safeEqual(candidate, expected)) return { ok: true, reason: null };
  }
  return { ok: false, reason: 'SIGNATURE_INVALID' };
}

/** True when the inbound path is configured well enough to accept anything. */
export function isInboundConfigured(): boolean {
  return Boolean(config.resend.apiKey.trim() && config.resend.webhookSecret.trim());
}

/**
 * Longest one Received-emails request may run before it is abandoned. The
 * webhook handler holds Resend's request open for as long as this call is in
 * flight, so the bound exists to stop an unattended socket from stalling the
 * acknowledgement - undici's own default is measured in minutes.
 */
const RECEIVING_TIMEOUT_MS = 15_000;

/**
 * Attempts per call, and the pause between them. Resend's webhook is answered
 * HTTP 200 for every permanent outcome, so a transient blip that is not retried
 * here would leave the message unfiled until an operator re-ran the backfill.
 */
const RECEIVING_ATTEMPTS = 3;
const RECEIVING_BACKOFF_MS = 400;

/** A status worth retrying: the message is not wrong, the moment is. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * undici collapses every network fault into `TypeError: fetch failed` and keeps
 * the real reason - the DNS, connect or TLS error - on `cause`. Without that
 * detail a recorded FETCH_FAILED says only that something went wrong.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause: unknown = err.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    const detail =
      typeof code === 'string' && code.length > 0 ? `${cause.message} (${code})` : cause.message;
    return `${err.name}: ${err.message}; cause ${cause.name}: ${detail}`;
  }
  if (typeof cause === 'string' && cause.length > 0) return `${err.name}: ${err.message}; cause ${cause}`;
  return `${err.name}: ${err.message}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One authenticated call to the Received-emails API, retried on a transient
 * fault.
 *
 * A 4xx is terminal and returns at once: the key or the id is wrong and no
 * retry changes that. Everything else - a timeout, a socket fault, a 429, a 5xx
 * - is tried again in place, and the caller is told whether the failure stayed
 * retryable so the webhook can hand the delivery back to Resend rather than
 * drop it.
 */
async function resendGet<T>(
  path: string
): Promise<{ ok: true; data: T } | { ok: false; error: string; retryable: boolean }> {
  const apiKey = config.resend.apiKey.trim();
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY missing', retryable: false };

  let error = 'Resend request failed';
  for (let attempt = 1; attempt <= RECEIVING_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(RECEIVING_BACKOFF_MS * (attempt - 1));
    try {
      const res = await fetch(`${RESEND_RECEIVING_URL}${path}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(RECEIVING_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, data: (await res.json()) as T };
      error = `Resend error ${res.status}`;
      if (!isRetryableStatus(res.status)) return { ok: false, error, retryable: false };
    } catch (err) {
      error = describeError(err);
    }
  }
  return { ok: false, error, retryable: true };
}

/** Normalise one attachment descriptor from either API shape. */
function normalizeAttachment(raw: unknown): ReceivedAttachment | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const id = clean(rec.id);
  const filename = clean(rec.filename) ?? clean(rec.name);
  if (!id || !filename) return null;
  return {
    id,
    filename,
    content_type: clean(rec.content_type),
    content_disposition: clean(rec.content_disposition),
    content_id: clean(rec.content_id),
  };
}

/** One message, or the reason it could not be retrieved. */
export type FetchReceivedResult =
  | { ok: true; email: ReceivedEmail }
  | { ok: false; error: string; retryable: boolean };

/**
 * Fetch one received message in full: body, headers, envelope and attachment
 * descriptors. A failure is reported rather than thrown, so the caller can
 * record the delivery as unprocessed instead of writing a half-message, and it
 * carries whether the failure was transient so a delivery can be retried
 * instead of dropped.
 */
export async function fetchReceivedEmail(id: string): Promise<FetchReceivedResult> {
  const emailId = clean(id);
  if (!emailId) return { ok: false, error: 'MISSING_EMAIL_ID', retryable: false };
  const result = await resendGet<Record<string, unknown>>(`/${encodeURIComponent(emailId)}`);
  if (!result.ok) {
    console.error(
      `[mail][inbound] received-email fetch failed id=${emailId} retryable=${result.retryable}: ${result.error}`
    );
    return { ok: false, error: result.error, retryable: result.retryable };
  }
  const raw = result.data ?? {};
  const headers =
    typeof raw.headers === 'object' && raw.headers !== null
      ? (raw.headers as Record<string, string | string[] | null>)
      : null;
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.map(normalizeAttachment).filter((a): a is ReceivedAttachment => a !== null)
    : [];
  const email: ReceivedEmail = {
    id: clean(raw.id) ?? emailId,
    to: addressList(raw.to),
    from: clean(raw.from),
    created_at: clean(raw.created_at),
    subject: clean(raw.subject),
    message_id: clean(raw.message_id),
    bcc: addressList(raw.bcc),
    cc: addressList(raw.cc),
    reply_to: addressList(raw.reply_to),
    html: typeof raw.html === 'string' ? raw.html : null,
    text: typeof raw.text === 'string' ? raw.text : null,
    headers,
    received_for: addressList(raw.received_for),
    attachments,
  };
  return { ok: true, email };
}

/** List stored received messages, newest first. Used by the backfill script. */
export async function listReceivedEmails(limit = 100): Promise<ReceivedEmailSummary[]> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 100, 1), 100);
  const result = await resendGet<{ data?: unknown }>(`?limit=${capped}`);
  if (!result.ok) {
    console.error(`[mail][inbound] received-email list failed: ${result.error}`);
    return [];
  }
  const rows = Array.isArray(result.data?.data) ? (result.data!.data as unknown[]) : [];
  return rows
    .map((raw): ReceivedEmailSummary | null => {
      if (typeof raw !== 'object' || raw === null) return null;
      const rec = raw as Record<string, unknown>;
      const id = clean(rec.id);
      if (!id) return null;
      return {
        id,
        created_at: clean(rec.created_at),
        from: clean(rec.from),
        to: addressList(rec.to),
        subject: clean(rec.subject),
      };
    })
    .filter((r): r is ReceivedEmailSummary => r !== null);
}

/**
 * Read one header value out of the fetched message, case-insensitively. The
 * Received-emails API returns header names in lower case, but that is an
 * implementation detail we do not want to depend on.
 */
export function headerValue(
  headers: Record<string, string | string[] | null> | null,
  name: string
): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value.length > 0 ? clean(value[0]) : null;
    return clean(value);
  }
  return null;
}

/**
 * Parse an RFC 5322 address into its display name and address.
 *
 * Handles `Name <addr>`, `"Name" <addr>`, `Name <addr>, Other <addr>` (first
 * entry wins) and a bare `addr`. Anything unparsable becomes the address with
 * no name rather than being dropped - a stored message with an odd sender
 * beats a message that never arrives.
 */
export function parseFromHeader(value: string | null): { name: string | null; email: string | null } {
  const raw = clean(value);
  if (!raw) return { name: null, email: null };
  const first = raw.split(',')[0].trim();

  const angled = first.match(/^(.*)<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1].trim().replace(/^"(.*)"$/, '$1').trim();
    const email = clean(angled[2]);
    return { name: name.length > 0 ? name : null, email };
  }
  return { name: null, email: clean(first) };
}

/** True when the header looks like an address we can store as a sender. */
export function isEmailAddress(value: string | null): boolean {
  if (!value) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
