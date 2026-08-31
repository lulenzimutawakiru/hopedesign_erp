import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { Ctx } from '../db.js';
import { badRequest, notFound } from '../utils.js';
import { emitEvent } from './events.js';

const ENTITY_PREFIX: Record<string, string> = {
  PRODUCT: 'HDG-FG',
  BATCH: 'HDG-BT',
  LOT: 'HDG-LT',
  SERIAL: 'HDG-SN',
  WORK_ORDER: 'HDG-WO',
  SECURITY_JOB: 'HDG-SJ',
  REAM: 'HDG-RE',
  CARTON: 'HDG-CT',
  PALLET: 'HDG-PL',
  ASSET: 'HDG-AS',
  MACHINE: 'HDG-MC',
  BIN: 'HDG-BN',
  DELIVERY: 'HDG-DL',
  CUSTOMER: 'HDG-CU',
  RAW_MATERIAL: 'HDG-RM',
  CONSUMABLE: 'HDG-CN',
};

export interface QrGenerated {
  id: number;
  code: string;
  secret: string;
  payload: string;
  status: string;
}

export async function generateQr(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    entityType: string;
    entityId?: number | null;
    productId?: number | null;
    batchId?: number | null;
    count?: number;
  }
): Promise<QrGenerated[]> {
  const companyId = ctx.companyId ?? null;
  const tenantId = ctx.tenantId ?? null;
  if (!companyId || !tenantId) throw badRequest('Company context required');
  const prefix = ENTITY_PREFIX[input.entityType] ?? 'HDG-QR';
  const count = input.count ?? 1;
  const out: QrGenerated[] = [];
  for (let i = 0; i < count; i++) {
    const codeRes = await client.query('SELECT next_doc_no($1,$2,8) AS code', [tenantId, prefix]);
    const code = String(codeRes.rows[0].code);
    const secret = randomBytes(24).toString('base64url');
    const secretHash = createHash('sha256').update(secret).digest('hex');
    const insertRes = await client.query(
      `INSERT INTO qr_codes (company_id, tenant_id, code, secret_hash, entity_type, entity_id, product_id, batch_id, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, code, status`,
      [companyId, tenantId, code, secretHash, input.entityType, input.entityId ?? null, input.productId ?? null, input.batchId ?? null, ctx.userId ?? null]
    );
    const row = insertRes.rows[0];
    out.push({ id: Number(row.id), code, secret, payload: `${code}|${secret}`, status: String(row.status) });
    await emitEvent(client, ctx, {
      eventType: 'qr.generated',
      entityType: 'qr_codes',
      entityId: Number(row.id),
      entityCode: code,
      payload: { entityType: input.entityType, entityId: input.entityId },
    });
  }
  return out;
}

export async function findQrByCode(client: pg.PoolClient, ctx: Ctx, code: string) {
  const res = await client.query(
    `SELECT q.*, p.name AS product_name, pb.batch_no, w.code AS warehouse_code
     FROM qr_codes q
     LEFT JOIN products p ON p.id = q.product_id
     LEFT JOIN product_batches pb ON pb.id = q.batch_id
     LEFT JOIN inventory i ON i.product_id = q.product_id AND i.batch_id IS NOT DISTINCT FROM q.batch_id
     LEFT JOIN warehouses w ON w.id = i.warehouse_id
     WHERE q.code = $1 AND q.tenant_id = $2`,
    [code, ctx.tenantId]
  );
  return res.rows[0] ?? null;
}

