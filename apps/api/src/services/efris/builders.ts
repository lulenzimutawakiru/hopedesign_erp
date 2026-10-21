/**
 * EFRIS payload builder (spec 79-80).
 *
 * Builds a defensive, configurable submission payload from the registered ERP
 * transaction + taxpayer. The exact URA envelope is version-specific, so the
 * integration never fabricates undocumented fields: it ships a clean canonical
 * structure and lets `payload_mapping` on the active configuration add any
 * fixed/renamed wrapper the current URA specification requires.
 */
import type { EfrisConfigurationRow, EfrisTaxpayerRow } from './config.js';
import {
  buildT109Content,
  buildT110Content,
  buildT131Content,
  isStockDocType,
  resolveDeviceNo,
  type UraLine,
  type UraParty,
  type UraStockInput,
} from './protocol.js';

/** Seller fields the payload builder actually reads from the taxpayer row. */
export type EfrisTaxpayerLite = Pick<
  EfrisTaxpayerRow,
  | 'id'
  | 'legal_name'
  | 'trading_name'
  | 'tin'
  | 'vat_registered'
  | 'vat_number'
  | 'taxpayer_type'
  | 'place_of_business'
  | 'branch_id'
> & Partial<Pick<EfrisTaxpayerRow, 'address' | 'contact_email' | 'contact_phone'>>;

export interface FiscalParty {
  legalName: string | null;
  businessName?: string | null;
  tin: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface FiscalLine {
  itemCode?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  taxPercent: number;
  lineGross: number;
  /** URA unit-of-measure code as registered on the goods (e.g. "CT"). */
  unitOfMeasure?: string | null;
  /** URA goods-category id/name the goods is registered under (T130). */
  goodsCategoryId?: string | null;
  goodsCategoryName?: string | null;
  /** 1 when the line is VAT-applicable, 0 otherwise. */
  vatApplicableFlag?: string | null;
}

/** A T131 stock line: the registered goods identity + a quantity and unit value. */
export interface StockFiscalLine {
  goodsCode: string;
  measureUnit: string;
  quantity: number;
  unitPrice: number;
  remarks?: string | null;
}

/** The stock-movement context a T131 build needs (loaded off the ERP source). */
export interface StockSource {
  operationType: string;
  stockInType: string;
  adjustType: string;
  supplierTin: string | null;
  supplierName: string | null;
  branchId: string | null;
  invoiceNo: string | null;
  stockInDate: string;
  remarks: string | null;
  lines: StockFiscalLine[];
}

export interface FiscalBuildContext {
  docType: string;
  docRefType: string;
  docRefCode: string;
  docRefId: number;
  txnDate: string;
  currency: string;
  grossAmount: number;
  taxAmount: number;
  requestRef: string | null;
  taxpayer: EfrisTaxpayerLite | null;
  config: EfrisConfigurationRow | null;
  buyer?: FiscalParty | null;
  lines?: FiscalLine[];
  oriInvoiceNo?: string | null;
  oriInvoiceId?: string | null;
  remarks?: string | null;
  /** T110 credit note application fields. */
  reasonCode?: string | null;
  reason?: string | null;
  applicationTime?: string | null;
  sellersReferenceNo?: string | null;
  /** T131 stock-movement source (present for stock doc types). */
  stock?: StockSource | null;
}

export interface BuiltFiscalPayload {
  /** Canonical body for an OAuth gateway. */
  payload: Record<string, unknown>;
  /** Inner URA T109 content for the system-to-system gateway. */
  ura: Record<string, unknown>;
}

const compact = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
};

/** Deep-merge `overlay` (from payload_mapping) over `base`; arrays replace. */
function deepMerge(base: Record<string, unknown>, overlay: unknown): Record<string, unknown> {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) {
    return { ...base };
  }
  const out: Record<string, unknown> = { ...base };
  const o = overlay as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    const existing = out[key];
    const next = o[key];
    if (existing && typeof existing === 'object' && !Array.isArray(existing) && next && typeof next === 'object' && !Array.isArray(next)) {
      out[key] = deepMerge(existing as Record<string, unknown>, next);
    } else {
      out[key] = next;
    }
  }
  return out;
}

function asParty(party: FiscalParty | null | undefined): UraParty | null {
  if (!party) return null;
  return {
    legalName: party.legalName,
    businessName: party.businessName ?? party.legalName,
    tin: party.tin,
    address: party.address ?? null,
    email: party.email ?? null,
    phone: party.phone ?? null,
  };
}

function asLines(lines: FiscalLine[] | undefined): UraLine[] {
  if (!lines) return [];
  return lines.map((line) => ({
    itemCode: line.itemCode ?? null,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    taxPercent: line.taxPercent,
    lineGross: line.lineGross,
    unitOfMeasure: line.unitOfMeasure ?? null,
    goodsCategoryId: line.goodsCategoryId ?? null,
    goodsCategoryName: line.goodsCategoryName ?? null,
    vatApplicableFlag: line.vatApplicableFlag ?? null,
  }));
}

