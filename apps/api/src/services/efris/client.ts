/**
 * Real HTTP(S) client for the URA EFRIS gateway.
 *
 * The exact URA payload contract is still version-specific, so nothing here
 * hardcodes an undocumented request body. Everything is driven by the active
 * efris_configurations row (base_url / token_url / auth_grant_type) plus the
 * environment-resolved credentials. A transaction can ONLY ever be marked
 * FISCALIZED when this client returns a confirmed fiscal identifier set
 * (FDN + verification code); there is no simulated success path anywhere.
 */
import type { EfrisMode } from './config.js';

export class EfrisClientError extends Error {
  readonly code: string;
  readonly stage: 'config' | 'auth' | 'submit' | 'response';
  readonly status: number | null;
  readonly payload: unknown;
  readonly retryable: boolean;

  constructor(opts: {
    code: string;
    stage: EfrisClientError['stage'];
    message: string;
    status?: number | null;
    payload?: unknown;
    retryable?: boolean;
  }) {
    super(opts.message);
    this.name = 'EfrisClientError';
    this.code = opts.code;
    this.stage = opts.stage;
    this.status = opts.status ?? null;
    this.payload = opts.payload ?? null;
    this.retryable = opts.retryable ?? true;
  }
}

export interface SubmitFiscalOptions {
  mode: EfrisMode;
  baseUrl: string;
  tokenUrl?: string | null;
  grantType: string;
  clientId?: string;
  clientSecret?: string;
  timeoutSeconds: number;
  payload: Record<string, unknown>;
}

