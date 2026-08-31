import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';

export interface MoveInput {
  movementType: string;
  product: number;
  batch?: number | null;
  warehouse?: number | null;
  bin?: number | null;
  fromWarehouse?: number | null;
  fromBin?: number | null;
  toWarehouse?: number | null;
  toBin?: number | null;
  quantity: number;
  unitCost?: number;
  refType?: string | null;
  refId?: number | null;
  refCode?: string | null;
  qr?: number | null;
  workOrder?: number | null;
  reason?: string | null;
  valuationMethod?: string;
}

export const RAW_MATERIAL_TYPES = ['JUMBO_ROLL', 'PAPER_BOBBIN', 'PACKAGING'];
export const CONSUMABLE_TYPES = ['CONSUMABLE', 'SPARE_PART'];

export async function postMove(client: pg.PoolClient, ctx: Ctx, m: MoveInput) {
  const res = await client.query('SELECT post_inventory_move($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) AS movement_id', [
    ctx.companyId,
    ctx.tenantId,
    ctx.branchId ?? null,
    m.movementType,
    m.product,
    m.batch ?? null,
    m.warehouse ?? null,
    m.bin ?? null,
    m.fromWarehouse ?? null,
    m.fromBin ?? null,
    m.toWarehouse ?? null,
    m.toBin ?? null,
    m.quantity,
    m.unitCost ?? 0,
    m.refType ?? null,
    m.refId ?? null,
    m.refCode ?? null,
    m.qr ?? null,
    m.workOrder ?? null,
    ctx.userId ?? null,
    m.reason ?? null,
    m.valuationMethod ?? 'WEIGHTED_AVERAGE',
  ]);
  return Number(res.rows[0].movement_id);
}

export async function reserve(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { product: number; batch?: number | null; warehouse?: number | null; qty: number; refType: string; refId: number }
) {
  const res = await client.query('SELECT reserve_stock($1,$2,$3,$4,$5,$6,$7,$8,$9) AS reservation_id', [
    ctx.companyId,
    ctx.tenantId,
    input.product,
    input.batch ?? null,
    input.warehouse ?? null,
    input.qty,
    input.refType,
    input.refId,
    ctx.userId ?? null,
  ]);
  return Number(res.rows[0].reservation_id);
}

export async function release(client: pg.PoolClient, reservationId: number) {
  await client.query('SELECT release_reservation($1)', [reservationId]);
}

/** Consume a reservation after the stock has been issued (does not put qty back on hand). */
export async function consume(client: pg.PoolClient, reservationId: number) {
  await client.query(
    `UPDATE inventory i SET reserved_qty = GREATEST(0, reserved_qty - r.quantity), updated_at = now()
     FROM inventory_reservations r
     WHERE r.id = $1 AND r.status = 'ACTIVE'
       AND i.product_id = r.product_id AND i.batch_id IS NOT DISTINCT FROM r.batch_id
       AND i.warehouse_id = r.warehouse_id`,
    [reservationId]
  );
  await client.query(
    `UPDATE inventory_reservations SET status = 'CONSUMED' WHERE id = $1 AND status = 'ACTIVE'`,
    [reservationId]
  );
}

function n(v: unknown): number {
  return Number(v);
}

