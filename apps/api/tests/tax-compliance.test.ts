// Tax compliance totals: posted VAT is signed (credit notes reduce output)
// and input VAT is a credit against the payable. No database.
import { describe, expect, it } from 'vitest';
import { foldVat, summarizeTaxActivity, type TaxActivityRow } from '../src/services/taxFilings.js';

function row(partial: Partial<TaxActivityRow> & Pick<TaxActivityRow, 'id'>): TaxActivityRow {
  return {
    docType: 'SALES_INVOICE',
    docRefType: 'customer_invoices',
    docRefId: 1,
    docRefCode: 'INV',
    txnDate: '2026-11-01',
    baseAmount: 0,
    taxAmount: 0,
    rate: 18,
    status: 'POSTED',
    taxCode: 'VAT-OUT',
    taxName: 'Output VAT',
    taxType: 'VAT',
    direction: 'OUTPUT',
    jurisdictionCode: null,
    ...partial,
  };
}

describe('tax compliance activity', () => {
  const rows: TaxActivityRow[] = [
    row({ id: 'inv', baseAmount: 1000, taxAmount: 180 }),
    row({ id: 'cn', docType: 'CREDIT_NOTE', baseAmount: -200, taxAmount: -36 }),
    row({
      id: 'si',
      docType: 'SUPPLIER_INVOICE',
      direction: 'INPUT',
      taxCode: 'VAT-IN',
      taxName: 'Input VAT',
      baseAmount: 500,
      taxAmount: 90,
    }),
    row({
      id: 'wht',
      docType: 'PAYMENT',
      direction: 'OTHER',
      taxCode: 'WHT',
      taxName: 'Withholding',
      taxType: 'WHT',
      baseAmount: 1000,
      taxAmount: 60,
    }),
  ];

  it('nets credit notes into output VAT and keeps input VAT separate', () => {
    const vat = foldVat(rows);
    expect(vat.outputVatBase).toBe(800);
    expect(vat.outputVat).toBe(144);
    expect(vat.inputVatBase).toBe(500);
    expect(vat.inputVat).toBe(90);
    expect(vat.netVatPayable).toBe(54);
    expect(vat.breakdown.find((line) => line.docType === 'WHT')).toBeUndefined();
  });

  it('presents input VAT as a credit when the payable is totalled', () => {
    const summary = summarizeTaxActivity(rows);
    expect(summary.find((s) => s.taxCode === 'VAT-OUT')?.taxAmount).toBe(144);
    expect(summary.find((s) => s.taxCode === 'VAT-IN')).toMatchObject({ direction: 'INPUT', taxAmount: 90 });
    expect(summary.find((s) => s.taxCode === 'WHT')?.taxAmount).toBe(60);
    const payable = summary.reduce((sum, line) => sum + line.taxAmount * (line.direction === 'INPUT' ? -1 : 1), 0);
    expect(payable).toBe(114);
  });
});
