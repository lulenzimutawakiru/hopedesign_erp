/**
 * Minimal dependency-free PDF writer used for document downloads.
 * Renders the standard-14 Helvetica fonts with WinAnsiEncoding, so no fonts
 * need to be embedded and Latin-1 / common typographic characters are kept.
 *
 * Graphics operators are wrapped in q/Q so fill/stroke colour never leaks
 * between text, rules and filled shapes.
 */
import { deflateSync, inflateSync } from 'node:zlib';

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN = 48;
export const BOTTOM = 54;

export type PdfOrientation = 'portrait' | 'landscape';

export type Rgb = [number, number, number];

export interface PdfTextStyle {
  bold?: boolean;
  color?: Rgb;
  maxWidth?: number;
  align?: 'left' | 'right' | 'center';
}

export interface PdfTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  weight?: number;
}

export interface PdfTableOptions {
  x: number;
  width: number;
  columns: PdfTableColumn[];
  rows: Array<Record<string, unknown>>;
  size?: number;
  headerSize?: number;
  cellPadding?: number;
  headerFill?: Rgb;
  headerColor?: Rgb;
  zebra?: boolean;
  zebraFill?: Rgb;
  grid?: 'none' | 'horizontal' | 'full';
  lineColor?: Rgb;
}

export interface PdfDocMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date;
}

// Helvetica regular advance widths for chars 32..126 (units of 1/1000 em).
const REG = '278278355556556889667191333333389584278333278278556556556556556556556556556556' +
  '278278584584584556101566766772272266761177872227850066755683372277866777872266761' +
  '172266794466766761127827827846955633355655650055655627855655622222250022283355655' +
  '6556556333500278556500722500500500334260334584';
const BOLD_SCALE = 1.05;

function charWidth(ch: string, size: number, bold: boolean): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 32 && code <= 126) {
    const w = Number(REG.slice((code - 32) * 3, (code - 32) * 3 + 3));
    return (w / 1000) * size * (bold ? BOLD_SCALE : 1);
  }
  return size * (bold ? 0.62 : 0.56);
}

export function textWidth(text: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of String(text)) w += charWidth(ch, size, bold);
  return w;
}

export function wrapText(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (!cur || textWidth(candidate, size, bold) <= maxWidth) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Wrap text for table cells: like wrapText but hard-breaks words that exceed
 * maxWidth so cell contents never overflow the column.
 */
function wrapCellText(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const out: string[] = [];
  let line = '';
  const flush = (): void => {
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
    const candidate = line ? `${line} ${w}` : w;
    if (!line || textWidth(candidate, size, bold) <= maxWidth) line = candidate;
    else {
      out.push(line);
      line = w;
    }
  }
  flush();
  return out.length ? out : [''];
}

/**
 * Compute per-column widths for a table. Explicit weights win; otherwise the
 * available width is split proportionally to each column's natural text width
 * (header + sampled cell content) so narrow fields stay narrow and long text
 * gets room instead of cramming into word-by-word wraps.
 */
function tableColWidths(
  width: number,
  columns: PdfTableColumn[],
  rows: Array<Record<string, unknown>>,
  size: number,
  headerSize: number,
  pad: number
): number[] {
  const count = columns.length || 1;
  if (columns.some((c) => c.weight !== undefined)) {
    const totalW = columns.reduce((a, c) => a + (c.weight ?? 1), 0);
    return columns.map((c) => (width * (c.weight ?? 1)) / totalW);
  }
  const sample = rows.slice(0, 80);
  const naturals = columns.map((c) => {
    let nw = textWidth(c.label, headerSize, true) + pad * 2;
    for (const r of sample) {
      const v = r[c.key] == null ? '' : String(r[c.key]);
      nw = Math.max(nw, Math.min(textWidth(v, size, false), 240) + pad * 2);
    }
    return Math.min(nw, 280);
  });
  const sum = naturals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return columns.map(() => width / count);
  if (sum <= width) {
    const leftover = width - sum;
    return naturals.map((nw) => nw + (leftover * nw) / sum);
  }
  const minW = Math.min(28, width / count);
  const scaled = naturals.map((nw) => Math.max(minW, (nw * width) / sum));
  const scaledSum = scaled.reduce((a, b) => a + b, 0);
  return scaled.map((w) => (w / scaledSum) * width);
}

// Unicode -> WinAnsi byte map for the C1-range typographic characters.
const WIN_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

function toWinAnsi(s: string): string {
  const out: number[] = [];
  for (const ch of String(s)) {
    const code = ch.codePointAt(0) ?? 0x3f;
    let b: number;
    if (code >= 0x20 && code <= 0x7e) b = code;
    else if (code >= 0xa0 && code <= 0xff) b = code;
    else if (WIN_EXTRA[code] !== undefined) b = WIN_EXTRA[code];
    else if (code === 0xa0 || code === 0x2011 || code === 0x2212) b = 0x2d;
    else b = 0x3f;
    out.push(b);
  }
  return Buffer.from(out).toString('latin1');
}

/** PDF /Info date: D:YYYYMMDDHHmmSS+HH'mm (local time). */
function formatPdfDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}'${pad(abs % 60)}`
  );
}

