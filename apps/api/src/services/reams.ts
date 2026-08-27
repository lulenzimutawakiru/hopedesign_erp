import pg from 'pg';
import { createHash } from 'node:crypto';
import { Ctx } from '../db.js';
import { badRequest, conflict, notFound } from '../utils.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import { postMove } from './inventory.js';
import { generateQr, scanQr, findQrByCode } from './qr.js';

/** A carton seals exactly 5 reams (each ream QR is scanned before sealing). */
export const REAMS_PER_CARTON = 5;

export interface ReamGenerated {
  id: number;
  reamNo: string;
  qrId: number;
  code: string;
  secret: string;
  payload: string;
}

export interface SealedCarton {
  cartonId: number;
  cartonNo: string;
  qrId: number;
  code: string;
  secret: string;
  payload: string;
  reams: { reamId: number; reamNo: string; qrId: number; code: string }[];
}

async function requireReamProduct(client: pg.PoolClient, ctx: Ctx, productId: number) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const res = await client.query(
    `SELECT id, code, name, type, gsm, sheets_per_ream, width_mm, standard_cost FROM products
     WHERE id = $1 AND company_id = $2`,
    [productId, companyId]
  );
  if (res.rows.length === 0) throw notFound('Product not found');
  if (res.rows[0].type !== 'REAM') throw badRequest('Product is not a REAM product');
  return res.rows[0];
}

async function validateBatch(client: pg.PoolClient, ctx: Ctx, productId: number, batchId: number | null) {
  if (!batchId) return null;
  const res = await client.query(
    `SELECT id FROM product_batches WHERE id = $1 AND product_id = $2 AND company_id = $3`,
    [batchId, productId, ctx.companyId ?? 0]
  );
  if (res.rows.length === 0) throw badRequest('Batch does not belong to this product');
  return batchId;
}

/** Default finished-goods location for ream stock (FG-WH + first bin). */
async function resolveFgLocation(
  client: pg.PoolClient,
  ctx: Ctx
): Promise<{ warehouseId: number; binId: number | null } | null> {
  const wh = await client.query(
    `SELECT id FROM warehouses WHERE company_id = $1 AND code = 'FG-WH'`,
    [ctx.companyId]
  );
  if (wh.rows.length === 0) return null;
  const warehouseId = Number(wh.rows[0].id);
  const bin = await client.query(
    `SELECT id FROM warehouse_bins WHERE warehouse_id = $1 ORDER BY code LIMIT 1`,
    [warehouseId]
  );
  return { warehouseId, binId: bin.rows.length ? Number(bin.rows[0].id) : null };
}

/**
 * Create a production batch for a REAM product. The batch number is
 * auto-generated (BT-YYYY-00000001) and is printed on every ream/carton
 * label and returned by the public verification portal.
 */
export async function createProductionBatch(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { productId: number; quantity?: number | null; lotNo?: string | null; expiryDate?: string | null; notes?: string | null }
) {
  const companyId = ctx.companyId ?? null;
  const tenantId = ctx.tenantId ?? null;
  if (!companyId || !tenantId) throw badRequest('Company context required');
  const product = await requireReamProduct(client, ctx, input.productId);
  const noRes = await client.query('SELECT next_doc_no($1,$2,8) AS no', [tenantId, 'BT']);
  const batchNo = String(noRes.rows[0].no);
  const attributes: Record<string, unknown> = {};
  if (input.notes) attributes.notes = input.notes;
  const ins = await client.query(
    `INSERT INTO product_batches
       (company_id, tenant_id, product_id, batch_no, lot_no, received_at, expiry_date, quantity, planned_qty, unit_cost, status, attributes)
     VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8,0,'ACTIVE',$9) RETURNING *`,
    [
      companyId,
      tenantId,
      input.productId,
      batchNo,
      input.lotNo ?? null,
      input.expiryDate ?? null,
      0,
      input.quantity ?? 0,
      JSON.stringify(attributes),
    ]
  );
  const row = ins.rows[0];
  await emitEvent(client, ctx, {
    eventType: 'production.batch.created',
    entityType: 'product_batches',
    entityId: Number(row.id),
    entityCode: batchNo,
    payload: { productId: input.productId, productCode: product.code, quantity: input.quantity ?? 0 },
  });
  await logAudit(client, ctx, {
    action: 'production.batch.create',
    resource: 'product_batches',
    recordId: Number(row.id),
    recordCode: batchNo,
    metadata: { productId: input.productId, quantity: input.quantity ?? 0, lotNo: input.lotNo ?? null },
  });
  return row;
}

