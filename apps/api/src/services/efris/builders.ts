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
import { buildT109Content, resolveDeviceNo, type UraLine, type UraParty } from './protocol.js';

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
  remarks?: string | null;
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
  }));
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
    deviceNo: resolveDeviceNo(flags, undefined),
    remarks: ctx.remarks ?? ctx.requestRef,
  });
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
  return { payload, ura };
}