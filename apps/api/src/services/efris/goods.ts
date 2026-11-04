import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, notFound, toCamelRows } from '../../utils.js';
import { logAudit } from '../audit.js';

export const EFRIS_REGISTRATION_STATUSES = ['UNMAPPED', 'MAPPED', 'SUBMITTED', 'REGISTERED', 'EXCLUDED'] as const;
export type EfrisRegistrationStatus = (typeof EFRIS_REGISTRATION_STATUSES)[number];

export interface EfrisGoodsInput {
  goodsCode: string;
  goodsName: string;
  categoryId?: string | null;
  categoryName?: string | null;
  unitOfMeasure?: string | null;
  vatRate?: number;
  exciseRate?: number;
  isActive?: boolean;
}

function assertStatus(s: unknown): asserts s is EfrisRegistrationStatus {
  if (typeof s !== 'string' || !(EFRIS_REGISTRATION_STATUSES as readonly string[]).includes(s)) {
    throw badRequest(`Invalid registration status "${String(s)}"; expected one of: ${EFRIS_REGISTRATION_STATUSES.join(', ')}`);
  }
}

/** Search the URA goods catalogue copy. */
export async function listGoods(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { q?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? 100), 500);
  const offset = (page - 1) * pageSize;
  const params: unknown[] = [ctx.tenantId];
  let where = 'g.tenant_id = $1';
  if (opts.q && String(opts.q).trim()) {
    params.push(`%${String(opts.q).trim()}%`);
    where += ` AND (g.goods_code ILIKE $2 OR g.goods_name ILIKE $2 OR g.category_name ILIKE $2)`;
  }
  const total = await client.query(`SELECT COUNT(*)::int AS n FROM efris_goods g WHERE ${where}`, params);
  params.push(pageSize, offset);
  const rows = await client.query(
    `SELECT g.* FROM efris_goods g WHERE ${where} ORDER BY g.goods_name ASC, g.goods_code ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: toCamelRows(rows.rows), pagination: { page, pageSize, total: Number(total.rows[0].n) } };
}

/** Bulk-upsert catalogue rows (idempotent on goods_code). */
export async function importGoods(client: pg.PoolClient, ctx: Ctx, items: EfrisGoodsInput[]) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Expected a non-empty array of goods');
  const clean = items.map((it) => ({
    goodsCode: String(it.goodsCode ?? '').trim(),
    goodsName: String(it.goodsName ?? '').trim(),
    categoryId: it.categoryId != null ? String(it.categoryId) : null,
    categoryName: it.categoryName != null ? String(it.categoryName) : null,
    unitOfMeasure: it.unitOfMeasure != null ? String(it.unitOfMeasure) : null,
    vatRate: Number(it.vatRate ?? 0),
    exciseRate: Number(it.exciseRate ?? 0),
    isActive: it.isActive !== false,
  }));
  let inserted = 0;
  for (const g of clean) {
    if (!g.goodsCode || !g.goodsName) throw badRequest('goodsCode and goodsName are required for every goods row');
    const r = await client.query(
      `INSERT INTO efris_goods (company_id, tenant_id, goods_code, goods_name, category_id, category_name, unit_of_measure, vat_rate, excise_rate, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (company_id, goods_code) DO UPDATE SET
         goods_name = EXCLUDED.goods_name,
         category_id = EXCLUDED.category_id,
         category_name = EXCLUDED.category_name,
         unit_of_measure = EXCLUDED.unit_of_measure,
         vat_rate = EXCLUDED.vat_rate,
         excise_rate = EXCLUDED.excise_rate,
         is_active = EXCLUDED.is_active,
         updated_at = now()
       RETURNING id`,
      [ctx.companyId, ctx.tenantId, g.goodsCode, g.goodsName, g.categoryId, g.categoryName, g.unitOfMeasure, g.vatRate, g.exciseRate, g.isActive]
    );
    inserted += r.rows.length;
  }
  await logAudit(client, ctx, { action: 'import', resource: 'efris_goods', recordId: 0, recordCode: null, newValues: { count: clean.length } });
  return { imported: inserted, received: clean.length };
}

/** Products joined to their goods mapping + registration status. */
export async function listProductRegistrations(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? 100), 500);
  const offset = (page - 1) * pageSize;
  const params: unknown[] = [ctx.tenantId];
  let where = 'p.tenant_id = $1';
  if (opts.status && String(opts.status).trim()) {
    params.push(String(opts.status).trim());
    where += ` AND p.efris_registration_status = $${params.length}`;
  }
  if (opts.q && String(opts.q).trim()) {
    params.push(`%${String(opts.q).trim()}%`);
    where += ` AND (p.code ILIKE $${params.length} OR p.name ILIKE $${params.length} OR p.efris_goods_code ILIKE $${params.length} OR p.efris_goods_name ILIKE $${params.length})`;
  }
  const total = await client.query(`SELECT COUNT(*)::int AS n FROM products p WHERE ${where}`, params);
  params.push(pageSize, offset);
  const rows = await client.query(
    `SELECT p.id, p.code, p.name, p.type, p.unit_id,
            p.efris_goods_code, p.efris_goods_name, p.efris_goods_category_id, p.efris_goods_category_name,
            p.efris_unit_of_measure, p.efris_registration_status, p.efris_registered_at,
            g.vat_rate AS catalogue_vat_rate, g.excise_rate AS catalogue_excise_rate
       FROM products p
       LEFT JOIN efris_goods g ON g.goods_code = p.efris_goods_code AND g.tenant_id = p.tenant_id
      WHERE ${where}
      ORDER BY p.efris_registration_status = 'UNMAPPED' DESC, p.name ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: toCamelRows(rows.rows), pagination: { page, pageSize, total: Number(total.rows[0].n) } };
}

