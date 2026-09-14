/**
 * KCB inbound notification receiver (unauthenticated bank webhook).
 *
 *   POST /api/integrations/kcb/account-notification
 *   POST /api/integrations/kcb/till-notification
 *   POST /api/integrations/kcb/validation
 *
 * KCB is the caller, so the RSA signature over the RAW request body is the
 * authentication (services/kcb/security.ts). The raw bytes are the signed
 * artefact, never a re-serialised copy of the parsed object: a JSON
 * parse/stringify round trip reorders keys and every signature would fail.
 * express.json already captures those bytes in req.rawBody; the fallback
 * reader below captures them for a body sent under a non-JSON content type.
 *
 * This router is a boundary adapter and nothing more. It reads the request,
 * hands it to the ingest service, and renders KCB's acknowledgement contract.
 * It decides nothing about who the caller is, what they may see, or whether a
 * payment is real - all of that is settled by the signature in ingest.ts.
 *
 * Refusals are answered HTTP 200 with a non-zero statusCode on purpose. A hard
 * failure makes KCB retry, and a retry cannot repair an invalid signature or an
 * account we cannot map; a 200 with statusCode '1' says "received, not
 * accepted", which ends the retry loop. The specific reason goes to the audit
 * trail and the server log, never to the response - a forged message learns
 * only that it was rejected. A malformed body is the one exception: it is
 * answered 400, because a truncated body may be transport damage worth retrying.
 */
import express, { NextFunction, Request, Response, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  ingestKcbNotification,
  readSignatureHeader,
  validateKcbBill,
  KcbBillValidationResult,
  KcbIngestResult,
} from '../services/kcb/ingest.js';
import { isRecord, str, KcbNotificationType } from '../services/kcb/payload.js';
import { ApiError, asyncHandler } from '../utils.js';

export const kcbEventsRouter = Router();

