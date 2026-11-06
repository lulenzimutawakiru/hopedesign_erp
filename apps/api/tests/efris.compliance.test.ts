// GAP-2/3/4 compliance behaviour: config-driven tax categories (fail-closed),
// B2G buyer classification (fail-closed) and the stable data-exchange id.
// No database — pure protocol.
import { describe, expect, it } from 'vitest';
import {
  buildGlobalInfo,
  buildT109Content,
  buildT110Content,
  buyerTypeCode,
  EfrisProtocolError,
  taxCategory,
} from '../src/services/efris/protocol.js';

const seller = {
  legalName: 'Hope Design Group Ltd',
  businessName: 'Hope Design',
  tin: '1000000000',
  address: 'Kampala',
  email: 'accounts@example.com',
  phone: '256700000000',
  placeOfBusiness: 'Kampala',
};

describe('taxCategory (GAP-2)', () => {
  it('keeps the proven standard and zero defaults', () => {
    expect(taxCategory(0.18)).toEqual({ code: '01', name: 'Standard' });
    expect(taxCategory(0)).toEqual({ code: '02', name: 'Zero' });
  });

  it('refuses to silently relabel a non-standard rate', () => {
    let caught: unknown;
    try {
      taxCategory(0.12);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EfrisProtocolError);
    expect((caught as EfrisProtocolError).code).toBe('EFRIS_TAX_CATEGORY_UNMAPPED');
  });

  it('accepts an explicitly configured rate', () => {
    expect(taxCategory(0.12, { categories: { rates: { '0.12': { code: '03', name: 'Reduced' } } } }))
      .toEqual({ code: '03', name: 'Reduced' });
  });

  it('distinguishes exempt from zero-rated and fails closed without an exempt code', () => {
    // Zero-rated is fine on its own.
    expect(taxCategory(0)).toEqual({ code: '02', name: 'Zero' });
    // Exempt is NOT zero-rated: no code configured → refuse.
    let caught: unknown;
    try {
      taxCategory(0, { exempt: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EfrisProtocolError);
    expect((caught as EfrisProtocolError).code).toBe('EFRIS_EXEMPT_CATEGORY_UNMAPPED');
  });

  it('uses the configured exempt code when present', () => {
    expect(taxCategory(0, { exempt: true, categories: { exempt: { code: '04', name: 'Exempt' } } }))
      .toEqual({ code: '04', name: 'Exempt' });
  });

  it('honours standard/zero overrides', () => {
    expect(taxCategory(0.18, { categories: { standard: { code: 'A1' } } })).toEqual({ code: 'A1', name: 'Standard' });
    expect(taxCategory(0, { categories: { zero: { code: 'B2' } } })).toEqual({ code: 'B2', name: 'Zero' });
  });

  it('surfaces the exempt category in a T109 body instead of mislabelling it zero', () => {
    const withExemptCode = buildT109Content({
      docType: 'SALES_INVOICE',
      docRefCode: 'INV-EXEMPT',
      txnDate: '2026-11-06',
      currency: 'UGX',
      grossAmount: 50000,
      taxAmount: 0,
      seller,
      buyer: null,
      lines: [{ description: 'Exempt supply', quantity: 1, unitPrice: 50000, taxPercent: 0, lineGross: 50000, exempt: true }],
      taxCategories: { exempt: { code: '04', name: 'Exempt' } },
    });
    const tax = withExemptCode.taxDetails as Array<Record<string, string>>;
    expect(tax[0].taxCategoryCode).toBe('04');

    // Without the exempt code the same line must refuse, not become "02 Zero".
    expect(() => buildT109Content({
      docType: 'SALES_INVOICE',
      docRefCode: 'INV-EXEMPT',
      txnDate: '2026-11-06',
      currency: 'UGX',
      grossAmount: 50000,
      taxAmount: 0,
      seller,
      buyer: null,
      lines: [{ description: 'Exempt supply', quantity: 1, unitPrice: 50000, taxPercent: 0, lineGross: 50000, exempt: true }],
    })).toThrow(EfrisProtocolError);
  });
});

describe('buyerTypeCode (GAP-3)', () => {
  it('keeps the proven business/consumer defaults', () => {
    expect(buyerTypeCode({ tin: '1000000001' })).toBe('0');
    expect(buyerTypeCode(null)).toBe('1');
    expect(buyerTypeCode({ tin: null })).toBe('1');
  });

  it('refuses to classify a government buyer as a business', () => {
    let caught: unknown;
    try {
      buyerTypeCode({ tin: '1000000001', buyerKind: 'government' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EfrisProtocolError);
    expect((caught as EfrisProtocolError).code).toBe('EFRIS_B2G_BUYER_TYPE_UNMAPPED');
  });

  it('uses the configured government code, and honours business/consumer overrides', () => {
    expect(buyerTypeCode({ tin: '1000000001', buyerKind: 'government' }, { government: '2' })).toBe('2');
    expect(buyerTypeCode({ tin: '1000000001' }, { business: 'B' })).toBe('B');
    expect(buyerTypeCode(null, { consumer: 'C' })).toBe('C');
  });

  it('flows a government buyer through the T109 buyerType', () => {
    const invoice = buildT109Content({
      docType: 'SALES_INVOICE',
      docRefCode: 'INV-B2G',
      txnDate: '2026-11-06',
      currency: 'UGX',
      grossAmount: 118000,
      taxAmount: 18000,
      seller,
      buyer: { legalName: 'Ministry of Works', tin: '1000000009', buyerKind: 'government' },
      lines: [{ description: 'Paper', quantity: 1, unitPrice: 100000, taxPercent: 18, lineGross: 118000 }],
      buyerTypes: { government: '2' },
    });
    expect((invoice.buyerDetails as Record<string, string>).buyerType).toBe('2');

    // A T110 credit note mirrors the same classification.
    const credit = buildT110Content({
      docType: 'CREDIT_NOTE',
      docRefCode: 'CN-B2G',
      txnDate: '2026-11-06',
      currency: 'UGX',
      grossAmount: 118000,
      taxAmount: 18000,
      seller,
      buyer: { legalName: 'Ministry of Works', tin: '1000000009', buyerKind: 'government' },
      lines: [{ description: 'Paper', quantity: 1, unitPrice: 100000, taxPercent: 18, lineGross: 118000 }],
      buyerTypes: { government: '2' },
    });
    expect((credit.buyerDetails as Record<string, string>).buyerType).toBe('2');
  });
});

describe('stable data-exchange id (GAP-4)', () => {
  it('reuses the caller-provided exchange id across envelopes', () => {
    const base = { interfaceCode: 'T109', tin: '1000000000', deviceNo: 'TCS000000001' };
    const a = buildGlobalInfo({ ...base, exchangeId: 'DEDUP-0001' });
    const b = buildGlobalInfo({ ...base, exchangeId: 'DEDUP-0001' });
    expect(a.dataExchangeId).toBe('DEDUP-0001');
    expect(b.dataExchangeId).toBe('DEDUP-0001');
  });

  it('generates a fresh 32-char uppercase hex id when none is supplied', () => {
    const base = { interfaceCode: 'T109', tin: '1000000000', deviceNo: 'TCS000000001' };
    const a = buildGlobalInfo(base) as Record<string, unknown>;
    const b = buildGlobalInfo(base) as Record<string, unknown>;
    expect(typeof a.dataExchangeId).toBe('string');
    expect(a.dataExchangeId).toMatch(/^[0-9A-F]{32}$/);
    expect(a.dataExchangeId).not.toBe(b.dataExchangeId);
  });
});
