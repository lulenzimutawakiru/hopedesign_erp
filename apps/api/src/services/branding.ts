import pg from 'pg';
import { createHash, createHmac } from 'node:crypto';
import { Ctx } from '../db.js';
import { config } from '../config.js';

/**
 * Shared branding + authenticity layer for every exported document.
 *
 * - Loads the tenant/company profile (name, tagline, contacts, TIN/VRN, branch)
 * - Computes a deterministic SHA-256 fingerprint over a document's canonical content
 * - Issues / verifies an HMAC-signed, tamper-evident document token
 * - Renders a shared branded HTML template (used by reports print view)
 */

// Brand palette - matches the web BrandMark / brand tokens (#0B1F33 navy, #00A6A6 teal, #1261A0 blue).
export const BRAND = {
  navy: [0.043, 0.122, 0.2] as [number, number, number],
  teal: [0, 0.651, 0.651] as [number, number, number],
  blue: [0.071, 0.38, 0.627] as [number, number, number],
  gray: [0.373, 0.42, 0.463] as [number, number, number],
  line: [0.851, 0.882, 0.91] as [number, number, number],
  headerFill: [0.957, 0.965, 0.973] as [number, number, number],
  ink: [0.09, 0.168, 0.227] as [number, number, number],
  paper: [0.961, 0.969, 0.976] as [number, number, number],
  zebra: [0.965, 0.972, 0.978] as [number, number, number],
  white: [1, 1, 1] as [number, number, number],
};
export const BRAND_HEX = {
  navy: '#0B1F33',
  teal: '#00A6A6',
  blue: '#1261A0',
  gray: '#5F6B76',
  headerFill: '#F4F6F8',
  line: '#D9E1E8',
  ink: '#172B3A',
  paper: '#F5F7FA',
  zebra: '#F6F8F9',
  white: '#FFFFFF',
};

