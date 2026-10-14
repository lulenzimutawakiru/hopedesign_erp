/**
 * HTTP client for URA EFRIS.
 *
 * Two transports share one rule: a transaction is fiscalized only when the
 * response carries an FDN and a verification code.
 *
 *   * URA system-to-system (no token URL). TEST calls the sandbox, ACTIVE
 *     calls the live gateway. The body is a signed T109 envelope.
 *   * OAuth client-credentials (token URL set). The same host rule applies,
 *     and the body is the canonical JSON payload for a gateway that is not
 *     the native URA envelope.
 */
import type { EfrisMode } from './config.js';
import {
  assertUrlMatchesMode,
  buildEncryptedEnvelope,
  buildUnencryptedEnvelope,
  canonicalizeEndpoint,
  digFirst,
  EfrisProtocolError,
  extractAesKey,
  interfaceCodeFor,
  isSuccessCode,
  looksLikePrivateKey,
  normalizePrivateKey,
  readReturnState,
  resolveDeviceNo,
  resolveModeEndpoint,
  unwrapResponse,
  type UraGlobalOptions,
} from './protocol.js';

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
  /** Inner URA content. Used by the system-to-system transport. */
  uraPayload?: Record<string, unknown>;
  docType?: string;
  tin?: string | null;
  securityFlags?: Record<string, unknown> | null;
}

export interface FiscalIdentifiers {
  fdn: string;
  vrc: string;
  qrRef?: string | null;
}

export interface EfrisProbeResult {
  ok: true;
  mode: 'TEST' | 'ACTIVE';
  host: string;
  interfaceCode: string;
  returnCode: string;
  message: string;
  serverTime: string | null;
}

function protocolError(err: unknown, stage: EfrisClientError['stage']): EfrisClientError | null {
  if (!(err instanceof EfrisProtocolError)) return null;
  return new EfrisClientError({
    code: err.code,
    stage,
    message: err.message,
    retryable: false,
  });
}

async function withTimeout<T>(seconds: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, Math.ceil(seconds * 1000)));
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

function assertLiveMode(mode: EfrisMode): asserts mode is 'TEST' | 'ACTIVE' {
  if (mode !== 'TEST' && mode !== 'ACTIVE') {
    throw new EfrisClientError({
      code: 'EFRIS_MODE_DISABLED',
      stage: 'config',
      message: 'EFRIS mode is DISABLED, so nothing is sent to URA',
      retryable: false,
    });
  }
}

function flagsOf(opts: SubmitFiscalOptions): Record<string, unknown> {
  return opts.securityFlags && typeof opts.securityFlags === 'object' ? opts.securityFlags : {};
}

export function usesOauthGateway(opts: Pick<SubmitFiscalOptions, 'tokenUrl' | 'securityFlags'>): boolean {
  const protocol = flagsOf(opts as SubmitFiscalOptions).protocol;
  if (protocol === 'ura_s2s' || protocol === 'URA_S2S') return false;
  if (protocol === 'oauth' || protocol === 'OAUTH') return true;
  return Boolean(opts.tokenUrl && opts.tokenUrl.trim());
}

function checkHost(mode: 'TEST' | 'ACTIVE', url: string, flags: Record<string, unknown>): void {
  try {
    assertUrlMatchesMode(mode, canonicalizeEndpoint(url), flags);
  } catch (err) {
    const wrapped = protocolError(err, 'config');
    if (wrapped) throw wrapped;
    throw err;
  }
}