function pdfString(s: string): string {
  return '(' + toWinAnsi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function rgb(color: Rgb, stroke = false): string {
  return `${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} ${stroke ? 'RG' : 'rg'}`;
}

interface PdfImage {
  name: string;
  width: number;
  height: number;
  filter: 'DCTDecode' | 'FlateDecode';
  bytes: string;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) {
      i += 2;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

function decodePngRgb(buf: Buffer): { width: number; height: number; rgb: Buffer } | null {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idats: Buffer[] = [];
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) return null;
    } else if (type === 'IDAT') {
      idats.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }
  if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || idats.length === 0) return null;
  if (width > 4000 || height > 4000) return null;
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idats));
  } catch {
    return null;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const rgb = Buffer.alloc(width * height * 3);
  let src = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    if (src + 1 + stride > inflated.length) return null;
    const filter = inflated[src];
    src += 1;
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const raw = inflated[src + i];
      const a = i >= bpp ? recon[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) pred = paeth(a, b, c);
      else if (filter !== 0) return null;
      recon[i] = (raw + pred) & 255;
    }
    src += stride;
    for (let x = 0; x < width; x++) {
      const si = x * bpp;
      const di = (y * width + x) * 3;
      if (colorType === 6) {
        const alpha = recon[si + 3] / 255;
        rgb[di] = Math.round(recon[si] * alpha + 255 * (1 - alpha));
        rgb[di + 1] = Math.round(recon[si + 1] * alpha + 255 * (1 - alpha));
        rgb[di + 2] = Math.round(recon[si + 2] * alpha + 255 * (1 - alpha));
      } else {
        rgb[di] = recon[si];
        rgb[di + 1] = recon[si + 1];
        rgb[di + 2] = recon[si + 2];
      }
    }
    prev = recon;
  }
  return { width, height, rgb };
}

export class PdfDoc {
  readonly pageW: number;
  readonly pageH: number;
  private pages: string[][] = [[]];
  private y: number;
  private pageIndex = 0;
  private meta: PdfDocMetadata = {};
  private newPageHandler: (() => void) | null = null;
  private images: PdfImage[] = [];
  private imageSeq = 0;

  constructor(opts: { orientation?: PdfOrientation } = {}) {
    const landscape = opts.orientation === 'landscape';
    this.pageW = landscape ? PAGE_H : PAGE_W;
    this.pageH = landscape ? PAGE_W : PAGE_H;
    this.y = this.pageH - MARGIN;
  }

  get pageWidth(): number {
    return this.pageW;
  }

  get pageHeight(): number {
    return this.pageH;
  }

  get contentWidth(): number {
    return this.pageW - MARGIN * 2;
  }

  setMetadata(meta: PdfDocMetadata): void {
    this.meta = { ...this.meta, ...meta };
  }

