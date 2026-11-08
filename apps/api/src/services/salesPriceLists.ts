import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PriceListItemInput {
  productId: number;
  unitPrice: number;
  currency?: string;
  minQuantity?: number;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface PriceListInput {
  code?: string;
  name: string;
  currency?: string;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
  notes?: string | null;
}

async function nextCode(client: pg.PoolClient, ctx: Ctx, preferred?: string): Promise<string> {
  const trimmed = (preferred ?? '').trim().toUpperCase();
  if (trimmed) {
    const dup = await client.query('SELECT id FROM price_lists WHERE company_id = $1 AND code = $2', [ctx.companyId, trimmed]);
    if (dup.rows.length === 0) return trimmed;
    throw badRequest(`Price list code ${trimmed} already exists`);
  }
  const seq = await client.query('SELECT count(*)::int AS n FROM price_lists WHERE company_id = $1', [ctx.companyId]);
  return `PL-${String(Number(seq.rows[0]?.n ?? 0) + 1).padStart(4, '0')}`;
}

export async function listPriceLists(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT pl.id, pl.code, pl.name, pl.currency, pl.valid_from, pl.valid_to, pl.is_active, pl.notes,
            (SELECT count(*) FROM price_list_items pli WHERE pli.price_list_id = pl.id)::int AS item_count,
            (SELECT count(*) FROM customers c WHERE c.price_list_id = pl.id AND c.status IN ('ACTIVE','PROSPECT'))::int AS customer_count,
            pl.created_at, pl.updated_at
     FROM price_lists pl
     WHERE pl.tenant_id = $1 AND pl.company_id = $2
     ORDER BY pl.is_active DESC, pl.name`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function getPriceList(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT pl.* FROM price_lists pl WHERE pl.id = $1 AND pl.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Price list not found');
  const [items, customers] = await Promise.all([
    client.query(
      `SELECT pli.*, p.code AS product_code, p.name AS product_name, p.standard_price
       FROM price_list_items pli
       JOIN products p ON p.id = pli.product_id
       WHERE pli.price_list_id = $1
       ORDER BY p.name`,
      [id]
    ),
    client.query(
      `SELECT c.id, c.code, c.name, c.status
       FROM customers c
       WHERE c.price_list_id = $1 AND c.tenant_id = $2
       ORDER BY c.name`,
      [id, ctx.tenantId]
    ),
  ]);
  return { priceList: toCamelRow(res.rows[0]), items: toCamelRows(items.rows), customers: toCamelRows(customers.rows) };
}

export async function createPriceList(client: pg.PoolClient, ctx: Ctx, input: PriceListInput) {
  const name = String(input.name ?? '').trim();
  if (!name) throw badRequest('Price list name is required');
  const code = await nextCode(client, ctx, input.code);
  const ins = await client.query(
    `INSERT INTO price_lists (company_id, tenant_id, code, name, currency, valid_from, valid_to, is_active, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      ctx.companyId, ctx.tenantId, code, name,
      input.currency ?? 'UGX',
      input.validFrom ?? null, input.validTo ?? null,
      input.isActive ?? true, input.notes ?? null,
    ]
  );
  const row = toCamelRow(ins.rows[0]);
  await logAudit(client, ctx, { action: 'create', resource: 'price_lists', recordId: Number(row.id), recordCode: code, newValues: { name, currency: row.currency } });
  return row;
}