async function postJson(
  url: string,
  body: unknown,
  timeoutSeconds: number,
  stage: 'auth' | 'submit',
  headers: Record<string, string>
): Promise<{ status: number; data: unknown }> {
  return withTimeout(timeoutSeconds, async (signal) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new EfrisClientError({
        code: stage === 'auth' ? 'EFRIS_TOKEN_NETWORK' : 'EFRIS_SUBMIT_NETWORK',
        stage,
        message: `EFRIS ${stage === 'auth' ? 'token' : 'submit'} request failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const data = (await res.json().catch(() => null)) as unknown;
    return { status: res.status, data };
  });
}

/** POST form-encoded OAuth client-credentials token request. */
async function requestAccessToken(opts: SubmitFiscalOptions, tokenUrl: string): Promise<string> {
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
      res = await fetch(tokenUrl, {
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

/** Pull the fiscal identifiers out of a confirmed URA response. */
export function extractFiscalIdentifiers(raw: unknown): FiscalIdentifiers | null {
  const fdnRaw = digFirst(raw, ['fdn', 'fiscalDocumentNumber', 'fiscal_document_number', 'invoiceNo', 'antifakeInvoiceNo']);
  const vrcRaw = digFirst(raw, ['vrc', 'verificationCode', 'verification_code', 'verifyCode', 'verify_code', 'antifakeCode', 'antiFakeCode']);
  if (typeof fdnRaw !== 'string' || fdnRaw.trim().length === 0) return null;
  if (typeof vrcRaw !== 'string' || vrcRaw.trim().length === 0) return null;
  const qrRaw = digFirst(raw, ['qrUrl', 'qr_url', 'qrCode', 'qr_code', 'qrRef', 'qr_ref', 'fiscalQr', 'fiscal_qr']);
  return {
    fdn: fdnRaw.trim(),
    vrc: vrcRaw.trim(),
    qrRef: typeof qrRaw === 'string' && qrRaw.trim().length > 0 ? qrRaw.trim() : null,
  };
}

function rejectBusinessFailure(raw: unknown): void {
  const state = readReturnState(raw);
  if (!state || isSuccessCode(state.code)) return;
  const failure = state.message.length > 0 ? `${state.code}: ${state.message}` : `URA return code ${state.code}`;
  const retryable = !/invalid|reject|unauthor|forbidden|not.?found|duplicate|already.?exist|no.?right/i.test(failure);
  throw new EfrisClientError({
    code: 'EFRIS_BIZ_REJECT',
    stage: 'response',
    message: `URA EFRIS rejected the submission: ${failure.slice(0, 1000)}`,
    payload: raw,
    retryable,
  });
}

function s2sIdentity(opts: SubmitFiscalOptions): { tin: string; deviceNo: string; privateKey: string; flags: Record<string, unknown> } {
  const flags = flagsOf(opts);
  const tin = (opts.tin ?? '').trim();
  if (!tin) {
    throw new EfrisClientError({
      code: 'EFRIS_TIN_MISSING',
      stage: 'config',
      message: 'EFRIS taxpayer TIN is required before a document can be sent to URA',
      retryable: false,
    });
  }
  const deviceNo = resolveDeviceNo(flags, opts.clientId);
  if (!deviceNo) {
    throw new EfrisClientError({
      code: 'EFRIS_DEVICE_MISSING',
      stage: 'config',
      message: 'EFRIS device number is not set. Put it in security flags as deviceNo, or in the client-id environment value.',
      retryable: false,
    });
  }
  if (!looksLikePrivateKey(opts.clientSecret)) {
    throw new EfrisClientError({
      code: 'EFRIS_PRIVATE_KEY_MISSING',
      stage: 'config',
      message: 'EFRIS device private key is not set on the server. The credentials environment value must be a PEM private key.',
      retryable: false,
    });
  }
  return { tin, deviceNo, privateKey: normalizePrivateKey(opts.clientSecret as string), flags };
}

async function postUraEnvelope(
  endpoint: string,
  envelope: Record<string, unknown>,
  timeoutSeconds: number
): Promise<unknown> {
  const res = await postJson(endpoint, envelope, timeoutSeconds, 'submit', {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });
  if (res.status < 200 || res.status >= 300) {
    throw new EfrisClientError({
      code: 'EFRIS_SUBMIT_HTTP',
      stage: 'submit',
      message: `EFRIS gateway returned HTTP ${res.status}`,
      status: res.status,
      payload: res.data,
      retryable: res.status === 408 || res.status === 409 || res.status === 425 || res.status === 429 || res.status >= 500,
    });
  }
  rejectBusinessFailure(res.data);
  return res.data;
}

async function fetchAesKey(opts: SubmitFiscalOptions, endpoint: string, global: UraGlobalOptions): Promise<string> {
  const envelope = buildUnencryptedEnvelope(null, { ...global, interfaceCode: 'T104' }, opts.clientSecret);
  const raw = await postUraEnvelope(endpoint, envelope, opts.timeoutSeconds);
  let unwrapped: unknown;
  try {
    unwrapped = unwrapResponse(raw);
  } catch (err) {
    const wrapped = protocolError(err, 'response');
    if (wrapped) throw wrapped;
    throw err;
  }
  rejectBusinessFailure(unwrapped);
  const key = extractAesKey(unwrapped);
  if (!key) {
    throw new EfrisClientError({
      code: 'EFRIS_AES_KEY_MISSING',
      stage: 'auth',
      message: 'URA did not return a symmetric key (T104)',
      payload: unwrapped,
      retryable: true,
    });
  }
  return key;
}

async function submitUra(opts: SubmitFiscalOptions, endpoint: string): Promise<unknown> {
  const identity = s2sIdentity(opts);
  const interfaceCode = interfaceCodeFor(opts.docType ?? 'SALES_INVOICE', identity.flags);
  const global: UraGlobalOptions = {
    interfaceCode,
    tin: identity.tin,
    deviceNo: identity.deviceNo,
    flags: identity.flags,
  };
  const aesKey = await fetchAesKey(opts, endpoint, global);
  let envelope: Record<string, unknown>;
  try {
    envelope = buildEncryptedEnvelope(opts.uraPayload ?? opts.payload, aesKey, global, identity.privateKey);
  } catch (err) {
    const wrapped = protocolError(err, 'config');
    if (wrapped) throw wrapped;
    throw err;
  }
  const raw = await postUraEnvelope(endpoint, envelope, opts.timeoutSeconds);
  try {
    const unwrapped = unwrapResponse(raw, aesKey);
    rejectBusinessFailure(unwrapped);
    return unwrapped;
  } catch (err) {
    if (err instanceof EfrisClientError) throw err;
    const wrapped = protocolError(err, 'response');
    if (wrapped) throw wrapped;
    throw err;
  }
}

/**
 * Ask URA for the server time (T101) or, on an OAuth gateway, for a token.
 * Neither call fiscalizes a document. TEST success is what unlocks production.
 */
export async function probeEfrisGateway(opts: SubmitFiscalOptions): Promise<EfrisProbeResult> {
  assertLiveMode(opts.mode);
  const flags = flagsOf(opts);
  if (usesOauthGateway(opts)) {
    const tokenUrl = (opts.tokenUrl ?? '').trim();
    if (!tokenUrl) {
      throw new EfrisClientError({
        code: 'EFRIS_TOKEN_URL_MISSING',
        stage: 'auth',
        message: 'EFRIS token_url is not configured for this integration',
        retryable: false,
      });
    }
    checkHost(opts.mode, tokenUrl, flags);
    if ((opts.baseUrl ?? '').trim()) checkHost(opts.mode, opts.baseUrl, flags);
    await requestAccessToken(opts, canonicalizeEndpoint(tokenUrl));
    return {
      ok: true,
      mode: opts.mode,
      host: new URL(tokenUrl).hostname.toLowerCase(),
      interfaceCode: 'OAUTH',
      returnCode: '00',
      message: 'OAuth token endpoint accepted the client credentials',
      serverTime: null,
    };
  }
  let endpoint: string;
  try {
    endpoint = resolveModeEndpoint(opts.mode, opts.baseUrl, flags);
  } catch (err) {
    const wrapped = protocolError(err, 'config');
    if (wrapped) throw wrapped;
    throw err;
  }
  const identity = s2sIdentity(opts);
  const global: UraGlobalOptions = {
    interfaceCode: 'T101',
    tin: identity.tin,
    deviceNo: identity.deviceNo,
    flags: identity.flags,
  };
  const envelope = buildUnencryptedEnvelope(null, global, identity.privateKey);
  const raw = await postUraEnvelope(endpoint, envelope, opts.timeoutSeconds);
  let unwrapped: unknown = raw;
  try {
    unwrapped = unwrapResponse(raw);
  } catch (err) {
    const wrapped = protocolError(err, 'response');
    if (wrapped) throw wrapped;
    throw err;
  }
  rejectBusinessFailure(unwrapped);
  const state = readReturnState(unwrapped);
  const serverTimeRaw = digFirst(unwrapped, ['serverTime', 'systemTime', 'time']);
  return {
    ok: true,
    mode: opts.mode,
    host: new URL(endpoint).hostname.toLowerCase(),
    interfaceCode: 'T101',
    returnCode: state?.code || '00',
    message: state?.message || 'URA sandbox responded',
    serverTime: typeof serverTimeRaw === 'string' ? serverTimeRaw : null,
  };
}

/**
 * Submit a fiscal document to URA. Returns the parsed body on success; the
 * caller validates the fiscal identifiers before any status transition.
 */
export async function submitFiscalDocument(opts: SubmitFiscalOptions): Promise<unknown> {
  assertLiveMode(opts.mode);
  const flags = flagsOf(opts);
  if (usesOauthGateway(opts)) {
    const baseUrl = (opts.baseUrl ?? '').trim();
    if (!baseUrl) {
      throw new EfrisClientError({
        code: 'EFRIS_BASE_URL_MISSING',
        stage: 'config',
        message: 'EFRIS base_url is not configured for this integration',
        retryable: false,
      });
    }
    checkHost(opts.mode, baseUrl, flags);
    const tokenUrl = (opts.tokenUrl ?? '').trim();
    if (tokenUrl) checkHost(opts.mode, tokenUrl, flags);
    const token = tokenUrl ? await requestAccessToken(opts, canonicalizeEndpoint(tokenUrl)) : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await postJson(canonicalizeEndpoint(baseUrl), opts.payload, opts.timeoutSeconds, 'submit', headers);
    if (res.status < 200 || res.status >= 300) {
      throw new EfrisClientError({
        code: 'EFRIS_SUBMIT_HTTP',
        stage: 'submit',
        message: `EFRIS gateway returned HTTP ${res.status}`,
        status: res.status,
        payload: res.data,
        retryable: res.status === 408 || res.status === 409 || res.status === 425 || res.status === 429 || res.status >= 500,
      });
    }
    rejectBusinessFailure(res.data);
    return res.data;
  }
  let endpoint: string;
  try {
    endpoint = resolveModeEndpoint(opts.mode, opts.baseUrl, flags);
  } catch (err) {
    const wrapped = protocolError(err, 'config');
    if (wrapped) throw wrapped;
    throw err;
  }
  return submitUra(opts, endpoint);
}
