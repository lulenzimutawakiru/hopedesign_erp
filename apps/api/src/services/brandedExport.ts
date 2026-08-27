/**
 * Shared branded table export pipeline (PDF / print HTML / XLSX).
 *
 * Reuses the PdfDoc writer, the brand palette and the company profile loader
 * so every exported table - generic data exports, management reports and
 * operational registers - renders with the same letterhead, security footer
 * and optional authenticity block as official documents.
 */

import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  BRAND,
  BRAND_HEX,
  applyExcelBrandHeader,
  brandHex,
  companyContactLines,
  companyRegLines,
  formatDocDateTime,
  hexToRgb,
  renderBrandedHtml,
  type CompanyProfile,
} from './branding.js';
import {
  BOTTOM,
  MARGIN,
  PAGE_W,
  PdfDoc,
  textWidth,
  type PdfTableColumn,
  type Rgb,
} from './pdf.js';

const GRAY = BRAND.gray;
const LINE = BRAND.line;
const INK = BRAND.ink;
const TABLE_W = PAGE_W - MARGIN * 2;

export interface BrandedTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  weight?: number;
}

export interface BrandedTableOpts {
  title: string;
  subtitle?: string;
  kicker?: string;
  docNo?: string;
  status?: string;
  classification?: string;
  company: CompanyProfile;
  issuedBy: string;
  issuedAt: string;
  correlationId?: string | null;
  facts?: Array<[string, string]>;
  columns: BrandedTableColumn[];
  rows: Array<Record<string, unknown>>;
  fingerprint?: string;
  token?: string;
  verifyUrl?: string;
}

interface DocBrand {
  navy: [number, number, number];
  teal: [number, number, number];
}

const brandOf = (c: CompanyProfile): DocBrand => ({
  navy: hexToRgb(c.brandColor, BRAND.navy),
  teal: hexToRgb(c.brandColorSecondary, BRAND.teal),
});

const authEnabled = (o: BrandedTableOpts): boolean =>
  Boolean(o.token && o.verifyUrl && o.fingerprint);