export async function createAdjustment(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    adjustmentType: string;
    reason: string;
    items: Array<{
      productId?: number; product_id?: number;
      warehouseId?: number; warehouse_id?: number;
      binId?: number | null; bin_id?: number | null;
      countedQty?: number | null; counted_qty?: number | null;
      varianceQty?: number; variance_qty?: number;
      unitCost?: number; unit_cost?: number;
      reason?: string | null;
    }>;
  }
) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const noRes = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, 'ADJ']);
  const adjustmentNo = String(noRes.rows[0].code);
  const ins = await client.query(
    `INSERT INTO inventory_adjustments
       (company_id, tenant_id, branch_id, adjustment_no, adjustment_type, reason, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7) RETURNING id`,
    [companyId, ctx.tenantId, ctx.branchId ?? null, adjustmentNo, input.adjustmentType, input.reason, ctx.userId ?? null]
  );
  const adjustmentId = Number(ins.rows[0].id);
  if (!input.items?.length) throw badRequest('At least one adjustment line is required');
  for (const item of input.items) {
    const productId = n(item.productId ?? item.product_id);
    const warehouseId = n(item.warehouseId ?? item.warehouse_id);
    const binId = item.binId ?? item.bin_id ?? null;
    if (!productId || !warehouseId) throw badRequest('Each line needs a product and warehouse');
    const expected = await client.query(
      `SELECT COALESCE(sum(quantity),0)::numeric AS qty FROM inventory
       WHERE product_id = $1 AND warehouse_id = $2 AND bin_id IS NOT DISTINCT FROM $3`,
      [productId, warehouseId, binId]
    );
    const expectedQty = Number(expected.rows[0].qty);
    const counted = item.countedQty ?? item.counted_qty;
    const variance = item.varianceQty ?? item.variance_qty;
    const hasCount = counted != null && Number.isFinite(Number(counted));
    const varianceQty = hasCount ? Number(counted) - expectedQty : Number(variance);
    if (!Number.isFinite(varianceQty)) throw badRequest('Enter a counted quantity or variance');
    await client.query(
      `INSERT INTO inventory_adjustment_items
         (adjustment_id, product_id, warehouse_id, bin_id, counted_qty, expected_qty, variance_qty, unit_cost, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        adjustmentId,
        productId,
        warehouseId,
        binId,
        hasCount ? Number(counted) : null,
        expectedQty,
        varianceQty,
        Number(item.unitCost ?? item.unit_cost ?? 0),
        item.reason ?? null,
      ]
    );
  }
  return { adjustmentId, adjustmentNo };
}

export async function postAdjustment(client: pg.PoolClient, ctx: Ctx, adjustmentId: number) {
  const adj = await client.query(
    `SELECT * FROM inventory_adjustments WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [adjustmentId, ctx.tenantId]
  );
  if (adj.rows.length === 0) throw badRequest('Adjustment not found');
  const a = adj.rows[0];
  if (a.status !== 'APPROVED') throw badRequest(`Adjustment must be APPROVED before posting (current: ${a.status})`);
  const items = await client.query(
    `SELECT * FROM inventory_adjustment_items WHERE adjustment_id = $1`,
    [adjustmentId]
  );
  for (const item of items.rows) {
    const qty = Number(item.variance_qty);
    if (qty === 0) continue;
    await postMove(client, ctx, {
      movementType: qty > 0 ? 'ADJUSTMENT' : 'ISSUE',
      product: Number(item.product_id),
      batch: item.batch_id ? Number(item.batch_id) : null,
      warehouse: Number(item.warehouse_id),
      bin: item.bin_id ? Number(item.bin_id) : null,
      quantity: Math.abs(qty),
      unitCost: Number(item.unit_cost) || 0,
      refType: 'inventory_adjustments',
      refId: adjustmentId,
      refCode: String(a.adjustment_no),
      reason: String(a.reason),
    });
  }
  await client.query(
    `UPDATE inventory_adjustments SET status = 'POSTED', posted_by = $2, posted_at = now() WHERE id = $1`,
    [adjustmentId, ctx.userId ?? null]
  );
  return { adjustmentId, adjustmentNo: a.adjustment_no };
}

export async function createTransfer(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    fromWarehouseId: number;
    toWarehouseId: number;
    notes?: string | null;
    items: Array<{
      productId?: number; product_id?: number;
      batchId?: number | null; batch_id?: number | null;
      quantity: number;
      unitCost?: number; unit_cost?: number;
    }>;
  }
) {
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  const noRes = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, 'XFER']);
  const transferNo = String(noRes.rows[0].code);
  const ins = await client.query(
    `INSERT INTO inventory_transfers
       (company_id, tenant_id, branch_id, transfer_no, from_warehouse_id, to_warehouse_id, notes, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8) RETURNING id`,
    [companyId, ctx.tenantId, ctx.branchId ?? null, transferNo, input.fromWarehouseId, input.toWarehouseId, input.notes ?? null, ctx.userId ?? null]
  );
  const transferId = Number(ins.rows[0].id);
  if (Number(input.fromWarehouseId) === Number(input.toWarehouseId)) throw badRequest('From and to warehouses must differ');
  if (!input.items?.length) throw badRequest('At least one transfer line is required');
  for (const item of input.items) {
    const productId = n(item.productId ?? item.product_id);
    const qty = Number(item.quantity);
    if (!productId || !(qty > 0)) throw badRequest('Each line needs a product and a positive quantity');
    await client.query(
      `INSERT INTO inventory_transfer_items (transfer_id, product_id, batch_id, quantity, unit_cost)
       VALUES ($1,$2,$3,$4,$5)`,
      [transferId, productId, item.batchId ?? item.batch_id ?? null, qty, Number(item.unitCost ?? item.unit_cost ?? 0)]
    );
  }
  return { transferId, transferNo };
}