/** Convert a #rrggbb hex colour to an RGB 0..1 array for PDFKit; falls back on invalid input. */
export function hexToRgb(
  hex: string | undefined,
  fallback: [number, number, number] = BRAND.navy
): [number, number, number] {
  const h = (hex ?? '').replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return fallback;
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** Normalize a #rrggbb hex colour to an Excel ARGB string (FFrrggbb); falls back on invalid input. */
export function brandHex(v: string | undefined, fallback: string): string {
  const h = (v ?? '').replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(h) ? `FF${h}` : fallback;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Formal long date for printed documents (21 August 2026). Date-only values use UTC. */
export function formatDocDate(v: unknown): string {
  if (v == null || v === '') return '';
  const raw = String(v);
  const isoDay = raw.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(raw);
  const d = isoDay ? new Date(`${raw.slice(0, 10)}T00:00:00Z`) : new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
  const day = isoDay ? d.getUTCDate() : d.getDate();
  const month = isoDay ? d.getUTCMonth() : d.getMonth();
  const year = isoDay ? d.getUTCFullYear() : d.getFullYear();
  return `${day} ${MONTHS[month]} ${year}`;
}

/** Formal date and 24-hour time (21 August 2026, 14:32). */
export function formatDocDateTime(v: unknown): string {
  if (v == null || v === '') return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

/** Human status: APPROVED_PENDING -> Approved pending. */
export function formatDocStatus(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function companyContactLines(c: CompanyProfile): string[] {
  return [
    [c.address, c.branchName && c.branchAddress && c.branchAddress !== c.address ? c.branchAddress : '']
      .filter(Boolean)
      .join('  ·  '),
    [c.phone, c.email, c.website].filter(Boolean).join('  ·  '),
  ].filter(Boolean);
}

export function companyRegLines(c: CompanyProfile): string[] {
  return [
    [
      c.legalName && c.legalName !== c.name ? c.legalName : '',
      c.tin ? `TIN ${c.tin}` : '',
      c.vrn ? `VRN ${c.vrn}` : '',
      c.currency ? `Currency ${c.currency}` : '',
    ]
      .filter(Boolean)
      .join('  ·  '),
  ].filter(Boolean);
}

export function brandMarkSvg(size = 40, navy = BRAND_HEX.navy, teal = BRAND_HEX.teal): string {
  return `<svg class="brand-mark" viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true">
      <rect width="40" height="40" rx="8" fill="${navy}"/>
      <rect x="8" y="8" width="6.2" height="24" rx="1.2" fill="#fff"/>
      <rect x="25.8" y="8" width="6.2" height="24" rx="1.2" fill="#fff"/>
      <rect x="8" y="17" width="24" height="6" rx="1" fill="${teal}"/>
      <rect x="18.6" y="14.4" width="2.8" height="11.2" rx="0.4" fill="${navy}"/>
      <rect x="14.4" y="18.6" width="11.2" height="2.8" rx="0.4" fill="${navy}"/>
    </svg>`;
}

export interface ExcelBrandHeaderOpts {
  title: string;
  subtitle?: string;
  docNo?: string;
  issuedBy: string;
  issuedAt: string;
  facts?: Array<[string, string]>;
  status?: string;
  classification?: string;
  columns?: number;
}

function excelCol(n: number): string {
  let s = '';
  let x = Math.max(1, n);
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** Shared navy letterhead block used by document and report workbooks. */
export function applyExcelBrandHeader(
  ws: {
    addRow: (values?: unknown[]) => {
      number: number;
      font?: unknown;
      fill?: unknown;
      alignment?: unknown;
      height?: number;
      getCell: (col: number) => {
        font?: unknown;
        fill?: unknown;
        alignment?: unknown;
        value?: unknown;
        border?: unknown;
      };
    };
    mergeCells: (from: string, to: string) => void;
  },
  company: CompanyProfile,
  opts: ExcelBrandHeaderOpts
): number {
  const navy = brandHex(company.brandColor, `FF${BRAND_HEX.navy.slice(1)}`);
  const teal = brandHex(company.brandColorSecondary, `FF${BRAND_HEX.teal.slice(1)}`);
  const gray = 'FF5F6B76';
  const white = 'FFFFFFFF';
  const paper = 'FFF4F6F8';
  const last = excelCol(Math.max(8, opts.columns ?? 8));
  const merge = (n: number) => ws.mergeCells(`A${n}`, `${last}${n}`);

  const r1 = ws.addRow([company.name]);
  r1.font = { bold: true, size: 16, color: { argb: white }, name: 'Calibri' };
  r1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
  r1.alignment = { vertical: 'middle' };
  r1.height = 24;
  merge(r1.number);

  if (company.tagline) {
    const t = ws.addRow([company.tagline]);
    t.font = { italic: true, size: 10, color: { argb: teal }, name: 'Calibri' };
    t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
    merge(t.number);
  }
  for (const ln of [...companyContactLines(company), ...companyRegLines(company)]) {
    const r = ws.addRow([ln]);
    r.font = { size: 9, color: { argb: 'FFD0D7DE' }, name: 'Calibri' };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
    merge(r.number);
  }

  ws.addRow([]);
  const titleRow = ws.addRow([opts.title.toUpperCase()]);
  titleRow.font = { bold: true, size: 14, color: { argb: navy }, name: 'Calibri' };
  merge(titleRow.number);
  if (opts.docNo) {
    const n = ws.addRow([opts.docNo]);
    n.font = { bold: true, size: 11, color: { argb: teal }, name: 'Calibri' };
    merge(n.number);
  }
  if (opts.subtitle) {
    const s = ws.addRow([opts.subtitle]);
    s.font = { size: 10, color: { argb: gray }, name: 'Calibri' };
    merge(s.number);
  }
  const issued = ws.addRow([`Issued by ${opts.issuedBy} on ${formatDocDateTime(opts.issuedAt)}`]);
  issued.font = { size: 9, color: { argb: gray }, name: 'Calibri' };
  merge(issued.number);

  const facts: Array<[string, string]> = [...(opts.facts ?? [])];
  if (opts.status) facts.push(['Status', opts.status]);
  if (opts.classification) facts.push(['Classification', opts.classification]);
  if (facts.length) {
    ws.addRow([]);
    for (const [k, v] of facts) {
      const fr = ws.addRow([k, v]);
      fr.getCell(1).font = { size: 9, color: { argb: gray }, name: 'Calibri' };
      fr.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: paper } };
      fr.getCell(2).font = { bold: true, size: 10, color: { argb: navy }, name: 'Calibri' };
    }
  }
  const spacer = ws.addRow([]);
  return spacer.number + 1;
}

export interface CompanyProfile {
  name: string;
  tagline: string;
  legalName: string;
  code: string;
  tin: string;
  vrn: string;
  currency: string;
  address: string;
  phone: string;
  email: string;
  supportEmail: string;
  website: string;
  branchName: string;
  branchAddress: string;
  branchPhone: string;
  branchEmail: string;
  verifyUrl: string;
  brandEnabled: boolean;
  verifyEnabled: boolean;
  pdfStamp: boolean;
  footerText: string;
  brandColor: string;
  brandColorSecondary: string;
  logoUrl: string;
  footerLogoUrl: string;
  signatureUrl: string;
  autoSignEnabled: boolean;
  autoSignName: string;
  autoSignRole: string;
}

const strOf = (v: unknown): string => (v == null || v === '' ? '' : String(v));

/** Load the tenant/company/branch profile plus document-related app settings. */
export async function loadCompanyProfile(
  client: pg.PoolClient | pg.QueryResult,
  ctx: Ctx
): Promise<CompanyProfile> {
  const c = client as unknown as pg.PoolClient;
  const tenantId = ctx.tenantId ?? 0;
  const companyId = ctx.companyId ?? null;
  const branchId = ctx.branchId ?? null;

  const comp = await c.query(
    `SELECT c.code, c.name, c.legal_name, c.tin, c.vrn, c.currency, c.address, c.phone, c.email, c.website,
            b.code AS branch_code, b.name AS branch_name, b.address AS branch_address,
            b.phone AS branch_phone, b.email AS branch_email
     FROM companies c
     LEFT JOIN branches b ON b.id = $3 AND b.tenant_id = $1
     WHERE c.tenant_id = $1 AND ($2::bigint IS NULL OR c.id = $2)
     ORDER BY ($2::bigint IS NOT NULL) DESC, c.id ASC
     LIMIT 1`,
    [tenantId, companyId, branchId ?? null]
  );
  const row = comp.rows[0] as Record<string, unknown> | undefined;

  const set = await c.query(
    `SELECT category, key, value FROM app_settings
     WHERE tenant_id = $1 AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
     ORDER BY category, key, (company_id IS NOT NULL) DESC`,
    [tenantId, companyId]
  );
  const stored = new Map<string, unknown>();
  for (const r of set.rows) {
    const rec = r as { category: string; key: string; value: unknown };
    const k = `${rec.category}.${rec.key}`;
    if (!stored.has(k)) stored.set(k, rec.value);
  }
  const getStr = (key: string, fallback: string): string => {
    const v = stored.get(key);
    return v == null || v === '' ? fallback : String(v);
  };
  const getBool = (key: string, fallback: boolean): boolean => {
    const v = stored.get(key);
    return v == null ? fallback : Boolean(v);
  };
  const hexOf = (key: string, fallback: string): string => {
    const v = getStr(key, fallback);
    return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  };

  const companyName =
    getStr('general.company_name', '') || strOf(row?.name) || 'Company';
  const tagline = getStr('general.company_tagline', '');
  const verifyBase = getStr('qr.qr_verify_url', '').replace(/\/+$/, '');
  const fallbackVerify = `${config.webPublicUrl.replace(/\/+$/, '')}/verify`;
  const verifyUrl = verifyBase || fallbackVerify;

  return {
    name: companyName,
    tagline,
    legalName: getStr('general.company_legal_name', '') || strOf(row?.legal_name) || companyName,
    code: strOf(row?.code),
    tin: getStr('general.tax_id', '') || strOf(row?.tin),
    vrn: strOf(row?.vrn),
    currency: strOf(row?.currency) || getStr('general.currency', 'UGX'),
    address: getStr('general.physical_address', '') || strOf(row?.address),
    phone: getStr('general.contact_phone', '') || strOf(row?.phone),
    email: getStr('general.contact_email', '') || strOf(row?.email),
    supportEmail: getStr('general.support_email', ''),
    website: getStr('general.website', '') || strOf(row?.website),
    branchName: strOf(row?.branch_name),
    branchAddress: strOf(row?.branch_address),
    branchPhone: strOf(row?.branch_phone),
    branchEmail: strOf(row?.branch_email),
    verifyUrl,
    brandEnabled: getBool('documents.brand_enabled', true),
    verifyEnabled: getBool('documents.verify_enabled', true),
    pdfStamp: getBool('documents.pdf_stamp', false),
    footerText: getStr('documents.footer_text', ''),
    brandColor: hexOf('general.brand_color', '#1261A0'),
    brandColorSecondary: hexOf('general.brand_color_secondary', '#00A6A6'),
    logoUrl: getStr('general.logo_url', ''),
    footerLogoUrl: getStr('general.footer_logo_url', ''),
    signatureUrl: getStr('general.signature_url', ''),
    autoSignEnabled: getBool('documents.auto_sign_enabled', true),
    autoSignName: getStr('documents.auto_sign_name', ''),
    autoSignRole: getStr('documents.auto_sign_role', 'Managing Director'),
  };
}

export interface PublicCompanyInfo {
  name: string;
  tagline: string;
  legal_name: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  brand_color: string;
  brand_color_secondary: string;
  logo_url: string;
  footer_logo_url: string;
  verify_url: string;
}

/** Slim, safe branding/contact profile for public verification responses. */
export function toPublicCompany(p: CompanyProfile): PublicCompanyInfo {
  return {
    name: p.name,
    tagline: p.tagline,
    legal_name: p.legalName,
    address: p.address,
    phone: p.phone,
    email: p.supportEmail || p.email,
    website: p.website,
    brand_color: p.brandColor,
    brand_color_secondary: p.brandColorSecondary,
    logo_url: p.logoUrl,
    footer_logo_url: p.footerLogoUrl,
    verify_url: p.verifyUrl,
  };
}

// ---------------------------------------------------------------------------
// Canonical fingerprint
// ---------------------------------------------------------------------------

export interface FingerprintSource {
  code: string;
  title: string;
  subtitle?: string;
  meta: Array<[string, string]>;
  columns: Array<{ key: string; label: string; align?: string | null; weight?: number | null }>;
  items: Array<Record<string, unknown>>;
  totals: Array<[string, string]>;
  notes: string[];
}

/** Deterministic JSON serialization (sorted keys) for tamper-evident hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** SHA-256 fingerprint over the canonical content of a business document. */
export function documentFingerprint(src: FingerprintSource): string {
  const canon = canonicalJson({
    code: src.code,
    title: src.title,
    subtitle: src.subtitle ?? '',
    meta: src.meta,
    columns: src.columns.map((c) => ({
      key: c.key,
      label: c.label,
      align: c.align ?? 'left',
      weight: c.weight ?? 1,
    })),
    items: src.items,
    totals: src.totals,
    notes: src.notes,
  });
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}

/** SHA-256 fingerprint over a report / data-export result set. */
export function reportFingerprint(
  table: string,
  cols: string[],
  rows: Array<Record<string, unknown>>
): string {
  const canon = canonicalJson({ table, cols, rows });
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// HMAC-signed document tokens
// ---------------------------------------------------------------------------

export interface DocVerificationClaims {
  v: 1;
  type: string;
  kind?: string;
  id: number;
  code: string;
  title: string;
  fingerprint: string;
  issuedAt: string;
  tenantId: number;
  companyId: number | null;
  companyName: string;
  issuer: string;
  issuerName: string;
}

const TOKEN_VERSION = 1;

/** Issue a signed document token: d1.<payload>.<hmac-sha256>. */
export function issueDocumentToken(claims: Omit<DocVerificationClaims, 'v'>): string {
  const payload: DocVerificationClaims = { v: TOKEN_VERSION, ...claims };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', config.docSigningSecret)
    .update(`doc.v${TOKEN_VERSION}.${body}`)
    .digest('base64url');
  return `d1.${body}.${sig}`;
}

/** Verify a document token signature and return its claims (null when invalid). */
export function verifyDocumentToken(token: string): DocVerificationClaims | null {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || parts[0] !== 'd1') return null;
  const [, body, sig] = parts;
  const expected = createHmac('sha256', config.docSigningSecret)
    .update(`doc.v1.${body}`)
    .digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DocVerificationClaims;
    if (!claims || claims.v !== TOKEN_VERSION || !claims.type || !Number.isInteger(claims.id) || !claims.fingerprint) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

/** Public verification URL that opens the portal and auto-checks the document token. */
export function documentVerifyUrl(profile: CompanyProfile, token: string): string {
  return `${profile.verifyUrl}#doc=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Branded HTML template (reports print view)
// ---------------------------------------------------------------------------

export interface BrandedHtmlParty {
  heading: string;
  name: string;
  lines: string[];
}

export interface BrandedHtmlOptions {
  title: string;
  subtitle?: string;
  kicker?: string;
  company: CompanyProfile;
  issuedBy: string;
  issuedAt: string;
  correlationId?: string | null;
  docNo?: string;
  status?: string;
  classification?: string;
  parties?: BrandedHtmlParty[];
  facts?: Array<[string, string]>;
  authenticity?: { fingerprint: string; token: string; verifyUrl: string } | null;
  body: string;
  photo?: { dataUrl: string; caption?: string } | null;
}

function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function qrSvg(payload: string): Promise<string> {
  try {
    const { default: QRCode } = await import('qrcode');
    return await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 160 });
  } catch {
    return '';
  }
}

export async function renderBrandedHtml(opts: BrandedHtmlOptions): Promise<string> {
  const c = opts.company;
  const auth = opts.authenticity;
  const qr = auth ? await qrSvg(auth.verifyUrl) : '';
  const authTokenShort =
    auth && auth.token.length > 24 ? `${auth.token.slice(0, 14)}\u2026${auth.token.slice(-8)}` : auth?.token ?? '';
  const contactHtml = [...companyContactLines(c), ...companyRegLines(c)]
    .map((line) => `<div class="c-line">${esc(line)}</div>`)
    .join('');
  const brandMarkHtml = /^https?:\/\//i.test(c.logoUrl.trim())
    ? `<img class="brand-logo" src="${esc(c.logoUrl.trim())}" alt="${esc(c.name)} logo" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.style.display='none'"/>`
    : brandMarkSvg(42, c.brandColor, c.brandColorSecondary);
  const footerLogoHtml = /^https?:\/\//i.test(c.footerLogoUrl.trim())
    ? `<img class="foot-logo" src="${esc(c.footerLogoUrl.trim())}" alt="${esc(c.name)} footer logo" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.style.display='none'"/>`
    : '';

  const stampRaw = `Issued by ${opts.issuedBy} on ${formatDocDateTime(opts.issuedAt)}`;
  const classification = opts.classification ?? 'Internal';
  const kicker = opts.kicker ?? 'Official document';
  const status = opts.status ? formatDocStatus(opts.status) : '';

  const facts: Array<[string, string]> = [
    ['Document No', opts.docNo || '—'],
    ['Issue Date', formatDocDateTime(opts.issuedAt)],
    ...(opts.facts ?? []),
    ...(status ? ([['Status', status]] as Array<[string, string]>) : []),
    ['Classification', classification],
  ];
  const seen = new Set<string>();
  const factCells = facts
    .filter(([k, v]) => {
      const key = k.toLowerCase();
      if (seen.has(key) || !v || v === '—') return false;
      seen.add(key);
      return true;
    })
    .map(
      ([k, v]) =>
        `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`
    )
    .join('');

  const photoHtml = opts.photo?.dataUrl
    ? `<aside class="party passport-slot">
        <div class="h">${esc(opts.photo.caption ?? 'Passport photograph')}</div>
        <img class="passport-photo" src="${esc(opts.photo.dataUrl)}" alt="${esc(opts.photo.caption ?? 'Employee photograph')}" />
      </aside>`
    : '';
  const partiesHtml = (opts.parties ?? [])
    .filter((p) => p.name)
    .map(
      (p) => `<aside class="party">
        <div class="h">${esc(p.heading)}</div>
        <div class="n">${esc(p.name)}</div>
        ${p.lines.map((ln) => `<div class="l">${esc(ln)}</div>`).join('')}
      </aside>`
    )
    .join('') + photoHtml;

  const footLeft = [c.footerText, c.legalName || c.name, c.tin ? `TIN ${c.tin}` : '', c.vrn ? `VRN ${c.vrn}` : '']
    .filter(Boolean)
    .join('  ·  ');
  const footRight = [
    stampRaw,
    opts.correlationId ? `Ref ${opts.correlationId}` : '',
    auth ? `SHA-256 ${auth.fingerprint.slice(0, 16)}…` : '',
  ]
    .filter(Boolean)
    .join('  ·  ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(opts.title)}${opts.docNo ? ` ${esc(opts.docNo)}` : ''} — ${esc(c.name)}</title>
<style>
  :root {
    --navy: ${c.brandColor};
    --teal: ${c.brandColorSecondary};
    --blue: ${BRAND_HEX.blue};
    --line: ${BRAND_HEX.line};
    --ink: ${BRAND_HEX.ink};
    --muted: ${BRAND_HEX.gray};
    --paper: ${BRAND_HEX.paper};
    --fill: ${BRAND_HEX.headerFill};
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Calibri, 'Segoe UI', Arial, Helvetica, sans-serif;
    color: var(--ink);
    background: #fff;
    font-size: 11px;
    line-height: 1.45;
  }
  .sheet { max-width: 860px; margin: 0 auto; padding: 0 0 28px; }
  .topbar { height: 8px; background: var(--navy); }
  .topbar::after { content: ''; display: block; height: 3px; background: var(--teal); }
  .letterhead { padding: 18px 32px 0; }
  .lh-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .lh-brand { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
  .brand-mark { width: 42px; height: 42px; flex: 0 0 auto; display: block; }
  .brand-logo { height: 42px; width: auto; max-width: 120px; flex: 0 0 auto; object-fit: contain; }
  .co-name { font-size: 18px; font-weight: 700; color: var(--navy); letter-spacing: 0.01em; margin: 0; }
  .co-tag { color: var(--teal); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; margin: 2px 0 6px; font-weight: 600; }
  .c-line { color: var(--muted); font-size: 9.5px; line-height: 1.45; }
  .lh-doc { text-align: right; flex: 0 0 auto; max-width: 46%; }
  .doc-kicker { font-size: 8.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--teal); font-weight: 700; margin-bottom: 4px; }
  .doc-title { font-size: 20px; font-weight: 700; color: var(--navy); letter-spacing: 0.04em; margin: 0; line-height: 1.15; }
  .doc-no { font-weight: 700; color: var(--teal); font-size: 12.5px; margin-top: 4px; letter-spacing: 0.02em; }
  .doc-sub { color: var(--muted); font-size: 10.5px; margin-top: 4px; }
  .lh-rule { height: 2.2px; background: var(--navy); margin: 14px 0 0; }
  .lh-rule::after { content: ''; display: block; height: 1.4px; background: var(--teal); margin-top: 1.6px; }
  .meta-stamp { color: var(--muted); font-size: 9.5px; margin: 12px 32px 0; }
  .facts { display: grid; grid-template-columns: repeat(4, 1fr); margin: 14px 32px 0; border: 1px solid var(--line); background: var(--fill); }
  .fact { padding: 8px 12px; border-right: 1px solid var(--line); }
  .fact:last-child { border-right: 0; }
  .fact .k { font-size: 8px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  .fact .v { font-size: 11px; font-weight: 700; color: var(--navy); margin-top: 3px; word-break: break-word; }
  .parties { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 16px 32px 0; align-items: stretch; }
  .party { background: var(--fill); border-left: 3px solid var(--teal); padding: 10px 12px; }
  .passport-slot { max-width: 128px; text-align: center; }
  .passport-photo { width: 86px; height: 110px; object-fit: cover; object-position: center top; border: 1px solid var(--navy); background: #fff; display: block; margin: 8px auto 0; }
  .party .h { font-size: 8.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--teal); font-weight: 700; }
  .party .n { font-size: 12.5px; font-weight: 700; color: var(--navy); margin: 3px 0 4px; }
  .party .l { font-size: 10px; color: #3d4c58; line-height: 1.45; }
  .body { padding: 8px 32px 0; }
  table.data, table { border-collapse: collapse; width: 100%; font-size: 10.5px; margin-top: 12px; }
  table.data th, table th { background: var(--navy); color: #fff; font-weight: 600; letter-spacing: 0.04em; font-size: 9.5px; text-transform: uppercase; border: 0; padding: 7px 8px; text-align: left; }
  table.data td, table td { border: 0; border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; color: var(--ink); }
  table.data tbody tr:nth-child(even) td, table tbody tr:nth-child(even) td { background: ${BRAND_HEX.zebra}; }
  .totals { margin: 16px 0 0 auto; width: 280px; font-size: 11px; }
  .totals .row { display: flex; justify-content: space-between; padding: 4px 8px; color: var(--ink); }
  .totals .row.total { background: var(--navy); color: #fff; font-weight: 700; padding: 8px 10px; margin-top: 4px; }
  .notes { margin-top: 18px; font-size: 10.5px; color: var(--ink); }
  .notes h4 { margin: 0 0 6px; font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--navy); }
  .notes p { margin: 0 0 8px; }
  .signs { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 28px; margin-top: 36px; }
  .contract-intro { font-size: 11px; color: var(--ink); margin: 4px 0 10px; text-align: justify; }
  .band { background: var(--navy); color: #fff; font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700; padding: 7px 10px; margin: 16px 0 10px; border-left: 3px solid var(--teal); }
  .band.light { background: var(--fill); color: var(--navy); }
  .clause { margin: 0 0 16px; page-break-inside: avoid; }
  .clause h4 { margin: 0 0 4px; font-size: 12px; color: var(--navy); }
  .clause p { margin: 0 0 6px; font-size: 11px; text-align: justify; white-space: pre-wrap; }
  .clause .legal-ref { font-size: 9px; color: var(--muted); }
  .sign .line { border-bottom: 1px solid #9aa8b3; height: 32px; }
  .sign .lbl { font-size: 8px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-top: 6px; font-weight: 700; }
  .sign .nm { font-size: 10px; color: var(--ink); margin-top: 2px; }
  .sign .dt { font-size: 8px; color: var(--muted); margin-top: 2px; }
  .sign .sig-img { height: 34px; max-width: 160px; object-fit: contain; display: block; margin-bottom: 4px; }
  .auth { margin: 22px 32px 0; background: var(--fill); border: 1px solid var(--line); border-left: 3px solid var(--teal); box-shadow: 0 1px 2px rgba(11, 31, 51, 0.08); }
  .auth-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 14px; background: var(--navy); }
  .auth-title { display: flex; align-items: center; gap: 8px; color: #fff; font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
  .auth-title svg { width: 16px; height: 16px; display: block; flex: 0 0 auto; }
  .auth-chip { background: var(--teal); color: #fff; font-size: 7.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; padding: 2px 9px; border-radius: 999px; }
  .auth-body { display: flex; gap: 16px; align-items: flex-start; padding: 12px 14px; }
  .auth-qr { flex: 0 0 auto; }
  .auth-qr-box { background: #fff; border: 1px solid var(--line); padding: 6px; box-shadow: 0 1px 2px rgba(11, 31, 51, 0.08); }
  .auth-qr svg { width: 96px; height: 96px; display: block; }
  .auth-info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .auth-row { display: flex; gap: 10px; align-items: baseline; }
  .auth-label { flex: 0 0 118px; font-size: 7.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  .auth-value { font-size: 9px; color: var(--ink); word-break: break-all; min-width: 0; }
  .auth-value.mono { font-family: 'IBM Plex Mono', Consolas, Menlo, monospace; font-size: 8px; color: #445; }
  .auth-value.vu { color: var(--blue); text-decoration: none; }
  .auth-note { margin: 4px 0 0; font-size: 8.5px; color: var(--muted); line-height: 1.5; }
  .foot { margin: 18px 32px 0; padding-top: 8px; border-top: 2px solid var(--navy); color: var(--muted); font-size: 8.5px; display: flex; justify-content: space-between; gap: 16px; }
  .foot .foot-l { display: flex; align-items: center; min-width: 0; }
  .foot-logo { height: 26px; width: auto; max-width: 120px; object-fit: contain; flex: 0 0 auto; margin-right: 8px; }
  .foot .r { text-align: right; }
  @page { size: A4; margin: 12mm 12mm 14mm; }
  @media print {
    .sheet { max-width: none; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none; }
    .letterhead, .facts, .parties, .auth, table.data th, table th, .clause, .band, .sign { break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="sheet">
  <div class="topbar"></div>
  <header class="letterhead">
    <div class="lh-row">
      <div class="lh-brand">
        ${brandMarkHtml}
        <div>
          <p class="co-name">${esc(c.name)}</p>
          ${c.tagline ? `<div class="co-tag">${esc(c.tagline)}</div>` : ''}
          ${contactHtml}
        </div>
      </div>
      <div class="lh-doc">
        <div class="doc-kicker">${esc(kicker)}</div>
        <h1 class="doc-title">${esc(opts.title)}</h1>
        ${opts.docNo ? `<div class="doc-no">${esc(opts.docNo)}</div>` : ''}
        ${opts.subtitle ? `<div class="doc-sub">${esc(opts.subtitle)}</div>` : ''}
      </div>
    </div>
    <div class="lh-rule"></div>
  </header>

  <div class="meta-stamp">${esc(stampRaw)}${opts.correlationId ? ` · Ref ${esc(opts.correlationId)}` : ''}</div>
  <div class="facts">${factCells}</div>
  ${partiesHtml ? `<div class="parties">${partiesHtml}</div>` : ''}

  <div class="body">${opts.body}</div>

  ${
    auth
      ? `<div class="auth">
          <div class="auth-head">
            <div class="auth-title">${brandMarkSvg(16, c.brandColor, c.brandColorSecondary)}<span>Document authenticity</span></div>
            <span class="auth-chip">Verified</span>
          </div>
          <div class="auth-body">
            ${qr ? `<div class="auth-qr"><div class="auth-qr-box">${qr}</div></div>` : ''}
            <div class="auth-info">
              <div class="auth-row"><span class="auth-label">Issued by</span><span class="auth-value">${esc(opts.issuedBy)} · ${esc(formatDocDateTime(opts.issuedAt))}</span></div>
              <div class="auth-row"><span class="auth-label">SHA-256 fingerprint</span><span class="auth-value mono">${esc(auth.fingerprint)}</span></div>
              <div class="auth-row"><span class="auth-label">Document token</span><span class="auth-value mono">${esc(authTokenShort)}</span></div>
              <div class="auth-row"><span class="auth-label">Verify at</span><a class="auth-value vu" href="${esc(auth.verifyUrl)}">${esc(auth.verifyUrl)}</a></div>
              <p class="auth-note">Scan the QR code or open the verify link to confirm this document against the official registry. Any alteration of the contents invalidates the fingerprint.</p>
            </div>
          </div>
        </div>`
      : ''
  }

  <footer class="foot">
    <div class="foot-l">
      ${footerLogoHtml}
      <div>${esc(footLeft)}</div>
    </div>
    <div class="r">${esc(footRight)}</div>
  </footer>
</div>
<script>window.print();</script>
</body>
</html>`;
}
