import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, parsePagination, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { logAudit } from './audit.js';

/**
 * Odoo "Purchase" parity — the sourcing records that exist in the schema but
 * were never surfaced as first-class screens:
 *
 *  - Vendor price lists   (supplier_price_lists)  — per-supplier product prices
 *  - Supplier contracts   (supplier_contracts)    — purchase agreements
 *  - Supplier evaluations (supplier_evaluations)  — vendor performance scoring
 *  - Purchase analysis    — ordered spend by supplier and by product
 *
 * All three tables were created in migration 0004 but are only reachable
 * through the generic record registry (or not at all); this service exposes
 * them with the same tenant scoping the procurement module already uses.
 */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
};
const isDate = (v: unknown): boolean => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

/** Suppliers + products for the sourcing forms. */
export async function sourcingMeta(client: pg.PoolClient, ctx: Ctx) {
  const sup = await client.query(
    `SELECT id, code, name FROM suppliers WHERE tenant_id = $1 AND company_id = $2 AND status <> 'BLOCKED' ORDER BY name LIMIT 500`,
    [ctx.tenantId, ctx.companyId]
  );
  const prd = await client.query(
    `SELECT id, code, name FROM products WHERE tenant_id = $1 AND company_id = $2 ORDER BY code LIMIT 1000`,
    [ctx.tenantId, ctx.companyId]
  );
  return { suppliers: toCamelRows(sup.rows), products: toCamelRows(prd.rows) };
}

// ---------------------------------------------------------------------------
// Vendor price lists
// ---------------------------------------------------------------------------

