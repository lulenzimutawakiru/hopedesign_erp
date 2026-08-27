import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { startWorkflow } from './workflow.js';
import { consume, postMove, reserve } from './inventory.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import * as finance from './finance.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface SalesLineInput {
  productId: number;
  description?: string | null;
  quantity: number;
  unitId?: number | null;
  unitPrice: number;
  discountPercent?: number;
  taxPercent?: number;
  deliveryDate?: string | null;
}

export interface InvoiceLineInput {
  productId?: number | null;
  description?: string | null;
  quantity: number;
  unitPrice: number;
  taxPercent?: number;
}

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

/** Company bank defaults from app_settings (general category), company-scoped with tenant fallback. */
async function companyBankDefaults(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT key, value FROM app_settings
     WHERE tenant_id = $1 AND category = 'general'
       AND key IN ('bank_name','bank_account_name','bank_account_number')
       AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
     ORDER BY (company_id IS NOT NULL) DESC`,
    [ctx.tenantId, ctx.companyId ?? null]
  );
  const stored: Record<string, string> = {};
  for (const row of res.rows) {
    if (!(row.key in stored)) stored[row.key] = row.value == null ? '' : String(row.value);
  }
  return {
    bankName: stored['bank_name'] ?? '',
    bankAccountName: stored['bank_account_name'] ?? '',
    bankAccountNumber: stored['bank_account_number'] ?? '',
  };
}

function validateDiscount(discountType: string, discountValue: number) {
  if (!['AMOUNT', 'PERCENT'].includes(discountType)) {
    throw badRequest('discountType must be AMOUNT or PERCENT');
  }
  if (!Number.isFinite(discountValue) || discountValue < 0) {
    throw badRequest('discountValue must be a non-negative number');
  }
  if (discountType === 'PERCENT' && discountValue > 100) {
    throw badRequest('Percentage discount cannot exceed 100%');
  }
}

async function productMeta(client: pg.PoolClient, ctx: Ctx, productId: number) {
  const res = await client.query(
    `SELECT id, name, type, standard_price, unit_id FROM products WHERE id = $1 AND tenant_id = $2`,
    [productId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest(`Product ${productId} not found`);
  return res.rows[0];
}

/** Default warehouse by product type (finished goods vs raw vs security). */
export async function warehouseByType(client: pg.PoolClient, ctx: Ctx, productType: string): Promise<number> {
  const code = productType === 'SECURITY_ITEM' ? 'SEC-WH' : ['JUMBO_ROLL', 'PAPER_BOBBIN', 'PACKAGING', 'CONSUMABLE', 'SPARE_PART'].includes(productType) ? 'RAW-MAT' : 'FG-WH';
  const res = await client.query(`SELECT id FROM warehouses WHERE company_id = $1 AND code = $2`, [ctx.companyId, code]);
  if (res.rows.length === 0) throw badRequest(`Warehouse ${code} not found`);
  return Number(res.rows[0].id);
}

async function defaultBin(client: pg.PoolClient, _ctx: Ctx, warehouseId: number): Promise<number | null> {
  const res = await client.query(
    `SELECT id FROM warehouse_bins WHERE warehouse_id = $1 ORDER BY code LIMIT 1`,
    [warehouseId]
  );
  return res.rows.length ? Number(res.rows[0].id) : null;
}

async function assertCustomerCanTrade(
  client: pg.PoolClient,
  ctx: Ctx,
  customerId: number,
  extraAmount = 0
) {
  const res = await client.query(
    `SELECT c.id, c.status, c.credit_limit,
            COALESCE((
              SELECT sum(i.total - i.amount_paid) FROM customer_invoices i
              WHERE i.customer_id = c.id AND i.status NOT IN ('VOID','PAID')
            ), 0)::numeric AS open_ar
     FROM customers c WHERE c.id = $1 AND c.tenant_id = $2`,
    [customerId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Customer not found');
  const row = res.rows[0];
  if (['BLOCKED', 'INACTIVE'].includes(String(row.status))) {
    throw badRequest(`Customer is ${row.status}`);
  }
  const limit = Number(row.credit_limit) || 0;
  const exposure = Number(row.open_ar) + Number(extraAmount || 0);
  if (limit > 0 && exposure > limit) {
    throw badRequest('Credit limit exceeded');
  }
}

/** Create a sales quotation (DRAFT). */
export async function createQuotation(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    customerId: number;
    contactId?: number | null;
    opportunityId?: number | null;
    quotationDate?: string;
    validUntil?: string | null;
    currency?: string;
    notes?: string | null;
    terms?: string | null;
    items: SalesLineInput[];
  }
) {
  const companyId = ctx.companyId;
  if (!companyId) throw badRequest('Company context required');
  if (!input.items?.length) throw badRequest('At least one line item is required');
  const quoted = input.items.reduce((s, it) => s + Number(it.quantity) * Number(it.unitPrice), 0);
  await assertCustomerCanTrade(client, ctx, input.customerId, quoted);
  const quotationNo = await nextDoc(client, ctx, 'QT');
  const ins = await client.query(
    `INSERT INTO sales_quotations
       (company_id, tenant_id, branch_id, quotation_no, customer_id, contact_id, opportunity_id,
        quotation_date, valid_until, currency, notes, terms, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      companyId, ctx.tenantId, ctx.branchId ?? null, quotationNo, input.customerId,
      input.contactId ?? null, input.opportunityId ?? null,
      input.quotationDate ?? new Date().toISOString().slice(0, 10),
      input.validUntil ?? null, input.currency ?? 'UGX', input.notes ?? null, input.terms ?? null,
      ctx.userId ?? null,
    ]
  );
  const quotationId = Number(ins.rows[0].id);
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  for (const item of input.items) {
    const product = await productMeta(client, ctx, item.productId);
    const qty = Number(item.quantity);
    if (qty <= 0) throw badRequest('Quantity must be positive');
    const unitPrice = Number(item.unitPrice);
    const discountPercent = Number(item.discountPercent ?? 0);
    const taxPercent = Number(item.taxPercent ?? 0);
    const lineTotal = qty * unitPrice;
    const discountAmt = lineTotal * (discountPercent / 100);
    const taxAmt = (lineTotal - discountAmt) * (taxPercent / 100);
    await client.query(
      `INSERT INTO sales_quotation_items
         (quotation_id, product_id, description, quantity, unit_id, unit_price, discount_percent, tax_percent, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        quotationId, item.productId, item.description ?? product.name, qty, item.unitId ?? product.unit_id ?? null,
        unitPrice, discountPercent, taxPercent, round2(lineTotal - discountAmt + taxAmt),
      ]
    );
    subtotal += lineTotal;
    discount += discountAmt;
    tax += taxAmt;
  }
  const total = round2(subtotal - discount + tax);
  await client.query(
    `UPDATE sales_quotations SET subtotal = $1, discount_amount = $2, tax_amount = $3, total = $4 WHERE id = $5`,
    [round2(subtotal), round2(discount), round2(tax), total, quotationId]
  );
  await emitEvent(client, ctx, { eventType: 'sales.quotation_created', entityType: 'sales_quotations', entityId: quotationId, entityCode: quotationNo });
  await logAudit(client, ctx, { action: 'create', resource: 'sales_quotations', recordId: quotationId, recordCode: quotationNo, newValues: { customerId: input.customerId, total } });
  return { quotationId, quotationNo, total };
}

/** Submit a quotation for approval (auto-approves when no workflow configured). */
export async function submitQuotation(client: pg.PoolClient, ctx: Ctx, quotationId: number) {
  const res = await client.query(
    `SELECT * FROM sales_quotations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [quotationId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Quotation not found');
  const q = res.rows[0];
  if (q.status !== 'DRAFT') throw badRequest(`Quotation is ${q.status}, only DRAFT can be submitted`);
  await client.query(`UPDATE sales_quotations SET status = 'SUBMITTED' WHERE id = $1`, [quotationId]);
  await startWorkflow(client, ctx, { entityType: 'sales.quotations', entityId: quotationId, entityCode: String(q.quotation_no), amount: Number(q.total) });
  await logAudit(client, ctx, { action: 'submit', resource: 'sales_quotations', recordId: quotationId, recordCode: String(q.quotation_no) });
  return { quotationId, quotationNo: String(q.quotation_no) };
}

/** Create a sales order (DRAFT). When quotationId is given, copies the approved quotation lines. */
export async function createSalesOrder(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    quotationId?: number | null;
    customerId: number;
    contactId?: number | null;
    customerPoNo?: string | null;
    orderDate?: string;
    requestedDate?: string | null;
    deliveryDate?: string | null;
    currency?: string;
    notes?: string | null;
    items?: SalesLineInput[];
    bankName?: string | null;
    bankAccountName?: string | null;
    bankAccountNumber?: string | null;
    discountType?: 'AMOUNT' | 'PERCENT' | null;
    discountValue?: number | null;
  }
) {
  const companyId = ctx.companyId;
  if (!companyId) throw badRequest('Company context required');
  await assertCustomerCanTrade(client, ctx, input.customerId, 0);
  const orderNo = await nextDoc(client, ctx, 'SO');
  const bank = await companyBankDefaults(client, ctx);
  const bankName = input.bankName != null ? String(input.bankName) : bank.bankName;
  const bankAccountName = input.bankAccountName != null ? String(input.bankAccountName) : bank.bankAccountName;
  const bankAccountNumber = input.bankAccountNumber != null ? String(input.bankAccountNumber) : bank.bankAccountNumber;
  const discountType = input.discountType != null ? input.discountType : 'PERCENT';
  const discountValue = Number(input.discountValue ?? 0);
  validateDiscount(discountType, discountValue);
  const ins = await client.query(
    `INSERT INTO sales_orders
       (company_id, tenant_id, branch_id, order_no, quotation_id, customer_id, contact_id, customer_po_no,
        order_date, requested_date, delivery_date, currency, notes,
        bank_name, bank_account_name, bank_account_number, discount_type, discount_value, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [
      companyId, ctx.tenantId, ctx.branchId ?? null, orderNo, input.quotationId ?? null, input.customerId,
      input.contactId ?? null, input.customerPoNo ?? null,
      input.orderDate ?? new Date().toISOString().slice(0, 10),
      input.requestedDate ?? null, input.deliveryDate ?? null, input.currency ?? 'UGX', input.notes ?? null,
      bankName || null, bankAccountName || null, bankAccountNumber || null,
      discountType, discountValue, ctx.userId ?? null,
    ]
  );
  const orderId = Number(ins.rows[0].id);
  let lines = input.items ?? [];
  if (lines.length === 0 && input.quotationId) {
    const qItems = await client.query(
      `SELECT product_id, description, quantity, unit_id, unit_price, discount_percent, tax_percent
       FROM sales_quotation_items WHERE quotation_id = $1 ORDER BY id`,
      [input.quotationId]
    );
    lines = qItems.rows.map((row) => ({
      productId: Number(row.product_id),
      description: row.description != null ? String(row.description) : null,
      quantity: Number(row.quantity),
      unitId: row.unit_id != null ? Number(row.unit_id) : null,
      unitPrice: Number(row.unit_price),
      discountPercent: Number(row.discount_percent ?? 0),
      taxPercent: Number(row.tax_percent ?? 0),
    }));
  }
  if (lines.length === 0) throw badRequest('At least one line item is required');
  let subtotal = 0;
  let discount = 0;
  const lineSpecs: Array<{
    productId: number;
    description: string;
    qty: number;
    unitId: number | null;
    unitPrice: number;
    discountPercent: number;
    taxPercent: number;
    lineTotal: number;
    discountAmt: number;
    deliveryDate: string | null;
  }> = [];
  for (const item of lines) {
    const product = await productMeta(client, ctx, item.productId);
    const qty = Number(item.quantity);
    if (qty <= 0) throw badRequest('Quantity must be positive');
    const unitPrice = Number(item.unitPrice);
    const discountPercent = Number(item.discountPercent ?? 0);
    const taxPercent = Number(item.taxPercent ?? 0);
    const lineTotal = qty * unitPrice;
    const discountAmt = lineTotal * (discountPercent / 100);
    lineSpecs.push({
      productId: item.productId,
      description: item.description ?? product.name,
      qty,
      unitId: item.unitId ?? product.unit_id ?? null,
      unitPrice,
      discountPercent,
      taxPercent,
      lineTotal,
      discountAmt,
      deliveryDate: item.deliveryDate ?? null,
    });
    subtotal += lineTotal;
    discount += discountAmt;
  }
  const orderDiscount = discountType === 'AMOUNT'
    ? Math.min(discountValue, subtotal)
    : (subtotal * discountValue) / 100;
  const totalDiscount = round2(discount + orderDiscount);
  let tax = 0;
  for (const spec of lineSpecs) {
    const headerShare = subtotal > 0 ? orderDiscount * (spec.lineTotal / subtotal) : 0;
    const taxAmt = Math.max(0, spec.lineTotal - spec.discountAmt - headerShare) * (spec.taxPercent / 100);
    await client.query(
      `INSERT INTO sales_order_items
         (order_id, product_id, description, quantity, unit_id, unit_price, discount_percent, tax_percent, line_total, delivery_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        orderId, spec.productId, spec.description, spec.qty, spec.unitId,
        spec.unitPrice, spec.discountPercent, spec.taxPercent, round2(spec.lineTotal - spec.discountAmt + taxAmt),
        spec.deliveryDate,
      ]
    );
    tax += taxAmt;
  }
  const total = round2(subtotal - totalDiscount + tax);
  await client.query(
    `UPDATE sales_orders SET subtotal = $1, discount_amount = $2, tax_amount = $3, total = $4 WHERE id = $5`,
    [round2(subtotal), totalDiscount, round2(tax), total, orderId]
  );
  await emitEvent(client, ctx, { eventType: 'sales.order_created', entityType: 'sales_orders', entityId: orderId, entityCode: orderNo });
  await logAudit(client, ctx, { action: 'create', resource: 'sales_orders', recordId: orderId, recordCode: orderNo, newValues: { customerId: input.customerId, total } });
  return { orderId, orderNo, total };
}

