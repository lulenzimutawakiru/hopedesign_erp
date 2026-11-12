import { describe, expect, it } from 'vitest';
import {
  addDays,
  afterSubmit,
  buildQuotationItems,
  defaultValidUntil,
  quotationTotals,
  type DraftLine,
} from './odooSales';

function product(partial: Partial<DraftLine> = {}): DraftLine {
  return {
    key: 'a',
    lineKind: 'PRODUCT',
    productId: 1,
    description: 'Ream',
    quantity: 2,
    unitId: 1,
    unitPrice: 100,
    discountPercent: 10,
    taxPercent: 18,
    taxCategory: 'STANDARD',
    cost: 40,
    weight: 2.5,
    ...partial,
  };
}

describe('odoo sales quotation helpers', () => {
  it('adds validity days on the UTC calendar', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(defaultValidUntil('2026-03-01', 30)).toBe('2026-03-31');
    expect(defaultValidUntil('2026-03-01', 0)).toBe('');
  });

  it('prices product lines and ignores sections and notes', () => {
    const totals = quotationTotals([
      product(),
      { ...product(), key: 's', lineKind: 'SECTION', description: 'Paper', quantity: 0, unitPrice: 0 },
      { ...product(), key: 'n', lineKind: 'NOTE', description: 'Lead time 5 days', quantity: 5, unitPrice: 9 },
    ]);
    expect(totals.untaxed).toBe(180);
    expect(totals.tax).toBe(32.4);
    expect(totals.total).toBe(212.4);
    expect(totals.margin).toBe(100);
    expect(totals.weight).toBe(5);
  });

  it('sends sections without a product and keeps product ids', () => {
    const items = buildQuotationItems([
      { ...product(), key: 's', lineKind: 'SECTION', description: '  Paper  ', productId: '' },
      product(),
    ]);
    expect(items[0]).toMatchObject({ lineKind: 'SECTION', productId: null, quantity: 0, description: 'Paper' });
    expect(items[1]).toMatchObject({ lineKind: 'PRODUCT', productId: 1, quantity: 2, sequence: 1 });
  });

  it('converts an approved quotation only when the user may convert', () => {
    expect(afterSubmit('APPROVED', true)).toBe('convert');
    expect(afterSubmit('APPROVED', false)).toBe('approved');
    expect(afterSubmit('SUBMITTED', true)).toBe('waiting');
  });
});