export interface FiscalIdentifiers {
  fdn: string;
  vrc: string;
  qrRef?: string | null;
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, Math.ceil(ms * 1000)));
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** POST form-encoded OAuth client-credentials token request. */
async function requestAccessToken(opts: SubmitFiscalOptions): Promise<string> {
  if (!opts.tokenUrl) {
    throw new EfrisClientError({
      code: 'EFRIS_TOKEN_URL_MISSING',
      stage: 'auth',
      message: 'EFRIS token_url is not configured for this integration',
      retryable: false,
    });
  }
  if (!opts.clientId || !opts.clientSecret) {
    throw new EfrisClientError({
      code: 'EFRIS_CREDENTIALS_MISSING',
      stage: 'auth',
      message: 'EFRIS integration credentials are not set on the server',
      retryable: false,
    });
  }
  const form = new URLSearchParams({
    grant_type: opts.grantType || 'client_credentials',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  return withTimeout(opts.timeoutSeconds, async (signal) => {
    let res: Response;
    try {
      res = await fetch(opts.tokenUrl as string, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form.toString(),
        signal,
      });
    } catch (err) {
      throw new EfrisClientError({
        code: 'EFRIS_TOKEN_NETWORK',
        stage: 'auth',
        message: `EFRIS token request failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      throw new EfrisClientError({
        code: 'EFRIS_TOKEN_HTTP',
        stage: 'auth',
        message: `EFRIS token endpoint returned ${res.status}`,
        status: res.status,
        payload: data,
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    const token = data && typeof data.access_token === 'string' ? data.access_token : undefined;
    if (!token) {
      throw new EfrisClientError({
        code: 'EFRIS_TOKEN_INVALID',
        stage: 'auth',
        message: 'EFRIS token response did not include an access_token',
        status: res.status,
        payload: data,
        retryable: false,
      });
    }
    return token;
  });
}

/** Walk nested objects/arrays returning the first value matching one of the keys. */
function digFirst(value: unknown, keys: string[], depth = 0): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return undefined;
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = digFirst(item, keys, depth + 1);
      if (hit !== undefined && hit !== null) return hit;
    }
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const norm = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (keys.some((k) => k.toLowerCase() === norm)) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim().length > 0) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
  }
  for (const key of Object.keys(obj)) {
    const hit = digFirst(obj[key], keys, depth + 1);
    if (hit !== undefined && hit !== null) return hit;
  }
  return undefined;
}

/** Pull the fiscal identifiers out of a confirmed URA response. */
export function extractFiscalIdentifiers(raw: unknown): FiscalIdentifiers | null {
  const fdnRaw = digFirst(raw, ['fdn', 'fiscalDocumentNumber', 'fiscal_document_number']);
  const vrcRaw = digFirst(raw, ['vrc', 'verificationCode', 'verification_code', 'verifyCode', 'verify_code']);
  if (typeof fdnRaw !== 'string' || fdnRaw.trim().length === 0) return null;
  if (typeof vrcRaw !== 'string' || vrcRaw.trim().length === 0) return null;
  const qrRaw = digFirst(raw, ['qrUrl', 'qr_url', 'qrCode', 'qr_code', 'qrRef', 'qr_ref', 'fiscalQr', 'fiscal_qr']);
  return {
    fdn: fdnRaw.trim(),
    vrc: vrcRaw.trim(),
    qrRef: typeof qrRaw === 'string' && qrRaw.trim().length > 0 ? qrRaw.trim() : null,
  };
}

/** Detect an explicit business-level failure in a URA-style envelope. */
function businessFailure(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const envelope = raw as Record<string, unknown>;
  const state = envelope.returnStateInfo as Record<string, unknown> | undefined;
  if (!state || typeof state !== 'object') return null;
  const codeRaw = state.returnCode ?? state.return_code ?? state.code;
  const msgRaw = state.returnMessage ?? state.return_message ?? state.message;
  const code = typeof codeRaw === 'string' || typeof codeRaw === 'number' ? String(codeRaw).trim() : '';
  const msg = typeof msgRaw === 'string' ? msgRaw.trim() : '';
  const successCodes = new Set(['0', '000', '0000', '00', 'SUCCESS', 'SUCCESSFUL']);
  if (code.length > 0 && !successCodes.has(code.toUpperCase())) {
    return msg.length > 0 ? `${code}: ${msg}` : `URA return code ${code}`;
  }
  return null;
}

/**
 * Submit a fiscal document to URA. Returns the parsed JSON body on HTTP 2xx
 * success; the caller then validates the fiscal identifiers before any status
 * transition. Throws EfrisClientError for auth/transport/validation failures.
 */
export async function submitFiscalDocument(opts: SubmitFiscalOptions): Promise<unknown> {
  if (!opts.baseUrl.trim()) {
    throw new EfrisClientError({
      code: 'EFRIS_BASE_URL_MISSING',
      stage: 'config',
      message: 'EFRIS base_url is not configured for this integration',
      retryable: false,
    });
  }
  // OAuth2 client-credentials is only used when token_url is configured. A
  // gateway that accepts direct submission (token_url empty) is supported too.
  const token = opts.tokenUrl ? await requestAccessToken(opts) : undefined;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return withTimeout(opts.timeoutSeconds, async (signal) => {
    let res: Response;
    try {
      res = await fetch(opts.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(opts.payload),
        signal,
      });
    } catch (err) {
      throw new EfrisClientError({
        code: 'EFRIS_SUBMIT_NETWORK',
        stage: 'submit',
        message: `EFRIS submit request failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      throw new EfrisClientError({
        code: 'EFRIS_SUBMIT_HTTP',
        stage: 'submit',
        message: `EFRIS gateway returned HTTP ${res.status}`,
        status: res.status,
        payload: data,
        retryable: res.status === 408 || res.status === 409 || res.status === 425 || res.status === 429 || res.status >= 500,
      });
    }
    const failure = businessFailure(data);
    if (failure) {
      const retryable = !/invalid|reject|unauthor|forbidden|not.?found|duplicate|already.?exist|no.?right/i.test(failure);
      throw new EfrisClientError({
        code: 'EFRIS_BIZ_REJECT',
        stage: 'response',
        message: `URA EFRIS rejected the submission: ${failure.slice(0, 1000)}`,
        payload: data,
        retryable,
      });
    }
    return data;
  });
}