/** Convert an APPROVED quotation into a DRAFT sales order and mark the quote CONVERTED. */
export async function convertQuotation(client: pg.PoolClient, ctx: Ctx, quotationId: number) {
  const res = await client.query(
    `SELECT * FROM sales_quotations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [quotationId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Quotation not found');
  const q = res.rows[0];
  if (q.status !== 'APPROVED') throw badRequest(`Quotation is ${q.status}, only APPROVED quotations can be converted`);
  const order = await createSalesOrder(client, ctx, {
    quotationId,
    customerId: Number(q.customer_id),
    contactId: q.contact_id != null ? Number(q.contact_id) : null,
    currency: q.currency != null ? String(q.currency) : 'UGX',
    notes: q.notes != null ? String(q.notes) : null,
    items: [],
  });
  await client.query(`UPDATE sales_quotations SET status = 'CONVERTED' WHERE id = $1`, [quotationId]);
  await emitEvent(client, ctx, {
    eventType: 'sales.quotation_converted',
    entityType: 'sales_quotations',
    entityId: quotationId,
    entityCode: String(q.quotation_no),
    payload: { orderId: order.orderId, orderNo: order.orderNo },
  });
  await logAudit(client, ctx, {
    action: 'convert',
    resource: 'sales_quotations',
    recordId: quotationId,
    recordCode: String(q.quotation_no),
    newValues: { orderId: order.orderId, status: 'CONVERTED' },
  });
  return { ...order, quotationId, quotationNo: String(q.quotation_no) };
}

/** Submit a sales order ? SUBMITTED + workflow (WF-SO). */
export async function submitSalesOrder(client: pg.PoolClient, ctx: Ctx, orderId: number) {
  const res = await client.query(
    `SELECT * FROM sales_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [orderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Sales order not found');
  const so = res.rows[0];
  if (so.status !== 'DRAFT') throw badRequest(`Sales order is ${so.status}, only DRAFT can be submitted`);
  await client.query(`UPDATE sales_orders SET status = 'SUBMITTED' WHERE id = $1`, [orderId]);
  await startWorkflow(client, ctx, { entityType: 'sales.orders', entityId: orderId, entityCode: String(so.order_no), amount: Number(so.total) });
  await logAudit(client, ctx, { action: 'submit', resource: 'sales_orders', recordId: orderId, recordCode: String(so.order_no) });
  return { orderId, orderNo: String(so.order_no) };
}

/** Allocate available finished-goods stock to an APPROVED order (reservations). */
export async function allocateOrder(client: pg.PoolClient, ctx: Ctx, orderId: number) {
  const res = await client.query(
    `SELECT * FROM sales_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [orderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Sales order not found');
  const so = res.rows[0];
  if (!['APPROVED', 'ALLOCATED'].includes(so.status)) throw badRequest(`Sales order must be APPROVED before allocation (current: ${so.status})`);
  const items = await client.query(`SELECT * FROM sales_order_items WHERE order_id = $1`, [orderId]);
  const reservations: number[] = [];
  for (const item of items.rows) {
    const product = await productMeta(client, ctx, Number(item.product_id));
    const warehouseId = await warehouseByType(client, ctx, String(product.type));
    const avail = await client.query(
      `SELECT COALESCE(sum(quantity - reserved_qty),0)::numeric AS qty FROM inventory
       WHERE product_id = $1 AND warehouse_id = $2`,
      [item.product_id, warehouseId]
    );
    const available = Number(avail.rows[0].qty);
    const remaining = Number(item.quantity) - Number(item.allocated_qty);
    if (remaining <= 0) continue;
    const allocate = Math.min(remaining, available);
    if (allocate <= 0) continue;
    const batchRes = await client.query(
      `SELECT batch_id FROM inventory
       WHERE product_id = $1 AND warehouse_id = $2 AND quantity - reserved_qty > 0
       ORDER BY id LIMIT 1`,
      [item.product_id, warehouseId]
    );
    const reservationId = await reserve(client, ctx, {
      product: Number(item.product_id),
      batch: batchRes.rows[0]?.batch_id != null ? Number(batchRes.rows[0].batch_id) : null,
      warehouse: warehouseId,
      qty: allocate,
      refType: 'sales_order_items',
      refId: Number(item.id),
    });
    reservations.push(reservationId);
    await client.query(`UPDATE sales_order_items SET allocated_qty = allocated_qty + $1 WHERE id = $2`, [allocate, item.id]);
  }
  await client.query(`UPDATE sales_orders SET status = 'ALLOCATED', allocated = true WHERE id = $1`, [orderId]);
  await emitEvent(client, ctx, { eventType: 'sales.order_allocated', entityType: 'sales_orders', entityId: orderId, entityCode: String(so.order_no), payload: { reservations } });
  await logAudit(client, ctx, { action: 'allocate', resource: 'sales_orders', recordId: orderId, recordCode: String(so.order_no), newValues: { reservations } });
  return { orderId, orderNo: String(so.order_no), reservations };
}

/** Create a delivery note (READY) and dispatch it, moving stock out of the warehouse. */
export async function dispatchOrder(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    orderId: number;
    items: { orderItemId: number; quantity: number; batchId?: number | null; qrId?: number | null }[];
    vehicleId?: number | null;
    driverId?: number | null;
    recipientName?: string | null;
    recipientPhone?: string | null;
    dispatchDate?: string;
    notes?: string | null;
  }
) {
  const res = await client.query(
    `SELECT * FROM sales_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [input.orderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Sales order not found');
  const so = res.rows[0];
  if (!['APPROVED', 'ALLOCATED', 'PARTIALLY_DISPATCHED', 'DISPATCHED'].includes(so.status)) {
    throw badRequest(`Sales order cannot be dispatched (current: ${so.status})`);
  }
  let lines = input.items ?? [];
  if (lines.length === 0) {
    const remaining = await client.query(
      `SELECT id, quantity, dispatched_qty FROM sales_order_items WHERE order_id = $1 AND quantity > dispatched_qty`,
      [input.orderId]
    );
    lines = remaining.rows.map((row) => ({
      orderItemId: Number(row.id),
      quantity: Number(row.quantity) - Number(row.dispatched_qty),
    }));
  }
  if (lines.length === 0) throw badRequest('Nothing left to dispatch');
  input = { ...input, items: lines };
  const deliveryNo = await nextDoc(client, ctx, 'DN');
  const dnRes = await client.query(
    `INSERT INTO delivery_notes
       (company_id, tenant_id, branch_id, delivery_no, order_id, status, dispatch_date, vehicle_id, driver_id,
        recipient_name, recipient_phone, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,'READY',$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, ctx.branchId ?? null, deliveryNo, input.orderId,
      input.dispatchDate ?? new Date().toISOString().slice(0, 10),
      input.vehicleId ?? null, input.driverId ?? null, input.recipientName ?? null,
      input.recipientPhone ?? null, input.notes ?? null, ctx.userId ?? null,
    ]
  );
  const deliveryNoteId = Number(dnRes.rows[0].id);
  for (const item of input.items) {
    const soItem = await client.query(
      `SELECT * FROM sales_order_items WHERE id = $1 AND order_id = $2`,
      [item.orderItemId, input.orderId]
    );
    if (soItem.rows.length === 0) throw badRequest(`Order item ${item.orderItemId} not found on this order`);
    const si = soItem.rows[0];
    const qty = Number(item.quantity);
    if (qty <= 0) throw badRequest('Dispatch quantity must be positive');
    const remaining = Number(si.quantity) - Number(si.dispatched_qty);
    if (qty > remaining) throw badRequest(`Cannot dispatch ${qty} of item, only ${remaining} remaining`);
    const product = await productMeta(client, ctx, Number(si.product_id));
    const warehouseId = await warehouseByType(client, ctx, String(product.type));
    await client.query(
      `INSERT INTO delivery_note_items (delivery_note_id, order_item_id, product_id, quantity, batch_id, qr_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [deliveryNoteId, item.orderItemId, si.product_id, qty, item.batchId ?? null, item.qrId ?? null]
    );
    // Move stock out (DISPTACH is a negative movement type).
    await postMove(client, ctx, {
      movementType: 'DISPTACH',
      product: Number(si.product_id),
      batch: item.batchId ?? null,
      warehouse: warehouseId,
      quantity: qty,
      refType: 'delivery_notes',
      refId: deliveryNoteId,
      refCode: deliveryNo,
      reason: `Dispatch on sales order ${so.order_no}`,
    });
    // Release reservations tied to the SO line (the dispatch consumes the stock).
    const reservations = await client.query(
      `SELECT id FROM inventory_reservations
       WHERE reference_type = 'sales_order_items' AND reference_id = $1 AND status = 'ACTIVE'`,
      [item.orderItemId]
    );
    for (const r of reservations.rows) await consume(client, Number(r.id));
    await client.query(`UPDATE sales_order_items SET dispatched_qty = dispatched_qty + $1 WHERE id = $2`, [qty, item.orderItemId]);
  }
  await client.query(
    `UPDATE delivery_notes SET status = 'DISPATCHED' WHERE id = $1`,
    [deliveryNoteId]
  );
  const totals = await client.query(
    `SELECT sum(quantity)::numeric AS qty, sum(dispatched_qty)::numeric AS dispatched
     FROM sales_order_items WHERE order_id = $1`,
    [input.orderId]
  );
  const allDispatched = Number(totals.rows[0].dispatched) >= Number(totals.rows[0].qty);
  await client.query(
    `UPDATE sales_orders SET status = $1 WHERE id = $2`,
    [allDispatched ? 'DISPATCHED' : 'PARTIALLY_DISPATCHED', input.orderId]
  );
  await emitEvent(client, ctx, { eventType: 'sales.delivery_dispatched', entityType: 'delivery_notes', entityId: deliveryNoteId, entityCode: deliveryNo, payload: { orderId: input.orderId } });
  await logAudit(client, ctx, { action: 'dispatch', resource: 'delivery_notes', recordId: deliveryNoteId, recordCode: deliveryNo, newValues: { orderId: input.orderId } });
  return { deliveryNoteId, deliveryNo };
}

/** Mark a delivery note as delivered. */
export async function deliverDeliveryNote(
  client: pg.PoolClient,
  ctx: Ctx,
  deliveryNoteId: number,
  input: { receivedBy?: string | null; signature?: string | null; recipientName?: string | null; recipientPhone?: string | null; deliveredAt?: string }
) {
  const res = await client.query(
    `SELECT * FROM delivery_notes WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [deliveryNoteId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Delivery note not found');
  const dn = res.rows[0];
  if (!['DISPATCHED', 'IN_TRANSIT'].includes(dn.status)) throw badRequest(`Delivery note is ${dn.status}, cannot mark delivered`);
  await client.query(
    `UPDATE delivery_notes SET status = 'DELIVERED', delivered_at = $1, received_by = $2, signature = $3,
       recipient_name = COALESCE($4, recipient_name), recipient_phone = COALESCE($5, recipient_phone)
     WHERE id = $6`,
    [
      input.deliveredAt ?? new Date().toISOString(),
      input.receivedBy ?? null, input.signature ?? null, input.recipientName ?? null, input.recipientPhone ?? null,
      deliveryNoteId,
    ]
  );
  await emitEvent(client, ctx, { eventType: 'sales.delivery_delivered', entityType: 'delivery_notes', entityId: deliveryNoteId, entityCode: String(dn.delivery_no), payload: { receivedBy: input.receivedBy } });
  await logAudit(client, ctx, { action: 'deliver', resource: 'delivery_notes', recordId: deliveryNoteId, recordCode: String(dn.delivery_no), newValues: input });
  return { deliveryNoteId, deliveryNo: String(dn.delivery_no) };
}

/** Create a customer invoice.
 *  With orderId: invoices the dispatched-but-uninvoiced quantities of a sales order
 *  (bank/discount inherit from the order). Without orderId: creates a standalone manual
 *  invoice from provided line items (bank defaults from company settings). */
export async function createInvoice(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    orderId?: number | null;
    deliveryNoteId?: number | null;
    customerId?: number | null;
    invoiceDate?: string;
    dueDate?: string | null;
    currency?: string;
    notes?: string | null;
    items?: InvoiceLineInput[];
    bankName?: string | null;
    bankAccountName?: string | null;
    bankAccountNumber?: string | null;
    discountType?: 'AMOUNT' | 'PERCENT' | null;
    discountValue?: number | null;
  }
) {
  const companyId = ctx.companyId;
  if (!companyId) throw badRequest('Company context required');
  const bank = await companyBankDefaults(client, ctx);
  const orderId = input.orderId != null ? Number(input.orderId) : null;

  let customerId: number;
  let currency: string;
  let discountType: 'AMOUNT' | 'PERCENT';
  let discountValue: number;
  let bankName: string;
  let bankAccountName: string;
  let bankAccountNumber: string;
  let orderLines: Array<Record<string, unknown>> | null = null;
  let orderSubtotal = 0;
  let orderDiscountAmount = 0;

  if (orderId != null) {
    const res = await client.query(
      `SELECT * FROM sales_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [orderId, ctx.tenantId]
    );
    if (res.rows.length === 0) throw notFound('Sales order not found');
    const so = res.rows[0];
    if (!['DISPATCHED', 'PARTIALLY_DISPATCHED', 'INVOICED'].includes(so.status)) {
      throw badRequest(`Invoice requires dispatched goods (current: ${so.status})`);
    }
    const items = await client.query(`SELECT * FROM sales_order_items WHERE order_id = $1`, [orderId]);
    orderLines = items.rows.filter((i) => Number(i.dispatched_qty) - Number(i.invoiced_qty) > 0);
    if (orderLines.length === 0) throw badRequest('Nothing to invoice (all dispatched quantities already invoiced)');
    customerId = Number(so.customer_id);
    currency = String(so.currency ?? 'UGX');
    bankName = input.bankName != null ? String(input.bankName) : so.bank_name != null ? String(so.bank_name) : bank.bankName;
    bankAccountName = input.bankAccountName != null ? String(input.bankAccountName) : so.bank_account_name != null ? String(so.bank_account_name) : bank.bankAccountName;
    bankAccountNumber = input.bankAccountNumber != null ? String(input.bankAccountNumber) : so.bank_account_number != null ? String(so.bank_account_number) : bank.bankAccountNumber;
    discountType = so.discount_type === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';
    discountValue = Number(so.discount_value ?? 0);
    orderSubtotal = Number(so.subtotal ?? 0);
    orderDiscountAmount = Number(so.discount_amount ?? 0);
  } else {
    customerId = input.customerId != null ? Number(input.customerId) : 0;
    if (!customerId) throw badRequest('customerId is required when creating a manual invoice');
    const lines = input.items ?? [];
    if (lines.length === 0) throw badRequest('At least one line item is required');
    const quoted = lines.reduce((s, it) => s + Number(it.quantity) * Number(it.unitPrice), 0);
    await assertCustomerCanTrade(client, ctx, customerId, quoted);
    currency = input.currency ?? 'UGX';
    bankName = input.bankName != null ? String(input.bankName) : bank.bankName;
    bankAccountName = input.bankAccountName != null ? String(input.bankAccountName) : bank.bankAccountName;
    bankAccountNumber = input.bankAccountNumber != null ? String(input.bankAccountNumber) : bank.bankAccountNumber;
    discountType = input.discountType != null ? input.discountType : 'PERCENT';
    discountValue = Number(input.discountValue ?? 0);
    validateDiscount(discountType, discountValue);
  }

  const invoiceNo = await nextDoc(client, ctx, 'INV');
  const ins = await client.query(
    `INSERT INTO customer_invoices
       (company_id, tenant_id, branch_id, invoice_no, order_id, delivery_note_id, customer_id, invoice_date, due_date, currency, notes,
        bank_name, bank_account_name, bank_account_number, discount_type, discount_value, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [
      companyId, ctx.tenantId, ctx.branchId ?? null, invoiceNo, orderId,
      input.deliveryNoteId ?? null, customerId,
      input.invoiceDate ?? new Date().toISOString().slice(0, 10),
      input.dueDate ?? null, currency, input.notes ?? null,
      bankName || null, bankAccountName || null, bankAccountNumber || null,
      discountType, discountValue, ctx.userId ?? null,
    ]
  );
  const invoiceId = Number(ins.rows[0].id);
  let subtotal = 0;
  const lineSpecs: Array<{
    productId: number | null;
    description: string;
    qty: number;
    unitPrice: number;
    taxPercent: number;
    lineTotal: number;
    orderItemId: number | null;
  }> = [];
  if (orderLines) {
    for (const item of orderLines) {
      const qty = Number(item.dispatched_qty) - Number(item.invoiced_qty);
      const unitPrice = Number(item.unit_price);
      const lineTotal = qty * unitPrice;
      lineSpecs.push({
        productId: Number(item.product_id),
        description: item.description != null ? String(item.description) : '',
        qty,
        unitPrice,
        taxPercent: Number(item.tax_percent ?? 0),
        lineTotal,
        orderItemId: Number(item.id),
      });
      subtotal += lineTotal;
    }
  } else {
    for (const item of input.items ?? []) {
      const qty = Number(item.quantity);
      if (qty <= 0) throw badRequest('Quantity must be positive');
      const unitPrice = Number(item.unitPrice);
      const taxPercent = Number(item.taxPercent ?? 0);
      let productId: number | null = null;
      let description = item.description != null ? String(item.description).trim() : '';
      if (item.productId != null) {
        const product = await productMeta(client, ctx, Number(item.productId));
        productId = Number(product.id);
        if (!description) description = String(product.name);
      }
      if (!description) throw badRequest('Each line needs a product or description');
      const lineTotal = qty * unitPrice;
      lineSpecs.push({ productId, description, qty, unitPrice, taxPercent, lineTotal, orderItemId: null });
      subtotal += lineTotal;
    }
  }
  let invoiceDiscount = 0;
  if (discountValue > 0 && subtotal > 0) {
    if (discountType === 'PERCENT') {
      invoiceDiscount = round2((subtotal * discountValue) / 100);
    } else if (orderId != null && orderSubtotal > 0) {
      invoiceDiscount = round2((orderDiscountAmount * subtotal) / orderSubtotal);
    } else {
      invoiceDiscount = round2(Math.min(discountValue, subtotal));
    }
  }
  let tax = 0;
  for (const spec of lineSpecs) {
    const headerShare = subtotal > 0 ? invoiceDiscount * (spec.lineTotal / subtotal) : 0;
    const taxAmt = Math.max(0, spec.lineTotal - headerShare) * (spec.taxPercent / 100);
    await client.query(
      `INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price, tax_percent, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [invoiceId, spec.productId, spec.description, spec.qty, spec.unitPrice, spec.taxPercent, spec.lineTotal + taxAmt]
    );
    tax += taxAmt;
    if (spec.orderItemId != null) {
      await client.query(`UPDATE sales_order_items SET invoiced_qty = invoiced_qty + $1 WHERE id = $2`, [spec.qty, spec.orderItemId]);
    }
  }
  const total = round2(subtotal - invoiceDiscount + tax);
  await client.query(
    `UPDATE customer_invoices SET subtotal = $1, discount_amount = $2, tax_amount = $3, total = $4 WHERE id = $5`,
    [round2(subtotal), invoiceDiscount, round2(tax), total, invoiceId]
  );
  if (orderId != null) {
    const allInvoiced = await client.query(
      `SELECT bool_and(invoiced_qty >= quantity) AS done FROM sales_order_items WHERE order_id = $1`,
      [orderId]
    );
    if (allInvoiced.rows[0].done) {
      await client.query(`UPDATE sales_orders SET status = 'INVOICED' WHERE id = $1`, [orderId]);
    }
  }
  await client.query(`UPDATE customer_invoices SET status = 'SUBMITTED' WHERE id = $1`, [invoiceId]);
  await startWorkflow(client, ctx, { entityType: 'sales.invoices', entityId: invoiceId, entityCode: invoiceNo, amount: total });
  await emitEvent(client, ctx, { eventType: 'sales.invoice_created', entityType: 'customer_invoices', entityId: invoiceId, entityCode: invoiceNo, payload: { orderId: orderId ?? null, customerId, total } });
  await logAudit(client, ctx, { action: 'create', resource: 'customer_invoices', recordId: invoiceId, recordCode: invoiceNo, newValues: { orderId: orderId ?? null, customerId, total } });
  return { invoiceId, invoiceNo, total };
}

/** Record a customer payment (auto-posts to GL immediately). */
export async function createReceipt(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    invoiceId?: number | null;
    customerId: number;
    receiptDate?: string;
    amount?: number;
    method?: string;
    reference?: string | null;
    bankAccountId?: number | null;
    description?: string | null;
    allocations?: Array<{ invoiceId: number; amount: number }>;
  }
) {
  const customerId = Number(input.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) throw badRequest('Customer is required');
  const rawAllocs = Array.isArray(input.allocations) ? input.allocations : [];
  const allocations: Array<{ invoiceId: number; amount: number }> = [];
  for (const a of rawAllocs) {
    const invoiceId = Number(a.invoiceId);
    const part = round2(Number(a.amount));
    if (!Number.isInteger(invoiceId) || invoiceId <= 0 || part <= 0) continue;
    allocations.push({ invoiceId, amount: part });
  }
  if (allocations.length === 0 && input.invoiceId != null && Number(input.invoiceId) > 0) {
    const fallback = round2(Number(input.amount ?? 0));
    if (fallback <= 0) throw badRequest('Receipt amount must be positive');
    allocations.push({ invoiceId: Number(input.invoiceId), amount: fallback });
  }
  const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0));
  const amount = input.amount != null && Number(input.amount) > 0 ? round2(Number(input.amount)) : allocated;
  if (amount <= 0) throw badRequest('Receipt amount must be positive');
  if (allocated > amount + 0.005) throw badRequest('Allocated amount exceeds the receipt total');
  for (const a of allocations) {
    const inv = await client.query(
      `SELECT id, customer_id, status, total, amount_paid FROM customer_invoices
       WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [a.invoiceId, ctx.tenantId]
    );
    if (inv.rows.length === 0) throw notFound(`Invoice ${a.invoiceId} not found`);
    if (Number(inv.rows[0].customer_id) !== customerId) {
      throw badRequest(`Invoice ${inv.rows[0].id} does not belong to this customer`);
    }
    if (String(inv.rows[0].status) === 'VOID') throw badRequest(`Invoice ${a.invoiceId} is void`);
    const due = round2(Number(inv.rows[0].total) - Number(inv.rows[0].amount_paid));
    if (a.amount > due + 0.005) throw badRequest(`Allocation ${a.amount} exceeds balance due ${due} on invoice ${a.invoiceId}`);
  }
  const method = String(input.method ?? 'CASH');
  if (!['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CHEQUE', 'CARD', 'OTHER'].includes(method)) {
    throw badRequest('Unsupported payment method');
  }
  const receiptNo = await nextDoc(client, ctx, 'RCT');
  const primaryInvoice = allocations[0]?.invoiceId ?? (input.invoiceId != null ? Number(input.invoiceId) : null);
  const ins = await client.query(
    `INSERT INTO receipts
       (company_id, tenant_id, receipt_no, invoice_id, customer_id, receipt_date, amount, method, reference, bank_account_id, status, received_by, description, unallocated_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'POSTED',$11,$12,$13) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, receiptNo, primaryInvoice, customerId,
      input.receiptDate ?? new Date().toISOString().slice(0, 10),
      amount, method, input.reference ?? null, input.bankAccountId ?? null,
      ctx.userId ?? null, input.description ?? null, round2(amount - allocated),
    ]
  );
  const receiptId = Number(ins.rows[0].id);
  for (const a of allocations) {
    await client.query(
      `INSERT INTO receipt_allocations (receipt_id, invoice_id, amount) VALUES ($1,$2,$3)`,
      [receiptId, a.invoiceId, a.amount]
    );
  }
  const journalId = await finance.postReceipt(client, ctx, receiptId);
  await emitEvent(client, ctx, { eventType: 'sales.receipt_posted', entityType: 'receipts', entityId: receiptId, entityCode: receiptNo, payload: { journalId, amount } });
  await logAudit(client, ctx, { action: 'post', resource: 'receipts', recordId: receiptId, recordCode: receiptNo, newValues: { amount, journalId, allocations } });
  return { receiptId, receiptNo, journalId, unallocatedAmount: round2(amount - allocated) };
}