export async function completeTransfer(client: pg.PoolClient, ctx: Ctx, transferId: number) {
  const t = await client.query(
    `SELECT * FROM inventory_transfers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [transferId, ctx.tenantId]
  );
  if (t.rows.length === 0) throw badRequest('Transfer not found');
  const tr = t.rows[0];
  if (tr.status !== 'APPROVED') throw badRequest(`Transfer must be APPROVED (current: ${tr.status})`);
  const items = await client.query(`SELECT * FROM inventory_transfer_items WHERE transfer_id = $1`, [transferId]);
  for (const item of items.rows) {
    await postMove(client, ctx, {
      movementType: 'TRANSFER_OUT',
      product: Number(item.product_id),
      batch: item.batch_id ? Number(item.batch_id) : null,
      fromWarehouse: Number(tr.from_warehouse_id),
      toWarehouse: Number(tr.to_warehouse_id),
      quantity: Number(item.quantity),
      unitCost: Number(item.unit_cost) || 0,
      refType: 'inventory_transfers',
      refId: transferId,
      refCode: String(tr.transfer_no),
    });
  }
  await client.query(
    `UPDATE inventory_transfers SET status = 'COMPLETED', completed_at = now() WHERE id = $1`,
    [transferId]
  );
  return { transferId, transferNo: tr.transfer_no };
}

export async function listStock(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; warehouseId?: number | null; lowStock?: boolean; expiring?: boolean; productTypes?: string[]; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['i.tenant_id = $1', 'i.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(p.code ILIKE $${params.length} OR p.name ILIKE $${params.length})`);
  }
  if (filters.warehouseId) {
    params.push(filters.warehouseId);
    where.push(`i.warehouse_id = $${params.length}`);
  }
  if (filters.lowStock) {
    where.push('i.quantity <= COALESCE(p.reorder_point, 0) AND i.quantity >= 0');
  }
  if (filters.expiring) {
    where.push("pb.expiry_date IS NOT NULL AND pb.expiry_date <= now() + interval '30 days'");
  }
  if (filters.productTypes?.length) {
    params.push(filters.productTypes);
    where.push(`p.type = ANY($${params.length}::text[])`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT i.id, i.product_id, p.code AS product_code, p.name AS product_name, p.type AS product_type,
            p.reorder_point, p.status AS product_status,
            i.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name, w.type AS warehouse_type, w.is_secure,
            i.bin_id, b.code AS bin_code, i.batch_id, pb.batch_no,
            TO_CHAR(pb.expiry_date, 'YYYY-MM-DD') AS batch_expiry,
            i.quantity, i.reserved_qty, (i.quantity - i.reserved_qty) AS available_qty,
            i.avg_cost, (i.quantity * i.avg_cost) AS stock_value
     FROM inventory i
     JOIN products p ON p.id = i.product_id
     JOIN warehouses w ON w.id = i.warehouse_id
     LEFT JOIN warehouse_bins b ON b.id = i.bin_id
     LEFT JOIN product_batches pb ON pb.id = i.batch_id
     WHERE ${where.join(' AND ')}
     ORDER BY (i.quantity <= COALESCE(p.reorder_point, 0)) DESC, p.code, w.code
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const totalRes = await client.query(
    `SELECT count(*)::int AS n
     FROM inventory i
     JOIN products p ON p.id = i.product_id
     JOIN warehouses w ON w.id = i.warehouse_id
     LEFT JOIN product_batches pb ON pb.id = i.batch_id
     WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(res.rows), total: Number(totalRes.rows[0].n), page, pageSize };
}

export async function stockSummary(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT
       COALESCE(sum(i.quantity * i.avg_cost), 0)::numeric(18,2) AS stock_value,
       count(*)::int AS lines,
       count(DISTINCT i.product_id)::int AS products,
       (SELECT count(*)::int FROM (
          SELECT i2.product_id
          FROM inventory i2
          JOIN products p2 ON p2.id = i2.product_id
          WHERE i2.tenant_id = $1 AND i2.company_id = $2 AND i2.quantity >= 0
          GROUP BY i2.product_id
          HAVING COALESCE(sum(i2.quantity), 0) <= COALESCE(max(p2.reorder_point), 0)
        ) low) AS low_stock,
       count(*) FILTER (WHERE pb.expiry_date IS NOT NULL AND pb.expiry_date <= now() + interval '30 days')::int AS expiring,
       count(*) FILTER (WHERE i.reserved_qty > 0)::int AS reserved_lines,
       COALESCE(sum(i.reserved_qty), 0)::numeric AS reserved_qty,
       count(DISTINCT i.product_id) FILTER (WHERE p.type = ANY($3::text[]))::int AS material_lines,
       count(DISTINCT i.product_id) FILTER (WHERE p.type = ANY($4::text[]))::int AS consumable_lines,
       count(DISTINCT i.product_id) FILTER (WHERE NOT (p.type = ANY($3::text[]) OR p.type = ANY($4::text[])))::int AS product_lines,
       (SELECT count(*)::int FROM products p2 WHERE p2.tenant_id = $1 AND p2.company_id = $2 AND p2.type = ANY($3::text[])) AS catalog_materials,
       (SELECT count(*)::int FROM products p2 WHERE p2.tenant_id = $1 AND p2.company_id = $2 AND p2.type = ANY($4::text[])) AS catalog_consumables,
       (SELECT count(*)::int FROM products p2 WHERE p2.tenant_id = $1 AND p2.company_id = $2 AND NOT (p2.type = ANY($3::text[]) OR p2.type = ANY($4::text[]))) AS catalog_products,
       (SELECT count(*)::int FROM asset_register ar WHERE ar.tenant_id = $1 AND ar.company_id = $2 AND NOT ar.is_deleted) AS assets
     FROM inventory i
     JOIN products p ON p.id = i.product_id
     LEFT JOIN product_batches pb ON pb.id = i.batch_id
     WHERE i.tenant_id = $1 AND i.company_id = $2`,
    [ctx.tenantId, ctx.companyId, RAW_MATERIAL_TYPES, CONSUMABLE_TYPES]
  );
  return toCamelRow(res.rows[0]);
}

export async function warehouseBoard(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT w.id, w.code, w.name, w.type, w.is_secure, w.status,
            count(i.id)::int AS lines,
            count(DISTINCT i.product_id)::int AS products,
            COALESCE(sum(i.quantity), 0)::numeric AS quantity,
            COALESCE(sum(i.quantity * i.avg_cost), 0)::numeric(18,2) AS stock_value
     FROM warehouses w
     LEFT JOIN inventory i ON i.warehouse_id = w.id
     WHERE w.tenant_id = $1 AND w.company_id = $2
     GROUP BY w.id
     ORDER BY w.code`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function productStock(client: pg.PoolClient, ctx: Ctx, productId: number) {
  const prod = await client.query(
    `SELECT p.*, u.code AS unit_code, u.name AS unit_name
     FROM products p
     LEFT JOIN units u ON u.id = p.unit_id
     WHERE p.id = $1 AND p.tenant_id = $2`,
    [productId, ctx.tenantId]
  );
  if (!prod.rows.length) throw notFound('Product not found');
  const locations = await client.query(
    `SELECT i.id, i.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name, w.type AS warehouse_type,
            i.bin_id, b.code AS bin_code, i.batch_id, pb.batch_no,
            i.quantity, i.reserved_qty, (i.quantity - i.reserved_qty) AS available_qty,
            i.avg_cost, (i.quantity * i.avg_cost) AS stock_value
     FROM inventory i
     JOIN warehouses w ON w.id = i.warehouse_id
     LEFT JOIN warehouse_bins b ON b.id = i.bin_id
     LEFT JOIN product_batches pb ON pb.id = i.batch_id
     WHERE i.product_id = $1 AND i.tenant_id = $2
     ORDER BY w.code`,
    [productId, ctx.tenantId]
  );
  const movements = await client.query(
    `SELECT m.id, m.movement_no, m.movement_type, m.quantity, m.unit_cost, m.total_cost,
            m.warehouse_id, w.code AS warehouse_code, m.reason, m.reference_type, m.reference_code, m.created_at
     FROM inventory_movements m
     LEFT JOIN warehouses w ON w.id = m.warehouse_id
     WHERE m.product_id = $1 AND m.tenant_id = $2
     ORDER BY m.id DESC LIMIT 40`,
    [productId, ctx.tenantId]
  );
  return {
    product: toCamelRow(prod.rows[0]),
    locations: toCamelRows(locations.rows),
    movements: toCamelRows(movements.rows),
  };
}

export async function getAdjustment(client: pg.PoolClient, ctx: Ctx, adjustmentId: number) {
  const res = await client.query(
    `SELECT a.* FROM inventory_adjustments a WHERE a.id = $1 AND a.tenant_id = $2`,
    [adjustmentId, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Adjustment not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name,
            w.code AS warehouse_code, w.name AS warehouse_name
     FROM inventory_adjustment_items i
     JOIN products p ON p.id = i.product_id
     JOIN warehouses w ON w.id = i.warehouse_id
     WHERE i.adjustment_id = $1 ORDER BY i.id`,
    [adjustmentId]
  );
  return { adjustment: toCamelRow(res.rows[0]), items: toCamelRows(items.rows) };
}

