import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest } from '../utils.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Material Requirements Planning engine.
 *
 * Computes gross requirements from approved demand forecasts plus open sales
 * orders, subtracts available inventory, reserved stock and scheduled
 * receipts, then emits purchase or production suggestions per product.
 */
export async function runMrp(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { horizonStart?: string | null; horizonEnd?: string | null; runType?: string } = {}
) {
  const companyId = ctx.companyId;
  if (!companyId) throw badRequest('Company context required');
  const runNoRes = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, 'MRP']);
  const runNo = String(runNoRes.rows[0].code);
  const horizonStart = input.horizonStart ?? new Date().toISOString().slice(0, 10);
  const horizonEnd = input.horizonEnd ?? '9999-12-31';

  const ins = await client.query(
    `INSERT INTO mrp_runs
       (company_id, tenant_id, run_no, run_type, horizon_start, horizon_end, status, run_by)
     VALUES ($1,$2,$3,$4,$5,$6,'RUNNING',$7) RETURNING id`,
    [companyId, ctx.tenantId, runNo, input.runType ?? 'MANUAL', horizonStart, horizonEnd, ctx.userId ?? null]
  );
  const runId = Number(ins.rows[0].id);

  // --- Gross requirements: approved forecasts overlapping the horizon ---
  const forecastRes = await client.query(
    `SELECT product_id, SUM(quantity)::numeric AS qty
     FROM demand_forecasts
     WHERE tenant_id = $1 AND status = 'APPROVED'
       AND period_start <= $2 AND period_end >= $3
     GROUP BY product_id`,
    [ctx.tenantId, horizonEnd, horizonStart]
  );

  // --- Gross requirements: open sales orders (remaining, undispatched qty) ---
  const soRes = await client.query(
    `SELECT soi.product_id, SUM(soi.quantity - soi.dispatched_qty)::numeric AS qty
     FROM sales_order_items soi
     JOIN sales_orders so ON so.id = soi.order_id
     WHERE so.tenant_id = $1
       AND so.status IN ('APPROVED','ALLOCATED','PARTIALLY_DISPATCHED','DISPATCHED')
     GROUP BY soi.product_id`,
    [ctx.tenantId]
  );

  const gross = new Map<number, number>();
  for (const r of forecastRes.rows) gross.set(Number(r.product_id), (gross.get(Number(r.product_id)) ?? 0) + Number(r.qty));
  for (const r of soRes.rows) gross.set(Number(r.product_id), (gross.get(Number(r.product_id)) ?? 0) + Number(r.qty));

  const productIds = [...gross.keys()];
  if (productIds.length === 0) {
    await client.query(
      `UPDATE mrp_runs SET status = 'COMPLETED', summary = $1, completed_at = now() WHERE id = $2`,
      [JSON.stringify({ products: 0, total_purchase: 0, total_production: 0 }), runId]
    );
    await emitEvent(client, ctx, { eventType: 'mrp.completed', entityType: 'mrp_runs', entityId: runId, entityCode: runNo, payload: { products: 0 } });
    return { runId, runNo, products: [] };
  }

  // --- Available stock (on hand minus reserved) per product ---
  const availRes = await client.query(
    `SELECT product_id, SUM(quantity - reserved_qty)::numeric AS qty
     FROM inventory WHERE tenant_id = $1 GROUP BY product_id`,
    [ctx.tenantId]
  );
  const available = new Map<number, number>();
  for (const r of availRes.rows) available.set(Number(r.product_id), Number(r.qty));

  // --- Active reservations per product ---
  const resvRes = await client.query(
    `SELECT product_id, SUM(quantity)::numeric AS qty
     FROM inventory_reservations WHERE tenant_id = $1 AND status = 'ACTIVE' GROUP BY product_id`,
    [ctx.tenantId]
  );
  const reserved = new Map<number, number>();
  for (const r of resvRes.rows) reserved.set(Number(r.product_id), Number(r.qty));

  // --- Scheduled receipts from approved purchase orders ---
  const schedRes = await client.query(
    `SELECT poi.product_id, SUM(poi.quantity - poi.received_qty)::numeric AS qty
     FROM purchase_order_items poi
     JOIN purchase_orders po ON po.id = poi.order_id
     WHERE po.tenant_id = $1 AND po.status IN ('APPROVED','PARTIALLY_RECEIVED')
     GROUP BY poi.product_id`,
    [ctx.tenantId]
  );
  const scheduled = new Map<number, number>();
  for (const r of schedRes.rows) scheduled.set(Number(r.product_id), Number(r.qty));

  // --- Product metadata (type, safety stock, lot size) ---
  const prodRes = await client.query(
    `SELECT id, type, safety_stock, lot_size, name, code FROM products
     WHERE tenant_id = $1 AND id = ANY($2::bigint[])`,
    [ctx.tenantId, productIds]
  );
  const products = new Map<number, { type: string; safety_stock: number; lot_size: number | null; name: string; code: string }>();
  for (const r of prodRes.rows) {
    products.set(Number(r.id), {
      type: String(r.type),
      safety_stock: Number(r.safety_stock ?? 0),
      lot_size: r.lot_size ? Number(r.lot_size) : null,
      name: String(r.name),
      code: String(r.code),
    });
  }

  const suggestions: { productId: number; code: string; name: string; type: string; gross: number; available: number; reserved: number; scheduled: number; safetyStock: number; net: number; suggestionType: string; suggestedQty: number }[] = [];
  let totalPurchase = 0;
  let totalProduction = 0;

  for (const productId of productIds) {
    const meta = products.get(productId);
    if (!meta) continue;
    const grossQty = round4(gross.get(productId) ?? 0);
    const availQty = round4(available.get(productId) ?? 0);
    const resvQty = round4(reserved.get(productId) ?? 0);
    const schedQty = round4(scheduled.get(productId) ?? 0);
    const safetyQty = round4(meta.safety_stock);
    const netQty = round4(grossQty - availQty - schedQty + safetyQty);

    const reqTypes: { type: string; qty: number; suggestionType?: string; suggestedQty?: number; notes?: string }[] = [
      { type: 'GROSS', qty: grossQty },
      { type: 'AVAILABLE', qty: availQty },
      { type: 'RESERVED', qty: resvQty },
      { type: 'SCHEDULED_RECEIPT', qty: schedQty },
      { type: 'SAFETY_STOCK', qty: safetyQty },
      { type: 'NET', qty: netQty },
    ];

    let suggestionType = 'NONE';
    let suggestedQty = 0;
    if (netQty > 0) {
      const isFinished = meta.type === 'REAM' || meta.type === 'FINISHED_GOODS';
      suggestionType = isFinished ? 'PRODUCTION' : 'PURCHASE';
      suggestedQty = netQty;
      if (meta.lot_size && meta.lot_size > 0) {
        suggestedQty = Math.ceil(netQty / meta.lot_size) * meta.lot_size;
      }
      suggestedQty = round4(suggestedQty);
      reqTypes.push({ type: 'SUGGESTION', qty: suggestedQty, suggestionType, suggestedQty, notes: `Suggested ${suggestionType.toLowerCase()} for ${meta.name}` });
      if (suggestionType === 'PURCHASE') totalPurchase += suggestedQty;
      else totalProduction += suggestedQty;
      suggestions.push({ productId, code: meta.code, name: meta.name, type: meta.type, gross: grossQty, available: availQty, reserved: resvQty, scheduled: schedQty, safetyStock: safetyQty, net: netQty, suggestionType, suggestedQty });
    } else {
      reqTypes.push({ type: 'SUGGESTION', qty: 0, suggestionType: 'NONE', suggestedQty: 0, notes: 'No shortage' });
    }

    for (const rt of reqTypes) {
      await client.query(
        `INSERT INTO mrp_requirements
           (run_id, product_id, requirement_type, quantity, period_date, suggestion_type, suggested_quantity, suggested_date, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          runId,
          productId,
          rt.type,
          rt.qty,
          horizonStart,
          rt.suggestionType ?? null,
          rt.suggestedQty ?? null,
          rt.suggestedQty ? horizonStart : null,
          rt.notes ?? null,
        ]
      );
    }
  }

  await client.query(
    `UPDATE mrp_runs SET status = 'COMPLETED', summary = $1, completed_at = now() WHERE id = $2`,
    [
      JSON.stringify({ products: suggestions.length, total_purchase: totalPurchase, total_production: totalProduction, run_no: runNo }),
      runId,
    ]
  );
  await emitEvent(client, ctx, {
    eventType: 'mrp.completed',
    entityType: 'mrp_runs',
    entityId: runId,
    entityCode: runNo,
    payload: { products: suggestions.length, totalPurchase, totalProduction },
  });
  await logAudit(client, ctx, {
    action: 'run',
    resource: 'mrp_runs',
    recordId: runId,
    recordCode: runNo,
    newValues: { products: suggestions.length, totalPurchase, totalProduction },
  });
  return { runId, runNo, products: suggestions };
}

/** Summarize the latest MRP run per product for planners. */
export async function getMrpSummary(client: pg.PoolClient, ctx: Ctx, runId?: number) {
  const runRes = await client.query(
    `SELECT * FROM mrp_runs WHERE tenant_id = $1 ${runId ? 'AND id = $2' : 'ORDER BY id DESC LIMIT 1'}`,
    runId ? [ctx.tenantId, runId] : [ctx.tenantId]
  );
  if (runRes.rows.length === 0) throw badRequest('No MRP run found');
  const run = runRes.rows[0];
  const req = await client.query(
    `SELECT mr.*, p.code AS product_code, p.name AS product_name
     FROM mrp_requirements mr
     JOIN products p ON p.id = mr.product_id
     WHERE mr.run_id = $1
     ORDER BY mr.product_id, mr.requirement_type`,
    [run.id]
  );
  return { run, requirements: req.rows };
}
