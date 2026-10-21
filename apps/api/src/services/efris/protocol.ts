/**
 * URA EFRIS system-to-system protocol.
 *
 * TEST talks only to the URA sandbox (or a loopback stand-in). ACTIVE talks
 * only to the live gateway. The invoice body is the T109 billing upload; the
 * outer message is the documented data / globalInfo / returnStateInfo
 * envelope, AES-ECB encrypted and RSA-SHA1 signed the way the gateway expects.
 * A fiscal document is still not complete until the caller finds an FDN and a
 * verification code in the unwrapped response.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { EfrisMode } from './config.js';

export const URA_TEST_ENDPOINT = 'https://efristest.ura.go.ug/efrisws/ws/taapp/getInformation';
export const URA_PRODUCTION_ENDPOINT = 'https://efrisws.ura.go.ug/ws/taapp/getInformation';

const SANDBOX_HOSTS = new Set(['efristest.ura.go.ug']);
const PRODUCTION_HOSTS = new Set(['efrisws.ura.go.ug', 'efris.ura.go.ug']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const AES_BLOCK = 16;

/**
 * `globalInfo.version` is the "client software version" URA's gateway checks on
 * every request (rejected with return code 2889 when below the current minimum).
 * The historical value `1.1.20191201` is stale — URA now rejects it — but the
 * current minimum is not published anywhere and must come from URA. This lets an
 * operator supply the authoritative value via env or security flags without a
 * code change; it is deliberately NOT guessed here.
 */
const DEFAULT_CLIENT_VERSION = process.env.EFRIS_CLIENT_VERSION?.trim() || '1.1.20191201';

export class EfrisProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EfrisProtocolError';
    this.code = code;
  }
}

export function defaultEndpoint(mode: 'TEST' | 'ACTIVE'): string {
  return mode === 'TEST' ? URA_TEST_ENDPOINT : URA_PRODUCTION_ENDPOINT;
}

export function endpointHost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EfrisProtocolError('EFRIS_BASE_URL_INVALID', 'EFRIS endpoint is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EfrisProtocolError('EFRIS_BASE_URL_INVALID', 'EFRIS endpoint must be an http(s) URL');
  }
  return parsed.hostname.toLowerCase();
}

/** Fill in the documented gateway path when an operator saved only the host. */
export function canonicalizeEndpoint(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const bare = parsed.pathname === '/' || parsed.pathname === '';
  if (bare && host === 'efristest.ura.go.ug') parsed.pathname = '/efrisws/ws/taapp/getInformation';
  if (bare && host === 'efrisws.ura.go.ug') parsed.pathname = '/ws/taapp/getInformation';
  return parsed.toString();
}

export function extraProductionHosts(flags: Record<string, unknown> | null | undefined): string[] {
  const raw = flags?.extraProductionHosts ?? flags?.extra_production_hosts;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => String(item ?? '').trim().toLowerCase())
    .filter((host) => host.length > 0 && !SANDBOX_HOSTS.has(host));
}

/**
 * Refuse a URL that would send a test document to the live gateway, or a
 * production document to the sandbox. Loopback is a TEST stand-in. ACTIVE
 * accepts an extra host only when the operator listed it, and never a sandbox
 * host.
 */
export function assertUrlMatchesMode(
  mode: EfrisMode,
  url: string,
  flags?: Record<string, unknown> | null
): void {
  if (mode === 'DISABLED') return;
  const host = endpointHost(url);
  const loopback = LOOPBACK_HOSTS.has(host);
  if (mode === 'TEST') {
    if (PRODUCTION_HOSTS.has(host)) {
      throw new EfrisProtocolError(
        'EFRIS_MODE_HOST_MISMATCH',
        `TEST mode cannot call the URA production gateway (${host}). Use the sandbox endpoint.`
      );
    }
    return;
  }
  if (SANDBOX_HOSTS.has(host) || loopback) {
    const allowed = extraProductionHosts(flags);
    if (loopback && allowed.includes(host)) return;
    throw new EfrisProtocolError(
      'EFRIS_MODE_HOST_MISMATCH',
      `Production mode cannot call ${host}. Point ACTIVE at the URA live gateway.`
    );
  }
  if (PRODUCTION_HOSTS.has(host) || extraProductionHosts(flags).includes(host)) return;
  throw new EfrisProtocolError(
    'EFRIS_MODE_HOST_MISMATCH',
    `Production mode only calls the URA live gateway. ${host} is not a production host.`
  );
}

export function resolveModeEndpoint(
  mode: 'TEST' | 'ACTIVE',
  baseUrl: string | null | undefined,
  flags?: Record<string, unknown> | null
): string {
  const raw = (baseUrl ?? '').trim();
  const url = canonicalizeEndpoint(raw || defaultEndpoint(mode));
  assertUrlMatchesMode(mode, url, flags);
  return url;
}

