import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';

export const PRODUCT_UOM_PURPOSES = ['BASE', 'PURCHASE', 'PRODUCTION', 'SALES', 'EFRIS'] as const;
export type ProductUomPurpose = (typeof PRODUCT_UOM_PURPOSES)[number];

export interface ProductUomInput {
  unitId: number;
  purpose: ProductUomPurpose;
  conversionFactor: number;
  isDefault?: boolean;
}

function assertPurpose(p: unknown): asserts p is ProductUomPurpose {
  if (typeof p !== 'string' || !(PRODUCT_UOM_PURPOSES as readonly string[]).includes(p)) {
    throw badRequest(`Invalid UOM purpose "${String(p)}"; expected one of: ${PRODUCT_UOM_PURPOSES.join(', ')}`);
  }
}

async function getProduct(client: pg.PoolClient, ctx: Ctx, productId: number) {
  const r = await client.query(
    `SELECT id, name, unit_id FROM products WHERE id = $1 AND tenant_id = $2`,
    [productId, ctx.tenantId]
  );
  if (r.rows.length === 0) throw notFound('Product not found');
  return r.rows[0] as { id: number; name: string; unit_id: number | null };
}

/** Units available for a product's per-purpose UOM mapping (for the picker). */
export async function listUnits(client: pg.PoolClient, ctx: Ctx) {
  const r = await client.query(
    `SELECT id, code, name FROM units WHERE tenant_id = $1 ORDER BY code ASC`,
    [ctx.tenantId]
  );
  return toCamelRows(r.rows);
}

/**
 * List a product's UOM mappings, always including a BASE row. If the product
 * has no stored BASE mapping, a synthetic one is derived from products.unit_id
 * so existing products work without a backfill.
 */
export async function listProductUoms(client: pg.PoolClient, ctx: Ctx, productId: number) {
  const product = await getProduct(client, ctx, productId);
  const r = await client.query(
    `SELECT pu.id, pu.product_id, pu.unit_id, pu.purpose, pu.conversion_factor, pu.is_default,
            u.code AS unit_code, u.name AS unit_name
       FROM product_uoms pu
       JOIN units u ON u.id = pu.unit_id
      WHERE pu.product_id = $1 AND pu.tenant_id = $2
      ORDER BY CASE pu.purpose
        WHEN 'BASE' THEN 0 WHEN 'PURCHASE' THEN 1 WHEN 'PRODUCTION' THEN 2
        WHEN 'SALES' THEN 3 WHEN 'EFRIS' THEN 4 END`,
    [productId, ctx.tenantId]
  );
  const rows = toCamelRows(r.rows) as Array<Record<string, unknown>>;
  if (!rows.some((x) => x.purpose === 'BASE') && product.unit_id != null) {
    const baseUnit = await client.query(`SELECT code, name FROM units WHERE id = $1`, [product.unit_id]);
    rows.unshift({
      id: null,
      productId,
      unitId: Number(product.unit_id),
      purpose: 'BASE',
      conversionFactor: 1,
      isDefault: true,
      unitCode: baseUnit.rows[0]?.code ?? null,
      unitName: baseUnit.rows[0]?.name ?? null,
    });
  }
  return rows;
}

/**
 * Replace all of a product's UOM mappings in one transaction. The BASE purpose
 * is pinned to the product's base unit (products.unit_id) at factor 1.
 */
export async function setProductUoms(client: pg.PoolClient, ctx: Ctx, productId: number, inputs: ProductUomInput[]) {
  const product = await getProduct(client, ctx, productId);
  if (!Array.isArray(inputs)) throw badRequest('Expected an array of UOM mappings');

  const seen = new Set<string>();
  const clean: ProductUomInput[] = [];
  for (const inp of inputs) {
    assertPurpose(inp.purpose);
    const unitId = Number(inp.unitId);
    if (!Number.isInteger(unitId) || unitId <= 0) throw badRequest('unitId is required for every UOM mapping');
    const factor = inp.purpose === 'BASE' ? 1 : Number(inp.conversionFactor);
    if (!(factor > 0)) throw badRequest(`conversionFactor for "${inp.purpose}" must be > 0`);
    if (seen.has(inp.purpose)) throw badRequest(`Duplicate UOM purpose "${inp.purpose}"`);
    seen.add(inp.purpose);
    clean.push({ unitId, purpose: inp.purpose, conversionFactor: factor, isDefault: !!inp.isDefault });
  }

  // The caller may omit BASE and rely on the derived base unit, but only when
  // the product actually has one.
  if (!seen.has('BASE') && product.unit_id == null) {
    throw badRequest('A BASE UOM is required for this product');
  }

  await client.query(`DELETE FROM product_uoms WHERE product_id = $1 AND tenant_id = $2`, [productId, ctx.tenantId]);
  for (const inp of clean) {
    await client.query(
      `INSERT INTO product_uoms (company_id, tenant_id, product_id, unit_id, purpose, conversion_factor, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.companyId, ctx.tenantId, productId, inp.unitId, inp.purpose, inp.conversionFactor, inp.isDefault]
    );
  }

  await logAudit(client, ctx, {
    action: 'update',
    resource: 'product_uoms',
    recordId: productId,
    recordCode: product.name,
    newValues: { purposes: clean.map((i) => i.purpose) },
  });

  return listProductUoms(client, ctx, productId);
}
