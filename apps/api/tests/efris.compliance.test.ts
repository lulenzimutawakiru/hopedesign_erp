// GAP-2/3/4 compliance behaviour: config-driven tax categories (fail-closed),
// B2B/B2C/B2G buyer classification and the stable data-exchange id.
// No database — pure protocol.
import { describe, expect, it } from 'vitest';
import {
  applyRegisteredBuyer,
  assessBuyerTin,
  buildGlobalInfo,
  buildT109Content,
  buildT110Content,
  buildT114Content,
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

describe('buyerTypeCode (B2B / B2C / B2G)', () => {
  it('keeps the proven business/consumer defaults', () => {
    expect(buyerTypeCode({ tin: '1000000001' })).toBe('0');
    expect(buyerTypeCode(null)).toBe('1');
    expect(buyerTypeCode({ tin: null })).toBe('1');
  });

  it('classifies a government buyer as 3 by default', () => {
    // 2 is URA's foreigner code. A Ugandan TIN sent as 2 is refused.
    expect(buyerTypeCode({ tin: '1000000001', buyerKind: 'government' })).toBe('3');
    expect(buyerTypeCode({ tin: '1000000001', buyerKind: 'government' }, {})).toBe('3');
    expect(buyerTypeCode({ tin: '1000000001', buyerKind: 'b2g' })).toBe('3');
  });

  it('honours business/consumer/government overrides', () => {
    expect(buyerTypeCode({ tin: '1000000001', buyerKind: 'government' }, { government: 'G' })).toBe('G');
    expect(buyerTypeCode({ tin: '1000000001' }, { business: 'B' })).toBe('B');
    expect(buyerTypeCode(null, { consumer: 'C' })).toBe('C');
  });

  it('flows a government buyer through the T109 buyerType without explicit config', () => {
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
    });
    expect((invoice.buyerDetails as Record<string, string>).buyerType).toBe('3');

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
    });
    expect((credit.buyerDetails as Record<string, string>).buyerType).toBe('3');
  });

  it('drops a TIN from a consumer buyer and keeps a business TIN for lookup', () => {
    const consumer = assessBuyerTin(
      { legalName: 'Walk in', tin: '1000000001', buyerKind: 'consumer' },
      '1047578560',
    );
    expect(consumer.action).toBe('use');
    if (consumer.action === 'use') expect(consumer.buyer?.tin).toBeNull();

    const business = assessBuyerTin({ legalName: 'Acme Trading', tin: '1000 000 002' }, '1047578560');
    expect(business).toMatchObject({ action: 'lookup', tin: '1000000002' });

    expect(assessBuyerTin({ legalName: 'Self', tin: '1047578560' }, '1047578560')).toMatchObject({
      action: 'reject',
      code: 'EFRIS_BUYER_TIN_IS_SELLER',
    });
    expect(assessBuyerTin({ legalName: 'Short', tin: '12345' }, '1047578560')).toMatchObject({
      action: 'reject',
      code: 'EFRIS_BUYER_TIN_INVALID',
    });
  });

  it('requires a TIN for a classified business or government buyer', () => {
    for (const buyerKind of ['business', 'b2b', 'government', 'gov', 'b2g']) {
      expect(assessBuyerTin({ legalName: 'Classified', tin: null, buyerKind }, '1047578560')).toMatchObject({
        action: 'reject',
        code: 'EFRIS_BUYER_TIN_REQUIRED',
      });
    }
    const consumer = assessBuyerTin({ legalName: 'Walk in', tin: null, buyerKind: 'b2c' }, '1047578560');
    expect(consumer.action).toBe('use');
    const unclassified = assessBuyerTin({ legalName: 'Unclassified', tin: null }, '1047578560');
    expect(unclassified.action).toBe('use');
  });

  it('stamps the URA registered name onto a buyer TIN invoice', () => {
    const buyer = applyRegisteredBuyer(
      { legalName: 'Acme Trading', businessName: 'Acme Trading', tin: '1000000002' },
      { legalName: 'ACME UGANDA LIMITED', businessName: 'Acme' },
    );
    expect(buyer.legalName).toBe('ACME UGANDA LIMITED');
    expect(buyer.businessName).toBe('Acme');
    const invoice = buildT109Content({
      docType: 'SALES_INVOICE',
      docRefCode: 'INV-TIN',
      txnDate: '2026-11-19',
      currency: 'UGX',
      grossAmount: 118000,
      taxAmount: 18000,
      seller,
      buyer,
      lines: [{ description: 'Paper', quantity: 1, unitPrice: 100000, taxPercent: 18, lineGross: 118000 }],
    });
    const details = invoice.buyerDetails as Record<string, string>;
    expect(details.buyerTin).toBe('1000000002');
    expect(details.buyerLegalName).toBe('ACME UGANDA LIMITED');
    expect(details.buyerType).toBe('0');
  });
});

describe('buildT114Content (credit-note cancel)', () => {
  it('sends the application reference and the caller reason', () => {
    const body = buildT114Content({
      referenceNo: 'APP-100',
      invoiceNo: 'FDN-CN',
      oriInvoiceNo: 'FDN-INV',
      reasonCode: '102',
      reason: 'Customer withdrew the return',
    });
    expect(body).toEqual({
      referenceNo: 'APP-100',
      invoiceNo: 'FDN-CN',
      oriInvoiceNo: 'FDN-INV',
      reasonCode: '102',
      reason: 'Customer withdrew the return',
    });
    expect(Object.keys(body).sort()).toEqual(['invoiceNo', 'oriInvoiceNo', 'reason', 'reasonCode', 'referenceNo']);
  });

  it('refuses a cancel with no application reference and maps an unknown reason to 105', () => {
    expect(() => buildT114Content({ referenceNo: '  ' })).toThrow(EfrisProtocolError);
    try {
      buildT114Content({ referenceNo: '' });
    } catch (err) {
      expect(err).toBeInstanceOf(EfrisProtocolError);
      expect((err as EfrisProtocolError).code).toBe('EFRIS_CREDIT_NOTE_REF_REQUIRED');
    }
    expect(buildT114Content({ referenceNo: 'APP-1', reasonCode: 'NOT-A-CODE', reason: 'Because' }).reasonCode).toBe('105');
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
