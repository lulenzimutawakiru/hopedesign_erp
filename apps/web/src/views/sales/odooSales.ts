/** Pure helpers for the Odoo 19 Sales quotation screen. */

export type LineKind = 'PRODUCT' | 'SECTION' | 'NOTE';

export interface DraftLine {
  key: string;
  lineKind: LineKind;
  productId: number | '';
  description: string;
  quantity: number;
  unitId: number | '';
  unitPrice: number;
  discountPercent: number;
  taxPercent: number;
  taxCategory: string;
  cost: number;
  weight: number;
}

export interface DraftOptional {
  key: string;
  productId: number | '';
  description: string;
  quantity: number;
  unitPrice: number;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map((n) => Number(n));
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Empty string when validity is 0: Odoo then leaves the expiration blank. */
export function defaultValidUntil(quotationDate: string, days: number): string {
  if (!(days > 0)) return '';
  return addDays(quotationDate, days);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function quotationTotals(lines: DraftLine[]) {
  let untaxed = 0;
  let tax = 0;
  let margin = 0;
  let weight = 0;
  for (const line of lines) {
    if (line.lineKind !== 'PRODUCT') continue;
    const base = line.quantity * line.unitPrice;
    const after = base * (1 - (Number(line.discountPercent) || 0) / 100);
    untaxed += after;
    tax += after * ((Number(line.taxPercent) || 0) / 100);
    margin += after - line.quantity * (Number(line.cost) || 0);
    weight += line.quantity * (Number(line.weight) || 0);
  }
  return {
    untaxed: round2(untaxed),
    tax: round2(tax),
    total: round2(untaxed + tax),
    margin: round2(margin),
    weight: round2(weight),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function buildQuotationItems(lines: DraftLine[]) {
  return lines.map((line, sequence) => {
    if (line.lineKind !== 'PRODUCT') {
      return {
        lineKind: line.lineKind,
        productId: null,
        description: line.description.trim(),
        quantity: 0,
        unitPrice: 0,
        discountPercent: 0,
        taxPercent: 0,
        sequence,
      };
    }
    return {
      lineKind: 'PRODUCT' as const,
      productId: line.productId === '' ? null : Number(line.productId),
      description: line.description.trim(),
      quantity: Number(line.quantity),
      unitId: line.unitId === '' ? null : Number(line.unitId),
      unitPrice: Number(line.unitPrice),
      discountPercent: Number(line.discountPercent) || 0,
      taxPercent: Number(line.taxPercent) || 0,
      taxCategory: line.taxCategory || null,
      sequence,
    };
  });
}

export function buildOptionals(rows: DraftOptional[]) {
  return rows
    .filter((row) => row.productId !== '')
    .map((row, sequence) => ({
      productId: Number(row.productId),
      description: row.description.trim(),
      quantity: Number(row.quantity) || 1,
      unitPrice: Number(row.unitPrice) || 0,
      sequence,
    }));
}

/**
 * What Confirm does next.
 * A draft is submitted. Quotations are approval-free, so submit lands on APPROVED,
 * and Confirm then converts when the user holds sales.quotations.convert.
 * The ISO requirement review still runs inside convert.
 */
export function afterSubmit(status: string, canConvert: boolean): 'convert' | 'approved' | 'waiting' {
  if (status === 'APPROVED' && canConvert) return 'convert';
  if (status === 'APPROVED') return 'approved';
  return 'waiting';
}

export function confirmLabel(status: string, canConvert: boolean): string | null {
  if (status === '' || status === 'DRAFT') return 'Confirm';
  if (status === 'APPROVED' && canConvert) return 'Confirm';
  if (status === 'APPROVED') return null;
  return null;
}

export function shippingPolicyLabel(policy: string): string {
  return policy === 'WHEN_ALL' ? 'When all products are ready' : 'As soon as possible';
}