/** Create a credit note against an invoice (DRAFT + workflow; posts when approved). */
export async function createCreditNote(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { invoiceId?: number | null; customerId: number; creditDate?: string; amount: number; reason: string; reasonCode?: string | null }
) {
  const amount = round2(Number(input.amount));
  if (amount <= 0) throw badRequest('Credit note amount must be positive');
  if (!String(input.reason ?? '').trim()) throw badRequest('Reason is required');
  const creditNo = await nextDoc(client, ctx, 'CN');
  const ins = await client.query(
    `INSERT INTO credit_notes
       (company_id, tenant_id, credit_no, invoice_id, customer_id, credit_date, amount, reason, reason_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, creditNo, input.invoiceId ?? null, input.customerId,
      input.creditDate ?? new Date().toISOString().slice(0, 10), amount, String(input.reason).trim(),
      input.reasonCode ?? null,
    ]
  );
  const creditNoteId = Number(ins.rows[0].id);
  await startWorkflow(client, ctx, { entityType: 'sales.credit_notes', entityId: creditNoteId, entityCode: creditNo, amount });
  await emitEvent(client, ctx, { eventType: 'sales.credit_note_created', entityType: 'credit_notes', entityId: creditNoteId, entityCode: creditNo });
  await logAudit(client, ctx, { action: 'create', resource: 'credit_notes', recordId: creditNoteId, recordCode: creditNo, newValues: { amount } });
  return { creditNoteId, creditNo };
}

/** Create a debit note (DRAFT + workflow; posts when approved). Prefix DNM so it does not collide with delivery notes. */
export async function createDebitNote(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { invoiceId?: number | null; customerId: number; debitDate?: string; amount: number; reason: string; reasonCode?: string | null }
) {
  const amount = round2(Number(input.amount));
  if (amount <= 0) throw badRequest('Debit note amount must be positive');
  if (!String(input.reason ?? '').trim()) throw badRequest('Reason is required');
  const reasonCode = String(input.reasonCode ?? 'OTHER').toUpperCase();
  if (!['UNDERBILLING', 'ADDITIONAL_CHARGES', 'PRICE_CORRECTION', 'FREIGHT', 'TAX', 'OTHER'].includes(reasonCode)) {
    throw badRequest('Unsupported debit note reason');
  }
  const debitNo = await nextDoc(client, ctx, 'DNM');
  const ins = await client.query(
    `INSERT INTO debit_notes
       (company_id, tenant_id, debit_no, invoice_id, customer_id, debit_date, amount, reason, reason_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, debitNo, input.invoiceId ?? null, Number(input.customerId),
      input.debitDate ?? new Date().toISOString().slice(0, 10), amount, String(input.reason).trim(), reasonCode,
    ]
  );
  const debitNoteId = Number(ins.rows[0].id);
  await startWorkflow(client, ctx, { entityType: 'sales.debit_notes', entityId: debitNoteId, entityCode: debitNo, amount });
  await emitEvent(client, ctx, { eventType: 'sales.debit_note_created', entityType: 'debit_notes', entityId: debitNoteId, entityCode: debitNo });
  await logAudit(client, ctx, { action: 'create', resource: 'debit_notes', recordId: debitNoteId, recordCode: debitNo, newValues: { amount, reasonCode } });
  return { debitNoteId, debitNo };
}