export async function listVendorPricelists(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; supplierId?: number; productId?: number; page?: number; pageSize?: number } = {}
) {
  const { page, pageSize, offset } = parsePagination({ page: filters.page, pageSize: filters.pageSize });
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['pl.tenant_id = $1', 'pl.company_id = $2'];
  if (filters.supplierId) { params.push(filters.supplierId); where.push('pl.supplier_id = $' + params.length); }
  if (filters.productId) { params.push(filters.productId); where.push('pl.product_id = $' + params.length); }
  if (filters.q?.trim()) {
    params.push('%' + filters.q.trim() + '%');
    where.push('(s.name ILIKE $' + params.length + ' OR p.name ILIKE $' + params.length + ' OR p.code ILIKE $' + params.length + ')');
  }
  const whereSql = where.join(' AND ');
  const res = await client.query(
    `SELECT pl.id, pl.supplier_id, pl.product_id, pl.unit_price, pl.currency,
            pl.effective_from, pl.effective_to, pl.lead_time_days, pl.minimum_order_qty, pl.notes,
            s.code AS supplier_code, s.name AS supplier_name,
            p.code AS product_code, p.name AS product_name
       FROM supplier_price_lists pl
       JOIN suppliers s ON s.id = pl.supplier_id
       JOIN products p ON p.id = pl.product_id
      WHERE ${whereSql}
      ORDER BY p.code, pl.effective_from DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  const count = await client.query(
    `SELECT count(*)::int AS n FROM supplier_price_lists pl
      JOIN suppliers s ON s.id = pl.supplier_id JOIN products p ON p.id = pl.product_id
      WHERE ${whereSql}`,
    params
  );
  const rows = res.rows.map((r) => {
    const out = toCamelRow(r);
    out.effectiveFrom = toISODate(r.effective_from);
    out.effectiveTo = toISODate(r.effective_to);
    return out;
  });
  return { rows, page, pageSize, totalCount: Number(count.rows[0].n) || 0 };
}

export async function createVendorPricelist(client: pg.PoolClient, ctx: Ctx, input: Record<string, unknown>) {
  const supplierId = num(input.supplierId);
  const productId = num(input.productId);
  const unitPrice = input.unitPrice == null ? null : num(input.unitPrice);
  if (!supplierId) throw badRequest('supplierId is required');
  if (!productId) throw badRequest('productId is required');
  if (unitPrice == null || unitPrice < 0) throw badRequest('unitPrice is required and cannot be negative');
  const effectiveFrom = text(input.effectiveFrom);
  const effectiveTo = text(input.effectiveTo);
  if (effectiveFrom && !isDate(effectiveFrom)) throw badRequest('effectiveFrom must be a YYYY-MM-DD date');
  if (effectiveTo && !isDate(effectiveTo)) throw badRequest('effectiveTo must be a YYYY-MM-DD date');

  let res: pg.QueryResult;
  try {
    res = await client.query(
      `INSERT INTO supplier_price_lists
         (company_id, tenant_id, supplier_id, product_id, unit_price, currency, effective_from, effective_to, lead_time_days, minimum_order_qty, notes)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date,CURRENT_DATE),$8::date,$9,$10,$11)
       RETURNING *`,
      [
        ctx.companyId, ctx.tenantId, supplierId, productId, unitPrice,
        text(input.currency) ?? 'UGX',
        effectiveFrom ?? null, effectiveTo ?? null,
        input.leadTimeDays == null ? null : num(input.leadTimeDays),
        input.minimumOrderQty == null ? 0 : num(input.minimumOrderQty),
        text(input.notes) ?? null,
      ]
    );
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === '23505') {
      throw badRequest('This supplier already has a price for that product starting on that date');
    }
    throw e;
  }
  const row = res.rows[0];
  await logAudit(client, ctx, { action: 'create', resource: 'supplier_price_lists', recordId: Number(row.id), newValues: { supplierId, productId, unitPrice } });
  return toCamelRow(row);
}

export async function updateVendorPricelist(client: pg.PoolClient, ctx: Ctx, id: number, input: Record<string, unknown>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => { sets.push(`${col} = $${vals.length + 1}`); vals.push(v); };

  if ('unitPrice' in input) add('unit_price', num(input.unitPrice));
  if ('currency' in input) add('currency', text(input.currency) ?? 'UGX');
  if ('effectiveFrom' in input) add('effective_from', text(input.effectiveFrom) ?? null);
  if ('effectiveTo' in input) add('effective_to', text(input.effectiveTo) ?? null);
  if ('leadTimeDays' in input) add('lead_time_days', input.leadTimeDays == null ? null : num(input.leadTimeDays));
  if ('minimumOrderQty' in input) add('minimum_order_qty', input.minimumOrderQty == null ? 0 : num(input.minimumOrderQty));
  if ('notes' in input) add('notes', text(input.notes) ?? null);

  if (!sets.length) throw badRequest('No fields to update');
  let res: pg.QueryResult;
  try {
    res = await client.query(
      `UPDATE supplier_price_lists SET ${sets.join(', ')}
       WHERE id = $${vals.length + 1} AND tenant_id = $${vals.length + 2} AND company_id = $${vals.length + 3}
       RETURNING *`,
      [...vals, id, ctx.tenantId, ctx.companyId]
    );
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === '23505') throw badRequest('Duplicate price list entry');
    throw e;
  }
  if (res.rowCount === 0) throw notFound('Price list entry not found');
  await logAudit(client, ctx, { action: 'update', resource: 'supplier_price_lists', recordId: id, newValues: input });
  return toCamelRow(res.rows[0]);
}

// ---------------------------------------------------------------------------
// Supplier contracts
// ---------------------------------------------------------------------------

const CONTRACT_STATUSES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED'];

export async function listSupplierContracts(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; supplierId?: number; status?: string; page?: number; pageSize?: number } = {}
) {
  const { page, pageSize, offset } = parsePagination({ page: filters.page, pageSize: filters.pageSize });
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['sc.tenant_id = $1', 'sc.company_id = $2'];
  if (filters.supplierId) { params.push(filters.supplierId); where.push('sc.supplier_id = $' + params.length); }
  if (filters.status) { params.push(filters.status); where.push('sc.status = $' + params.length); }
  if (filters.q?.trim()) {
    params.push('%' + filters.q.trim() + '%');
    where.push('(sc.contract_no ILIKE $' + params.length + ' OR sc.title ILIKE $' + params.length + ' OR s.name ILIKE $' + params.length + ')');
  }
  const whereSql = where.join(' AND ');
  const res = await client.query(
    `SELECT sc.id, sc.supplier_id, sc.contract_no, sc.title, sc.start_date, sc.end_date, sc.value, sc.terms, sc.status,
            s.code AS supplier_code, s.name AS supplier_name
       FROM supplier_contracts sc
       JOIN suppliers s ON s.id = sc.supplier_id
      WHERE ${whereSql}
      ORDER BY sc.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  const count = await client.query(
    `SELECT count(*)::int AS n FROM supplier_contracts sc JOIN suppliers s ON s.id = sc.supplier_id WHERE ${whereSql}`,
    params
  );
  const rows = res.rows.map((r) => {
    const out = toCamelRow(r);
    out.startDate = toISODate(r.start_date);
    out.endDate = toISODate(r.end_date);
    return out;
  });
  return { rows, page, pageSize, totalCount: Number(count.rows[0].n) || 0 };
}

