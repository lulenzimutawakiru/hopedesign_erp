/**
 * Hikvision secure event receiver (unauthenticated device webhook).
 *
 *   POST /api/integrations/hikvision/events
 *
 * Terminals authenticate with x-hikvision-serial + x-hikvision-key headers
 * (query-string credentials are only honoured for devices configured with
 * allow_query_key). JSON bodies are parsed by the global express.json parser;
 * XML bodies are read as strict text. Every event is validated, stored raw and
 * queued by ingestDeviceEvent; this route only acknowledges receipt so the
 * terminal can move on (200). All error responses are deliberately opaque.
 */
import express, { NextFunction, Request, Response, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ingestDeviceEvent, HeaderMap, WebhookCredentials } from '../services/hikvision/ingest.js';
import { parseMultipartBody } from '../services/hikvision/parser.js';
import { ApiError, asyncHandler } from '../utils.js';

export const hikvisionEventsRouter = Router();

/** Per-source limiter: terminal IP + serial share one small bucket. */
const eventLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const serial = req.headers['x-hikvision-serial'];
    const ip = req.socket.remoteAddress ?? req.ip ?? 'unknown';
    return `${ip}:${String(serial ?? 'none')}`;
  },
});

/** Parse XML/plain-text payloads; JSON is already handled by express.json(). */
const xmlParser = express.text({ type: ['application/xml', 'text/xml'], limit: '2mb' });

/**
 * A terminal configured with an HTTP listening host posts multipart/form-data.
 * No multipart middleware is mounted app-wide, so the body is read as a raw
 * buffer here and decoded with parseMultipartBody in the handler.
 */
// 25mb matches the Caddy request_body max_size on this route: a verification
// event carries a JPEG snapshot, and a 3mb body was previously rejected with a
// 500 (PayloadTooLargeError) that the terminal retried forever.
const multipartParser = express.raw({ type: ['multipart/form-data'], limit: '25mb' });

hikvisionEventsRouter.post(
  '/events',
  eventLimiter,
  xmlParser,
  multipartParser,
  asyncHandler(async (req, res) => {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    // The listening host wraps each event as a JSON part named
    // AccessControllerEvent; flatten it so the shared alias lookups apply.
    let body: unknown = req.body;
    let rawText: string | null = typeof req.body === 'string' ? req.body : null;
    // Multipart diagnostics carry the decoded parts. The raw byte stream is
    // never used: its binary JPEG snapshot decodes to NUL bytes, which jsonb
    // rejects (SQLSTATE 22P05) and which would fail the whole ingest.
    let rawPayload: unknown;
    if (Buffer.isBuffer(req.body)) {
      const multipart = parseMultipartBody(req.body, contentType);
      body = multipart ? multipart.fields : {};
      rawPayload = multipart ? multipart.raw : null;
    }
    const credentials: WebhookCredentials = {
      headerSerial: null,
      headerKey: null,
      querySerial: typeof req.query.serial === 'string' ? req.query.serial : null,
      queryKey: typeof req.query.key === 'string' ? req.query.key : null,
    };
    const result = await ingestDeviceEvent({
      credentials,
      contentType,
      body,
      rawText,
      rawPayload,
      headers: req.headers as unknown as HeaderMap,
      ip: req.ip ?? req.socket.remoteAddress ?? '',
    });
    // The ISAPI listening host treats any status other than 200 as a failed
    // delivery and re-posts the event; the old 202 produced a ~1.3s retry
    // storm. statusCode 1 (OK) is included for firmwares that parse the body.
    res.status(200).json({
      statusCode: 1,
      statusString: 'OK',
      subStatusCode: 'ok',
      received: true,
      eventId: result.rawEventId,
      status: result.status,
      duplicateOf: result.duplicateOfRawEventId ?? undefined,
    });
  })
);

/**
 * Opaque error filter for the device-facing surface. Body-parser syntax
 * errors and ApiErrors are mapped to generic responses; no parser internals,
 * stack traces or schema details ever reach a terminal.
 */
export function hikvisionWebhookErrorFilter(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith('/events')) {
    next(err);
    return;
  }
  const syntax = err as { type?: string; status?: number; message?: string };
  // A body that exceeds the parser limit must not surface as a 500: the
  // terminal reads 5xx as "retry" and floods the endpoint.
  if (syntax?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' } });
    return;
  }
  const parseFailure =
    syntax?.type === 'entity.parse.failed' ||
    syntax?.type === 'encoding.unsupported' ||
    syntax?.type === 'request.aborted' ||
    (err instanceof SyntaxError && typeof syntax?.message === 'string' && syntax.message.includes('JSON'));
  if (err instanceof ApiError && (err.status === 401 || err.status === 400)) {
    res
      .status(err.status)
      .json({ error: { code: err.status === 401 ? 'UNAUTHORIZED' : 'BAD_REQUEST', message: err.status === 401 ? 'Unauthorized' : 'Invalid event payload' } });
    return;
  }
  if (parseFailure) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid event payload' } });
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  console.error(`[hikvision][webhook] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Service unavailable' } });
}