/** Register a customer return; completeSalesReturn moves goods back into stock. */
export async function createSalesReturn(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { orderId?: number | null; deliveryNoteId?: number | null; customerId: number; reason: string; items: { productId: number; quantity: number; batchId?: number | null; qrId?: number | null; condition?: string }[] }
) {
  const returnNo = await nextDoc(client, ctx, 'RET');
  const ins = await client.query(
    `INSERT INTO sales_returns (company_id, tenant_id, branch_id, return_no, order_id, delivery_note_id, customer_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, ctx.branchId ?? null, returnNo, input.orderId ?? null,
      input.deliveryNoteId ?? null, input.customerId, input.reason,
    ]
  );
  const returnId = Number(ins.rows[0].id);
  for (const item of input.items) {
    await client.query(
      `INSERT INTO sales_return_items (return_id, product_id, quantity, batch_id, qr_id, condition)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [returnId, item.productId, item.quantity, item.batchId ?? null, item.qrId ?? null, item.condition ?? 'RESALEABLE']
    );
  }
  await emitEvent(client, ctx, { eventType: 'sales.return_created', entityType: 'sales_returns', entityId: returnId, entityCode: returnNo });
  return { returnId, returnNo };
}

/** Complete a return: move goods into RETURNS (resaleable) or DAMAGED/SCRAP warehouse. */
export async function completeSalesReturn(client: pg.PoolClient, ctx: Ctx, returnId: number, input: { qcResult?: string | null }) {
  const res = await client.query(
    `SELECT * FROM sales_returns WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [returnId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Sales return not found');
  const ret = res.rows[0];
  if (ret.status !== 'OPEN') throw badRequest(`Sales return is ${ret.status}`);
  const items = await client.query(`SELECT * FROM sales_return_items WHERE return_id = $1`, [returnId]);
  const toWarehouse = await client.query(
    `SELECT id FROM warehouses WHERE company_id = $1 AND code = 'RETURNS'`,
    [ctx.companyId]
  );
  const damagedWh = await client.query(
    `SELECT id FROM warehouses WHERE company_id = $1 AND code = 'DAMAGED'`,
    [ctx.companyId]
  );
  for (const item of items.rows) {
    const whId = item.condition === 'RESALEABLE' ? Number(toWarehouse.rows[0].id) : Number(damagedWh.rows[0].id);
    await postMove(client, ctx, {
      movementType: 'RETURN_IN',
      product: Number(item.product_id),
      batch: item.batch_id ? Number(item.batch_id) : null,
      warehouse: whId,
      quantity: Number(item.quantity),
      refType: 'sales_returns',
      refId: returnId,
      refCode: String(ret.return_no),
      reason: `Customer return ${ret.return_no}`,
    });
  }
  await client.query(
    `UPDATE sales_returns SET status = 'COMPLETED', qc_result = $1 WHERE id = $2`,
    [input.qcResult ?? null, returnId]
  );
  await emitEvent(client, ctx, { eventType: 'sales.return_completed', entityType: 'sales_returns', entityId: returnId, entityCode: String(ret.return_no) });
  await logAudit(client, ctx, { action: 'complete', resource: 'sales_returns', recordId: returnId, recordCode: String(ret.return_no) });
  return { returnId, returnNo: String(ret.return_no) };
}

function camelDoc(row: Record<string, unknown>) {
  return toCamelRow(row);
}

/** Header + lines + related documents for the sales workspace UI. */
export async function getQuotation(client: pg.PoolClient, ctx: Ctx, quotationId: number) {
  const res = await client.query(
    `SELECT q.*, c.name AS customer_name, c.code AS customer_code,
            c.address AS customer_address, c.billing_address AS customer_billing_address,
            c.shipping_address AS customer_shipping_address, c.phone AS customer_phone,
            c.email AS customer_email, c.tin AS customer_tin, c.vrn AS customer_vrn,
            c.payment_terms_days AS customer_payment_terms_days
     FROM sales_quotations q
     JOIN customers c ON c.id = q.customer_id
     WHERE q.id = $1 AND q.tenant_id = $2`,
    [quotationId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Quotation not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name
     FROM sales_quotation_items i
     LEFT JOIN products p ON p.id = i.product_id
     WHERE i.quotation_id = $1 ORDER BY i.id`,
    [quotationId]
  );
  const orders = await client.query(
    `SELECT id, order_no, status, total FROM sales_orders WHERE quotation_id = $1 ORDER BY id`,
    [quotationId]
  );
  return { quotation: camelDoc(res.rows[0]), items: toCamelRows(items.rows), orders: toCamelRows(orders.rows) };
}