  setNewPageHandler(fn: () => void): void {
    this.newPageHandler = fn;
  }

  get cursorY(): number {
    return this.y;
  }

  set cursorY(v: number) {
    this.y = v;
  }

  get currentPage(): number {
    return this.pageIndex;
  }

  newPage(): void {
    this.pages.push([]);
    this.pageIndex += 1;
    this.y = this.pageH - MARGIN;
    if (this.newPageHandler) this.newPageHandler();
  }

  pageCount(): number {
    return this.pages.length;
  }

  op(s: string): void {
    this.pages[this.pageIndex].push(s);
  }

  ensure(needed: number): void {
    if (this.y - needed < BOTTOM) this.newPage();
  }

  text(text: string, x: number, size = 10, style: PdfTextStyle = {}): number {
    const bold = style.bold ?? false;
    const maxW = style.maxWidth ?? this.pageW - MARGIN * 2;
    const lines = wrapText(text, size, bold, maxW);
    const font = bold ? 'F2' : 'F1';
    const color: Rgb = style.color ?? [0.09, 0.168, 0.227];
    for (const line of lines) {
      this.ensure(size * 1.45);
      const w = textWidth(line, size, bold);
      let tx = x;
      if (style.align === 'right') tx = x + maxW - w;
      else if (style.align === 'center') tx = x + (maxW - w) / 2;
      this.op(`q ${rgb(color)} BT /${font} ${size} Tf 1 0 0 1 ${fmt(tx)} ${fmt(this.y)} Tm ${pdfString(line)} Tj ET Q`);
      this.y -= size * 1.42;
    }
    return this.y;
  }

  /**
   * Paint a single pre-wrapped line at an exact baseline without affecting the
   * cursor flow or triggering page breaks. Used for boxes whose height is
   * computed up front (e.g. the document authenticity block).
   */
  rawText(text: string, x: number, y: number, size: number, style: PdfTextStyle = {}): void {
    const bold = style.bold ?? false;
    const maxW = style.maxWidth ?? this.pageW - MARGIN * 2;
    const w = textWidth(text, size, bold);
    let tx = x;
    if (style.align === 'right') tx = x + maxW - w;
    else if (style.align === 'center') tx = x + (maxW - w) / 2;
    const font = bold ? 'F2' : 'F1';
    const color: Rgb = style.color ?? [0.09, 0.168, 0.227];
    this.op(`q ${rgb(color)} BT /${font} ${size} Tf 1 0 0 1 ${fmt(tx)} ${fmt(y)} Tm ${pdfString(text)} Tj ET Q`);
  }

  line(x1: number, y1: number, x2: number, y2: number, color?: Rgb, width = 0.6): void {
    const c: Rgb = color ?? [0.85, 0.88, 0.91];
    this.op(`q ${fmt(width)} w ${rgb(c, true)} ${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S Q`);
  }

  rect(x: number, y: number, w: number, h: number, fill?: Rgb): void {
    const c: Rgb = fill ?? [0, 0, 0];
    this.op(`q ${rgb(c)} ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re f Q`);
  }

  strokeRect(x: number, y: number, w: number, h: number, color: Rgb = [0.85, 0.88, 0.91], width = 0.6): void {
    this.op(`q ${fmt(width)} w ${rgb(color, true)} ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re S Q`);
  }

  fillStrokeRect(x: number, y: number, w: number, h: number, fill: Rgb, stroke: Rgb, width = 0.6): void {
    this.op(`q ${fmt(width)} w ${rgb(fill)} ${rgb(stroke, true)} ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re B Q`);
  }