export async function createSupplierContract(client: pg.PoolClient, ctx: Ctx, input: Record<string, unknown>) {
  const supplierId = num(input.supplierId);
  const contractNo = text(input.contractNo);
  const title = text(input.title);
  const startDate = text(input.startDate);
  if (!supplierId) throw badRequest('supplierId is required');
  if (!contractNo) throw badRequest('contractNo is required');
  if (!title) throw badRequest('title is required');
  if (!startDate || !isDate(startDate)) throw badRequest('startDate is required and must be a YYYY-MM-DD date');
  const endDate = text(input.endDate);
  if (endDate && !isDate(endDate)) throw badRequest('endDate must be a YYYY-MM-DD date');
  const status = text(input.status) ?? 'DRAFT';
  if (!CONTRACT_STATUSES.includes(status)) throw badRequest(`status must be one of ${CONTRACT_STATUSES.join(', ')}`);

  let res: pg.QueryResult;
  try {
    res = await client.query(
      `INSERT INTO supplier_contracts
         (company_id, tenant_id, supplier_id, contract_no, title, start_date, end_date, value, terms, status)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10) RETURNING *`,
      [ctx.companyId, ctx.tenantId, supplierId, contractNo, title, startDate, endDate ?? null, num(input.value), text(input.terms) ?? null, status]
    );
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === '23505') throw badRequest('A contract with this number already exists');
    throw e;
  }
  const row = res.rows[0];
  await logAudit(client, ctx, { action: 'create', resource: 'supplier_contracts', recordId: Number(row.id), recordCode: String(row.contract_no), newValues: { supplierId, contractNo, title, status } });
  return toCamelRow(row);
}

export async function updateSupplierContract(client: pg.PoolClient, ctx: Ctx, id: number, input: Record<string, unknown>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => { sets.push(`${col} = $${vals.length + 1}`); vals.push(v); };

  if ('supplierId' in input) add('supplier_id', num(input.supplierId));
  if ('contractNo' in input) add('contract_no', text(input.contractNo));
  if ('title' in input) add('title', text(input.title));
  if ('startDate' in input) add('start_date', text(input.startDate) ?? null);
  if ('endDate' in input) add('end_date', text(input.endDate) ?? null);
  if ('value' in input) add('value', num(input.value));
  if ('terms' in input) add('terms', text(input.terms) ?? null);
  if ('status' in input) {
    const s = text(input.status);
    if (s && !CONTRACT_STATUSES.includes(s)) throw badRequest(`status must be one of ${CONTRACT_STATUSES.join(', ')}`);
    add('status', s);
  }

  if (!sets.length) throw badRequest('No fields to update');
  let res: pg.QueryResult;
  try {
    res = await client.query(
      `UPDATE supplier_contracts SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${vals.length + 1} AND tenant_id = $${vals.length + 2} AND company_id = $${vals.length + 3}
       RETURNING *`,
      [...vals, id, ctx.tenantId, ctx.companyId]
    );
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === '23505') throw badRequest('A contract with this number already exists');
    throw e;
  }
  if (res.rowCount === 0) throw notFound('Contract not found');
  await logAudit(client, ctx, { action: 'update', resource: 'supplier_contracts', recordId: id, newValues: input });
  return toCamelRow(res.rows[0]);
}

// ---------------------------------------------------------------------------
// Supplier evaluations
// ---------------------------------------------------------------------------

