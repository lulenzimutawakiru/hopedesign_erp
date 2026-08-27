import { Router } from 'express';
import pg from 'pg';
import multer from 'multer';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest } from '../../utils.js';
import * as proc from '../../services/procurement.js';

export const procurementOpsRouter = Router();
const prUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

procurementOpsRouter.get('/board', ...runGet('procurement.orders.view', (c, ctx) => proc.buyBoard(c, ctx)));
procurementOpsRouter.get('/demand', ...runGet('procurement.requisitions.view', (c, ctx) => proc.buyDemand(c, ctx)));
procurementOpsRouter.post('/demand/make', ...run('procurement.requisitions.create', (c, ctx, b) => proc.makeFromDemand(c, ctx, {
  productId: Number(b.productId),
  quantity: Number(b.quantity),
  supplierId: b.supplierId != null ? Number(b.supplierId) : null,
  needBy: b.needBy != null ? String(b.needBy) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));

// Suppliers
procurementOpsRouter.get('/suppliers', ...runGet('procurement.suppliers.view', (c, ctx, q) => proc.listSuppliers(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
})));
procurementOpsRouter.post('/suppliers', ...run('procurement.suppliers.create', (c, ctx, b) => proc.createSupplier(c, ctx, b)));
procurementOpsRouter.post('/suppliers/:id/submit', ...run('procurement.suppliers.submit', (c, ctx, _b, p) => proc.submitSupplier(c, ctx, Number(p.id))));

// Requisitions
procurementOpsRouter.get('/requisitions', ...runGet('procurement.requisitions.view', (c, ctx, q) => proc.listRequisitions(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
procurementOpsRouter.get('/requisition-meta', ...runGet('procurement.requisitions.view', (c, ctx, q) => proc.requisitionMeta(c, ctx, q.company != null ? Number(q.company) : undefined, q.branch != null ? Number(q.branch) : undefined)));
procurementOpsRouter.get('/requisitions/:id', ...runGet('procurement.requisitions.view', (c, ctx, _q, p) => proc.getRequisition(c, ctx, Number(p.id))));
procurementOpsRouter.post('/requisitions', ...run('procurement.requisitions.create', (c, ctx, b) => proc.createRequisition(c, ctx, b)));
procurementOpsRouter.post('/requisitions/:id/submit', ...run('procurement.requisitions.submit', (c, ctx, _b, p) => proc.submitRequisition(c, ctx, Number(p.id))));
procurementOpsRouter.post('/requisitions/:id/update', ...run('procurement.requisitions.update', (c, ctx, b, p) => proc.updateRequisition(c, ctx, Number(p.id), b)));
procurementOpsRouter.post('/requisitions/:id/reopen', ...run('procurement.requisitions.update', (c, ctx, _b, p) => proc.reopenRequisition(c, ctx, Number(p.id))));
procurementOpsRouter.post('/requisitions/:id/cancel', ...run('procurement.requisitions.update', (c, ctx, _b, p) => proc.cancelRequisition(c, ctx, Number(p.id))));
procurementOpsRouter.post('/requisitions/:id/hold', ...run('procurement.requisitions.update', (c, ctx, b, p) => proc.holdRequisition(c, ctx, Number(p.id), b.reason != null ? String(b.reason) : null)));
procurementOpsRouter.post('/requisitions/:id/release', ...run('procurement.requisitions.update', (c, ctx, _b, p) => proc.releaseRequisition(c, ctx, Number(p.id))));
procurementOpsRouter.get('/requisitions/:id/comments', ...runGet('procurement.requisitions.view', (c, ctx, _q, p) => proc.listPrComments(c, ctx, Number(p.id))));
procurementOpsRouter.post('/requisitions/:id/comments', ...run('procurement.requisitions.update', (c, ctx, b, p) => proc.commentOnRequisition(c, ctx, Number(p.id), {
  body: String(b.body ?? ''),
  isInternal: b.isInternal === true,
  mentions: Array.isArray(b.mentions) ? b.mentions.map((n: unknown) => Number(n)) : [],
})));
procurementOpsRouter.get('/requisitions/:id/attachments', ...runGet('procurement.requisitions.view', (c, ctx, _q, p) => proc.listPrAttachments(c, ctx, Number(p.id))));
procurementOpsRouter.post(
  '/requisitions/:id/attachments',
  requirePermission('procurement.requisitions.update'),
  prUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('A file is required (field "file")');
    const out = await tx(
      (client) =>
        proc.uploadPrAttachment(client, req.ctx, Number(req.params.id), {
          file: {
            originalname: req.file!.originalname,
            mimetype: req.file!.mimetype,
            size: req.file!.size,
            buffer: req.file!.buffer,
          },
          title: req.body.title != null ? String(req.body.title) : null,
          classification: req.body.classification != null ? String(req.body.classification) : null,
        }),
      req.ctx
    );
    res.status(201).json({ data: out });
  })
);
procurementOpsRouter.get(
  '/requisitions/:id/attachments/:attachmentId/file',
  requirePermission('procurement.requisitions.view'),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => proc.getPrAttachmentFile(client, req.ctx, Number(req.params.id), Number(req.params.attachmentId)),
      req.ctx
    );
    res.setHeader('Content-Type', out.mimeType);
    res.setHeader('Content-Length', String(out.sizeBytes));
    res.setHeader('Content-Disposition', `attachment; filename="${out.fileName.replace(/[^A-Za-z0-9._-]+/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(out.buffer);
  })
);
procurementOpsRouter.post('/requisitions/:id/assign', ...run('procurement.requisitions.update', (c, ctx, b, p) => proc.assignRequisition(c, ctx, Number(p.id), {
  officerUserId: Number(b.officerUserId),
  notes: b.notes != null ? String(b.notes) : null,
})));
procurementOpsRouter.get('/requisitions/:id/assignments', ...runGet('procurement.requisitions.view', (c, ctx, _q, p) => proc.listPrAssignments(c, ctx, Number(p.id))));
procurementOpsRouter.get('/requisition-assignees', ...runGet('procurement.requisitions.view', (c, ctx) => proc.listPrAssignees(c, ctx)));
procurementOpsRouter.get('/requisitions/:id/history', ...runGet('procurement.requisitions.view', (c, ctx, _q, p) => proc.requisitionHistory(c, ctx, Number(p.id))));
procurementOpsRouter.get('/requisitions/:id/inventory-check', ...runGet('procurement.requisitions.view', (c, ctx, _q, p) => proc.requisitionInventoryCheck(c, ctx, Number(p.id))));
procurementOpsRouter.post('/requisitions/:id/convert', ...run('procurement.orders.create', (c, ctx, b, p) => proc.convertRequisition(c, ctx, {
  requisitionId: Number(p.id),
  supplierId: Number(b.supplierId),
  expectedDate: b.expectedDate != null ? String(b.expectedDate) : null,
  notes: b.notes != null ? String(b.notes) : null,
})));

// RFQ
procurementOpsRouter.get('/rfqs', ...runGet('procurement.rfqs.view', (c, ctx) => proc.listRfqs(c, ctx)));
procurementOpsRouter.get('/rfqs/:id', ...runGet('procurement.rfqs.view', (c, ctx, _q, p) => proc.getRfq(c, ctx, Number(p.id))));
procurementOpsRouter.post('/rfqs', ...run('procurement.rfqs.create', (c, ctx, b) => proc.createRfq(c, ctx, b)));
procurementOpsRouter.post('/rfqs/:id/evaluate', ...run('procurement.rfqs.evaluate', (c, ctx, _b, p) => proc.evaluateQuotations(c, ctx, Number(p.id))));
procurementOpsRouter.post('/rfqs/:id/convert', ...run('procurement.orders.create', (c, ctx, _b, p) => proc.convertAwardedRfq(c, ctx, Number(p.id))));

// Supplier quotations
procurementOpsRouter.post('/quotations', ...run('procurement.quotations.create', (c, ctx, b) => proc.createSupplierQuotation(c, ctx, b)));
procurementOpsRouter.get('/quotations/:id', ...runGet('procurement.quotations.view', (c, ctx, _q, p) => proc.getSupplierQuotation(c, ctx, Number(p.id))));

// Purchase orders
procurementOpsRouter.get('/orders', ...runGet('procurement.orders.view', (c, ctx, q) => proc.listOrders(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
procurementOpsRouter.get('/orders/:id', ...runGet('procurement.orders.view', (c, ctx, _q, p) => proc.getOrderDetail(c, ctx, Number(p.id))));
procurementOpsRouter.post('/orders', ...run('procurement.orders.create', (c, ctx, b) => proc.createPurchaseOrder(c, ctx, b)));
procurementOpsRouter.post('/orders/:id/submit', ...run('procurement.orders.submit', (c, ctx, _b, p) => proc.submitPurchaseOrder(c, ctx, Number(p.id))));
procurementOpsRouter.post('/orders/:id/approve', ...run('procurement.orders.approve', (c, ctx, _b, p) => proc.approvePurchaseOrder(c, ctx, Number(p.id))));
procurementOpsRouter.post('/orders/:id/cancel', ...run('procurement.orders.update', (c, ctx, _b, p) => proc.cancelPurchaseOrder(c, ctx, Number(p.id))));
procurementOpsRouter.post('/orders/:id/amend', ...run('procurement.orders.update', (c, ctx, b, p) => proc.createPurchaseOrderAmendment(c, ctx, {
  orderId: Number(p.id),
  reason: b.reason != null ? String(b.reason) : null,
  items: Array.isArray(b.items) ? b.items : [],
})));
procurementOpsRouter.get('/orders/:id/amendments', ...runGet('procurement.orders.view', (c, ctx, _q, p) => proc.listPurchaseOrderAmendments(c, ctx, Number(p.id))));
procurementOpsRouter.post('/amendments/:amendmentId/submit', ...run('procurement.orders.update', (c, ctx, _b, p) => proc.submitPurchaseOrderAmendment(c, ctx, Number(p.amendmentId))));
procurementOpsRouter.post('/amendments/:amendmentId/apply', ...run('procurement.orders.update', (c, ctx, _b, p) => proc.applyPurchaseOrderAmendment(c, ctx, Number(p.amendmentId))));

// Three-way match (PO <-> GRN <-> Invoice)
procurementOpsRouter.get('/match', ...runGet('procurement.orders.view', (c, ctx, q) => proc.listMatchDesk(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
  match: q.match != null ? String(q.match) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));
procurementOpsRouter.get('/match/:poId', ...runGet('procurement.orders.view', (c, ctx, q, p) => proc.getThreeWayMatch(c, ctx, Number(p.poId), {
  priceTolerancePct: q.priceTolerancePct != null ? Number(q.priceTolerancePct) : undefined,
})));
procurementOpsRouter.post('/match/:poId/run', ...run('procurement.orders.update', (c, ctx, _b, p) => proc.runThreeWayMatch(c, ctx, Number(p.poId))));

// Supplier price history / price intelligence
procurementOpsRouter.get('/prices', ...runGet('procurement.orders.view', (c, ctx, q) => proc.listPriceHistory(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  supplierId: q.supplierId != null ? Number(q.supplierId) : undefined,
  productId: q.productId != null ? Number(q.productId) : undefined,
  days: q.days != null ? Number(q.days) : undefined,
  flag: q.flag != null ? String(q.flag) : undefined,
  page: q.page != null ? Number(q.page) : undefined,
  pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
})));

// Goods receipts + QC
procurementOpsRouter.get('/goods-receipts', ...runGet('procurement.goods_receipts.view', (c, ctx) => proc.listGoodsReceipts(c, ctx)));
procurementOpsRouter.get('/goods-receipts/:id', ...runGet('procurement.goods_receipts.view', (c, ctx, _q, p) => proc.getGoodsReceipt(c, ctx, Number(p.id))));
procurementOpsRouter.post('/goods-receipts', ...run('procurement.goods_receipts.create', (c, ctx, b) => proc.createGoodsReceipt(c, ctx, b)));
procurementOpsRouter.post('/goods-receipts/:id/qc', ...run('procurement.goods_receipts.inspect', (c, ctx, b, p) => proc.qcGoodsReceipt(c, ctx, Number(p.id), { results: b.results })));
procurementOpsRouter.post('/returns', ...run('procurement.goods_receipts.create', (c, ctx, b) => proc.createPurchaseReturn(c, ctx, {
  grnId: Number(b.grnId),
  reason: String(b.reason ?? 'Return to supplier'),
  items: b.items ?? [],
})));
procurementOpsRouter.get('/returns/:id', ...runGet('procurement.returns.view', (c, ctx, _q, p) => proc.getPurchaseReturn(c, ctx, Number(p.id))));
procurementOpsRouter.get('/inspections/:id', ...runGet('quality.inspections.view', (c, ctx, _q, p) => proc.getInspection(c, ctx, Number(p.id))));

// Supplier invoices + payments
procurementOpsRouter.get('/supplier-invoices', ...runGet('procurement.supplier_invoices.view', (c, ctx, q) => proc.listSupplierInvoices(c, ctx, {
  q: q.q != null ? String(q.q) : undefined,
  status: q.status != null ? String(q.status) : undefined,
})));
procurementOpsRouter.get('/supplier-invoices/:id', ...runGet('procurement.supplier_invoices.view', (c, ctx, _q, p) => proc.getSupplierInvoice(c, ctx, Number(p.id))));
procurementOpsRouter.post('/supplier-invoices', ...run('procurement.supplier_invoices.create', (c, ctx, b) => proc.createSupplierInvoice(c, ctx, b)));
procurementOpsRouter.post('/supplier-invoices/:id/submit', ...run('procurement.supplier_invoices.submit', (c, ctx, _b, p) => proc.submitSupplierInvoice(c, ctx, Number(p.id))));
procurementOpsRouter.get('/payments', ...runGet('procurement.payments.view', (c, ctx) => proc.listPayments(c, ctx)));
procurementOpsRouter.get('/payments/:id', ...runGet('procurement.payments.view', (c, ctx, _q, p) => proc.getSupplierPayment(c, ctx, Number(p.id))));
procurementOpsRouter.post('/payments', ...run('procurement.payments.create', (c, ctx, b) => proc.createSupplierPayment(c, ctx, b)));
procurementOpsRouter.post('/payments/:id/submit', ...run('procurement.payments.submit', (c, ctx, _b, p) => proc.submitSupplierPayment(c, ctx, Number(p.id))));
