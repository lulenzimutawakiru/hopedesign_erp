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
  digObject,
  EfrisProtocolError,
  extractAesKey,
  interfaceCodeFor,
  isSuccessCode,
  looksLikePrivateKey,
  normalizePrivateKey,
  readReturnState,
  resolveDeviceNo,
  resolveModeEndpoint,
  rsaDecryptBase64,
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

/**
 * Offline-enabler transport. Hope Design's EFRIS device is registered as an
 * "Offline enabler" (the Aisino Tax Control Service), not a direct S2S device.
 * The ERP posts the plaintext `{data, globalInfo, returnStateInfo}` envelope to
 * the local TCS (`POST /efristcs/ws/tcsapp/getInformation`); the TCS holds the
 * AES key and the private key, overrides `appId` (AP02) and `deviceNo`, and
 * forwards to URA. The ERP therefore never calls T104.
 */
export function usesOfflineEnabler(opts: Pick<SubmitFiscalOptions, 'tokenUrl' | 'securityFlags'>): boolean {
  const protocol = flagsOf(opts as SubmitFiscalOptions).protocol;
  return protocol === 'offline_enabler' || protocol === 'OFFLINE_ENABLER' || protocol === 'enabler' || protocol === 'ENABLER';
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
  const retryable = !/invalid|reject|unauthor|forbidden|not.?found|duplicate|already.?exist|already.*issued|no.?right/i.test(failure);
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

async function fetchAesKey(
  opts: SubmitFiscalOptions,
  endpoint: string,
  global: UraGlobalOptions,
  privateKeyPem: string
): Promise<string> {
  const envelope = buildUnencryptedEnvelope(null, { ...global, interfaceCode: 'T104' }, privateKeyPem);
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
  const encryptedKey = extractAesKey(unwrapped);
  if (!encryptedKey) {
    throw new EfrisClientError({
      code: 'EFRIS_AES_KEY_MISSING',
      stage: 'auth',
      message: 'URA did not return a symmetric key (T104)',
      payload: unwrapped,
      retryable: true,
    });
  }
  // `passowrdDes` is the AES key RSA-encrypted with the taxpayer's public key;
  // it must be decrypted with the private key before use (see protocol.ts).
  let aesKey: string;
  try {
    aesKey = rsaDecryptBase64(encryptedKey, privateKeyPem).toString('hex');
  } catch (err) {
    const wrapped = protocolError(err, 'auth');
    if (wrapped) throw wrapped;
    throw err;
  }
  if (![32, 48, 64].includes(aesKey.length)) {
    throw new EfrisClientError({
      code: 'EFRIS_AES_KEY_INVALID',
      stage: 'auth',
      message: `URA returned a symmetric key of ${aesKey.length / 2} bytes after decryption; expected 16, 24 or 32`,
      retryable: false,
    });
  }
  return aesKey;
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
  const aesKey = await fetchAesKey(opts, endpoint, global, identity.privateKey);
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
 * Submit a fiscal document through the local offline enabler (Aisino TCS).
 *
 * Offline-mode format: the content is base64-encoded plaintext, the signature is
 * empty, and no T104 key exchange happens. The TCS encrypts, signs and forwards
 * to URA, and returns the fiscalised response (FDN / verification code). This is
 * TEST-only until the TCS has been initialised against the sandbox and the round
 * trip has been verified live.
 */
async function submitViaOfflineEnabler(opts: SubmitFiscalOptions, endpoint: string): Promise<unknown> {
  // The TCS owns the private key and the device number, so the ERP only needs the
  // TIN. (s2sIdentity would demand a device key that the enabler transport never
  // uses.)
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
  const interfaceCode = interfaceCodeFor(opts.docType ?? 'SALES_INVOICE', flags);
  const global: UraGlobalOptions = {
    interfaceCode,
    tin,
    deviceNo: resolveDeviceNo(flags, opts.clientId) ?? '',
    flags,
  };
  // No private key is passed: buildUnencryptedEnvelope leaves the signature empty
  // and the content plaintext, exactly the offline-mode request the TCS expects.
  // offlineEnabler pre-encodes non-ASCII so the TCS's single-byte re-encode
  // round-trips UTF-8 correctly (see preEncodeForOfflineEnabler).
  const envelope = buildUnencryptedEnvelope(opts.uraPayload ?? opts.payload, global, undefined, { offlineEnabler: true });
  const raw = await postUraEnvelope(endpoint, envelope, opts.timeoutSeconds);
  try {
    const unwrapped = unwrapResponse(raw);
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
  if (usesOfflineEnabler(opts)) {
    return submitViaOfflineEnabler(opts, endpoint);
  }
  return submitUra(opts, endpoint);
}

/**
 * Post an arbitrary URA S2S / offline-enabler content under a specific interface
 * code and return the unwrapped body. Used for the credit-note follow-ups (T111
 * application query, T108 document fetch), which query URA but do not fiscalize.
 */
async function postUraContent(
  opts: SubmitFiscalOptions,
  interfaceCode: string,
  content: Record<string, unknown>,
  endpoint: string
): Promise<unknown> {
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

  if (usesOfflineEnabler(opts)) {
    const global: UraGlobalOptions = {
      interfaceCode,
      tin,
      deviceNo: resolveDeviceNo(flags, opts.clientId) ?? '',
      flags,
    };
    const envelope = buildUnencryptedEnvelope(content, global, undefined, { offlineEnabler: true });
    const raw = await postUraEnvelope(endpoint, envelope, opts.timeoutSeconds);
    try {
      const unwrapped = unwrapResponse(raw);
      rejectBusinessFailure(unwrapped);
      return unwrapped;
    } catch (err) {
      if (err instanceof EfrisClientError) throw err;
      const wrapped = protocolError(err, 'response');
      if (wrapped) throw wrapped;
      throw err;
    }
  }

  const identity = s2sIdentity(opts);
  const global: UraGlobalOptions = { interfaceCode, tin: identity.tin, deviceNo: identity.deviceNo, flags };
  const aesKey = await fetchAesKey(opts, endpoint, global, identity.privateKey);
  const envelope = buildEncryptedEnvelope(content, aesKey, global, identity.privateKey);
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

function queryEndpoint(opts: SubmitFiscalOptions): string {
  assertLiveMode(opts.mode);
  const flags = flagsOf(opts);
  if (usesOauthGateway(opts)) {
    throw new EfrisClientError({
      code: 'EFRIS_LOOKUP_TRANSPORT',
      stage: 'config',
      message: 'Credit-note queries (T111/T108) are only available on the URA system-to-system gateway',
      retryable: false,
    });
  }
  return resolveModeEndpoint(opts.mode, opts.baseUrl, flags);
}

/** Query a submitted T110 application by referenceNo (interface code T111). */
export async function queryCreditNoteApplication(
  opts: SubmitFiscalOptions,
  referenceNo: string
): Promise<unknown> {
  return postUraContent(
    opts,
    'T111',
    { referenceNo, queryType: '1', pageNo: '1', pageSize: '10' },
    queryEndpoint(opts)
  );
}

/** Fetch the approved credit-note document by its invoiceNo (interface code T108). */
export async function fetchCreditNoteDocument(
  opts: SubmitFiscalOptions,
  invoiceNo: string
): Promise<unknown> {
  return postUraContent(opts, 'T108', { invoiceNo }, queryEndpoint(opts));
}

export interface TaxpayerLookupOptions {
  mode: EfrisMode;
  baseUrl: string;
  tokenUrl?: string | null;
  clientId?: string;
  clientSecret?: string;
  timeoutSeconds: number;
  securityFlags?: Record<string, unknown> | null;
  /** The company's own EFRIS taxpayer TIN, used for the signed globalInfo. */
  tin?: string | null;
  /** The customer TIN being queried. */
  lookupTin: string;
}

/** Only the taxpayer fields URA's T119 response is documented to return. */
export interface UraTaxpayer {
  tin: string | null;
  governmentTin: string | null;
  legalName: string | null;
  businessName: string | null;
  address: string | null;
  contactEmail: string | null;
  contactNumber: string | null;
  taxpayerType: string | null;
}

export interface TaxpayerLookupResult {
  found: boolean;
  taxpayer: UraTaxpayer | null;
  raw: unknown;
}

/**
 * Pull the `taxpayer` object out of an unwrapped T119 response and keep only the
 * fields the URA gateway is documented to return. Unknown/extra fields are
 * dropped, never invented.
 */
export function extractTaxpayer(raw: unknown): UraTaxpayer | null {
  const obj = digObject(raw, ['taxpayer']);
  if (!obj) return null;
  const str = (keys: string[]): string | null => {
    const value = digFirst(obj, keys);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  return {
    tin: str(['tin', 'taxpayerTin']),
    governmentTin: str(['governmentTIN', 'government_tin']),
    legalName: str(['legalName', 'legal_name']),
    businessName: str(['businessName', 'business_name']),
    address: str(['address']),
    contactEmail: str(['contactEmail', 'contact_email']),
    contactNumber: str(['contactNumber', 'contact_number', 'mobilePhone']),
    taxpayerType: str(['taxpayerType', 'taxpayer_type']),
  };
}

/**
 * Query URA for a taxpayer by TIN (interface code T119). This is a native URA
 * system-to-system call: the signed globalInfo carries `interfaceCode: T119`,
 * and the (unencrypted) content is `{ tin, ninBrn: '' }`. It never fiscalizes a
 * document, so TEST-mode success is a valid signal, exactly like the T101 probe.
 */
export async function queryTaxpayerByTin(opts: TaxpayerLookupOptions): Promise<TaxpayerLookupResult> {
  assertLiveMode(opts.mode);
  const flags = flagsOf({ securityFlags: opts.securityFlags ?? null } as SubmitFiscalOptions);
  if (usesOauthGateway({ tokenUrl: opts.tokenUrl ?? null, securityFlags: opts.securityFlags ?? null })) {
    throw new EfrisClientError({
      code: 'EFRIS_LOOKUP_TRANSPORT',
      stage: 'config',
      message: 'Customer TIN lookup (T119) is only available on the URA system-to-system gateway',
      retryable: false,
    });
  }
  let endpoint: string;
  try {
    endpoint = resolveModeEndpoint(opts.mode, opts.baseUrl, flags);
  } catch (err) {
    const wrapped = protocolError(err, 'config');
    if (wrapped) throw wrapped;
    throw err;
  }
  // Reuse the same identity resolution as fiscal submission (seller TIN, device
  // number, private key). T119 signs the envelope with the company device key.
  const identity = s2sIdentity(opts as unknown as SubmitFiscalOptions);
  const global: UraGlobalOptions = {
    interfaceCode: 'T119',
    tin: identity.tin,
    deviceNo: identity.deviceNo,
    flags: identity.flags,
  };
  const envelope = buildUnencryptedEnvelope({ tin: opts.lookupTin, ninBrn: '' }, global, identity.privateKey);
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
  const taxpayer = extractTaxpayer(unwrapped);
  return { found: taxpayer != null, taxpayer, raw: unwrapped };
}
