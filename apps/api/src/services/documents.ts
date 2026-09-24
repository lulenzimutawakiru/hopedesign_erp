import pg from 'pg';
import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import { Ctx } from '../db.js';
import { notFound } from '../utils.js';
import * as sales from './sales.js';
import * as procurement from './procurement.js';
import * as finance from './finance.js';
import * as contracts from './contracts.js';
import { readEmployeePhotoFile } from './hr.js';
import { PdfDoc, PdfTableColumn, PdfTextStyle, textWidth, wrapText, PAGE_W, PAGE_H, MARGIN, BOTTOM, Rgb } from './pdf.js';
import QRCode from 'qrcode';
import {
  BRAND,
  applyExcelBrandFooter,
  CompanyProfile,
  brandHex,
  applyExcelBrandHeader,
  companyContactLines,
  companyRegLines,
  documentFingerprint,
  documentVerifyUrl,
  issueDocumentToken,
  loadCompanyProfile,
  formatDocDate,
  formatDocDateTime,
  formatDocStatus,
  renderBrandedHtml,
} from './branding.js';
import {
  brandingAssetParams,
  brandOf,
  drawFacts,
  drawLetterhead,
  drawRunningHeader,
  excelBrandImages,
  excelNumFmt,
  preloadFooterLogo,
  brandImageWidth,
  preloadLogo,
  preloadSecondaryLogo,
  readStoredBrandingFile,
  toExcelValue,
  type DocBrand,
  type LetterheadMeta,
} from './brandedExport.js';

/**
 * Generic business-document export layer.
 * Every document type normalizes its data into a DocData shape which is then
 * rendered to PDF / Excel / CSV / JSON with a consistent layout.
 */

export interface DocParty {
  heading: string;
  name: string;
  lines: string[];
}

export interface DocSignature {
  label: string;
  name?: string;
  /** Title/role shown under the signatory name (e.g. Managing Director). */
  role?: string;
  /** When present, the block renders as an executed signature with this date. */
  signedAt?: string;
  /** True when the signature was filled automatically from company settings. */
  auto?: boolean;
  /** Public URL of the uploaded signature image (rendered when available). */
  signatureUrl?: string;
}

export interface DocData {
  code: string;
  title: string;
  subtitle?: string;
  kicker?: string;
  currency?: string;
  status?: string;
  parties?: DocParty[];
  facts?: Array<[string, string]>;
  signatures?: DocSignature[];
  meta: Array<[string, string]>;
  columns: PdfTableColumn[];
  items: Array<Record<string, unknown>>;
  totals: Array<[string, string]>;
  notes: string[];
  /** Payslip-only: lines showing how Net Pay is derived (Gross Pay minus deductions). */
  payBreakdown?: Array<[string, string]>;
  /** Payslip-only: PAYE bracket table and explanatory note used for the period. */
  payeBrackets?: { bands: Array<[string, string]>; note?: string };
  raw: unknown;
  isContract?: boolean;
  isCertificate?: boolean;
  isIdCard?: boolean;
  isPayslip?: boolean;
  classification?: string;
  photo?: { bytes: Buffer; mime: string; dataUrl: string; caption?: string };
  qrPng?: Buffer;
  qrToken?: string;
}

export interface DocumentTypeDef {
  type: string;
  label: string;
  permission: string;
  load: (client: pg.PoolClient, ctx: Ctx, id: number) => Promise<DocData>;
}

const num = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const money = (v: unknown): string =>
  num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyCcy = (v: unknown, ccy?: string): string =>
  `${ccy ? `${ccy} ` : ''}${money(v)}`;
const qty = (v: unknown): string =>
  num(v).toLocaleString('en-US', { maximumFractionDigits: 4 });
const pct = (v: unknown): string => (num(v) === 0 ? '' : `${num(v)}%`);
const dateOnly = (v: unknown): string => formatDocDate(v);
const str = (v: unknown): string => (v == null || v === '' ? '' : String(v));
const yesNo = (v: unknown): string => (v ? 'Yes' : 'No');
const lines = (...vals: Array<unknown>): string[] =>
  vals.filter((v): v is string => v != null && String(v).trim() !== '').map((v) => String(v));
const statusLabel = (v: unknown): string => formatDocStatus(v);
const bankLines = (rec: Record<string, unknown>): string[] => {
  const name = str(pick(rec, 'bankName', 'bank_name'));
  const accountName = str(pick(rec, 'bankAccountName', 'bank_account_name'));
  const accountNumber = str(pick(rec, 'bankAccountNumber', 'bank_account_number'));
  if (!name && !accountName && !accountNumber) return [];
  return lines(
    name ? `Bank: ${name}` : '',
    accountName ? `Account Name: ${accountName}` : '',
    accountNumber ? `Account No: ${accountNumber}` : '',
  );
};
const discountLabel = (rec: Record<string, unknown>): string => {
  const type = str(pick(rec, 'discountType', 'discount_type'));
  const value = num(pick(rec, 'discountValue', 'discount_value'));
  if (type === 'PERCENT' && value > 0) return `Discount (${value}%)`;
  return 'Discount';
};
const maskAccount = (v: unknown): string => {
  const s = str(v).replace(/\s+/g, '');
  if (!s) return '';
  if (s.length <= 4) return '****';
  return `****${s.slice(-4)}`;
};

function customerParties(rec: Record<string, unknown>): DocParty[] {
  const name = str(pick(rec, 'customerName', 'customer_name'));
  if (!name) return [];
  const code = str(pick(rec, 'customerCode', 'customer_code'));
  const bill =
    str(pick(rec, 'customerBillingAddress', 'customer_billing_address')) ||
    str(pick(rec, 'customerAddress', 'customer_address', 'address'));
  const ship = str(pick(rec, 'customerShippingAddress', 'customer_shipping_address'));
  const contact = [str(pick(rec, 'customerPhone')), str(pick(rec, 'customerEmail'))]
    .filter(Boolean)
    .join('  ·  ');
  const tax = [str(pick(rec, 'customerTin')) && `TIN ${str(pick(rec, 'customerTin'))}`, str(pick(rec, 'customerVrn')) && `VRN ${str(pick(rec, 'customerVrn'))}`]
    .filter(Boolean)
    .join('  ·  ');
  const billTo: DocParty = {
    heading: 'Bill To',
    name,
    lines: lines(code ? `Account ${code}` : '', bill, contact, tax),
  };
  if (ship && ship !== bill) {
    return [billTo, { heading: 'Ship To', name, lines: lines(ship, contact) }];
  }
  return [billTo];
}

function supplierParty(rec: Record<string, unknown>, heading = 'Supplier'): DocParty | null {
  const name = str(pick(rec, 'supplierName', 'supplier_name'));
  if (!name) return null;
  const code = str(pick(rec, 'supplierCode', 'supplier_code'));
  const contact = [str(pick(rec, 'supplierPhone')), str(pick(rec, 'supplierEmail'))]
    .filter(Boolean)
    .join('  ·  ');
  const tax = [str(pick(rec, 'supplierTin')) && `TIN ${str(pick(rec, 'supplierTin'))}`, str(pick(rec, 'supplierVrn')) && `VRN ${str(pick(rec, 'supplierVrn'))}`]
    .filter(Boolean)
    .join('  ·  ');
  return {
    heading,
    name,
    lines: lines(
      code ? `Account ${code}` : '',
      pick(rec, 'supplierAddress', 'supplier_address', 'address'),
      contact,
      tax,
      pick(rec, 'supplierWebsite', 'supplier_website')
    ),
  };
}

function paymentTerms(rec: Record<string, unknown>): string {
  const days = num(pick(rec, 'customerPaymentTermsDays', 'paymentTermsDays', 'payment_terms_days'));
  if (!days) return '';
  return days === 1 ? 'Net 1 day' : `Net ${days} days`;
}