export async function updatePriceList(client: pg.PoolClient, ctx: Ctx, id: number, input: PriceListInput) {
  const cur = await client.query('SELECT * FROM price_lists WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  if (cur.rows.length === 0) throw notFound('Price list not found');
  const sets: string[] = [];
  const values: unknown[] = [ctx.tenantId, id];
  const push = (col: string, v: unknown) => { sets.push(`${col} = $${values.length + 1}`); values.push(v); };
  if (input.name !== undefined) push('name', String(input.name).trim());
  if (input.currency !== undefined) push('currency', String(input.currency).trim() || 'UGX');
  if (input.validFrom !== undefined) push('valid_from', input.validFrom || null);
  if (input.validTo !== undefined) push('valid_to', input.validTo || null);
  if (input.isActive !== undefined) push('is_active', Boolean(input.isActive));
  if (input.notes !== undefined) push('notes', input.notes ?? null);
  if (sets.length) {
    sets.push('updated_at = now()');
    await client.query(`UPDATE price_lists SET ${sets.join(', ')} WHERE id = $2 AND tenant_id = $1`, values);
  }
  const out = await client.query('SELECT * FROM price_lists WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  const row = toCamelRow(out.rows[0]);
  await logAudit(client, ctx, { action: 'update', resource: 'price_lists', recordId: id, recordCode: String(row.code), newValues: { name: input.name } });
  return row;
}

/** Deactivate rather than hard-delete so history + customer references survive. */
export async function deletePriceList(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `UPDATE price_lists SET is_active = false, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING id, code`,
    [id, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Price list not found');
  await client.query('UPDATE customers SET price_list_id = NULL WHERE price_list_id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  await logAudit(client, ctx, { action: 'delete', resource: 'price_lists', recordId: id, recordCode: String(res.rows[0].code), newValues: { is_active: false } });
  return { id, deactivated: true };
}

/** Replace the item set for a price list in one atomic operation. */
export async function savePriceListItems(client: pg.PoolClient, ctx: Ctx, id: number, items: PriceListItemInput[]) {
  const cur = await client.query('SELECT id FROM price_lists WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  if (cur.rows.length === 0) throw notFound('Price list not found');
  await client.query('DELETE FROM price_list_items WHERE price_list_id = $1', [id]);
  for (const it of items) {
    const price = Number(it.unitPrice);
    if (!Number.isFinite(price) || price < 0) throw badRequest('Item price must be a non-negative number');
    const product = await client.query('SELECT id FROM products WHERE id = $1 AND tenant_id = $2', [it.productId, ctx.tenantId]);
    if (product.rows.length === 0) throw badRequest(`Product ${it.productId} not found`);
    await client.query(
      `INSERT INTO price_list_items (price_list_id, product_id, unit_price, currency, min_quantity, effective_from, effective_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, it.productId, round2(price), it.currency ?? 'UGX', Number(it.minQuantity ?? 0) || 0, it.effectiveFrom ?? null, it.effectiveTo ?? null]
    );
  }
  const res = await client.query('SELECT count(*)::int AS n FROM price_list_items WHERE price_list_id = $1', [id]);
  await logAudit(client, ctx, { action: 'update', resource: 'price_lists', recordId: id, newValues: { itemCount: res.rows[0].n } });
  return { priceListId: id, itemCount: res.rows[0].n };
}

export async function assignPriceListToCustomer(client: pg.PoolClient, ctx: Ctx, customerId: number, priceListId: number | null) {
  const cust = await client.query('SELECT id FROM customers WHERE id = $1 AND tenant_id = $2', [customerId, ctx.tenantId]);
  if (cust.rows.length === 0) throw notFound('Customer not found');
  if (priceListId != null) {
    const pl = await client.query('SELECT id FROM price_lists WHERE id = $1 AND tenant_id = $2', [priceListId, ctx.tenantId]);
    if (pl.rows.length === 0) throw notFound('Price list not found');
  }
  await client.query('UPDATE customers SET price_list_id = $1, updated_at = now() WHERE id = $2', [priceListId, customerId]);
  await logAudit(client, ctx, { action: 'update', resource: 'customers', recordId: customerId, newValues: { priceListId } });
  return { customerId, priceListId };
}

/** Effective sale price for a product under the customer's active price list, else null. */
export async function resolveUnitPrice(client: pg.PoolClient, ctx: Ctx, customerId: number, productId: number): Promise<number | null> {
  const res = await client.query(
    `SELECT pli.unit_price::numeric AS price
     FROM customers c
     JOIN price_lists pl ON pl.id = c.price_list_id AND pl.is_active = true
     JOIN price_list_items pli ON pli.price_list_id = pl.id AND pli.product_id = $2
     WHERE c.id = $1 AND c.tenant_id = $3
       AND (pl.valid_from IS NULL OR pl.valid_from <= CURRENT_DATE)
       AND (pl.valid_to IS NULL OR pl.valid_to >= CURRENT_DATE)
       AND (pli.effective_from IS NULL OR pli.effective_from <= CURRENT_DATE)
       AND (pli.effective_to IS NULL OR pli.effective_to >= CURRENT_DATE)
       AND (pli.min_quantity IS NULL OR pli.min_quantity <= 0)
     ORDER BY pli.id LIMIT 1`,
    [customerId, productId, ctx.tenantId]
  );
  return res.rows.length ? Number(res.rows[0].price) : null;
}
