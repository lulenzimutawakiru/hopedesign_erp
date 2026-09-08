import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/** SHA-256 hex digest (used to store device auth keys at rest). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/** Constant-time comparison for two hex strings. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(String(a ?? ''), 'hex');
  const bb = Buffer.from(String(b ?? ''), 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/** HMAC-SHA256 signature over a raw body (hex). */
export function hmacHex(secret: string, body: string): string {
  return createHmac('sha256', String(secret ?? '')).update(String(body ?? ''), 'utf8').digest('hex');
}

/** Random device auth key (returned once at registration). */
export function generateDeviceKey(): string {
  return randomBytes(24).toString('hex');
}

/** Clean an incoming IP: strip IPv4-mapped IPv6 prefixes and whitespace. */
export function normalizeIp(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const cleaned = s.replace(/^::ffff:/i, '');
  const parts = cleaned.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  return parts.length > 0 ? parts[0] : '';
}