/** Map a product to a catalogue entry and mark it MAPPED. */
export async function mapProductToGoods(client: pg.PoolClient, ctx: Ctx, productId: number, input: { goodsCode: string }) {
  const goodsCode = String(input?.goodsCode ?? '').trim();
  if (!goodsCode) throw badRequest('goodsCode is required');

  const prod = await client.query(
    `SELECT id, code, name FROM products WHERE id = $1 AND tenant_id = $2`,
    [productId, ctx.tenantId]
  );
  if (prod.rows.length === 0) throw notFound('Product not found');

  const g = await client.query(
    `SELECT * FROM efris_goods WHERE goods_code = $1 AND tenant_id = $2`,
    [goodsCode, ctx.tenantId]
  );
  if (g.rows.length === 0) throw badRequest(`No catalogue entry for goods code "${goodsCode}"`);

  const row = g.rows[0];
  // Remapping invalidates any prior registration confirmation.
  await client.query(
    `UPDATE products SET
       efris_goods_code = $3, efris_goods_name = $4,
       efris_goods_category_id = $5, efris_goods_category_name = $6,
       efris_unit_of_measure = $7, efris_registration_status = 'MAPPED', efris_registered_at = NULL
     WHERE id = $1 AND tenant_id = $2`,
    [productId, ctx.tenantId, row.goods_code, row.goods_name, row.category_id, row.category_name, row.unit_of_measure]
  );

  await logAudit(client, ctx, {
    action: 'map', resource: 'product', recordId: productId,
    recordCode: String(prod.rows[0].code ?? ''), newValues: { efris_goods_code: row.goods_code },
  });
  return { productId, efrisGoodsCode: row.goods_code, efrisRegistrationStatus: 'MAPPED' };
}

/**
 * Set a product's registration status. This is an operator/administrative
 * action: REGISTERED is confirmed against URA evidence, never auto-derived.
 */
export async function setRegistrationStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  productId: number,
  input: { status: string }
) {
  assertStatus(input?.status);
  const prod = await client.query(
    `SELECT id, code, name, efris_goods_code, efris_registration_status FROM products WHERE id = $1 AND tenant_id = $2`,
    [productId, ctx.tenantId]
  );
  if (prod.rows.length === 0) throw notFound('Product not found');

  const registeredAt = input.status === 'REGISTERED' ? 'now()' : 'NULL';
  await client.query(
    `UPDATE products SET efris_registration_status = $3, efris_registered_at = ${registeredAt}
     WHERE id = $1 AND tenant_id = $2`,
    [productId, ctx.tenantId, input.status]
  );

  await logAudit(client, ctx, {
    action: 'set_status', resource: 'product', recordId: productId,
    recordCode: String(prod.rows[0].code ?? ''),
    oldValues: { efris_registration_status: prod.rows[0].efris_registration_status },
    newValues: { efris_registration_status: input.status },
  });
  return { productId, efrisRegistrationStatus: input.status };
}