  /**
   * Draw a branded footer (company line, issued-by line, page numbers) at the
   * bottom of every page. Drawn after content so it never affects layout flow.
   */
  footer(lines: string[], opts: { size?: number; color?: Rgb; navy?: Rgb; accent?: Rgb; logoName?: string } = {}): void {
    const size = opts.size ?? 7;
    const color: Rgb = opts.color ?? [0.42, 0.47, 0.52];
    const navy: Rgb = opts.navy ?? [0.043, 0.122, 0.2];
    const accent: Rgb = opts.accent ?? [0, 0.651, 0.651];
    const ruleY = BOTTOM - 6;
    const logo = opts.logoName ? this.images.find((im) => im.name === opts.logoName) : undefined;
    const logoH = 7;
    const logoW = logo ? Math.min(120, Math.max(18, (logo.width / logo.height) * logoH)) : 0;
    const textX = MARGIN + (logoW ? logoW + 8 : 0);
    for (let p = 0; p < this.pages.length; p++) {
      const page = this.pages[p];
      page.push(`q 1.6 w ${rgb(navy, true)} ${fmt(MARGIN)} ${fmt(ruleY)} m ${fmt(this.pageW - MARGIN)} ${fmt(ruleY)} l S Q`);
      page.push(`q 0.7 w ${rgb(accent, true)} ${fmt(MARGIN)} ${fmt(ruleY - 2.2)} m ${fmt(this.pageW - MARGIN)} ${fmt(ruleY - 2.2)} l S Q`);
      if (logo) page.push(`q ${fmt(logoW)} 0 0 ${fmt(logoH)} ${fmt(MARGIN)} ${fmt(ruleY - 2.2 - logoH)} cm /${logo.name} Do Q`);
      lines.forEach((ln, i) => {
        const ly = ruleY - 4 - (i + 1) * size * 1.28;
        page.push(`q ${rgb(color)} BT /F1 ${size} Tf 1 0 0 1 ${fmt(textX)} ${fmt(ly)} Tm ${pdfString(ln)} Tj ET Q`);
      });
      const pageLabel = `Page ${p + 1} of ${this.pages.length}`;
      const pw = textWidth(pageLabel, size, false);
      page.push(`q ${rgb(color)} BT /F1 ${size} Tf 1 0 0 1 ${fmt(this.pageW - MARGIN - pw)} ${fmt(ruleY - 4 - size * 1.28)} Tm ${pdfString(pageLabel)} Tj ET Q`);
    }
  }

  /**
   * Draw a professional security watermark on every page: the label text is
   * repeated in a fine, brick-staggered diagonal grid across the page (an
   * anti-copy security background) behind a larger centered rotated label
   * (e.g. "CONFIDENTIAL"). The watermark ops are unshifted to the start of
   * each page content stream so it paints behind body text, headers, tables
   * and the footer.
   */
  watermark(text: string, opts: { size?: number; color?: Rgb; angle?: number } = {}): void {
    const labelSize = opts.size ?? 48;
    const color: Rgb = opts.color ?? [0.965, 0.97, 0.975];
    const angle = opts.angle ?? 0.45;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const patternSize = Math.max(10, Math.round(labelSize * 0.35));
    const tileW = textWidth(text, patternSize, true) + patternSize * 2.4;
    const rowH = patternSize * 1.9;
    const rows = Math.ceil(this.pageH / rowH) + 2;
    const cols = Math.ceil((this.pageW + tileW) / tileW) + 1;
    const tiles: string[] = [];
    for (let r = 0; r < rows; r++) {
      const stagger = (r % 2) * (tileW / 2) - (this.pageW / 2);
      const y = this.pageH - MARGIN - r * rowH;
      for (let c = 0; c < cols; c++) {
        const x = this.pageW / 2 + c * tileW + stagger;
        tiles.push(`${fmt(cos)} ${fmt(sin)} ${fmt(-sin)} ${fmt(cos)} ${fmt(x)} ${fmt(y)} Tm ${pdfString(text)} Tj`);
      }
    }
    const w = textWidth(text, labelSize, true);
    const cx = this.pageW / 2;
    const cy = this.pageH / 2;
    const tx = cx - (w * cos) / 2;
    const ty = cy - (w * sin) / 2;
    for (let p = 0; p < this.pages.length; p++) {
      this.pages[p].unshift(
        `q ${rgb(color)} BT /F2 ${patternSize} Tf ${tiles.join('\n')} ET Q`,
        `q ${rgb(color)} BT /F2 ${labelSize} Tf ` +
          `${fmt(cos)} ${fmt(sin)} ${fmt(-sin)} ${fmt(cos)} ${fmt(tx)} ${fmt(ty)} Tm ` +
          `${pdfString(text)} Tj ET Q`
      );
    }
  }

