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
>;
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
}

export interface BuiltFiscalPayload {
  payload: Record<string, unknown>;
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

/** Resolve the effective request payload for a claimed transaction. */
export function buildSubmitPayload(ctx: FiscalBuildContext): BuiltFiscalPayload {
  const taxpayer = ctx.taxpayer;
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
  };
  const base: Record<string, unknown> = {
    seller,
    invoice,
  };
  const mapping = ctx.config?.payload_mapping;
  let payload = base;
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    const m = mapping as Record<string, unknown>;
    if (m.fixed && typeof m.fixed === 'object' && !Array.isArray(m.fixed)) {
      payload = deepMerge(base, m.fixed);
    }
    if (m.envelope && typeof m.envelope === 'string') {
      const env = m.envelope as string;
      payload = { [env]: payload };
    }
  }
  return { payload };
}