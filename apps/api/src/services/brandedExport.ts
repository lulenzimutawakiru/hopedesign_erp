/**
 * Shared branded table export pipeline (PDF / print HTML / XLSX / CSV).
 *
 * Reuses the PdfDoc writer, the brand palette and the company profile loader
 * so every exported table - generic data exports, management reports and
 * operational registers - renders with the same letterhead, security footer
 * and optional authenticity block as official documents.
 */

import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  BRAND,
  BRAND_HEX,
  applyExcelBrandFooter,
  applyExcelBrandHeader,
  brandHex,
  companyContactLines,
  companyRegLines,
  formatDocDateTime,
  hexToRgb,
  renderBrandedHtml,
  type CompanyProfile,
  type ExcelBrandImages,
} from './branding.js';
import {
  BOTTOM,
  MARGIN,
  PAGE_W,
  PdfDoc,
  imagePixelSize,
  textWidth,
  type PdfTableColumn,
  type Rgb,
} from './pdf.js';

export const GRAY = BRAND.gray;
export const LINE = BRAND.line;
export const INK = BRAND.ink;
export const TABLE_W = PAGE_W - MARGIN * 2;

export interface BrandedTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  weight?: number;
}

/**
 * The metadata the shared letterhead / running-header renderers need. Both the
 * export pipeline (`BrandedDocMeta`) and the business-document layer
 * (`DocData` + `DocumentRenderOpts`) project onto this shape so every PDF and
 * print sheet is drawn with an identical branded header.
 */
export interface LetterheadMeta {
  title: string;
  subtitle?: string;
  kicker?: string;
  docNo?: string;
  status?: string;
  company: CompanyProfile;
}

/** Document-level metadata shared by single-table exports and multi-section payroll documents. */
export interface BrandedDocMeta extends LetterheadMeta {
  classification?: string;
  issuedBy: string;
  issuedAt: string;
  correlationId?: string | null;
  facts?: Array<[string, string]>;
  fingerprint?: string;
  token?: string;
  verifyUrl?: string;
}

export interface BrandedTableOpts extends BrandedDocMeta {
  columns: BrandedTableColumn[];
  rows: Array<Record<string, unknown>>;
}

export interface DocBrand {
  navy: [number, number, number];
  teal: [number, number, number];
}

export const brandOf = (c: CompanyProfile): DocBrand => ({
  navy: hexToRgb(c.brandColor, BRAND.navy),
  teal: hexToRgb(c.brandColorSecondary, BRAND.teal),
});

const authEnabled = (o: BrandedDocMeta): boolean =>
  Boolean(o.token && o.verifyUrl && o.fingerprint);

export function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Compact a raw DB value into a clean printable cell string for PDF/print. */
export function normalizeCellValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return compactDateTime(v);
  if (typeof v === 'object') {
    try {
      return capCell(JSON.stringify(v) ?? '');
    } catch {
      return capCell(String(v));
    }
  }
  const s = String(v);
  const fullJsDate = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}/.exec(s);
  if (fullJsDate) {
    const t = new Date(s);
    if (!Number.isNaN(t.getTime())) return compactDateTime(t);
  }
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(s);
  if (iso) return `${iso[1]} ${iso[2]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return capCell(s);
}

/** Compact local datetime: 2026-09-30 12:34. */
function compactDateTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (hh === '00' && mm === '00') return date;
  return `${date} ${hh}:${mm}`;
}

/** Hard-cap long cell strings so they cannot wrap into dozens of lines. */
function capCell(s: string, max = 160): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}\u2026`;
}

