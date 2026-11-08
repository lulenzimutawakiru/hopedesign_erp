import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';
import { createRequisition } from './procurement.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => Number(v ?? 0);

export interface ReorderRuleInput {
  productId: number;
  warehouseId?: number | null;
  ruleType?: string | null;
  minQty?: number | null;
  maxQty?: number | null;
  reorderPoint?: number | null;
  eoqQty?: number | null;
  safetyStock?: number | null;
  leadTimeDays?: number | null;
  multipleQty?: number;
  preferredSupplierId?: number | null;
  isActive?: boolean;
}

const RULE_TYPES = ['MIN_MAX', 'ROP', 'EOQ', 'FORECAST_DRIVEN'];

const ruleColumns: Array<[keyof ReorderRuleInput, string, (v: unknown) => unknown]> = [
  ['productId', 'product_id', (v) => Number(v)],
  ['warehouseId', 'warehouse_id', (v) => (v != null && v !== '' ? Number(v) : null)],
  ['ruleType', 'rule_type', (v) => (v != null && v !== '' ? String(v) : 'MIN_MAX')],
  ['minQty', 'min_qty', (v) => (v != null && v !== '' ? Number(v) : null)],
  ['maxQty', 'max_qty', (v) => (v != null && v !== '' ? Number(v) : null)],
  ['reorderPoint', 'reorder_point', (v) => (v != null && v !== '' ? Number(v) : null)],
  ['eoqQty', 'eoq_qty', (v) => (v != null && v !== '' ? Number(v) : null)],
  ['safetyStock', 'safety_stock', (v) => (v != null && v !== '' ? Number(v) : null)],
  ['leadTimeDays', 'lead_time_days', (v) => (v != null && v !== '' ? Number(v) : null)],
  ['multipleQty', 'multiple_qty', (v) => (v != null && v !== '' ? Number(v) : 1)],
  ['preferredSupplierId', 'preferred_supplier_id', (v) => (v != null && v !== '' ? Number(v) : null)],
  ['isActive', 'is_active', (v) => v !== false],
];

