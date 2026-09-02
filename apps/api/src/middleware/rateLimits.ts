import { rateLimit } from 'express-rate-limit';
import type { Request } from 'express';
import { config } from '../config.js';

/**
 * Route-level rate limiting for high-risk endpoints.
 *
 * Keying model:
 *  - 'identifier' limits per account-identifier + IP (pre-login brute force).
 *  - 'auth' limits per authenticated user + IP (post-login abuse).
 *  - 'ip' limits per source IP only (token-gated flows such as MFA).
 *
 * These limits complement the global /api limiter in app.ts.
 */

type KeySource = 'auth' | 'identifier' | 'ip';

function buildKey(req: Request, source: KeySource): string {
  const ip = req.ctx?.ip || req.ip || '0.0.0.0';
  if (source === 'auth') {
    const uid = req.auth?.id;
    return uid ? `u${uid}:${ip}` : `anon:${ip}`;
  }
  if (source === 'identifier') {
    const identifier = String((req.body as Record<string, unknown> | undefined)?.identifier ?? '')
      .trim()
      .toLowerCase();
    return identifier ? `${identifier}:${ip}` : `anon:${ip}`;
  }
  return ip;
}

interface LimiterOptions {
  windowMs: number;
  limit: number;
  keySource?: KeySource;
  message?: string;
}

export function makeRateLimiter(opts: LimiterOptions) {
  // Test suites exercise hundreds of requests per minute in-process. Keep the
  // rate-limit code path active but raise the ceiling so CI is not throttled;
  // production/development limits stay at the configured values.
  const limit = config.env === 'test' ? 1_000_000 : opts.limit;
  return rateLimit({
    windowMs: opts.windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => buildKey(req, opts.keySource ?? 'auth'),
    handler: (_req: Request, res) => {
      res.status(429).json({ error: opts.message ?? 'Too many requests. Please try again later.' });
    },
  });
}

/** Credential + MFA + enrollment attempt limits (per account identifier + IP). */
export const loginLimiter = makeRateLimiter({
  windowMs: 60_000,
  limit: 10,
  keySource: 'identifier',
  message: 'Too many login attempts. Please wait a minute and try again.',
});

/** MFA challenge endpoints are token-gated; limit per IP. */
export const mfaLimiter = makeRateLimiter({
  windowMs: 60_000,
  limit: 15,
  keySource: 'ip',
  message: 'Too many MFA attempts. Please try again later.',
});

/** Invite acceptance is a privileged account-creation flow. */
export const inviteLimiter = makeRateLimiter({
  windowMs: 60_000,
  limit: 5,
  keySource: 'identifier',
  message: 'Too many invite attempts. Please try again later.',
});

/** Search abuse / mass enumeration guard (per authenticated user + IP). */
export const searchLimiter = makeRateLimiter({
  windowMs: 60_000,
  limit: 30,
  message: 'Search rate limit exceeded. Please slow down.',
});

/** Bulk export + import guard (per authenticated user + IP). */
export const exportLimiter = makeRateLimiter({
  windowMs: 3_600_000,
  limit: 10,
  message: 'Export/import rate limit exceeded. You may run 10 operations per hour.',
});

/** QR scanning guard (per authenticated user + IP). */
export const qrScanLimiter = makeRateLimiter({
  windowMs: 60_000,
  limit: 30,
  message: 'QR scan rate limit exceeded. Please slow down.',
});

/** Messaging / notification guard (per authenticated user + IP). */
export const messagingLimiter = makeRateLimiter({
  windowMs: 60_000,
  limit: 20,
  message: 'Message rate limit exceeded. Please slow down.',
});

