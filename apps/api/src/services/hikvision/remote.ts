/**
 * Outbound ISAPI transport helpers for Hikvision DS-K1T administration.
 *
 * Device ISAPI credentials (username + password) are stored encrypted at rest
 * (AES-256-GCM) using an app-level domain-separated secret; the plaintext is
 * only ever decrypted in-memory for a single outbound device command. The
 * command transport performs real HTTP calls against the terminal with Basic
 * auth first and an RFC-7616 Digest fallback. When a terminal is unreachable
 * or not configured for remote commands, callers surface a FAILED/SKIPPED
 * result in hikvision_sync_logs - never a silent success.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, createHmac } from 'node:crypto';
import { config } from '../../config.js';

const SECRET = createHash('sha256')
  .update(`hikvision.device.secret.v1:${config.docSigningSecret}`)
  .digest();

const utf8 = (s: string): Buffer => Buffer.from(String(s), 'utf8');

/** Encrypt a device ISAPI password for storage (returns null when empty). */
export function encryptDeviceSecret(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || String(plain).trim() === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** Decrypt a device ISAPI password stored by encryptDeviceSecret. */
export function decryptDeviceSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', SECRET, Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

interface DigestParts {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

/** Parse an RFC 7616 WWW-Authenticate Digest challenge header. */
export function parseDigestChallenge(header: string): DigestParts | null {
  const out: DigestParts = { realm: '', nonce: '' };
  if (!/digest/i.test(header)) return null;
  for (const m of header.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) {
    const [, key, q, bare] = m;
    const val = q ?? bare ?? '';
    if (key.toLowerCase() === 'realm') out.realm = val;
    else if (key.toLowerCase() === 'nonce') out.nonce = val;
    else if (key.toLowerCase() === 'qop') out.qop = val;
    else if (key.toLowerCase() === 'opaque') out.opaque = val;
    else if (key.toLowerCase() === 'algorithm') out.algorithm = val;
  }
  return out.realm && out.nonce ? out : null;
}

function md5hex(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

/** Build the Authorization header for a digest challenge. */
export function digestAuthorization(user: string, pass: string, method: string, uri: string, d: DigestParts): string {
  const cnonce = randomBytes(12).toString('hex');
  const nc = '00000001';
  const ha1 = md5hex(`${user}:${d.realm}:${pass}`);
  const ha2 = md5hex(`${method}:${uri}`);
  const qop = (d.qop ?? '').split(',').map((x) => x.trim()).find((x) => x === 'auth') ? 'auth' : undefined;
  const response = qop
    ? md5hex(`${ha1}:${d.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5hex(`${ha1}:${d.nonce}:${ha2}`);
  const parts = [
    `username="${user}"`,
    `realm="${d.realm}"`,
    `nonce="${d.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${d.algorithm ?? 'MD5'}`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (d.opaque) parts.push(`opaque="${d.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

const BASIC_RE = /^basic\s/i;

export interface RemoteResult {
  ok: boolean;
  status: number;
  message: string;
}

function toMessage(body: string, status: number): string {
  const t = body.slice(0, 160).replace(/\s+/g, ' ').trim();
  if (status >= 200 && status < 300) return 'Command accepted by device';
  if (status === 401 || status === 403) return 'Device rejected credentials (HTTP ' + status + ')';
  if (t) return `Device responded HTTP ${status}: ${t}`;
  return `Device responded HTTP ${status}`;
}

/**
 * Perform an authenticated ISAPI request against a terminal using Basic auth,
 * falling back to Digest when the device challenges with it.
 */
export async function isapiRequest(
  ip: string,
  user: string,
  pass: string,
  method: 'GET' | 'PUT',
  path: string,
  bodyText?: string
): Promise<RemoteResult> {
  const uri = `http://${ip}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  const basic = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const attempt = async (authorization?: string): Promise<RemoteResult> => {
    const res = await fetch(uri, {
      method,
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(bodyText !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: bodyText,
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.status >= 200 && res.status < 300, status: res.status, message: toMessage(text, res.status) };
  };
  try {
    let result = await attempt();
    if (result.status === 401) {
      // Negotiate from the device's WWW-Authenticate challenge: prefer Digest,
      // fall back to Basic only when the device explicitly offers it.
      const header = await fetch(uri, { method, signal: controller.signal })
        .then((r) => r.headers.get('www-authenticate') ?? '')
        .catch(() => '');
      const digest = parseDigestChallenge(header);
      if (digest) {
        result = await attempt(digestAuthorization(user, pass, method, path, digest));
      } else if (BASIC_RE.test(header)) {
        result = await attempt(basic);
      }
    }
    return result;
  } catch {
    return { ok: false, status: 0, message: 'Device unreachable (connection failed or timed out)' };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe a terminal for reachability/credentials (GET /ISAPI/System/status). */
export async function probeDevice(ip: string, user: string | null, pass: string | null): Promise<RemoteResult> {
  if (!ip || !user || !pass) {
    return { ok: false, status: 0, message: 'Device not configured for remote commands (ISAPI credentials missing)' };
  }
  return isapiRequest(ip, user, pass, 'GET', '/ISAPI/System/status');
}

/** Push server time to a terminal (PUT /ISAPI/System/time). */
export async function syncDeviceClockRemote(
  ip: string,
  user: string | null,
  pass: string | null,
  deviceTimezone: string
): Promise<RemoteResult> {
  if (!ip || !user || !pass) {
    return { ok: false, status: 0, message: 'Device not configured for remote commands (ISAPI credentials missing)' };
  }
  const now = new Date();
  const tz = deviceTimezone && deviceTimezone.length <= 64 ? deviceTimezone : 'UTC';
  const body = JSON.stringify({ time: { time: now.toISOString(), timeZone: tz } });
  return isapiRequest(ip, user, pass, 'PUT', '/ISAPI/System/time', body);
}