  table(opts: PdfTableOptions): number {
    const { x, width, columns, rows } = opts;
    const size = opts.size ?? 8.5;
    const headerSize = opts.headerSize ?? 8;
    const pad = opts.cellPadding ?? 5.5;
    const lh = 1.32;
    const headerFill: Rgb = opts.headerFill ?? [0.043, 0.122, 0.2];
    const headerColor: Rgb = opts.headerColor ?? [1, 1, 1];
    const zebra = opts.zebra ?? true;
    const zebraFill: Rgb = opts.zebraFill ?? [0.965, 0.972, 0.978];
    const grid = opts.grid ?? 'horizontal';
    const lineColor: Rgb = opts.lineColor ?? [0.85, 0.88, 0.91];
    const colW = tableColWidths(width, columns, rows, size, headerSize, pad);
    const cellX = columns.map((_c, i) => x + colW.slice(0, i).reduce((a, b) => a + b, 0));
    const wrapCell = (v: unknown, w: number, s: number, bold: boolean): string[] =>
      wrapCellText(v == null ? '' : String(v), s, bold, Math.max(12, w - pad * 2));
    const headerLines = columns.map((c, i) => wrapCell(c.label, colW[i], headerSize, true));
    const headerH = Math.max(...headerLines.map((l) => l.length)) * headerSize * lh + pad * 2;
    const paintHeader = (): void => {
      this.ensure(headerH + 4);
      this.rect(x, this.y - headerH, width, headerH, headerFill);
      for (let i = 0; i < columns.length; i++) {
        let cy = this.y - pad - headerSize;
        for (const ln of headerLines[i]) {
          const w = textWidth(ln, headerSize, true);
          const tx = columns[i].align === 'right' ? cellX[i] + colW[i] - pad - w : cellX[i] + pad;
          this.op(`q ${rgb(headerColor)} BT /F2 ${headerSize} Tf 1 0 0 1 ${fmt(tx)} ${fmt(cy)} Tm ${pdfString(ln)} Tj ET Q`);
          cy -= headerSize * lh;
        }
      }
      this.y -= headerH;
    };
    paintHeader();
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const lines = columns.map((c, i) => wrapCell(row[c.key] == null ? '' : String(row[c.key]), colW[i], size, false));
      const rowH = Math.max(...lines.map((l) => l.length), 1) * size * lh + pad * 2;
      if (this.y - rowH < BOTTOM) {
        this.newPage();
        paintHeader();
      }
      if (zebra && ri % 2 === 1) {
        this.rect(x, this.y - rowH, width, rowH, zebraFill);
      }
      for (let i = 0; i < columns.length; i++) {
        let cy = this.y - pad - size;
        for (const ln of lines[i]) {
          const w = textWidth(ln, size, false);
          const tx = columns[i].align === 'right' ? cellX[i] + colW[i] - pad - w : cellX[i] + pad;
          this.op(`q 0.09 0.168 0.227 rg BT /F1 ${size} Tf 1 0 0 1 ${fmt(tx)} ${fmt(cy)} Tm ${pdfString(ln)} Tj ET Q`);
          cy -= size * lh;
        }
      }
      this.y -= rowH;
      if (grid !== 'none') {
        this.line(x, this.y, x + width, this.y, lineColor, 0.35);
      }
    }
    if (grid === 'full') {
      this.strokeRect(x, this.y, width, 0.01, lineColor, 0.4);
    }
    this.line(x, this.y, x + width, this.y, [0.043, 0.122, 0.2], 0.8);
    return this.y;
  }

  /** Embed a JPEG or PNG and return its XObject name, or null if it cannot be used. */
  addImage(buf: Buffer): string | null {
    const jpeg = jpegSize(buf);
    if (jpeg && jpeg.width > 0 && jpeg.height > 0) {
      this.imageSeq += 1;
      const name = 'Im' + this.imageSeq;
      this.images.push({
        name,
        width: jpeg.width,
        height: jpeg.height,
        filter: 'DCTDecode',
        bytes: buf.toString('latin1'),
      });
      return name;
    }
    const png = decodePngRgb(buf);
    if (!png) return null;
    const compressed = deflateSync(png.rgb);
    this.imageSeq += 1;
    const name = 'Im' + this.imageSeq;
    this.images.push({
      name,
      width: png.width,
      height: png.height,
      filter: 'FlateDecode',
      bytes: compressed.toString('latin1'),
    });
    return name;
  }

  /** Draw an embedded image. x/y is the lower-left corner in PDF space. */
  image(name: string, x: number, y: number, w: number, h: number): void {
    if (!this.images.some((im) => im.name === name)) return;
    this.op(`q ${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(y)} cm /${name} Do Q`);
  }

  /** Return the pixel dimensions of an embedded image, or null when unknown. */
  imageDims(name: string): { width: number; height: number } | null {
    const im = this.images.find((entry) => entry.name === name);
    return im ? { width: im.width, height: im.height } : null;
  }

  build(): Buffer {
    const pageCount = this.pages.length;
    const font1 = 3 + pageCount;
    const font2 = font1 + 1;
    const imageStart = font2 + 1;
    const contentStart = imageStart + this.images.length;
    const xobjects = this.images
      .map((im, i) => `/${im.name} ${imageStart + i} 0 R`)
      .join(' ');
    const objects: string[] = [];
    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push(`<< /Type /Pages /Kids [${this.pages.map((_p, i) => `${3 + i} 0 R`).join(' ')}] /Count ${pageCount} >>`);
    for (let i = 0; i < pageCount; i++) {
      const xo = xobjects ? ` /XObject << ${xobjects} >>` : '';
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.pageW} ${this.pageH}] ` +
        `/Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >>${xo} >> /Contents ${contentStart + i} 0 R >>`);
    }
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    for (const im of this.images) {
      objects.push(
        `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${im.filter} /Length ${im.bytes.length} >>\n` +
          `stream\n${im.bytes}\nendstream`
      );
    }
    for (const ops of this.pages) {
      const stream = ops.join('\n');
      objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    }
    const meta = this.meta;
    const created = meta.creationDate ?? new Date();
    const info: Array<[string, string]> = [];
    if (meta.title) info.push(['/Title', pdfString(meta.title)]);
    if (meta.author) info.push(['/Author', pdfString(meta.author)]);
    if (meta.subject) info.push(['/Subject', pdfString(meta.subject)]);
    if (meta.keywords) info.push(['/Keywords', pdfString(meta.keywords)]);
    if (meta.creator) info.push(['/Creator', pdfString(meta.creator)]);
    if (meta.producer) info.push(['/Producer', pdfString(meta.producer)]);
    info.push(['/CreationDate', pdfString(formatPdfDate(created))]);
    info.push(['/ModDate', pdfString(formatPdfDate(created))]);
    objects.push(`<< ${info.map(([k, v]) => `${k} ${v}`).join(' ')} >>`);
    const infoRef = objects.length;
    const parts: string[] = ['%PDF-1.4\n'];
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(parts.join(''), 'latin1'));
      parts.push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
    }
    const xrefStart = Buffer.byteLength(parts.join(''), 'latin1');
    parts.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
    for (const off of offsets) parts.push(`${String(off).padStart(10, '0')} 00000 n \n`);
    parts.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoRef} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
    return Buffer.from(parts.join(''), 'latin1');
  }
}

/**
 * Zero-dependency PDF inspection for CV/document processing.
 * Extracts version, page count, encryption flag, Info metadata and a text
 * excerpt from content streams (FlateDecode or uncompressed). Best-effort
 * parser: malformed-but-plausible PDFs degrade gracefully instead of throwing.
 */

export interface PdfMetadata {
  title: string | null;
  author: string | null;
}

export interface PdfParseResult {
  ok: boolean;
  error?: string;
  version: string | null;
  pageCount: number;
  encrypted: boolean;
  metadata: PdfMetadata;
  text: string;
  textLength: number;
}

const MAX_TEXT_CHARS = 50_000;
const STREAM_RE = /<<([^>]*)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
const TEXT_OP_RE = /\(((?:[^()\\]|\\.)*)\)\s*Tj|\[((?:[^\]\\]|\\.)*)\]\s*TJ/g;
const TJ_ITEM_RE = /\(((?:[^()\\]|\\.)*)\)/g;

function decodePdfString(raw: string): string {
  return raw
    .replace(/\\([nrtbf])/g, (_m, c: string) =>
      c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === 'b' ? '\b' : '\f'
    )
    .replace(/\\([0-7]{1,3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\(.)/g, '$1');
}

function extractText(content: string): string {
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  TEXT_OP_RE.lastIndex = 0;
  while ((m = TEXT_OP_RE.exec(content)) !== null) {
    if (m[1] !== undefined) {
      parts.push(decodePdfString(m[1]));
    } else if (m[2] !== undefined) {
      const items: string[] = [];
      let im: RegExpExecArray | null;
      TJ_ITEM_RE.lastIndex = 0;
      while ((im = TJ_ITEM_RE.exec(m[2])) !== null) items.push(decodePdfString(im[1]));
      parts.push(items.join(' '));
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function parsePdf(buffer: Buffer): PdfParseResult {
  const latin = buffer.toString('latin1');
  const versionMatch = /^%PDF-(\d\.\d)/.exec(latin);
  if (!versionMatch) {
    return {
      ok: false,
      error: 'Not a valid PDF file',
      version: null,
      pageCount: 0,
      encrypted: false,
      metadata: { title: null, author: null },
      text: '',
      textLength: 0,
    };
  }
  if (!latin.includes('%%EOF')) {
    return {
      ok: false,
      error: 'Truncated PDF file (missing EOF marker)',
      version: versionMatch[1],
      pageCount: 0,
      encrypted: false,
      metadata: { title: null, author: null },
      text: '',
      textLength: 0,
    };
  }

  const encrypted = /\/Encrypt\s/.test(latin);

  let pageCount = 0;
  const pagesCount = /\/Type\s*\/Pages[\s\S]{0,4096}?\/Count\s+(\d+)/.exec(latin);
  if (pagesCount) {
    pageCount = Math.max(1, parseInt(pagesCount[1], 10) || 0);
  } else {
    const pages = latin.match(/\/Type\s*\/Page\b(?!s)/g);
    if (pages) pageCount = pages.length;
  }

  const titleMatch = /\/Title\s*\(((?:[^()\\]|\\.)*)\)/.exec(latin);
  const authorMatch = /\/Author\s*\(((?:[^()\\]|\\.)*)\)/.exec(latin);

  const texts: string[] = [];
  let sm: RegExpExecArray | null;
  STREAM_RE.lastIndex = 0;
  while ((sm = STREAM_RE.exec(latin)) !== null) {
    const dict = sm[1] ?? '';
    const raw = sm[2] ?? '';
    let content = raw;
    if (/FlateDecode/.test(dict)) {
      try {
        content = inflateSync(Buffer.from(raw, 'latin1')).toString('latin1');
      } catch {
        content = '';
      }
    }
    if (content) {
      const t = extractText(content);
      if (t) texts.push(t);
      if (texts.join(' ').length >= MAX_TEXT_CHARS) break;
    }
  }

  const text = texts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);

  return {
    ok: true,
    version: versionMatch[1],
    pageCount,
    encrypted,
    metadata: {
      title: titleMatch ? decodePdfString(titleMatch[1]).trim() || null : null,
      author: authorMatch ? decodePdfString(authorMatch[1]).trim() || null : null,
    },
    text,
    textLength: text.length,
  };
}
