import pg from 'pg';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { Ctx } from '../db.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../utils.js';
import { logAudit } from './audit.js';

/**
 * Niimbot label spool.
 *
 * Renders ream/carton labels as 300 DPI PNGs sized for Niimbot label rolls,
 * persists them under the storage root and exposes a printer-bridge queue.
 * A companion bridge polls GET /api/qr/labels/spool, prints on the Niimbot
 * and acknowledges each label via /printed (or /failed).
 *
 * The QR payload (code|secret) is required when spooling so that the printed
 * label always carries the unforgeable authenticity payload; the secret is
 * verified against the stored hash before the label is rendered.
 */

const DPI = 300;
const PX_PER_MM = DPI / 25.4;

const LABEL_MM: Record<string, { width: number; height: number }> = {
  REAM: { width: 40, height: 25 },
  CARTON: { width: 60, height: 40 },
};

// ------------------------------------------------------------------ PNG encode

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Minimal RGBA PNG encoder (no external image deps). */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ tiny font

/** 5x7 bitmap font (uppercase letters, digits and label punctuation). */
const FONT: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1e, 0x01, 0x01, 0x0e, 0x01, 0x01, 0x1e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x10, 0x1e, 0x01, 0x01, 0x1e],
  '6': [0x0e, 0x10, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x01, 0x0e],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
};

function textWidth(text: string, scale: number): number {
  return text.length * 6 * scale;
}

function drawText(
  rgba: Buffer,
  width: number,
  x: number,
  y: number,
  text: string,
  scale: number,
  maxWidth?: number
): number {
  let cx = x;
  let remaining = text.toUpperCase();
  if (maxWidth != null) {
    const maxChars = Math.max(1, Math.floor(maxWidth / (6 * scale)));
    remaining = remaining.slice(0, maxChars);
  }
  for (const ch of remaining) {
    const g = FONT[ch] ?? FONT[' '];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if ((g[r] >> (4 - c)) & 1) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = cx + c * scale + dx;
              const py = y + r * scale + dy;
              if (px >= 0 && py >= 0 && px < width) {
                const i = (py * width + px) * 4;
                rgba[i] = 0;
                rgba[i + 1] = 0;
                rgba[i + 2] = 0;
                rgba[i + 3] = 255;
              }
            }
          }
        }
      }
    }
    cx += 6 * scale;
  }
  return cx - x;
}