/** Build the T131 goodsStockIn/goodsStockInItem body for a stock doc type. */
function buildStockContent(ctx: FiscalBuildContext): Record<string, unknown> {
  const stock = ctx.stock ?? {
    operationType: '101',
    stockInType: '102',
    adjustType: '',
    supplierTin: null,
    supplierName: null,
    branchId: null,
    invoiceNo: null,
    stockInDate: ctx.txnDate,
    remarks: null,
    lines: [] as StockFiscalLine[],
  };
  const input: UraStockInput = {
    docType: ctx.docType,
    docRefCode: ctx.docRefCode,
    stockInDate: stock.stockInDate || ctx.txnDate,
    operationType: stock.operationType || '101',
    stockInType: stock.stockInType ?? null,
    adjustType: stock.adjustType ?? null,
    supplierTin: stock.supplierTin,
    supplierName: stock.supplierName,
    branchId: stock.branchId,
    invoiceNo: stock.invoiceNo,
    remarks: stock.remarks ?? ctx.remarks ?? ctx.requestRef,
    lines: stock.lines.map((line) => ({
      goodsCode: line.goodsCode,
      measureUnit: line.measureUnit,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      remarks: line.remarks ?? null,
    })),
  };
  return buildT131Content(input);
}

/** Resolve the OAuth body and the URA T109 body for a claimed transaction. */
export function buildSubmitPayload(ctx: FiscalBuildContext): BuiltFiscalPayload {
  const taxpayer = ctx.taxpayer;
  const flags = ctx.config?.security_flags && typeof ctx.config.security_flags === 'object'
    ? ctx.config.security_flags
    : {};
  const seller: Record<string, unknown> = {
    legalName: compact(taxpayer?.legal_name ?? null),
    tradingName: compact(taxpayer?.trading_name ?? null),
    tin: compact(taxpayer?.tin ?? null),
    vatRegistered: taxpayer?.vat_registered ?? false,
    vatNumber: compact(taxpayer?.vat_number ?? null),
    taxpayerType: compact(taxpayer?.taxpayer_type ?? null),
    placeOfBusiness: compact(taxpayer?.place_of_business ?? null),
    branchId: taxpayer?.branch_id ?? null,
  };
  const netAmount = Math.round((ctx.grossAmount - ctx.taxAmount) * 100) / 100;
  const invoice: Record<string, unknown> = {
    docType: ctx.docType,
    docRefType: ctx.docRefType,
    docRefId: ctx.docRefId,
    docRefCode: ctx.docRefCode,
    issueDate: ctx.txnDate,
    currency: ctx.currency || 'UGX',
    grossAmount: ctx.grossAmount,
    taxAmount: ctx.taxAmount,
    netAmount,
    requestRef: compact(ctx.requestRef),
    oriInvoiceNo: compact(ctx.oriInvoiceNo ?? null),
  };
  const base: Record<string, unknown> = { seller, invoice };
  const sellerParty: UraParty = {
    legalName: taxpayer?.legal_name ?? null,
    businessName: taxpayer?.trading_name ?? taxpayer?.legal_name ?? null,
    tin: taxpayer?.tin ?? null,
    address: taxpayer?.address ?? null,
    email: taxpayer?.contact_email ?? null,
    phone: taxpayer?.contact_phone ?? null,
    placeOfBusiness: taxpayer?.place_of_business ?? null,
  };
  let ura = buildT109Content({
    docType: ctx.docType,
    docRefCode: ctx.docRefCode,
    txnDate: ctx.txnDate,
    currency: ctx.currency || 'UGX',
    grossAmount: ctx.grossAmount,
    taxAmount: ctx.taxAmount,
    seller: sellerParty,
    buyer: asParty(ctx.buyer),
    lines: asLines(ctx.lines),
    oriInvoiceNo: ctx.oriInvoiceNo ?? null,
    oriInvoiceId: ctx.oriInvoiceId ?? null,
    deviceNo: resolveDeviceNo(flags, undefined),
    remarks: ctx.remarks ?? ctx.requestRef,
  });
  // Credit notes are applied through T110, whose content structure differs from
  // T109 (top-level oriInvoiceId/oriInvoiceNo, minimal basicInformation, no
  // sellerDetails, and a reasonCode/applicationTime). Building them with the T109
  // shape is rejected with 2825 "without original invoice".
  if (ctx.docType.toUpperCase() === 'CREDIT_NOTE' || ctx.docType.toUpperCase() === 'CREDIT') {
    ura = buildT110Content({
      docType: ctx.docType,
      docRefCode: ctx.docRefCode,
      txnDate: ctx.txnDate,
      currency: ctx.currency || 'UGX',
      grossAmount: ctx.grossAmount,
      taxAmount: ctx.taxAmount,
      seller: sellerParty,
      buyer: asParty(ctx.buyer),
      lines: asLines(ctx.lines),
      oriInvoiceNo: ctx.oriInvoiceNo ?? null,
      oriInvoiceId: ctx.oriInvoiceId ?? null,
      reasonCode: ctx.reasonCode ?? null,
      reason: ctx.reason ?? null,
      applicationTime: ctx.applicationTime ?? null,
      sellersReferenceNo: ctx.sellersReferenceNo ?? null,
      remarks: ctx.remarks ?? ctx.requestRef,
    });
  }
  const mapping = ctx.config?.payload_mapping;
  let payload = base;
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    const m = mapping as Record<string, unknown>;
    if (m.fixed && typeof m.fixed === 'object' && !Array.isArray(m.fixed)) {
      payload = deepMerge(base, m.fixed);
      ura = deepMerge(ura, m.fixed);
    }
    if (m.envelope && typeof m.envelope === 'string') {
      payload = { [m.envelope]: payload };
    }
  }
  // Stock movements are recorded through T131, whose body replaces the T109/T110
  // tax-document shape; the OAuth and S2S transports must both carry it. Applied
  // after any envelope/fixed mapping so a stock payload is never rebuilt from the
  // T109 `base`.
  if (isStockDocType(ctx.docType)) {
    const stock = buildStockContent(ctx);
    ura = stock;
    payload = stock;
  }
  return { payload, ura };
}