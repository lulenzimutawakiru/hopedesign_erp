import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, db } from './helpers.js';

async function sku(): Promise<number> {
  const res = await db(`SELECT id FROM products WHERE code = 'A4-80' UNION ALL SELECT id FROM products LIMIT 1`);
  return Number(res.rows[0].id);
}

describe('Sales order-to-cash ops', () => {
  it('converts an approved quotation into a sales order with copied lines', async () => {
    const { token } = await loginAs('sarah.sales');
    const create = await api.post('/api/ops/sales/quotations').set(auth(token)).send({
      customerId: 1,
      items: [{ productId: 3, quantity: 5, unitPrice: 12000, taxPercent: 18 }],
    });
    expect(create.status).toBe(200);
    const quotationId = create.body.data.quotationId;

    const submit = await api.post(`/api/ops/sales/quotations/${quotationId}/submit`).set(auth(token)).send({});
    expect(submit.status).toBe(200);

    const detail = await api.get(`/api/ops/sales/quotations/${quotationId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.quotation.status).toBe('APPROVED');
    expect(detail.body.data.items.length).toBe(1);

    const convert = await api.post(`/api/ops/sales/quotations/${quotationId}/convert`).set(auth(token)).send({});
    expect(convert.status).toBe(200);
    expect(Number(convert.body.data.orderId)).toBeGreaterThan(0);

    const quoteAfter = await api.get(`/api/ops/sales/quotations/${quotationId}`).set(auth(token));
    expect(quoteAfter.body.data.quotation.status).toBe('CONVERTED');
    expect(quoteAfter.body.data.orders.length).toBeGreaterThanOrEqual(1);

    const order = await api.get(`/api/ops/sales/orders/${convert.body.data.orderId}`).set(auth(token));
    expect(order.status).toBe(200);
    expect(order.body.data.order.status).toBe('DRAFT');
    expect(Number(order.body.data.order.quotationId)).toBe(quotationId);
    expect(order.body.data.items.length).toBe(1);
    expect(Number(order.body.data.items[0].quantity)).toBe(5);
  });

  it('charges VAT after the header discount on sales orders', async () => {
    const { token } = await loginAs('sarah.sales');
    const create = await api.post('/api/ops/sales/orders').set(auth(token)).send({
      customerId: 1,
      items: [{ productId: 3, quantity: 2, unitPrice: 1000, taxPercent: 18 }],
      discountType: 'PERCENT',
      discountValue: 10,
    });
    expect(create.status).toBe(200);
    const orderId = Number(create.body.data.orderId);
    const detail = await api.get(`/api/ops/sales/orders/${orderId}`).set(auth(token));
    expect(detail.status).toBe(200);
    const order = detail.body.data.order;
    expect(Number(order.subtotal)).toBe(2000);
    expect(Number(order.discountAmount ?? order.discount_amount)).toBe(200);
    expect(Number(order.taxAmount ?? order.tax_amount)).toBe(324);
    expect(Number(order.total)).toBe(2124);
  });

  it('refuses to convert a draft quotation', async () => {
    const { token } = await loginAs('sarah.sales');
    const create = await api.post('/api/ops/sales/quotations').set(auth(token)).send({
      customerId: 1,
      items: [{ productId: 3, quantity: 1, unitPrice: 1000 }],
    });
    const refused = await api
      .post(`/api/ops/sales/quotations/${create.body.data.quotationId}/convert`)
      .set(auth(token))
      .send({});
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/only APPROVED/i);
  });

  it('runs quote to cash: convert, dispatch, invoice, collect', async () => {
    const { token } = await loginAs('sarah.sales');
    const productId = await sku();
    const quoted = await api.post('/api/ops/sales/quotations').set(auth(token)).send({
      customerId: 1,
      items: [{ productId, quantity: 2, unitPrice: 15000, taxPercent: 18 }],
    });
    expect(quoted.status).toBe(200);
    const quotationId = quoted.body.data.quotationId;
    await api.post(`/api/ops/sales/quotations/${quotationId}/submit`).set(auth(token)).send({});
    const converted = await api.post(`/api/ops/sales/quotations/${quotationId}/convert`).set(auth(token)).send({});
    expect(converted.status).toBe(200);
    const orderId = Number(converted.body.data.orderId);
    await db(`UPDATE sales_orders SET status = 'APPROVED' WHERE id = $1`, [orderId]);
    const stocked = await db(
      `UPDATE inventory SET quantity = GREATEST(quantity, 25)
       WHERE product_id = $1 AND batch_id IS NULL AND bin_id IS NULL
         AND warehouse_id = (SELECT w.id FROM warehouses w JOIN products p ON p.company_id = w.company_id WHERE p.id = $1 AND w.code = 'FG-WH' LIMIT 1)
       RETURNING id`,
      [productId]
    );
    if (stocked.rows.length === 0) {
      await db(
        `INSERT INTO inventory (company_id, tenant_id, product_id, warehouse_id, quantity, reserved_qty, avg_cost)
         SELECT p.company_id, p.tenant_id, p.id, w.id, 25, 0, 4000
         FROM products p
         JOIN warehouses w ON w.company_id = p.company_id AND w.code = 'FG-WH'
         WHERE p.id = $1`,
        [productId]
      );
    }
    const shipped = await api.post(`/api/ops/sales/orders/${orderId}/dispatch`).set(auth(token)).send({});
    expect(shipped.status).toBe(200);
    expect(shipped.body.data.deliveryNo).toMatch(/^DN/);

    const { token: admin } = await loginAs('admin');
    const invoice = await api.post('/api/ops/sales/invoices').set(auth(admin)).send({ orderId });
    expect(invoice.status).toBe(200);
    const invoiceId = Number(invoice.body.data.invoiceId);
    await db(`UPDATE customer_invoices SET status = 'APPROVED' WHERE id = $1`, [invoiceId]);
    const posted = await api.post(`/api/ops/sales/invoices/${invoiceId}/post`).set(auth(admin)).send({});
    expect(posted.status).toBe(200);

    const receipt = await api.post('/api/ops/sales/receipts').set(auth(admin)).send({
      invoiceId,
      customerId: 1,
      amount: invoice.body.data.total,
      method: 'BANK_TRANSFER',
    });
    expect(receipt.status).toBe(200);

    const after = await api.get(`/api/ops/sales/invoices/${invoiceId}`).set(auth(admin));
    expect(after.status).toBe(200);
    expect(after.body.data.invoice.glPosted).toBe(true);
    expect(Number(after.body.data.invoice.amountPaid)).toBe(Number(invoice.body.data.total));

    const tb = await api.get('/api/ops/finance/trial-balance').set(auth(admin));
    expect(Math.round(Number(tb.body.data.totals.debit) * 100)).toBe(Math.round(Number(tb.body.data.totals.credit) * 100));
  });

  async function postedInvoice(token: string, admin: string, quantity: number): Promise<{ invoiceId: number; total: number; deliveryNoteId: number }> {
    const productId = await sku();
    const quoted = await api.post('/api/ops/sales/quotations').set(auth(token)).send({
      customerId: 1,
      items: [{ productId, quantity, unitPrice: 10000, taxPercent: 18 }],
    });
    expect(quoted.status).toBe(200);
    const quotationId = quoted.body.data.quotationId;
    await api.post(`/api/ops/sales/quotations/${quotationId}/submit`).set(auth(token)).send({});
    const converted = await api.post(`/api/ops/sales/quotations/${quotationId}/convert`).set(auth(token)).send({});
    const orderId = Number(converted.body.data.orderId);
    await db(`UPDATE sales_orders SET status = 'APPROVED' WHERE id = $1`, [orderId]);
    const stocked = await db(
      `UPDATE inventory SET quantity = GREATEST(quantity, 50)
       WHERE product_id = $1 AND batch_id IS NULL AND bin_id IS NULL
         AND warehouse_id = (SELECT w.id FROM warehouses w JOIN products p ON p.company_id = w.company_id WHERE p.id = $1 AND w.code = 'FG-WH' LIMIT 1)
       RETURNING id`,
      [productId]
    );
    if (stocked.rows.length === 0) {
      await db(
        `INSERT INTO inventory (company_id, tenant_id, product_id, warehouse_id, quantity, reserved_qty, avg_cost)
         SELECT p.company_id, p.tenant_id, p.id, w.id, 50, 0, 4000
         FROM products p
         JOIN warehouses w ON w.company_id = p.company_id AND w.code = 'FG-WH'
         WHERE p.id = $1`,
        [productId]
      );
    }
    const shipped = await api.post(`/api/ops/sales/orders/${orderId}/dispatch`).set(auth(token)).send({});
    expect(shipped.status).toBe(200);
    const invoice = await api.post('/api/ops/sales/invoices').set(auth(admin)).send({ orderId });
    expect(invoice.status).toBe(200);
    const invoiceId = Number(invoice.body.data.invoiceId);
    await db(`UPDATE customer_invoices SET status = 'APPROVED' WHERE id = $1`, [invoiceId]);
    const posted = await api.post(`/api/ops/sales/invoices/${invoiceId}/post`).set(auth(admin)).send({});
    expect(posted.status).toBe(200);
    return { invoiceId, total: Number(invoice.body.data.total), deliveryNoteId: Number(shipped.body.data.deliveryNoteId) };
  }

  it('allocates one receipt across two invoices and prints the branded slip', async () => {
    const { token } = await loginAs('sarah.sales');
    const { token: admin } = await loginAs('admin');
    const a = await postedInvoice(token, admin, 1);
    const b = await postedInvoice(token, admin, 1);
    const splitA = Math.round(a.total * 0.4 * 100) / 100;
    const splitB = Math.round(b.total * 0.4 * 100) / 100;
    const receipt = await api.post('/api/ops/sales/receipts').set(auth(admin)).send({
      customerId: 1,
      amount: splitA + splitB,
      method: 'BANK_TRANSFER',
      allocations: [
        { invoiceId: a.invoiceId, amount: splitA },
        { invoiceId: b.invoiceId, amount: splitB },
      ],
    });
    expect(receipt.status).toBe(200);
    expect(Number(receipt.body.data.unallocatedAmount)).toBe(0);

    const detail = await api.get(`/api/ops/sales/receipts/${receipt.body.data.receiptId}`).set(auth(admin));
    expect(detail.status).toBe(200);
    expect(detail.body.data.allocations.length).toBe(2);

    const invA = await api.get(`/api/ops/sales/invoices/${a.invoiceId}`).set(auth(admin));
    expect(Number(invA.body.data.invoice.amountPaid)).toBe(splitA);
    expect(invA.body.data.invoice.status).toBe('PARTIALLY_PAID');

    const pdf = await api.get(`/api/documents/receipt/${receipt.body.data.receiptId}?format=pdf`).set(auth(admin));
    expect(pdf.status).toBe(200);
    expect(Buffer.isBuffer(pdf.body) ? pdf.body.subarray(0, 5).toString('latin1') : Buffer.from(pdf.body).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const printed = await api.get(`/api/documents/receipt/${receipt.body.data.receiptId}?format=print`).set(auth(admin));
    expect(printed.status).toBe(200);
    expect(printed.text).toContain('Receipt');
    expect(printed.text).toContain('Allocations');
  }, 40_000);

  it('prints packing list and proof of delivery from a delivery note', async () => {
    const { token } = await loginAs('sarah.sales');
    const { token: admin } = await loginAs('admin');
    const posted = await postedInvoice(token, admin, 1);
    const packing = await api.get(`/api/documents/packing-list/${posted.deliveryNoteId}?format=print`).set(auth(admin));
    expect(packing.status).toBe(200);
    expect(packing.text).toContain('Packing List');
    expect(packing.text).toContain('Packed items');
    const pod = await api.get(`/api/documents/proof-of-delivery/${posted.deliveryNoteId}?format=print`).set(auth(admin));
    expect(pod.status).toBe(200);
    expect(pod.text).toContain('Proof of Delivery');
  }, 40_000);

  it('issues a debit note, posts AR, and prints the branded document', async () => {
    const { token } = await loginAs('sarah.sales');
    const { token: admin } = await loginAs('admin');
    const posted = await postedInvoice(token, admin, 1);
    const created = await api.post('/api/ops/sales/debit-notes').set(auth(admin)).send({
      customerId: 1,
      invoiceId: posted.invoiceId,
      amount: 25000,
      reason: 'Freight underbilled on dispatch',
      reasonCode: 'FREIGHT',
    });
    expect(created.status).toBe(200);
    expect(String(created.body.data.debitNo)).toMatch(/^DNM-/);
    const debitNoteId = Number(created.body.data.debitNoteId);
    await db(`UPDATE debit_notes SET status = 'APPROVED' WHERE id = $1`, [debitNoteId]);
    const gl = await api.post(`/api/ops/sales/debit-notes/${debitNoteId}/post`).set(auth(admin)).send({});
    expect(gl.status).toBe(200);
    const after = await api.get(`/api/ops/sales/invoices/${posted.invoiceId}`).set(auth(admin));
    expect(Number(after.body.data.invoice.total)).toBe(posted.total + 25000);
    const printed = await api.get(`/api/documents/debit-note/${debitNoteId}?format=print`).set(auth(admin));
    expect(printed.status).toBe(200);
    expect(printed.text).toContain('Debit Note');
    expect(printed.text).toMatch(/Freight/i);
    const cn = await api.post('/api/ops/sales/credit-notes').set(auth(admin)).send({
      customerId: 1,
      invoiceId: posted.invoiceId,
      amount: 1000,
      reason: 'Pricing correction',
      reasonCode: 'PRICING_CORRECTION',
    });
    expect(cn.status).toBe(200);
    const cnPrint = await api.get(`/api/documents/credit-note/${cn.body.data.creditNoteId}?format=print`).set(auth(admin));
    expect(cnPrint.status).toBe(200);
    expect(cnPrint.text).toContain('Credit Note');
  }, 40_000);

  it('blocks a quote when the account is credit-held and exposes the sales board', async () => {
    const { token } = await loginAs('sarah.sales');
    const held = await db(`SELECT id FROM customers WHERE status = 'BLOCKED' LIMIT 1`);
    if (held.rows.length) {
      const productId = await sku();
      const bad = await api.post('/api/ops/sales/quotations').set(auth(token)).send({
        customerId: Number(held.rows[0].id),
        items: [{ productId, quantity: 1, unitPrice: 10000 }],
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error.message).toMatch(/BLOCKED|Credit|cannot trade/i);
    }

    const board = await api.get('/api/ops/sales/board').set(auth(token));
    expect(board.status).toBe(200);
    expect(board.body.data.kpis).toBeTruthy();
    expect(Array.isArray(board.body.data.orders)).toBe(true);
  });

  it('creates a standalone manual invoice with bank details and a percentage discount', async () => {
    const { token } = await loginAs('admin');
    const create = await api.post('/api/ops/sales/invoices').set(auth(token)).send({
      customerId: 1,
      invoiceDate: '2026-08-20',
      dueDate: '2026-09-20',
      notes: 'Manual invoice',
      items: [{ productId: 3, quantity: 2, unitPrice: 1000, taxPercent: 18 }],
      bankName: 'Test Bank',
      bankAccountName: 'Acme Trading',
      bankAccountNumber: '0011223344',
      discountType: 'PERCENT',
      discountValue: 10,
    });
    expect(create.status).toBe(200);
    const invoiceId = Number(create.body.data.invoiceId);
    expect(invoiceId).toBeGreaterThan(0);

    const detail = await api.get(`/api/ops/sales/invoices/${invoiceId}`).set(auth(token));
    expect(detail.status).toBe(200);
    const inv = detail.body.data.invoice;
    expect(inv.orderId ?? inv.order_id ?? null).toBe(null);
    expect(String(inv.bankName ?? inv.bank_name)).toBe('Test Bank');
    expect(String(inv.bankAccountName ?? inv.bank_account_name)).toBe('Acme Trading');
    expect(String(inv.bankAccountNumber ?? inv.bank_account_number)).toBe('0011223344');
    expect(String(inv.discountType ?? inv.discount_type)).toBe('PERCENT');
    expect(Number(inv.discountValue ?? inv.discount_value)).toBe(10);
    expect(Number(inv.subtotal)).toBe(2000);
    expect(Number(inv.discountAmount ?? inv.discount_amount)).toBe(200);
    expect(Number(inv.taxAmount ?? inv.tax_amount)).toBe(324);
    expect(Number(inv.total)).toBe(2124);
    expect(detail.body.data.items.length).toBe(1);
    expect(Number(detail.body.data.items[0].quantity)).toBe(2);
    expect(Number(detail.body.data.items[0].productId ?? detail.body.data.items[0].product_id)).toBe(3);
  });

  it('creates a manual invoice with a fixed-amount discount and posts it to GL', async () => {
    const { token } = await loginAs('admin');
    const productId = await sku();
    const create = await api.post('/api/ops/sales/invoices').set(auth(token)).send({
      customerId: 1,
      items: [{ productId, quantity: 3, unitPrice: 5000, taxPercent: 18 }],
      discountType: 'AMOUNT',
      discountValue: 1000,
    });
    expect(create.status).toBe(200);
    const invoiceId = Number(create.body.data.invoiceId);

    const detail = await api.get(`/api/ops/sales/invoices/${invoiceId}`).set(auth(token));
    expect(Number(detail.body.data.invoice.subtotal)).toBe(15000);
    expect(Number(detail.body.data.invoice.discountAmount ?? detail.body.data.invoice.discount_amount)).toBe(1000);
    expect(Number(detail.body.data.invoice.taxAmount ?? detail.body.data.invoice.tax_amount)).toBe(2520);
    expect(Number(detail.body.data.invoice.total)).toBe(16520);

    await db(`UPDATE customer_invoices SET status = 'APPROVED' WHERE id = $1`, [invoiceId]);
    const posted = await api.post(`/api/ops/sales/invoices/${invoiceId}/post`).set(auth(token)).send({});
    expect(posted.status).toBe(200);
    const after = await api.get(`/api/ops/sales/invoices/${invoiceId}`).set(auth(token));
    expect(after.body.data.invoice.glPosted).toBe(true);
    expect(after.body.data.invoice.status).toBe('POSTED');
  });
});