/** Per-source limiter: one bucket per calling IP. */
const notificationLimiter = rateLimit({
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
 * empty and be refused as unparsable.
 */
const rawBodyReader = express.text({
  type: ['text/plain', 'application/octet-stream', 'application/xml', 'text/xml'],
  limit: '2mb',
  verify: (req, _res, buf) => {
    (req as Request).rawBody = Buffer.from(buf);
  },
});

/** Identifiers KCB sends that its acknowledgement contract echoes back. */
interface AckIdentifiers {
  messageId: string | null;
  originatorConversationId: string | null;
  transactionId: string | null;
  transactionReference: string | null;
}

/**
 * Pull the echo identifiers out of the wire envelope. This is the only place in
 * the router that knows the two published envelopes exist, and it reads
 * identifiers only - no amounts, names or customer references are ever echoed
 * back, so a response cannot be used to reflect supplied content.
 */
function ackIdentifiers(body: unknown): AckIdentifiers {
  const root = isRecord(body) ? body : {};
  const header = isRecord(root.header) ? root.header : {};
  const requestPayload = isRecord(root.requestPayload) ? root.requestPayload : {};
  const additionalData = isRecord(requestPayload.additionalData) ? requestPayload.additionalData : {};
  const notificationData = isRecord(additionalData.notificationData) ? additionalData.notificationData : {};
  return {
    messageId: str(header.messageID),
    originatorConversationId: str(header.originatorConversationID),
    transactionId: str(notificationData.transactionID) ?? str(root.transactionID),
    transactionReference: str(root.transactionReference) ?? str(notificationData.transactionReference),
  };
}

/** Decode a body the fallback reader left as text; null when there is none. */
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

/** The exact request shape the ingest service expects, assembled once. */
function prepare(req: Request, notificationType: KcbNotificationType) {
  const body = readBody(req);
  return {
    ack: ackIdentifiers(body),
    options: {
      body,
      rawBody: req.rawBody ?? (typeof req.body === 'string' ? Buffer.from(req.body, 'utf8') : null),
      signature: readSignatureHeader(req.headers as unknown as Record<string, unknown>),
      notificationType,
      ip: req.ip ?? req.socket.remoteAddress ?? '',
      userAgent: req.headers['user-agent'] ?? null,
    },
  };
}

/**
 * KCB reads statusCode and nothing else: '0' is accepted, anything else is
 * "received but not accepted". The reason stays server-side.
 */
function status(accepted: boolean): { statusCode: string; statusMessage: string } {
  return accepted
    ? { statusCode: '0', statusMessage: 'Notification received successfully' }
    : { statusCode: '1', statusMessage: 'Notification rejected' };
}

/** Account-notification acknowledgement (flat, per the published contract). */
function accountAcknowledgement(result: KcbIngestResult, ids: AckIdentifiers) {
  return {
    transactionID: ids.transactionReference ?? ids.transactionId ?? '',
    ...status(result.accepted),
  };
}

/** Till-notification acknowledgement (header + responsePayload, per contract). */
function tillAcknowledgement(result: KcbIngestResult, ids: AckIdentifiers) {
  return {
    header: {
      messageID: ids.messageId ?? '',
      originatorConversationID: ids.originatorConversationId ?? '',
      ...status(result.accepted),
    },
    responsePayload: {
      transactionInfo: {
        transactionId: ids.transactionId ?? '',
      },
    },
  };
}

/**
 * Bill-validation response. It answers with our own record of the bill, never a
 * value echoed from the request, and declines an unknown reference by returning
 * an empty biller name. Authorising a payment is not receiving one, so nothing
 * here touches the ledger.
 */
function validationAcknowledgement(result: KcbBillValidationResult) {
  const accepted = result.accepted && result.customerName !== null;
  return {
    CustomerName: accepted ? (result.customerName ?? '') : '',
    billAmount: accepted ? (result.billAmount ?? 0) : 0,
    currency: accepted ? (result.currency ?? '') : '',
    billType: accepted ? (result.billType ?? '') : '',
    creditAccountIdentifier: accepted ? (result.creditAccountIdentifier ?? '') : '',
    ...status(accepted),
  };
}

kcbEventsRouter.post(
  '/account-notification',
  notificationLimiter,
  rawBodyReader,
  asyncHandler(async (req, res) => {
    const { options, ack } = prepare(req, 'ACCOUNT');
    const result = await ingestKcbNotification(options);
    res.status(200).json(accountAcknowledgement(result, ack));
  })
);

kcbEventsRouter.post(
  '/till-notification',
  notificationLimiter,
  rawBodyReader,
  asyncHandler(async (req, res) => {
    const { options, ack } = prepare(req, 'TILL');
    const result = await ingestKcbNotification(options);
    res.status(200).json(tillAcknowledgement(result, ack));
  })
);

kcbEventsRouter.post(
  '/validation',
  notificationLimiter,
  rawBodyReader,
  asyncHandler(async (req, res) => {
    const { options } = prepare(req, 'VALIDATION');
    const result = await validateKcbBill(options);
    res.status(200).json(validationAcknowledgement(result));
  })
);

/** Paths this filter owns; anything else falls through to the next handler. */
const OWNED_PATHS = ['/account-notification', '/till-notification', '/validation'];

/**
 * Opaque error filter for the bank-facing surface. Body-parser syntax errors
 * and our own ApiErrors become generic responses; parser internals, stack
 * traces and schema details never reach the caller.
 */
export function kcbWebhookErrorFilter(err: unknown, req: Request, res: Response, next: NextFunction): void {
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
    (err instanceof SyntaxError && typeof syntax?.message === 'string' && syntax.message.includes('JSON'));
  if (parseFailure) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid notification payload' } });
    return;
  }
  if (err instanceof ApiError && err.status < 500) {
    res.status(err.status).json({
      error: {
        code: err.status === 401 ? 'UNAUTHORIZED' : err.status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST',
        message: 'Notification rejected',
      },
    });
    return;
  }
  console.error(`[kcb][webhook] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Service unavailable' } });
}