function drawQr(rgba: Buffer, width: number, x: number, y: number, box: number, payload: string): void {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const modules = qr.modules.size;
  const quiet = 2;
  const modulePx = Math.max(1, Math.floor((box - quiet * 2) / (modules + quiet * 2)));
  const sizePx = (modules + quiet * 2) * modulePx;
  const offX = x + Math.floor((box - sizePx) / 2);
  const offY = y + Math.floor((box - sizePx) / 2);
  const data = qr.modules.data as Uint8Array;
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (data[row * modules + col] !== 1) continue;
      for (let dy = 0; dy < modulePx; dy++) {
        for (let dx = 0; dx < modulePx; dx++) {
          const px = offX + (col + quiet) * modulePx + dx;
          const py = offY + (row + quiet) * modulePx + dy;
          if (px >= 0 && py >= 0 && px < width) {
            const i = (py * width + px) * 4;
            rgba[i] = 0;
            rgba[i + 1] = 0;
            rgba[i + 2] = 0;
            rgba[i + 3] = 255;
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------ rendering

export interface LabelRenderInput {
  /** code|secret payload encoded into the QR (required for authenticity). */
  payload: string;
  /** Human readable QR code shown under the QR (e.g. HDG-RE-2026-00000001). */
  qrText?: string;
  /** Header text, e.g. REAM or CARTON. */
  title: string;
  /** Text column lines (product, batch, specs). */
  lines: string[];
  widthMm: number;
  heightMm: number;
}

export function renderLabelPng(input: LabelRenderInput): Buffer {
  const width = Math.max(64, Math.round(input.widthMm * PX_PER_MM));
  const height = Math.max(64, Math.round(input.heightMm * PX_PER_MM));
  const rgba = Buffer.alloc(width * height * 4, 0xff); // white background

  const qrSize = Math.min(Math.round(height * 0.72), Math.round(width * 0.5));
  const qrX = Math.round(width * 0.03);
  const qrY = 16;
  drawQr(rgba, width, qrX, qrY, qrSize, input.payload);

  const titleY = 8;
  drawText(rgba, width, qrX, titleY, input.title, 2);

  const textX = qrX + qrSize + 14;
  const textW = width - textX - 12;
  let lineY = 14;
  for (const line of input.lines) {
    drawText(rgba, width, textX, lineY, line, 2, textW);
    lineY += 20;
    if (lineY > height - 16) break;
  }

  if (input.qrText) {
    const tw = textWidth(input.qrText, 1);
    drawText(rgba, width, qrX + Math.max(0, Math.floor((qrSize - tw) / 2)), qrY + qrSize + 6, input.qrText, 1, qrSize);
  }

  return encodePng(width, height, rgba);
}

// ------------------------------------------------------------------ spool API

export interface SpoolItem {
  qrId: number;
  payload: string;
}

export interface SpooledLabel {
  id: number;
  labelNo: string;
  qrId: number;
  code: string;
  payload: string;
  imageDataUrl: string;
}

async function labelContent(
  client: pg.PoolClient,
  qr: { id: number; entity_type: string; product_code: string | null; batch_no: string | null }
): Promise<{ title: string; lines: string[]; mm: { width: number; height: number } }> {
  const base = [
    qr.product_code ? `PRODUCT ${qr.product_code}` : '',
    qr.batch_no ? `BATCH ${qr.batch_no}` : '',
  ].filter(Boolean);

  if (qr.entity_type === 'REAM') {
    const res = await client.query(
      `SELECT ream_no, sheets, gsm FROM reams WHERE qr_id = $1`,
      [qr.id]
    );
    const row = res.rows[0] ?? {};
    return {
      title: 'REAM',
      lines: [
        ...base,
        row.ream_no ? `REAM ${row.ream_no}` : '',
        row.sheets ? `SHEETS ${row.sheets}` : '',
        row.gsm ? `GSM ${row.gsm}` : '',
      ].filter(Boolean),
      mm: LABEL_MM.REAM,
    };
  }
  if (qr.entity_type === 'CARTON') {
    const res = await client.query(
      `SELECT carton_no, ream_count FROM cartons WHERE qr_id = $1`,
      [qr.id]
    );
    const row = res.rows[0] ?? {};
    return {
      title: 'CARTON',
      lines: [
        ...base,
        row.carton_no ? `CARTON ${row.carton_no}` : '',
        row.ream_count ? `REAMS ${row.ream_count}` : '',
      ].filter(Boolean),
      mm: LABEL_MM.CARTON,
    };
  }
  return { title: String(qr.entity_type ?? 'LABEL'), lines: base, mm: LABEL_MM.REAM };
}

/**
 * Render + queue labels for the Niimbot bridge. The payload (code|secret) is
 * validated against the QR's stored hash before the label is generated.
 */
export async function spoolLabels(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { items: SpoolItem[]; templateId?: number | null }
): Promise<{ jobNo: string; jobId: number; labels: SpooledLabel[] }> {
  const companyId = ctx.companyId ?? null;
  const tenantId = ctx.tenantId ?? null;
  if (!companyId || !tenantId) throw badRequest('Company context required');

  const items = [...new Map((input.items ?? []).map((it) => [Number(it.qrId), it]).entries()).values()].filter(
    (it) => Number.isFinite(Number(it.qrId)) && typeof it.payload === 'string' && it.payload.length > 0
  );
  if (items.length === 0) throw badRequest('items (qrId + payload) are required');

  const jobNoRes = await client.query('SELECT next_doc_no($1,$2,8) AS code', [tenantId, 'LBL']);
  const jobNo = String(jobNoRes.rows[0].code);
  const jobRes = await client.query(
    `INSERT INTO label_print_jobs (company_id, tenant_id, job_no, template_id, count, status, requested_by)
     VALUES ($1,$2,$3,$4,$5,'QUEUED',$6) RETURNING id`,
    [companyId, tenantId, jobNo, input.templateId ?? null, items.length, ctx.userId ?? null]
  );
  const jobId = Number(jobRes.rows[0].id);

  const labels: SpooledLabel[] = [];
  for (const item of items) {
    const qrRes = await client.query(
      `SELECT q.id, q.code, q.secret_hash, q.entity_type, p.code AS product_code, pb.batch_no
       FROM qr_codes q
       LEFT JOIN products p ON p.id = q.product_id
       LEFT JOIN product_batches pb ON pb.id = q.batch_id
       WHERE q.id = $1 AND q.tenant_id = $2`,
      [Number(item.qrId), tenantId]
    );
    if (qrRes.rows.length === 0) throw badRequest(`QR id ${item.qrId} not found`);
    const qr = qrRes.rows[0];

    const [codePart, secretPart] = String(item.payload).split('|');
    if (!codePart || !secretPart || codePart !== qr.code) {
      throw badRequest(`Payload does not match QR ${qr.code}`);
    }
    const hash = createHash('sha256').update(secretPart).digest('hex');
    if (hash !== qr.secret_hash) throw badRequest(`Invalid secret for QR ${qr.code}`);

    const labelNoRes = await client.query('SELECT next_doc_no($1,$2,8) AS code', [tenantId, 'LAB']);
    const labelNo = String(labelNoRes.rows[0].code);
    const content = await labelContent(client, qr);
    const png = renderLabelPng({
      payload: String(item.payload),
      qrText: qr.code,
      title: content.title,
      lines: content.lines,
      widthMm: content.mm.width,
      heightMm: content.mm.height,
    });

    const relPath = `niimbot/${tenantId}/${jobNo}/${labelNo}.png`;
    const absPath = path.join(config.storageRoot, relPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, png);

    const ins = await client.query(
      `INSERT INTO qr_labels (company_id, tenant_id, qr_id, template_id, label_no, copies, status, print_job_id, label_image_path)
       VALUES ($1,$2,$3,$4,$5,1,'GENERATED',$6,$7) RETURNING id`,
      [companyId, tenantId, qr.id, input.templateId ?? null, labelNo, jobId, relPath]
    );
    labels.push({
      id: Number(ins.rows[0].id),
      labelNo,
      qrId: qr.id,
      code: qr.code,
      payload: String(item.payload),
      imageDataUrl: `data:image/png;base64,${png.toString('base64')}`,
    });
  }

  await logAudit(client, ctx, {
    action: 'labels.spool',
    resource: 'qr_labels',
    recordId: jobId,
    recordCode: jobNo,
    metadata: { count: labels.length, jobNo },
  });
  return { jobNo, jobId, labels };
}

/** Poll endpoint for the Niimbot bridge: queued labels + their PNG images. */
export async function fetchSpool(client: pg.PoolClient, ctx: Ctx, input: { limit?: number }) {
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  const res = await client.query(
    `SELECT l.id, l.label_no, l.qr_id, l.template_id, l.label_image_path, l.status AS label_status,
            j.id AS job_id, j.job_no, j.status AS job_status, q.code AS qr_code, q.entity_type
     FROM qr_labels l
     JOIN label_print_jobs j ON j.id = l.print_job_id
     JOIN qr_codes q ON q.id = l.qr_id
     WHERE l.status = 'GENERATED' AND j.status IN ('QUEUED','PRINTING')
     ORDER BY l.id
     LIMIT $1`,
    [limit]
  );
  const rows: (Record<string, unknown> & { imageDataUrl: string | null })[] = [];
  for (const row of res.rows) {
    let imageDataUrl: string | null = null;
    if (row.label_image_path) {
      try {
        const buf = readFileSync(path.join(config.storageRoot, String(row.label_image_path)));
        imageDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
      } catch {
        imageDataUrl = null;
      }
    }
    rows.push({ ...row, imageDataUrl });
  }
  const jobIds = [...new Set(res.rows.map((r) => Number(r.job_id)))];
  if (jobIds.length > 0) {
    await client.query(
      `UPDATE label_print_jobs SET status = 'PRINTING' WHERE id = ANY($1::bigint[]) AND status = 'QUEUED'`,
      [jobIds]
    );
  }
  return rows;
}

/** Bridge acknowledgement: label printed on the Niimbot. */
export async function markLabelPrinted(client: pg.PoolClient, ctx: Ctx, labelId: number) {
  const res = await client.query(
    `UPDATE qr_labels SET status = 'PRINTED', printed_at = now(), printed_by = $2
     WHERE id = $1 AND tenant_id = $3 AND status IN ('GENERATED','PRINTED','REPRINTED')
     RETURNING id, print_job_id, label_no`,
    [labelId, ctx.userId ?? null, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Label not found or not spooled');
  const jobId = res.rows[0].print_job_id;
  await client.query(
    `UPDATE label_print_jobs SET status = 'PRINTED', completed_at = now()
     WHERE id = $1 AND NOT EXISTS (
       SELECT 1 FROM qr_labels l WHERE l.print_job_id = $1 AND l.status = 'GENERATED'
     )`,
    [jobId]
  );
  await logAudit(client, ctx, {
    action: 'labels.printed',
    resource: 'qr_labels',
    recordId: Number(res.rows[0].id),
    recordCode: String(res.rows[0].label_no),
    metadata: { jobId },
  });
  return res.rows[0];
}

/** Bridge acknowledgement: printing failed on the Niimbot. */
export async function markLabelFailed(
  client: pg.PoolClient,
  ctx: Ctx,
  labelId: number,
  reason?: string
) {
  const res = await client.query(
    `UPDATE qr_labels SET status = 'DAMAGED'
     WHERE id = $1 AND tenant_id = $2 AND status = 'GENERATED'
     RETURNING id, print_job_id, label_no`,
    [labelId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Label not found or already printed');
  const jobId = res.rows[0].print_job_id;
  await client.query(
    `UPDATE label_print_jobs SET status = 'FAILED'
     WHERE id = $1 AND NOT EXISTS (
       SELECT 1 FROM qr_labels l WHERE l.print_job_id = $1 AND l.status = 'GENERATED'
     )`,
    [jobId]
  );
  await logAudit(client, ctx, {
    action: 'labels.failed',
    resource: 'qr_labels',
    recordId: Number(res.rows[0].id),
    recordCode: String(res.rows[0].label_no),
    metadata: { jobId, reason: reason ?? null },
  });
  return res.rows[0];
}