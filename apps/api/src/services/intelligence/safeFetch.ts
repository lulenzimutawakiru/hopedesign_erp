import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { LookupFunction } from 'node:net';
import type { SafeFetchResult } from './types.js';

/**
 * SSRF-guarded HTTP GET for business-website intelligence.
 *
 * Defences, in order:
 *  - scheme must be http/https and the port must be an allowed web port;
 *  - the hostname is resolved and every address is checked against private /
 *    loopback / link-local / reserved ranges — a host that resolves only to a
 *    non-public address is refused (DNS-rebinding safe: the connection uses the
 *    validated address via a custom `lookup`, while Host/SNI keep the real name);
 *  - redirects are refused rather than followed (open-redirect + SSRF chaining
 *    is closed by construction);
 *  - the response body is capped at a byte limit and the request has a timeout.
 *
 * Extracted content is untrusted data — callers must never treat it as
 * instructions and must not echo it into prompts un-delimited.
 */

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

function isIpv4(ip: string): boolean {
  return ip.includes('.');
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

/** True when the IPv4 address is private, loopback, link-local, CGNAT,
 *  multicast, reserved or otherwise not globally routable. */
export function isPrivateIpv4(ip: string): boolean {
  const p = ipv4Parts(ip);
  if (!p) return true; // unparseable -> refuse
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** True when the IPv6 address is loopback, unspecified, link-local, ULA or
 *  multicast. IPv4-mapped IPv6 addresses are delegated to the IPv4 check. */
export function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = lower.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

/** True when the address string (v4 or v6) is non-public. */
export function isPrivateIp(ip: string): boolean {
  return isIpv4(ip) ? isPrivateIpv4(ip) : isPrivateIpv6(ip);
}

export type UrlValidation =
  | { ok: true; url: URL }
  | { ok: false; error: string };

/** Parse and gate a URL for fetching. Only public web URLs are permitted. */
export function validateUrl(raw: string): UrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'INVALID_URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'UNSUPPORTED_SCHEME' };
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) return { ok: false, error: 'BLOCKED_PORT' };
  return { ok: true, url };
}

const safeLookup: LookupFunction = (hostname, _options, callback) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    const public_ = addresses.filter((a) => !isPrivateIp(a.address));
    if (public_.length === 0) {
      callback(new Error(`SSRF_BLOCKED: ${hostname}`), '', 0);
      return;
    }
    callback(null, public_[0].address, public_[0].family);
  });
};

interface FetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

interface RawResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string | null;
  text: string;
  sizeBytes: number;
}

function requestOnce(url: URL, options: Required<FetchOptions>): Promise<RawResult> {
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  return new Promise<RawResult>((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8',
          'User-Agent': 'NatexIntelligence/1.0 (+website intelligence)',
        },
        lookup: safeLookup,
        timeout: options.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '');
        const chunks: Buffer[] = [];
        let size = 0;
        let aborted = false;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            aborted = true;
            req.destroy(new Error('SIZE_EXCEEDED'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          resolve({
            ok: status >= 200 && status < 400,
            status,
            finalUrl: url.toString(),
            contentType,
            text: Buffer.concat(chunks).toString('utf8'),
            sizeBytes: size,
          });
        });
        res.on('error', (err) => reject(err));
      }
    );
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/** Fetch a URL under the SSRF + size + timeout policy. Redirects are refused. */
export async function safeFetch(rawUrl: string, options: FetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const opts: Required<FetchOptions> = { maxBytes, timeoutMs };

  const validation = validateUrl(rawUrl);
  if (!validation.ok) return { ok: false, error: validation.error };

  let result: RawResult;
  try {
    result = await requestOnce(validation.url, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  if (result.status >= 300 && result.status < 400) {
    return { ok: false, error: 'REDIRECT', status: result.status, finalUrl: result.finalUrl };
  }

  return {
    ok: result.ok,
    status: result.status,
    finalUrl: result.finalUrl,
    contentType: result.contentType,
    text: result.text,
    sizeBytes: result.sizeBytes,
  };
}
