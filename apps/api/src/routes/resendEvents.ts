/**
 * Resend inbound mail receiver (unauthenticated provider webhook).
 *
 *   POST /api/integrations/email/resend
 *
 * Resend is the caller, so the Svix signature over the RAW request body is the
 * authentication (services/mail/inbound/resend.ts). The raw bytes are the
 * signed artefact, never a re-serialised copy of the parsed object: a JSON
 * parse/stringify round trip reorders keys and every signature would fail.
 * express.json already captures those bytes in req.rawBody; the fallback
 * reader below captures them for a body sent under a non-JSON content type.
 *
 * This router is a boundary adapter and nothing more. It reads the request,
 * hands it to the ingest service, and acknowledges. Every delivery is answered
 * HTTP 200, including a refusal - Resend retries a non-2xx response, and a
 * retry cannot repair a bad signature or a destination no mailbox owns, so a
 * 200 ends the retry loop while the specific reason goes to the audit trail
 * and the server log. Only a malformed body is answered 400, because a
 * truncated body may be transport damage worth retrying.
 */
import express, { NextFunction, Request, Response, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ingestResendEmail, IngestResult } from '../services/mail/inbound/ingest.js';
import { ApiError, asyncHandler } from '../utils.js';

export const resendEventsRouter = Router();

/** Per-source limiter: one bucket per calling IP. */
const inboundLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.socket.remoteAddress ?? req.ip ?? 'unknown',
});

/**
 * Fallback reader for a body that arrives under a non-JSON content type. The
 * published contract is application/json, which express.json has already
 * parsed; this only catches a relabelled body, which would otherwise arrive
 * empty and fail its signature check.
 */
const rawBodyReader = express.text({
  type: ['text/plain', 'application/octet-stream'],
  limit: '2mb',
  verify: (req, _res, buf) => {
    (req as Request).rawBody = Buffer.from(buf);
  },
});

/** Read the webhook envelope, tolerating a body the fallback reader left as text. */
function readBody(req: Request): unknown {
  const body: unknown = req.body;
  if (typeof body !== 'string') return body;
  const text = body.trim();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Addresses from an envelope field that may be a string or an array. */
function addressList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  return raw.map((v) => String(v ?? '').trim()).filter((v) => v.length > 0);
}

function text(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s.length === 0 ? null : s;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The exact request shape the ingest service expects, assembled once. */
function prepare(req: Request) {
  const body = readBody(req);
  const root = isRecord(body) ? body : {};
  const data = isRecord(root.data) ? root.data : root;
  const emailId = text(data.email_id) ?? text(data.emailId) ?? text(data.id);
  const recipients = [...addressList(data.received_for), ...addressList(data.to)];
  return {
    emailId: emailId ?? '',
    envelope: {
      eventType: text(root.type) ?? 'email.received',
      providerMessageId: text(data.message_id),
      recipients,
    },
    options: {
      emailId: emailId ?? '',
      providerMessageId: text(data.message_id),
      eventType: text(root.type) ?? 'email.received',
      recipients,
      rawBody:
        req.rawBody ?? (typeof req.body === 'string' ? Buffer.from(req.body, 'utf8') : null),
      headers: req.headers as unknown as Record<string, unknown>,
      payload: isRecord(body) ? body : { raw: typeof body === 'string' ? body : null },
      ip: req.ip ?? req.socket.remoteAddress ?? '',
      userAgent: req.headers['user-agent'] ?? null,
    },
  };
}

/**
 * Resend reads the status code and nothing else. The acknowledgement never
 * echoes supplied content, so a forged message learns only that it was
 * received.
 */
function acknowledgement(result: IngestResult) {
  return {
    received: true,
    accepted: result.accepted,
    duplicate: result.duplicate,
    messageId: result.emailRowId,
  };
}

resendEventsRouter.post(
  '/',
  inboundLimiter,
  rawBodyReader,
  asyncHandler(async (req, res) => {
    const { options } = prepare(req);
    const result = await ingestResendEmail(options);
    res.status(200).json(acknowledgement(result));
  })
);

/** Paths this filter owns; anything else falls through to the next handler. */
const OWNED_PATHS = ['/'];

/**
 * Opaque error filter for the provider-facing surface. Body-parser syntax
 * errors and our own ApiErrors become generic responses; parser internals,
 * stack traces and schema details never reach the caller.
 */
export function resendWebhookErrorFilter(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!OWNED_PATHS.some((path) => req.path.startsWith(path))) {
    next(err);
    return;
  }
  const syntax = err as { type?: string; status?: number; message?: string };
  const parseFailure =
    syntax?.type === 'entity.parse.failed' ||
    syntax?.type === 'encoding.unsupported' ||
    syntax?.type === 'entity.too.large' ||
    syntax?.type === 'request.aborted' ||
    (err instanceof SyntaxError &&
      typeof syntax?.message === 'string' &&
      syntax.message.includes('JSON'));
  if (parseFailure) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid webhook payload' } });
    return;
  }
  if (err instanceof ApiError && err.status < 500) {
    res.status(err.status).json({
      error: {
        code: err.status === 401 ? 'UNAUTHORIZED' : err.status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST',
        message: 'Webhook rejected',
      },
    });
    return;
  }
  console.error(`[mail][inbound] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Service unavailable' } });
}