function pkcs7Pad(buf: Buffer): Buffer {
  const pad = AES_BLOCK - (buf.length % AES_BLOCK);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function pkcs7Unpad(buf: Buffer): Buffer {
  if (buf.length === 0) throw new EfrisProtocolError('EFRIS_CRYPTO', 'Cannot unpad an empty EFRIS payload');
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > AES_BLOCK) throw new EfrisProtocolError('EFRIS_CRYPTO', 'Invalid PKCS7 padding on an EFRIS payload');
  const tail = buf.subarray(buf.length - pad);
  if (!tail.equals(Buffer.alloc(pad, pad))) {
    throw new EfrisProtocolError('EFRIS_CRYPTO', 'PKCS7 padding check failed on an EFRIS payload');
  }
  return buf.subarray(0, buf.length - pad);
}

export function normalizeAesKey(key: string): Buffer {
  const trimmed = key.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const decoded = Buffer.from(trimmed, 'hex');
    if (decoded.length === 16 || decoded.length === 24 || decoded.length === 32) return decoded;
  }
  return Buffer.from(trimmed, 'utf8');
}

export function encryptAesEcb(plaintext: string, key: string): string {
  const keyBuf = normalizeAesKey(key);
  if (![16, 24, 32].includes(keyBuf.length)) {
    throw new EfrisProtocolError('EFRIS_CRYPTO', `URA AES key must be 16, 24 or 32 bytes (got ${keyBuf.length})`);
  }
  const cipher = crypto.createCipheriv(`aes-${keyBuf.length * 8}-ecb`, keyBuf, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(pkcs7Pad(Buffer.from(plaintext, 'utf8'))), cipher.final()]);
  return encrypted.toString('base64');
}

export function decryptAesEcb(ciphertextB64: string, key: string, encryptCode = '2', zipCode = '0'): string {
  if (!ciphertextB64) return '';
  let data: Buffer = Buffer.from(ciphertextB64, 'base64');
  if (zipCode === '1') {
    if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) {
      throw new EfrisProtocolError('EFRIS_CRYPTO', 'URA payload claimed to be gzip compressed');
    }
    data = Buffer.from(zlib.gunzipSync(data));
  }
  if (encryptCode === '2') {
    const keyBuf = normalizeAesKey(key);
    if (data.length % AES_BLOCK !== 0) {
      throw new EfrisProtocolError('EFRIS_CRYPTO', 'URA ciphertext length is not a multiple of the AES block');
    }
    const decipher = crypto.createDecipheriv(`aes-${keyBuf.length * 8}-ecb`, keyBuf, null);
    decipher.setAutoPadding(false);
    data = pkcs7Unpad(Buffer.concat([decipher.update(data), decipher.final()]));
  }
  return data.toString('utf8');
}

export function signRsaSha1(data: string, privateKeyPem: string): string {
  try {
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(data);
    sign.end();
    return sign.sign(normalizePrivateKey(privateKeyPem)).toString('base64');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new EfrisProtocolError('EFRIS_PRIVATE_KEY_INVALID', `URA device private key could not sign the request: ${message}`);
  }
}

/** Accept a PEM, a PEM with escaped newlines, or a base64-wrapped PEM. */
export function normalizePrivateKey(raw: string): string {
  let value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\\n/g, '\n').trim();
  if (!value.includes('BEGIN') && /^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 80) {
    const decoded = Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (decoded.includes('BEGIN')) return decoded.trim();
  }
  return value;
}

/**
 * Decrypt URA's T104 `passowrdDes` value into the raw symmetric-key bytes.
 *
 * The S2S guide is explicit: "The value in passowrdDes is RSA encrypted using
 * your public key, so you have to decrypt it using your private key. The value
 * obtained after decryption is the AES key." The value is base64-encoded RSA
 * ciphertext under PKCS#1 v1.5 padding (Java's default `Cipher.getInstance("RSA")`).
 *
 * Returns the raw decrypted bytes so the caller can hex-encode them for the AES
 * helpers without lossy string round-trips. Never returns the encrypted value.
 */