/** Word-wrap like wrapText, but also breaks words that exceed maxWidth. */
export function wrapHard(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const out: string[] = [];
  const words = String(text).split(/\s+/).filter(Boolean);
  let line = '';
  const flush = () => {
    if (line) {
      out.push(line);
      line = '';
    }
  };
  for (const word of words) {
    let w = word;
    while (textWidth(w, size, bold) > maxWidth) {
      flush();
      let cut = 1;
      while (cut < w.length && textWidth(w.slice(0, cut + 1), size, bold) <= maxWidth) cut++;
      out.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const candidate = line ? line + ' ' + w : w;
    if (!line || textWidth(candidate, size, bold) <= maxWidth) line = candidate;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** Best-effort natural table width (pt) used to choose portrait vs landscape. */
function estimateTableWidth(opts: BrandedTableOpts, rows: Array<Record<string, unknown>>): number {
  const size = 7.9;
  const headerSize = 7.0;
  const pad = 3.5;
  const sample = rows.slice(0, 40);
  let total = 0;
  for (const c of opts.columns) {
    let w = textWidth(c.label, headerSize, true) + pad * 2;
    for (const r of sample) {
      const v = r[c.key] == null ? '' : String(r[c.key]);
      w = Math.max(w, Math.min(textWidth(v, size, false) + pad * 2, 260));
    }
    total += Math.min(w, 300);
  }
  return total;
}

/**
 * Width an uploaded brand image occupies when drawn at `height`, preserving its
 * intrinsic aspect ratio and never exceeding `maxWidth`. Returns 0 when no
 * uploaded asset is available, so documents degrade to text only - there is no
 * built-in vector brand mark to fall back to.
 */
export function brandImageWidth(doc: PdfDoc, height: number, maxWidth: number, logoName?: string): number {
  if (!logoName) return 0;
  const dims = doc.imageDims(logoName);
  if (!dims || !dims.height) return 0;
  return Math.min(maxWidth, Math.max(12, (dims.width / dims.height) * height));
}

/**
 * Read an uploaded branding asset (logo / footer-logo / signature) from local
 * storage using the tenant+company query params of its public URL. The PDF
 * writer only supports PNG/JPEG, so other formats fall back to the vector
 * brand mark when drawn.
 */
export function readStoredBrandingFile(
  assetUrl: string,
  filePrefix: string
): { bytes: Buffer; ext: string } | null {
  const parsed = brandingAssetParams(assetUrl);
  if (!parsed) return null;
  const dir = path.join(config.storageRoot, 'branding', parsed.tenant, parsed.company);
  for (const ext of ['.png', '.jpg']) {
    const abs = path.join(dir, `${filePrefix}${ext}`);
    try {
      if (!existsSync(abs)) continue;
      const bytes = readFileSync(abs);
      if (bytes.length) return { bytes, ext };
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Validate an uploaded-asset public URL and return its tenant/company scope.
 * Returns null when the URL is not an absolute http(s) asset URL or when the
 * numeric tenant/company query params are missing, so callers can reject
 * malformed branding settings before touching the storage root.
 */
export function brandingAssetParams(assetUrl: string): { url: URL; tenant: string; company: string } | null {
  const url = String(assetUrl ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const tenant = String(parsed.searchParams.get('tenant') ?? '');
  const company = String(parsed.searchParams.get('company') ?? '');
  if (!/^\d+$/.test(tenant) || !/^\d+$/.test(company)) return null;
  return { url: parsed, tenant, company };
}

/** Read the uploaded company logo for a tenant/company from local storage. */
function readStoredLogo(logoUrl: string): { bytes: Buffer; ext: string } | null {
  return readStoredBrandingFile(logoUrl, 'logo');
}

/** Read the uploaded footer logo for a tenant/company from local storage. */
function readStoredFooterLogo(footerLogoUrl: string): { bytes: Buffer; ext: string } | null {
  return readStoredBrandingFile(footerLogoUrl, 'footer-logo');
}

/** Read the uploaded secondary (header-right) logo for a tenant/company from local storage. */
function readStoredSecondaryLogo(secondaryLogoUrl: string): { bytes: Buffer; ext: string } | null {
  return readStoredBrandingFile(secondaryLogoUrl, 'secondary-logo');
}

/** Preload the stored company logo into the PDF and return its XObject name. */
export function preloadLogo(doc: PdfDoc, logoUrl: string): string | undefined {
  if (!logoUrl) return undefined;
  const file = readStoredLogo(logoUrl);
  return file ? doc.addImage(file.bytes) ?? undefined : undefined;
}

/** Preload the stored footer logo into the PDF and return its XObject name. */
export function preloadFooterLogo(doc: PdfDoc, footerLogoUrl: string): string | undefined {
  if (!footerLogoUrl) return undefined;
  const file = readStoredFooterLogo(footerLogoUrl);
  return file ? doc.addImage(file.bytes) ?? undefined : undefined;
}

/** Preload the stored secondary (header-right) logo and return its XObject name. */
export function preloadSecondaryLogo(doc: PdfDoc, secondaryLogoUrl: string): string | undefined {
  if (!secondaryLogoUrl) return undefined;
  const file = readStoredSecondaryLogo(secondaryLogoUrl);
  return file ? doc.addImage(file.bytes) ?? undefined : undefined;
}

/**
 * Register the uploaded brand logos on an ExcelJS workbook so the spreadsheet
 * letterhead can carry the same two marks as the PDF/HTML renderers. Returns
 * nothing when no uploaded asset exists - the letterhead then stays text only.
 */
/**
 * Minimal ExcelJS workbook surface needed to register uploaded brand artwork.
 *
 * ExcelJS types `Image.buffer` with its own ambient `Buffer` (declared as
 * `interface Buffer extends ArrayBuffer {}`), which a Node Buffer does not
 * structurally satisfy - even though the media writer appends the bytes to the
 * archive verbatim. The loose `buffer` type keeps that mismatch in one place.
 */
export interface ExcelImageWorkbook {
  addImage: (image: { extension: 'png' | 'jpeg' | 'gif'; buffer?: unknown }) => number;
}

export function excelBrandImages(
  wb: unknown,
  company: { logoUrl: string; secondaryLogoUrl?: string; footerLogoUrl: string }
): ExcelBrandImages {
  const out: ExcelBrandImages = {};
  const book = wb as ExcelImageWorkbook | null | undefined;
  if (!book || typeof book.addImage !== 'function') return out;
  const register = (
    file: { bytes: Buffer; ext: string } | null,
    slot: 'logo' | 'secondaryLogo' | 'footerLogo'
  ): void => {
    if (!file) return;
    const size = imagePixelSize(file.bytes);
    if (!size || !size.height) return;
    const id = book.addImage({ buffer: file.bytes, extension: file.ext === '.jpg' ? 'jpeg' : 'png' });
    const aspect = size.width / size.height;
    if (slot === 'logo') {
      out.logoId = id;
      out.logoAspect = aspect;
    } else if (slot === 'secondaryLogo') {
      out.secondaryLogoId = id;
      out.secondaryLogoAspect = aspect;
    } else {
      out.footerLogoId = id;
      out.footerLogoAspect = aspect;
    }
  };
  register(company.logoUrl ? readStoredLogo(company.logoUrl) : null, 'logo');
  register(company.secondaryLogoUrl ? readStoredSecondaryLogo(company.secondaryLogoUrl) : null, 'secondaryLogo');
  register(company.footerLogoUrl ? readStoredFooterLogo(company.footerLogoUrl) : null, 'footerLogo');
  return out;
}

export function drawTopBar(doc: PdfDoc, brand: DocBrand): void {
  doc.rect(0, doc.pageHeight - 8, doc.pageWidth, 8, brand.navy);
  doc.rect(0, doc.pageHeight - 11, doc.pageWidth, 3, brand.teal);
}

/**
 * Compact branded header used on every continuation page. Carries the same two
 * uploaded marks as the page-one letterhead - primary at the left margin,
 * secondary flush with the right margin - so a multi-page document reads as one
 * continuous letterhead.
 */
export function drawRunningHeader(
  doc: PdfDoc,
  opts: LetterheadMeta,
  brand: DocBrand,
  logoName?: string,
  secondaryLogoName?: string
): void {
  drawTopBar(doc, brand);
  const top = doc.pageHeight - 18;
  const mark = 16;
  const logoW = brandImageWidth(doc, mark, 90, logoName);
  let textX = MARGIN;
  if (logoW && logoName) {
    doc.image(logoName, MARGIN, top - mark, logoW, mark);
    textX = MARGIN + logoW + 8;
  }
  const halfW = doc.contentWidth * 0.5;
  const secH = 14;
  const secW = brandImageWidth(doc, secH, 92, secondaryLogoName);
  let labelW = Math.max(60, halfW);
  if (secW && secondaryLogoName) {
    doc.image(secondaryLogoName, MARGIN + doc.contentWidth - secW, top - secH, secW, secH);
    labelW = Math.max(60, Math.min(halfW, doc.contentWidth - secW - 12));
  }
  doc.rawText(opts.company.name, textX, top - 5, 8, {
    bold: true,
    color: brand.navy,
    maxWidth: Math.max(60, doc.contentWidth - (textX - MARGIN) - labelW - 8),
  });
  const right = `${opts.title.toUpperCase()}${opts.docNo ? `  ${opts.docNo}` : ''}`;
  doc.rawText(right, MARGIN + doc.contentWidth - labelW, top - 5, 8, {
    align: 'right',
    maxWidth: labelW,
    color: GRAY,
    bold: true,
  });
  doc.line(MARGIN, top - 22, MARGIN + doc.contentWidth, top - 22, brand.navy, 1.2);
  doc.line(MARGIN, top - 24.2, MARGIN + doc.contentWidth, top - 24.2, brand.teal, 0.7);
  doc.cursorY = top - 34;
}

/**
 * Full letterhead used on page one of every branded document: the uploaded
 * primary mark at the left margin, the uploaded secondary mark flush with the
 * right margin, and the document identity block beneath the secondary mark.
 */
export function drawLetterhead(
  doc: PdfDoc,
  opts: LetterheadMeta,
  brand: DocBrand,
  logoName?: string,
  secondaryLogoName?: string
): void {
  const c = opts.company;
  drawTopBar(doc, brand);
  const logoSize = 30;
  const top = doc.pageHeight - 18;
  const logoY = top - logoSize - 6;
  const logoW = brandImageWidth(doc, logoSize, 110, logoName);
  let textX = MARGIN;
  if (logoW && logoName) {
    doc.image(logoName, MARGIN, logoY, logoW, logoSize);
    textX = MARGIN + logoW + 11;
  }
  const rightX = MARGIN + doc.contentWidth * 0.56;
  const rightW = doc.contentWidth * 0.44;
  const leftW = Math.max(80, rightX - textX - 4);
  doc.cursorY = top - 6;
  doc.text(c.name, textX, 12, { bold: true, color: brand.navy, maxWidth: leftW });
  if (c.tagline) {
    doc.text(c.tagline.toUpperCase(), textX, 6.4, { color: brand.teal, maxWidth: leftW, bold: true });
  }
  for (const ln of [...companyContactLines(c), ...companyRegLines(c)].slice(0, 2)) {
    doc.text(ln, textX, 6.4, { color: GRAY, maxWidth: leftW });
  }
  // Secondary mark sits at the top-right of the header. The document identity
  // block starts below it so the two never overlap on a narrow letterhead.
  let ry = top - 4;
  const secH = 22;
  const secW = brandImageWidth(doc, secH, Math.min(132, rightW), secondaryLogoName);
  if (secW && secondaryLogoName) {
    doc.image(secondaryLogoName, MARGIN + doc.contentWidth - secW, top - secH - 1, secW, secH);
    ry = top - secH - 11;
  }
  doc.rawText((opts.kicker ?? 'Official document').toUpperCase(), rightX, ry, 6.2, {
    align: 'right',
    maxWidth: rightW,
    color: brand.teal,
    bold: true,
  });
  ry -= 15;
  const titleLines = wrapHard(opts.title.toUpperCase(), 13, true, rightW);
  for (const ln of titleLines) {
    doc.rawText(ln, rightX, ry, 13, { align: 'right', maxWidth: rightW, color: brand.navy, bold: true });
    ry -= 14.5;
  }
  if (opts.docNo) {
    doc.rawText(opts.docNo, rightX, ry, 9, { align: 'right', maxWidth: rightW, color: brand.teal, bold: true });
    ry -= 11.5;
  }
  if (opts.subtitle) {
    for (const ln of wrapHard(opts.subtitle, 7.4, false, rightW).slice(0, 2)) {
      doc.rawText(ln, rightX, ry, 7.4, { align: 'right', maxWidth: rightW, color: GRAY });
      ry -= 9.2;
    }
  }
  if (opts.status) {
    const pillText = opts.status.toUpperCase();
    const pillW = textWidth(pillText, 6.4, true) + 18;
    const pillH = 13;
    const px = MARGIN + doc.contentWidth - pillW;
    const py = ry - pillH - 4;
    doc.rect(px, py, pillW, pillH, brand.teal);
    doc.rawText(pillText, px, py + pillH / 2 + 2.2, 6.4, {
      align: 'center',
      bold: true,
      color: BRAND.white,
      maxWidth: pillW,
    });
    ry = py - 6;
  }
  const ruleY = Math.min(doc.cursorY, ry) - 6;
  doc.line(MARGIN, ruleY, MARGIN + doc.contentWidth, ruleY, brand.navy, 1.6);
  doc.line(MARGIN, ruleY - 2.2, MARGIN + doc.contentWidth, ruleY - 2.2, brand.teal, 0.8);
  doc.cursorY = ruleY - 10;
}

export function drawFacts(doc: PdfDoc, items: Array<[string, string]>, brand: DocBrand): void {
  const shown = items.filter(([, v]) => v && v !== '-' && v !== 'N/A');
  if (!shown.length) return;
  const cols = Math.min(4, Math.max(2, shown.length));
  const colW = doc.contentWidth / cols;
  const pad = 8;
  const labelSize = 5.8;
  const valueSize = 8;
  const cells = shown.map(([label, value]) => ({
    label,
    lines: wrapHard(String(value), valueSize, true, colW - pad * 2).slice(0, 3),
  }));
  const rows = Math.ceil(cells.length / cols);
  const rowHs: number[] = [];
  for (let r = 0; r < rows; r++) {
    const slice = cells.slice(r * cols, r * cols + cols);
    const maxLines = Math.max(...slice.map((c) => c.lines.length), 1);
    rowHs.push(Math.max(26, 12 + maxLines * (valueSize * 1.32) + 8));
  }
  const h = rowHs.reduce((a, b) => a + b, 0);
  if (doc.cursorY - h < BOTTOM) doc.newPage();
  const top = doc.cursorY;
  doc.rect(MARGIN, top - h, doc.contentWidth, h, BRAND.headerFill);
  doc.rect(MARGIN, top - h, 2.6, h, brand.teal);
  doc.strokeRect(MARGIN, top - h, doc.contentWidth, h, LINE, 0.45);
  let y = top;
  for (let r = 0; r < rows; r++) {
    const rh = rowHs[r];
    if (r > 0) doc.line(MARGIN, y, MARGIN + doc.contentWidth, y, LINE, 0.4);
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      if (!cell) continue;
      const x = MARGIN + c * colW;
      if (c > 0) doc.line(x, y, x, y - rh, LINE, 0.35);
      doc.rawText(cell.label.toUpperCase(), x + pad, y - 10, labelSize, {
        color: GRAY,
        bold: true,
        maxWidth: colW - pad * 2,
      });
      cell.lines.forEach((ln, i) => {
        doc.rawText(ln, x + pad, y - 21 - i * (valueSize * 1.32), valueSize, {
          color: brand.navy,
          bold: true,
          maxWidth: colW - pad * 2,
        });
      });
    }
    y -= rh;
  }
  doc.cursorY = top - h - 10;
}

export async function renderTablePdf(opts: BrandedTableOpts): Promise<Buffer> {
  const rows = opts.rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const c of opts.columns) out[c.key] = normalizeCellValue(r[c.key]);
    return out;
  });
  const landscape = opts.columns.length > 8 || estimateTableWidth(opts, rows) > TABLE_W;
  const doc = new PdfDoc({ orientation: landscape ? 'landscape' : 'portrait' });
  const tableW = doc.contentWidth;
  const auth = authEnabled(opts);
  const classification = opts.classification ?? 'Internal';
  const brand = brandOf(opts.company);
  const logoName = preloadLogo(doc, opts.company.logoUrl);
  const secondaryLogoName = preloadSecondaryLogo(doc, opts.company.secondaryLogoUrl);
  const footerLogoName = preloadFooterLogo(doc, opts.company.footerLogoUrl);

  doc.setNewPageHandler(() => drawRunningHeader(doc, opts, brand, logoName, secondaryLogoName));
  drawLetterhead(doc, opts, brand, logoName, secondaryLogoName);

  doc.text(
    'Issued by ' +
      opts.issuedBy +
      ' on ' +
      formatDocDateTime(opts.issuedAt) +
      (opts.correlationId ? '  \u00b7  Ref ' + opts.correlationId : ''),
    MARGIN,
    7.2,
    { color: GRAY, maxWidth: tableW }
  );
  doc.cursorY -= 4;

  const facts: Array<[string, string]> = [
    ['Document No', opts.docNo ?? ''],
    ['Issue Date', formatDocDateTime(opts.issuedAt)],
    ...(opts.facts ?? []),
    ['Rows', String(opts.rows.length)],
    ['Classification', classification],
  ];
  const seen = new Set<string>();
  const uniqueFacts = facts.filter(([k, v]) => {
    const key = k.toLowerCase();
    if (!v || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  drawFacts(doc, uniqueFacts, brand);

  if (opts.columns.length && opts.rows.length) {
    const columns: PdfTableColumn[] = opts.columns.map((c) => ({
      key: c.key,
      label: c.label,
      align: c.align,
      weight: c.weight,
    }));
    doc.table({
      x: MARGIN,
      width: tableW,
      columns,
      rows,
      headerFill: brand.navy,
      headerColor: BRAND.white,
      zebra: true,
      zebraFill: BRAND.zebra,
      grid: 'horizontal',
      lineColor: LINE,
      cellPadding: 3.5,
      headerSize: 7.0,
      size: 7.9,
    });
    doc.cursorY -= 6;
  }

  const companyLine = [
    opts.company.legalName || opts.company.name,
    opts.company.tin ? `TIN ${opts.company.tin}` : '',
    opts.company.vrn ? `VRN ${opts.company.vrn}` : '',
  ]
    .filter(Boolean)
    .join('  \u00b7  ');
  const authLine = auth ? `SHA-256 ${opts.fingerprint?.slice(0, 16)}...` : '';
  doc.footer(
    [
      [opts.company.footerText, companyLine].filter(Boolean).join('  \u00b7  '),
      [
        `Issued by ${opts.issuedBy} on ${formatDocDateTime(opts.issuedAt)}`,
        opts.correlationId ? `Ref ${opts.correlationId}` : '',
        authLine,
        classification.toUpperCase(),
      ]
        .filter(Boolean)
        .join('  \u00b7  '),
    ].filter(Boolean),
    { navy: brand.navy, accent: brand.teal, color: GRAY, logoName: footerLogoName }
  );

  doc.setMetadata({
    title: `${opts.title}${opts.docNo ? ` ${opts.docNo}` : ''}`,
    author: opts.issuedBy,
    subject: opts.subtitle ?? `${opts.title} issued by ${opts.company.name}`,
    keywords: [opts.docNo, classification, opts.company.legalName].filter(Boolean).join(', '),
    creator: opts.company.name,
    producer: opts.company.legalName || opts.company.name,
  });
  if (/confidential|restricted/i.test(classification)) doc.watermark('CONFIDENTIAL');
  else if (auth) doc.watermark('VERIFIED COPY', { color: [0.965, 0.97, 0.975], size: 46 });

  return doc.build();
}

export async function renderTablePrintHtml(opts: BrandedTableOpts): Promise<string> {
  const head = opts.columns.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = opts.rows
    .map((r) => `<tr>${opts.columns.map((c) => `<td>${esc(normalizeCellValue(r[c.key]))}</td>`).join('')}</tr>`)
    .join('');
  return renderBrandedHtml({
    title: opts.title,
    subtitle: opts.subtitle ?? `${opts.rows.length} row${opts.rows.length === 1 ? '' : 's'}`,
    kicker: opts.kicker,
    company: opts.company,
    issuedBy: opts.issuedBy,
    issuedAt: opts.issuedAt,
    correlationId: opts.correlationId ?? null,
    docNo: opts.docNo,
    status: opts.status,
    classification: opts.classification ?? 'Internal',
    facts: opts.facts,
    authenticity:
      opts.token && opts.verifyUrl && opts.fingerprint
        ? { fingerprint: opts.fingerprint, token: opts.token, verifyUrl: opts.verifyUrl }
        : undefined,
    body: `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
  });
}

const QTY_LABEL = /(qty|quantity|units|count|rows)/i;
const MONEY_LABEL = /(amount|total|price|cost|value|tax|discount|subtotal|balance|debit|credit|pay|depr)/i;

/** Coerce display strings such as "12,500.00" or "UGX 1,180.00" into Excel numbers. */
export function toExcelValue(v: unknown): unknown {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  if (v instanceof Date) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  const stripped = trimmed.replace(/^(UGX|USD|EUR|GBP|KES|TZS)\s+/i, '').replace(/,/g, '');
  if (/^-?\d+(\.\d+)?$/.test(stripped)) {
    if (/^0\d+$/.test(stripped) && stripped.length > 1) return v;
    const n = Number(stripped);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

export function excelNumFmt(label: string, align?: string): string | undefined {
  if (QTY_LABEL.test(label)) return '#,##0.####';
  if (MONEY_LABEL.test(label) || align === 'right') return '#,##0.00';
  return undefined;
}

export async function renderTableXlsx(opts: BrandedTableOpts): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = opts.company.name;
  wb.company = opts.company.legalName || opts.company.name;
  wb.created = new Date(opts.issuedAt);
  const ws = wb.addWorksheet(opts.title.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().slice(0, 30) || 'Export', {
    pageSetup: {
      paperSize: 9,
      orientation: opts.columns.length > 8 ? 'landscape' : 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.2, footer: 0.2 },
    },
    headerFooter: {
      oddHeader: `&L${opts.company.name}&C${opts.title}&R${opts.docNo || ''}`,
      oddFooter: `&L${opts.company.legalName || opts.company.name}${opts.company.tin ? `  TIN ${opts.company.tin}` : ''}${opts.classification ? `  \u00b7  ${opts.classification}` : ''}&RPage &P of &N`,
    },
  });
  const navy = brandHex(opts.company.brandColor, BRAND_HEX.navy);
  const brandImages = excelBrandImages(wb, opts.company);
  applyExcelBrandHeader(ws, opts.company, {
    title: opts.title,
    subtitle: opts.subtitle,
    docNo: opts.docNo,
    issuedBy: opts.issuedBy,
    issuedAt: opts.issuedAt,
    facts: opts.facts,
    status: opts.status,
    classification: opts.classification ?? 'Internal',
    columns: Math.max(8, opts.columns.length),
  }, brandImages);
  const hr = ws.addRow(opts.columns.map((c) => c.label));
  hr.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 9 };
  hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
  hr.alignment = { vertical: 'middle' };
  opts.rows.forEach((row, i) => {
    const r = ws.addRow(opts.columns.map((c) => toExcelValue(row[c.key])));
    if (i % 2 === 1) r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8F9' } };
    r.alignment = { vertical: 'middle' };
  });
  ws.addRow([]);
  ws.addRow(['SHA-256 Fingerprint', opts.fingerprint ?? '']);
  ws.addRow(['Exported By', opts.issuedBy]);
  ws.addRow(['Exported At', formatDocDateTime(opts.issuedAt)]);
  opts.columns.forEach((col, i) => {
    const excelCol = ws.getColumn(i + 1);
    excelCol.width = Math.max(14, Math.min(36, col.label.length + 12));
    const fmt = excelNumFmt(col.label, col.align);
    if (fmt) excelCol.numFmt = fmt;
    if (col.align === 'right' || fmt) excelCol.alignment = { horizontal: 'right' };
  });
  ws.views = [{ state: 'frozen', ySplit: hr.number }];
  if (opts.columns.length) {
    ws.autoFilter = {
      from: { row: hr.number, column: 1 },
      to: { row: hr.number, column: opts.columns.length },
    };
  }
  applyExcelBrandFooter(ws, brandImages, { columns: opts.columns.length });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Company-letterhead CSV used by table dumps and management reports. */
export function renderTableCsv(
  opts: BrandedTableOpts,
  extraMeta: Array<[string, string]> = []
): string {
  const c = opts.company;
  const rows: unknown[][] = [];
  rows.push([c.name]);
  if (c.tagline) rows.push([c.tagline]);
  for (const ln of [...companyContactLines(c), ...companyRegLines(c)]) rows.push([ln]);
  if (c.footerText) rows.push([c.footerText]);
  rows.push([]);
  rows.push([opts.title.toUpperCase()]);
  if (opts.docNo) rows.push(['Document No', opts.docNo]);
  if (opts.subtitle) rows.push([opts.subtitle]);
  rows.push([`Issued by ${opts.issuedBy} on ${formatDocDateTime(opts.issuedAt)}`]);
  if (opts.classification) rows.push(['Classification', opts.classification]);
  for (const [k, v] of opts.facts ?? []) if (v) rows.push([k, v]);
  for (const [k, v] of extraMeta) if (v) rows.push([k, v]);
  rows.push([]);
  rows.push(opts.columns.map((col) => col.label));
  for (const row of opts.rows) {
    rows.push(
      opts.columns.map((col) => {
        const v = row[col.key];
        if (v == null || v === '') return '';
        if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
        return String(v);
      })
    );
  }
  if (opts.fingerprint) {
    rows.push([]);
    rows.push(['SHA-256 Fingerprint', opts.fingerprint]);
  }
  rows.push(['Exported By', opts.issuedBy]);
  rows.push(['Exported At', formatDocDateTime(opts.issuedAt)]);
  return stringify(rows, { header: false });
}