const pick = (v: Record<string, unknown> | null | undefined, ...keys: string[]): unknown => {
  if (!v) return undefined;
  for (const k of keys) {
    const val = v[k];
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
};

async function loadQuotation(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await sales.getQuotation(client, ctx, id);
  const q = out.quotation as Record<string, unknown>;
  const items = (out.items ?? []) as Array<Record<string, unknown>>;
  const customerName = str(pick(q, 'customerName', 'customer_name'));
  const customerCode = str(pick(q, 'customerCode', 'customer_code'));
  const currency = str(pick(q, 'currency')) || 'UGX';
  const status = statusLabel(pick(q, 'status'));
  return {
    code: str(pick(q, 'quotationNo', 'quotation_no')),
    title: 'Quotation',
    kicker: 'Sales document',
    currency,
    status,
    parties: customerParties(q),
    facts: [
      ['Date', dateOnly(pick(q, 'quotationDate', 'quotation_date'))],
      ['Valid Until', dateOnly(pick(q, 'validUntil', 'valid_until'))],
      ['Currency', currency],
      ['Revision', str(pick(q, 'revision'))],
      ['Payment Terms', paymentTerms(q)],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Prepared by' },
      { label: 'Authorised by' },
      { label: 'Customer acceptance' },
    ],
    subtitle: customerName ? `${customerName}${customerCode ? `  ·  ${customerCode}` : ''}` : undefined,
    meta: [
      ['Quotation No', str(pick(q, 'quotationNo', 'quotation_no'))],
      ['Revision', str(pick(q, 'revision'))],
      ['Date', dateOnly(pick(q, 'quotationDate', 'quotation_date'))],
      ['Valid Until', dateOnly(pick(q, 'validUntil', 'valid_until'))],
      ['Customer', customerName],
      ['Currency', currency],
      ['Status', status],
      ['Approved', pick(q, 'approvedAt', 'approved_at') ? 'Yes' : 'No'],
    ],
    columns: [
      { key: 'productCode', label: 'Product Code', weight: 1.5 },
      { key: 'productName', label: 'Product / Description', weight: 2.6 },
      { key: 'quantity', label: 'Qty', align: 'right', weight: 0.9 },
      { key: 'unitPrice', label: 'Unit Price', align: 'right', weight: 1.1 },
      { key: 'discountPercent', label: 'Disc %', align: 'right', weight: 0.8 },
      { key: 'taxPercent', label: 'Tax %', align: 'right', weight: 0.8 },
      { key: 'lineTotal', label: 'Line Total', align: 'right', weight: 1.2 },
    ],
    items: items.map((it) => ({
      productCode: str(pick(it, 'productCode', 'product_code')),
      productName: str(pick(it, 'productName', 'product_name', 'description')),
      quantity: qty(pick(it, 'quantity')),
      unitPrice: money(pick(it, 'unitPrice', 'unit_price')),
      discountPercent: pct(pick(it, 'discountPercent', 'discount_percent')),
      taxPercent: pct(pick(it, 'taxPercent', 'tax_percent')),
      lineTotal: money(pick(it, 'lineTotal', 'line_total')),
    })),
    totals: [
      ['Subtotal', money(pick(q, 'subtotal'))],
      ['Discount', money(pick(q, 'discountAmount', 'discount_amount'))],
      ['Tax', money(pick(q, 'taxAmount', 'tax_amount'))],
      ['Total', moneyCcy(pick(q, 'total'), currency)],
    ],
    notes: lines(pick(q, 'terms'), pick(q, 'notes')),
    raw: out,
  };
}

async function loadSalesOrder(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await sales.getSalesOrder(client, ctx, id);
  const o = out.order as Record<string, unknown>;
  const items = (out.items ?? []) as Array<Record<string, unknown>>;
  const customerName = str(pick(o, 'customerName', 'customer_name'));
  const customerCode = str(pick(o, 'customerCode', 'customer_code'));
  const currency = str(pick(o, 'currency')) || 'UGX';
  const status = statusLabel(pick(o, 'status'));
  return {
    code: str(pick(o, 'orderNo', 'order_no')),
    title: 'Sales Order',
    kicker: 'Sales document',
    currency,
    status,
    parties: customerParties(o),
    facts: [
      ['Order Date', dateOnly(pick(o, 'orderDate', 'order_date'))],
      ['Requested Date', dateOnly(pick(o, 'requestedDate', 'requested_date'))],
      ['Delivery Date', dateOnly(pick(o, 'deliveryDate', 'delivery_date'))],
      ['Customer PO', str(pick(o, 'customerPoNo', 'customer_po_no'))],
      ['Quotation', str(pick(o, 'quotationNo', 'quotation_no'))],
      ['Currency', currency],
      ['Payment Terms', paymentTerms(o)],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Prepared by' },
      { label: 'Authorised by' },
      { label: 'Customer acknowledgement' },
    ],
    subtitle: customerName ? `${customerName}${customerCode ? `  ·  ${customerCode}` : ''}` : undefined,
    meta: [
      ['Order No', str(pick(o, 'orderNo', 'order_no'))],
      ['Order Date', dateOnly(pick(o, 'orderDate', 'order_date'))],
      ['Requested Date', dateOnly(pick(o, 'requestedDate', 'requested_date'))],
      ['Delivery Date', dateOnly(pick(o, 'deliveryDate', 'delivery_date'))],
      ['Customer PO', str(pick(o, 'customerPoNo', 'customer_po_no'))],
      ['Quotation', str(pick(o, 'quotationNo', 'quotation_no'))],
      ['Currency', currency],
      ['Status', status],
    ],
    columns: [
      { key: 'productCode', label: 'Product Code', weight: 1.5 },
      { key: 'productName', label: 'Product / Description', weight: 2.4 },
      { key: 'quantity', label: 'Qty', align: 'right', weight: 0.9 },
      { key: 'allocatedQty', label: 'Allocated', align: 'right', weight: 0.9 },
      { key: 'unitPrice', label: 'Unit Price', align: 'right', weight: 1.1 },
      { key: 'taxPercent', label: 'Tax %', align: 'right', weight: 0.8 },
      { key: 'lineTotal', label: 'Line Total', align: 'right', weight: 1.2 },
    ],
    items: items.map((it) => ({
      productCode: str(pick(it, 'productCode', 'product_code')),
      productName: str(pick(it, 'productName', 'product_name', 'description')),
      quantity: qty(pick(it, 'quantity')),
      allocatedQty: qty(pick(it, 'allocatedQty', 'allocated_qty')),
      unitPrice: money(pick(it, 'unitPrice', 'unit_price')),
      taxPercent: pct(pick(it, 'taxPercent', 'tax_percent')),
      lineTotal: money(pick(it, 'lineTotal', 'line_total')),
    })),
    totals: [
      ['Subtotal', money(pick(o, 'subtotal'))],
      [discountLabel(o), money(pick(o, 'discountAmount', 'discount_amount'))],
      ['Tax', money(pick(o, 'taxAmount', 'tax_amount'))],
      ['Total', moneyCcy(pick(o, 'total'), currency)],
    ],
    notes: lines(pick(o, 'notes'), ...bankLines(o)),
    raw: out,
  };
}

async function loadSalesInvoice(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await sales.getInvoice(client, ctx, id);
  const inv = out.invoice as Record<string, unknown>;
  const items = (out.items ?? []) as Array<Record<string, unknown>>;
  const total = num(pick(inv, 'total'));
  const paid = num(pick(inv, 'amountPaid', 'amount_paid'));
  const customerName = str(pick(inv, 'customerName', 'customer_name'));
  const customerCode = str(pick(inv, 'customerCode', 'customer_code'));
  const currency = str(pick(inv, 'currency')) || 'UGX';
  const status = statusLabel(pick(inv, 'status'));
  return {
    code: str(pick(inv, 'invoiceNo', 'invoice_no')),
    title: 'Tax Invoice',
    kicker: 'Sales document',
    currency,
    status,
    parties: customerParties(inv),
    facts: [
      ['Invoice Date', dateOnly(pick(inv, 'invoiceDate', 'invoice_date'))],
      ['Due Date', dateOnly(pick(inv, 'dueDate', 'due_date'))],
      ['Order No', str(pick(inv, 'orderNo', 'order_no'))],
      ['Delivery Note', str(pick(inv, 'deliveryNo', 'delivery_no'))],
      ['Currency', currency],
      ['Payment Terms', paymentTerms(inv)],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Prepared by' },
      { label: 'Authorised by' },
      { label: 'Received by' },
    ],
    subtitle: customerName ? `${customerName}${customerCode ? `  ·  ${customerCode}` : ''}` : undefined,
    meta: [
      ['Invoice No', str(pick(inv, 'invoiceNo', 'invoice_no'))],
      ['Invoice Date', dateOnly(pick(inv, 'invoiceDate', 'invoice_date'))],
      ['Due Date', dateOnly(pick(inv, 'dueDate', 'due_date'))],
      ['Order No', str(pick(inv, 'orderNo', 'order_no'))],
      ['Delivery Note', str(pick(inv, 'deliveryNo', 'delivery_no'))],
      ['Currency', currency],
      ['Status', status],
      ['GL Posted', yesNo(pick(inv, 'glPosted', 'gl_posted'))],
    ],
    columns: [
      { key: 'productCode', label: 'Product Code', weight: 1.5 },
      { key: 'productName', label: 'Product / Description', weight: 2.6 },
      { key: 'quantity', label: 'Qty', align: 'right', weight: 0.9 },
      { key: 'unitPrice', label: 'Unit Price', align: 'right', weight: 1.1 },
      { key: 'taxPercent', label: 'Tax %', align: 'right', weight: 0.8 },
      { key: 'lineTotal', label: 'Line Total', align: 'right', weight: 1.2 },
    ],
    items: items.map((it) => ({
      productCode: str(pick(it, 'productCode', 'product_code')),
      productName: str(pick(it, 'productName', 'product_name', 'description')),
      quantity: qty(pick(it, 'quantity')),
      unitPrice: money(pick(it, 'unitPrice', 'unit_price')),
      taxPercent: pct(pick(it, 'taxPercent', 'tax_percent')),
      lineTotal: money(pick(it, 'lineTotal', 'line_total')),
    })),
    totals: [
      ['Subtotal', money(pick(inv, 'subtotal'))],
      [discountLabel(inv), money(pick(inv, 'discountAmount', 'discount_amount'))],
      ['Tax', money(pick(inv, 'taxAmount', 'tax_amount'))],
      ['Total', moneyCcy(total, currency)],
      ['Amount Paid', money(paid)],
      ['Balance Due', moneyCcy(total - paid, currency)],
    ],
    notes: lines(pick(inv, 'notes'), ...bankLines(inv)),
    raw: out,
  };
}

async function loadDeliveryLayout(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  kind: 'note' | 'packing' | 'pod'
): Promise<DocData> {
  const out = await sales.getDeliveryNote(client, ctx, id);
  const dn = out.deliveryNote as Record<string, unknown>;
  const items = (out.items ?? []) as Array<Record<string, unknown>>;
  const status = statusLabel(pick(dn, 'status'));
  const customerName = str(pick(dn, 'customerName', 'customer_name'));
  const title = kind === 'packing' ? 'Packing List' : kind === 'pod' ? 'Proof of Delivery' : 'Delivery Note';
  const kicker = kind === 'pod' ? 'Delivery confirmation' : 'Logistics document';
  const signatures =
    kind === 'pod'
      ? [
          { label: 'Customer signature', name: str(pick(dn, 'receivedBy', 'received_by', 'recipientName', 'recipient_name')) },
          { label: 'Driver signature', name: str(pick(dn, 'driverName', 'driver_name')) },
          { label: 'Warehouse signature' },
        ]
      : [
          { label: 'Dispatched by' },
          { label: 'Received by', name: str(pick(dn, 'receivedBy', 'received_by', 'recipientName', 'recipient_name')) },
          { label: 'Date' },
        ];
  const columns =
    kind === 'packing'
      ? [
          { key: 'productCode', label: 'SKU', weight: 1.4 },
          { key: 'productName', label: 'Product', weight: 2.6 },
          { key: 'batchNo', label: 'Batch / Lot', weight: 1.4 },
          { key: 'quantity', label: 'Qty', align: 'right' as const, weight: 0.9 },
          { key: 'packages', label: 'Packages', align: 'right' as const, weight: 0.9 },
        ]
      : [
          { key: 'productCode', label: 'Product Code', weight: 1.5 },
          { key: 'productName', label: 'Product / Description', weight: 2.8 },
          { key: 'batchNo', label: 'Batch / Lot', weight: 1.4 },
          { key: 'quantity', label: 'Qty', align: 'right' as const, weight: 1.1 },
        ];
  return {
    code: str(pick(dn, 'deliveryNo', 'delivery_no')),
    title,
    kicker,
    status,
    parties: customerParties(dn),
    facts: [
      ['Order No', str(pick(dn, 'orderNo', 'order_no'))],
      ['Dispatch Date', dateOnly(pick(dn, 'dispatchDate', 'dispatch_date'))],
      ['Delivered', pick(dn, 'deliveredAt', 'delivered_at') ? formatDocDateTime(pick(dn, 'deliveredAt', 'delivered_at')) : ''],
      ['Warehouse', str(pick(dn, 'warehouseName', 'warehouse_name'))],
      ['Driver', str(pick(dn, 'driverName', 'driver_name'))],
      ['Vehicle', lines(pick(dn, 'vehiclePlate', 'vehicle_plate'), pick(dn, 'vehicleCode', 'vehicle_code')).join('  ')],
      ['Recipient', str(pick(dn, 'recipientName', 'recipient_name'))],
      ['Recipient Phone', str(pick(dn, 'recipientPhone', 'recipient_phone'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures,
    subtitle: customerName || undefined,
    meta: [
      ['Document No', str(pick(dn, 'deliveryNo', 'delivery_no'))],
      ['Order No', str(pick(dn, 'orderNo', 'order_no'))],
      ['Status', status],
      ['Dispatch Date', dateOnly(pick(dn, 'dispatchDate', 'dispatch_date'))],
    ],
    columns,
    items: items.map((it) => ({
      productCode: str(pick(it, 'productCode', 'product_code')),
      productName: str(pick(it, 'productName', 'product_name')),
      batchNo: str(pick(it, 'batchNo', 'batch_no', 'lotNo', 'lot_no')),
      quantity: qty(pick(it, 'quantity')),
      packages: qty(pick(it, 'quantity')),
    })),
    totals: [['Items', String(items.length)], ['Total Qty', qty(items.reduce((s, it) => s + num(pick(it, 'quantity')), 0))]],
    notes: lines(pick(dn, 'notes'), kind === 'pod' ? 'Customer confirmation of goods received in good order unless remarks are recorded above.' : ''),
    raw: out,
  };
}

async function loadDeliveryNote(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  return loadDeliveryLayout(client, ctx, id, 'note');
}

async function loadPackingList(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  return loadDeliveryLayout(client, ctx, id, 'packing');
}

async function loadProofOfDelivery(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  return loadDeliveryLayout(client, ctx, id, 'pod');
}

async function loadReceipt(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await sales.getReceipt(client, ctx, id);
  const r = out.receipt as Record<string, unknown>;
  const allocations = (out.allocations ?? []) as Array<Record<string, unknown>>;
  const currency = 'UGX';
  const status = statusLabel(pick(r, 'status'));
  const amount = num(pick(r, 'amount'));
  const unallocated = num(pick(r, 'unallocatedAmount', 'unallocated_amount'));
  return {
    code: str(pick(r, 'receiptNo', 'receipt_no')),
    title: 'Receipt',
    kicker: 'Sales document',
    currency,
    status,
    parties: customerParties(r),
    facts: [
      ['Receipt Date', dateOnly(pick(r, 'receiptDate', 'receipt_date'))],
      ['Payment Method', statusLabel(pick(r, 'method'))],
      ['Reference', str(pick(r, 'reference'))],
      ['Invoice', str(pick(r, 'invoiceNo', 'invoice_no'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Received by' },
      { label: 'Customer acknowledgement' },
    ],
    subtitle: str(pick(r, 'customerName', 'customer_name')) || undefined,
    meta: [
      ['Receipt No', str(pick(r, 'receiptNo', 'receipt_no'))],
      ['Receipt Date', dateOnly(pick(r, 'receiptDate', 'receipt_date'))],
      ['Method', str(pick(r, 'method'))],
      ['Status', status],
    ],
    columns: [
      { key: 'invoiceNo', label: 'Invoice', weight: 2 },
      { key: 'invoiceStatus', label: 'Invoice Status', weight: 1.4 },
      { key: 'invoiceTotal', label: 'Invoice Total', align: 'right', weight: 1.4 },
      { key: 'amount', label: 'Allocated', align: 'right', weight: 1.4 },
    ],
    items: allocations.map((a) => ({
      invoiceNo: str(pick(a, 'invoiceNo', 'invoice_no')),
      invoiceStatus: statusLabel(pick(a, 'invoiceStatus', 'invoice_status')),
      invoiceTotal: money(pick(a, 'total')),
      amount: money(pick(a, 'amount')),
    })),
    totals: [
      ['Amount Received', moneyCcy(amount, currency)],
      ['Allocated', money(amount - unallocated)],
      ['Unallocated / credit', moneyCcy(unallocated, currency)],
    ],
    notes: lines(pick(r, 'description'), 'This receipt is an acknowledgement of payment received. It is not a tax invoice.'),
    raw: out,
  };
}

async function loadCreditNote(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await sales.getCreditNote(client, ctx, id);
  const cn = out.creditNote as Record<string, unknown>;
  const currency = 'UGX';
  const status = statusLabel(pick(cn, 'status'));
  const amount = num(pick(cn, 'amount'));
  return {
    code: str(pick(cn, 'creditNo', 'credit_no')),
    title: 'Credit Note',
    kicker: 'Sales document',
    currency,
    status,
    parties: customerParties(cn),
    facts: [
      ['Credit Date', dateOnly(pick(cn, 'creditDate', 'credit_date'))],
      ['Invoice', str(pick(cn, 'invoiceNo', 'invoice_no'))],
      ['Reason', statusLabel(pick(cn, 'reasonCode', 'reason_code')) || str(pick(cn, 'reason'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [{ label: 'Prepared by' }, { label: 'Authorised by' }],
    subtitle: str(pick(cn, 'customerName', 'customer_name')) || undefined,
    meta: [
      ['Credit No', str(pick(cn, 'creditNo', 'credit_no'))],
      ['Invoice', str(pick(cn, 'invoiceNo', 'invoice_no'))],
      ['Status', status],
    ],
    columns: [
      { key: 'description', label: 'Description', weight: 4 },
      { key: 'amount', label: 'Amount', align: 'right', weight: 1.4 },
    ],
    items: [{ description: str(pick(cn, 'reason')) || 'Credit adjustment', amount: money(amount) }],
    totals: [['Credit Amount', moneyCcy(amount, currency)]],
    notes: lines(pick(cn, 'reason'), 'This credit note reduces the customer balance. It is issued after approval and posts to the ledger.'),
    raw: out,
  };
}

async function loadDebitNote(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await sales.getDebitNote(client, ctx, id);
  const dn = out.debitNote as Record<string, unknown>;
  const currency = 'UGX';
  const status = statusLabel(pick(dn, 'status'));
  const amount = num(pick(dn, 'amount'));
  return {
    code: str(pick(dn, 'debitNo', 'debit_no')),
    title: 'Debit Note',
    kicker: 'Sales document',
    currency,
    status,
    parties: customerParties(dn),
    facts: [
      ['Debit Date', dateOnly(pick(dn, 'debitDate', 'debit_date'))],
      ['Invoice', str(pick(dn, 'invoiceNo', 'invoice_no'))],
      ['Reason', statusLabel(pick(dn, 'reasonCode', 'reason_code'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [{ label: 'Prepared by' }, { label: 'Authorised by' }],
    subtitle: str(pick(dn, 'customerName', 'customer_name')) || undefined,
    meta: [
      ['Debit No', str(pick(dn, 'debitNo', 'debit_no'))],
      ['Invoice', str(pick(dn, 'invoiceNo', 'invoice_no'))],
      ['Status', status],
    ],
    columns: [
      { key: 'description', label: 'Description', weight: 4 },
      { key: 'amount', label: 'Amount', align: 'right', weight: 1.4 },
    ],
    items: [{ description: str(pick(dn, 'reason')) || 'Additional charge', amount: money(amount) }],
    totals: [['Debit Amount', moneyCcy(amount, currency)]],
    notes: lines(pick(dn, 'reason'), 'This debit note increases the amount payable by the customer after approval.'),
    raw: out,
  };
}

async function loadSalesReturn(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await sales.getSalesReturn(client, ctx, id);
  const ret = out.salesReturn as Record<string, unknown>;
  const items = (out.items ?? []) as Array<Record<string, unknown>>;
  const status = statusLabel(pick(ret, 'status'));
  return {
    code: str(pick(ret, 'returnNo', 'return_no')),
    title: 'Returned Goods Note',
    kicker: 'Sales document',
    status,
    parties: customerParties(ret),
    facts: [
      ['Return Date', dateOnly(pick(ret, 'returnDate', 'return_date'))],
      ['Order No', str(pick(ret, 'orderNo', 'order_no'))],
      ['Delivery Note', str(pick(ret, 'deliveryNo', 'delivery_no'))],
      ['Reason', str(pick(ret, 'reason'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Inspected by' },
      { label: 'Warehouse' },
      { label: 'Customer' },
    ],
    subtitle: str(pick(ret, 'customerName', 'customer_name')) || undefined,
    meta: [
      ['Return No', str(pick(ret, 'returnNo', 'return_no'))],
      ['Order No', str(pick(ret, 'orderNo', 'order_no'))],
      ['Status', status],
    ],
    columns: [
      { key: 'productCode', label: 'Product Code', weight: 1.4 },
      { key: 'productName', label: 'Product', weight: 2.4 },
      { key: 'batchNo', label: 'Batch / Lot', weight: 1.4 },
      { key: 'condition', label: 'Condition', weight: 1.4 },
      { key: 'quantity', label: 'Qty', align: 'right', weight: 1 },
    ],
    items: items.map((it) => ({
      productCode: str(pick(it, 'productCode', 'product_code')),
      productName: str(pick(it, 'productName', 'product_name')),
      batchNo: str(pick(it, 'batchNo', 'batch_no')),
      condition: statusLabel(pick(it, 'condition')),
      quantity: qty(pick(it, 'quantity')),
    })),
    totals: [['Items', String(items.length)], ['Total Qty', qty(items.reduce((s, it) => s + num(pick(it, 'quantity')), 0))]],
    notes: lines(pick(ret, 'reason'), pick(ret, 'qcResult', 'qc_result')),
    raw: out,
  };
}

async function loadRequisition(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await procurement.getRequisition(client, ctx, id);
  const r = out.requisition as Record<string, unknown>;
  const items = (out.items ?? []) as Array<Record<string, unknown>>;
  const status = statusLabel(pick(r, 'status'));
  const requestedBy = str(pick(r, 'requestedByName', 'requested_by_name'));
  const dept = str(pick(r, 'departmentName', 'department_name')) || str(pick(r, 'departmentCode', 'department_code'));
  return {
    code: str(pick(r, 'prNo', 'pr_no')),
    title: 'Purchase Requisition',
    kicker: 'Procurement document',
    status,
    facts: [
      ['Requested By', requestedBy],
      ['Requested Date', dateOnly(pick(r, 'requestedDate', 'requested_date'))],
      ['Required Date', dateOnly(pick(r, 'requiredDate', 'required_date'))],
      ['Department', dept],
      ['Budget Code', str(pick(r, 'budgetCode', 'budget_code'))],
      ['Cost Centre', str(pick(r, 'costCentreName', 'cost_centre_name', 'costCentreCode', 'cost_centre_code'))],
      ['Currency', str(pick(r, 'currencyCode', 'currency_code', 'currency'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Requested by', name: requestedBy },
      { label: 'Budget holder' },
      { label: 'Authorised by' },
    ],
    subtitle: requestedBy ? `Requested by ${requestedBy}` : undefined,
    meta: [
      ['PR No', str(pick(r, 'prNo', 'pr_no'))],
      ['Requested By', requestedBy],
      ['Requested Date', dateOnly(pick(r, 'requestedDate', 'requested_date'))],
      ['Required Date', dateOnly(pick(r, 'requiredDate', 'required_date'))],
      ['Budget Code', str(pick(r, 'budgetCode', 'budget_code'))],
      ['Budget Validated', yesNo(pick(r, 'budgetValidated', 'budget_validated'))],
      ['Status', status],
      ['Tax', str(pick(r, 'taxCode', 'tax_code'))],
      ['Discount Rate', str(pick(r, 'discountRate', 'discount_rate'))],
      ['Delivery Cost', money(pick(r, 'deliveryCost', 'delivery_cost'))],
      ['Department', dept],
    ],
    columns: [
      { key: 'productCode', label: 'Product Code', weight: 1.5 },
      { key: 'productName', label: 'Product', weight: 2.2 },
      { key: 'quantity', label: 'Qty', align: 'right', weight: 0.9 },
      { key: 'estimatedCost', label: 'Est. Cost', align: 'right', weight: 1.1 },
      { key: 'discountPercent', label: 'Disc %', align: 'right', weight: 0.8 },
      { key: 'taxPercent', label: 'Tax %', align: 'right', weight: 0.8 },
      { key: 'lineTotal', label: 'Line Total', align: 'right', weight: 1.2 },
      { key: 'needBy', label: 'Need By', weight: 1.0 },
      { key: 'suggestedSupplier', label: 'Suggested Supplier', weight: 1.6 },
    ],
    items: items.map((it) => ({
      productCode: str(pick(it, 'productCode', 'product_code')),
      productName: str(pick(it, 'productName', 'product_name')),
      quantity: qty(pick(it, 'quantity')),
      estimatedCost: money(pick(it, 'estimatedCost', 'estimated_cost')),
      discountPercent: pct(pick(it, 'discountPercent', 'discount_percent')),
      taxPercent: pct(pick(it, 'taxRate', 'tax_rate')),
      lineTotal: money(pick(it, 'lineTotal', 'line_total')),
      needBy: dateOnly(pick(it, 'needBy', 'need_by')),
      suggestedSupplier: str(pick(it, 'suggestedSupplier', 'suggested_supplier', 'supplierCode', 'supplier_code')),
    })),
    totals: [
      ['Subtotal', money(items.reduce((s, it) => s + num(pick(it, 'estimatedCost', 'estimated_cost')) * num(pick(it, 'quantity')), 0))],
      ['Discount', money(items.reduce((s, it) => s + num(pick(it, 'discountAmount', 'discount_amount')), 0))],
      ['Tax', money(items.reduce((s, it) => s + num(pick(it, 'taxAmount', 'tax_amount')), 0))],
      ['Delivery Cost', money(pick(r, 'deliveryCost', 'delivery_cost'))],
      ['Estimated Total', money(num(pick(r, 'totalEstimated', 'total_estimated')) || items.reduce((s, it) => s + num(pick(it, 'lineTotal', 'line_total')), 0))],
    ],
    notes: lines(pick(r, 'notes')),
    raw: out,
  };
}

async function loadRfq(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await procurement.getRfq(client, ctx, id);
  const r = out.rfq as Record<string, unknown>;
  const items = (out.items ?? []) as Array<Record<string, unknown>>;
  const suppliers = (out.suppliers ?? []) as Array<Record<string, unknown>>;
  const status = statusLabel(pick(r, 'status'));
  return {
    code: str(pick(r, 'rfqNo', 'rfq_no')),
    title: 'Request for Quotation',
    kicker: 'Procurement document',
    status,
    facts: [
      ['Issue Date', dateOnly(pick(r, 'issueDate', 'issue_date'))],
      ['Closing Date', dateOnly(pick(r, 'closingDate', 'closing_date'))],
      ['Suppliers Invited', String(suppliers.length)],
      ['Quotations Received', String((out.quotations ?? []).length)],
    ],
    signatures: [
      { label: 'Prepared by' },
      { label: 'Authorised by' },
      { label: 'Procurement officer' },
    ],
    meta: [
      ['RFQ No', str(pick(r, 'rfqNo', 'rfq_no'))],
      ['Issue Date', dateOnly(pick(r, 'issueDate', 'issue_date'))],
      ['Closing Date', dateOnly(pick(r, 'closingDate', 'closing_date'))],
      ['Status', status],
      ['Suppliers', String(suppliers.length)],
      ['Quotations Received', String((out.quotations ?? []).length)],
    ],
    columns: [
      { key: 'productCode', label: 'Product Code', weight: 1.5 },
      { key: 'productName', label: 'Product', weight: 2.6 },
      { key: 'quantity', label: 'Qty', align: 'right', weight: 0.9 },
      { key: 'targetPrice', label: 'Target Price', align: 'right', weight: 1.1 },
      { key: 'notes', label: 'Notes', weight: 1.6 },
    ],
    items: items.map((it) => ({
      productCode: str(pick(it, 'productCode', 'product_code')),
      productName: str(pick(it, 'productName', 'product_name')),
      quantity: qty(pick(it, 'quantity')),
      targetPrice: pick(it, 'targetPrice', 'target_price') == null ? '' : money(pick(it, 'targetPrice', 'target_price')),
      notes: str(pick(it, 'notes')),
    })),
    totals: [['Items', String(items.length)]],
    notes: lines(
      pick(r, 'notes'),
      suppliers.length ? `Suppliers invited: ${suppliers.map((s) => str(pick(s, 'name'))).join(', ')}` : ''
    ),
    raw: out,
  };
}

async function loadPurchaseOrder(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await procurement.getOrderDetail(client, ctx, id);
  const o = out.order as Record<string, unknown>;
  const items = (out.items ?? []) as Array<Record<string, unknown>>;
  const supplierName = str(pick(o, 'supplierName', 'supplier_name'));
  const supplierCode = str(pick(o, 'supplierCode', 'supplier_code'));
  const currency = str(pick(o, 'currency')) || 'UGX';
  const status = statusLabel(pick(o, 'status'));
  const supplier = supplierParty(o);
  const days = num(pick(o, 'paymentTermsDays', 'payment_terms_days'));
  return {
    code: str(pick(o, 'poNo', 'po_no')),
    title: 'Purchase Order',
    kicker: 'Procurement document',
    currency,
    status,
    parties: supplier ? [supplier] : [],
    facts: [
      ['Order Date', dateOnly(pick(o, 'orderDate', 'order_date'))],
      ['Expected Date', dateOnly(pick(o, 'expectedDate', 'expected_date'))],
      ['Currency', currency],
      ['Budget Code', str(pick(o, 'budgetCode', 'budget_code'))],
      ['PR No', str(pick(o, 'prNo', 'pr_no'))],
      ['Payment Terms', days ? `Net ${days} days` : ''],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Prepared by' },
      { label: 'Authorised by' },
      { label: 'Supplier acknowledgement' },
    ],
    subtitle: supplierName ? `${supplierName}${supplierCode ? `  ·  ${supplierCode}` : ''}` : undefined,
    meta: [
      ['PO No', str(pick(o, 'poNo', 'po_no'))],
      ['Order Date', dateOnly(pick(o, 'orderDate', 'order_date'))],
      ['Expected Date', dateOnly(pick(o, 'expectedDate', 'expected_date'))],
      ['Supplier', supplierName],
      ['Currency', currency],
      ['Budget Code', str(pick(o, 'budgetCode', 'budget_code'))],
      ['Three-Way Match', yesNo(pick(o, 'threeWayMatched', 'three_way_matched'))],
      ['Status', status],
    ],
    columns: [
      { key: 'productCode', label: 'Product Code', weight: 1.5 },
      { key: 'productName', label: 'Product', weight: 2.2 },
      { key: 'quantity', label: 'Ordered', align: 'right', weight: 1.0 },
      { key: 'receivedQty', label: 'Received', align: 'right', weight: 1.0 },
      { key: 'unitPrice', label: 'Unit Price', align: 'right', weight: 1.1 },
      { key: 'taxPercent', label: 'Tax %', align: 'right', weight: 0.8 },
      { key: 'lineTotal', label: 'Line Total', align: 'right', weight: 1.2 },
    ],
    items: items.map((it) => ({
      productCode: str(pick(it, 'productCode', 'product_code')),
      productName: str(pick(it, 'productName', 'product_name', 'description')),
      quantity: qty(pick(it, 'quantity')),
      receivedQty: qty(pick(it, 'receivedQty', 'received_qty')),
      unitPrice: money(pick(it, 'unitPrice', 'unit_price')),
      taxPercent: pct(pick(it, 'taxPercent', 'tax_percent')),
      lineTotal: money(pick(it, 'lineTotal', 'line_total')),
    })),
    totals: [
      ['Subtotal', money(pick(o, 'subtotal'))],
      ['Tax', money(pick(o, 'taxAmount', 'tax_amount'))],
      ['Total', moneyCcy(pick(o, 'total'), currency)],
    ],
    notes: lines(pick(o, 'notes')),
    raw: out,
  };
}

async function loadGoodsReceipt(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await procurement.getGoodsReceipt(client, ctx, id);
  const g = out.receipt as Record<string, unknown>;
  const items = (out.items ?? []) as Array<Record<string, unknown>>;
  const status = statusLabel(pick(g, 'status'));
  const supplier = supplierParty(g);
  const supplierName = str(pick(g, 'supplierName', 'supplier_name'));
  return {
    code: str(pick(g, 'grnNo', 'grn_no')),
    title: 'Goods Received Note',
    kicker: 'Warehouse document',
    status,
    parties: supplier ? [supplier] : [],
    facts: [
      ['PO No', str(pick(g, 'poNo', 'po_no'))],
      ['Received', pick(g, 'receivedAt', 'received_at') ? formatDocDateTime(pick(g, 'receivedAt', 'received_at')) : ''],
      ['Received By', str(pick(g, 'receivedBy', 'received_by'))],
      ['Delivery Ref', str(pick(g, 'deliveryRef', 'delivery_ref'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Received by', name: str(pick(g, 'receivedBy', 'received_by')) },
      { label: 'Inspected by' },
      { label: 'Authorised by' },
    ],
    subtitle: supplierName || undefined,
    meta: [
      ['GRN No', str(pick(g, 'grnNo', 'grn_no'))],
      ['PO No', str(pick(g, 'poNo', 'po_no'))],
      ['Received At', pick(g, 'receivedAt', 'received_at') ? formatDocDateTime(pick(g, 'receivedAt', 'received_at')) : ''],
      ['Received By', str(pick(g, 'receivedBy', 'received_by'))],
      ['Delivery Ref', str(pick(g, 'deliveryRef', 'delivery_ref'))],
      ['Status', status],
    ],
    columns: [
      { key: 'productCode', label: 'Product Code', weight: 1.5 },
      { key: 'productName', label: 'Product', weight: 2.2 },
      { key: 'quantityReceived', label: 'Received', align: 'right', weight: 1.0 },
      { key: 'quantityAccepted', label: 'Accepted', align: 'right', weight: 1.0 },
      { key: 'quantityRejected', label: 'Rejected', align: 'right', weight: 1.0 },
      { key: 'unitCost', label: 'Unit Cost', align: 'right', weight: 1.1 },
      { key: 'qcStatus', label: 'QC', weight: 1.2 },
    ],
    items: items.map((it) => ({
      productCode: str(pick(it, 'productCode', 'product_code')),
      productName: str(pick(it, 'productName', 'product_name')),
      quantityReceived: qty(pick(it, 'quantityReceived', 'quantity_received')),
      quantityAccepted: pick(it, 'quantityAccepted', 'quantity_accepted') == null ? '' : qty(pick(it, 'quantityAccepted', 'quantity_accepted')),
      quantityRejected: qty(pick(it, 'quantityRejected', 'quantity_rejected')),
      unitCost: money(pick(it, 'unitCost', 'unit_cost')),
      qcStatus: str(pick(it, 'qcStatus', 'qc_status')),
    })),
    totals: [['Items', String(items.length)]],
    notes: lines(pick(g, 'notes')),
    raw: out,
  };
}

async function loadSupplierInvoice(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await procurement.getSupplierInvoice(client, ctx, id);
  const inv = out.invoice as Record<string, unknown>;
  const items = (out.items ?? []) as Array<Record<string, unknown>>;
  const total = num(pick(inv, 'total'));
  const paid = num(pick(inv, 'amountPaid', 'amount_paid'));
  const supplierName = str(pick(inv, 'supplierName', 'supplier_name'));
  const supplierCode = str(pick(inv, 'supplierCode', 'supplier_code'));
  const currency = str(pick(inv, 'currency')) || 'UGX';
  const status = statusLabel(pick(inv, 'status'));
  const supplier = supplierParty(inv);
  return {
    code: str(pick(inv, 'supplierInvoiceNo', 'supplier_invoice_no')),
    title: 'Supplier Invoice',
    kicker: 'Accounts payable',
    currency,
    status,
    parties: supplier ? [supplier] : [],
    facts: [
      ['Invoice Date', dateOnly(pick(inv, 'invoiceDate', 'invoice_date'))],
      ['Due Date', dateOnly(pick(inv, 'dueDate', 'due_date'))],
      ['PO No', str(pick(inv, 'poNo', 'po_no'))],
      ['GRN No', str(pick(inv, 'grnNo', 'grn_no'))],
      ['Currency', currency],
      ['Three-Way Match', yesNo(pick(inv, 'threeWayMatched', 'three_way_matched'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Checked by' },
      { label: 'Matched by' },
      { label: 'Authorised for payment' },
    ],
    subtitle: supplierName ? `${supplierName}${supplierCode ? `  ·  ${supplierCode}` : ''}` : undefined,
    meta: [
      ['Invoice No', str(pick(inv, 'supplierInvoiceNo', 'supplier_invoice_no'))],
      ['Invoice Date', dateOnly(pick(inv, 'invoiceDate', 'invoice_date'))],
      ['Due Date', dateOnly(pick(inv, 'dueDate', 'due_date'))],
      ['Supplier', supplierName],
      ['PO No', str(pick(inv, 'poNo', 'po_no'))],
      ['GRN No', str(pick(inv, 'grnNo', 'grn_no'))],
      ['Three-Way Match', yesNo(pick(inv, 'threeWayMatched', 'three_way_matched'))],
      ['Status', status],
    ],
    columns: [
      { key: 'productCode', label: 'Product Code', weight: 1.5 },
      { key: 'productName', label: 'Product / Description', weight: 2.6 },
      { key: 'quantity', label: 'Qty', align: 'right', weight: 0.9 },
      { key: 'unitPrice', label: 'Unit Price', align: 'right', weight: 1.1 },
      { key: 'taxPercent', label: 'Tax %', align: 'right', weight: 0.8 },
      { key: 'lineTotal', label: 'Line Total', align: 'right', weight: 1.2 },
    ],
    items: items.map((it) => ({
      productCode: str(pick(it, 'productCode', 'product_code')),
      productName: str(pick(it, 'productName', 'product_name', 'description')),
      quantity: qty(pick(it, 'quantity')),
      unitPrice: money(pick(it, 'unitPrice', 'unit_price')),
      taxPercent: pct(pick(it, 'taxPercent', 'tax_percent')),
      lineTotal: money(pick(it, 'lineTotal', 'line_total')),
    })),
    totals: [
      ['Subtotal', money(pick(inv, 'subtotal'))],
      ['Tax', money(pick(inv, 'taxAmount', 'tax_amount'))],
      ['Total', moneyCcy(total, currency)],
      ['Amount Paid', money(paid)],
      ['Balance Due', moneyCcy(total - paid, currency)],
    ],
    notes: lines(pick(inv, 'notes')),
    raw: out,
  };
}

async function loadSupplierPayment(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await procurement.getSupplierPayment(client, ctx, id);
  const p = out.payment as Record<string, unknown>;
  const currency = str(pick(p, 'currency')) || 'UGX';
  const status = statusLabel(pick(p, 'status'));
  const amount = num(pick(p, 'amount'));
  const supplier = supplierParty(p);
  const bank = lines(pick(p, 'bankName', 'bank_name'), pick(p, 'bankAccountName', 'bank_account_name'), maskAccount(pick(p, 'bankAccountNo', 'bank_account_no'))).join('  ');
  return {
    code: str(pick(p, 'paymentNo', 'payment_no')),
    title: 'Payment Voucher',
    kicker: 'Accounts payable',
    currency,
    status,
    parties: supplier ? [supplier] : [],
    facts: [
      ['Payment Date', dateOnly(pick(p, 'paymentDate', 'payment_date'))],
      ['Method', statusLabel(pick(p, 'method'))],
      ['Reference', str(pick(p, 'reference'))],
      ['Supplier Invoice', str(pick(p, 'supplierInvoiceNo', 'supplier_invoice_no'))],
      ['Purchase Order', str(pick(p, 'poNo', 'po_no'))],
      ['Bank', bank],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Prepared by' },
      { label: 'Authorised by' },
      { label: 'Received by' },
    ],
    subtitle: str(pick(p, 'supplierName', 'supplier_name')) || undefined,
    meta: [
      ['Payment No', str(pick(p, 'paymentNo', 'payment_no'))],
      ['Payment Date', dateOnly(pick(p, 'paymentDate', 'payment_date'))],
      ['Method', str(pick(p, 'method'))],
      ['Status', status],
    ],
    columns: [
      { key: 'description', label: 'Description', weight: 4 },
      { key: 'amount', label: 'Amount', align: 'right', weight: 1.4 },
    ],
    items: [
      {
        description: lines(
          str(pick(p, 'supplierInvoiceNo', 'supplier_invoice_no')) ? `Invoice ${pick(p, 'supplierInvoiceNo', 'supplier_invoice_no')}` : 'Supplier payment',
          str(pick(p, 'poNo', 'po_no')) ? `PO ${pick(p, 'poNo', 'po_no')}` : '',
          str(pick(p, 'reference')) ? `Ref ${pick(p, 'reference')}` : ''
        ).join(' · ') || 'Supplier payment',
        amount: money(amount),
      },
    ],
    totals: [['Amount Paid', moneyCcy(amount, currency)]],
    notes: lines('This voucher authorises settlement of the supplier account. It posts to the ledger on release.'),
    raw: out,
  };
}

async function loadPurchaseReturn(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await procurement.getPurchaseReturn(client, ctx, id);
  const r = out.purchaseReturn as Record<string, unknown>;
  const items = (out.items ?? []) as Array<Record<string, unknown>>;
  const status = statusLabel(pick(r, 'status'));
  const supplier = supplierParty(r);
  return {
    code: str(pick(r, 'returnNo', 'return_no')),
    title: 'Supplier Return Note',
    kicker: 'Procurement document',
    status,
    parties: supplier ? [supplier] : [],
    facts: [
      ['Return Date', dateOnly(pick(r, 'returnDate', 'return_date'))],
      ['GRN No', str(pick(r, 'grnNo', 'grn_no'))],
      ['PO No', str(pick(r, 'poNo', 'po_no'))],
      ['Reason', str(pick(r, 'reason'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [{ label: 'Prepared by' }, { label: 'Warehouse' }, { label: 'Supplier acknowledgement' }],
    subtitle: str(pick(r, 'supplierName', 'supplier_name')) || undefined,
    meta: [
      ['Return No', str(pick(r, 'returnNo', 'return_no'))],
      ['GRN No', str(pick(r, 'grnNo', 'grn_no'))],
      ['Status', status],
    ],
    columns: [
      { key: 'productCode', label: 'Product Code', weight: 1.4 },
      { key: 'productName', label: 'Product', weight: 2.6 },
      { key: 'batchNo', label: 'Batch / Lot', weight: 1.4 },
      { key: 'quantity', label: 'Qty', align: 'right', weight: 1 },
    ],
    items: items.map((it) => ({
      productCode: str(pick(it, 'productCode', 'product_code')),
      productName: str(pick(it, 'productName', 'product_name')),
      batchNo: str(pick(it, 'batchNo', 'batch_no')),
      quantity: qty(pick(it, 'quantity')),
    })),
    totals: [['Items', String(items.length)], ['Total Qty', qty(items.reduce((s, it) => s + num(pick(it, 'quantity')), 0))]],
    notes: lines(pick(r, 'reason')),
    raw: out,
  };
}

async function loadSupplierQuotation(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await procurement.getSupplierQuotation(client, ctx, id);
  const q = out.quotation as Record<string, unknown>;
  const items = (out.items ?? []) as Array<Record<string, unknown>>;
  const currency = str(pick(q, 'currency')) || 'UGX';
  const status = statusLabel(pick(q, 'status'));
  const supplier = supplierParty(q);
  return {
    code: str(pick(q, 'quoteNo', 'quote_no')),
    title: 'Supplier Quotation',
    kicker: 'Procurement document',
    currency,
    status,
    parties: supplier ? [supplier] : [],
    facts: [
      ['Quote Date', dateOnly(pick(q, 'quoteDate', 'quote_date'))],
      ['Valid Until', dateOnly(pick(q, 'validUntil', 'valid_until'))],
      ['RFQ', str(pick(q, 'rfqNo', 'rfq_no'))],
      ['PR No', str(pick(q, 'prNo', 'pr_no'))],
      ['Currency', currency],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [{ label: 'Received by' }, { label: 'Evaluated by' }],
    subtitle: str(pick(q, 'supplierName', 'supplier_name')) || undefined,
    meta: [
      ['Quote No', str(pick(q, 'quoteNo', 'quote_no'))],
      ['RFQ', str(pick(q, 'rfqNo', 'rfq_no'))],
      ['Status', status],
    ],
    columns: [
      { key: 'productCode', label: 'Product Code', weight: 1.5 },
      { key: 'productName', label: 'Product', weight: 2.6 },
      { key: 'quantity', label: 'Qty', align: 'right', weight: 0.9 },
      { key: 'unitPrice', label: 'Unit Price', align: 'right', weight: 1.2 },
      { key: 'leadTime', label: 'Lead days', align: 'right', weight: 1 },
      { key: 'lineTotal', label: 'Line Total', align: 'right', weight: 1.3 },
    ],
    items: items.map((it) => ({
      productCode: str(pick(it, 'productCode', 'product_code')),
      productName: str(pick(it, 'productName', 'product_name')),
      quantity: qty(pick(it, 'quantity')),
      unitPrice: money(pick(it, 'unitPrice', 'unit_price')),
      leadTime: str(pick(it, 'leadTimeDays', 'lead_time_days')),
      lineTotal: money(pick(it, 'lineTotal', 'line_total')),
    })),
    totals: [['Total', moneyCcy(pick(q, 'total'), currency)]],
    notes: lines(pick(q, 'notes')),
    raw: out,
  };
}

async function loadBidAnalysis(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await procurement.getRfq(client, ctx, id);
  const r = out.rfq as Record<string, unknown>;
  const quotes = (out.quotations ?? []) as Array<Record<string, unknown>>;
  const status = statusLabel(pick(r, 'status'));
  const rows: Array<Record<string, unknown>> = [];
  for (const q of quotes) {
    const qItems = (Array.isArray(q.items) ? q.items : []) as Array<Record<string, unknown>>;
    for (const it of qItems) {
      rows.push({
        productCode: str(pick(it, 'productCode', 'product_code')),
        productName: str(pick(it, 'productName', 'product_name')),
        supplier: str(pick(q, 'supplierName', 'supplier_name')),
        quantity: qty(pick(it, 'quantity')),
        unitPrice: money(pick(it, 'unitPrice', 'unit_price')),
        leadTime: str(pick(it, 'leadTimeDays', 'lead_time_days')),
        lineTotal: money(pick(it, 'lineTotal', 'line_total')),
        quoteStatus: statusLabel(pick(q, 'status')),
      });
    }
  }
  const lowest = quotes.length
    ? quotes.reduce((a, b) => (num(pick(a, 'total')) <= num(pick(b, 'total')) ? a : b))
    : null;
  return {
    code: str(pick(r, 'rfqNo', 'rfq_no')),
    title: 'Bid Analysis',
    kicker: 'Procurement document',
    status,
    facts: [
      ['RFQ No', str(pick(r, 'rfqNo', 'rfq_no'))],
      ['Issue Date', dateOnly(pick(r, 'issueDate', 'issue_date'))],
      ['Closing Date', dateOnly(pick(r, 'closingDate', 'closing_date'))],
      ['Quotations', String(quotes.length)],
      ['Lowest quote', lowest ? `${str(pick(lowest, 'supplierName', 'supplier_name'))} ${moneyCcy(pick(lowest, 'total'), 'UGX')}` : ''],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [{ label: 'Evaluated by' }, { label: 'Awarded by' }],
    subtitle: str(pick(r, 'rfqNo', 'rfq_no')) || undefined,
    meta: [
      ['RFQ No', str(pick(r, 'rfqNo', 'rfq_no'))],
      ['Status', status],
    ],
    columns: [
      { key: 'productCode', label: 'Product Code', weight: 1.3 },
      { key: 'productName', label: 'Product', weight: 2 },
      { key: 'supplier', label: 'Supplier', weight: 2 },
      { key: 'quantity', label: 'Qty', align: 'right', weight: 0.8 },
      { key: 'unitPrice', label: 'Unit Price', align: 'right', weight: 1.1 },
      { key: 'leadTime', label: 'Lead days', align: 'right', weight: 0.9 },
      { key: 'lineTotal', label: 'Line Total', align: 'right', weight: 1.2 },
      { key: 'quoteStatus', label: 'Status', weight: 1 },
    ],
    items: rows,
    totals: quotes.map((q) => [`${str(pick(q, 'supplierName', 'supplier_name'))} (${str(pick(q, 'quoteNo', 'quote_no'))})`, moneyCcy(pick(q, 'total'), 'UGX')]),
    notes: lines(
      pick(r, 'notes'),
      lowest ? `Recommended award: ${str(pick(lowest, 'supplierName', 'supplier_name'))} (${str(pick(lowest, 'quoteNo', 'quote_no'))}).` : 'No quotations recorded.'
    ),
    raw: out,
  };
}

async function loadInspection(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await procurement.getInspection(client, ctx, id);
  const i = out.inspection as Record<string, unknown>;
  const results = (out.results ?? []) as Array<Record<string, unknown>>;
  const status = statusLabel(pick(i, 'status'));
  const result = statusLabel(pick(i, 'result'));
  return {
    code: str(pick(i, 'inspectionNo', 'inspection_no')),
    title: 'Incoming Inspection Report',
    kicker: 'Quality document',
    status,
    facts: [
      ['Kind', statusLabel(pick(i, 'kind'))],
      ['Product', lines(pick(i, 'productCode', 'product_code'), pick(i, 'productName', 'product_name')).join(' · ')],
      ['Batch / Lot', str(pick(i, 'batchNo', 'batch_no'))],
      ['Quantity', qty(pick(i, 'quantity'))],
      ['Result', result],
      ['Inspected', pick(i, 'inspectedAt', 'inspected_at') ? formatDocDateTime(pick(i, 'inspectedAt', 'inspected_at')) : ''],
      ['Inspector', str(pick(i, 'inspectorName', 'inspector_name'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Inspector', name: str(pick(i, 'inspectorName', 'inspector_name')) },
      { label: 'Reviewed by' },
    ],
    subtitle: result || undefined,
    meta: [
      ['Inspection No', str(pick(i, 'inspectionNo', 'inspection_no'))],
      ['Result', result],
      ['Status', status],
    ],
    columns: [
      { key: 'parameter', label: 'Parameter', weight: 2 },
      { key: 'standard', label: 'Standard', weight: 1.6 },
      { key: 'actual', label: 'Actual', weight: 1.6 },
      { key: 'passed', label: 'Pass', weight: 1 },
    ],
    items: results.map((row) => ({
      parameter: str(pick(row, 'parameter')),
      standard: str(pick(row, 'standardValue', 'standard_value')),
      actual: str(pick(row, 'actualValue', 'actual_value')),
      passed: pick(row, 'passed') == null ? '' : pick(row, 'passed') ? 'Pass' : 'Fail',
    })),
    totals: [['Result', result]],
    notes: lines(pick(i, 'notes')),
    raw: out,
  };
}

async function loadJournal(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await finance.getJournal(client, ctx, id);
  const j = out.journal as Record<string, unknown>;
  const linesData = (out.lines ?? []) as Array<Record<string, unknown>>;
  const currency = str(pick(j, 'currency')) || 'UGX';
  const status = statusLabel(pick(j, 'status'));
  const reference = lines(pick(j, 'referenceType', 'reference_type'), pick(j, 'referenceCode', 'reference_code')).join(' ');
  return {
    code: str(pick(j, 'entryNo', 'entry_no')),
    title: 'Journal Entry',
    kicker: 'Finance document',
    currency,
    status,
    facts: [
      ['Entry Date', dateOnly(pick(j, 'entryDate', 'entry_date'))],
      ['Journal Type', statusLabel(pick(j, 'journalType', 'journal_type'))],
      ['Reference', reference],
      ['Currency', currency],
      ['Posted', pick(j, 'postedAt', 'posted_at') ? formatDocDateTime(pick(j, 'postedAt', 'posted_at')) : 'No'],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Prepared by' },
      { label: 'Reviewed by' },
      { label: 'Posted by' },
    ],
    subtitle: str(pick(j, 'description')) || (reference ? `Reference: ${reference}` : undefined),
    meta: [
      ['Entry No', str(pick(j, 'entryNo', 'entry_no'))],
      ['Entry Date', dateOnly(pick(j, 'entryDate', 'entry_date'))],
      ['Journal Type', str(pick(j, 'journalType', 'journal_type'))],
      ['Reference', reference],
      ['Currency', currency],
      ['Status', status],
      ['Posted', pick(j, 'postedAt', 'posted_at') ? 'Yes' : 'No'],
      ['Description', str(pick(j, 'description'))],
    ],
    columns: [
      { key: 'accountCode', label: 'Account Code', weight: 1.4 },
      { key: 'accountName', label: 'Account', weight: 2.4 },
      { key: 'description', label: 'Description', weight: 2.2 },
      { key: 'debit', label: 'Debit', align: 'right', weight: 1.2 },
      { key: 'credit', label: 'Credit', align: 'right', weight: 1.2 },
    ],
    items: linesData.map((ln) => ({
      accountCode: str(pick(ln, 'accountCode', 'account_code')),
      accountName: str(pick(ln, 'accountName', 'account_name')),
      description: str(pick(ln, 'description')),
      debit: num(pick(ln, 'debit')) ? money(pick(ln, 'debit')) : '',
      credit: num(pick(ln, 'credit')) ? money(pick(ln, 'credit')) : '',
    })),
    totals: [
      ['Total Debit', moneyCcy(pick(j, 'totalDebit', 'total_debit'), currency)],
      ['Total Credit', moneyCcy(pick(j, 'totalCredit', 'total_credit'), currency)],
    ],
    notes: [],
    raw: out,
  };
}
async function loadExpense(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await finance.getExpense(client, ctx, id);
  const e = out.expense as Record<string, unknown>;
  const currency = str(pick(e, 'currency')) || 'UGX';
  const status = statusLabel(pick(e, 'status'));
  const account = lines(pick(e, 'accountCode', 'account_code'), pick(e, 'accountName', 'account_name')).join(' - ');
  const journalNo = out.journal ? str(pick(out.journal.journal, 'entryNo', 'entry_no')) : '';
  return {
    code: str(pick(e, 'expenseNo', 'expense_no')),
    title: 'Expense Voucher',
    kicker: 'Finance document',
    currency,
    status,
    subtitle: str(pick(e, 'category')) || str(pick(e, 'vendor')) || undefined,
    facts: [
      ['Expense Date', dateOnly(pick(e, 'expenseDate', 'expense_date'))],
      ['Category', str(pick(e, 'category'))],
      ['Payment Method', str(pick(e, 'method'))],
      ['Vendor', str(pick(e, 'vendor'))],
      ['Reference', str(pick(e, 'reference'))],
      ['Expense Account', account],
      ['GL Journal', journalNo],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Prepared by' },
      { label: 'Approved by' },
      { label: 'Posted by' },
    ],
    meta: [
      ['Expense No', str(pick(e, 'expenseNo', 'expense_no'))],
      ['Expense Date', dateOnly(pick(e, 'expenseDate', 'expense_date'))],
      ['Category', str(pick(e, 'category'))],
      ['Payment Method', str(pick(e, 'method'))],
      ['Vendor', str(pick(e, 'vendor'))],
      ['Reference', str(pick(e, 'reference'))],
      ['Expense Account', account],
      ['Amount', moneyCcy(pick(e, 'amount'), currency)],
      ['Status', status],
      ['GL Journal', journalNo || 'Not posted'],
    ],
    columns: [
      { key: 'accountCode', label: 'Account Code', weight: 1.4 },
      { key: 'accountName', label: 'Account', weight: 2.4 },
      { key: 'description', label: 'Description', weight: 2.2 },
      { key: 'debit', label: 'Debit', align: 'right', weight: 1.2 },
      { key: 'credit', label: 'Credit', align: 'right', weight: 1.2 },
    ],
    items:
      out.journal && Array.isArray(out.journal.lines) && out.journal.lines.length
        ? out.journal.lines.map((ln) => ({
            accountCode: str(pick(ln, 'accountCode', 'account_code')),
            accountName: str(pick(ln, 'accountName', 'account_name')),
            description: str(pick(ln, 'description')),
            debit: num(pick(ln, 'debit')) ? money(pick(ln, 'debit')) : '',
            credit: num(pick(ln, 'credit')) ? money(pick(ln, 'credit')) : '',
          }))
        : [
            {
              accountCode: str(pick(e, 'accountCode', 'account_code')),
              accountName: str(pick(e, 'accountName', 'account_name')),
              description: str(pick(e, 'category')) || str(pick(e, 'reference')),
              debit: money(pick(e, 'amount')),
              credit: '',
            },
          ],
    totals: [['Expense Amount', moneyCcy(pick(e, 'amount'), currency)]],
    notes: [],
    raw: out,
  };
}

async function loadBudget(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await finance.getBudget(client, ctx, id);
  const b = out.budget as Record<string, unknown>;
  const currency = str(pick(b, 'currency')) || 'UGX';
  const status = statusLabel(pick(b, 'status'));
  const period = `${dateOnly(pick(b, 'periodStart', 'period_start'))} - ${dateOnly(pick(b, 'periodEnd', 'period_end'))}`;
  const approvedAt = pick(b, 'approvedAt', 'approved_at');
  return {
    code: str(pick(b, 'budgetNo', 'budget_no')),
    title: 'Budget',
    kicker: 'Finance document',
    currency,
    status,
    subtitle: period,
    facts: [
      ['Period', period],
      ['Planned Amount', moneyCcy(pick(b, 'amount'), currency)],
      ['Approved', approvedAt ? formatDocDateTime(approvedAt) : 'No'],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Prepared by' },
      { label: 'Approved by' },
    ],
    meta: [
      ['Budget No', str(pick(b, 'budgetNo', 'budget_no'))],
      ['Period Start', dateOnly(pick(b, 'periodStart', 'period_start'))],
      ['Period End', dateOnly(pick(b, 'periodEnd', 'period_end'))],
      ['Planned Amount', moneyCcy(pick(b, 'amount'), currency)],
      ['Status', status],
      ['Approved', approvedAt ? formatDocDateTime(approvedAt) : 'No'],
    ],
    columns: [
      { key: 'accountCode', label: 'Account Code', weight: 1.4 },
      { key: 'accountName', label: 'Account', weight: 2.6 },
      { key: 'accountType', label: 'Type', weight: 1.2 },
      { key: 'amount', label: 'Amount', align: 'right', weight: 1.3 },
    ],
    items: (out.lines ?? []).map((ln) => ({
      accountCode: str(pick(ln, 'accountCode', 'account_code')),
      accountName: str(pick(ln, 'accountName', 'account_name')),
      accountType: str(pick(ln, 'accountType', 'account_type')),
      amount: money(pick(ln, 'amount')),
    })),
    totals: [['Total Budgeted', moneyCcy(pick(b, 'amount'), currency)]],
    notes: [],
    raw: out,
  };
}

async function loadEmploymentContract(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const out = await contracts.getContract(client, ctx, id);
  const c = out.contract as Record<string, unknown>;
  const currency = str(pick(c, 'currency')) || 'UGX';
  const status = statusLabel(pick(c, 'status'));
  const employeeName = lines(pick(c, 'firstName', 'first_name'), pick(c, 'lastName', 'last_name')).join(' ');
  const employeeNo = str(pick(c, 'employeeNo', 'employee_no'));
  const employerName = str(pick(c, 'companyLegalName', 'company_legal_name')) || str(pick(c, 'companyName', 'company_name'));
  const allowances = (out.allowances ?? []) as Array<Record<string, unknown>>;
  const benefits = (out.benefits ?? []) as Array<Record<string, unknown>>;
  const noticeDays = num(pick(c, 'noticePeriodDays', 'notice_period_days'));
  const hours = num(pick(c, 'workingHoursPerWeek', 'working_hours_per_week'));
  const leaveDays = num(pick(c, 'annualLeaveDays', 'annual_leave_days'));
  const version = num(pick(c, 'version'));
  const photoFile = readEmployeePhotoFile(pick(c, 'photoPath', 'photo_path'), pick(c, 'photoMime', 'photo_mime'));
  const photo = photoFile
    ? {
        bytes: photoFile.bytes,
        mime: photoFile.mime,
        dataUrl: `data:${photoFile.mime};base64,${photoFile.bytes.toString('base64')}`,
        caption: String(pick(c, 'photoKind', 'photo_kind') ?? 'PASSPORT') === 'PHOTO' ? 'Employee photograph' : 'Passport photograph',
      }
    : undefined;
  return {
    code: str(pick(c, 'contractNo', 'contract_no')),
    title: 'Employment Contract',
    kicker: 'HR document',
    currency,
    status,
    subtitle: lines(
      statusLabel(pick(c, 'contractType', 'contract_type')),
      version ? `Version ${version}` : ''
    ).join(' · '),
    parties: [
      {
        heading: 'Employer',
        name: employerName,
        lines: lines(
          pick(c, 'companyAddress', 'company_address'),
          str(pick(c, 'companyPhone', 'company_phone')) ? `Phone: ${pick(c, 'companyPhone', 'company_phone')}` : '',
          str(pick(c, 'companyEmail', 'company_email')) ? `Email: ${pick(c, 'companyEmail', 'company_email')}` : '',
          str(pick(c, 'tin')) ? `TIN ${pick(c, 'tin')}` : ''
        ),
      },
      {
        heading: 'Employee',
        name: employeeName,
        lines: lines(
          employeeNo ? `Employee No ${employeeNo}` : '',
          pick(c, 'employeeAddress', 'employee_address'),
          str(pick(c, 'employeePhone', 'employee_phone')) ? `Phone: ${pick(c, 'employeePhone', 'employee_phone')}` : '',
          str(pick(c, 'employeeEmail', 'employee_email')) ? `Email: ${pick(c, 'employeeEmail', 'employee_email')}` : ''
        ),
      },
    ],
    facts: [
      ['Contract No', str(pick(c, 'contractNo', 'contract_no'))],
      ['Contract Type', statusLabel(pick(c, 'contractType', 'contract_type'))],
      ['Status', status],
      ['Start Date', dateOnly(pick(c, 'startDate', 'start_date'))],
      ['End Date', dateOnly(pick(c, 'endDate', 'end_date'))],
      ['Job Title', str(pick(c, 'jobTitle', 'job_title'))],
      ['Job Code', str(pick(c, 'jobCode', 'job_code'))],
      ['Department', str(pick(c, 'departmentName', 'department_name'))],
      ['Branch', str(pick(c, 'branchName', 'branch_name'))],
      ['Work Location', str(pick(c, 'location'))],
      ['Reporting Manager', str(pick(c, 'reportingManagerName', 'reporting_manager_name'))],
      ['Employee Category', str(pick(c, 'employeeCategory', 'employee_category'))],
      ['Probation', pick(c, 'probationStartDate', 'probation_start_date') ? lines(dateOnly(pick(c, 'probationStartDate', 'probation_start_date')), dateOnly(pick(c, 'probationEndDate', 'probation_end_date'))).join(' to ') : ''],
      ['Working Hours/Week', hours ? `${hours} hrs` : ''],
      ['Annual Leave', leaveDays ? `${leaveDays} days` : ''],
      ['Notice Period', noticeDays ? `${noticeDays} days` : ''],
      ['Basic Salary', moneyCcy(pick(c, 'salary'), currency)],
      ['Gross Salary', moneyCcy(pick(c, 'grossSalary', 'gross_salary'), currency)],
      ['Pay Frequency', statusLabel(pick(c, 'salaryFrequency', 'salary_frequency'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: contractSignatures(out),
    meta: [
      ['Contract No', str(pick(c, 'contractNo', 'contract_no'))],
      ['Employee', employeeName],
      ['Employee No', employeeNo],
      ['Contract Type', str(pick(c, 'contractType', 'contract_type'))],
      ['Status', status],
      ['Start Date', dateOnly(pick(c, 'startDate', 'start_date'))],
      ['End Date', dateOnly(pick(c, 'endDate', 'end_date'))],
      ['Version', version ? String(version) : ''],
      ['Legal Framework', str(pick(c, 'legalFrameworkVersion', 'legal_framework_version'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    columns: [
      { key: 'component', label: 'Component', weight: 2 },
      { key: 'detail', label: 'Detail', weight: 3 },
      { key: 'value', label: 'Value', align: 'right', weight: 1.4 },
    ],
    items: [
      ...allowances.map((a) => ({
        component: str(pick(a, 'name')) || statusLabel(pick(a, 'allowanceType', 'allowance_type')),
        detail: lines(
          str(pick(a, 'frequency')) ? `Frequency ${pick(a, 'frequency')}` : '',
          str(pick(a, 'payrollTreatment', 'payroll_treatment')) ? `Payroll ${pick(a, 'payrollTreatment', 'payroll_treatment')}` : '',
          pick(a, 'taxable') != null ? (pick(a, 'taxable') ? 'Taxable' : 'Non-taxable') : ''
        ).join(' · '),
        value: num(pick(a, 'percentage')) ? `${num(pick(a, 'percentage'))}%` : moneyCcy(pick(a, 'amount'), currency),
      })),
      ...benefits.map((b) => ({
        component: lines(str(pick(b, 'name')), statusLabel(pick(b, 'benefitType', 'benefit_type'))).join(' ') || 'Benefit',
        detail: lines(
          str(pick(b, 'frequency')) ? `Frequency ${pick(b, 'frequency')}` : '',
          pick(b, 'taxable') != null ? (pick(b, 'taxable') ? 'Taxable' : 'Non-taxable') : ''
        ).join(' · '),
        value: moneyCcy(pick(b, 'employerCost', 'employer_cost'), currency),
      })),
    ],
    totals: [],
    notes: [
      'This document records the written particulars of employment. It does not remove, reduce or contract out any statutory right conferred by the Employment Act (Cap. 226, Laws of Uganda), as amended.',
      'Where the legal position is uncertain, this document should be reviewed by a qualified employment-law professional before approval.',
    ],
    raw: out,
    isContract: true,
    photo,
  };
}

async function loadCertificateOfService(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const res = await client.query(
    `SELECT cos.*, e.employee_no, e.first_name, e.last_name, e.address AS employee_address,
            c.name AS company_name, c.legal_name AS company_legal_name, c.address AS company_address,
            c.phone AS company_phone, c.email AS company_email, c.tin, ec.contract_no
     FROM certificate_of_service cos
     JOIN employees e ON e.id = cos.employee_id
     JOIN companies c ON c.id = cos.company_id
     LEFT JOIN employment_contracts ec ON ec.id = cos.contract_id
     WHERE cos.id = $1 AND cos.tenant_id = $2 AND cos.company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Certificate of service not found');
  const r = res.rows[0] as Record<string, unknown>;
  const employeeName = lines(pick(r, 'first_name'), pick(r, 'last_name')).join(' ');
  const employerName = str(pick(r, 'company_legal_name')) || str(pick(r, 'company_name'));
  return {
    code: str(pick(r, 'cert_no')),
    title: 'Certificate of Service',
    kicker: 'HR document',
    currency: 'UGX',
    status: statusLabel(pick(r, 'status')),
    subtitle: str(pick(r, 'position')) || undefined,
    parties: [
      {
        heading: 'Employer',
        name: employerName,
        lines: lines(
          pick(r, 'company_address'),
          str(pick(r, 'company_phone')) ? `Phone: ${pick(r, 'company_phone')}` : '',
          str(pick(r, 'company_email')) ? `Email: ${pick(r, 'company_email')}` : ''
        ),
      },
      {
        heading: 'Employee',
        name: employeeName,
        lines: lines(
          str(pick(r, 'employee_no')) ? `Employee No ${pick(r, 'employee_no')}` : '',
          pick(r, 'employee_address')
        ),
      },
    ],
    facts: [
      ['Certificate No', str(pick(r, 'cert_no'))],
      ['Period of Employment', lines(dateOnly(pick(r, 'period_start')), dateOnly(pick(r, 'period_end'))).join(' to ')],
      ['Position / Capacity', str(pick(r, 'position'))],
      ['Nature of Business', str(pick(r, 'nature_of_business'))],
      ['Wages at Termination', moneyCcy(pick(r, 'wages_at_termination'), 'UGX')],
      ['Reason for Termination', str(pick(r, 'reason_for_termination'))],
      ['Status', statusLabel(pick(r, 'status'))],
      ['Issued', pick(r, 'issued_at') ? formatDocDateTime(pick(r, 'issued_at')) : ''],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [{ label: 'Employer Representative' }],
    isCertificate: true,
    meta: [
      ['Certificate No', str(pick(r, 'cert_no'))],
      ['Contract No', str(pick(r, 'contract_no'))],
      ['Employee', employeeName],
      ['Employee No', str(pick(r, 'employee_no'))],
      ['Period Start', dateOnly(pick(r, 'period_start'))],
      ['Period End', dateOnly(pick(r, 'period_end'))],
      ['Position', str(pick(r, 'position'))],
      ['Nature of Business', str(pick(r, 'nature_of_business'))],
      ['Wages at Termination', moneyCcy(pick(r, 'wages_at_termination'), 'UGX')],
      ['Reason for Termination', str(pick(r, 'reason_for_termination'))],
      ['Status', statusLabel(pick(r, 'status'))],
      ['Issued At', pick(r, 'issued_at') ? formatDocDateTime(pick(r, 'issued_at')) : ''],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    columns: [],
    items: [],
    totals: [],
    notes: [
      'This certificate is issued under the Employment Act (Cap. 226, Laws of Uganda), as amended, and records the particulars of employment set out above.',
      'It is a statutory certificate of service and is not a reference as to the character or performance of the employee.',
    ],
    raw: res.rows[0],
  };
}

/**
 * Ugandan monthly PAYE brackets in force for FY2026/27 (effective 1 July 2026).
 * PAYE is charged on taxable pay after deducting the employee NSSF contribution.
 */
const UG_PAYE_BRACKETS_2026: { bands: Array<[string, string]>; note: string } = {
  bands: [
    ['Up to 335,000', '0%'],
    ['335,001 \u2013 410,000', '20%'],
    ['410,001 \u2013 485,000', '25%'],
    ['485,001 \u2013 10,000,000', '30%'],
    ['Above 10,000,000', '40%'],
  ],
  note:
    'PAYE is applied to taxable pay after deducting the employee NSSF contribution. ' +
    'Up to UGX 10,000,000: 33,750 + 30% of the excess over 485,000. ' +
    'Above UGX 10,000,000: PAYE on 10,000,000 + 40% of the excess.',
};

async function loadPayslip(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const res = await client.query(
    `SELECT i.*,
            e.employee_no, e.first_name, e.last_name, e.position, e.phone, e.email, e.address,
            e.tin AS employee_tin, e.nssf_no, e.bank_name, e.bank_account_no,
            e.photo_path, e.photo_mime, e.photo_kind,
            d.name AS department_name, d.code AS department_code,
            p.payroll_no, p.period_start, p.period_end, p.payment_date, p.status AS payroll_status,
            p.currency AS payroll_currency, p.run_type, p.off_cycle_type, p.reason AS payroll_reason,
            c.name AS company_name, c.legal_name AS company_legal_name, c.address AS company_address,
            c.phone AS company_phone, c.email AS company_email, c.tin AS company_tin,
            s.status AS payslip_status, s.verification_code, s.published_at, s.payment_date AS slip_payment_date
     FROM payroll_items i
     JOIN payrolls p ON p.id = i.payroll_id
     JOIN employees e ON e.id = i.employee_id
     JOIN companies c ON c.id = p.company_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN payslips s ON s.payroll_id = i.payroll_id AND s.employee_id = i.employee_id AND s.tenant_id = p.tenant_id
     WHERE i.id = $1 AND p.tenant_id = $2 AND p.company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Payslip not found');
  const r = res.rows[0] as Record<string, unknown>;
  const currency = str(pick(r, 'currency', 'payroll_currency')) || 'UGX';
  const employeeName = lines(pick(r, 'first_name'), pick(r, 'last_name')).join(' ');
  const employerName = str(pick(r, 'company_legal_name')) || str(pick(r, 'company_name'));
  const period = lines(dateOnly(pick(r, 'period_start')), dateOnly(pick(r, 'period_end'))).join(' to ');
  const published = str(pick(r, 'payslip_status'));
  const payrollStatus = statusLabel(pick(r, 'payroll_status'));
  const status = published ? statusLabel(published) : payrollStatus;
  const runType = statusLabel(pick(r, 'run_type')) || 'Normal';
  const offCycle = statusLabel(pick(r, 'off_cycle_type'));
  const photoFile = readEmployeePhotoFile(pick(r, 'photo_path'), pick(r, 'photo_mime'));
  const photo = photoFile
    ? {
        bytes: photoFile.bytes,
        mime: photoFile.mime,
        dataUrl: `data:${photoFile.mime};base64,${photoFile.bytes.toString('base64')}`,
        caption: String(pick(r, 'photo_kind') ?? 'PASSPORT') === 'PHOTO' ? 'Employee photograph' : 'Passport photograph',
      }
    : undefined;
  const bank = lines(pick(r, 'bank_name'), maskAccount(pick(r, 'bank_account_no'))).join('  ');
  const items: Array<Record<string, unknown>> = [];
  const addLine = (kind: string, component: string, detail: string, amount: unknown, always = false) => {
    const n = num(amount);
    if (!always && n === 0) return;
    items.push({ kind, component, detail, amount: money(n) });
  };
  addLine('Earning', 'Basic pay', 'Contracted monthly salary', pick(r, 'basic_pay'), true);
  addLine('Earning', 'Allowances', 'Taxable allowances for the period', pick(r, 'allowances'));
  addLine('Deduction', 'PAYE', 'Pay-As-You-Earn (Income Tax Act)', pick(r, 'paye'), true);
  addLine('Deduction', 'NSSF (employee)', 'National Social Security Fund employee contribution', pick(r, 'nssf'), true);
  addLine('Deduction', 'Local Service Tax', 'Local Service Tax for the period', pick(r, 'lst'));
  addLine('Deduction', 'Staff loan', 'Monthly loan recovery', pick(r, 'loans'));
  addLine('Deduction', 'Salary advance', 'Advance recovery', pick(r, 'advances'));
  addLine('Deduction', 'Other deductions', 'Other authorised deductions', pick(r, 'other_deductions'));
  const payBreakdown: Array<[string, string]> = [['Gross Pay', moneyCcy(pick(r, 'gross_pay'), currency)]];
  const deductionLines: Array<[string, string]> = [];
  const addDeduction = (label: string, amount: unknown) => {
    if (num(amount) > 0) deductionLines.push([label, `(${moneyCcy(amount, currency)})`]);
  };
  addDeduction('Less: Employee NSSF (5%)', pick(r, 'nssf'));
  addDeduction('Less: PAYE (Income Tax)', pick(r, 'paye'));
  addDeduction('Less: Local Service Tax', pick(r, 'lst'));
  addDeduction('Less: Staff loan recovery', pick(r, 'loans'));
  addDeduction('Less: Salary advance recovery', pick(r, 'advances'));
  addDeduction('Less: Other deductions', pick(r, 'other_deductions'));
  payBreakdown.push(...deductionLines);
  payBreakdown.push(['Net Pay', moneyCcy(pick(r, 'net_pay'), currency)]);
  const paymentDate = dateOnly(pick(r, 'slip_payment_date', 'payment_date'));
  const notes = [
    'Confidential. Statutory deductions follow the rates configured for this period.',
  ];
  if (!published && !['RELEASED', 'PAID', 'POSTED', 'CLOSED'].includes(str(pick(r, 'payroll_status')))) {
    notes.push('This is a calculated slip. It has not been published as a final payslip.');
  }
  if (str(pick(r, 'payroll_reason'))) notes.push(`Payroll note: ${str(pick(r, 'payroll_reason'))}`);
  return {
    code: str(pick(r, 'payslip_no')),
    title: 'Payslip',
    kicker: 'Pay statement',
    currency,
    status,
    classification: 'Confidential',
    isPayslip: true,
    subtitle: lines(employeeName, period).join('  ·  ') || undefined,
    parties: [
      {
        heading: 'Employer',
        name: employerName,
        lines: lines(
          pick(r, 'company_address'),
          str(pick(r, 'company_phone')) ? `Phone: ${pick(r, 'company_phone')}` : '',
          str(pick(r, 'company_email')) ? `Email: ${pick(r, 'company_email')}` : '',
          str(pick(r, 'company_tin')) ? `TIN ${pick(r, 'company_tin')}` : ''
        ),
      },
      {
        heading: 'Employee',
        name: employeeName,
        lines: lines(
          str(pick(r, 'employee_no')) ? `Employee No ${pick(r, 'employee_no')}` : '',
          pick(r, 'position'),
          pick(r, 'department_name'),
          pick(r, 'address'),
          str(pick(r, 'phone')) ? `Phone: ${pick(r, 'phone')}` : '',
          str(pick(r, 'email')) ? `Email: ${pick(r, 'email')}` : ''
        ),
      },
    ],
    facts: [
      ['Payslip No', str(pick(r, 'payslip_no'))],
      ['Payroll No', str(pick(r, 'payroll_no'))],
      ['Period', period],
      ['Pay Date', paymentDate],
      ['Run Type', offCycle ? `${runType} · ${offCycle}` : runType],
      ['Currency', currency],
      ['TIN', str(pick(r, 'employee_tin'))],
      ['NSSF No', str(pick(r, 'nssf_no'))],
      ['Bank', bank],
      ['Taxable Pay', moneyCcy(pick(r, 'taxable_income'), currency)],
      ['Verification', str(pick(r, 'verification_code'))],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Employee acknowledgement', name: employeeName },
      { label: 'Payroll officer' },
    ],
    meta: [
      ['Payslip No', str(pick(r, 'payslip_no'))],
      ['Payroll No', str(pick(r, 'payroll_no'))],
      ['Employee', employeeName],
      ['Employee No', str(pick(r, 'employee_no'))],
      ['Period Start', dateOnly(pick(r, 'period_start'))],
      ['Period End', dateOnly(pick(r, 'period_end'))],
      ['Gross Pay', moneyCcy(pick(r, 'gross_pay'), currency)],
      ['Net Pay', moneyCcy(pick(r, 'net_pay'), currency)],
      ['Status', status],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    columns: [
      { key: 'kind', label: 'Type', weight: 1.1 },
      { key: 'component', label: 'Component', weight: 2.2 },
      { key: 'detail', label: 'Detail', weight: 2.6 },
      { key: 'amount', label: 'Amount', align: 'right', weight: 1.3 },
    ],
    items,
    totals: [
      ['Gross Pay', moneyCcy(pick(r, 'gross_pay'), currency)],
      ['Total Deductions', moneyCcy(pick(r, 'total_deductions'), currency)],
      ['Net Pay', moneyCcy(pick(r, 'net_pay'), currency)],
      ...(num(pick(r, 'employer_nssf')) ? ([['Employer NSSF', moneyCcy(pick(r, 'employer_nssf'), currency)]] as Array<[string, string]>) : []),
    ],
    notes,
    raw: r,
    photo,
    payBreakdown,
    payeBrackets: UG_PAYE_BRACKETS_2026,
  };
}

async function loadPayrollRegister(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const head = await client.query(
    `SELECT p.payroll_no, p.period_start, p.period_end, p.payment_date, p.status,
            p.currency, p.run_type, p.off_cycle_type, p.reason, p.validation_score, p.gl_posted,
            p.gross_total, p.deduction_total, p.net_total,
            c.name AS company_name, c.legal_name AS company_legal_name, c.address AS company_address,
            c.phone AS company_phone, c.email AS company_email, c.tin AS company_tin
     FROM payrolls p
     JOIN companies c ON c.id = p.company_id
     WHERE p.id = $1 AND p.tenant_id = $2 AND p.company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (head.rows.length === 0) throw notFound('Payroll not found');
  const h = head.rows[0] as Record<string, unknown>;

  const itemsRes = await client.query(
    `SELECT i.*,
            e.employee_no, e.first_name, e.last_name, e.position, e.status AS employee_status,
            e.nssf_no, e.tin AS employee_tin, e.bank_name, e.bank_account_no,
            d.name AS department_name, br.name AS branch_name
     FROM payroll_items i
     JOIN payrolls p ON p.id = i.payroll_id
     JOIN employees e ON e.id = i.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN branches br ON br.id = e.branch_id
     WHERE i.payroll_id = $1 AND p.tenant_id = $2 AND p.company_id = $3
     ORDER BY e.first_name, e.last_name`,
    [id, ctx.tenantId, ctx.companyId]
  );

  const sumsRes = await client.query(
    `SELECT count(i.employee_id)::int AS employee_count,
            COALESCE(sum(i.basic_pay), 0) AS basic_total,
            COALESCE(sum(i.allowances), 0) AS allowances_total,
            COALESCE(sum(i.gross_pay), 0) AS gross_total,
            COALESCE(sum(i.taxable_income), 0) AS taxable_total,
            COALESCE(sum(i.paye), 0) AS paye_total,
            COALESCE(sum(i.nssf), 0) AS nssf_total,
            COALESCE(sum(i.lst), 0) AS lst_total,
            COALESCE(sum(i.employer_nssf), 0) AS employer_nssf_total,
            COALESCE(sum(i.loans), 0) AS loans_total,
            COALESCE(sum(i.advances), 0) AS advances_total,
            COALESCE(sum(i.other_deductions), 0) AS other_deductions_total,
            COALESCE(sum(i.total_deductions), 0) AS deduction_total,
            COALESCE(sum(i.net_pay), 0) AS net_total
     FROM payroll_items i
     JOIN payrolls p ON p.id = i.payroll_id
     WHERE i.payroll_id = $1 AND p.tenant_id = $2 AND p.company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
  );
  const s = sumsRes.rows[0] as Record<string, unknown>;
  const currency = str(pick(h, 'currency')) || 'UGX';
  const employeeCount = num(pick(s, 'employee_count'));
  const period = lines(dateOnly(pick(h, 'period_start')), dateOnly(pick(h, 'period_end'))).join(' to ');
  const payrollStatus = statusLabel(pick(h, 'status'));
  const runType = statusLabel(pick(h, 'run_type')) || 'Normal';
  const offCycle = statusLabel(pick(h, 'off_cycle_type'));
  const glPosted = Boolean(pick(h, 'gl_posted'));
  const validation = pick(h, 'validation_score');
  const employerName = str(pick(h, 'company_legal_name')) || str(pick(h, 'company_name'));
  const paymentDate = dateOnly(pick(h, 'payment_date'));

  const items: Array<Record<string, unknown>> = (itemsRes.rows as Array<Record<string, unknown>>).map((r) => {
    const name = lines(pick(r, 'first_name'), pick(r, 'last_name')).join(' ');
    return {
      employee: name,
      employeeNo: str(pick(r, 'employee_no')),
      department: str(pick(r, 'department_name')),
      branch: str(pick(r, 'branch_name')),
      basicPay: money(pick(r, 'basic_pay')),
      allowances: money(pick(r, 'allowances')),
      grossPay: money(pick(r, 'gross_pay')),
      taxableIncome: money(pick(r, 'taxable_income')),
      paye: money(pick(r, 'paye')),
      nssf: money(pick(r, 'nssf')),
      lst: money(pick(r, 'lst')),
      employerNssf: money(pick(r, 'employer_nssf')),
      loans: money(pick(r, 'loans')),
      advances: money(pick(r, 'advances')),
      otherDeductions: money(pick(r, 'other_deductions')),
      totalDeductions: money(pick(r, 'total_deductions')),
      netPay: money(pick(r, 'net_pay')),
      payslipNo: str(pick(r, 'payslip_no')),
    };
  });

  const notes = [
    'This register lists every employee line on the payroll run for the period shown. Amounts are in the payroll currency.',
    'PAYE, NSSF and Local Service Tax are calculated from the statutory configuration in force for this payroll period under Ugandan law.',
  ];
  if (!['RELEASED', 'PAID', 'POSTED', 'CLOSED'].includes(str(pick(h, 'status')))) {
    notes.push('This is a draft register. It has not been released as a final payroll.');
  }
  if (str(pick(h, 'reason'))) notes.push(`Payroll note: ${str(pick(h, 'reason'))}`);

  return {
    code: str(pick(h, 'payroll_no')),
    title: 'Payroll Register',
    kicker: 'Payroll document',
    currency,
    status: payrollStatus,
    classification: 'Confidential',
    subtitle: lines(employerName, period).join('  \u00b7  ') || undefined,
    parties: [
      {
        heading: 'Employer',
        name: employerName,
        lines: lines(
          pick(h, 'company_address'),
          str(pick(h, 'company_phone')) ? `Phone: ${pick(h, 'company_phone')}` : '',
          str(pick(h, 'company_email')) ? `Email: ${pick(h, 'company_email')}` : '',
          str(pick(h, 'company_tin')) ? `TIN ${pick(h, 'company_tin')}` : ''
        ),
      },
    ],
    facts: [
      ['Payroll No', str(pick(h, 'payroll_no'))],
      ['Period', period],
      ['Pay Date', paymentDate],
      ['Run Type', offCycle ? `${runType} \u00b7 ${offCycle}` : runType],
      ['Currency', currency],
      ['Employees', String(employeeCount)],
      ['Validation', validation == null ? '-' : `${str(validation)}%`],
      ['GL Posting', glPosted ? 'Posted' : 'Open'],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    signatures: [
      { label: 'Prepared by' },
      { label: 'Authorised signatory' },
    ],
    meta: [
      ['Payroll No', str(pick(h, 'payroll_no'))],
      ['Period Start', dateOnly(pick(h, 'period_start'))],
      ['Period End', dateOnly(pick(h, 'period_end'))],
      ['Pay Date', paymentDate],
      ['Currency', currency],
      ['Employees', String(employeeCount)],
      ['Gross Pay', moneyCcy(pick(s, 'gross_total'), currency)],
      ['Net Pay', moneyCcy(pick(s, 'net_total'), currency)],
      ['Status', payrollStatus],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    columns: [
      { key: 'employee', label: 'Employee', weight: 2.2 },
      { key: 'employeeNo', label: 'Emp No', weight: 0.9 },
      { key: 'department', label: 'Department', weight: 1.4 },
      { key: 'basicPay', label: 'Basic', align: 'right', weight: 1.0 },
      { key: 'allowances', label: 'Allow.', align: 'right', weight: 0.9 },
      { key: 'grossPay', label: 'Gross', align: 'right', weight: 1.0 },
      { key: 'taxableIncome', label: 'Taxable', align: 'right', weight: 1.0 },
      { key: 'paye', label: 'PAYE', align: 'right', weight: 0.9 },
      { key: 'nssf', label: 'NSSF', align: 'right', weight: 0.9 },
      { key: 'lst', label: 'LST', align: 'right', weight: 0.8 },
      { key: 'employerNssf', label: 'Er NSSF', align: 'right', weight: 0.9 },
      { key: 'loans', label: 'Loans', align: 'right', weight: 0.9 },
      { key: 'advances', label: 'Advances', align: 'right', weight: 0.9 },
      { key: 'otherDeductions', label: 'Other', align: 'right', weight: 0.9 },
      { key: 'totalDeductions', label: 'Total Ded.', align: 'right', weight: 1.0 },
      { key: 'netPay', label: 'Net', align: 'right', weight: 1.1 },
    ],
    items,
    totals: [
      ['Employees', String(employeeCount)],
      ['Total Basic Pay', moneyCcy(pick(s, 'basic_total'), currency)],
      ['Total Allowances', moneyCcy(pick(s, 'allowances_total'), currency)],
      ['Total Gross Pay', moneyCcy(pick(s, 'gross_total'), currency)],
      ['Taxable Income', moneyCcy(pick(s, 'taxable_total'), currency)],
      ['PAYE', moneyCcy(pick(s, 'paye_total'), currency)],
      ['NSSF (employee)', moneyCcy(pick(s, 'nssf_total'), currency)],
      ['Local Service Tax', moneyCcy(pick(s, 'lst_total'), currency)],
      ['Employer NSSF', moneyCcy(pick(s, 'employer_nssf_total'), currency)],
      ['Staff loans', moneyCcy(pick(s, 'loans_total'), currency)],
      ['Salary advances', moneyCcy(pick(s, 'advances_total'), currency)],
      ['Other deductions', moneyCcy(pick(s, 'other_deductions_total'), currency)],
      ['Total Deductions', moneyCcy(pick(s, 'deduction_total'), currency)],
      ['Net Pay', moneyCcy(pick(s, 'net_total'), currency)],
    ],
    notes,
    raw: { payroll: h, items: itemsRes.rows, totals: s },
  };
}

async function qrPngOf(payload: string): Promise<Buffer | undefined> {
  const token = String(payload ?? '').trim();
  if (!token) return undefined;
  try {
    return await QRCode.toBuffer(token, { type: 'png', width: 280, margin: 1, errorCorrectionLevel: 'M' });
  } catch {
    return undefined;
  }
}

async function employeeIdDocFromRow(
  row: Record<string, unknown>,
  extra: { cardNo?: string; serial?: string; issueDate?: string; expiryDate?: string; qrToken?: string }
): Promise<DocData> {
  const official = str(pick(row, 'employee_number', 'employeeNumber')) || str(pick(row, 'employee_no', 'employeeNo'));
  const shortId = str(pick(row, 'short_employee_number', 'shortEmployeeNumber'));
  const fullName = lines(pick(row, 'first_name', 'firstName'), pick(row, 'last_name', 'lastName')).join(' ');
  const department = str(pick(row, 'department_name', 'departmentName'));
  const position = str(pick(row, 'position_title', 'positionTitle', 'position'));
  const company = str(pick(row, 'company_legal_name', 'companyLegalName')) || str(pick(row, 'company_name', 'companyName'));
  const status = statusLabel(pick(row, 'employee_status', 'status'));
  const cardNo = extra.cardNo || '';
  const photoFile = readEmployeePhotoFile(pick(row, 'photo_path', 'photoPath'), pick(row, 'photo_mime', 'photoMime'));
  const photo = photoFile
    ? {
        bytes: photoFile.bytes,
        mime: photoFile.mime,
        dataUrl: `data:${photoFile.mime};base64,${photoFile.bytes.toString('base64')}`,
        caption: 'Passport photograph',
      }
    : undefined;
  const qrToken = extra.qrToken || '';
  const qrPng = await qrPngOf(qrToken);
  return {
    code: cardNo || official || 'EMPLOYEE-ID',
    title: 'Employee Identity Card',
    kicker: 'HR identity',
    status,
    classification: 'Internal',
    subtitle: lines(fullName, official).join('  ·  ') || undefined,
    isIdCard: true,
    photo,
    qrPng,
    qrToken,
    facts: [
      ['Official ID', official],
      ['Badge ID', shortId],
      ['Employee', fullName],
      ['Department', department],
      ['Position', position],
      ['Company', company],
      ['Card No', cardNo],
      ['Serial', extra.serial || ''],
      ['Issued', extra.issueDate || ''],
      ['Expires', extra.expiryDate || ''],
      ['Status', status],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    meta: [
      ['Official ID', official],
      ['Badge ID', shortId],
      ['Name', fullName],
      ['Card No', cardNo],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>,
    columns: [],
    items: [],
    totals: [],
    notes: [
      'This identity card remains the property of the employer. If found, return it to Human Resources.',
      'The official employee ID never changes. Card numbers and QR tokens may be replaced if a card is lost or damaged.',
    ],
    raw: { ...row, ...extra, official, shortId, fullName, department, position, company },
  };
}

async function loadEmployeeId(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const res = await client.query(
    `SELECT e.*, d.name AS department_name, b.name AS branch_name, pos.title AS position_title,
            c.name AS company_name, c.legal_name AS company_legal_name,
            (SELECT i.identity_number FROM employee_identities i
              WHERE i.employee_id = e.id AND i.identity_type = 'QR_IDENTITY' AND i.status <> 'REVOKED'
              ORDER BY i.created_at DESC LIMIT 1) AS qr_token,
            (SELECT card.card_no FROM employee_id_cards card
              WHERE card.employee_id = e.id AND card.status IN ('ACTIVE','DRAFT')
              ORDER BY CASE WHEN card.status = 'ACTIVE' THEN 0 ELSE 1 END, card.id DESC LIMIT 1) AS active_card_no,
            (SELECT card.serial_number FROM employee_id_cards card
              WHERE card.employee_id = e.id AND card.status IN ('ACTIVE','DRAFT')
              ORDER BY CASE WHEN card.status = 'ACTIVE' THEN 0 ELSE 1 END, card.id DESC LIMIT 1) AS active_serial,
            (SELECT card.issue_date FROM employee_id_cards card
              WHERE card.employee_id = e.id AND card.status IN ('ACTIVE','DRAFT')
              ORDER BY CASE WHEN card.status = 'ACTIVE' THEN 0 ELSE 1 END, card.id DESC LIMIT 1) AS active_issue_date,
            (SELECT card.expiry_date FROM employee_id_cards card
              WHERE card.employee_id = e.id AND card.status IN ('ACTIVE','DRAFT')
              ORDER BY CASE WHEN card.status = 'ACTIVE' THEN 0 ELSE 1 END, card.id DESC LIMIT 1) AS active_expiry_date
     FROM employees e
     JOIN companies c ON c.id = e.company_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN branches b ON b.id = e.branch_id
     LEFT JOIN positions pos ON pos.id = e.position_id
     WHERE e.id = $1 AND e.tenant_id = $2 AND e.company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Employee not found');
  const row = res.rows[0] as Record<string, unknown>;
  return employeeIdDocFromRow(row, {
    cardNo: str(pick(row, 'active_card_no')),
    serial: str(pick(row, 'active_serial')),
    issueDate: dateOnly(pick(row, 'active_issue_date', 'hire_date')),
    expiryDate: dateOnly(pick(row, 'active_expiry_date')),
    qrToken: str(pick(row, 'qr_token')),
  });
}

async function loadEmployeeIdCard(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  const res = await client.query(
    `SELECT e.*, d.name AS department_name, b.name AS branch_name, pos.title AS position_title,
            c.name AS company_name, c.legal_name AS company_legal_name,
            card.card_no, card.serial_number, card.issue_date, card.expiry_date, card.status AS card_status,
            (SELECT i.identity_number FROM employee_identities i
              WHERE i.employee_id = e.id AND i.identity_type = 'QR_IDENTITY' AND i.status <> 'REVOKED'
              ORDER BY i.created_at DESC LIMIT 1) AS qr_token
     FROM employee_id_cards card
     JOIN employees e ON e.id = card.employee_id
     JOIN companies c ON c.id = e.company_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN branches b ON b.id = e.branch_id
     LEFT JOIN positions pos ON pos.id = e.position_id
     WHERE card.id = $1 AND card.tenant_id = $2 AND e.company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Employee ID card not found');
  const row = res.rows[0] as Record<string, unknown>;
  await client.query(
    `UPDATE employee_id_cards SET printed_at = COALESCE(printed_at, now()), printed_by = COALESCE(printed_by, $2)
      WHERE id = $1`,
    [id, ctx.userId ?? null]
  );
  return employeeIdDocFromRow(row, {
    cardNo: str(pick(row, 'card_no')),
    serial: str(pick(row, 'serial_number')),
    issueDate: dateOnly(pick(row, 'issue_date', 'hire_date')),
    expiryDate: dateOnly(pick(row, 'expiry_date')),
    qrToken: str(pick(row, 'qr_token')),
  });
}

export async function loadEmployeeIdRegister(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string } = {}
): Promise<DocData> {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['e.tenant_id = $1', 'e.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(
      `(COALESCE(e.employee_number,'') ILIKE $${params.length} OR COALESCE(e.short_employee_number,'') ILIKE $${params.length}
        OR e.employee_no ILIKE $${params.length} OR e.first_name ILIKE $${params.length}
        OR e.last_name ILIKE $${params.length} OR COALESCE(e.position,'') ILIKE $${params.length})`
    );
  }
  if (filters.status?.trim()) {
    params.push(filters.status.trim());
    where.push(`e.status = $${params.length}`);
  }
  const res = await client.query(
    `SELECT e.id, e.employee_no, e.employee_number, e.short_employee_number, e.first_name, e.last_name,
            e.position, e.status, d.name AS department_name,
            (SELECT count(*)::int FROM employee_id_cards c WHERE c.employee_id = e.id AND c.status = 'ACTIVE') AS active_cards,
            (SELECT count(*)::int FROM employee_identities i WHERE i.employee_id = e.id AND i.identity_type = 'QR_IDENTITY' AND i.status <> 'REVOKED') AS has_qr
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ${where.join(' AND ')}
     ORDER BY e.last_name, e.first_name
     LIMIT 500`,
    params
  );
  const items = res.rows.map((r) => {
    const rec = r as Record<string, unknown>;
    return {
      official: str(pick(rec, 'employee_number')) || str(pick(rec, 'employee_no')),
      badge: str(pick(rec, 'short_employee_number')),
      name: lines(pick(rec, 'first_name'), pick(rec, 'last_name')).join(' '),
      department: str(pick(rec, 'department_name')),
      position: str(pick(rec, 'position')),
      status: statusLabel(pick(rec, 'status')),
      cards: String(pick(rec, 'active_cards') ?? 0),
      qr: Number(pick(rec, 'has_qr') ?? 0) > 0 ? 'Yes' : 'No',
    };
  });
  return {
    code: 'EMP-ID-REGISTER',
    title: 'Employee ID Register',
    kicker: 'HR identity',
    classification: 'Internal',
    subtitle: `${items.length} employee${items.length === 1 ? '' : 's'}`,
    facts: [['Records', String(items.length)]],
    meta: [['Records', String(items.length)]],
    columns: [
      { key: 'official', label: 'Official ID', weight: 1.4 },
      { key: 'badge', label: 'Badge', weight: 1 },
      { key: 'name', label: 'Name', weight: 1.6 },
      { key: 'department', label: 'Department', weight: 1.2 },
      { key: 'position', label: 'Position', weight: 1.2 },
      { key: 'status', label: 'Status', weight: 0.9 },
      { key: 'cards', label: 'Cards', align: 'right', weight: 0.6 },
      { key: 'qr', label: 'QR', weight: 0.5 },
    ],
    items,
    totals: [['Employees', String(items.length)]],
    notes: ['Official IDs are permanent. Badge numbers and QR tokens may change when a card is replaced.'],
    raw: { rows: items },
  };
}

/**
 * The caller's own payslip.
 *
 * The same document the HR workspace renders, reached through the employee
 * portal instead. Ownership is proved by joining the payslip back to the
 * employee behind the authenticated user, so an employee who guesses a
 * colleague's payslip id gets a not-found answer rather than their pay.
 */
async function loadMyPayslip(client: pg.PoolClient, ctx: Ctx, id: number): Promise<DocData> {
  if (!ctx.userId) throw notFound('Payslip not found');
  // The portal identifies a published payslip by `payslips.id` - that is the id the
  // employee sees in the payslip list and the net-pay trend - so ownership is proven
  // against the payslip row itself. The rendered document is produced from the payroll
  // item the slip was published for, which is what holds the frozen calculation.
  const owned = await client.query(
    `SELECT i.id AS item_id
       FROM payslips s
       JOIN users u ON u.employee_id = s.employee_id AND u.tenant_id = s.tenant_id
       LEFT JOIN payroll_items i ON i.payroll_id = s.payroll_id AND i.employee_id = s.employee_id
      WHERE s.id = $1 AND u.id = $2 AND s.tenant_id = $3 AND s.company_id = $4
        AND s.status = 'PUBLISHED'`,
    [id, ctx.userId, ctx.tenantId, ctx.companyId]
  );
  const itemId = owned.rows[0] ? owned.rows[0].item_id : null;
  if (itemId == null) throw notFound('Payslip not found');
  return loadPayslip(client, ctx, Number(itemId));
}

export const DOCUMENT_TYPES: Record<string, DocumentTypeDef> = {
  expense: { type: 'expense', label: 'Expense Voucher', permission: 'finance.expenses.view', load: loadExpense },
  budget: { type: 'budget', label: 'Budget', permission: 'finance.budgets.view', load: loadBudget },
  'sales-quotation': { type: 'sales-quotation', label: 'Sales Quotation', permission: 'sales.quotations.view', load: loadQuotation },
  'sales-order': { type: 'sales-order', label: 'Sales Order', permission: 'sales.orders.view', load: loadSalesOrder },
  'delivery-note': { type: 'delivery-note', label: 'Delivery Note', permission: 'sales.delivery_notes.view', load: loadDeliveryNote },
  'packing-list': { type: 'packing-list', label: 'Packing List', permission: 'sales.delivery_notes.view', load: loadPackingList },
  'proof-of-delivery': { type: 'proof-of-delivery', label: 'Proof of Delivery', permission: 'sales.delivery_notes.view', load: loadProofOfDelivery },
  'sales-invoice': { type: 'sales-invoice', label: 'Sales Invoice', permission: 'sales.invoices.view', load: loadSalesInvoice },
  receipt: { type: 'receipt', label: 'Receipt', permission: 'sales.receipts.view', load: loadReceipt },
  'credit-note': { type: 'credit-note', label: 'Credit Note', permission: 'sales.credit_notes.view', load: loadCreditNote },
  'debit-note': { type: 'debit-note', label: 'Debit Note', permission: 'sales.debit_notes.view', load: loadDebitNote },
  'sales-return': { type: 'sales-return', label: 'Returned Goods Note', permission: 'sales.returns.view', load: loadSalesReturn },
  requisition: { type: 'requisition', label: 'Purchase Requisition', permission: 'procurement.requisitions.view', load: loadRequisition },
  rfq: { type: 'rfq', label: 'Request for Quotation', permission: 'procurement.rfqs.view', load: loadRfq },
  'purchase-order': { type: 'purchase-order', label: 'Purchase Order', permission: 'procurement.orders.view', load: loadPurchaseOrder },
  'goods-receipt': { type: 'goods-receipt', label: 'Goods Received Note', permission: 'procurement.goods_receipts.view', load: loadGoodsReceipt },
  'purchase-invoice': { type: 'purchase-invoice', label: 'Supplier Invoice', permission: 'procurement.supplier_invoices.view', load: loadSupplierInvoice },
  'supplier-payment': { type: 'supplier-payment', label: 'Payment Voucher', permission: 'procurement.payments.view', load: loadSupplierPayment },
  'purchase-return': { type: 'purchase-return', label: 'Supplier Return Note', permission: 'procurement.returns.view', load: loadPurchaseReturn },
  'supplier-quotation': { type: 'supplier-quotation', label: 'Supplier Quotation', permission: 'procurement.quotations.view', load: loadSupplierQuotation },
  'bid-analysis': { type: 'bid-analysis', label: 'Bid Analysis', permission: 'procurement.rfqs.view', load: loadBidAnalysis },
  inspection: { type: 'inspection', label: 'Incoming Inspection Report', permission: 'quality.inspections.view', load: loadInspection },
  journal: { type: 'journal', label: 'Journal Entry', permission: 'finance.journals.view', load: loadJournal },
  'employment-contract': { type: 'employment-contract', label: 'Employment Contract', permission: 'hr.contracts.view', load: loadEmploymentContract },
  'certificate-of-service': { type: 'certificate-of-service', label: 'Certificate of Service', permission: 'hr.certificates.view', load: loadCertificateOfService },
  payslip: { type: 'payslip', label: 'Payslip', permission: 'hr.payslips.view', load: loadPayslip },
  'my-payslip': { type: 'my-payslip', label: 'Payslip', permission: 'hr.employee_payroll.self_view', load: loadMyPayslip },
  'payroll-register': { type: 'payroll-register', label: 'Payroll Register', permission: 'hr.payrolls.view', load: loadPayrollRegister },
  'employee-id': { type: 'employee-id', label: 'Employee Identity Card', permission: 'hr.employee_identity.view', load: loadEmployeeId },
  'employee-id-card': { type: 'employee-id-card', label: 'Employee ID Card', permission: 'hr.employee_card.view', load: loadEmployeeIdCard },
};

export interface EmploymentContractToken {
  token: string;
  verifyUrl: string;
  issuedAt: string;
  reason: string | null;
}

/**
 * Issue a signed verification token for an employment contract using exactly
 * the same load + fingerprint path as /api/documents/:type/:id, so a QR
 * encoding the returned URL auto-verifies through /api/public/verify-document.
 */
export async function issueEmploymentContractToken(
  client: pg.PoolClient,
  ctx: Ctx,
  contractId: number,
  issuer?: { email?: string; name?: string }
): Promise<EmploymentContractToken> {
  const def = DOCUMENT_TYPES['employment-contract'];
  const loaded = await def.load(client, ctx, contractId);
  const company = await loadCompanyProfile(client, ctx);
  const issuedAt = new Date().toISOString();
  if (!company.verifyEnabled) {
    return { token: '', verifyUrl: '', issuedAt, reason: 'VERIFY_DISABLED' };
  }
  const fingerprint = documentFingerprint({
    code: loaded.code,
    title: loaded.title,
    subtitle: loaded.subtitle,
    meta: loaded.meta,
    columns: loaded.columns,
    items: loaded.items,
    totals: loaded.totals,
    notes: loaded.notes,
  });
  const email = issuer?.email ?? 'system';
  const name = issuer?.name ?? 'HR portal';
  const token = issueDocumentToken({
    type: def.type,
    id: contractId,
    code: loaded.code,
    title: loaded.title,
    fingerprint,
    issuedAt,
    tenantId: ctx.tenantId ?? 0,
    companyId: ctx.companyId ?? null,
    companyName: company.name,
    issuer: email,
    issuerName: name,
  });
  return { token, verifyUrl: documentVerifyUrl(company, token), issuedAt, reason: null };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const GRAY = BRAND.gray;
const LINE = BRAND.line;
const INK = BRAND.ink;
const TABLE_W = PAGE_W - MARGIN * 2;

export interface DocumentRenderOpts {
  company: CompanyProfile;
  issuedBy: string;
  issuedAt: string;
  signerName?: string;
  signerRole?: string;
  correlationId?: string | null;
  fingerprint?: string;
  token?: string;
  verifyUrl?: string;
  classification?: string;
  status?: string;
}

const authEnabled = (opts: DocumentRenderOpts): boolean =>
  Boolean(opts.token && opts.verifyUrl && opts.fingerprint);

const statusOf = (data: DocData, opts: DocumentRenderOpts): string =>
  opts.status ?? data.status ?? data.meta.find(([label]) => /^status$/i.test(label))?.[1] ?? '';

const classifOf = (data: DocData, opts: DocumentRenderOpts): string =>
  opts.classification ?? data.classification ?? 'Internal';

/**
 * Project a business document onto the shared letterhead shape so the PDF
 * renderers draw exactly the same branded header as the export pipeline.
 */
const letterheadMeta = (data: DocData, opts: DocumentRenderOpts, status: string): LetterheadMeta => ({
  title: data.title,
  subtitle: data.subtitle,
  kicker: data.kicker,
  docNo: data.code,
  status,
  company: opts.company,
});

/** Signature labels that belong to an external party and must stay blank for a physical signature. */
const EXTERNAL_SIGNATURE_RE = /customer|driver|supplier|acknowledg|acceptance|witness|^employee$/i;

/**
 * Pre-fill company signature blocks from the auto-sign settings. Lines already
 * carrying a name or execution date, external-party lines (customer, driver,
 * supplier, witness, employee) are left untouched so they can still be signed
 * physically. On contracts only the company-side block (Employer Representative)
 * is auto-signed; employee and witness blocks stay for the real signatories.
 */
function applyAutoSignatures(data: DocData, opts: DocumentRenderOpts): DocData {
  if (!opts.company.autoSignEnabled) return data;
  const signer = (opts.company.autoSignName || opts.signerName || opts.company.legalName || opts.company.name).trim();
  if (!signer) return data;
  const role = (opts.company.autoSignRole || opts.signerRole || '').trim();
  const signedAt = opts.issuedAt;
  const source = data.signatures ?? [];
  const signs = source.map((s) => {
    if (s.name || s.signedAt || s.auto) return s;
    if (data.isContract) {
      if (!/employer|company|authorised|representative/i.test(s.label)) return s;
    } else if (EXTERNAL_SIGNATURE_RE.test(s.label)) {
      return s;
    }
    return { ...s, name: signer, role, signedAt, auto: true, signatureUrl: opts.company.signatureUrl || undefined };
  });
  if (signs.every((s, i) => s === source[i])) return data;
  return { ...data, signatures: signs };
}

/** Map contract_signatures rows into DocSignature blocks (executed rows carry name + date). */
function contractSignatures(out: { signatures?: Array<Record<string, unknown>> }): DocSignature[] {
  const rows = (out.signatures ?? []) as Array<Record<string, unknown>>;
  const byType = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const t = str(pick(r, 'signerType', 'signer_type')).toUpperCase();
    if (t && !byType.has(t)) byType.set(t, r);
  }
  const block = (type: string, label: string, role?: string): DocSignature => {
    const r = byType.get(type);
    const signed = Boolean(r && String(pick(r, 'status')) === 'SIGNED');
    return {
      label,
      role,
      name: signed ? str(pick(r, 'signerName', 'signer_name')) || undefined : undefined,
      signedAt: signed ? String(pick(r, 'signedAt', 'signed_at')) : undefined,
      signatureUrl: signed ? str(pick(r, 'signatureUrl', 'signature_url')) || undefined : undefined,
    };
  };
  return [
    block('EMPLOYEE', 'Employee'),
    block('EMPLOYER_REPRESENTATIVE', 'Employer Representative'),
    block('WITNESS', 'Witness'),
  ];
}

/** Hard wrap: word-wrap like wrapText, but also breaks words that exceed maxWidth. */
function wrapHard(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const out: string[] = [];
  const words = String(text).split(/\s+/).filter(Boolean);
  let line = '';
  const flush = () => {
    if (line) {
      out.push(line);
      line = '';
    }
  };
  for (const word of words) {
    let w = word;
    while (textWidth(w, size, bold) > maxWidth) {
      flush();
      let cut = 1;
      while (cut < w.length && textWidth(w.slice(0, cut + 1), size, bold) <= maxWidth) cut++;
      out.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const candidate = line ? line + ' ' + w : w;
    if (!line || textWidth(candidate, size, bold) <= maxWidth) line = candidate;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** Collapse a date range to a compact form, e.g. "01 Sep 2026 to 30 Sep 2026" -> "01 Sep - 30 Sep 2026". */
function compactRange(text: string): string {
  const t = String(text ?? '').trim();
  const m = t.match(/^(.+?)\s+(?:to|through|until|\u2013|\u2014|-)\s+(.+)$/i);
  if (!m) return t;
  const from = m[1].trim();
  const to = m[2].trim();
  const fd = from.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  const td = to.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (fd && td) {
    if (fd[2].toLowerCase() === td[2].toLowerCase() && fd[3] === td[3]) return fd[1] + ' \u2013 ' + td[1] + ' ' + td[2] + ' ' + td[3];
    if (fd[3] === td[3]) return fd[1] + ' ' + fd[2] + ' \u2013 ' + td[1] + ' ' + td[2] + ' ' + td[3];
  }
  return from + ' \u2013 ' + to;
}

/** Draw one line, shrinking to `floor` then ellipsizing, so a value can never leave its column. */
function fitLine(
  doc: PdfDoc,
  text: string,
  x: number,
  y: number,
  size: number,
  style: PdfTextStyle,
  maxWidth: number,
  floor = 6
): void {
  const bold = style.bold ?? false;
  let s = size;
  while (s > floor && textWidth(text, s, bold) > maxWidth) s -= 0.25;
  let value = text;
  if (textWidth(value, s, bold) > maxWidth) {
    const room = maxWidth - textWidth('\u2026', s, bold);
    let cut = value.length;
    while (cut > 1 && textWidth(value.slice(0, cut), s, bold) > room) cut -= 1;
    value = value.slice(0, cut).replace(/[\s,;:.\u00b7-]+$/, '') + '\u2026';
  }
  doc.rawText(value, x, y, s, { ...style, maxWidth });
}

function drawParties(doc: PdfDoc, parties: DocParty[], brand: DocBrand, photoName?: string | null, photoCaption?: string): void {
  const list = parties.filter((p) => p.name);
  if (!list.length && !photoName) return;
  const gap = 10;
  const photoW = photoName ? 86 : 0;
  const usable = TABLE_W - (photoName ? photoW + gap : 0);
  const cols = Math.min(2, Math.max(list.length, 1));
  const colW = list.length ? (usable - gap * (cols - 1)) / cols : usable;
  const pad = 8;
  const sizeName = 10;
  const sizeLine = 7.6;
  const heights = list.map((p) => {
    const nameLines = wrapHard(p.name, sizeName, true, colW - pad * 2);
    const body = p.lines.flatMap((ln) => wrapHard(ln, sizeLine, false, colW - pad * 2));
    return 16 + nameLines.length * 13 + body.length * 10 + pad;
  });
  const photoH = photoName ? 128 : 0;
  const h = Math.max(...heights, photoH, 42);
  if (doc.cursorY - h < BOTTOM) doc.newPage();
  const top = doc.cursorY;
  list.forEach((p, i) => {
    const x = MARGIN + i * (colW + gap);
    doc.rect(x, top - h, colW, h, BRAND.headerFill);
    doc.rect(x, top - h, 2.6, h, brand.teal);
    doc.rawText(p.heading.toUpperCase(), x + pad, top - 11, 6.4, { color: brand.teal, bold: true, maxWidth: colW - pad * 2 });
    let y = top - 24;
    for (const ln of wrapHard(p.name, sizeName, true, colW - pad * 2)) {
      doc.rawText(ln, x + pad, y, sizeName, { color: brand.navy, bold: true, maxWidth: colW - pad * 2 });
      y -= 13;
    }
    for (const ln of p.lines.flatMap((l) => wrapHard(l, sizeLine, false, colW - pad * 2))) {
      doc.rawText(ln, x + pad, y, sizeLine, { color: INK, maxWidth: colW - pad * 2 });
      y -= 10;
    }
  });
  if (photoName) {
    const x = MARGIN + usable + gap;
    const imgW = 70;
    const imgH = 90;
    doc.rect(x, top - h, photoW, h, BRAND.headerFill);
    doc.rect(x, top - h, 2.6, h, brand.teal);
    doc.rawText('PHOTOGRAPH', x + pad, top - 11, 6.4, { color: brand.teal, bold: true, maxWidth: photoW - pad * 2 });
    const imgX = x + (photoW - imgW) / 2;
    const imgY = top - 18 - imgH;
    doc.strokeRect(imgX - 1.2, imgY - 1.2, imgW + 2.4, imgH + 2.4, brand.navy, 0.7);
    doc.image(photoName, imgX, imgY, imgW, imgH);
    doc.rawText((photoCaption ?? 'Passport photograph').toUpperCase(), x + 4, imgY - 10, 5.8, {
      color: GRAY,
      bold: true,
      maxWidth: photoW - 8,
      align: 'center',
    });
  }
  doc.cursorY = top - h - 12;
}

function drawTotals(doc: PdfDoc, totals: Array<[string, string]>, brand: DocBrand): void {
  if (!totals.length) return;
  const boxW = 228;
  const x = MARGIN + TABLE_W - boxW;
  const rowH = 16;
  const grand = totals.length - 1;
  const h = totals.length * rowH + 12;
  if (doc.cursorY - h < BOTTOM) doc.newPage();
  const top = doc.cursorY;
  doc.rect(x, top - h, boxW, h, BRAND.headerFill);
  doc.rect(x, top - h, 2.6, h, brand.teal);
  let y = top - 6;
  totals.forEach(([label, value], i) => {
    const last = i === grand;
    if (last) {
      doc.rect(x, y - rowH - 2, boxW, rowH + 6, brand.navy);
      doc.rect(x, y - rowH - 2, 2.6, rowH + 6, brand.teal);
      doc.rawText(label.toUpperCase(), x + 10, y - 11, 8.2, { bold: true, color: BRAND.white, maxWidth: boxW * 0.48 });
      doc.rawText(value, x + 8, y - 11, 9.4, { bold: true, color: BRAND.white, align: 'right', maxWidth: boxW - 16 });
    } else {
      doc.rawText(label, x + 10, y - 10, 7.8, { color: GRAY, maxWidth: boxW * 0.5 });
      doc.rawText(value, x + 8, y - 10, 8.4, { bold: true, color: INK, align: 'right', maxWidth: boxW - 16 });
      doc.line(x + 10, y - rowH, x + boxW - 8, y - rowH, LINE, 0.35);
    }
    y -= rowH;
  });
  doc.cursorY = top - h - 8;
}

interface PaySlipGridLayout {
  colGap: number;
  colW: number;
  bandH: number;
  headH: number;
  pad: number;
  footSize: number;
  lineStep: number;
  footW: number;
  footLines: string[];
  rowH: number;
  left: Array<[string, string]>;
  right: Array<[string, string]>;
  colBody: number;
  height: number;
}

/**
 * Lay out the compact two-column payslip footer: the net-pay calculation on the left
 * and the PAYE brackets applied on the right. Side-by-side columns are what keep a
 * full statement on one page without shrinking any type.
 *
 * `maxH` is the exact height the caller has reserved, so the grid can never push the
 * terms, signature and authenticity blocks below it onto a second page. Rows only fold
 * when a statement is long enough that it cannot fit even at the tightest row height.
 * Returns null when there is nothing worth drawing.
 */
function paySlipGridLayout(data: DocData, maxH: number): PaySlipGridLayout | null {
  const left0 = (data.payBreakdown ?? []).filter((r) => r && String(r[0] ?? '').trim());
  const right0 = (data.payeBrackets?.bands ?? []).filter((b) => b && String(b[0] ?? '').trim());
  const note = String(data.payeBrackets?.note ?? '').trim();
  if (!left0.length && !right0.length && !note) return null;

  const colGap = 12;
  const colW = (TABLE_W - colGap) / 2;
  const bandH = 16;
  const headH = 11;
  const pad = 7;
  const footSize = 6.2;
  const lineStep = footSize * 1.42;
  const footW = colW - 16;
  const footLines = note ? wrapHard(note, footSize, false, footW) : [];
  const footBlock = footLines.length ? footLines.length * lineStep + 5 : 0;

  const MIN_ROW = 8.5;
  // The columns may use whatever the caller reserved, less the 6 pt the drawer leaves
  // under them, so the height returned by this function is honoured to the point.
  const body = maxH - (bandH + 5 + headH + pad + 6);
  if (body < MIN_ROW) return null;

  // Both columns share one row height so the two tables line up across the page.
  const fold = (list: Array<[string, string]>, max: number): Array<[string, string]> =>
    list.length <= max
      ? list
      : [...list.slice(0, Math.max(0, max - 1)), [String(list.length - (max - 1)) + ' further lines', ''] as [string, string]];

  // The rate table carries the statutory note under it, so it has less room per row. When
  // the note cannot fit at all it is dropped rather than pushing the grid off the page.
  const noteRoom = body - Math.max(MIN_ROW, right0.length * MIN_ROW);
  const keepNote = !left0.length && !right0.length ? footBlock > 0 : footBlock <= noteRoom;
  const foot = keepNote ? footLines : [];
  const footUse = keepNote ? footBlock : 0;

  const fits = (lh: Array<[string, string]>, rh: Array<[string, string]>, h: number): boolean =>
    lh.length * h <= body && rh.length * h + footUse <= body;

  let left = left0;
  let right = right0;
  let rowH = 15;
  while (rowH > 12 && !fits(left, right, rowH)) rowH -= 1;
  if (!fits(left, right, rowH)) {
    left = fold(left, Math.max(1, Math.floor(body / MIN_ROW)));
    right = fold(right, Math.max(1, Math.floor((body - footUse) / MIN_ROW)));
    rowH = 12;
    while (rowH > MIN_ROW && !fits(left, right, rowH)) rowH -= 0.5;
  }
  if (!fits(left, right, rowH)) return null;

  const colBody = Math.max(left.length * rowH, right.length * rowH + footUse);
  const height = bandH + 5 + headH + colBody + pad + 6;
  return { colGap, colW, bandH, headH, pad, footSize, lineStep, footW, footLines: foot, rowH, left, right, colBody, height };
}

/**
 * Draw the summary grid and return the height it consumed, or 0 when there is nothing
 * to draw. `maxH` is the height the caller reserved, so this never overflows the page.
 */
function drawPaySlipSummaryGrid(doc: PdfDoc, data: DocData, brand: DocBrand, maxH: number): number {
  const grid = paySlipGridLayout(data, maxH);
  if (!grid) return 0;
  const { colGap, colW, bandH, headH, footSize, lineStep, footW, footLines, rowH, left, right } = grid;
  const showLeft = left.length > 0;
  const showRight = right.length > 0 || footLines.length > 0;
  if (!showLeft && !showRight) return 0;

  const top = doc.cursorY;
  const rowsTop = top - bandH - 5;

  const drawColumn = (
    x: number,
    label: string,
    head: [string, string],
    list: Array<[string, string]>,
    foot: string[]
  ): void => {
    doc.rect(x, top - bandH, colW, bandH, brand.navy);
    doc.rect(x, top - bandH, 2.6, bandH, brand.teal);
    doc.rawText(label.toUpperCase(), x + 9, top - bandH / 2 + 2.4, 6.6, {
      bold: true,
      color: BRAND.white,
      maxWidth: colW - 18,
    });
    doc.rect(x, rowsTop - headH, colW, headH, BRAND.headerFill);
    doc.rawText(head[0], x + 8, rowsTop - 7.6, 5.3, { bold: true, color: brand.teal, maxWidth: colW * 0.62 });
    doc.rawText(head[1], x + 6, rowsTop - 7.6, 5.3, {
      bold: true,
      color: brand.teal,
      align: 'right',
      maxWidth: colW - 12,
    });

    list.forEach(([name, value], i) => {
      const bottom = rowsTop - headH - (i + 1) * rowH;
      const textY = bottom + Math.max(2.4, (rowH - 7.2) / 2);
      doc.line(x + 8, bottom, x + colW - 8, bottom, LINE, 0.3);
      if (i === list.length - 1 && list.length > 1) {
        doc.rect(x, bottom, colW, rowH, brand.navy);
        doc.rawText(name, x + 8, textY, 7.2, { bold: true, color: BRAND.white, maxWidth: colW * 0.62 });
        doc.rawText(value, x + 6, textY, 7.8, { bold: true, color: BRAND.white, align: 'right', maxWidth: colW - 12 });
      } else {
        if (i % 2 === 1) doc.rect(x, bottom, colW, rowH, BRAND.zebra);
        doc.rawText(name, x + 8, textY, 7.2, { color: BRAND.ink, maxWidth: colW * 0.62 });
        doc.rawText(value, x + 6, textY, 7.2, { bold: true, color: BRAND.ink, align: 'right', maxWidth: colW - 12 });
      }
    });

    let fy = rowsTop - headH - list.length * rowH - 5;
    for (const ln of foot) {
      doc.rawText(ln, x + 8, fy, footSize, { color: GRAY, maxWidth: footW });
      fy -= lineStep;
    }
  };

  if (showLeft) drawColumn(MARGIN, 'Net pay calculation', ['DESCRIPTION', 'AMOUNT'], left, []);
  if (showRight) drawColumn(MARGIN + colW + colGap, 'PAYE brackets applied', ['MONTHLY TAXABLE INCOME', 'RATE'], right, footLines);

  doc.cursorY = top - grid.height;
  return grid.height;
}
function drawPaySlipExtras(doc: PdfDoc, data: DocData, brand: DocBrand): void {
  const breakdown = data.payBreakdown ?? [];
  const brackets = data.payeBrackets;
  if (!breakdown.length && !brackets?.bands.length) return;
  if (breakdown.length) {
    drawContractBand(doc, 'Net Pay calculation', brand);
    const rowH = 15;
    const h = breakdown.length * rowH + 12;
    if (doc.cursorY - h < BOTTOM) doc.newPage();
    const top = doc.cursorY;
    doc.rect(MARGIN, top - h, TABLE_W, h, BRAND.headerFill);
    doc.rect(MARGIN, top - h, 2.6, h, brand.teal);
    let y = top - 6;
    breakdown.forEach(([label, value], i) => {
      const last = i === breakdown.length - 1;
      if (last) {
        doc.rect(MARGIN, y - rowH - 2, TABLE_W, rowH + 6, brand.navy);
        doc.rect(MARGIN, y - rowH - 2, 2.6, rowH + 6, brand.teal);
        doc.rawText(label.toUpperCase(), MARGIN + 10, y - 11, 8.2, { bold: true, color: BRAND.white, maxWidth: TABLE_W * 0.62 });
        doc.rawText(value, MARGIN + 8, y - 11, 9.4, { bold: true, color: BRAND.white, align: 'right', maxWidth: TABLE_W - 16 });
      } else {
        doc.rawText(label, MARGIN + 10, y - 10, 7.8, { color: GRAY, maxWidth: TABLE_W * 0.62 });
        doc.rawText(value, MARGIN + 8, y - 10, 8.4, { bold: true, color: INK, align: 'right', maxWidth: TABLE_W - 16 });
        doc.line(MARGIN + 10, y - rowH, MARGIN + TABLE_W - 8, y - rowH, LINE, 0.35);
      }
      y -= rowH;
    });
    doc.cursorY = top - h - 8;
  }
  if (brackets?.bands.length) {
    drawContractBand(doc, 'PAYE brackets applied', brand);
    const columns: PdfTableColumn[] = [
      { key: 'band', label: 'Monthly taxable income (UGX)', weight: 2.4 },
      { key: 'rate', label: 'PAYE rate', align: 'right', weight: 1 },
    ];
    const rows = brackets.bands.map(([band, rate]) => ({ band, rate }));
    doc.table({
      x: MARGIN,
      width: TABLE_W,
      columns,
      rows,
      headerFill: brand.navy,
      headerColor: BRAND.white,
      zebra: true,
      zebraFill: BRAND.zebra,
      grid: 'horizontal',
      lineColor: LINE,
      cellPadding: 6,
      headerSize: 7.4,
      size: 8.3,
    });
    doc.cursorY -= 6;
    if (brackets.note) {
      const wrapped = wrapHard(brackets.note, 7.6, false, TABLE_W - 20);
      const h = wrapped.length * 7.6 * 1.42 + 14;
      if (doc.cursorY - h < BOTTOM) doc.newPage();
      const top = doc.cursorY;
      doc.rect(MARGIN, top - h, TABLE_W, h, BRAND.headerFill);
      doc.rect(MARGIN, top - h, 2.6, h, brand.teal);
      let y = top - 11;
      for (const ln of wrapped) {
        doc.rawText(ln, MARGIN + 10, y, 7.6, { color: GRAY, maxWidth: TABLE_W - 20 });
        y -= 7.6 * 1.42;
      }
      doc.cursorY = top - h - 5;
    }
  }
}

/**
 * Height the "Terms and notes" block will consume, measured without drawing it. Mirrors
 * drawContractNotices line for line so the payslip tail can reserve exactly this much.
 */
function contractNoticesHeight(notes: string[]): number {
  let h = 0;
  for (const note of notes) {
    h += 23 + wrapHard(note, 7.6, false, TABLE_W - 20).length * 7.6 * 1.42 + 14 + 5;
  }
  return h;
}

/**
 * Lay out the whole payslip tail - summary grid, terms, signatures and the authenticity
 * panel - as one pinned block.
 *
 * A payslip is a one-page document, so the tail is measured before anything is drawn and
 * the summary grid is given exactly the room left over by the blocks with fixed heights.
 * Breaks are suppressed for the duration so the tail can never spill onto a second page.
 */
async function drawPayslipTail(
  doc: PdfDoc,
  data: DocData,
  brand: DocBrand,
  opts: DocumentRenderOpts,
  auth: boolean,
  floor: number,
): Promise<void> {
  const notes = (data.notes ?? []).filter((n) => n && String(n).trim());
  const noticesH = contractNoticesHeight(notes);
  const sigH = 23 + 54;
  const authH = auth ? 4 + authBlockHeight(opts) + 6 : 0;

  const top = doc.cursorY;
  const gridMax = Math.max(0, top - floor - noticesH - sigH - authH);

  doc.setNoBreak(true);
  try {
    drawPaySlipSummaryGrid(doc, data, brand, gridMax);
    drawContractNotices(doc, notes, brand, 'Terms and notes');
    await drawContractSignatures(doc, data.signatures ?? [], brand);
    if (auth) {
      doc.cursorY -= 4;
      await drawAuthenticityBlock(doc, opts, brand);
    }
  } finally {
    doc.setNoBreak(false);
  }
}

interface AuthBlockLayout {
  pad: number;
  qrBox: number;
  headerH: number;
  tx: number;
  tw: number;
  labelSize: number;
  noteSize: number;
  lineH: (size: number) => number;
  rows: Array<{ label: string; lines: string[]; size: number; color: Rgb }>;
  noteLines: string[];
  boxH: number;
}

/**
 * Measure the authenticity panel without drawing it. The payslip renderer reserves
 * exactly this much vertical space up front, so the panel can never end up alone on
 * page 2 while the statement it belongs to sits on page 1.
 */
function authBlockLayout(opts: DocumentRenderOpts): AuthBlockLayout {
  const pad = 10;
  const qrBox = 60;
  const gap = 14;
  const headerH = 18;
  const tx = MARGIN + pad + qrBox + gap;
  const tw = TABLE_W - pad * 2 - qrBox - gap;

  const issued = opts.issuedBy + '  \u00b7  ' + formatDocDateTime(opts.issuedAt);
  const tokenShort =
    opts.token && opts.token.length > 24
      ? opts.token.slice(0, 14) + '\u2026' + opts.token.slice(-8)
      : opts.token ?? '';
  const note =
    'Scan the QR code or open the verify link to confirm this document against the official registry. Any alteration of the contents invalidates the fingerprint.';

  const labelSize = 5.6;
  const monoSize = 6.3;
  const valueSize = 6.6;
  const noteSize = 6.3;
  const lineH = (size: number): number => size * 1.36;

  // Only rows that actually have a value are laid out. A payslip issued without a
  // verification token used to print an empty 'Document token' row, spending a whole
  // label/value pair of vertical space on a page that has none to spare.
  const rows: Array<{ label: string; lines: string[]; size: number; color: Rgb }> = [
    { label: 'Issued by', lines: wrapHard(issued, valueSize, false, tw), size: valueSize, color: GRAY },
  ];
  if (opts.fingerprint) {
    rows.push({ label: 'SHA-256 fingerprint', lines: wrapHard(opts.fingerprint, monoSize, false, tw), size: monoSize, color: INK });
  }
  if (tokenShort) {
    rows.push({ label: 'Document token', lines: wrapHard(tokenShort, monoSize, false, tw), size: monoSize, color: INK });
  }
  if (opts.verifyUrl) {
    rows.push({ label: 'Verify at', lines: wrapHard(opts.verifyUrl, valueSize, false, tw), size: valueSize, color: BRAND.blue });
  }
  const noteLines = wrapHard(note, noteSize, false, tw);

  let contentH = 9;
  for (const r of rows) contentH += labelSize * 1.5 + r.lines.length * lineH(r.size) + 4;
  contentH += noteLines.length * lineH(noteSize) + 8;
  return {
    pad,
    qrBox,
    headerH,
    tx,
    tw,
    labelSize,
    noteSize,
    lineH,
    rows,
    noteLines,
    boxH: Math.max(qrBox + pad * 2, headerH + Math.ceil(contentH)),
  };
}

function authBlockHeight(opts: DocumentRenderOpts): number {
  return authBlockLayout(opts).boxH;
}

async function drawAuthenticityBlock(doc: PdfDoc, opts: DocumentRenderOpts, brand: DocBrand): Promise<void> {
  const { pad, qrBox, headerH, tx, tw, labelSize, noteSize, lineH, rows, noteLines, boxH } = authBlockLayout(opts);
  if (doc.cursorY - boxH < BOTTOM) doc.newPage();
  const top = doc.cursorY;
  const bottom = top - boxH;

  // Panel background + left teal accent.
  doc.rect(MARGIN, bottom, TABLE_W, boxH, BRAND.headerFill);
  doc.rect(MARGIN, bottom, 2.6, boxH, brand.teal);

  // Navy header band with title and VERIFIED chip.
  doc.rect(MARGIN, top - headerH, TABLE_W, headerH, brand.navy);
  doc.rawText('DOCUMENT AUTHENTICITY', MARGIN + 10, top - headerH / 2 + 3, 8.2, {
    bold: true,
    color: BRAND.white,
    maxWidth: tw,
  });
  const chip = 'VERIFIED';
  const chipW = textWidth(chip, 6.2, true) + 12;
  const chipX = MARGIN + TABLE_W - 10 - chipW;
  doc.rect(chipX, top - headerH + 3.5, chipW, 11, brand.teal);
  doc.rawText(chip, chipX, top - headerH + 7.2, 6.2, {
    bold: true,
    color: BRAND.white,
    align: 'center',
    maxWidth: chipW,
  });

  // White QR panel with border, embedding a crisp PNG so it stays scannable.
  const qrTop = top - headerH - Math.max(0, (boxH - headerH - qrBox) / 2);
  doc.rect(MARGIN + pad, qrTop - qrBox, qrBox, qrBox, BRAND.white);
  doc.strokeRect(MARGIN + pad, qrTop - qrBox, qrBox, qrBox, brand.navy, 0.7);
  let qrName: string | null = null;
  if (opts.verifyUrl) {
    try {
      const png = await QRCode.toBuffer(opts.verifyUrl, { type: 'png', width: 240, margin: 1, errorCorrectionLevel: 'M' });
      qrName = doc.addImage(png);
    } catch {
      qrName = null;
    }
  }
  if (qrName) {
    const inset = 4;
    doc.image(qrName, MARGIN + pad + inset, qrTop - qrBox + inset, qrBox - inset * 2, qrBox - inset * 2);
  } else {
    doc.rawText('QR', MARGIN + pad, qrTop - qrBox / 2 + 2, 10, { bold: true, color: brand.teal, align: 'center', maxWidth: qrBox });
    doc.rawText('UNAVAILABLE', MARGIN + pad, qrTop - qrBox / 2 - 8, 5.4, { color: GRAY, align: 'center', maxWidth: qrBox });
  }

  // Label/value rows.
  let y = top - headerH - 9;
  for (const r of rows) {
    doc.rawText(r.label.toUpperCase(), tx, y - 2, labelSize, { color: brand.teal, bold: true, maxWidth: tw });
    y -= labelSize * 1.5;
    for (const ln of r.lines) {
      doc.rawText(ln, tx, y, r.size, { color: r.color, maxWidth: tw });
      y -= lineH(r.size);
    }
    y -= 4;
  }
  for (const ln of noteLines) {
    doc.rawText(ln, tx, y, noteSize, { color: GRAY, maxWidth: tw });
    y -= lineH(noteSize);
  }

  doc.rect(MARGIN, bottom, TABLE_W, 2.2, brand.teal);
  doc.cursorY = bottom - 6;
}

// ---------------------------------------------------------------------------
// Formal employment-contract PDF layout
// ---------------------------------------------------------------------------

interface ContractClauseRender {
  title: string;
  text: string;
  legalReference?: string;
}

interface ContractSectionRender {
  band: string;
  clauses: ContractClauseRender[];
}

const CONTRACT_CLAUSE_SECTION = contracts.CONTRACT_CLAUSE_SECTION;

const CONTRACT_SECTION_BANDS: Record<string, string> = {
  EMPLOYMENT: 'Part I \u2014 Engagement',
  DUTIES: 'Part II \u2014 Duties and Responsibilities',
  COMPENSATION: 'Part III \u2014 Compensation and Benefits',
  WORKING_HOURS: 'Part IV \u2014 Working Hours',
  LEAVE: 'Part V \u2014 Leave Entitlements',
  CONFIDENTIALITY: 'Part VI \u2014 Confidentiality, Conduct and Compliance',
  TERMINATION: 'Part VII \u2014 Termination, Discipline and Disputes',
  GENERAL: 'Part VIII \u2014 General Provisions',
  RIGHTS: 'Part IX \u2014 Rights and Non-Discrimination',
};

function parseClauseValue(term: Record<string, unknown>): { text: string; clauseCode: string } {
  let value: { text?: string; clauseCode?: string; value?: string } = {};
  const raw = term.value ?? term.body ?? term.description;
  if (raw != null) {
    try {
      value =
        typeof raw === 'string' && raw.trim().startsWith('{')
          ? (JSON.parse(raw) as { text?: string; clauseCode?: string; value?: string })
          : typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as { text?: string; clauseCode?: string; value?: string })
            : { text: String(raw) };
    } catch {
      value = { text: String(raw) };
    }
  }
  const text = String(value.text ?? value.value ?? term.description ?? term.body ?? '').trim();
  const clauseCode = String(value.clauseCode ?? term.clauseCode ?? term.clause_code ?? '').toUpperCase();
  return { text, clauseCode };
}

function pushClause(
  sections: ContractSectionRender[],
  current: ContractSectionRender | null,
  title: string,
  text: string,
  clauseCode: string,
  legalReference?: string
): ContractSectionRender | null {
  if (!text) return current;
  const band = CONTRACT_SECTION_BANDS[CONTRACT_CLAUSE_SECTION[clauseCode] ?? ''] ?? '';
  const heading =
    title.trim() ||
    clauseCode.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()) ||
    'Clause';
  if (!current || current.band !== band) {
    current = { band, clauses: [] };
    sections.push(current);
  }
  current.clauses.push({ title: heading, text, legalReference });
  return current;
}

function contractSections(data: DocData): ContractSectionRender[] {
  const raw = (data.raw ?? {}) as Record<string, unknown>;
  const terms = Array.isArray(raw.terms) ? (raw.terms as Array<Record<string, unknown>>) : [];
  const sections: ContractSectionRender[] = [];
  let current: ContractSectionRender | null = null;
  const seen = new Set<string>();
  for (const term of terms) {
    const termType = String(term.termType ?? term.term_type ?? 'CLAUSE').toUpperCase();
    if (termType && termType !== 'CLAUSE' && termType !== 'PARTICULAR') continue;
    const { text, clauseCode } = parseClauseValue(term);
    const key = (clauseCode || String(term.title ?? '') + '|' + text).toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    current = pushClause(
      sections,
      current,
      String(term.title ?? ''),
      text,
      clauseCode,
      term.legalReference ? String(term.legalReference) : term.legal_reference ? String(term.legal_reference) : undefined
    );
  }
  if (sections.length > 0) return sections;

  const contract = (raw.contract && typeof raw.contract === 'object' ? raw.contract : raw) as Record<string, unknown>;
  const content = contract.content as { sections?: Array<Record<string, unknown>> } | undefined;
  const contentSections = Array.isArray(content?.sections) ? content.sections : [];
  for (const sec of contentSections) {
    const clauses = Array.isArray(sec.clauses) ? (sec.clauses as Array<Record<string, unknown>>) : [];
    for (const cl of clauses) {
      const clauseCode = String(cl.clauseCode ?? cl.clause_code ?? '').toUpperCase();
      const text = String(cl.text ?? '').trim();
      const key = (clauseCode || String(cl.name ?? '') + '|' + text).toUpperCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      current = pushClause(
        sections,
        current,
        String(cl.name ?? cl.title ?? ''),
        text,
        clauseCode,
        cl.legalReference ? String(cl.legalReference) : cl.legal_reference ? String(cl.legal_reference) : undefined
      );
    }
  }
  return sections;
}

function drawContractBand(doc: PdfDoc, label: string, brand: DocBrand, light = false): void {
  const bandH = light ? 15 : 17;
  if (doc.cursorY - bandH - 6 < BOTTOM) doc.newPage();
  const y = doc.cursorY;
  if (light) {
    doc.rect(MARGIN, y - bandH, TABLE_W, bandH, BRAND.headerFill);
    doc.rect(MARGIN, y - bandH, 2.6, bandH, brand.teal);
    doc.rawText(label.toUpperCase(), MARGIN + 9, y - bandH / 2 + 2.6, 6.8, {
      bold: true,
      color: brand.navy,
      maxWidth: TABLE_W - 18,
    });
    doc.line(MARGIN, y - bandH, MARGIN + TABLE_W, y - bandH, LINE, 0.5);
  } else {
    doc.rect(MARGIN, y - bandH, TABLE_W, bandH, brand.navy);
    doc.rect(MARGIN, y - bandH, 3, bandH, brand.teal);
    doc.rawText(label.toUpperCase(), MARGIN + 9, y - bandH / 2 + 2.8, 7, {
      bold: true,
      color: BRAND.white,
      maxWidth: TABLE_W - 18,
    });
  }
  doc.cursorY = y - bandH - 6;
}

function drawContractIntro(doc: PdfDoc, opts: DocumentRenderOpts): void {
  doc.cursorY -= 2;
  doc.text(
    'This document records the written particulars of employment between the Employer and the Employee identified below and constitutes their contract of employment. It is issued in accordance with the Employment Act (Cap. 226, Laws of Uganda), as amended, and nothing in it removes, reduces or contracts out any statutory right conferred on the Employee.',
    MARGIN,
    8.6,
    { color: INK, maxWidth: TABLE_W }
  );
  doc.cursorY -= 2;
  doc.text(
    'Issued by ' + opts.issuedBy + ' on ' + formatDocDateTime(opts.issuedAt) + (opts.correlationId ? '  \u00b7  Ref ' + opts.correlationId : ''),
    MARGIN,
    7,
    { color: GRAY, maxWidth: TABLE_W }
  );
  doc.cursorY -= 4;
}

function drawContractParticulars(doc: PdfDoc, items: Array<[string, string]>, brand: DocBrand, bandLabel = 'Particulars of Employment'): void {
  const shown = items.filter(([, v]) => v && v !== '-' && v !== 'N/A');
  if (!shown.length) return;
  drawContractBand(doc, bandLabel, brand);
  const pad = 8;
  const labelSize = 5.9;
  const valueSize = 7.6;
  const pairsPerRow = 2;
  const colW = TABLE_W / pairsPerRow;
  let idx = 0;
  while (idx < shown.length) {
    const rowItems = shown.slice(idx, idx + pairsPerRow);
    const wrapped = rowItems.map(([label, value]) => ({
      label,
      lines: wrapHard(String(value), valueSize, true, colW - pad * 2).slice(0, 3),
    }));
    const rowH = Math.max(26, 12 + Math.max(...wrapped.map((w) => w.lines.length)) * (valueSize * 1.32) + 6);
    if (doc.cursorY - rowH < BOTTOM) doc.newPage();
    const top = doc.cursorY;
    doc.rect(MARGIN, top - rowH, TABLE_W, rowH, BRAND.headerFill);
    wrapped.forEach((cell, c) => {
      const x = MARGIN + c * colW;
      doc.rawText(cell.label.toUpperCase(), x + pad, top - 10, labelSize, { color: GRAY, bold: true, maxWidth: colW - pad * 2 });
      cell.lines.forEach((ln, i) => {
        doc.rawText(ln, x + pad, top - 21 - i * (valueSize * 1.32), valueSize, { color: INK, bold: true, maxWidth: colW - pad * 2 });
      });
      if (c === 0) doc.line(x + colW, top, x + colW, top - rowH, LINE, 0.4);
    });
    doc.line(MARGIN, top - rowH, MARGIN + TABLE_W, top - rowH, LINE, 0.5);
    doc.cursorY = top - rowH;
    idx += pairsPerRow;
  }
  doc.line(MARGIN, doc.cursorY, MARGIN + TABLE_W, doc.cursorY, brand.navy, 0.9);
  doc.cursorY -= 8;
}

function drawJustifiedLine(doc: PdfDoc, text: string, x: number, y: number, size: number, maxW: number, color: Rgb): void {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    doc.rawText(text, x, y, size, { color, maxWidth: maxW });
    return;
  }
  // Distribute the leftover width on top of the normal word-space width so
  // justified words never collapse into one another.
  const spaceW = textWidth(' ', size, false);
  const wordsW = words.reduce((a, w) => a + textWidth(w, size, false), 0);
  const gap = Math.max(spaceW, (maxW - wordsW) / (words.length - 1));
  let cx = x;
  for (const word of words) {
    doc.rawText(word, cx, y, size, { color });
    cx += textWidth(word, size, false) + gap;
  }
}

function drawContractClause(doc: PdfDoc, no: number, clause: ContractClauseRender, brand: DocBrand): void {
  const headSize = 9.2;
  const bodySize = 8.8;
  const refSize = 6.6;
  const bodyW = TABLE_W - 8;
  const bodyX = MARGIN + 8;
  if (doc.cursorY - headSize * 1.5 - 6 < BOTTOM) doc.newPage();
  doc.cursorY -= 2;
  doc.rawText(no + '. ' + clause.title, MARGIN, doc.cursorY, headSize, { bold: true, color: brand.navy, maxWidth: TABLE_W });
  doc.cursorY -= headSize * 1.42;
  const paragraphs = String(clause.text).split(/\n+/).map((p) => p.trim()).filter(Boolean);
  for (const para of paragraphs) {
    const bodyLines = wrapHard(para, bodySize, false, bodyW);
    bodyLines.forEach((ln, i) => {
      if (doc.cursorY - bodySize * 1.5 < BOTTOM) doc.newPage();
      if (i < bodyLines.length - 1 && ln.trim().length) drawJustifiedLine(doc, ln, bodyX, doc.cursorY, bodySize, bodyW, INK);
      else doc.rawText(ln, bodyX, doc.cursorY, bodySize, { color: INK, maxWidth: bodyW });
      doc.cursorY -= bodySize * 1.42;
    });
    doc.cursorY -= 2.4;
  }
  if (clause.legalReference) {
    for (const ln of wrapHard('Legal reference: ' + clause.legalReference, refSize, false, bodyW)) {
      if (doc.cursorY - refSize * 1.5 < BOTTOM) doc.newPage();
      doc.rawText(ln, bodyX, doc.cursorY, refSize, { color: GRAY, maxWidth: bodyW });
      doc.cursorY -= refSize * 1.42;
    }
  }
  doc.cursorY -= 2;
}

function drawContractClauses(doc: PdfDoc, data: DocData, brand: DocBrand): void {
  const sections = contractSections(data);
  if (!sections.length) return;
  drawContractBand(doc, 'Terms and Conditions of Employment', brand);
  let clauseNo = 0;
  for (const section of sections) {
    if (section.band) drawContractBand(doc, section.band, brand, true);
    for (const clause of section.clauses) {
      clauseNo += 1;
      drawContractClause(doc, clauseNo, clause, brand);
    }
  }
}

function drawContractSchedule(doc: PdfDoc, data: DocData, brand: DocBrand): void {
  if (!data.items.length) return;
  drawContractBand(doc, 'Schedule A \u2014 Allowances and Benefits', brand);
  const columns: PdfTableColumn[] = [{ key: '_no', label: '#', align: 'right', weight: 0.45 }, ...data.columns];
  const rows = data.items.map((it, i) => ({ _no: i + 1, ...it }));
  doc.table({
    x: MARGIN,
    width: TABLE_W,
    columns,
    rows,
    headerFill: brand.navy,
    headerColor: BRAND.white,
    zebra: true,
    zebraFill: BRAND.zebra,
    grid: 'horizontal',
    lineColor: LINE,
  });
  doc.cursorY -= 6;
}

function drawContractNotices(doc: PdfDoc, notes: string[], brand: DocBrand, bandLabel = 'Statutory Notice'): void {
  if (!notes.length) return;
  drawContractBand(doc, bandLabel, brand);
  for (const note of notes) {
    const wrapped = wrapHard(note, 7.6, false, TABLE_W - 20);
    const h = wrapped.length * 7.6 * 1.42 + 14;
    if (doc.cursorY - h < BOTTOM) doc.newPage();
    const top = doc.cursorY;
    doc.rect(MARGIN, top - h, TABLE_W, h, BRAND.headerFill);
    doc.rect(MARGIN, top - h, 2.6, h, brand.teal);
    let y = top - 11;
    for (const ln of wrapped) {
      doc.rawText(ln, MARGIN + 10, y, 7.6, { color: GRAY, maxWidth: TABLE_W - 20 });
      y -= 7.6 * 1.42;
    }
    doc.cursorY = top - h - 5;
  }
}

/** Read the uploaded signature image for a tenant/company from local storage. */
function readStoredSignature(signatureUrl: string): { bytes: Buffer; ext: string } | null {
  return readStoredBrandingFile(signatureUrl, 'signature');
}

/**
 * Read the per-signatory uploaded signature for a contract. The public URL
 * carries extra `contract` + `signer` query params pointing at the stored
 * contract-sig-<contract>-<signer> file.
 */
function readStoredContractSignature(signatureUrl: string): { bytes: Buffer; ext: string } | null {
  const parsed = brandingAssetParams(signatureUrl);
  if (!parsed) return null;
  const contract = String(parsed.url.searchParams.get('contract') ?? '');
  const signer = String(parsed.url.searchParams.get('signer') ?? '');
  if (!/^\d+$/.test(contract) || !/^[A-Z_]+$/.test(signer)) return null;
  return readStoredBrandingFile(signatureUrl, `contract-sig-${contract}-${signer}`);
}

async function drawContractSignatures(doc: PdfDoc, signs: DocSignature[], brand: DocBrand): Promise<void> {
  if (!signs.length) return;
  drawContractBand(doc, 'Signatures', brand);
  const h = 54;
  if (doc.cursorY - h < BOTTOM) doc.newPage();
  const n = Math.min(3, signs.length);
  const gap = 24;
  const colW = (TABLE_W - gap * (n - 1)) / n;
  const top = doc.cursorY;
  signs.slice(0, n).forEach((s, i) => {
    const x = MARGIN + i * (colW + gap);
    if (s.signedAt && s.name) {
      if (s.signatureUrl) {
        const sigFile = readStoredContractSignature(s.signatureUrl) ?? readStoredSignature(s.signatureUrl);
        const sigName = sigFile ? doc.addImage(sigFile.bytes) : null;
        if (sigName) doc.image(sigName, x + Math.max(0, colW - 60) / 2, top - 38, 60, 20);
      }
      doc.rawText(s.name, x, top - 14, 9, { color: INK, bold: true, maxWidth: colW });
      doc.rawText(s.role ?? '', x, top - 24, 7, { color: GRAY, maxWidth: colW });
      doc.rawText(`Signed electronically ${formatDocDate(s.signedAt)}`, x, top - 34, 6.6, { color: GRAY, maxWidth: colW });
      doc.rawText(s.label.toUpperCase(), x, top - 46, 6.4, { color: brand.teal, bold: true, maxWidth: colW });
    } else {
      doc.line(x, top - 26, x + colW, top - 26, brand.navy, 0.8);
      doc.rawText('Date: ______________', x, top - 12, 6.8, { color: GRAY, maxWidth: colW });
      doc.rawText(s.label.toUpperCase(), x, top - 38, 6.4, { color: brand.teal, bold: true, maxWidth: colW });
      if (s.name) doc.rawText(s.name, x, top - 48, 8, { color: INK, maxWidth: colW });
    }
  });
  doc.cursorY = top - h;
}

async function renderContractPdf(data: DocData, opts: DocumentRenderOpts): Promise<Buffer> {
  const doc = new PdfDoc();
  const auth = authEnabled(opts);
  const classification = classifOf(data, opts);
  const status = statusOf(data, opts);
  const brand = brandOf(opts.company);
  const logoName = preloadLogo(doc, opts.company.logoUrl);
  const secondaryLogoName = preloadSecondaryLogo(doc, opts.company.secondaryLogoUrl);
  const footerLogoName = preloadFooterLogo(doc, opts.company.footerLogoUrl);

  const head = letterheadMeta(data, opts, status);
  doc.setNewPageHandler(() => drawRunningHeader(doc, head, brand, logoName, secondaryLogoName));
  drawLetterhead(doc, head, brand, logoName, secondaryLogoName);
  drawContractIntro(doc, opts);

  const photoName = data.photo?.bytes ? doc.addImage(data.photo.bytes) : null;
  drawParties(doc, data.parties ?? [], brand, photoName, data.photo?.caption);

  const particulars: Array<[string, string]> = [
    ...(data.facts ?? []),
    ...data.meta.filter(([label]) => /legal framework|version/i.test(label)),
  ];
  const seen = new Set<string>();
  const uniqueParticulars = particulars.filter(([k, v]) => {
    const key = k.toLowerCase();
    if (!v || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  drawContractParticulars(doc, uniqueParticulars, brand);
  drawContractClauses(doc, data, brand);
  drawContractSchedule(doc, data, brand);
  drawContractNotices(doc, data.notes, brand);
  await drawContractSignatures(doc, data.signatures ?? [], brand);
  if (auth) {
    doc.cursorY -= 4;
    await drawAuthenticityBlock(doc, opts, brand);
  }

  const companyLine = [opts.company.legalName || opts.company.name, opts.company.tin ? 'TIN ' + opts.company.tin : '', opts.company.vrn ? 'VRN ' + opts.company.vrn : '']
    .filter(Boolean)
    .join('  \u00b7  ');
  const authLine = auth ? 'SHA-256 ' + (opts.fingerprint ?? '').slice(0, 16) + '...' : '';
  doc.footer(
    [
      [opts.company.footerText, companyLine].filter(Boolean).join('  \u00b7  '),
      ['Issued by ' + opts.issuedBy + ' on ' + formatDocDateTime(opts.issuedAt), opts.correlationId ? 'Ref ' + opts.correlationId : '', authLine, classification.toUpperCase()]
        .filter(Boolean)
        .join('  \u00b7  '),
    ].filter(Boolean),
    { navy: brand.navy, accent: brand.teal, color: GRAY, logoName: footerLogoName }
  );

  doc.setMetadata({
    title: data.title + (data.code ? ' ' + data.code : ''),
    author: opts.issuedBy,
    subject: data.subtitle ?? data.title + ' issued by ' + opts.company.name,
    keywords: [data.code, classification, data.status ?? '', opts.company.legalName, 'Employment Contract'].filter(Boolean).join(', '),
    creator: opts.company.name,
    producer: opts.company.legalName || opts.company.name,
  });
  if (/confidential|restricted/i.test(classification)) doc.watermark('CONFIDENTIAL');
  else if (auth) doc.watermark('VERIFIED COPY', { color: [0.965, 0.97, 0.975], size: 46 });

  return doc.build();
}

// ---------------------------------------------------------------------------
// Formal certificate-of-service PDF layout
// ---------------------------------------------------------------------------

function factOf(data: DocData, label: string): string {
  const needle = label.toLowerCase();
  const found =
    (data.facts ?? []).find(([k]) => k.toLowerCase() === needle)?.[1] ??
    (data.meta ?? []).find(([k]) => k.toLowerCase() === needle)?.[1] ??
    '';
  return String(found ?? '');
}

function partyName(data: DocData, heading: string): string {
  return data.parties?.find((p) => p.heading.toLowerCase() === heading.toLowerCase())?.name ?? '';
}

function serviceDuration(startIso: unknown, endIso: unknown): string {
  const start = new Date(String(startIso ?? '').slice(0, 10) + 'T00:00:00Z');
  const end = new Date(String(endIso ?? '').slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return '';
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  if (months < 0) months = 0;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  const parts: string[] = [];
  if (years === 1) parts.push('1 year');
  else if (years > 1) parts.push(years + ' years');
  if (rem === 1) parts.push('1 month');
  else if (rem > 1) parts.push(rem + ' months');
  if (!parts.length) return 'less than one month';
  return parts.join(' and ');
}

function drawBodyParagraph(doc: PdfDoc, text: string, size: number, x: number, maxW: number, color: Rgb): void {
  const bodyLines = wrapHard(text, size, false, maxW);
  bodyLines.forEach((ln, i) => {
    if (doc.cursorY - size * 1.5 < BOTTOM) doc.newPage();
    if (i < bodyLines.length - 1 && ln.trim().length) drawJustifiedLine(doc, ln, x, doc.cursorY, size, maxW, color);
    else doc.rawText(ln, x, doc.cursorY, size, { color, maxWidth: maxW });
    doc.cursorY -= size * 1.42;
  });
  doc.cursorY -= 2.4;
}

function drawCertificateStatement(doc: PdfDoc, data: DocData, brand: DocBrand): void {
  drawContractBand(doc, 'Certificate Statement', brand);
  const employer = partyName(data, 'Employer');
  const employee = partyName(data, 'Employee');
  const employeeNo = factOf(data, 'employee no');
  const position = factOf(data, 'position / capacity');
  const period = factOf(data, 'period of employment');
  const nature = factOf(data, 'nature of business');
  const wages = factOf(data, 'wages at termination');
  const reason = factOf(data, 'reason for termination');
  const raw = data.raw as Record<string, unknown>;
  const duration = serviceDuration(pick(raw, 'period_start'), pick(raw, 'period_end'));

  const bodySize = 8.8;
  const bodyX = MARGIN + 8;
  const bodyW = TABLE_W - 8;

  let opening = 'This is to certify that ' + employee + (employeeNo ? ' (Employee No ' + employeeNo + ')' : '');
  opening += ' was employed by ' + (employer || 'the Employer');
  if (position) opening += ' and served in the capacity of ' + position;
  opening += ' during the period of continuous employment ' + (period ? 'from ' + period : '(set out below)');
  if (duration) opening += ', being a period of ' + duration;
  opening += '.';
  drawBodyParagraph(doc, opening, bodySize, bodyX, bodyW, INK);

  if (nature) {
    drawBodyParagraph(doc, "The nature of the Employer's business is " + nature + '.', bodySize, bodyX, bodyW, INK);
  }
  if (wages) {
    drawBodyParagraph(doc, 'At the date on which the employment ceased, the wages payable to the Employee were ' + wages + '.', bodySize, bodyX, bodyW, INK);
  }
  if (reason) {
    drawBodyParagraph(doc, 'The reason for the termination of the employment was: ' + reason + '.', bodySize, bodyX, bodyW, INK);
  }
  drawBodyParagraph(
    doc,
    'This certificate is issued at the request of the Employee in accordance with the Employment Act (Cap. 226, Laws of Uganda), as amended. It is a statutory certificate of service and is not a reference as to the character or performance of the Employee.',
    bodySize,
    bodyX,
    bodyW,
    INK
  );
  doc.cursorY -= 2;
}

async function renderCertificatePdf(data: DocData, opts: DocumentRenderOpts): Promise<Buffer> {
  const doc = new PdfDoc();
  const auth = authEnabled(opts);
  const classification = classifOf(data, opts);
  const status = statusOf(data, opts);
  const brand = brandOf(opts.company);
  const logoName = preloadLogo(doc, opts.company.logoUrl);
  const secondaryLogoName = preloadSecondaryLogo(doc, opts.company.secondaryLogoUrl);
  const footerLogoName = preloadFooterLogo(doc, opts.company.footerLogoUrl);

  const head = letterheadMeta(data, opts, status);
  doc.setNewPageHandler(() => drawRunningHeader(doc, head, brand, logoName, secondaryLogoName));
  drawLetterhead(doc, head, brand, logoName, secondaryLogoName);
  drawCertificateStatement(doc, data, brand);
  drawParties(doc, data.parties ?? [], brand);

  const particulars: Array<[string, string]> = [
    ...(data.facts ?? []),
    ...data.meta.filter(([label]) => /contract no|legal framework|version/i.test(label)),
  ];
  const seen = new Set<string>();
  const uniqueParticulars = particulars.filter(([k, v]) => {
    const key = k.toLowerCase();
    if (!v || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  drawContractParticulars(doc, uniqueParticulars, brand, 'Certificate Particulars');
  drawContractNotices(doc, data.notes, brand);
  await drawContractSignatures(doc, data.signatures ?? [], brand);
  if (auth) {
    doc.cursorY -= 4;
    await drawAuthenticityBlock(doc, opts, brand);
  }

  const companyLine = [opts.company.legalName || opts.company.name, opts.company.tin ? 'TIN ' + opts.company.tin : '', opts.company.vrn ? 'VRN ' + opts.company.vrn : '']
    .filter(Boolean)
    .join('  \u00b7  ');
  const authLine = auth ? 'SHA-256 ' + (opts.fingerprint ?? '').slice(0, 16) + '...' : '';
  doc.footer(
    [
      [opts.company.footerText, companyLine].filter(Boolean).join('  \u00b7  '),
      ['Issued by ' + opts.issuedBy + ' on ' + formatDocDateTime(opts.issuedAt), opts.correlationId ? 'Ref ' + opts.correlationId : '', authLine, classification.toUpperCase()]
        .filter(Boolean)
        .join('  \u00b7  '),
    ].filter(Boolean),
    { navy: brand.navy, accent: brand.teal, color: GRAY, logoName: footerLogoName }
  );

  doc.setMetadata({
    title: data.title + (data.code ? ' ' + data.code : ''),
    author: opts.issuedBy,
    subject: data.subtitle ?? data.title + ' issued by ' + opts.company.name,
    keywords: [data.code, classification, data.status ?? '', opts.company.legalName, 'Certificate of Service'].filter(Boolean).join(', '),
    creator: opts.company.name,
    producer: opts.company.legalName || opts.company.name,
  });
  if (/confidential|restricted/i.test(classification)) doc.watermark('CONFIDENTIAL');
  else if (auth) doc.watermark('VERIFIED COPY', { color: [0.965, 0.97, 0.975], size: 46 });

  return doc.build();
}

function linesBand(data: DocData): string {
  const t = data.title.toLowerCase();
  if (t.includes('journal')) return 'Journal lines';
  if (t.includes('budget')) return 'Budget lines';
  if (t.includes('expense')) return 'Expense lines';
  if (t.includes('delivery')) return 'Delivered items';
  if (t.includes('goods received') || t.includes('received note')) return 'Received items';
  if (t.includes('requisition')) return 'Requested items';
  if (t.includes('rfq') || t.includes('request for quotation')) return 'Quoted items';
  if (t.includes('bid analysis')) return 'Quote comparison';
  if (t.includes('quotation')) return 'Quoted items';
  if (t.includes('inspection')) return 'Test results';
  if (t.includes('payment voucher') || t.includes('voucher')) return 'Payment lines';
  if (t.includes('supplier return')) return 'Returned items';
  if (t.includes('invoice')) return 'Invoice lines';
  if (t.includes('order')) return 'Order lines';
  if (t.includes('payslip')) return 'Earnings and deductions';
  if (t.includes('packing')) return 'Packed items';
  if (t.includes('proof of delivery')) return 'Delivered items';
  if (t.includes('returned')) return 'Returned items';
  if (t.includes('receipt')) return 'Allocations';
  if (t.includes('credit') || t.includes('debit')) return 'Adjustment';
  return 'Line items';
}

function factVal(data: DocData, label: string): string {
  const hit = (data.facts ?? []).find(([k]) => k.toLowerCase() === label.toLowerCase());
  return hit ? hit[1] : '';
}

function cropMarks(doc: PdfDoc, x: number, y: number, w: number, h: number, color: Rgb): void {
  const m = 10;
  const s = 8;
  doc.line(x - m, y + h, x - m + s, y + h, color, 0.6);
  doc.line(x, y + h + m - s, x, y + h + m, color, 0.6);
  doc.line(x + w + m - s, y + h, x + w + m, y + h, color, 0.6);
  doc.line(x + w, y + h + m - s, x + w, y + h + m, color, 0.6);
  doc.line(x - m, y, x - m + s, y, color, 0.6);
  doc.line(x, y - m, x, y - m + s, color, 0.6);
  doc.line(x + w + m - s, y, x + w + m, y, color, 0.6);
  doc.line(x + w, y - m, x + w, y - m + s, color, 0.6);
}

// ---------------------------------------------------------------------------
// Employee identity card (CR80 / ID-1: 85.6 mm x 54 mm)
//
// The card is printed on card stock, so both faces are laid out one above the
// other on a portrait page and cut on crop marks. Every block below is measured
// rather than pinned to a fixed pitch, so a wrapped name, an extra register
// field or a missing photograph can never collide with a band or leave the card.
// ---------------------------------------------------------------------------

/** CR80 card geometry in points (85.6 mm x 54 mm). */
const ID_CARD_W = 243;
const ID_CARD_H = 153;

/** Compact ASCII operand for a raw PDF content-stream number. */
function pdfNum(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** Fill colour operator (PDF `rg`). */
function pdfFill(color: Rgb): string {
  return `${pdfNum(color[0])} ${pdfNum(color[1])} ${pdfNum(color[2])} rg`;
}

/** Stroke colour operator (PDF `RG`). */
function pdfStroke(color: Rgb): string {
  return `${pdfNum(color[0])} ${pdfNum(color[1])} ${pdfNum(color[2])} RG`;
}

/** Blend a colour toward white to build the very light security tints. */
function idCardTint(color: Rgb, amount: number): Rgb {
  const a = Math.max(0, Math.min(1, amount));
  return [1 - (1 - color[0]) * a, 1 - (1 - color[1]) * a, 1 - (1 - color[2]) * a];
}

/** Filled rounded rectangle emitted straight into the content stream. */
function idCardPill(doc: PdfDoc, x: number, y: number, w: number, h: number, fill: Rgb, radius?: number): void {
  const r = Math.max(0, Math.min(radius ?? h / 2, h / 2, w / 2));
  const k = r * 0.5523;
  const x2 = x + w;
  const y2 = y + h;
  doc.op(
    `q ${pdfFill(fill)} ${pdfNum(x + r)} ${pdfNum(y)} m ${pdfNum(x2 - r)} ${pdfNum(y)} l ` +
      `${pdfNum(x2 - r + k)} ${pdfNum(y)} ${pdfNum(x2)} ${pdfNum(y + r - k)} ${pdfNum(x2)} ${pdfNum(y + r)} c ` +
      `${pdfNum(x2)} ${pdfNum(y2 - r)} l ${pdfNum(x2)} ${pdfNum(y2 - r + k)} ${pdfNum(x2 - r + k)} ${pdfNum(y2)} ${pdfNum(x2 - r)} ${pdfNum(y2)} c ` +
      `${pdfNum(x + r)} ${pdfNum(y2)} l ${pdfNum(x + r - k)} ${pdfNum(y2)} ${pdfNum(x)} ${pdfNum(y2 - r + k)} ${pdfNum(x)} ${pdfNum(y2 - r)} c ` +
      `${pdfNum(x)} ${pdfNum(y + r)} l ${pdfNum(x)} ${pdfNum(y + r - k)} ${pdfNum(x + r - k)} ${pdfNum(y)} ${pdfNum(x + r)} ${pdfNum(y)} c f Q`
  );
}

/** Faint diagonal security tint clipped to a region - a print-safe guilloche stand-in. */
function idCardSecurityTint(doc: PdfDoc, x: number, y: number, w: number, h: number, color: Rgb, step = 5): void {
  const lines: string[] = [];
  for (let offset = -h; offset < w; offset += step) {
    lines.push(`${pdfNum(x + offset)} ${pdfNum(y)} m ${pdfNum(x + offset + h)} ${pdfNum(y + h)} l S`);
  }
  if (!lines.length) return;
  doc.op(`q ${pdfNum(x)} ${pdfNum(y)} ${pdfNum(w)} ${pdfNum(h)} re W n 0.25 w ${pdfStroke(color)} ${lines.join(' ')} Q`);
}

/** Microtext thread: the phrase tiled at 2-3pt until the band is full. */
function idCardMicrotext(doc: PdfDoc, text: string, x: number, y: number, w: number, size: number, color: Rgb): void {
  const step = textWidth(text, size, false);
  if (step <= 0) return;
  const reps = Math.floor(w / step);
  if (reps < 1) return;
  doc.rawText(text.repeat(reps), x, y, size, { color, align: 'center', maxWidth: w });
}

/** Contain-fit: scale an image to sit fully inside a box, centred, aspect preserved. */
function idCardFitImage(doc: PdfDoc, name: string, x: number, y: number, w: number, h: number, pad: number): void {
  const dims = doc.imageDims(name);
  if (!dims || dims.width <= 0 || dims.height <= 0) return;
  const ar = dims.width / dims.height;
  const boxAr = w / h;
  let dw = w - pad * 2;
  let dh = h - pad * 2;
  if (ar > boxAr) dh = dw / ar;
  else dw = dh * ar;
  doc.image(name, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** Cover-fit: crop an image to fill its frame edge to edge, as on a printed ID card. */
function idCardCoverImage(doc: PdfDoc, name: string, x: number, y: number, w: number, h: number): void {
  const dims = doc.imageDims(name);
  if (!dims || dims.width <= 0 || dims.height <= 0 || w <= 0 || h <= 0) return;
  const ar = dims.width / dims.height;
  const boxAr = w / h;
  let dw = w;
  let dh = h;
  if (ar > boxAr) dw = h * ar;
  else dh = w / ar;
  doc.op(`q ${pdfNum(x)} ${pdfNum(y)} ${pdfNum(w)} ${pdfNum(h)} re W n`);
  doc.image(name, x - (dw - w) / 2, y - (dh - h) / 2, dw, dh);
  doc.op('Q');
}

/** Baseline that optically centres a line of the given size inside a band. */
function idCardCentreBaseline(bandY: number, bandH: number, size: number): number {
  return bandY + (bandH - size * 0.72) / 2;
}

/** Draw a single line, shrinking the size until it fits within maxWidth. */
function idCardFitText(
  doc: PdfDoc,
  text: string,
  x: number,
  y: number,
  size: number,
  style: PdfTextStyle,
  maxWidth: number
): void {
  let s = size;
  const bold = style.bold ?? false;
  while (s > 5 && textWidth(text, s, bold) > maxWidth) s -= 0.5;
  doc.rawText(text, x, y, s, { ...style, maxWidth });
}

/** Shrink to `floor`, then ellipsize, so a card value can never leave its column. */
function idCardFitLine(
  doc: PdfDoc,
  text: string,
  x: number,
  y: number,
  size: number,
  style: PdfTextStyle,
  maxWidth: number,
  floor: number
): void {
  const bold = style.bold ?? false;
  let s = size;
  while (s > floor && textWidth(text, s, bold) > maxWidth) s -= 0.25;
  let value = text;
  if (textWidth(value, s, bold) > maxWidth) {
    const room = maxWidth - textWidth('\u2026', s, bold);
    let cut = value.length;
    while (cut > 1 && textWidth(value.slice(0, cut), s, bold) > room) cut -= 1;
    value = value.slice(0, cut).replace(/[\s,;:.\u00b7-]+$/, '') + '\u2026';
  }
  doc.rawText(value, x, y, s, { ...style, maxWidth });
}

function renderIdCardPdf(data: DocData, opts: DocumentRenderOpts): Buffer {
  const doc = new PdfDoc();
  const brand = brandOf(opts.company);
  const raw = (data.raw ?? {}) as Record<string, unknown>;
  const official = factVal(data, 'Official ID') || str(pick(raw, 'official'));
  const shortId = factVal(data, 'Badge ID') || str(pick(raw, 'shortId'));
  const fullName = factVal(data, 'Employee') || str(pick(raw, 'fullName'));
  const department = factVal(data, 'Department') || str(pick(raw, 'department'));
  const position = factVal(data, 'Position') || str(pick(raw, 'position'));
  const company = factVal(data, 'Company') || opts.company.legalName || opts.company.name;
  const cardNo = factVal(data, 'Card No') || str(pick(raw, 'cardNo'));
  const serial = factVal(data, 'Serial') || str(pick(raw, 'serial'));
  const issued = factVal(data, 'Issued') || formatDocDate(opts.issuedAt);
  const expires = factVal(data, 'Expires');
  const status = statusOf(data, opts);
  const photoName = data.photo?.bytes ? doc.addImage(data.photo.bytes) : null;
  const qrName = data.qrPng ? doc.addImage(data.qrPng) : null;
  const logoName = preloadLogo(doc, opts.company.logoUrl);
  const secondaryLogoName = preloadSecondaryLogo(doc, opts.company.secondaryLogoUrl);
  const footerLogoName = preloadFooterLogo(doc, opts.company.footerLogoUrl);
  const cardHead = letterheadMeta(data, opts, status);
  doc.setNewPageHandler(() => drawRunningHeader(doc, cardHead, brand, logoName, secondaryLogoName));
  const verifyHost = (opts.verifyUrl || opts.company.verifyUrl || opts.company.website || '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0];

  const CARD_W = ID_CARD_W;
  const CARD_H = ID_CARD_H;
  const frontX = (PAGE_W - CARD_W) / 2;
  const frontY = PAGE_H - MARGIN - 36 - CARD_H;
  const backY = frontY - CARD_H - 30;

  doc.setMetadata({
    title: `Employee ID ${official || data.code}`,
    author: company,
    subject: 'Employee identity card',
    keywords: [official, shortId, fullName, cardNo].filter(Boolean).join(', '),
    creator: 'HOPE DESIGN ERP',
  });

  // --------------------------------------------------------------- page head
  doc.rawText('EMPLOYEE IDENTITY CARD', MARGIN, PAGE_H - MARGIN, 12, { bold: true, color: brand.navy, maxWidth: TABLE_W });
  if (fullName) {
    idCardFitLine(doc, fullName.toUpperCase(), MARGIN, PAGE_H - MARGIN, 9, { bold: true, color: INK, align: 'right' }, TABLE_W, 6);
  }
  if (official) {
    idCardFitLine(doc, 'Official ID  ' + official, MARGIN, PAGE_H - MARGIN - 11, 7.5, { bold: true, color: brand.teal, align: 'right' }, TABLE_W, 6);
  }
  doc.line(MARGIN, PAGE_H - MARGIN - 6, PAGE_W - MARGIN, PAGE_H - MARGIN - 6, brand.teal, 1.1);
  doc.rawText(`${company}  \u00b7  Human Resources`, MARGIN, PAGE_H - MARGIN - 15, 7.5, { color: GRAY, maxWidth: TABLE_W });

  const cardLabel = (label: string, note: string, y: number): void => {
    doc.rawText(label, frontX, y, 7.5, { bold: true, color: brand.navy, maxWidth: CARD_W });
    if (note) doc.rawText(note, frontX, y, 7, { color: GRAY, align: 'right', maxWidth: CARD_W });
  };

  // ----------------------------------------------------------- front (face)
  const drawFront = (x: number, y: number): void => {
    const top = y + CARD_H;
    const HDR = 30;
    const KEY = 2.5;
    const FTR = 16;
    const VAL = 12;
    const PAD = 12;
    const bodyTop = top - HDR - KEY;
    const right = x + CARD_W - PAD;

    cropMarks(doc, x, y, CARD_W, CARD_H, brand.navy);
    doc.rect(x, y, CARD_W, CARD_H, BRAND.white);
    idCardSecurityTint(doc, x + 1, y + 1, CARD_W - 2, CARD_H - 2, idCardTint(brand.navy, 0.05));
    doc.strokeRect(x, y, CARD_W, CARD_H, brand.navy, 1.4);
    doc.strokeRect(x + 4, y + 4, CARD_W - 8, CARD_H - 8, BRAND.line, 0.5);

    // Header band carrying the lockup and the status pill, then the brand keyline.
    doc.rect(x, top - HDR, CARD_W, HDR, brand.navy);
    doc.rect(x, top - HDR - KEY, CARD_W, KEY, brand.teal);
    let headRight = right;
    if (status) {
      const label = status.toUpperCase();
      const size = 5.4;
      const pillW = Math.min(92, textWidth(label, size, true) + 15);
      const pillH = 12;
      const pillX = right - pillW;
      const pillY = top - HDR / 2 - pillH / 2;
      idCardPill(doc, pillX, pillY, pillW, pillH, brand.teal);
      idCardFitText(doc, label, pillX + 4, idCardCentreBaseline(pillY, pillH, size), size, { bold: true, color: BRAND.white, align: 'center' }, pillW - 8);
      headRight = pillX - 6;
    }
    let headTx = x + PAD;
    if (logoName) {
      idCardPill(doc, x + 8, top - HDR + 4, 22, 22, BRAND.white, 2.5);
      idCardFitImage(doc, logoName, x + 9, top - HDR + 5, 20, 20, 1);
      headTx = x + 36;
    }
    const headW = Math.max(46, headRight - headTx);
    idCardFitText(doc, opts.company.name.toUpperCase(), headTx, top - 11.5, 9, { bold: true, color: BRAND.white }, headW);
    idCardFitText(doc, 'STAFF IDENTITY CARD', headTx, top - 21.5, 5.4, { bold: true, color: brand.teal }, headW);

    // Photograph: cover-fit inside a white matte so the frame is always filled.
    const photoW = 62;
    const photoH = 80;
    const photoX = x + PAD;
    const photoY = bodyTop - 4 - photoH;
    const inset = 1.5;
    const ix = photoX + inset;
    const iy = photoY + inset;
    const iw = photoW - inset * 2;
    const ih = photoH - inset * 2;
    doc.rect(photoX, photoY, photoW, photoH, BRAND.white);
    doc.rect(ix, iy, iw, ih, BRAND.headerFill);
    if (photoName) {
      idCardCoverImage(doc, photoName, ix, iy, iw, ih);
    } else {
      const initials = (fullName || '?').split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';
      doc.rawText(initials, ix, idCardCentreBaseline(iy, ih, 20) + 6, 20, { bold: true, color: brand.navy, align: 'center', maxWidth: iw });
      doc.rawText('PHOTO ON FILE', ix, iy + 8, 4.6, { color: GRAY, align: 'center', maxWidth: iw });
    }
    doc.strokeRect(photoX, photoY, photoW, photoH, brand.navy, 1);
    doc.strokeRect(ix, iy, iw, ih, BRAND.line, 0.4);

    // Identity details. The name sits on a fixed grid so a one-line and a two-line
    // name share the same rhythm, and the credential plate is anchored to the foot
    // of the column so every card produced in a batch reads identically.
    const colL = x + 76;
    const colR = x + 236;
    const tx = colL + 8;
    const tw = colR - 8 - tx;
    doc.line(colL, y + 30, colL, bodyTop - 2, BRAND.line, 0.6);
    const PLATE_TOP = y + 66.5;
    const PLATE_BOTTOM = y + 36.5;
    const nameLines = wrapText(fullName || 'EMPLOYEE', 12, true, tw).slice(0, 2);
    const nameSlots = nameLines.length > 1 ? [y + 110, y + 93] : [y + 93];
    nameLines.forEach((line, i) => idCardFitLine(doc, line, tx, nameSlots[i], 12, { bold: true, color: brand.navy }, tw, 8));
    idCardFitLine(doc, position || 'Staff', tx, y + 80.5, 8, { color: INK }, tw, 5.5);
    if (department) idCardFitLine(doc, department, tx, y + 71, 6.6, { color: GRAY }, tw, 5.5);

    // Credential plate: a light panel that anchors the official identity number.
    doc.rect(colL, PLATE_BOTTOM, colR - colL, PLATE_TOP - PLATE_BOTTOM, idCardTint(brand.teal, 0.09));
    doc.line(colL, PLATE_TOP, colR, PLATE_TOP, BRAND.line, 0.6);
    const idLabel = 'EMPLOYEE ID';
    const idLabelW = textWidth(idLabel, 5.4, true);
    doc.rawText(idLabel, tx, y + 58, 5.4, { bold: true, color: brand.teal, maxWidth: tw });
    if (shortId) {
      const badge = 'BADGE  ' + shortId.toUpperCase();
      idCardFitLine(doc, badge, tx + idLabelW + 6, y + 58, 5.4, { bold: true, color: GRAY, align: 'right' }, tw - idLabelW - 6, 4.5);
    }
    idCardFitLine(doc, official || 'ID PENDING', tx, y + 42.5, 13, { bold: true, color: brand.navy }, tw, 8);

    // Validity strip, then the property footer.
    doc.rect(x, y + FTR, CARD_W, VAL, idCardTint(brand.navy, 0.07));
    doc.line(x, y + FTR + VAL, x + CARD_W, y + FTR + VAL, BRAND.line, 0.5);
    const validityBits = [issued ? 'Issued ' + issued : '', expires ? 'Expires ' + expires : ''].filter(Boolean);
    const notice = 'Valid only with the holder\u2019s photograph';
    const validity = validityBits.length ? validityBits.join('   \u00b7   ') + '   \u00b7   ' + notice : notice;
    idCardFitText(doc, validity, x + PAD, idCardCentreBaseline(y + FTR, VAL, 5.8), 5.8, { color: INK, align: 'center' }, CARD_W - PAD * 2);
    doc.rect(x, y, CARD_W, FTR, brand.navy);
    idCardFitText(doc, 'Property of ' + company + '   \u00b7   Return to Human Resources', x + PAD, idCardCentreBaseline(y, FTR, 5.2), 5.2, { bold: true, color: BRAND.white, align: 'center' }, CARD_W - PAD * 2);
  };

  // -------------------------------------------------------- back (reverse)
  const drawBack = (x: number, y: number): void => {
    const top = y + CARD_H;
    const HDR = 28;
    const KEY = 2.5;
    const FTR = 16;
    const BAND = 8.5;
    const PAD = 12;
    const bodyTop = top - HDR - KEY;
    const right = x + CARD_W - PAD;

    cropMarks(doc, x, y, CARD_W, CARD_H, brand.navy);
    doc.rect(x, y, CARD_W, CARD_H, BRAND.white);
    idCardSecurityTint(doc, x + 1, y + 1, CARD_W - 2, CARD_H - 2, idCardTint(brand.navy, 0.05));
    doc.strokeRect(x, y, CARD_W, CARD_H, brand.navy, 1.4);
    doc.strokeRect(x + 4, y + 4, CARD_W - 8, CARD_H - 8, BRAND.line, 0.5);

    doc.rect(x, top - HDR, CARD_W, HDR, brand.navy);
    doc.rect(x, top - HDR - KEY, CARD_W, KEY, brand.teal);
    idCardFitText(doc, 'EMPLOYEE IDENTIFICATION', x + PAD, top - 11.5, 8.5, { bold: true, color: BRAND.white, align: 'center' }, CARD_W - PAD * 2);
    idCardFitText(doc, 'Return this card to Human Resources if found', x + PAD, top - 21, 5.4, { bold: true, color: brand.teal, align: 'center' }, CARD_W - PAD * 2);

    // Verification QR above the holder's signature, in the left column.
    const qrSize = 60;
    const qrX = x + PAD;
    const qrY = bodyTop - 2.5 - qrSize;
    doc.rect(qrX, qrY, qrSize, qrSize, BRAND.white);
    doc.strokeRect(qrX, qrY, qrSize, qrSize, brand.navy, 0.9);
    if (qrName) {
      idCardFitImage(doc, qrName, qrX + 3, qrY + 3, qrSize - 6, qrSize - 6, 0);
      idCardFitText(doc, 'SCAN TO VERIFY', qrX, qrY - 8.5, 5.4, { bold: true, color: brand.teal, align: 'center' }, qrSize);
    } else {
      doc.rawText('NO QR CODE', qrX, qrY + qrSize / 2 + 1.5, 6, { color: GRAY, align: 'center', maxWidth: qrSize });
      doc.rawText('VERIFICATION PENDING', qrX, qrY + qrSize / 2 - 7.5, 4.6, { color: GRAY, align: 'center', maxWidth: qrSize });
    }
    if (verifyHost) idCardFitText(doc, verifyHost, qrX, qrY - 17, 4.6, { color: GRAY, align: 'center' }, qrSize);
    doc.line(qrX, y + 37, qrX + qrSize, y + 37, brand.navy, 0.7);
    idCardFitText(doc, 'HOLDER\u2019S SIGNATURE', qrX, y + 31.5, 4.6, { color: GRAY, align: 'center' }, qrSize);

    // Register of the values printed on the card, with a measured row pitch so
    // the block always clears both the header and the footer bands.
    const rows: Array<[string, string]> = [
      ['Official ID', official],
      ['Badge', shortId],
      ['Card No', cardNo],
      ['Serial', serial],
      ['Issued', issued],
      ['Expires', expires],
    ].filter(([, v]) => Boolean(v)) as Array<[string, string]>;
    const fx = x + 84;
    const fw = right - fx;
    const labelW = 58;
    if (rows.length) {
      const regTop = bodyTop - 6;
      const regBottom = y + 34;
      const pitch = Math.min(15, Math.max(9, (regTop - regBottom) / rows.length));
      rows.forEach(([k, v], i) => {
        const baseline = regTop - i * pitch;
        doc.rawText(k.toUpperCase(), fx, baseline, 5.2, { bold: true, color: GRAY, maxWidth: labelW });
        idCardFitText(doc, v, fx + labelW + 4, baseline, 7.6, { bold: true, color: INK }, fw - labelW - 4);
        doc.line(fx, baseline - 4.8, right, baseline - 4.8, BRAND.line, 0.4);
      });
    }

    // Microtext security thread, then the two-line footer.
    doc.rect(x, y + FTR, CARD_W, BAND, idCardTint(brand.navy, 0.07));
    doc.line(x, y + FTR + BAND, x + CARD_W, y + FTR + BAND, BRAND.line, 0.5);
    idCardMicrotext(
      doc,
      opts.company.name.toUpperCase() + '  \u00b7  OFFICIAL EMPLOYEE IDENTITY DOCUMENT  \u00b7  ',
      x + PAD,
      y + FTR + 2.6,
      CARD_W - PAD * 2,
      2.6,
      idCardTint(brand.navy, 0.42)
    );
    doc.rect(x, y, CARD_W, FTR, brand.navy);
    idCardFitText(doc, 'IF FOUND   \u00b7   RETURN TO ' + company.toUpperCase(), x + PAD, y + 9.2, 5.2, { bold: true, color: BRAND.white, align: 'center' }, CARD_W - PAD * 2);
    idCardFitText(doc, 'NOT TRANSFERABLE   \u00b7   SURRENDER ON SEPARATION', x + PAD, y + 3.4, 4.4, { color: idCardTint(brand.teal, 0.75), align: 'center' }, CARD_W - PAD * 2);
  };

  drawFront(frontX, frontY);
  cardLabel('Front', 'CR80  \u00b7  85.6 \u00d7 54 mm', frontY + CARD_H + 11);
  drawBack(frontX, backY);
  cardLabel('Back', 'Print at 100% - do not scale to fit', backY + CARD_H + 11);

  // Printing and issue notes, so HR can produce the card without guesswork.
  const notesTop = backY - 20;
  doc.rawText('PRINTING & ISSUE', MARGIN, notesTop, 8, { bold: true, color: brand.navy, maxWidth: TABLE_W });
  doc.line(MARGIN, notesTop - 4, PAGE_W - MARGIN, notesTop - 4, BRAND.line, 0.5);
  const notes = [
    'Print both faces at 100% scale on CR80 card stock (85.6 \u00d7 54 mm) and cut on the crop marks - do not use fit to page.',
    'The holder signs the reverse before the card is laminated. A card without a photograph or signature is not valid.',
    'The official employee ID printed on the front is permanent: reissue the card, not the ID, if it is lost, damaged or the photograph changes.',
  ];
  let noteY = notesTop - 12;
  notes.forEach((note) => {
    wrapText(note, 6.6, false, TABLE_W - 8).forEach((line, i) => {
      doc.rawText((i === 0 ? '\u2022  ' : '    ') + line, MARGIN, noteY, 6.6, { color: GRAY, maxWidth: TABLE_W });
      noteY -= 9;
    });
    noteY -= 1.5;
  });

  const companyLine = [opts.company.legalName || opts.company.name, opts.company.tin ? 'TIN ' + opts.company.tin : '']
    .filter(Boolean)
    .join('  \u00b7  ');
  doc.footer(
    [
      [opts.company.footerText, companyLine].filter(Boolean).join('  \u00b7  '),
      [
        'Issued by ' + opts.issuedBy + ' on ' + formatDocDateTime(opts.issuedAt),
        opts.verifyUrl ? 'Verify this identity card at ' + opts.verifyUrl : '',
        classifOf(data, opts).toUpperCase(),
      ]
        .filter(Boolean)
        .join('  \u00b7  '),
    ].filter(Boolean),
    { navy: brand.navy, accent: brand.teal, color: GRAY, logoName: footerLogoName }
  );

  return doc.build();
}

function htmlEsc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderIdCardHtml(data: DocData, opts: DocumentRenderOpts): string {
  const navy = brandHex(opts.company.brandColor, '#0b1f33');
  const teal = brandHex(opts.company.brandColorSecondary, '#00a6a6');
  const official = factVal(data, 'Official ID');
  const shortId = factVal(data, 'Badge ID');
  const fullName = factVal(data, 'Employee');
  const department = factVal(data, 'Department');
  const position = factVal(data, 'Position');
  const cardNo = factVal(data, 'Card No');
  const serial = factVal(data, 'Serial');
  const issued = factVal(data, 'Issued');
  const expires = factVal(data, 'Expires');
  const status = statusOf(data, opts);
  const photo = data.photo?.dataUrl
    ? `<img src="${htmlEsc(data.photo.dataUrl)}" alt="Photograph"/>`
    : `<div class="ph"><span>${htmlEsc((fullName || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase())}</span><em>PHOTO ON FILE</em></div>`;
  const qr = data.qrPng
    ? `<img class="qr" src="data:image/png;base64,${data.qrPng.toString('base64')}" alt="QR"/>`
    : '<div class="qr empty">NO QR CODE<br/>VERIFICATION PENDING</div>';
  const company = htmlEsc(opts.company.name);
  const regLine = [opts.company.tin ? 'TIN ' + opts.company.tin : '', opts.company.vrn ? 'VRN ' + opts.company.vrn : '']
    .filter(Boolean)
    .join(' \u00b7 ');
  const primaryLogoSrc = String(opts.company.logoUrl ?? '').trim();
  const primaryLogoHtml = /^https?:\/\//i.test(primaryLogoSrc)
    ? `<img class="hlogo" src="${htmlEsc(primaryLogoSrc)}" alt="${company} logo" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.style.display='none'"/>`
    : '';
  const secondaryLogoSrc = String(opts.company.secondaryLogoUrl ?? '').trim();
  const secondaryLogoHtml = /^https?:\/\//i.test(secondaryLogoSrc)
    ? `<img class="hlogo sec" src="${htmlEsc(secondaryLogoSrc)}" alt="${company} secondary logo" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.style.display='none'"/>`
    : '';
  const footerLogoSrc = String(opts.company.footerLogoUrl ?? '').trim();
  const footerLogoHtml = /^https?:\/\//i.test(footerLogoSrc)
    ? `<img class="flogo" src="${htmlEsc(footerLogoSrc)}" alt="${company} footer logo" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.style.display='none'"/>`
    : '';
  const validity = ['Issued ' + issued, expires ? 'Expires ' + expires : ''].filter(Boolean).join('  ·  ');
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${htmlEsc(data.title)} ${htmlEsc(official)}</title>
<style>
  :root { --navy:${navy}; --teal:${teal}; }
  body { font-family: Arial, Helvetica, sans-serif; color:#172b3c; margin:24px; }
  h1 { font-size:16px; margin:0 0 4px; }
  .muted { color:#6b7280; font-size:12px; margin-bottom:16px; }
  .sheet { display:flex; flex-direction:column; gap:22px; align-items:center; }
  .card { width:85.6mm; height:54mm; border:1.1px solid var(--navy); border-radius:1.5mm; overflow:hidden; position:relative; background:#fff; box-shadow:0 1px 3px rgba(11,31,51,.18); }
  .head { position:relative; background:var(--navy); color:#fff; padding:1.6mm 2.8mm 1.4mm; }
  .head .co { font-size:3.1mm; font-weight:700; letter-spacing:.05em; line-height:1.15; }
  .head .k { font-size:2.2mm; color:var(--teal); font-weight:700; letter-spacing:.03em; }
  .head.center .co, .head.center .k { text-align:center; }
  .chip { position:absolute; right:2.8mm; top:1.6mm; background:var(--teal); color:#fff; font-size:2mm; font-weight:700; letter-spacing:.06em; padding:.7mm 1.6mm; border-radius:999px; }
  .accent { height:3px; background:var(--teal); }
  .front { display:flex; gap:2.8mm; padding:2.4mm; }
  .front img, .ph { width:20.5mm; height:26.5mm; object-fit:cover; border:1px solid var(--navy); background:#f4f6f8; }
  .ph { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1mm; color:var(--navy); }
  .ph span { font-size:6mm; font-weight:700; }
  .ph em { font-style:normal; font-size:1.7mm; color:#5f6b76; }
  .meta { flex:1; min-width:0; }
  .meta .name { font-size:4.4mm; font-weight:700; color:var(--navy); line-height:1.15; }
  .meta .role { font-size:3mm; color:#4b5563; margin-top:.4mm; }
  .meta .dept { font-size:2.7mm; color:#4b5563; }
  .meta .idlabel { font-size:2mm; font-weight:700; letter-spacing:.05em; color:var(--teal); margin-top:1.6mm; }
  .meta .id { font-size:4.6mm; font-weight:700; color:var(--navy); word-break:break-all; }
  .meta .badge { font-size:2.5mm; color:#172b3c; }
  .validity { text-align:center; font-size:2.1mm; color:#5f6b76; padding:.6mm 1mm; }
  .footbar { position:absolute; left:0; right:0; bottom:0; background:var(--navy); color:#fff; font-size:2mm; font-weight:700; text-align:center; padding:.9mm 1mm; }
  .back { padding:0; }
  .backrow { display:flex; gap:3mm; padding:2.4mm 2.8mm; }
  .qrblock { flex:0 0 auto; width:20mm; text-align:center; }
  .qrblock .qr { width:20mm; height:20mm; border:1px solid var(--navy); background:#fff; }
  .qrblock .qr img { width:100%; height:100%; object-fit:contain; }
  .qrblock .qr.empty { font-size:1.8mm; color:#5f6b76; display:flex; flex-direction:column; align-items:center; justify-content:center; }
  .qrlbl { font-size:2mm; font-weight:700; letter-spacing:.04em; color:var(--teal); margin-top:.6mm; }
  .fields { flex:1; min-width:0; }
  .row { display:flex; gap:2mm; padding:.7mm 0; border-bottom:1px solid #e4e9ee; }
  .row .k { flex:0 0 21mm; color:#5f6b76; text-transform:uppercase; font-size:2mm; font-weight:700; letter-spacing:.03em; line-height:1.4; }
  .row .v { flex:1; min-width:0; font-weight:700; font-size:2.7mm; line-height:1.4; word-break:break-all; }
  .terms { text-align:center; font-size:2mm; color:#5f6b76; padding:.6mm 2.8mm 1.6mm; }
  .doc-head { position:relative; display:flex; align-items:flex-start; justify-content:space-between; gap:18px; padding-bottom:10px; }
  .doc-head::before { content:''; position:absolute; left:0; right:0; bottom:0; height:2px; background:var(--navy); }
  .doc-head::after { content:''; position:absolute; left:0; right:0; bottom:-3.4px; height:1.4px; background:var(--teal); }
  .dh-l { display:flex; align-items:flex-start; gap:12px; min-width:0; }
  .dh-r { flex:0 0 auto; display:flex; justify-content:flex-end; }
  .hlogo { height:40px; width:auto; max-width:132px; object-fit:contain; flex:0 0 auto; display:block; }
  .hlogo.sec { height:34px; max-width:148px; }
  /* Two-part card footer: identity band over a document-control rail. */
  .doc-foot { margin:22px 0 0; position:relative; background:#f7fafc; border:1px solid #e4e9ee; font-size:11px; color:#5f6b76; }
  .doc-foot::before { content:''; position:absolute; top:0; left:0; right:0; height:2.4px; background:var(--navy); }
  .doc-foot::after { content:''; position:absolute; top:3.6px; left:0; right:0; height:1.2px; background:var(--teal); }
  .doc-foot .fband { display:flex; align-items:center; gap:18px; padding:14px 18px 12px; }
  .doc-foot .fmk { flex:0 0 auto; max-width:178px; padding-right:18px; border-right:1px solid #d6dee6; }
  .doc-foot .flogo { height:34px; width:auto; max-width:152px; object-fit:contain; display:block; }
  .doc-foot .fi { flex:1 1 auto; min-width:0; }
  .doc-foot .fi .nm { font-size:11px; font-weight:700; color:var(--navy); text-transform:uppercase; letter-spacing:.07em; }
  .doc-foot .ln { font-size:10px; color:#5f6b76; line-height:1.5; margin-top:2.5px; }
  .doc-foot .fstrip { display:flex; align-items:center; gap:14px; padding:6.5px 18px 7px; border-top:1px solid #e4e9ee; background:#fff; }
  .doc-foot .fstrip .ln { flex:1 1 auto; min-width:0; margin-top:0; }
  .doc-foot .k { flex:0 0 auto; font-size:9px; letter-spacing:.16em; text-transform:uppercase; color:var(--teal); font-weight:700; }
  @media print {
    body { margin:8mm; }
    .no-print { display:none; }
    .card { box-shadow:none; }
    .card { break-inside: avoid; }
  }
</style></head>
<body>
  <header class="doc-head">
    <div class="dh-l">
      ${primaryLogoHtml}
      <div>
        <h1>Employee identity card</h1>
        <p class="muted">${company} · print or save as PDF from this window</p>
      </div>
    </div>
    ${secondaryLogoHtml ? `<div class="dh-r">${secondaryLogoHtml}</div>` : ''}
  </header>
  <div class="sheet">
    <div class="card">
      <div class="head">
        <div class="co">${company}</div>
        <div class="k">STAFF IDENTITY CARD</div>
        ${status ? `<span class="chip">${htmlEsc(status.toUpperCase())}</span>` : ''}
      </div>
      <div class="accent"></div>
      <div class="front">
        ${photo}
        <div class="meta">
          <div class="name">${htmlEsc(fullName)}</div>
          <div class="role">${htmlEsc(position)}</div>
          <div class="dept">${htmlEsc(department)}</div>
          <div class="idlabel">EMPLOYEE ID</div>
          <div class="id">${htmlEsc(official || 'ID PENDING')}</div>
          ${shortId ? `<div class="badge">Badge ${htmlEsc(shortId)}</div>` : ''}
        </div>
      </div>
      ${validity ? `<div class="validity">${htmlEsc(validity)}</div>` : ''}
      <div class="footbar">Property of ${company} · Return to Human Resources</div>
    </div>
    <div class="card">
      <div class="back">
        <div class="head center">
          <div class="co">EMPLOYEE IDENTIFICATION</div>
          <div class="k">Return this card to Human Resources if found</div>
        </div>
        <div class="accent"></div>
        <div class="backrow">
          <div class="qrblock">
            <div class="qr">${qr}</div>
            <div class="qrlbl">SCAN TO VERIFY</div>
          </div>
          <div class="fields">
            ${official ? `<div class="row"><div class="k">Official ID</div><div class="v">${htmlEsc(official)}</div></div>` : ''}
            ${shortId ? `<div class="row"><div class="k">Badge</div><div class="v">${htmlEsc(shortId)}</div></div>` : ''}
            ${cardNo ? `<div class="row"><div class="k">Card No</div><div class="v">${htmlEsc(cardNo)}</div></div>` : ''}
            ${serial ? `<div class="row"><div class="k">Serial</div><div class="v">${htmlEsc(serial)}</div></div>` : ''}
            ${issued ? `<div class="row"><div class="k">Issued</div><div class="v">${htmlEsc(issued)}</div></div>` : ''}
            ${expires ? `<div class="row"><div class="k">Expires</div><div class="v">${htmlEsc(expires)}</div></div>` : ''}
          </div>
        </div>
        <div class="terms">This card is not transferable and must be surrendered on separation from service.</div>
        <div class="footbar">IF FOUND · RETURN TO ${company.toUpperCase()}</div>
      </div>
    </div>
  </div>
  <footer class="doc-foot">
    <div class="fband">
      ${footerLogoHtml ? `<div class="fmk">${footerLogoHtml}</div>` : ''}
      <div class="fi">
        <div class="nm">${htmlEsc(opts.company.legalName || opts.company.name)}</div>
        ${opts.company.footerText ? `<div class="ln">${htmlEsc(opts.company.footerText)}</div>` : ''}
        ${regLine ? `<div class="ln">${htmlEsc(regLine)}</div>` : ''}
      </div>
    </div>
    <div class="fstrip">
      <span class="k">Document control</span>
      <div class="ln">Issued by ${htmlEsc(opts.issuedBy)} on ${htmlEsc(formatDocDateTime(opts.issuedAt))}${opts.verifyUrl ? ' \u00b7 ' + htmlEsc(opts.verifyUrl) : ''}</div>
    </div>
  </footer>
  <script src="/assets/print.js"></script>
</body></html>`;
}


function payslipLines(data: DocData, kind: string) {
  return (data.items ?? []).filter((it) => String(it.kind) === kind);
}
function payslipFact(data: DocData, label: string) {
  const hit = (data.facts ?? []).find((row) => row[0] === label);
  return hit ? String(hit[1]) : '';
}
function payslipTotal(data: DocData, label: string) {
  const hit = (data.totals ?? []).find((row) => row[0] === label);
  return hit ? String(hit[1]) : '';
}

function htmlPayslipBody(data: DocData): string {
  const employee = (data.parties ?? []).find((p) => p.heading === 'Employee');
  const name = htmlEsc(employee?.name ?? '');
  const lines = (employee?.lines ?? []).map((ln) => `<div>${htmlEsc(ln)}</div>`).join('');
  const net = htmlEsc(payslipTotal(data, 'Net Pay'));
  const gross = htmlEsc(payslipTotal(data, 'Gross Pay'));
  const deducted = htmlEsc(payslipTotal(data, 'Total Deductions'));
  const payDate = htmlEsc(payslipFact(data, 'Pay Date'));
  const bank = htmlEsc(payslipFact(data, 'Bank'));
  const tin = htmlEsc(payslipFact(data, 'TIN'));
  const nssf = htmlEsc(payslipFact(data, 'NSSF No'));
  const period = htmlEsc(compactRange(payslipFact(data, 'Period')));
  const row = (it: Record<string, unknown>) => `<tr><td>${htmlEsc(it.component)}</td><td>${htmlEsc(it.detail ?? '')}</td><td class="amt">${htmlEsc(it.amount)}</td></tr>`;
  const table = (title: string, kind: string) => {
    const items = payslipLines(data, kind);
    const body = items.length
      ? items.map(row).join('')
      : '<tr><td colspan="3">None for this period</td></tr>';
    return `<section><h3>${title}</h3><table><thead><tr><th>Component</th><th>Basis</th><th>Amount</th></tr></thead><tbody>${body}</tbody></table></section>`;
  };
  return `<style>
    .slip { font-family: inherit; color: inherit; }
    .slip-top { display: flex; gap: 16px; align-items: stretch; margin-top: 8px; }
    .who { flex: 1; border: 1px solid #e4e7ec; border-left: 3px solid var(--teal); padding: 14px 16px; }
    .who .k { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--teal); font-weight: 700; }
    .who .n { font-size: 20px; font-weight: 750; margin: 4px 0 8px; }
    .who .m { font-size: 12px; line-height: 1.45; color: #526072; }
    .who .p { margin-top: 9px; padding-top: 8px; border-top: 1px solid #eef1f4; font-size: 12px; color: #526072; }
    .who .p .k2 { display: inline-block; min-width: 64px; font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--teal); font-weight: 700; }
    .net { width: 220px; background: var(--navy); color: #fff; padding: 14px 16px; }
    .net .k { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--teal); font-weight: 700; }
    .net .v { font-size: 20px; font-weight: 750; margin-top: 8px; }
    .net .s { margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.25); font-size: 12px; opacity: .92; }
    .cols { display: flex; gap: 16px; margin-top: 16px; }
    .cols section { flex: 1; }
    .cols h3 { margin: 0; background: var(--navy); color: #fff; font-size: 11px; letter-spacing: .08em; padding: 8px 10px; }
    .cols table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .cols th { text-align: left; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: #526072; padding: 6px 8px; border-bottom: 1px solid #e4e7ec; }
    .cols td { padding: 7px 8px; border-bottom: 1px solid #eef1f4; vertical-align: top; }
    .cols td.amt, .cols th:last-child { text-align: right; white-space: nowrap; }
    .sum { display: flex; margin-top: 16px; border: 1px solid #e4e7ec; }
    .sum div { flex: 1; padding: 10px 12px; }
    .sum div:last-child { background: var(--navy); color: #fff; }
    .sum .k { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
    .sum .v { font-size: 14px; font-weight: 750; margin-top: 4px; }
    .payto { margin-top: 12px; font-size: 12px; color: #526072; }
    .slip ul { margin: 8px 0 0; padding-left: 18px; font-size: 12px; color: #526072; }
  </style>
  <div class="slip">
    <div class="slip-top">
      <div class="who"><div class="k">Employee</div><div class="n">${name}</div><div class="m">${lines}</div>${period ? `<div class="p"><span class="k2">Period</span>${period}</div>` : ''}</div>
      <div class="net"><div class="k">Net pay</div><div class="v">${net}</div>${payDate ? `<div class="s">Pay date ${payDate}</div>` : ''}</div>
    </div>
    <div class="band">Earnings and deductions</div>
    <div class="cols">${table('Earnings', 'Earning')}${table('Deductions', 'Deduction')}</div>
    <div class="sum">
      <div><div class="k">Gross pay</div><div class="v">${gross}</div></div>
      <div><div class="k">Deductions</div><div class="v">${deducted}</div></div>
      <div><div class="k">Net pay</div><div class="v">${net}</div></div>
    </div>
    <div class="payto">${[bank && `Paid to ${bank}`, tin && `TIN ${tin}`, nssf && `NSSF ${nssf}`].filter(Boolean).join(' · ')}</div>
    ${htmlPayBreakdown(data)}
    ${htmlNotes((data.notes ?? []).filter((n) => n && String(n).trim()), 'Terms and notes')}
    ${htmlSignatures(data.signatures ?? [])}
  </div>`;
}

async function renderPayslipPdf(data: DocData, opts: DocumentRenderOpts): Promise<Buffer> {
  const doc = new PdfDoc();
  doc.setNewPageHandler(() => undefined);
  const brand = brandOf(opts.company);
  const c = opts.company;
  const logoName = preloadLogo(doc, c.logoUrl);
  const secondaryLogo = preloadSecondaryLogo(doc, c.secondaryLogoUrl);
  const footerLogo = preloadFooterLogo(doc, c.footerLogoUrl);
  const classification = classifOf(data, opts);
  const auth = authEnabled(opts);
  const head = letterheadMeta(data, opts, "");
  head.subtitle = undefined;
  head.status = undefined;
  drawLetterhead(doc, head, brand, logoName, secondaryLogo);

  const W = TABLE_W;
  const employee = (data.parties ?? []).find((p) => p.heading === "Employee");
  const net = payslipTotal(data, "Net Pay");
  const gross = payslipTotal(data, "Gross Pay");
  const deducted = payslipTotal(data, "Total Deductions");
  const period = payslipFact(data, "Period");
  const payDate = payslipFact(data, "Pay Date");
  const payrollNo = payslipFact(data, "Payroll No");
  const bank = payslipFact(data, "Bank");
  const tin = payslipFact(data, "TIN");
  const nssfNo = payslipFact(data, "NSSF No");

  const floor = 86;
  let y = doc.cursorY - 4;
  doc.rawText(employee?.name || "", MARGIN, y, 14, { bold: true, color: brand.navy, maxWidth: W });
  y -= 18;
  const who = (employee?.lines ?? []).filter((ln) => ln && String(ln).trim()).slice(0, 3).join("    ·    ");
  if (who) {
    doc.rawText(who, MARGIN, y, 8, { color: BRAND.gray, maxWidth: W });
    y -= 14;
  }

  const metaH = 30;
  y -= 2;
  doc.rect(MARGIN, y - metaH, W, metaH, BRAND.headerFill);
  const meta = [
    ["PERIOD", compactRange(period)],
    ["PAY DATE", payDate],
    ["PAYROLL", payrollNo],
    ["CURRENCY", payslipFact(data, "Currency")],
  ];
  const weights = [1.5, 1.0, 0.9, 0.6];
  const weightSum = weights.reduce((a, b) => a + b, 0);
  meta.forEach(([lab, val], i) => {
    const col = (weights[i] / weightSum) * W;
    const mx = MARGIN + (weights.slice(0, i).reduce((a, b) => a + b, 0) / weightSum) * W;
    const x = mx + 12;
    if (i > 0) doc.line(mx, y - 5, mx, y - metaH + 5, BRAND.line, 0.4);
    doc.rawText(lab, x, y - 12, 5.8, { bold: true, color: brand.teal, maxWidth: col - 24 });
    fitLine(doc, val || "—", x, y - 24, 8, { bold: true, color: brand.navy }, col - 24, 6.4);
  });
  y -= metaH + 12;

  const headH = 16;
  const netH = 36;
  const reserved = 16 + 12 + netH + 8;
  let earnings = payslipLines(data, "Earning");
  let deds = payslipLines(data, "Deduction");
  const fold = (lines: Array<Record<string, unknown>>, max: number) => (
    lines.length <= max
      ? lines
      : [...lines.slice(0, Math.max(0, max - 1)), { component: String(lines.length - (max - 1)) + " further lines", amount: "" }]
  );
  let n = Math.max(earnings.length, deds.length, 1);
  let rowH = 15;
  const room = Math.max(12, y - floor - reserved - headH);
  if (n * rowH > room) rowH = Math.max(12, Math.floor(room / n));
  if (n * rowH > room) {
    const maxRows = Math.max(1, Math.floor(room / 12));
    earnings = fold(earnings, maxRows);
    deds = fold(deds, maxRows);
    n = Math.max(earnings.length, deds.length, 1);
    rowH = 12;
  }

  const gap = 12;
  const colW = (W - gap) / 2;
  const y0 = y;
  const drawCol = (x: number, title: string, lines: Array<Record<string, unknown>>) => {
    doc.rect(x, y0 - headH, colW, headH, brand.navy);
    doc.rawText(title, x + 10, y0 - 11, 7, { bold: true, color: BRAND.white, maxWidth: colW - 20 });
    for (let i = 0; i < n; i++) {
      const bottom = y0 - headH - (i + 1) * rowH;
      doc.rect(x, bottom, colW, rowH, i % 2 === 0 ? BRAND.white : BRAND.zebra);
      doc.line(x + 10, bottom, x + colW - 10, bottom, BRAND.line, 0.3);
      const line = lines[i];
      if (!line) continue;
      const textY = bottom + Math.max(3, (rowH - 8) / 2);
      doc.rawText(String(line.component ?? ""), x + 10, textY, 8, { color: BRAND.ink, maxWidth: colW * 0.56 });
      doc.rawText(String(line.amount ?? ""), x + 8, textY, 8, { bold: true, color: BRAND.ink, align: "right", maxWidth: colW - 18 });
    }
  };
  drawCol(MARGIN, "EARNINGS", earnings);
  drawCol(MARGIN + colW + gap, "DEDUCTIONS", deds);

  const sumY = y0 - headH - n * rowH - 14;
  doc.rawText("Gross pay", MARGIN + 10, sumY, 7.5, { color: BRAND.gray, maxWidth: colW * 0.45 });
  doc.rawText(gross, MARGIN + 8, sumY, 9, { bold: true, color: brand.navy, align: "right", maxWidth: colW - 18 });
  const dx = MARGIN + colW + gap;
  doc.rawText("Deductions", dx + 10, sumY, 7.5, { color: BRAND.gray, maxWidth: colW * 0.45 });
  doc.rawText(deducted, dx + 8, sumY, 9, { bold: true, color: brand.navy, align: "right", maxWidth: colW - 18 });

  const netTop = sumY - 12;
  doc.rect(MARGIN, netTop - netH, W, netH, brand.navy);
  doc.rect(MARGIN, netTop - netH, W, 2.2, brand.teal);
  doc.rawText("NET PAY", MARGIN + 16, netTop - 15, 7.5, { bold: true, color: brand.teal });
  doc.rawText(net, MARGIN + 14, netTop - 15, 14, { bold: true, color: BRAND.white, align: "right", maxWidth: W - 30 });
  const note = [bank && "Paid to " + bank, tin && "TIN " + tin, nssfNo && "NSSF " + nssfNo].filter(Boolean).join("    ·    ");
  if (note) doc.rawText(note, MARGIN + 16, netTop - 28, 7, { color: [0.82, 0.88, 0.9], maxWidth: W - 32 });

  // A payslip is issued as a single sheet, so the whole tail is measured and pinned by
  // drawPayslipTail instead of being laid out with the usual flowing page-break rules.
  doc.cursorY = netTop - netH - 14;
  await drawPayslipTail(doc, data, brand, opts, auth, BOTTOM + 6);

  const companyLine = [c.legalName || c.name, c.tin ? "TIN " + c.tin : "", c.vrn ? "VRN " + c.vrn : ""].filter(Boolean).join("  ·  ");
  const authLine = auth ? `SHA-256 ${opts.fingerprint?.slice(0, 16)}...` : '';
  doc.footer(
    [
      [c.footerText, companyLine].filter(Boolean).join("  ·  "),
      [
        "Issued by " + opts.issuedBy + " on " + formatDocDateTime(opts.issuedAt),
        opts.correlationId ? "Ref " + opts.correlationId : "",
        authLine,
        classification.toUpperCase(),
      ].filter(Boolean).join("  ·  "),
    ].filter(Boolean),
    { navy: brand.navy, accent: brand.teal, color: GRAY, logoName: footerLogo },
  );
  doc.setMetadata({
    title: "Payslip" + (data.code ? " " + data.code : ""),
    author: opts.issuedBy,
    subject: "Payslip",
    keywords: [data.code, c.legalName || c.name].filter(Boolean).join(", "),
    creator: c.name,
    producer: c.legalName || c.name,
  });
  if (/confidential|restricted/i.test(classification)) doc.watermark("CONFIDENTIAL");
  else if (auth) doc.watermark("VERIFIED COPY", { color: [0.965, 0.97, 0.975], size: 46 });
  return doc.build();
}

async function renderPdf(data: DocData, opts: DocumentRenderOpts): Promise<Buffer> {
  if (data.isIdCard) return renderIdCardPdf(data, opts);
  if (data.isPayslip) return renderPayslipPdf(data, opts);
  if (data.isContract) return renderContractPdf(data, opts);
  if (data.isCertificate) return renderCertificatePdf(data, opts);
  const doc = new PdfDoc();
  const auth = authEnabled(opts);
  const classification = classifOf(data, opts);
  const status = statusOf(data, opts);
  const brand = brandOf(opts.company);
  const logoName = preloadLogo(doc, opts.company.logoUrl);
  const secondaryLogoName = preloadSecondaryLogo(doc, opts.company.secondaryLogoUrl);
  const footerLogoName = preloadFooterLogo(doc, opts.company.footerLogoUrl);

  const head = letterheadMeta(data, opts, status);
  doc.setNewPageHandler(() => drawRunningHeader(doc, head, brand, logoName, secondaryLogoName));
  drawLetterhead(doc, head, brand, logoName, secondaryLogoName);

  doc.text(
    'Issued by ' + opts.issuedBy + ' on ' + formatDocDateTime(opts.issuedAt) + (opts.correlationId ? '  \u00b7  Ref ' + opts.correlationId : ''),
    MARGIN,
    7.2,
    { color: GRAY, maxWidth: TABLE_W }
  );
  doc.cursorY -= 4;

  const facts: Array<[string, string]> = [
    ['Document No', data.code || ''],
    ['Issue Date', formatDocDateTime(opts.issuedAt)],
    ...(data.facts ?? []),
    ['Status', status],
    ['Classification', classification],
  ];
  const seen = new Set<string>();
  const uniqueFacts = facts.filter(([k, v]) => {
    const key = k.toLowerCase();
    if (!v || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  drawFacts(doc, uniqueFacts, brand);
  const photoName = data.photo?.bytes ? doc.addImage(data.photo.bytes) : null;
  drawParties(doc, data.parties ?? [], brand, photoName, data.photo?.caption);

  if (data.columns.length && data.items.length) {
    drawContractBand(doc, linesBand(data), brand);
    const columns: PdfTableColumn[] = [{ key: '_no', label: '#', align: 'right', weight: 0.45 }, ...data.columns];
    const rows = data.items.map((it, i) => ({ _no: i + 1, ...it }));
    doc.table({
      x: MARGIN,
      width: TABLE_W,
      columns,
      rows,
      headerFill: brand.navy,
      headerColor: BRAND.white,
      zebra: true,
      zebraFill: BRAND.zebra,
      grid: 'horizontal',
      lineColor: LINE,
      cellPadding: 6,
      headerSize: 7.4,
      size: 8.3,
    });
    doc.cursorY -= 6;
  }

  drawTotals(doc, data.totals, brand);
  drawPaySlipExtras(doc, data, brand);
  drawContractNotices(doc, data.notes, brand, 'Terms and notes');
  await drawContractSignatures(doc, data.signatures ?? [], brand);
  if (auth) {
    doc.cursorY -= 4;
    await drawAuthenticityBlock(doc, opts, brand);
  }

  const companyLine = [opts.company.legalName || opts.company.name, opts.company.tin ? `TIN ${opts.company.tin}` : '', opts.company.vrn ? `VRN ${opts.company.vrn}` : '']
    .filter(Boolean)
    .join('  ·  ');
  const authLine = auth ? `SHA-256 ${opts.fingerprint?.slice(0, 16)}...` : '';
  doc.footer(
    [
      [opts.company.footerText, companyLine].filter(Boolean).join('  ·  '),
      [`Issued by ${opts.issuedBy} on ${formatDocDateTime(opts.issuedAt)}`, opts.correlationId ? `Ref ${opts.correlationId}` : '', authLine, classification.toUpperCase()]
        .filter(Boolean)
        .join('  ·  '),
    ].filter(Boolean),
    { navy: brand.navy, accent: brand.teal, color: GRAY, logoName: footerLogoName }
  );

  doc.setMetadata({
    title: `${data.title}${data.code ? ` ${data.code}` : ''}`,
    author: opts.issuedBy,
    subject: data.subtitle ?? `${data.title} issued by ${opts.company.name}`,
    keywords: [data.code, classification, opts.company.legalName].filter(Boolean).join(', '),
    creator: opts.company.name,
    producer: opts.company.legalName || opts.company.name,
  });
  if (/confidential|restricted/i.test(classification)) doc.watermark('CONFIDENTIAL');
  else if (auth) doc.watermark('VERIFIED COPY', { color: [0.965, 0.97, 0.975], size: 46 });

  return doc.build();
}

async function renderXlsx(data: DocData, opts: DocumentRenderOpts): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = opts.company.name;
  wb.company = opts.company.legalName || opts.company.name;
  wb.created = new Date(opts.issuedAt);
  const ws = wb.addWorksheet(data.title.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().slice(0, 30) || 'Document', {
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.2, footer: 0.2 },
    },
    headerFooter: {
      oddHeader: `&L${opts.company.name}&C${data.title}&R${data.code || ''}`,
      oddFooter: `&L${opts.company.legalName || opts.company.name}  TIN ${opts.company.tin || ''}  ·  ${classifOf(data, opts)}&RPage &P of &N`,
    },
  });

  const brandImages = excelBrandImages(wb, opts.company);
  applyExcelBrandHeader(ws, opts.company, {
    title: data.title,
    subtitle: data.subtitle,
    docNo: data.code,
    issuedBy: opts.issuedBy,
    issuedAt: opts.issuedAt,
    facts: data.facts,
    status: statusOf(data, opts),
    classification: classifOf(data, opts),
    columns: Math.max(8, data.columns.length + 1),
  }, brandImages);

  const navy = brandHex(opts.company.brandColor, 'FF0B1F33');
  const teal = brandHex(opts.company.brandColorSecondary, 'FF00A6A6');

  if (data.parties?.length) {
    for (const p of data.parties) {
      const head = ws.addRow([p.heading.toUpperCase(), p.name]);
      head.getCell(1).font = { bold: true, size: 9, color: { argb: teal } };
      head.getCell(2).font = { bold: true, size: 11, color: { argb: navy } };
      for (const ln of p.lines) ws.addRow(['', ln]);
    }
    ws.addRow([]);
  }

  const headerKeys = ['#', ...data.columns.map((c) => c.label)];
  const hr = ws.addRow(headerKeys);
  hr.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 9 };
  hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
  hr.alignment = { vertical: 'middle' };
  hr.height = 18;
  data.items.forEach((it, i) => {
    const row = ws.addRow([i + 1, ...data.columns.map((cc) => toExcelValue(it[cc.key]))]);
    if (i % 2 === 1) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8F9' } };
    }
    row.alignment = { vertical: 'middle' };
  });
  ws.addRow([]);
  data.totals.forEach(([label, value], i) => {
    const last = i === data.totals.length - 1;
    const row = ws.addRow([label, value]);
    row.font = { bold: true, color: { argb: last ? 'FFFFFFFF' : navy } };
    if (last) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
  });
  const xBreakdown = data.payBreakdown ?? [];
  const xBrackets = data.payeBrackets;
  if (xBreakdown.length || xBrackets?.bands.length) {
    ws.addRow([]);
    if (xBreakdown.length) {
      ws.addRow(['NET PAY CALCULATION']).font = { bold: true, color: { argb: navy } };
      xBreakdown.forEach(([label, value], i) => {
        const last = i === xBreakdown.length - 1;
        const row = ws.addRow([label, value]);
        row.font = { bold: true, color: { argb: last ? 'FFFFFFFF' : navy } };
        if (last) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
      });
    }
    if (xBrackets?.bands.length) {
      ws.addRow([]);
      ws.addRow(['PAYE BRACKETS APPLIED (MONTHLY UGX)']).font = { bold: true, color: { argb: navy } };
      const bhr = ws.addRow(['Monthly taxable income (UGX)', 'PAYE rate']);
      bhr.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 9 };
      bhr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
      xBrackets.bands.forEach(([band, rate]) => ws.addRow([band, rate]));
      if (xBrackets.note) ws.addRow([xBrackets.note]);
    }
  }
  if (data.notes.length) {
    ws.addRow([]);
    ws.addRow(['Terms and notes']).font = { bold: true, color: { argb: navy } };
    for (const note of data.notes) ws.addRow([note]);
  }
  if (authEnabled(opts)) {
    ws.addRow([]);
    ws.addRow(['DOCUMENT AUTHENTICITY']).font = { bold: true, color: { argb: navy } };
    ws.addRow(['SHA-256 Fingerprint', opts.fingerprint]);
    ws.addRow(['Document Token', opts.token]);
    ws.addRow(['Verify URL', opts.verifyUrl]);
  }

  ws.getColumn(1).width = 6;
  ws.getColumn(1).alignment = { horizontal: 'right' };
  data.columns.forEach((col, i) => {
    const excelCol = ws.getColumn(i + 2);
    excelCol.width = Math.max(14, Math.min(36, col.label.length + 12));
    const fmt = excelNumFmt(col.label, col.align);
    if (fmt) excelCol.numFmt = fmt;
    if (col.align === 'right' || fmt) excelCol.alignment = { horizontal: 'right' };
  });
  ws.views = [{ state: 'frozen', ySplit: hr.number }];
  ws.autoFilter = {
    from: { row: hr.number, column: 1 },
    to: { row: hr.number, column: data.columns.length + 1 },
  };
  applyExcelBrandFooter(ws, brandImages, { columns: data.columns.length + 1 });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function renderCsv(data: DocData, opts: DocumentRenderOpts): string {
  const rows: unknown[][] = [];
  const c = opts.company;
  rows.push([c.name]);
  if (c.tagline) rows.push([c.tagline]);
  for (const ln of [...companyContactLines(c), ...companyRegLines(c)]) rows.push([ln]);
  if (c.footerText) rows.push([c.footerText]);
  rows.push([]);
  rows.push([data.title.toUpperCase()]);
  if (data.code) rows.push(['Document No', data.code]);
  if (data.subtitle) rows.push([data.subtitle]);
  rows.push([`Issued by ${opts.issuedBy} on ${formatDocDateTime(opts.issuedAt)}`]);
  if (opts.correlationId) rows.push(['Reference', opts.correlationId]);
  rows.push(['Status', statusOf(data, opts) || 'N/A']);
  rows.push(['Classification', classifOf(data, opts)]);
  rows.push([]);
  if (data.parties?.length) {
    for (const p of data.parties) {
      rows.push([p.heading, p.name]);
      for (const ln of p.lines) rows.push(['', ln]);
    }
    rows.push([]);
  }
  for (const [label, value] of data.facts ?? data.meta) rows.push([label, value]);
  rows.push([]);
  rows.push(['#', ...data.columns.map((cc) => cc.label)]);
  data.items.forEach((it, i) => {
    rows.push([i + 1, ...data.columns.map((cc) => (it[cc.key] == null ? '' : it[cc.key]))]);
  });
  rows.push([]);
  for (const [label, value] of data.totals) rows.push([label, value]);
  const csvBreakdown = data.payBreakdown ?? [];
  const csvBrackets = data.payeBrackets;
  if (csvBreakdown.length || csvBrackets?.bands.length) {
    rows.push([]);
    if (csvBreakdown.length) {
      rows.push(['NET PAY CALCULATION']);
      for (const [label, value] of csvBreakdown) rows.push([label, value]);
    }
    if (csvBrackets?.bands.length) {
      rows.push([]);
      rows.push(['PAYE BRACKETS APPLIED (MONTHLY UGX)']);
      rows.push(['Monthly taxable income (UGX)', 'PAYE rate']);
      for (const [band, rate] of csvBrackets.bands) rows.push([band, rate]);
      if (csvBrackets.note) rows.push([csvBrackets.note]);
    }
  }
  if (data.notes.length) {
    rows.push([]);
    rows.push(['Terms and notes']);
    for (const note of data.notes) rows.push([note]);
  }
  if (authEnabled(opts)) {
    rows.push([]);
    rows.push(['DOCUMENT AUTHENTICITY']);
    rows.push(['SHA-256 Fingerprint', opts.fingerprint]);
    rows.push(['Document Token', opts.token]);
    rows.push(['Verify URL', opts.verifyUrl]);
  }
  rows.push([]);
  rows.push(['Exported By', opts.issuedBy]);
  rows.push(['Exported At', formatDocDateTime(new Date().toISOString())]);
  return stringify(rows, { header: false });
}

function renderJson(data: DocData, opts: DocumentRenderOpts): string {
  const c = opts.company;
  return JSON.stringify(
    {
      data: data.raw,
      meta: {
        title: data.title,
        code: data.code,
        kicker: data.kicker ?? null,
        exportedAt: new Date().toISOString(),
        company: {
          name: c.name,
          legalName: c.legalName,
          code: c.code,
          tin: c.tin,
          vrn: c.vrn,
          address: c.address,
          phone: c.phone,
          email: c.email,
          website: c.website,
          tagline: c.tagline,
          footerText: c.footerText,
          brandColor: c.brandColor,
          brandColorSecondary: c.brandColorSecondary,
          logoUrl: c.logoUrl,
          secondaryLogoUrl: c.secondaryLogoUrl,
          footerLogoUrl: c.footerLogoUrl,
          branch: c.branchName
            ? { name: c.branchName, address: c.branchAddress, phone: c.branchPhone, email: c.branchEmail }
            : null,
        },
        parties: data.parties ?? [],
        facts: data.facts ?? [],
        issuedBy: opts.issuedBy,
        issuedAt: opts.issuedAt,
        correlationId: opts.correlationId ?? null,
        docNo: data.code || null,
        status: statusOf(data, opts) || null,
        classification: classifOf(data, opts),
        payBreakdown: data.payBreakdown ?? [],
        payeBrackets: data.payeBrackets ?? null,
        authenticity: authEnabled(opts)
          ? { fingerprint: opts.fingerprint, token: opts.token, verifyUrl: opts.verifyUrl }
          : null,
      },
    },
    null,
    2
  );
}
function htmlParagraphs(text: string): string {
  return String(text)
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${htmlEsc(p)}</p>`)
    .join('');
}

function htmlSignatures(signs: DocSignature[]): string {
  if (!signs.length) return '';
  return `<div class="signs">${signs
    .slice(0, 3)
    .map((s) => {
      const executed = Boolean(s.signedAt && s.name);
      const sigImg =
        executed && s.signatureUrl && /^(https?:\/\/|\/api\/public\/branding\/(?:signature|contract-signature)\?)/i.test(s.signatureUrl)
          ? `<img class="sig-img" src="${htmlEsc(s.signatureUrl)}" alt="${htmlEsc(s.name)} signature">`
          : '';
      const details = executed
        ? `${s.role ? `<div class="dt">${htmlEsc(s.role)}</div>` : ''}<div class="nm">${htmlEsc(s.name)}</div><div class="dt">Signed electronically ${htmlEsc(formatDocDate(s.signedAt))}</div>`
        : s.name
        ? `<div class="nm">${htmlEsc(s.name)}</div>`
        : '';
      return `<div class="sign"><div class="line"></div>${sigImg}<div class="lbl">${htmlEsc(s.label)}</div>${details}</div>`;
    })
    .join('')}</div>`;
}

function htmlNotes(notes: string[], heading = 'Statutory notice'): string {
  if (!notes.length) return '';
  return `<div class="notes"><h4>${htmlEsc(heading)}</h4>${notes.map((n) => `<p>${htmlEsc(n)}</p>`).join('')}</div>`;
}

function htmlAlignAttr(align?: string | null): string {
  if (align === 'right') return ' class="num"';
  if (align === 'center') return ' class="ctr"';
  return '';
}

function htmlItemsTable(data: DocData): string {
  if (!data.items.length || !data.columns.length) return '';
  const head = data.columns.map((c) => `<th${htmlAlignAttr(c.align)}>${htmlEsc(c.label)}</th>`).join('');
  const body = data.items
    .map(
      (it, i) =>
        `<tr><td class="num">${i + 1}</td>${data.columns
          .map((c) => `<td${htmlAlignAttr(c.align)}>${htmlEsc(it[c.key] ?? '')}</td>`)
          .join('')}</tr>`
    )
    .join('');
  return `<table class="data"><thead><tr><th class="num">#</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function htmlPayBreakdown(data: DocData): string {
  const breakdown = data.payBreakdown ?? [];
  const brackets = data.payeBrackets;
  const parts: string[] = [];
  if (breakdown.length) {
    parts.push('<div class="band">Net Pay calculation</div>');
    parts.push(
      `<div class="totals">${breakdown
        .map(([label, value], i) => {
          const isNet = i === breakdown.length - 1 && /net pay/i.test(label);
          return `<div class="row${isNet ? ' total' : ''}"><span>${htmlEsc(label)}</span><span>${htmlEsc(value)}</span></div>`;
        })
        .join('')}</div>`
    );
  }
  if (brackets?.bands.length) {
    parts.push('<div class="band">PAYE brackets applied</div>');
    parts.push(
      `<table class="data"><thead><tr><th>Monthly taxable income (UGX)</th><th>PAYE rate</th></tr></thead><tbody>${brackets.bands
        .map(([band, rate]) => `<tr><td>${htmlEsc(band)}</td><td>${htmlEsc(rate)}</td></tr>`)
        .join('')}</tbody></table>`
    );
    if (brackets.note) parts.push(`<div class="notes"><p>${htmlEsc(brackets.note)}</p></div>`);
  }
  return parts.filter(Boolean).join('\n');
}

function htmlClauseBody(data: DocData): string {
  const sections = contractSections(data);
  const parts: string[] = [];
  parts.push(
    `<p class="contract-intro">${htmlEsc(
      'This document records the written particulars of employment between the Employer and the Employee identified below and constitutes their contract of employment. It is issued in accordance with the Employment Act (Cap. 226, Laws of Uganda), as amended, and nothing in it removes, reduces or contracts out any statutory right conferred on the Employee.'
    )}</p>`
  );
  if (sections.length) {
    parts.push('<div class="band">Terms and Conditions of Employment</div>');
    let n = 0;
    for (const section of sections) {
      if (section.band) parts.push(`<div class="band light">${htmlEsc(section.band)}</div>`);
      for (const clause of section.clauses) {
        n += 1;
        parts.push(
          `<article class="clause"><h4>${n}. ${htmlEsc(clause.title)}</h4>${htmlParagraphs(clause.text)}${
            clause.legalReference ? `<div class="legal-ref">Legal reference: ${htmlEsc(clause.legalReference)}</div>` : ''
          }</article>`
        );
      }
    }
  }
  if (data.items.length) {
    parts.push('<div class="band">Schedule A — Allowances and Benefits</div>');
    parts.push(htmlItemsTable(data));
  }
  parts.push(htmlNotes(data.notes));
  parts.push(htmlSignatures(data.signatures ?? []));
  return parts.filter(Boolean).join('\n');
}

function htmlCertificateBody(data: DocData): string {
  const employer = partyName(data, 'Employer');
  const employee = partyName(data, 'Employee');
  const employeeNo = factOf(data, 'employee no');
  const position = factOf(data, 'position / capacity');
  const period = factOf(data, 'period of employment');
  const nature = factOf(data, 'nature of business');
  const wages = factOf(data, 'wages at termination');
  const reason = factOf(data, 'reason for termination');
  const raw = data.raw as Record<string, unknown>;
  const duration = serviceDuration(pick(raw, 'period_start'), pick(raw, 'period_end'));
  const paras: string[] = [];
  let opening = 'This is to certify that ' + employee + (employeeNo ? ' (Employee No ' + employeeNo + ')' : '');
  opening += ' was employed by ' + (employer || 'the Employer');
  if (position) opening += ' and served in the capacity of ' + position;
  opening += ' during the period of continuous employment ' + (period ? 'from ' + period : '(set out below)');
  if (duration) opening += ', being a period of ' + duration;
  opening += '.';
  paras.push(opening);
  if (nature) paras.push("The nature of the Employer's business is " + nature + '.');
  if (wages) paras.push('At the date on which the employment ceased, the wages payable to the Employee were ' + wages + '.');
  if (reason) paras.push('The reason for the termination of the employment was: ' + reason + '.');
  paras.push(
    'This certificate is issued at the request of the Employee in accordance with the Employment Act (Cap. 226, Laws of Uganda), as amended. It is a statutory certificate of service and is not a reference as to the character or performance of the Employee.'
  );
  return [
    '<div class="band">Certificate Statement</div>',
    ...paras.map((p) => `<p class="contract-intro">${htmlEsc(p)}</p>`),
    htmlNotes(data.notes),
    htmlSignatures(data.signatures ?? []),
  ].join('\n');
}

function htmlGenericBody(data: DocData): string {
  const parts: string[] = [];
  if (data.items.length) {
    parts.push(`<div class="band">${htmlEsc(linesBand(data))}</div>`);
    parts.push(htmlItemsTable(data));
  }
  if (data.totals.length) {
    parts.push(
      `<div class="totals">${data.totals
        .map(([label, value], i) => `<div class="row${i === data.totals.length - 1 ? ' total' : ''}"><span>${htmlEsc(label)}</span><span>${htmlEsc(value)}</span></div>`)
        .join('')}</div>`
    );
  }
  parts.push(htmlPayBreakdown(data));
  if (data.notes.length) {
    parts.push('<div class="band">Terms and notes</div>');
    parts.push(htmlNotes(data.notes, 'Terms and notes'));
  }
  parts.push(htmlSignatures(data.signatures ?? []));
  return parts.filter(Boolean).join('\n');
}

async function renderHtml(data: DocData, opts: DocumentRenderOpts): Promise<string> {
  const auth = authEnabled(opts);
  const body = data.isPayslip ? htmlPayslipBody(data) : data.isContract ? htmlClauseBody(data) : data.isCertificate ? htmlCertificateBody(data) : htmlGenericBody(data);
  return renderBrandedHtml({
    title: data.title,
    subtitle: data.isPayslip ? undefined : data.subtitle,
    kicker: data.kicker ?? 'Official document',
    company: opts.company,
    issuedBy: opts.issuedBy,
    issuedAt: opts.issuedAt,
    correlationId: opts.correlationId ?? null,
    docNo: data.code,
    status: data.isPayslip ? undefined : statusOf(data, opts),
    classification: classifOf(data, opts),
    parties: data.isPayslip ? [] : data.parties,
    facts: data.isPayslip ? [] : (data.facts ?? data.meta),
    authenticity: data.isPayslip || !auth ? null : { fingerprint: opts.fingerprint ?? '', token: opts.token ?? '', verifyUrl: opts.verifyUrl ?? '' },
    photo: data.photo?.dataUrl ? { dataUrl: data.photo.dataUrl, caption: data.photo.caption } : null,
    body,
  });
}

export async function renderDocument(
  format: string,
  data: DocData,
  opts: DocumentRenderOpts
): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
  data = applyAutoSignatures(data, opts);
  switch (format) {
    case 'pdf':
      return { buffer: await renderPdf(data, opts), contentType: 'application/pdf', extension: 'pdf' };
    case 'xlsx':
      return {
        buffer: await renderXlsx(data, opts),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: 'xlsx',
      };
    case 'csv':
      return { buffer: Buffer.from(renderCsv(data, opts), 'utf-8'), contentType: 'text/csv; charset=utf-8', extension: 'csv' };
    case 'json':
      return { buffer: Buffer.from(renderJson(data, opts), 'utf-8'), contentType: 'application/json; charset=utf-8', extension: 'json' };
    case 'print':
      return {
        buffer: Buffer.from(await renderHtml(data, opts), 'utf-8'),
        contentType: 'text/html; charset=utf-8',
        extension: 'html',
      };
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}
