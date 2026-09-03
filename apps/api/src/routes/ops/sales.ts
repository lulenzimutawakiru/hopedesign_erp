import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils.js';
import * as sales from '../../services/sales.js';

export const salesOpsRouter = Router();

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

const runGet = (permission: string, fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

salesOpsRouter.get('/board', ...runGet('sales.orders.view', (c, ctx) => sales.salesBoard(c, ctx)));
salesOpsRouter.get('/command-center', ...runGet('sales.orders.view', (c, ctx) => sales.commandCenter(c, ctx)));
salesOpsRouter.get('/products', ...runGet('sales.quotations.create', (c, ctx) => sales.listSellableProducts(c, ctx)));
salesOpsRouter.get('/customers', ...runGet('sales.quotations.view', (c, ctx, q) => sales.listCustomers(c, ctx, q.q != null ? String(q.q) : undefined)));
salesOpsRouter.get('/customers/directory', ...runGet('sales.quotations.view', (c, ctx, q) => sales.customerDirectory(c, ctx, q.q != null ? String(q.q) : undefined)));
salesOpsRouter.get('/customers/:id/360', ...runGet('sales.quotations.view', (c, ctx, _q, p) => sales.customer360(c, ctx, Number(p.id))));

salesOpsRouter.get('/quotations', ...runGet('sales.quotations.view', (c, ctx, q) => sales.listQuotations(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
salesOpsRouter.get('/quotations/:id', ...runGet('sales.quotations.view', (c, ctx, _q, p) => sales.getQuotation(c, ctx, Number(p.id))));
salesOpsRouter.post('/quotations', ...run('sales.quotations.create', (c, ctx, b) => sales.createQuotation(c, ctx, b)));
salesOpsRouter.post('/quotations/:id/submit', ...run('sales.quotations.submit', (c, ctx, _b, p) => sales.submitQuotation(c, ctx, Number(p.id))));
salesOpsRouter.post('/quotations/:id/convert', ...run('sales.quotations.convert', (c, ctx, _b, p) => sales.convertQuotation(c, ctx, Number(p.id))));
salesOpsRouter.post('/quotations/:id/send', ...run('sales.quotations.send', (c, ctx, b, p) => sales.sendQuotationToCustomer(c, ctx, Number(p.id), {
  channels: Array.isArray(b?.channels) ? (b.channels as Array<'EMAIL' | 'SMS'>) : undefined,
  message: b?.message != null ? String(b.message) : null,
})));

salesOpsRouter.get('/orders', ...runGet('sales.orders.view', (c, ctx, q) => sales.listOrders(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
salesOpsRouter.get('/orders/:id', ...runGet('sales.orders.view', (c, ctx, _q, p) => sales.getSalesOrder(c, ctx, Number(p.id))));
salesOpsRouter.post('/orders', ...run('sales.orders.create', (c, ctx, b) => sales.createSalesOrder(c, ctx, b)));
salesOpsRouter.post('/orders/:id/submit', ...run('sales.orders.submit', (c, ctx, _b, p) => sales.submitSalesOrder(c, ctx, Number(p.id))));
salesOpsRouter.post('/orders/:id/allocate', ...run('sales.orders.allocate', (c, ctx, _b, p) => sales.allocateOrder(c, ctx, Number(p.id))));
salesOpsRouter.post('/orders/:id/dispatch', ...run('sales.orders.dispatch', (c, ctx, b, p) => sales.dispatchOrder(c, ctx, {
  orderId: Number(p.id),
  items: (b.items ?? []) as { orderItemId: number; quantity: number; batchId?: number | null; qrId?: number | null }[],
  vehicleId: b.vehicleId != null ? Number(b.vehicleId) : null,
  driverId: b.driverId != null ? Number(b.driverId) : null,
  recipientName: b.recipientName != null ? String(b.recipientName) : null,
  recipientPhone: b.recipientPhone != null ? String(b.recipientPhone) : null,
  dispatchDate: b.dispatchDate != null ? String(b.dispatchDate) : undefined,
  notes: b.notes != null ? String(b.notes) : null,
})));

salesOpsRouter.get('/delivery-notes/:id', ...runGet('sales.delivery_notes.view', (c, ctx, _q, p) => sales.getDeliveryNote(c, ctx, Number(p.id))));
salesOpsRouter.post('/delivery-notes/:id/deliver', ...run('sales.delivery_notes.deliver', (c, ctx, b, p) => sales.deliverDeliveryNote(c, ctx, Number(p.id), {
  receivedBy: b.receivedBy != null ? String(b.receivedBy) : null,
  signature: b.signature != null ? String(b.signature) : null,
  recipientName: b.recipientName != null ? String(b.recipientName) : null,
  recipientPhone: b.recipientPhone != null ? String(b.recipientPhone) : null,
  deliveredAt: b.deliveredAt != null ? String(b.deliveredAt) : undefined,
})));

salesOpsRouter.get('/invoices', ...runGet('sales.invoices.view', (c, ctx, q) => sales.listInvoices(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
})));
salesOpsRouter.get('/invoices/:id', ...runGet('sales.invoices.view', (c, ctx, _q, p) => sales.getInvoice(c, ctx, Number(p.id))));
salesOpsRouter.post('/invoices', ...run('sales.invoices.create', (c, ctx, b) => sales.createInvoice(c, ctx, b)));
salesOpsRouter.post('/invoices/:id/post', ...run('sales.invoices.post', (c, ctx, _b, p) => sales.postInvoice(c, ctx, Number(p.id))));
salesOpsRouter.get('/receipts', ...runGet('sales.receipts.view', (c, ctx) => sales.listReceipts(c, ctx)));
salesOpsRouter.get('/receipts/:id', ...runGet('sales.receipts.view', (c, ctx, _q, p) => sales.getReceipt(c, ctx, Number(p.id))));
salesOpsRouter.post('/receipts', ...run('sales.receipts.create', (c, ctx, b) => sales.createReceipt(c, ctx, {
  invoiceId: b.invoiceId != null ? Number(b.invoiceId) : null,
  customerId: Number(b.customerId),
  receiptDate: b.receiptDate != null ? String(b.receiptDate) : undefined,
  amount: b.amount != null ? Number(b.amount) : undefined,
  method: b.method != null ? String(b.method) : undefined,
  reference: b.reference != null ? String(b.reference) : null,
  bankAccountId: b.bankAccountId != null ? Number(b.bankAccountId) : null,
  description: b.description != null ? String(b.description) : null,
  allocations: Array.isArray(b.allocations)
    ? (b.allocations as Array<{ invoiceId?: number; amount?: number }>).map((a) => ({
        invoiceId: Number(a.invoiceId),
        amount: Number(a.amount),
      }))
    : undefined,
})));
salesOpsRouter.get('/credit-notes/:id', ...runGet('sales.credit_notes.view', (c, ctx, _q, p) => sales.getCreditNote(c, ctx, Number(p.id))));
salesOpsRouter.post('/credit-notes', ...run('sales.credit_notes.create', (c, ctx, b) => sales.createCreditNote(c, ctx, {
  invoiceId: b.invoiceId != null ? Number(b.invoiceId) : null,
  customerId: Number(b.customerId),
  creditDate: b.creditDate != null ? String(b.creditDate) : undefined,
  amount: Number(b.amount),
  reason: String(b.reason ?? ''),
  reasonCode: b.reasonCode != null ? String(b.reasonCode) : null,
})));
salesOpsRouter.get('/debit-notes/:id', ...runGet('sales.debit_notes.view', (c, ctx, _q, p) => sales.getDebitNote(c, ctx, Number(p.id))));
salesOpsRouter.post('/debit-notes/:id/post', ...run('sales.debit_notes.post', (c, ctx, _b, p) => sales.postDebitNote(c, ctx, Number(p.id))));
salesOpsRouter.post('/debit-notes', ...run('sales.debit_notes.create', (c, ctx, b) => sales.createDebitNote(c, ctx, {
  invoiceId: b.invoiceId != null ? Number(b.invoiceId) : null,
  customerId: Number(b.customerId),
  debitDate: b.debitDate != null ? String(b.debitDate) : undefined,
  amount: Number(b.amount),
  reason: String(b.reason ?? ''),
  reasonCode: b.reasonCode != null ? String(b.reasonCode) : null,
})));

salesOpsRouter.post('/returns', ...run('sales.returns.create', (c, ctx, b) => sales.createSalesReturn(c, ctx, b)));
salesOpsRouter.get('/returns/:id', ...runGet('sales.returns.view', (c, ctx, _q, p) => sales.getSalesReturn(c, ctx, Number(p.id))));
salesOpsRouter.post('/returns/:id/complete', ...run('sales.returns.complete', (c, ctx, b, p) => sales.completeSalesReturn(c, ctx, Number(p.id), { qcResult: b.qcResult != null ? String(b.qcResult) : null })));