/** Internal operational scan. Authenticates the QR, records the scan, detects anomalies. */
export async function scanQr(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { code: string; action?: string; location?: string | null; device?: string | null; secret?: string | null }
) {
  const qr = await findQrByCode(client, ctx, input.code);
  if (!qr) throw notFound('QR code not found');
  if (input.secret) {
    const hash = createHash('sha256').update(input.secret).digest('hex');
    if (hash !== qr.secret_hash) throw badRequest('Invalid QR secret');
  }
  const result =
    qr.status === 'VOID' || qr.status === 'DAMAGED' || qr.status === 'LOST' || qr.status === 'REPLACED'
      ? 'VOID'
      : qr.status === 'SUSPENDED'
        ? 'SUSPICIOUS'
        : 'AUTHENTIC';
  const scanRes = await client.query(
    `INSERT INTO qr_scans
       (company_id, tenant_id, qr_id, payload, scan_type, action, result, verified, ip, user_agent, device, location, scanned_by, metadata)
     VALUES ($1,$2,$3,$4,'INTERNAL',$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      qr.company_id,
      qr.tenant_id,
      qr.id,
      input.code,
      input.action ?? 'TRACK',
      result,
      result === 'AUTHENTIC',
      ctx.ip ?? null,
      ctx.userAgent ?? null,
      input.device ?? ctx.device ?? null,
      input.location ?? null,
      ctx.userId ?? null,
      JSON.stringify({}),
    ]
  );
  const scanId = Number(scanRes.rows[0].id);
  await client.query(
    `UPDATE qr_codes SET last_scan_at = now(), scan_count = scan_count + 1 WHERE id = $1`,
    [qr.id]
  );
  await client.query('SELECT detect_qr_anomalies($1,$2,$3)', [qr.id, scanId, input.location ?? null]);
  await emitEvent(client, ctx, {
    eventType: 'qr.scanned',
    entityType: 'qr_codes',
    entityId: Number(qr.id),
    entityCode: input.code,
    payload: { action: input.action, result, location: input.location },
  });
  return { qrId: Number(qr.id), code: input.code, result, scanId, status: qr.status };
}

/** Public verification via the SECURITY DEFINER function ? returns safe data only. */
export async function verifyQrPublic(payload: string, ip?: string, userAgent?: string, device?: string) {
  const { query } = await import('../db.js');
  const res = await query('SELECT verify_qr_public($1,$2,$3,$4) AS result', [payload, ip ?? null, userAgent ?? null, device ?? null]);
  return res.rows[0].result;
}

export async function voidQr(client: pg.PoolClient, ctx: Ctx, qrId: number, reason: string) {
  const res = await client.query(
    `UPDATE qr_codes SET status = 'VOID', status_reason = $2 WHERE id = $1 AND tenant_id = $3 RETURNING code`,
    [qrId, reason, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('QR code not found');
  await emitEvent(client, ctx, {
    eventType: 'qr.voided',
    entityType: 'qr_codes',
    entityId: qrId,
    entityCode: String(res.rows[0].code),
    payload: { reason },
    severity: 'WARN',
  });
  return res.rows[0];
}

export async function printLabels(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { qrIds: number[]; templateId?: number | null; copies?: number }
) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const jobRes = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, 'LBL']);
  const jobNo = String(jobRes.rows[0].code);
  const job = await client.query(
    `INSERT INTO label_print_jobs (company_id, tenant_id, job_no, template_id, count, status, requested_by)
     VALUES ($1,$2,$3,$4,$5,'QUEUED',$6) RETURNING id`,
    [companyId, ctx.tenantId, jobNo, input.templateId ?? null, input.qrIds.length, ctx.userId ?? null]
  );
  const jobId = Number(job.rows[0].id);
  const labels: number[] = [];
  for (const qrId of input.qrIds) {
    const labelRes = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, 'LAB']);
    const labelNo = String(labelRes.rows[0].code);
    const ins = await client.query(
      `INSERT INTO qr_labels (company_id, tenant_id, qr_id, template_id, label_no, copies, status)
       VALUES ($1,$2,$3,$4,$5,$6,'GENERATED') RETURNING id`,
      [companyId, ctx.tenantId, qrId, input.templateId ?? null, labelNo, input.copies ?? 1]
    );
    labels.push(Number(ins.rows[0].id));
  }
  await client.query(
    `UPDATE label_print_jobs SET status = 'PRINTED', completed_at = now() WHERE id = $1`,
    [jobId]
  );
  return { jobNo, jobId, labels };
}
