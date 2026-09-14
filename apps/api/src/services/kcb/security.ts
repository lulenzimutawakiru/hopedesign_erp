/**
 * KCB inbound notification security primitives.
 *
 * The notification endpoints are unauthenticated by nature - KCB is the caller
 * - so the RSA signature IS the authentication. KCB signs the raw request body
 * with its private key (SHA256withRSA) and puts the base64 signature in the
 * `Signature` header; we verify it with KCB's public key.
 *
 * Everything here fails closed: a missing key, an unparsable key, a missing
 * header or any crypto error is a verification failure, never a pass.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

/** Trim a key/header value; blank values become null. */
export function cleanKey(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s.length === 0 ? null : s;
}

/** Clean an incoming IP: strip IPv4-mapped IPv6 prefixes and proxy lists. */
export function normalizeIp(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const cleaned = s.replace(/^::ffff:/i, '');
  const parts = cleaned.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  return parts.length > 0 ? parts[0] : '';
}

/**
 * True when the value parses as an RSA public key. Used as a configuration
 * gate: an integration whose key cannot be parsed is not "configured", and an
 * integration that is not configured can never accept a notification.
 */
export function isUsablePublicKey(pem: string | null | undefined): boolean {
  const value = cleanKey(pem);
  if (!value) return false;
  try {
    createPublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Short, stable fingerprint of a public key (SHA-256 of its DER form). Safe to
 * show an administrator: it identifies which key is loaded without copying the
 * whole PEM into a screen or a log.
 */
export function publicKeyFingerprint(pem: string | null | undefined): string | null {
  const value = cleanKey(pem);
  if (!value) return null;
  try {
    const der = createPublicKey(value).export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('hex').slice(0, 32).toUpperCase();
  } catch {
    return null;
  }
}

/**
 * Verify the `Signature` header against the exact bytes KCB sent.
 *
 * The raw body - not a re-serialised copy of the parsed object - is the signed
 * artefact: a JSON.parse/JSON.stringify round trip reorders and reformats, and
 * every signature would silently fail against it.
 */
export function verifySignature(opts: {
  rawBody?: Buffer | string | null;
  signature?: string | null;
  publicKeyPem?: string | null;
}): boolean {
  const signature = cleanKey(opts.signature);
  const pem = cleanKey(opts.publicKeyPem);
  if (!signature || !pem || opts.rawBody == null) return false;
  const body = Buffer.isBuffer(opts.rawBody) ? opts.rawBody : Buffer.from(String(opts.rawBody), 'utf8');
  if (body.length === 0) return false;
  let sig: Buffer;
  try {
    sig = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  if (sig.length === 0) return false;
  try {
    return cryptoVerify('sha256', body, createPublicKey(pem), sig) === true;
  } catch {
    return false;
  }
}