export async function getTransfer(client: pg.PoolClient, ctx: Ctx, transferId: number) {
  const res = await client.query(
    `SELECT t.*, fw.code AS from_warehouse_code, fw.name AS from_warehouse_name,
            tw.code AS to_warehouse_code, tw.name AS to_warehouse_name
     FROM inventory_transfers t
     JOIN warehouses fw ON fw.id = t.from_warehouse_id
     JOIN warehouses tw ON tw.id = t.to_warehouse_id
     WHERE t.id = $1 AND t.tenant_id = $2`,
    [transferId, ctx.tenantId]
  );
  if (!res.rows.length) throw notFound('Transfer not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name
     FROM inventory_transfer_items i
     JOIN products p ON p.id = i.product_id
     WHERE i.transfer_id = $1 ORDER BY i.id`,
    [transferId]
  );
  return { transfer: toCamelRow(res.rows[0]), items: toCamelRows(items.rows) };
}

export async function listMovements(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; warehouseId?: number | null; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['m.tenant_id = $1', 'm.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(m.movement_no ILIKE $${params.length} OR p.code ILIKE $${params.length} OR p.name ILIKE $${params.length} OR m.reason ILIKE $${params.length})`);
  }
  if (filters.warehouseId) {
    params.push(filters.warehouseId);
    where.push(`(m.warehouse_id = $${params.length} OR m.from_warehouse_id = $${params.length} OR m.to_warehouse_id = $${params.length})`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT m.id, m.movement_no, m.movement_type, m.quantity, m.unit_cost, m.total_cost, m.status,
            m.reason, m.reference_type, m.reference_code, m.created_at,
            p.code AS product_code, p.name AS product_name,
            w.code AS warehouse_code, fw.code AS from_warehouse_code, tw.code AS to_warehouse_code
     FROM inventory_movements m
     JOIN products p ON p.id = m.product_id
     LEFT JOIN warehouses w ON w.id = m.warehouse_id
     LEFT JOIN warehouses fw ON fw.id = m.from_warehouse_id
     LEFT JOIN warehouses tw ON tw.id = m.to_warehouse_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const totalRes = await client.query(
    `SELECT count(*)::int AS n
     FROM inventory_movements m
     JOIN products p ON p.id = m.product_id
     WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(res.rows), total: Number(totalRes.rows[0].n), page, pageSize };
}