function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Compact a raw DB value into a clean printable cell string for PDF/print. */
function normalizeCellValue(v: unknown): string {
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
function wrapHard(text: string, size: number, bold: boolean, maxWidth: number): string[] {
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

function drawBrandMark(doc: PdfDoc, x: number, y: number, size: number, brand: DocBrand): void {
  doc.rect(x, y, size, size, brand.navy);
  const bar = size * 0.16;
  const inset = size * 0.2;
  doc.rect(x + inset, y + size * 0.2, bar, size * 0.6, BRAND.white);
  doc.rect(x + size - inset - bar, y + size * 0.2, bar, size * 0.6, BRAND.white);
  doc.rect(x + size * 0.2, y + size * 0.42, size * 0.6, size * 0.16, brand.teal);
  doc.rect(x + size * 0.46, y + size * 0.34, size * 0.08, size * 0.32, brand.navy);
  doc.rect(x + size * 0.36, y + size * 0.44, size * 0.32, size * 0.08, brand.navy);
}

/**
 * Read an uploaded branding asset (logo / footer-logo / signature) from local
 * storage using the tenant+company query params of its public URL. The PDF
 * writer only supports PNG/JPEG, so other formats fall back to the vector
 * brand mark when drawn.
 */
function readStoredBrandingFile(assetUrl: string, filePrefix: string): { bytes: Buffer; ext: string } | null {
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
  const dir = path.join(config.storageRoot, 'branding', tenant, company);
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

/** Read the uploaded company logo for a tenant/company from local storage. */
function readStoredLogo(logoUrl: string): { bytes: Buffer; ext: string } | null {
  return readStoredBrandingFile(logoUrl, 'logo');
}

/** Read the uploaded footer logo for a tenant/company from local storage. */
function readStoredFooterLogo(footerLogoUrl: string): { bytes: Buffer; ext: string } | null {
  return readStoredBrandingFile(footerLogoUrl, 'footer-logo');
}

/** Preload the stored company logo into the PDF and return its XObject name. */
function preloadLogo(doc: PdfDoc, logoUrl: string): string | undefined {
  if (!logoUrl) return undefined;
  const file = readStoredLogo(logoUrl);
  return file ? doc.addImage(file.bytes) ?? undefined : undefined;
}

/** Preload the stored footer logo into the PDF and return its XObject name. */
function preloadFooterLogo(doc: PdfDoc, footerLogoUrl: string): string | undefined {
  if (!footerLogoUrl) return undefined;
  const file = readStoredFooterLogo(footerLogoUrl);
  return file ? doc.addImage(file.bytes) ?? undefined : undefined;
}

function drawTopBar(doc: PdfDoc, brand: DocBrand): void {
  doc.rect(0, doc.pageHeight - 8, doc.pageWidth, 8, brand.navy);
  doc.rect(0, doc.pageHeight - 11, doc.pageWidth, 3, brand.teal);
}

function drawRunningHeader(doc: PdfDoc, opts: BrandedTableOpts, brand: DocBrand, logoName?: string): void {
  drawTopBar(doc, brand);
  const top = doc.pageHeight - 18;
  const mark = 16;
  const dims = logoName ? doc.imageDims(logoName) : null;
  let textX = MARGIN + mark + 8;
  if (dims) {
    const logoW = Math.min(90, Math.max(18, (dims.width / dims.height) * mark));
    doc.image(logoName as string, MARGIN, top - mark, logoW, mark);
    textX = MARGIN + logoW + 8;
  } else {
    drawBrandMark(doc, MARGIN, top - mark, mark, brand);
  }
  doc.rawText(opts.company.name, textX, top - 5, 8, {
    bold: true,
    color: brand.navy,
    maxWidth: doc.contentWidth * 0.55,
  });
  const right = `${opts.title.toUpperCase()}${opts.docNo ? `  ${opts.docNo}` : ''}`;
  doc.rawText(right, MARGIN, top - 5, 8, {
    align: 'right',
    maxWidth: doc.contentWidth,
    color: GRAY,
    bold: true,
  });
  doc.line(MARGIN, top - 22, MARGIN + doc.contentWidth, top - 22, brand.navy, 1.2);
  doc.line(MARGIN, top - 24.2, MARGIN + doc.contentWidth, top - 24.2, brand.teal, 0.7);
  doc.cursorY = top - 34;
}

function drawLetterhead(doc: PdfDoc, opts: BrandedTableOpts, brand: DocBrand, logoName?: string): void {
  const c = opts.company;
  drawTopBar(doc, brand);
  const logoSize = 30;
  const top = doc.pageHeight - 18;
  const logoY = top - logoSize - 6;
  const dims = logoName ? doc.imageDims(logoName) : null;
  let textX = MARGIN + logoSize + 11;
  if (dims) {
    const logoW = Math.min(110, Math.max(20, (dims.width / dims.height) * logoSize));
    doc.image(logoName as string, MARGIN, logoY, logoW, logoSize);
    textX = MARGIN + logoW + 11;
  } else {
    drawBrandMark(doc, MARGIN, logoY, logoSize, brand);
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
  let ry = top - 4;
  doc.rawText((opts.kicker ?? 'Official export').toUpperCase(), rightX, ry, 6.2, {
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

function drawFacts(doc: PdfDoc, items: Array<[string, string]>, brand: DocBrand): void {
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
  const footerLogoName = preloadFooterLogo(doc, opts.company.footerLogoUrl);

  doc.setNewPageHandler(() => drawRunningHeader(doc, opts, brand, logoName));
  drawLetterhead(doc, opts, brand, logoName);

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
  });
  const hr = ws.addRow(opts.columns.map((c) => c.label));
  hr.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 9 };
  hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
  hr.alignment = { vertical: 'middle' };
  opts.rows.forEach((row, i) => {
    const r = ws.addRow(opts.columns.map((c) => (row[c.key] == null ? '' : row[c.key])));
    if (i % 2 === 1) r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8F9' } };
  });
  ws.addRow([]);
  ws.addRow(['SHA-256 Fingerprint', opts.fingerprint ?? '']);
  ws.addRow(['Exported By', opts.issuedBy]);
  ws.addRow(['Exported At', formatDocDateTime(opts.issuedAt)]);
  opts.columns.forEach((_, i) => {
    ws.getColumn(i + 1).width = 18;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