export async function getSalesOrder(client: pg.PoolClient, ctx: Ctx, orderId: number) {
  const res = await client.query(
    `SELECT so.*, c.name AS customer_name, c.code AS customer_code, q.quotation_no,
            c.address AS customer_address, c.billing_address AS customer_billing_address,
            c.shipping_address AS customer_shipping_address, c.phone AS customer_phone,
            c.email AS customer_email, c.tin AS customer_tin, c.vrn AS customer_vrn,
            c.payment_terms_days AS customer_payment_terms_days
     FROM sales_orders so
     JOIN customers c ON c.id = so.customer_id
     LEFT JOIN sales_quotations q ON q.id = so.quotation_id
     WHERE so.id = $1 AND so.tenant_id = $2`,
    [orderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Sales order not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name
     FROM sales_order_items i
     LEFT JOIN products p ON p.id = i.product_id
     WHERE i.order_id = $1 ORDER BY i.id`,
    [orderId]
  );
  const deliveries = await client.query(
    `SELECT id, delivery_no, status, dispatch_date, delivered_at FROM delivery_notes WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  const invoices = await client.query(
    `SELECT id, invoice_no, status, total, amount_paid, invoice_date
     FROM customer_invoices WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  return {
    order: camelDoc(res.rows[0]),
    items: toCamelRows(items.rows),
    deliveries: toCamelRows(deliveries.rows),
    invoices: toCamelRows(invoices.rows),
  };
}

export async function getDeliveryNote(client: pg.PoolClient, ctx: Ctx, deliveryNoteId: number) {
  const res = await client.query(
    `SELECT dn.*, so.order_no, so.customer_id, so.id AS sales_order_id, c.name AS customer_name, c.code AS customer_code,
            c.address AS customer_address, c.billing_address AS customer_billing_address,
            c.shipping_address AS customer_shipping_address, c.phone AS customer_phone,
            c.email AS customer_email, c.tin AS customer_tin, c.vrn AS customer_vrn,
            v.plate_no AS vehicle_plate, v.code AS vehicle_code, d.name AS driver_name, d.phone AS driver_phone
     FROM delivery_notes dn
     JOIN sales_orders so ON so.id = dn.order_id
     JOIN customers c ON c.id = so.customer_id
     LEFT JOIN vehicles v ON v.id = dn.vehicle_id
     LEFT JOIN drivers d ON d.id = dn.driver_id
     WHERE dn.id = $1 AND dn.tenant_id = $2`,
    [deliveryNoteId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Delivery note not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name, b.batch_no
     FROM delivery_note_items i
     LEFT JOIN products p ON p.id = i.product_id
     LEFT JOIN product_batches b ON b.id = i.batch_id
     WHERE i.delivery_note_id = $1 ORDER BY i.id`,
    [deliveryNoteId]
  );
  const invoices = await client.query(
    `SELECT id, invoice_no, status, total, amount_paid, invoice_date
     FROM customer_invoices WHERE delivery_note_id = $1 OR order_id = $2 ORDER BY id`,
    [deliveryNoteId, Number(res.rows[0].sales_order_id)]
  );
  return {
    deliveryNote: camelDoc(res.rows[0]),
    items: toCamelRows(items.rows),
    invoices: toCamelRows(invoices.rows),
  };
}

export async function getInvoice(client: pg.PoolClient, ctx: Ctx, invoiceId: number) {
  const res = await client.query(
    `SELECT inv.*, c.name AS customer_name, c.code AS customer_code, so.order_no, dn.delivery_no,
            c.address AS customer_address, c.billing_address AS customer_billing_address,
            c.shipping_address AS customer_shipping_address, c.phone AS customer_phone,
            c.email AS customer_email, c.tin AS customer_tin, c.vrn AS customer_vrn,
            c.payment_terms_days AS customer_payment_terms_days
     FROM customer_invoices inv
     JOIN customers c ON c.id = inv.customer_id
     LEFT JOIN sales_orders so ON so.id = inv.order_id
     LEFT JOIN delivery_notes dn ON dn.id = inv.delivery_note_id
     WHERE inv.id = $1 AND inv.tenant_id = $2`,
    [invoiceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Invoice not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name
     FROM invoice_items i
     LEFT JOIN products p ON p.id = i.product_id
     WHERE i.invoice_id = $1 ORDER BY i.id`,
    [invoiceId]
  );
  const receipts = await client.query(
    `SELECT DISTINCT ON (r.id) r.id, r.receipt_no, r.status, r.amount, r.method, r.receipt_date,
            COALESCE(a.amount, r.amount) AS allocated_amount
     FROM receipts r
     LEFT JOIN receipt_allocations a ON a.receipt_id = r.id AND a.invoice_id = $1
     WHERE r.invoice_id = $1 OR a.invoice_id = $1
     ORDER BY r.id`,
    [invoiceId]
  );
  return { invoice: camelDoc(res.rows[0]), items: toCamelRows(items.rows), receipts: toCamelRows(receipts.rows) };
}

export async function postInvoice(client: pg.PoolClient, ctx: Ctx, invoiceId: number) {
  const journalId = await finance.postSalesInvoice(client, ctx, invoiceId);
  return { invoiceId, journalId };
}

export async function postDebitNote(client: pg.PoolClient, ctx: Ctx, debitNoteId: number) {
  const journalId = await finance.postDebitNote(client, ctx, debitNoteId);
  return { debitNoteId, journalId };
}

export async function listSellableProducts(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name, type, standard_price, unit_id
     FROM products WHERE tenant_id = $1 AND company_id = $2 AND status = 'ACTIVE'
     ORDER BY code LIMIT 80`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function listCustomers(client: pg.PoolClient, ctx: Ctx, q?: string) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['c.tenant_id = $1', 'c.company_id = $2', `c.status IN ('ACTIVE','PROSPECT')`];
  if (q?.trim()) {
    params.push(`%${q.trim()}%`);
    where.push(`(c.code ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }
  const res = await client.query(
    `SELECT c.id, c.code, c.name, c.status, c.credit_limit
     FROM customers c WHERE ${where.join(' AND ')} ORDER BY c.name LIMIT 80`,
    params
  );
  return toCamelRows(res.rows);
}

export async function listQuotations(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['q.tenant_id = $1', 'q.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(q.quotation_no ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`q.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT q.id, q.quotation_no, q.status, q.quotation_date, q.valid_until, q.total,
            c.code AS customer_code, c.name AS customer_name
     FROM sales_quotations q JOIN customers c ON c.id = q.customer_id
     WHERE ${where.join(' AND ')}
     ORDER BY q.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: toCamelRows(res.rows), page, pageSize };
}

export async function listOrders(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['so.tenant_id = $1', 'so.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(so.order_no ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`so.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT so.id, so.order_no, so.status, so.order_date, so.total, so.allocated,
            c.code AS customer_code, c.name AS customer_name,
            (SELECT COALESCE(sum(i.dispatched_qty),0) FROM sales_order_items i WHERE i.order_id = so.id)::numeric AS dispatched_qty,
            (SELECT COALESCE(sum(i.quantity),0) FROM sales_order_items i WHERE i.order_id = so.id)::numeric AS ordered_qty
     FROM sales_orders so JOIN customers c ON c.id = so.customer_id
     WHERE ${where.join(' AND ')}
     ORDER BY so.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: toCamelRows(res.rows), page, pageSize };
}

export async function listInvoices(client: pg.PoolClient, ctx: Ctx, filters: { q?: string; status?: string } = {}) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['inv.tenant_id = $1', 'inv.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(inv.invoice_no ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`inv.status = $${params.length}`);
  }
  const res = await client.query(
    `SELECT inv.id, inv.invoice_no, inv.status, inv.invoice_date, inv.due_date, inv.total, inv.amount_paid, inv.gl_posted,
            c.code AS customer_code, c.name AS customer_name, so.order_no
     FROM customer_invoices inv
     JOIN customers c ON c.id = inv.customer_id
     LEFT JOIN sales_orders so ON so.id = inv.order_id
     WHERE ${where.join(' AND ')}
     ORDER BY inv.id DESC LIMIT 80`,
    params
  );
  return toCamelRows(res.rows);
}

export async function listReceipts(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT r.id, r.receipt_no, r.status, r.receipt_date, r.amount, r.method, r.gl_posted, r.unallocated_amount,
            c.code AS customer_code, c.name AS customer_name, inv.invoice_no
     FROM receipts r
     JOIN customers c ON c.id = r.customer_id
     LEFT JOIN customer_invoices inv ON inv.id = r.invoice_id
     WHERE r.tenant_id = $1 AND r.company_id = $2
     ORDER BY r.id DESC LIMIT 80`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function getReceipt(client: pg.PoolClient, ctx: Ctx, receiptId: number) {
  const res = await client.query(
    `SELECT r.*, c.name AS customer_name, c.code AS customer_code,
            c.address AS customer_address, c.billing_address AS customer_billing_address,
            c.shipping_address AS customer_shipping_address, c.phone AS customer_phone,
            c.email AS customer_email, c.tin AS customer_tin, c.vrn AS customer_vrn,
            inv.invoice_no
     FROM receipts r
     JOIN customers c ON c.id = r.customer_id
     LEFT JOIN customer_invoices inv ON inv.id = r.invoice_id
     WHERE r.id = $1 AND r.tenant_id = $2`,
    [receiptId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Receipt not found');
  const allocations = await client.query(
    `SELECT a.id, a.invoice_id, a.amount, i.invoice_no, i.status AS invoice_status, i.total, i.amount_paid
     FROM receipt_allocations a
     JOIN customer_invoices i ON i.id = a.invoice_id
     WHERE a.receipt_id = $1 ORDER BY a.id`,
    [receiptId]
  );
  return { receipt: camelDoc(res.rows[0]), allocations: toCamelRows(allocations.rows) };
}

export async function getCreditNote(client: pg.PoolClient, ctx: Ctx, creditNoteId: number) {
  const res = await client.query(
    `SELECT cn.*, c.name AS customer_name, c.code AS customer_code,
            c.address AS customer_address, c.billing_address AS customer_billing_address,
            c.phone AS customer_phone, c.email AS customer_email, c.tin AS customer_tin, c.vrn AS customer_vrn,
            i.invoice_no
     FROM credit_notes cn
     JOIN customers c ON c.id = cn.customer_id
     LEFT JOIN customer_invoices i ON i.id = cn.invoice_id
     WHERE cn.id = $1 AND cn.tenant_id = $2`,
    [creditNoteId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Credit note not found');
  return { creditNote: camelDoc(res.rows[0]) };
}

export async function getDebitNote(client: pg.PoolClient, ctx: Ctx, debitNoteId: number) {
  const res = await client.query(
    `SELECT dn.*, c.name AS customer_name, c.code AS customer_code,
            c.address AS customer_address, c.billing_address AS customer_billing_address,
            c.phone AS customer_phone, c.email AS customer_email, c.tin AS customer_tin, c.vrn AS customer_vrn,
            i.invoice_no
     FROM debit_notes dn
     JOIN customers c ON c.id = dn.customer_id
     LEFT JOIN customer_invoices i ON i.id = dn.invoice_id
     WHERE dn.id = $1 AND dn.tenant_id = $2`,
    [debitNoteId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Debit note not found');
  return { debitNote: camelDoc(res.rows[0]) };
}

export async function getSalesReturn(client: pg.PoolClient, ctx: Ctx, returnId: number) {
  const res = await client.query(
    `SELECT r.*, c.name AS customer_name, c.code AS customer_code,
            c.address AS customer_address, c.shipping_address AS customer_shipping_address,
            c.phone AS customer_phone, c.email AS customer_email, c.tin AS customer_tin,
            so.order_no, dn.delivery_no
     FROM sales_returns r
     JOIN customers c ON c.id = r.customer_id
     LEFT JOIN sales_orders so ON so.id = r.order_id
     LEFT JOIN delivery_notes dn ON dn.id = r.delivery_note_id
     WHERE r.id = $1 AND r.tenant_id = $2`,
    [returnId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Sales return not found');
  const items = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name, b.batch_no
     FROM sales_return_items i
     LEFT JOIN products p ON p.id = i.product_id
     LEFT JOIN product_batches b ON b.id = i.batch_id
     WHERE i.return_id = $1 ORDER BY i.id`,
    [returnId]
  );
  return { salesReturn: camelDoc(res.rows[0]), items: toCamelRows(items.rows) };
}

export async function salesBoard(client: pg.PoolClient, ctx: Ctx) {
  const kpis = await client.query(
    `SELECT
       (SELECT count(*) FROM sales_quotations WHERE tenant_id = $1 AND company_id = $2 AND status IN ('DRAFT','SUBMITTED','APPROVED'))::int AS open_quotes,
       (SELECT count(*) FROM sales_orders WHERE tenant_id = $1 AND company_id = $2 AND status IN ('DRAFT','SUBMITTED','APPROVED','ALLOCATED','PARTIALLY_DISPATCHED'))::int AS open_orders,
       (SELECT count(*) FROM sales_orders WHERE tenant_id = $1 AND company_id = $2 AND status IN ('APPROVED','ALLOCATED'))::int AS to_ship,
       (SELECT count(*) FROM sales_orders WHERE tenant_id = $1 AND company_id = $2 AND status IN ('DISPATCHED','PARTIALLY_DISPATCHED'))::int AS to_invoice,
       (SELECT COALESCE(sum(total - amount_paid),0) FROM customer_invoices
         WHERE tenant_id = $1 AND company_id = $2 AND status NOT IN ('VOID','PAID'))::numeric AS open_ar`,
    [ctx.tenantId, ctx.companyId]
  );
  const quotes = await client.query(
    `SELECT q.id, q.quotation_no, q.status, q.total, c.name AS customer_name
     FROM sales_quotations q JOIN customers c ON c.id = q.customer_id
     WHERE q.tenant_id = $1 AND q.company_id = $2 AND q.status IN ('DRAFT','APPROVED')
     ORDER BY q.id DESC LIMIT 8`,
    [ctx.tenantId, ctx.companyId]
  );
  const orders = await client.query(
    `SELECT so.id, so.order_no, so.status, so.total, c.name AS customer_name
     FROM sales_orders so JOIN customers c ON c.id = so.customer_id
     WHERE so.tenant_id = $1 AND so.company_id = $2
       AND so.status IN ('DRAFT','SUBMITTED','APPROVED','ALLOCATED','PARTIALLY_DISPATCHED','DISPATCHED')
     ORDER BY so.id DESC LIMIT 10`,
    [ctx.tenantId, ctx.companyId]
  );
  const invoices = await client.query(
    `SELECT inv.id, inv.invoice_no, inv.status, inv.total, inv.amount_paid, c.name AS customer_name
     FROM customer_invoices inv JOIN customers c ON c.id = inv.customer_id
     WHERE inv.tenant_id = $1 AND inv.company_id = $2 AND inv.status NOT IN ('VOID','PAID')
     ORDER BY inv.due_date NULLS LAST, inv.id DESC LIMIT 8`,
    [ctx.tenantId, ctx.companyId]
  );
  return {
    kpis: toCamelRow(kpis.rows[0]),
    quotes: toCamelRows(quotes.rows),
    orders: toCamelRows(orders.rows),
    invoices: toCamelRows(invoices.rows),
  };
}
