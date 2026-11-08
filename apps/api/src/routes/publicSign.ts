import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { asyncHandler, badRequest, notFound } from '../utils.js';
import {
  publicMarkViewed,
  publicRefuseSign,
  publicSignFile,
  publicSignSession,
  publicSubmitSign,
} from '../services/signRequests.js';

/**
 * Public, unauthenticated e-signature portal.
 * A signer is identified solely by the unguessable signing token in the URL.
 * The token's SHA-256 digest is matched against the stored hash inside
 * SECURITY DEFINER functions, so no session is ever established and no PII is
 * readable without the token. Every write is validated server-side (status,
 * expiry, signature order) and is idempotent per signer.
 */
export const publicSignRouter = Router();

const TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/;

const hashToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex');

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many signing page requests. Try again later.' },
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many signing attempts. Try again later.' },
});

const tokenFrom = (req: Request): string => {
  const raw = String(req.params.token ?? '');
  if (!TOKEN_RE.test(raw)) throw badRequest('Invalid signing link');
  return hashToken(raw);
};

publicSignRouter.get(
  '/:token',
  readLimiter,
  asyncHandler(async (req, res) => {
    const tokenHash = tokenFrom(req);
    const session = await publicSignSession(tokenHash);
    if (!session) throw notFound('This signing link is invalid or has been revoked');
    // Record the first open of the page (idempotent). Runs outside any auth
    // context; the function resolves by token hash only.
    await publicMarkViewed(tokenHash);
    const fresh = await publicSignSession(tokenHash);
    res.json({ data: fresh ?? session });
  })
);

publicSignRouter.get(
  '/:token/file',
  readLimiter,
  asyncHandler(async (req, res) => {
    const tokenHash = tokenFrom(req);
    const file = await publicSignFile(tokenHash);
    if (!file) throw notFound('The document is not available');
    res.set('Content-Type', file.mimeType);
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    createReadStream(file.abs).pipe(res);
  })
);

publicSignRouter.post(
  '/:token/submit',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const tokenHash = tokenFrom(req);
    const result = await publicSubmitSign(
      tokenHash,
      req.body ?? {},
      req.ctx.ip,
      req.ctx.userAgent,
      req.ctx.device
    );
    res.json({ data: result });
  })
);

publicSignRouter.post(
  '/:token/refuse',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const tokenHash = tokenFrom(req);
    const reason = req.body?.reason != null && String(req.body.reason).trim().length > 0
      ? String(req.body.reason)
      : null;
    const result = await publicRefuseSign(tokenHash, reason, req.ctx.ip, req.ctx.userAgent, req.ctx.device);
    res.json({ data: result });
  })
);