export function rsaDecryptBase64(encryptedBase64: string, privateKeyPem: string): Buffer {
  try {
    const ciphertext = Buffer.from(encryptedBase64.trim(), 'base64');
    return crypto.privateDecrypt(
      {
        key: normalizePrivateKey(privateKeyPem),
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      ciphertext
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new EfrisProtocolError(
      'EFRIS_AES_KEY_DECRYPT_FAILED',
      `URA symmetric key could not be decrypted with the device private key: ${message}`
    );
  }
}

export function looksLikePrivateKey(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = normalizePrivateKey(value);
  return normalized.includes('PRIVATE KEY');
}

export function ugandaTimestamp(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function flagString(flags: Record<string, unknown> | null | undefined, ...keys: string[]): string {
  if (!flags) return '';
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

export function resolveDeviceNo(
  flags: Record<string, unknown> | null | undefined,
  clientId: string | undefined
): string | null {
  const fromFlags = flagString(flags, 'deviceNo', 'device_no', 'deviceNumber');
  if (fromFlags) return fromFlags;
  if (clientId && /^[A-Za-z0-9_-]{4,40}$/.test(clientId)) return clientId;
  return null;
}

export interface UraGlobalOptions {
  interfaceCode: string;
  tin: string;
  deviceNo: string;
  flags?: Record<string, unknown> | null;
}

export function buildGlobalInfo(opts: UraGlobalOptions, now = new Date()): Record<string, unknown> {
  const flags = opts.flags ?? {};
  const user = flagString(flags, 'userName', 'username') || 'admin';
  return {
    appId: flagString(flags, 'appId', 'app_id') || 'AP04',
    version: flagString(flags, 'clientVersion', 'client_version', 'version') || DEFAULT_CLIENT_VERSION,
    dataExchangeId: crypto.randomBytes(16).toString('hex').toUpperCase(),
    interfaceCode: opts.interfaceCode,
    requestCode: 'TP',
    requestTime: ugandaTimestamp(now),
    responseCode: 'TA',
    userName: user,
    deviceMAC: flagString(flags, 'deviceMac', 'deviceMAC') || 'FFFFFFFFFFFF',
    deviceNo: opts.deviceNo,
    tin: opts.tin,
    brn: flagString(flags, 'brn'),
    taxpayerID: flagString(flags, 'taxpayerId', 'taxpayerID') || '1',
    longitude: flagString(flags, 'longitude') || '32.5825',
    latitude: flagString(flags, 'latitude') || '0.3476',
    agentType: '0',
    extendField: {
      responseDateFormat: 'dd/MM/yyyy',
      responseTimeFormat: 'dd/MM/yyyy HH:mm:ss',
      referenceNo: flagString(flags, 'referenceNo'),
      operatorName: user,
      offlineInvoiceException: { errorCode: '', errorMsg: '' },
    },
  };
}

/**
 * Re-encodes a string so that a single-byte round trip through the Aisino TCS
 * offline enabler reproduces the original UTF-8 bytes.
 *
 * The TCS decodes our base64 `content` as UTF-8 and then re-encodes it with a
 * single-byte charset (Windows-1252) before forwarding to URA, which corrupts
 * every non-ASCII character ("²" U+00B2 arrives as U+FFFD). Pre-encoding each
 * UTF-8 code point as Latin-1 mojibake inverts that round trip: the TCS's
 * single-byte re-encode emits the original UTF-8 bytes, so URA decodes the
 * correct character. ASCII is unchanged.
 */
export function preEncodeForOfflineEnabler(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1');
}

export function buildUnencryptedEnvelope(
  content: Record<string, unknown> | null,
  global: UraGlobalOptions,
  privateKeyPem?: string,
  opts?: { offlineEnabler?: boolean }
): Record<string, unknown> {
  let contentB64 = '';
  let signature = '';
  if (content && Object.keys(content).length > 0) {
    const json = JSON.stringify(content);
    const text = opts?.offlineEnabler ? preEncodeForOfflineEnabler(json) : json;
    contentB64 = Buffer.from(text, 'utf8').toString('base64');
    if (privateKeyPem) signature = signRsaSha1(contentB64, privateKeyPem);
  }
  return {
    data: {
      content: contentB64,
      signature,
      dataDescription: { codeType: '0', encryptCode: '1', zipCode: '0' },
    },
    globalInfo: buildGlobalInfo(global),
    returnStateInfo: { returnCode: '', returnMessage: '' },
  };
}

export function buildEncryptedEnvelope(
  content: Record<string, unknown>,
  aesKey: string,
  global: UraGlobalOptions,
  privateKeyPem: string
): Record<string, unknown> {
  const encrypted = encryptAesEcb(JSON.stringify(content), aesKey);
  return {
    data: {
      content: encrypted,
      signature: signRsaSha1(encrypted, privateKeyPem),
      dataDescription: { codeType: '1', encryptCode: '2', zipCode: '0' },
    },
    globalInfo: buildGlobalInfo(global),
    returnStateInfo: { returnCode: '', returnMessage: '' },
  };
}

export function unwrapResponse(raw: unknown, aesKey?: string): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const envelope = raw as Record<string, unknown>;
  const data = envelope.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return raw;
  const section = data as Record<string, unknown>;
  const content = section.content;
  if (content && typeof content === 'object') return raw;
  if (typeof content !== 'string' || content.length === 0) return raw;
  const desc = (section.dataDescription ?? {}) as Record<string, unknown>;
  const codeType = String(desc.codeType ?? '0');
  const encryptCode = String(desc.encryptCode ?? '0');
  const zipCode = String(desc.zipCode ?? '0');
  let text: string;
  if (codeType === '1') {
    if (!aesKey) throw new EfrisProtocolError('EFRIS_CRYPTO', 'URA returned an encrypted body and no AES key is available');
    text = decryptAesEcb(content, aesKey, encryptCode, zipCode);
  } else {
    let decoded = Buffer.from(content, 'base64');
    if (zipCode === '1') decoded = Buffer.from(zlib.gunzipSync(decoded));
    text = decoded.toString('utf8');
  }
  try {
    section.content = JSON.parse(text) as unknown;
  } catch {
    section.content = text;
  }
  return envelope;
}

export function readReturnState(raw: unknown): { code: string; message: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const envelope = raw as Record<string, unknown>;
  const globalInfo = envelope.globalInfo;
  const candidates = [
    envelope.returnStateInfo,
    globalInfo && typeof globalInfo === 'object' ? (globalInfo as Record<string, unknown>).returnStateInfo : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const state = candidate as Record<string, unknown>;
    const codeRaw = state.returnCode ?? state.return_code ?? state.code;
    const msgRaw = state.returnMessage ?? state.return_message ?? state.message;
    const code = typeof codeRaw === 'string' || typeof codeRaw === 'number' ? String(codeRaw).trim() : '';
    const message = typeof msgRaw === 'string' ? msgRaw.trim() : '';
    if (code || message) return { code, message };
  }
  return null;
}

const SUCCESS_CODES = new Set(['0', '00', '000', '0000', 'SUCCESS', 'SUCCESSFUL']);

export function isSuccessCode(code: string): boolean {
  return code.length === 0 || SUCCESS_CODES.has(code.toUpperCase());
}

/** First string/number under one of the normalised keys, at most six levels down. */
export function digFirst(value: unknown, keys: string[], depth = 0): unknown {
  if (value === null || value === undefined || typeof value !== 'object' || depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = digFirst(item, keys, depth + 1);
      if (hit !== undefined && hit !== null) return hit;
    }
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  for (const key of Object.keys(obj)) {
    const norm = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!wanted.has(norm)) continue;
    const found = obj[key];
    if (typeof found === 'string' && found.trim()) return found;
    if (typeof found === 'number' && Number.isFinite(found)) return String(found);
  }
  for (const key of Object.keys(obj)) {
    const hit = digFirst(obj[key], keys, depth + 1);
    if (hit !== undefined && hit !== null) return hit;
  }
  return undefined;
}

/** First object under one of the normalised keys, at most six levels down. */
export function digObject(value: unknown, keys: string[], depth = 0): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== 'object' || depth > 6) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = digObject(item, keys, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  const wanted = new Set(keys.map((key) => key.replace(/[^a-z0-9]/gi, '').toLowerCase()));
  for (const key of Object.keys(obj)) {
    const norm = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!wanted.has(norm)) continue;
    const found = obj[key];
    if (found && typeof found === 'object' && !Array.isArray(found)) return found as Record<string, unknown>;
  }
  for (const key of Object.keys(obj)) {
    const hit = digObject(obj[key], keys, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function extractAesKey(raw: unknown): string | null {
  const found = digFirst(raw, ['passowrdDes', 'passwordDes', 'aesKey', 'symmetricKey', 'desKey']);
  return typeof found === 'string' && found.trim() ? found.trim() : null;
}

function money(value: number): string {
  if (!Number.isFinite(value)) return '0.00';
  return (Math.round(value * 100) / 100).toFixed(2);
}

function qty(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10000) / 10000;
  return String(rounded);
}

function compact(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/**
 * URA invoiceType. 1 normal (positive) invoice, 2 credit note (red/negative).
 *
 * A debit note is a supplementary POSITIVE invoice in URA's model — there is no
 * dedicated invoiceType for it, so it fiscalises as a normal invoice (`1`).
 * URA rejects `3` with `1135 basicInformation-->invoiceType:Invalid field value`.
 * payload_mapping.fixed can override the value when a gateway build differs.
 */
export function invoiceTypeFor(docType: string): string {
  const kind = docType.trim().toUpperCase();
  if (kind === 'CREDIT_NOTE' || kind === 'CREDIT') return '2';
  return '1';
}

/**
 * A stock movement is not a tax document: URA records it through the T131
 * stock-in/reconciliation interface, which returns a stock acknowledgement
 * rather than an FDN + verification code. These doc_type values are routed to
 * T131 instead of T109.
 */
export function isStockDocType(docType: string): boolean {
  const kind = docType.trim().toUpperCase();
  return kind === 'PURCHASE_RECEIPT'
    || kind === 'GOODS_RECEIPT'
    || kind === 'STOCK_IN'
    || kind === 'STOCK_MOVEMENT'
    || kind === 'STOCK_RECONCILIATION'
    || kind === 'STOCK_ADJUSTMENT'
    || kind === 'STOCK_OUT';
}

export function interfaceCodeFor(docType: string, flags: Record<string, unknown> | null | undefined): string {
  const override = flagString(flags, 'interfaceCode', 'interface_code');
  if (/^T\d{3}$/.test(override)) return override;
  const kind = docType.trim().toUpperCase();
  if (kind === 'CREDIT_NOTE' || kind === 'CREDIT') {
    const credit = flagString(flags, 'creditInterface', 'credit_interface');
    if (/^T\d{3}$/.test(credit)) return credit;
    // URA applies credit notes via T110 ("Please use interface api-T110 to apply
    // credit note"), not T109. Debit notes stay on T109 as positive invoices.
    return 'T110';
  }
  if (isStockDocType(kind)) return 'T131';
  return 'T109';
}

export interface UraLine {
  itemCode?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  taxPercent: number;
  /** Line gross (tax inclusive), as stored on invoice_items.line_total. */
  lineGross: number;
  /** URA unit-of-measure code as registered on the goods (e.g. "CT"), not a generic default. */
  unitOfMeasure?: string | null;
  /** URA goods-category id/name the goods is registered under (T130). */
  goodsCategoryId?: string | null;
  goodsCategoryName?: string | null;
  /** 1 when the line is VAT-applicable, 0 otherwise. */
  vatApplicableFlag?: string | null;
}

export interface UraParty {
  legalName?: string | null;
  businessName?: string | null;
  tin?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  placeOfBusiness?: string | null;
  buyerKind?: string | null;
}

export interface UraInvoiceInput {
  docType: string;
  docRefCode: string;
  txnDate: string;
  currency: string;
  grossAmount: number;
  taxAmount: number;
  seller: UraParty | null;
  buyer: UraParty | null;
  lines: UraLine[];
  oriInvoiceNo?: string | null;
  oriInvoiceId?: string | null;
  deviceNo?: string | null;
  remarks?: string | null;
  /** T110 credit note application: URA reason code (101-105). */
  reasonCode?: string | null;
  /** T110 credit note application: free-text reason. */
  reason?: string | null;
  /** T110 credit note application: application timestamp (defaults to now). */
  applicationTime?: string | null;
  /** T110 credit note application: seller's reference for the original sale. */
  sellersReferenceNo?: string | null;
}

interface PreparedLine {
  itemCode: string;
  description: string;
  quantity: number;
  net: number;
  tax: number;
  gross: number;
  rate: number;
  unitOfMeasure: string;
  goodsCategoryId: string;
  goodsCategoryName: string;
  vatApplicableFlag: string;
}

function prepareLines(input: UraInvoiceInput): PreparedLine[] {
  const source = input.lines.length > 0 ? input.lines : [{
    description: input.docRefCode || input.docType,
    quantity: 1,
    unitPrice: Math.max(input.grossAmount - input.taxAmount, 0),
    taxPercent: 0,
    lineGross: input.grossAmount,
  }];
  const prepared: PreparedLine[] = source.map((line, index) => {
    const quantity = line.quantity > 0 ? line.quantity : 1;
    const rate = line.taxPercent > 0 ? line.taxPercent / 100 : 0;
    const gross = Number.isFinite(line.lineGross) && line.lineGross > 0
      ? line.lineGross
      : line.unitPrice * quantity * (1 + rate);
    const net = rate > 0 ? gross / (1 + rate) : Math.max(gross - 0, line.unitPrice * quantity);
    const tax = Math.max(gross - net, 0);
    return {
      itemCode: compact(line.itemCode) || `ITEM${index + 1}`,
      description: compact(line.description) || `Item ${index + 1}`,
      quantity,
      net,
      tax,
      gross: net + tax,
      rate,
      unitOfMeasure: compact(line.unitOfMeasure) || '101',
      goodsCategoryId: compact(line.goodsCategoryId) || '',
      goodsCategoryName: compact(line.goodsCategoryName) || '',
      vatApplicableFlag: compact(line.vatApplicableFlag) || '',
    };
  });
  const netTarget = Math.max(input.grossAmount - input.taxAmount, 0);
  const last = prepared[prepared.length - 1];
  const netSum = prepared.reduce((sum, line) => sum + line.net, 0);
  const taxSum = prepared.reduce((sum, line) => sum + line.tax, 0);
  last.net += netTarget - netSum;
  last.tax += input.taxAmount - taxSum;
  if (last.net < 0) last.net = 0;
  if (last.tax < 0) last.tax = 0;
  last.gross = last.net + last.tax;
  if (last.net > 0) last.rate = last.tax / last.net;
  return prepared;
}

function taxCategory(rate: number): { code: string; name: string } {
  if (rate >= 0.17 && rate <= 0.19) return { code: '01', name: 'Standard' };
  if (rate === 0) return { code: '02', name: 'Zero' };
  return { code: '01', name: 'Standard' };
}

/** Inner T109 (or T110) content. Amounts are strings, which is what URA parses. */
export function buildT109Content(input: UraInvoiceInput): Record<string, unknown> {
  const lines = prepareLines(input);
  const seller = input.seller;
  const buyer = input.buyer;
  const buyerTin = compact(buyer?.tin);
  const issued = input.txnDate && input.txnDate.length <= 10 ? `${input.txnDate} 00:00:00` : input.txnDate;
  const goodsDetails = lines.map((line, index) => ({
    item: line.description,
    itemCode: line.itemCode,
    qty: qty(line.quantity),
    unitOfMeasure: line.unitOfMeasure,
    // URA treats goodsDetails.unitPrice/total as TAX-INCLUSIVE (gross) and derives
    // the VAT with tax = total * taxRate / (1 + taxRate). Sending the net amount
    // here is rejected with 2776 "Tax calculation error".
    unitPrice: money(line.quantity > 0 ? line.gross / line.quantity : line.gross),
    total: money(line.gross),
    taxRate: line.rate > 0 ? line.rate.toFixed(2) : '0',
    tax: money(line.tax),
    discountTotal: '',
    discountTaxRate: '0',
    orderNumber: String(index),
    discountFlag: '2',
    deemedFlag: '2',
    exciseFlag: '2',
    categoryId: '',
    categoryName: '',
    goodsCategoryId: line.goodsCategoryId,
    goodsCategoryName: line.goodsCategoryName,
    exciseRate: '',
    exciseRule: '',
    exciseTax: '',
    pack: '',
    stick: '',
    exciseUnit: '',
    exciseCurrency: input.currency || 'UGX',
    exciseRateName: '',
    vatApplicableFlag: line.vatApplicableFlag,
  }));
  const byCategory = new Map<string, { code: string; name: string; net: number; tax: number; gross: number; rate: number }>();
  for (const line of lines) {
    const category = taxCategory(line.rate);
    const current = byCategory.get(category.code) ?? { ...category, net: 0, tax: 0, gross: 0, rate: line.rate };
    current.net += line.net;
    current.tax += line.tax;
    current.gross += line.gross;
    byCategory.set(category.code, current);
  }
  const taxDetails = [...byCategory.values()].map((row) => ({
    taxCategoryCode: row.code,
    netAmount: money(row.net),
    taxRate: row.rate > 0 ? row.rate.toFixed(2) : '0',
    taxAmount: money(row.tax),
    grossAmount: money(row.gross),
    exciseUnit: '',
    exciseCurrency: input.currency || 'UGX',
    taxRateName: row.name,
  }));
  const netAmount = lines.reduce((sum, line) => sum + line.net, 0);
  const taxAmount = lines.reduce((sum, line) => sum + line.tax, 0);
  const grossAmount = netAmount + taxAmount;
  return {
    sellerDetails: {
      tin: compact(seller?.tin),
      ninBrn: '',
      legalName: compact(seller?.legalName),
      businessName: compact(seller?.businessName) || compact(seller?.legalName),
      address: compact(seller?.address),
      mobilePhone: compact(seller?.phone),
      linePhone: '',
      emailAddress: compact(seller?.email),
      placeOfBusiness: compact(seller?.placeOfBusiness),
      referenceNo: compact(input.docRefCode).slice(0, 50),
    },
    basicInformation: {
      invoiceNo: '',
      antifakeCode: '',
      deviceNo: compact(input.deviceNo),
      issuedDate: issued,
      operator: 'admin',
      currency: input.currency || 'UGX',
      // T110 credit note references the original invoice by BOTH identifiers:
      // oriInvoiceNo = original FDN, oriInvoiceId = original internal invoice id.
      // URA rejects 2825 "without original invoice" when either is missing.
      oriInvoiceNo: compact(input.oriInvoiceNo),
      oriInvoiceId: compact(input.oriInvoiceId),
      invoiceType: invoiceTypeFor(input.docType),
      invoiceKind: '1',
      dataSource: '103',
      invoiceIndustryCode: '101',
      isBatch: '0',
    },
    buyerDetails: {
      buyerTin,
      buyerNinBrn: '',
      buyerLegalName: compact(buyer?.legalName) || 'Cash customer',
      buyerBusinessName: compact(buyer?.businessName) || compact(buyer?.legalName),
      buyerAddress: compact(buyer?.address),
      buyerEmail: compact(buyer?.email),
      buyerMobilePhone: compact(buyer?.phone),
      buyerLinePhone: '',
      buyerPlaceOfBusi: '',
      buyerType: buyerTin ? '0' : '1',
      buyerCitizenship: '',
      buyerSector: '',
      buyerReferenceNo: '',
    },
    goodsDetails,
    taxDetails,
    summary: {
      netAmount: money(netAmount),
      taxAmount: money(taxAmount),
      grossAmount: money(grossAmount),
      itemCount: String(lines.length),
      modeCode: '1',
      remarks: compact(input.remarks).slice(0, 200),
      qrCode: '',
    },
    payWay: [{
      paymentMode: '102',
      paymentAmount: money(grossAmount),
      orderNumber: 'a',
    }],
  };
}

/** URA credit-note reason codes (from the gateway's own T110 option list). */
export const URA_CREDIT_NOTE_REASONS: Record<string, string> = {
  '101': 'Return of products due to expiry or damage, etc.',
  '102': 'Cancellation of the purchase',
  '103': 'Invoice amount wrongly Stated due to miscalculation of price, tax, or discounts,etc.',
  '104': 'Partial or complete waive off of the product sale after the invoice is generated and sent to customer.',
  '105': 'Others (Please specify)',
};

/**
 * Inner T110 credit-note application content.
 *
 * A credit note is a two-step workflow: the ERP first posts a T110 APPLICATION
 * (this body) referencing the original invoice, and URA returns an application
 * `referenceNo`. After URA approves it, a follow-up query (T111/T108) returns
 * the actual red-invoice FDN. The structure differs from T109 in three ways
 * that URA rejects if missed (return code 2825 "without original invoice"):
 *
 *   * `oriInvoiceId`/`oriInvoiceNo` sit at the TOP LEVEL, not in basicInformation;
 *   * `basicInformation` is minimal (operator, invoiceKind, invoiceIndustryCode,
 *     branchId) — no invoiceType, deviceNo, issuedDate, or dataSource;
 *   * there is no sellerDetails block, and the body carries
 *     invoiceApplyCategoryCode, reasonCode/reason and applicationTime.
 *
 * Amounts are the POSITIVE "what is being credited" values; URA negates them
 * when it issues the red invoice on approval.
 */
export function buildT110Content(input: UraInvoiceInput): Record<string, unknown> {
  const lines = prepareLines(input);
  const seller = input.seller;
  const buyer = input.buyer;
  const buyerTin = compact(buyer?.tin);
  const issued = compact(input.applicationTime) || ugandaTimestamp();
  // A T110 credit note is a red invoice: URA rejects positive goodsDetails qty
  // (1431 "Cannot be positive"), so qty/total/tax and the summary/payWay totals
  // are negated while unitPrice stays positive.
  const neg = (value: number): string => money(-Math.abs(value));
  const goodsDetails = lines.map((line, index) => ({
    item: line.description,
    itemCode: line.itemCode,
    qty: qty(-Math.abs(line.quantity)),
    unitOfMeasure: line.unitOfMeasure,
    // Same tax-inclusive (gross) model as T109, proven live on this sandbox.
    unitPrice: money(line.quantity > 0 ? line.gross / line.quantity : line.gross),
    total: neg(line.gross),
    taxRate: line.rate > 0 ? line.rate.toFixed(2) : '0',
    tax: neg(line.tax),
    discountTotal: '',
    discountTaxRate: '0',
    orderNumber: String(index),
    discountFlag: '2',
    deemedFlag: '2',
    exciseFlag: '2',
    categoryId: '',
    categoryName: '',
    goodsCategoryId: line.goodsCategoryId,
    goodsCategoryName: line.goodsCategoryName,
    exciseRate: '',
    exciseRule: '',
    exciseTax: '',
    pack: '',
    stick: '',
    exciseUnit: '',
    // URA stores the original invoice's goodsDetails without exciseCurrency
    // (only taxDetails keeps it), so the credit note must mirror that exactly —
    // sending 'UGX' here is rejected 1476 "must be the same as the original invoice".
    exciseCurrency: '',
    exciseRateName: '',
    vatApplicableFlag: line.vatApplicableFlag,
  }));
  const byCategory = new Map<string, { code: string; name: string; net: number; tax: number; gross: number; rate: number }>();
  for (const line of lines) {
    const category = taxCategory(line.rate);
    const current = byCategory.get(category.code) ?? { ...category, net: 0, tax: 0, gross: 0, rate: line.rate };
    current.net += line.net;
    current.tax += line.tax;
    current.gross += line.gross;
    byCategory.set(category.code, current);
  }
  const taxDetails = [...byCategory.values()].map((row) => ({
    taxCategoryCode: row.code,
    netAmount: neg(row.net),
    taxRate: row.rate > 0 ? row.rate.toFixed(2) : '0',
    taxAmount: neg(row.tax),
    grossAmount: neg(row.gross),
    exciseUnit: '',
    exciseCurrency: input.currency || 'UGX',
    taxRateName: row.name,
  }));
  const netAmount = lines.reduce((sum, line) => sum + line.net, 0);
  const taxAmount = lines.reduce((sum, line) => sum + line.tax, 0);
  const grossAmount = netAmount + taxAmount;
  return {
    oriInvoiceId: compact(input.oriInvoiceId),
    oriInvoiceNo: compact(input.oriInvoiceNo),
    reasonCode: compact(input.reasonCode) || '102',
    reason: compact(input.reason) || '',
    applicationTime: issued,
    invoiceApplyCategoryCode: '101',
    currency: input.currency || 'UGX',
    contactName: '',
    contactMobileNum: '',
    contactEmail: '',
    source: '103',
    remarks: compact(input.remarks).slice(0, 200),
    sellersReferenceNo: compact(input.sellersReferenceNo ?? input.docRefCode).slice(0, 50),
    goodsDetails,
    taxDetails,
    summary: {
      netAmount: neg(netAmount),
      taxAmount: neg(taxAmount),
      grossAmount: neg(grossAmount),
      itemCount: String(lines.length),
      modeCode: '0',
      remarks: compact(input.remarks).slice(0, 200),
      qrCode: '',
    },
    buyerDetails: {
      buyerTin,
      buyerNinBrn: '',
      buyerPassportNum: '',
      buyerLegalName: compact(buyer?.legalName) || 'Cash customer',
      buyerBusinessName: compact(buyer?.businessName) || compact(buyer?.legalName),
      buyerAddress: compact(buyer?.address),
      buyerEmail: compact(buyer?.email),
      buyerMobilePhone: compact(buyer?.phone),
      buyerLinePhone: '',
      buyerPlaceOfBusi: '',
      buyerType: buyerTin ? '0' : '1',
      buyerCitizenship: '1',
      buyerSector: '1',
      buyerReferenceNo: '',
    },
    payWay: [{
      paymentMode: '101',
      paymentAmount: neg(grossAmount),
      orderNumber: 'a',
    }],
    importServicesSeller: {
      importBusinessName: '',
      importEmailAddress: '',
      importContactNumber: '',
      importAddress: '',
      importInvoiceDate: '',
      importAttachmentName: '',
      importAttachmentContent: '',
    },
    basicInformation: {
      operator: 'admin',
      invoiceKind: '1',
      invoiceIndustryCode: '102',
      branchId: '',
    },
  };
}

/**
 * T131 stock-in `stockInType` options (from the gateway's own option list).
 * `102` local purchase is the default; `101` is import.
 */
export const URA_STOCK_IN_TYPES: Record<string, string> = {
  '101': 'Import',
  '102': 'Local Purchase',
};

/**
 * T131 stock-reconciliation `adjustType` options (from the gateway's own option
 * list). Only these four exist; the ERP maps its adjustment types onto them.
 */
export const URA_ADJUSTMENT_TYPES: Record<string, string> = {
  '101': 'Expired Goods',
  '102': 'Damaged Goods',
  '103': 'Personal Uses',
  '104': 'Others. (Please specify)',
};

/**
 * Map an ERP inventory-adjustment type onto a URA T131 adjustType code without
 * inventing any URA code. URA only exposes four reasons (expired / damaged /
 * personal use / others), so damage maps to 102 and every other ERP reason
 * (stocktake, cycle count, correction, scrap, quarantine, release) maps to 104
 * "Others".
 */
export function uraAdjustmentType(erpAdjustmentType: string | null | undefined): string {
  const kind = (erpAdjustmentType ?? '').trim().toUpperCase();
  if (kind === 'DAMAGE' || kind === 'DAMAGED') return '102';
  return '104';
}

export interface UraStockLine {
  /** URA goods code (products.efris_goods_code) — never a bare ERP SKU. */
  goodsCode: string;
  /** URA unit-of-measure code (products.efris_unit_of_measure, e.g. "CT"). */
  measureUnit: string;
  quantity: number;
  /** Unit value URA records for the stock line (gross/unit cost). */
  unitPrice: number;
  remarks?: string | null;
}

export interface UraStockInput {
  docType: string;
  docRefCode: string;
  /** YYYY-MM-DD the stock movement is effective. */
  stockInDate: string;
  /** '101' stock in, '102' adjustment/reconciliation. */
  operationType: string;
  /** stockInType: '101' import / '102' local purchase (stock in only). */
  stockInType?: string | null;
  /** adjustType: '101'-'104' (reconciliation only). */
  adjustType?: string | null;
  supplierTin?: string | null;
  supplierName?: string | null;
  branchId?: string | null;
  /** Supplier invoice/receipt reference, when the movement references one. */
  invoiceNo?: string | null;
  remarks?: string | null;
  lines: UraStockLine[];
}

/**
 * Inner T131 stock-in / stock-reconciliation content. The structure is the
 * gateway's `goodsStockIn` + `goodsStockInItem` shape; amounts are strings, and
 * every empty optional field is sent as '' exactly as the reference client does.
 * T131 never returns an FDN — success is a `returnCode` 00 stock acknowledgement.
 */
export function buildT131Content(input: UraStockInput): Record<string, unknown> {
  const isReconciliation = input.operationType === '102';
  return {
    goodsStockIn: {
      operationType: input.operationType,
      supplierTin: compact(input.supplierTin),
      supplierName: compact(input.supplierName),
      adjustType: isReconciliation ? compact(input.adjustType) : '',
      remarks: compact(input.remarks).slice(0, 200),
      stockInDate: compact(input.stockInDate),
      stockInType: isReconciliation ? '' : compact(input.stockInType) || '102',
      productionBatchNo: '',
      productionDate: '',
      branchId: compact(input.branchId),
      invoiceNo: compact(input.invoiceNo),
      isCheckBatchNo: '',
      rollBackIfError: '',
      goodsTypeCode: '101',
    },
    goodsStockInItem: input.lines.map((line) => ({
      commodityGoodsId: '',
      goodsCode: compact(line.goodsCode),
      measureUnit: compact(line.measureUnit),
      quantity: qty(line.quantity),
      unitPrice: money(line.unitPrice),
      remarks: compact(line.remarks),
      fuelTankId: '',
      lossQuantity: '',
      originalQuantity: '',
    })),
  };
}
