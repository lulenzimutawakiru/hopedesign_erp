import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, db } from './helpers.js';

async function productAndSupplier(token: string) {
  const products = await api.get('/api/inventory/items?pageSize=40').set(auth(token));
  expect(products.status).toBe(200);
  const product =
    products.body.data.find((p: { code: string }) => p.code === 'JUMBO-105') ??
    products.body.data.find((p: { type: string }) => p.type === 'JUMBO_ROLL' || p.type === 'PAPER_BOBBIN') ??
    products.body.data[0];
  expect(product).toBeTruthy();

  const listed = await api.get('/api/ops/procurement/suppliers').set(auth(token));
  expect(listed.status).toBe(200);
  let supplier = (listed.body.data as { id: number; name: string }[])[0];
  if (!supplier) {
    const created = await api.post('/api/ops/procurement/suppliers').set(auth(token)).send({
      name: 'Nile Fibre Mills',
      supplierType: 'RAW_MATERIAL',
      paymentTermsDays: 30,
    });
    expect(created.status).toBe(200);
    supplier = { id: created.body.data.supplierId, name: 'Nile Fibre Mills' };
  }
  return { product, supplier };
}

describe('Procurement source-to-pay', () => {
  it('raises a PR, converts to PO, receives into stock and posts a matched AP invoice', async () => {
    const { token } = await loginAs('admin');
    const { product, supplier } = await productAndSupplier(token);

    const pr = await api.post('/api/ops/procurement/requisitions').set(auth(token)).send({
      notes: 'Mill fibre cover',
      items: [{ productId: product.id, quantity: 4, estimatedCost: 250000 }],
    });
    expect(pr.status).toBe(200);
    const requisitionId = Number(pr.body.data.requisitionId);
    expect(requisitionId).toBeGreaterThan(0);

    const submitted = await api.post(`/api/ops/procurement/requisitions/${requisitionId}/submit`).set(auth(token)).send({});
    expect(submitted.status).toBe(200);

    // Seeded WF-PR workflow creates approval tasks instead of auto-approving,
    // so release the requisition (mirrors the PO release below) before convert.
    await db(`UPDATE purchase_requisitions SET status = 'APPROVED' WHERE id = $1`, [requisitionId]);

    const converted = await api.post(`/api/ops/procurement/requisitions/${requisitionId}/convert`).set(auth(token)).send({
      supplierId: supplier.id,
    });
    expect(converted.status).toBe(200);
    const orderId = Number(converted.body.data.orderId);
    expect(orderId).toBeGreaterThan(0);

    // SoD blocks a creator from approving. Release the PO so receive/invoice can run.
    await db(`UPDATE purchase_orders SET status = 'APPROVED' WHERE id = $1`, [orderId]);

    const detail = await api.get(`/api/ops/procurement/orders/${orderId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.order.status).toBe('APPROVED');
    const line = detail.body.data.items[0];
    expect(line).toBeTruthy();

    const grn = await api.post('/api/ops/procurement/goods-receipts').set(auth(token)).send({
      poId: orderId,
      deliveryRef: 'DN-TEST-1',
      items: [{
        poItemId: line.id,
        productId: product.id,
        quantityReceived: 4,
        unitCost: Number(line.unitPrice),
      }],
    });
    expect(grn.status).toBe(200);
    expect(grn.body.data.grnNo).toMatch(/^GRN/);

    const afterRecv = await api.get(`/api/ops/procurement/orders/${orderId}`).set(auth(token));
    expect(afterRecv.status).toBe(200);
    expect(afterRecv.body.data.order.status).toBe('RECEIVED');
    expect(Number(afterRecv.body.data.items[0].receivedQty)).toBe(4);

    const invoice = await api.post('/api/ops/procurement/supplier-invoices').set(auth(token)).send({
      poId: orderId,
      grnId: grn.body.data.grnId,
      supplierId: supplier.id,
      items: [{
        poItemId: line.id,
        productId: product.id,
        quantity: 4,
        unitPrice: Number(line.unitPrice),
      }],
    });
    expect(invoice.status).toBe(200);
    expect(invoice.body.data.threeWayMatched).toBe(true);
    const invoiceId = Number(invoice.body.data.invoiceId);

    const posted = await api.post(`/api/ops/procurement/supplier-invoices/${invoiceId}/submit`).set(auth(token)).send({});
    expect(posted.status).toBe(200);

    const inv = await api.get(`/api/ops/procurement/supplier-invoices/${invoiceId}`).set(auth(token));
    expect(inv.status).toBe(200);
    expect(inv.body.data.invoice.glPosted).toBe(true);
    expect(inv.body.data.invoice.status).toBe('MATCHED');
    expect(inv.body.data.invoice.threeWayMatched).toBe(true);
  });

  it('exposes the buy board and demand', async () => {
    const { token } = await loginAs('admin');
    const board = await api.get('/api/ops/procurement/board').set(auth(token));
    expect(board.status).toBe(200);
    expect(board.body.data.kpis).toBeTruthy();
    expect(Array.isArray(board.body.data.inbound)).toBe(true);
    expect(Array.isArray(board.body.data.awaiting)).toBe(true);

    const demand = await api.get('/api/ops/procurement/demand').set(auth(token));
    expect(demand.status).toBe(200);
    expect(Array.isArray(demand.body.data.shortages)).toBe(true);
    expect(Array.isArray(demand.body.data.mrp)).toBe(true);
  });

  it('rejects an invoice that exceeds received quantity', async () => {
    const { token } = await loginAs('admin');
    const { product, supplier } = await productAndSupplier(token);
    const po = await api.post('/api/ops/procurement/orders').set(auth(token)).send({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 2, unitPrice: 10000 }],
    });
    expect(po.status).toBe(200);
    const orderId = Number(po.body.data.orderId);
    await db(`UPDATE purchase_orders SET status = 'APPROVED' WHERE id = $1`, [orderId]);
    const detail = await api.get(`/api/ops/procurement/orders/${orderId}`).set(auth(token));
    const line = detail.body.data.items[0];

    const invoice = await api.post('/api/ops/procurement/supplier-invoices').set(auth(token)).send({
      poId: orderId,
      supplierId: supplier.id,
      items: [{ poItemId: line.id, productId: product.id, quantity: 2, unitPrice: 10000 }],
    });
    expect(invoice.status).toBe(200);
    expect(invoice.body.data.threeWayMatched).toBe(false);
  });

  it('prints payment voucher, supplier return, inspection report and bid analysis', async () => {
    const { token } = await loginAs('admin');
    const { product, supplier } = await productAndSupplier(token);

    const pr = await api.post('/api/ops/procurement/requisitions').set(auth(token)).send({
      notes: 'Document print cover',
      items: [{ productId: product.id, quantity: 3, estimatedCost: 80000 }],
    });
    expect(pr.status).toBe(200);
    const requisitionId = Number(pr.body.data.requisitionId);
    await api.post(`/api/ops/procurement/requisitions/${requisitionId}/submit`).set(auth(token)).send({});
    await db(`UPDATE purchase_requisitions SET status = 'APPROVED' WHERE id = $1`, [requisitionId]);

    const rfq = await api.post('/api/ops/procurement/rfqs').set(auth(token)).send({
      requisitionId,
      supplierIds: [supplier.id],
    });
    expect(rfq.status).toBe(200);
    const rfqId = Number(rfq.body.data.rfqId);
    const rfqDetail = await api.get(`/api/ops/procurement/rfqs/${rfqId}`).set(auth(token));
    expect(rfqDetail.status).toBe(200);
    const rfqItem = rfqDetail.body.data.items[0];
    const quoted = await api.post('/api/ops/procurement/quotations').set(auth(token)).send({
      rfqId,
      supplierId: supplier.id,
      items: [{ rfqItemId: rfqItem.id, productId: product.id, quantity: 3, unitPrice: 75000 }],
    });
    expect(quoted.status).toBe(200);
    const bid = await api.get(`/api/documents/bid-analysis/${rfqId}?format=print`).set(auth(token));
    expect(bid.status).toBe(200);
    expect(bid.text).toContain('Bid Analysis');
    expect(bid.text).toContain('Quote comparison');
    const sqPrint = await api.get(`/api/documents/supplier-quotation/${quoted.body.data.quotationId}?format=print`).set(auth(token));
    expect(sqPrint.status).toBe(200);
    expect(sqPrint.text).toContain('Supplier Quotation');

    const converted = await api.post(`/api/ops/procurement/requisitions/${requisitionId}/convert`).set(auth(token)).send({
      supplierId: supplier.id,
    });
    expect(converted.status).toBe(200);
    const orderId = Number(converted.body.data.orderId);
    await db(`UPDATE purchase_orders SET status = 'APPROVED' WHERE id = $1`, [orderId]);
    const detail = await api.get(`/api/ops/procurement/orders/${orderId}`).set(auth(token));
    const line = detail.body.data.items[0];
    const grn = await api.post('/api/ops/procurement/goods-receipts').set(auth(token)).send({
      poId: orderId,
      deliveryRef: 'DN-PRINT-1',
      items: [{ poItemId: line.id, productId: product.id, quantityReceived: 3, unitCost: Number(line.unitPrice) }],
    });
    expect(grn.status).toBe(200);
    const grnId = Number(grn.body.data.grnId);
    const grnLoaded = await api.get(`/api/ops/procurement/goods-receipts/${grnId}`).set(auth(token));
    expect(grnLoaded.status).toBe(200);
    const qc = await api.post(`/api/ops/procurement/goods-receipts/${grnId}/qc`).set(auth(token)).send({
      results: (grnLoaded.body.data.items as { id: number }[]).map((i) => ({ grnItemId: Number(i.id), result: 'PASSED' as const })),
    });
    expect(qc.status).toBe(200);
    const inspectionId = Number(qc.body.data.inspections[0]);
    const inspPrint = await api.get(`/api/documents/inspection/${inspectionId}?format=print`).set(auth(token));
    expect(inspPrint.status).toBe(200);
    expect(inspPrint.text).toContain('Incoming Inspection Report');

    const retIns = await db(
      `INSERT INTO purchase_returns (company_id, tenant_id, return_no, grn_id, po_id, supplier_id, reason, status)
       SELECT company_id, tenant_id, $2, id, po_id, supplier_id, 'Damaged on arrival', 'OPEN'
       FROM goods_receipts WHERE id = $1 RETURNING id`,
      [grnId, `PRN-DOC-${Date.now()}`]
    );
    const returnId = Number(retIns.rows[0].id);
    await db(`INSERT INTO purchase_return_items (return_id, product_id, quantity) VALUES ($1,$2,1)`, [returnId, product.id]);
    const retPrint = await api.get(`/api/documents/purchase-return/${returnId}?format=print`).set(auth(token));
    expect(retPrint.status).toBe(200);
    expect(retPrint.text).toContain('Supplier Return Note');

    const invoice = await api.post('/api/ops/procurement/supplier-invoices').set(auth(token)).send({
      poId: orderId,
      grnId,
      supplierId: supplier.id,
      items: [{ poItemId: line.id, productId: product.id, quantity: 2, unitPrice: Number(line.unitPrice) }],
    });
    expect(invoice.status).toBe(200);
    const pay = await api.post('/api/ops/procurement/payments').set(auth(token)).send({
      supplierInvoiceId: invoice.body.data.invoiceId,
      supplierId: supplier.id,
      amount: 50000,
      method: 'BANK_TRANSFER',
    });
    expect(pay.status).toBe(200);
    const voucher = await api.get(`/api/documents/supplier-payment/${pay.body.data.paymentId}?format=print`).set(auth(token));
    expect(voucher.status).toBe(200);
    expect(voucher.text).toContain('Payment Voucher');
    const pdf = await api.get(`/api/documents/supplier-payment/${pay.body.data.paymentId}?format=pdf`).set(auth(token));
    expect(pdf.status).toBe(200);
    const buf = Buffer.isBuffer(pdf.body) ? pdf.body : Buffer.from(pdf.body);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 40_000);

  it('rejects a duplicate supplier invoice document and a duplicate payment', async () => {
    const { token } = await loginAs('admin');
    const { product, supplier } = await productAndSupplier(token);
    const docNo = `SUP-DUP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    const poA = await api.post('/api/ops/procurement/orders').set(auth(token)).send({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 1, unitPrice: 15000 }],
    });
    expect(poA.status).toBe(200);
    const aId = Number(poA.body.data.orderId);
    await db(`UPDATE purchase_orders SET status = 'APPROVED' WHERE id = $1`, [aId]);
    const aDetail = await api.get(`/api/ops/procurement/orders/${aId}`).set(auth(token));
    const aLine = aDetail.body.data.items[0];

    const first = await api.post('/api/ops/procurement/supplier-invoices').set(auth(token)).send({
      poId: aId,
      supplierId: supplier.id,
      supplierDocumentNo: docNo,
      items: [{ poItemId: aLine.id, productId: product.id, quantity: 1, unitPrice: 15000 }],
    });
    expect(first.status).toBe(200);

    const poB = await api.post('/api/ops/procurement/orders').set(auth(token)).send({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 1, unitPrice: 15000 }],
    });
    expect(poB.status).toBe(200);
    const bId = Number(poB.body.data.orderId);
    await db(`UPDATE purchase_orders SET status = 'APPROVED' WHERE id = $1`, [bId]);
    const bDetail = await api.get(`/api/ops/procurement/orders/${bId}`).set(auth(token));
    const bLine = bDetail.body.data.items[0];

    const dupInv = await api.post('/api/ops/procurement/supplier-invoices').set(auth(token)).send({
      poId: bId,
      supplierId: supplier.id,
      supplierDocumentNo: docNo,
      items: [{ poItemId: bLine.id, productId: product.id, quantity: 1, unitPrice: 15000 }],
    });
    expect(dupInv.status).toBe(409);
    expect(String(dupInv.body.error?.message ?? dupInv.body.message ?? '')).toMatch(/Duplicate supplier invoice/i);

    const payRef = `PAY-DUP-${docNo}`;
    const pay = await api.post('/api/ops/procurement/payments').set(auth(token)).send({
      supplierId: supplier.id,
      amount: 77777,
      method: 'BANK_TRANSFER',
      reference: payRef,
      paymentDate: '2026-08-24',
    });
    expect(pay.status).toBe(200);

    const dupPay = await api.post('/api/ops/procurement/payments').set(auth(token)).send({
      supplierId: supplier.id,
      amount: 77777,
      method: 'BANK_TRANSFER',
      reference: payRef,
      paymentDate: '2026-08-24',
    });
    expect(dupPay.status).toBe(409);
    expect(String(dupPay.body.error?.message ?? dupPay.body.message ?? '')).toMatch(/Duplicate supplier payment/i);
  });
});