export async function listSupplierEvaluations(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { supplierId?: number; page?: number; pageSize?: number } = {}
) {
  const { page, pageSize, offset } = parsePagination({ page: filters.page, pageSize: filters.pageSize });
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['s.tenant_id = $1', 's.company_id = $2'];
  if (filters.supplierId) { params.push(filters.supplierId); where.push('e.supplier_id = $' + params.length); }
  const whereSql = where.join(' AND ');
  const res = await client.query(
    `SELECT e.id, e.supplier_id, e.quality_score, e.delivery_score, e.price_score, e.compliance_score, e.overall_score,
            e.comments, e.evaluated_at, e.evaluated_by,
            s.code AS supplier_code, s.name AS supplier_name,
            u.username AS evaluated_by_name, u.first_name, u.last_name
       FROM supplier_evaluations e
       JOIN suppliers s ON s.id = e.supplier_id
       LEFT JOIN users u ON u.id = e.evaluated_by
      WHERE ${whereSql}
      ORDER BY e.evaluated_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  const count = await client.query(
    `SELECT count(*)::int AS n FROM supplier_evaluations e JOIN suppliers s ON s.id = e.supplier_id WHERE ${whereSql}`,
    params
  );
  const rows = res.rows.map((r) => {
    const out = toCamelRow(r);
    out.evaluatedAt = r.evaluated_at == null ? null : String(r.evaluated_at);
    out.evaluatedByName = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.evaluated_by_name;
    return out;
  });
  return { rows, page, pageSize, totalCount: Number(count.rows[0].n) || 0 };
}

export async function createSupplierEvaluation(client: pg.PoolClient, ctx: Ctx, input: Record<string, unknown>) {
  const supplierId = num(input.supplierId);
  if (!supplierId) throw badRequest('supplierId is required');
  if (!ctx.userId) throw badRequest('User context required');
  const score = (v: unknown): number | null => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const quality = score(input.qualityScore);
  const delivery = score(input.deliveryScore);
  const price = score(input.priceScore);
  const compliance = score(input.complianceScore);
  const overall = score(input.overallScore);
  if ([quality, delivery, price, compliance].every((s) => s == null) && overall == null) {
    throw badRequest('Provide at least one score');
  }
  const res = await client.query(
    `INSERT INTO supplier_evaluations
       (supplier_id, evaluated_by, quality_score, delivery_score, price_score, compliance_score, overall_score, comments)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [supplierId, ctx.userId, quality, delivery, price, compliance, overall, text(input.comments) ?? null]
  );
  const row = res.rows[0];
  await logAudit(client, ctx, { action: 'create', resource: 'supplier_evaluations', recordId: Number(row.id), newValues: { supplierId, quality, delivery, price, compliance, overall } });
  return toCamelRow(row);
}

// ---------------------------------------------------------------------------
// Purchase analysis
// ---------------------------------------------------------------------------

export async function purchaseAnalysis(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { fromDate?: string; toDate?: string } = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['po.tenant_id = $1', 'po.company_id = $2'];
  if (filters.fromDate) { params.push(filters.fromDate); where.push('po.order_date >= $' + params.length + '::date'); }
  if (filters.toDate) { params.push(filters.toDate); where.push('po.order_date <= $' + params.length + '::date'); }
  const whereSql = where.join(' AND ');

  const bySupplier = await client.query(
    `SELECT s.id, s.code, s.name,
            COUNT(DISTINCT po.id)::int AS order_count,
            COALESCE(SUM(poi.quantity),0) AS quantity,
            COALESCE(SUM(poi.line_total),0) AS amount
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.order_id
       JOIN suppliers s ON s.id = po.supplier_id
      WHERE ${whereSql}
      GROUP BY s.id, s.code, s.name
      ORDER BY amount DESC`,
    params
  );
  const byProduct = await client.query(
    `SELECT p.id, p.code, p.name,
            COUNT(DISTINCT po.id)::int AS order_count,
            COALESCE(SUM(poi.quantity),0) AS quantity,
            COALESCE(SUM(poi.line_total),0) AS amount
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.order_id
       JOIN products p ON p.id = poi.product_id
      WHERE ${whereSql}
      GROUP BY p.id, p.code, p.name
      ORDER BY amount DESC`,
    params
  );
  const totals = await client.query(
    `SELECT COUNT(DISTINCT po.id)::int AS orders,
            COALESCE(SUM(poi.quantity),0) AS quantity,
            COALESCE(SUM(poi.line_total),0) AS amount
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.order_id
      WHERE ${whereSql}`,
    params
  );

  return {
    bySupplier: toCamelRows(bySupplier.rows),
    byProduct: toCamelRows(byProduct.rows),
    totals: toCamelRow(totals.rows[0]),
  };
}