/** Rules + product/warehouse/supplier labels + current on-hand and recommended order. */
export async function listReorderRules(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT rr.*,
       p.code AS product_code, p.name AS product_name, p.type AS product_type,
       p.reorder_point AS product_reorder_point, p.lead_time_days AS product_lead_time_days,
       u.code AS unit_code,
       w.code AS warehouse_code, w.name AS warehouse_name,
       s.name AS supplier_name,
       COALESCE((
         SELECT sum(i.quantity - i.reserved_qty - i.allocated_qty - i.blocked_qty - i.quality_hold_qty)
         FROM inventory i
         WHERE i.product_id = rr.product_id AND i.tenant_id = rr.tenant_id
           AND (rr.warehouse_id IS NULL OR i.warehouse_id = rr.warehouse_id)
       ), 0)::numeric AS on_hand
     FROM replenishment_rules rr
     JOIN products p ON p.id = rr.product_id
     LEFT JOIN units u ON u.id = p.unit_id
     LEFT JOIN warehouses w ON w.id = rr.warehouse_id
     LEFT JOIN suppliers s ON s.id = rr.preferred_supplier_id
     WHERE rr.tenant_id = $1
     ORDER BY p.code, rr.rule_type`,
    [ctx.tenantId]
  );
  return toCamelRows(res.rows).map((r) => {
    const onHand = num(r.onHand);
    const maxQty = r.maxQty != null ? num(r.maxQty) : null;
    const multiple = Math.max(1, num(r.multipleQty) || 1);
    const recommendedQty =
      maxQty != null && maxQty > onHand
        ? Math.ceil((maxQty - onHand) / multiple) * multiple
        : null;
    return { ...r, onHand, recommendedQty };
  });
}

export async function saveReorderRule(client: pg.PoolClient, ctx: Ctx, id: number | null, input: ReorderRuleInput) {
  if (!input.productId) throw badRequest('productId is required');
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');
  if (input.ruleType && !RULE_TYPES.includes(input.ruleType)) throw badRequest('Unsupported rule type');

  if (id == null) {
    const res = await client.query(
      `INSERT INTO replenishment_rules
         (company_id, tenant_id, product_id, warehouse_id, rule_type, min_qty, max_qty,
          reorder_point, eoq_qty, safety_stock, lead_time_days, multiple_qty,
          preferred_supplier_id, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        companyId, ctx.tenantId, input.productId,
        input.warehouseId ?? null,
        input.ruleType ?? 'MIN_MAX',
        input.minQty ?? null, input.maxQty ?? null,
        input.reorderPoint ?? null, input.eoqQty ?? null, input.safetyStock ?? null,
        input.leadTimeDays ?? null, Math.max(1, num(input.multipleQty) || 1),
        input.preferredSupplierId ?? null, input.isActive !== false, ctx.userId ?? null,
      ]
    );
    await logAudit(client, ctx, { action: 'create', resource: 'replenishment_rules', recordId: Number(res.rows[0].id), newValues: toCamelRow(res.rows[0]) });
    return toCamelRow(res.rows[0]);
  }

  const existing = await client.query(
    `SELECT * FROM replenishment_rules WHERE id = $1 AND tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (existing.rows.length === 0) throw notFound('Reordering rule not found');

  const sets: string[] = [];
  const vals: unknown[] = [];
  const changes: Record<string, unknown> = {};
  for (const [key, column, cast] of ruleColumns) {
    if (!(key in input)) continue;
    const value = cast(input[key]);
    changes[key] = value;
    vals.push(value);
    sets.push(`${column} = $${vals.length}`);
  }
  if (sets.length === 0) throw badRequest('No reordering rule fields to update');
  vals.push(id);
  const idIdx = vals.length;
  vals.push(ctx.tenantId);
  const tenantIdx = vals.length;
  const res = await client.query(
    `UPDATE replenishment_rules SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${idIdx} AND tenant_id = $${tenantIdx}
     RETURNING *`,
    vals
  );
  if (res.rowCount === 0) throw notFound('Reordering rule not found');
  await logAudit(client, ctx, { action: 'update', resource: 'replenishment_rules', recordId: id, newValues: changes });
  return toCamelRow(res.rows[0]);
}

export async function deleteReorderRule(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `DELETE FROM replenishment_rules WHERE id = $1 AND tenant_id = $2 RETURNING id, product_id`,
    [id, ctx.tenantId]
  );
  if (res.rowCount === 0) throw notFound('Reordering rule not found');
  await logAudit(client, ctx, { action: 'delete', resource: 'replenishment_rules', recordId: id });
  return { id, deleted: true };
}

/**
 * One-click replenishment: turn a rule into a DRAFT purchase requisition and
 * close any open reorder recommendation for the product so it stops nagging.
 */
export async function orderFromRule(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { productId: number; quantity?: number | null; warehouseId?: number | null; supplierId?: number | null }
) {
  if (!input.productId) throw badRequest('productId is required');
  const product = await client.query(
    `SELECT p.id, p.code, p.name FROM products p WHERE p.id = $1 AND p.tenant_id = $2`,
    [input.productId, ctx.tenantId]
  );
  if (product.rows.length === 0) throw notFound('Product not found');

  const quantity = Math.max(0, num(input.quantity));
  if (quantity <= 0) throw badRequest('Order quantity must be greater than zero');

  const result = await createRequisition(client, ctx, {
    title: `Replenish ${product.rows[0].name ?? product.rows[0].code}`,
    notes: 'Auto-created from reordering rules',
    category: 'GOODS',
    urgency: 'NORMAL',
    warehouseId: input.warehouseId ?? null,
    items: [
      {
        productId: input.productId,
        quantity,
        suggestedSupplierId: input.supplierId ?? null,
        description: `Replenish ${product.rows[0].name ?? product.rows[0].code} (${product.rows[0].code})`,
      },
    ],
  });

  await client.query(
    `UPDATE reorder_recommendations SET status = 'CONVERTED'
     WHERE product_id = $1 AND status = 'OPEN' AND tenant_id = $2`,
    [input.productId, ctx.tenantId]
  );

  return result;
}
