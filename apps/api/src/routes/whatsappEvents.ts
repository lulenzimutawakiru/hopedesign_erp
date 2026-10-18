/**
 * Meta WhatsApp webhook receiver (unauthenticated provider webhook).
 *
 *   GET  /api/integrations/whatsapp  - hub verification challenge
 *   POST /api/integrations/whatsapp  - inbound messages + delivery statuses
 *
 * Meta is the caller, so the `X-Hub-Signature-256` HMAC over the RAW request
 * body is the authentication (services/metaWhatsapp.ts). The raw bytes are the
 * signed artefact, never a re-serialised copy of the parsed object: a JSON
 * parse/stringify round trip reorders keys and every signature would fail.
 * express.json already captures those bytes in req.rawBody; the fallback reader
 * below captures them for a body sent under a non-JSON content type.
 *
 * This router is a boundary adapter and nothing more. It reads the request,
 * hands it to the ingest service, and acknowledges. A permanent outcome is
 * answered HTTP 200, including a refusal - Meta retries a non-2xx response, and
 * a retry cannot repair a bad signature or a number no tenant owns, so a 200
 * ends the retry loop while the specific reason goes to the ledger. A transient
 * database fault is answered 503, because there a retry is exactly what
 * repairs it.
 */
import express, { NextFunction, Request, Response, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ingestWhatsAppEvent, IngestResult } from '../services/whatsapp/ingest.js';
import { verifyHubChallenge } from '../services/metaWhatsapp.js';
import { ApiError, asyncHandler } from '../utils.js';

export const whatsappEventsRouter = Router();

/** Per-source limiter: one bucket per calling IP. */
const inboundLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.socket.remoteAddress ?? req.ip ?? 'unknown',
});

/** Fallback reader for a body that arrives under a non-JSON content type. */
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

/**
 * Hub verification handshake. Meta sends `GET ...?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
 * and expects the challenge echoed verbatim when the token matches.
 */
whatsappEventsRouter.get('/', (req, res) => {
  const check = verifyHubChallenge({
    mode: req.query['hub.mode'],
    token: req.query['hub.verify_token'],
    challenge: req.query['hub.challenge'],
  });
  if (!check.ok) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Verification failed' } });
    return;
  }
  res.status(200).send(check.challenge);
});

/** Meta reads the status code and nothing else. */
function acknowledgement(result: IngestResult) {
  return {
    received: true,
    accepted: result.accepted,
    inboundMessages: result.inboundMessages,
    statusUpdates: result.statusUpdates,
  };
}

whatsappEventsRouter.post(
  '/',
  inboundLimiter,
  rawBodyReader,
  asyncHandler(async (req, res) => {
    const body = readBody(req);
    const headers = req.headers as unknown as Record<string, unknown>;
    const result = await ingestWhatsAppEvent({
      rawBody: req.rawBody ?? (typeof req.body === 'string' ? Buffer.from(req.body, 'utf8') : null),
      headers,
      payload: body ?? {},
      ip: req.ip ?? req.socket.remoteAddress ?? '',
      userAgent: req.headers['user-agent'] ?? null,
    });
    // A transient database fault is the one outcome a retry can repair, so it is
    // the one outcome answered with a retryable status: Meta redelivers and the
    // message is filed on a later attempt. Every permanent outcome - including
    // every refusal - stays 200 to end the retry loop.
    if (!result.accepted && result.retryable) {
      res.status(503).json(acknowledgement(result));
      return;
    }
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
export function whatsappWebhookErrorFilter(
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
  console.error(`[whatsapp][inbound] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Service unavailable' } });
}