/** Generate one unique QR per ream (optionally in bulk) for a REAM product. */
export async function generateReams(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { productId: number; batchId?: number | null; count?: number }
): Promise<ReamGenerated[]> {
  const companyId = ctx.companyId ?? null;
  const tenantId = ctx.tenantId ?? null;
  if (!companyId || !tenantId) throw badRequest('Company context required');
  const requested = Math.max(1, Math.min(100, input.count ?? 1));
  const product = await requireReamProduct(client, ctx, input.productId);
  const batchId = await validateBatch(client, ctx, input.productId, input.batchId ?? null);
  const fg = await resolveFgLocation(client, ctx);

  // Industrial control: never over-produce past the batch's planned capacity.
  // planned_qty is anchored at batch creation (product_batches.quantity drifts
  // with every inventory movement), so it is a stable production target.
  let count = requested;
  if (batchId) {
    const capRes = await client.query(
      `SELECT id, batch_no, COALESCE(planned_qty, quantity, 0)::numeric AS planned
       FROM product_batches WHERE id = $1 AND tenant_id = $2`,
      [batchId, tenantId]
    );
    if (capRes.rows.length > 0) {
      const planned = Math.floor(Number(capRes.rows[0].planned) || 0);
      if (planned > 0) {
        const genRes = await client.query(
          `SELECT count(*)::int AS n FROM reams WHERE tenant_id = $1 AND batch_id = $2`,
          [tenantId, batchId]
        );
        const remaining = planned - Number(genRes.rows[0].n);
        if (remaining <= 0) {
          throw badRequest(
            `Batch ${String(capRes.rows[0].batch_no)} is at full planned capacity (${planned} reams). Create a new batch to produce more.`
          );
        }
        if (count > remaining) count = remaining;
      }
    }
  }

  const out: ReamGenerated[] = [];
  for (let i = 0; i < count; i++) {
    const noRes = await client.query('SELECT next_doc_no($1,$2,8) AS no', [tenantId, 'RM']);
    const reamNo = String(noRes.rows[0].no);
    const qrs = await generateQr(client, ctx, {
      entityType: 'REAM',
      productId: input.productId,
      batchId,
      count: 1,
    });
    const qr = qrs[0];
    const ins = await client.query(
      `INSERT INTO reams
         (company_id, tenant_id, product_id, batch_id, ream_no, qr_id, sheets, gsm, size, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        companyId, tenantId, input.productId, batchId, reamNo, qr.id,
        product.sheets_per_ream ?? 500,
        product.gsm ?? null,
        product.width_mm ? `${product.width_mm}mm` : null,
        ctx.userId ?? null,
      ]
    );
    const reamId = Number(ins.rows[0].id);
    await client.query('UPDATE qr_codes SET entity_id = $1 WHERE id = $2', [reamId, qr.id]);
    if (fg) {
      await postMove(client, ctx, {
        movementType: 'PRODUCTION_OUTPUT',
        product: input.productId,
        batch: batchId,
        warehouse: fg.warehouseId,
        bin: fg.binId,
        quantity: 1,
        unitCost: Number(product.standard_cost) || 0,
        refType: 'reams',
        refId: reamId,
        refCode: reamNo,
        qr: qr.id,
        reason: `Ream ${reamNo} generated`,
      });
    }
    out.push({ id: reamId, reamNo, qrId: qr.id, code: qr.code, secret: qr.secret, payload: qr.payload });
  }
  await logAudit(client, ctx, {
    action: 'reams.generate',
    resource: 'reams',
    metadata: { count, productId: input.productId, batchId },
  });
  return out;
}

export async function getReamByCode(client: pg.PoolClient, ctx: Ctx, code: string) {
  const res = await client.query(
    `SELECT r.*, q.code AS qr_code, q.status AS qr_status, q.scan_count AS qr_scan_count,
            p.code AS product_code, p.name AS product_name, pb.batch_no, c.carton_no
     FROM reams r
     JOIN products p ON p.id = r.product_id
     LEFT JOIN product_batches pb ON pb.id = r.batch_id
     LEFT JOIN qr_codes q ON q.id = r.qr_id
     LEFT JOIN cartons c ON c.id = r.carton_id
     WHERE q.code = $1 AND r.tenant_id = $2`,
    [code, ctx.tenantId]
  );
  return res.rows[0] ?? null;
}

export async function getCartonByCode(client: pg.PoolClient, ctx: Ctx, code: string) {
  const res = await client.query(
    `SELECT c.*, q.code AS qr_code, q.status AS qr_status, q.scan_count AS qr_scan_count,
            p.code AS product_code, p.name AS product_name, pb.batch_no
     FROM cartons c
     JOIN products p ON p.id = c.product_id
     LEFT JOIN product_batches pb ON pb.id = c.batch_id
     LEFT JOIN qr_codes q ON q.id = c.qr_id
     WHERE q.code = $1 AND c.tenant_id = $2`,
    [code, ctx.tenantId]
  );
  if (res.rows.length === 0) return null;
  const carton = res.rows[0];
  const members = await client.query(
    `SELECT r.id AS ream_id, r.ream_no, q.code, q.status AS qr_status, r.status AS ream_status, cr.seq
     FROM carton_reams cr
     JOIN reams r ON r.id = cr.ream_id
     JOIN qr_codes q ON q.id = r.qr_id
     WHERE cr.carton_id = $1
     ORDER BY cr.seq`,
    [carton.id]
  );
  return { ...carton, members: members.rows };
}

/**
 * Scan a ream QR on the packing line. Authenticates the QR (secret optional),
 * records a PACK scan and returns the ream it belongs to.
 */
export async function scanReamForPacking(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { code: string; secret?: string | null; location?: string | null }
) {
  const scan = await scanQr(client, ctx, {
    code: input.code,
    action: 'PACK',
    location: input.location ?? null,
    secret: input.secret ?? null,
  });
  if (scan.result !== 'AUTHENTIC') {
    throw badRequest(`Ream QR is not authentic (${scan.result})`);
  }
  const qr = await findQrByCode(client, ctx, input.code);
  if (!qr || qr.entity_type !== 'REAM') throw badRequest('QR code is not a ream');
  const ream = await getReamByCode(client, ctx, input.code);
  if (!ream) throw notFound('Ream record not found');
  return { result: scan.result, scanId: scan.scanId, ream };
}

/**
 * Seal exactly 5 distinct, available ream QRs into one carton and mint a
 * unique carton QR. Reams are linked, marked PACKED and a SEAL scan is logged.
 */
export async function sealCarton(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { productId: number; batchId?: number | null; reamCodes: string[]; secrets?: (string | null)[] }
): Promise<SealedCarton> {
  const companyId = ctx.companyId ?? null;
  const tenantId = ctx.tenantId ?? null;
  if (!companyId || !tenantId) throw badRequest('Company context required');
  const codes = [...new Set((input.reamCodes ?? []).map((c) => String(c).trim()).filter(Boolean))];
  if (codes.length !== REAMS_PER_CARTON) {
    throw badRequest(`Exactly ${REAMS_PER_CARTON} distinct ream QR codes are required to seal a carton`);
  }
  const product = await requireReamProduct(client, ctx, input.productId);
  const batchId = await validateBatch(client, ctx, input.productId, input.batchId ?? null);

  const reams: { id: number; reamNo: string; productId: number; batchId: number | null; status: string; qrId: number; code: string }[] = [];
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const qr = await findQrByCode(client, ctx, code);
    if (!qr) throw badRequest(`Ream QR ${code} not found`);
    if (qr.entity_type !== 'REAM') throw badRequest(`QR ${code} is not a ream QR`);
    const secret = input.secrets?.[i] ?? null;
    if (secret) {
      const hash = createHash('sha256').update(secret).digest('hex');
      if (hash !== qr.secret_hash) throw badRequest(`Invalid secret for ${code}`);
    }
    if (qr.status !== 'ACTIVE') throw badRequest(`Ream QR ${code} is not active (${qr.status})`);
    const reamRes = await client.query(
      `SELECT id, ream_no, product_id, batch_id, status, qr_id FROM reams
       WHERE qr_id = $1 AND tenant_id = $2`,
      [qr.id, tenantId]
    );
    if (reamRes.rows.length === 0) throw badRequest(`No ream record for ${code}`);
    const r = reamRes.rows[0];
    if (r.status !== 'AVAILABLE') throw conflict(`Ream ${r.ream_no} is already ${r.status}`);
    if (Number(r.product_id) !== input.productId) throw badRequest(`Ream ${r.ream_no} belongs to a different product`);
    if (Number(r.batch_id ?? 0) !== Number(batchId ?? 0)) throw badRequest(`Ream ${r.ream_no} batch does not match the carton batch`);
    reams.push({ id: Number(r.id), reamNo: String(r.ream_no), productId: Number(r.product_id), batchId: r.batch_id ?? null, status: String(r.status), qrId: Number(qr.id), code });
  }

  const cartonNoRes = await client.query('SELECT next_doc_no($1,$2,8) AS no', [tenantId, 'CTN']);
  const cartonNo = String(cartonNoRes.rows[0].no);
  const cartonQrs = await generateQr(client, ctx, {
    entityType: 'CARTON',
    productId: input.productId,
    batchId,
    count: 1,
  });
  const cartonQr = cartonQrs[0];

  const carton = await client.query(
    `INSERT INTO cartons (company_id, tenant_id, product_id, batch_id, carton_no, qr_id, ream_count, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'SEALED',$8) RETURNING id, carton_no`,
    [companyId, tenantId, input.productId, batchId, cartonNo, cartonQr.id, REAMS_PER_CARTON, ctx.userId ?? null]
  );
  const cartonId = Number(carton.rows[0].id);
  await client.query('UPDATE qr_codes SET entity_id = $1 WHERE id = $2', [cartonId, cartonQr.id]);

  for (let i = 0; i < reams.length; i++) {
    const r = reams[i];
    await client.query(
      `INSERT INTO carton_reams (carton_id, ream_id, seq) VALUES ($1,$2,$3)`,
      [cartonId, r.id, i + 1]
    );
    await client.query(
      `UPDATE reams SET status = 'PACKED', carton_id = $1, packed_at = now(), packed_by = $2 WHERE id = $3`,
      [cartonId, ctx.userId ?? null, r.id]
    );
    await client.query(
      `INSERT INTO qr_scans
         (company_id, tenant_id, qr_id, payload, scan_type, action, result, verified, scanned_by, metadata)
       VALUES ($1,$2,$3,$4,'INTERNAL','SEAL','AUTHENTIC',true,$5,$6::jsonb)`,
      [companyId, tenantId, r.qrId, r.code, ctx.userId ?? null, JSON.stringify({ cartonNo, cartonCode: cartonQr.code })]
    );
  }

  // Packing issue: the 5 packed reams leave loose FG stock (real decrement on
  // hand) and become carton contents. Skipped for legacy reams generated
  // before inventory posting existed (no stock layer to consume).
  const fg = await resolveFgLocation(client, ctx);
  if (fg) {
    const avail = await client.query(
      `SELECT COALESCE(SUM(quantity), 0)::numeric AS qty
       FROM inventory
       WHERE company_id = $1 AND product_id = $2 AND batch_id IS NOT DISTINCT FROM $3
         AND warehouse_id = $4 AND bin_id IS NOT DISTINCT FROM $5`,
      [companyId, input.productId, batchId, fg.warehouseId, fg.binId]
    );
    if (Number(avail.rows[0].qty) >= REAMS_PER_CARTON) {
      const reason = `Carton ${cartonNo} sealed (${REAMS_PER_CARTON} reams packed)`;
      await postMove(client, ctx, {
        movementType: 'ISSUE',
        product: input.productId,
        batch: batchId,
        warehouse: fg.warehouseId,
        bin: fg.binId,
        quantity: REAMS_PER_CARTON,
        unitCost: Number(product.standard_cost) || 0,
        refType: 'cartons',
        refId: cartonId,
        refCode: cartonNo,
        qr: cartonQr.id,
        reason,
      });
      // Net-zero serialized conversion: the 5 packed reams leave loose FG stock
      // (ISSUE) and re-enter on-hand as carton contents (RECEIPT), so total
      // on-hand quantity is unchanged while the carton QR carries the stock.
      await postMove(client, ctx, {
        movementType: 'RECEIPT',
        product: input.productId,
        batch: batchId,
        warehouse: fg.warehouseId,
        bin: fg.binId,
        quantity: REAMS_PER_CARTON,
        unitCost: Number(product.standard_cost) || 0,
        refType: 'cartons',
        refId: cartonId,
        refCode: cartonNo,
        qr: cartonQr.id,
        reason,
      });
    } else {
      await logAudit(client, ctx, {
        action: 'cartons.seal',
        resource: 'inventory',
        recordId: cartonId,
        recordCode: cartonNo,
        metadata: { note: 'Packing conversion skipped - legacy reams have no stock layer' },
      });
    }
  }

  await emitEvent(client, ctx, {
    eventType: 'carton.sealed',
    entityType: 'cartons',
    entityId: cartonId,
    entityCode: cartonNo,
    payload: { reamCodes: codes, cartonCode: cartonQr.code, productId: input.productId, batchId },
  });
  await logAudit(client, ctx, {
    action: 'cartons.seal',
    resource: 'cartons',
    recordId: cartonId,
    recordCode: cartonNo,
    metadata: { reamCodes: codes, cartonCode: cartonQr.code, productId: input.productId },
  });

  return {
    cartonId,
    cartonNo,
    qrId: cartonQr.id,
    code: cartonQr.code,
    secret: cartonQr.secret,
    payload: cartonQr.payload,
    reams: reams.map((r) => ({ reamId: r.id, reamNo: r.reamNo, qrId: r.qrId, code: r.code })),
  };
}

export interface PackingSummary {
  productId: number;
  batchId: number | null;
  plannedQty: number;
  generatedQty: number;
  remainingToGenerate: number;
  onHand: number;
  looseReams: number;
  packedReams: number;
  cartonsSealed: number;
  statusCounts: Record<string, number>;
}

/** Live stock picture for the packing line: on-hand, loose vs packed reams, cartons sealed. */
export async function getPackingSummary(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { productId: number; batchId?: number | null }
): Promise<PackingSummary> {
  const companyId = ctx.companyId ?? null;
  const tenantId = ctx.tenantId ?? null;
  if (!companyId || !tenantId) throw badRequest('Company context required');
  const product = await client.query(`SELECT id FROM products WHERE id = $1 AND company_id = $2`, [
    input.productId,
    companyId,
  ]);
  if (product.rows.length === 0) throw notFound('Product not found');
  const batchId = await validateBatch(client, ctx, input.productId, input.batchId ?? null);
  const onHandRes = await client.query(
    `SELECT COALESCE(SUM(quantity), 0)::numeric AS qty
     FROM inventory
     WHERE company_id = $1 AND product_id = $2 AND batch_id IS NOT DISTINCT FROM $3`,
    [companyId, input.productId, batchId]
  );
  const looseRes = await client.query(
    `SELECT count(*)::int AS n FROM reams
     WHERE tenant_id = $1 AND product_id = $2 AND batch_id IS NOT DISTINCT FROM $3 AND status = 'AVAILABLE'`,
    [tenantId, input.productId, batchId]
  );
  const packedRes = await client.query(
    `SELECT count(*)::int AS n FROM reams
     WHERE tenant_id = $1 AND product_id = $2 AND batch_id IS NOT DISTINCT FROM $3
       AND status IN ('PACKED','ISSUED','DISPATCHED')`,
    [tenantId, input.productId, batchId]
  );
  const cartonRes = await client.query(
    `SELECT count(*)::int AS n FROM cartons
     WHERE tenant_id = $1 AND product_id = $2 AND batch_id IS NOT DISTINCT FROM $3
       AND status IN ('SEALED','DISPATCHED')`,
    [tenantId, input.productId, batchId]
  );
  // Planned vs produced: planned_qty is anchored at batch creation, generated is
  // the ream count for the batch (all statuses), remaining is the shortfall.
  let plannedQty = 0;
  let generatedQty = 0;
  if (batchId) {
    const plannedRes = await client.query(
      `SELECT COALESCE(planned_qty, quantity, 0)::numeric AS planned
       FROM product_batches WHERE id = $1 AND tenant_id = $2`,
      [batchId, tenantId]
    );
    plannedQty = Math.floor(Number(plannedRes.rows[0]?.planned) || 0);
    const genRes = await client.query(
      `SELECT count(*)::int AS n FROM reams
       WHERE tenant_id = $1 AND product_id = $2 AND batch_id = $3`,
      [tenantId, input.productId, batchId]
    );
    generatedQty = Number(genRes.rows[0].n);
  }
  const statusRes = await client.query(
    `SELECT
       count(*) FILTER (WHERE status = 'AVAILABLE')::int AS available,
       count(*) FILTER (WHERE status = 'PACKED')::int AS packed,
       count(*) FILTER (WHERE status = 'ISSUED')::int AS issued,
       count(*) FILTER (WHERE status = 'DISPATCHED')::int AS dispatched,
       count(*) FILTER (WHERE status = 'LOST')::int AS lost,
       count(*) FILTER (WHERE status = 'VOID')::int AS void
     FROM reams
     WHERE tenant_id = $1 AND product_id = $2 AND batch_id IS NOT DISTINCT FROM $3`,
    [tenantId, input.productId, batchId]
  );
  const statusCounts: Record<string, number> = {};
  for (const [k, v] of Object.entries(statusRes.rows[0] ?? {})) statusCounts[k] = Number(v) || 0;
  return {
    productId: input.productId,
    batchId,
    plannedQty,
    generatedQty,
    remainingToGenerate: plannedQty > 0 ? Math.max(0, plannedQty - generatedQty) : 0,
    onHand: Number(onHandRes.rows[0].qty),
    looseReams: Number(looseRes.rows[0].n),
    packedReams: Number(packedRes.rows[0].n),
    cartonsSealed: Number(cartonRes.rows[0].n),
    statusCounts,
  };
}

export interface BatchCapacityRow {
  batchId: number;
  batchNo: string;
  plannedQty: number;
  generatedQty: number;
  remainingToGenerate: number;
  capacityReached: boolean;
}

/** Per-batch planned capacity + generated counts for a product's ACTIVE batches. */
export async function getBatchCapacity(
  client: pg.PoolClient,
  ctx: Ctx,
  productId: number
): Promise<BatchCapacityRow[]> {
  const companyId = ctx.companyId ?? null;
  const tenantId = ctx.tenantId ?? null;
  if (!companyId || !tenantId) throw badRequest('Company context required');
  await requireReamProduct(client, ctx, productId);
  const res = await client.query(
    `SELECT b.id, b.batch_no,
            COALESCE(b.planned_qty, b.quantity, 0)::numeric AS planned,
            (SELECT count(*)::int FROM reams r WHERE r.batch_id = b.id AND r.tenant_id = $2) AS generated
     FROM product_batches b
     WHERE b.product_id = $1 AND b.tenant_id = $2 AND b.status = 'ACTIVE'
     ORDER BY b.created_at DESC, b.id DESC`,
    [productId, tenantId]
  );
  return res.rows.map((r) => {
    const plannedQty = Math.floor(Number(r.planned) || 0);
    const generatedQty = Number(r.generated) || 0;
    const remainingToGenerate = plannedQty > 0 ? Math.max(0, plannedQty - generatedQty) : 0;
    return {
      batchId: Number(r.id),
      batchNo: String(r.batch_no),
      plannedQty,
      generatedQty,
      remainingToGenerate,
      capacityReached: plannedQty > 0 && remainingToGenerate <= 0,
    };
  });
}
