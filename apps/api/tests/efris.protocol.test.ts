// URA EFRIS protocol. No database: crypto, host isolation, and the T109 body.
import { constants as cryptoConstants, createVerify, generateKeyPairSync, publicEncrypt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  URA_PRODUCTION_ENDPOINT,
  URA_TEST_ENDPOINT,
  assertUrlMatchesMode,
  buildEncryptedEnvelope,
  buildT109Content,
  canonicalizeEndpoint,
  decryptAesEcb,
  encryptAesEcb,
  EfrisProtocolError,
  extractAesKey,
  interfaceCodeFor,
  invoiceTypeFor,
  preEncodeForOfflineEnabler,
  rsaDecryptBase64,
  signRsaSha1,
  unwrapResponse,
} from '../src/services/efris/protocol.js';
import { extractFiscalIdentifiers } from '../src/services/efris/client.js';

const AES_KEY = '0123456789abcdef';

function keyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

const seller = {
  legalName: 'Hope Design Group Ltd',
  businessName: 'Hope Design',
  tin: '1000000000',
  address: 'Kampala',
  email: 'accounts@example.com',
  phone: '256700000000',
  placeOfBusiness: 'Kampala',
};

describe('URA EFRIS protocol', () => {
  it('round-trips an AES-ECB payload and verifies the RSA-SHA1 signature', () => {
    const { privateKey, publicKey } = keyPair();
    const plain = JSON.stringify({ invoiceNo: 'FDN-1', note: 'Kampala café' });
    const cipher = encryptAesEcb(plain, AES_KEY);
    expect(decryptAesEcb(cipher, AES_KEY, '2', '0')).toBe(plain);

    const escaped = privateKey.replace(/\n/g, '\\n');
    const signature = signRsaSha1(cipher, escaped);
    const verify = createVerify('RSA-SHA1');
    verify.update(cipher);
    verify.end();
    expect(verify.verify(publicKey, signature, 'base64')).toBe(true);

    const envelope = buildEncryptedEnvelope(
      { basicInformation: { invoiceNo: 'FDN-1' } },
      AES_KEY,
      { interfaceCode: 'T109', tin: '1000000000', deviceNo: 'TCS000000001' },
      privateKey
    );
    const data = envelope.data as { content: string; signature: string; dataDescription: { codeType: string; encryptCode: string } };
    expect(data.dataDescription).toEqual({ codeType: '1', encryptCode: '2', zipCode: '0' });
    expect(decryptAesEcb(data.content, AES_KEY)).toContain('FDN-1');
    const check = createVerify('RSA-SHA1');
    check.update(data.content);
    check.end();
    expect(check.verify(publicKey, data.signature, 'base64')).toBe(true);
  });

  it('RSA-decrypts the T104 passowrdDes into the symmetric key, hex-lossless through AES', () => {
    // A deliberately binary 16-byte key — hex-encoding must survive the AES
    // helpers' hex/utf8 normalization without loss.
    const keyBytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]);
    const { privateKey, publicKey } = keyPair();
    // URA encrypts the AES key with the taxpayer's PUBLIC key (PKCS#1 v1.5).
    const ciphertext = publicEncrypt(
      { key: publicKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
      keyBytes
    );
    const decrypted = rsaDecryptBase64(ciphertext.toString('base64'), privateKey);
    expect(decrypted.equals(keyBytes)).toBe(true);

    // Exactly what fetchAesKey does after decrypting: hex-encode the bytes and
    // feed them to the AES-ECB helpers.
    const hexKey = decrypted.toString('hex');
    expect(hexKey).toBe('000102030405060708090a0b0c0d0e0f');
    const plain = JSON.stringify({ invoiceNo: 'FDN-T104' });
    const cipher = encryptAesEcb(plain, hexKey);
    expect(decryptAesEcb(cipher, hexKey, '2', '0')).toBe(plain);

    // A malformed private key fails loudly with the documented error code
    // (deterministic — the PEM never parses, unlike a mismatched key whose
    // PKCS#1 padding check only fails probabilistically).
    let caught: unknown;
    try {
      rsaDecryptBase64(ciphertext.toString('base64'), 'not-a-key');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EfrisProtocolError);
    expect((caught as EfrisProtocolError).code).toBe('EFRIS_AES_KEY_DECRYPT_FAILED');
  });

  it('keeps TEST off the live gateway and ACTIVE off the sandbox', () => {
    expect(() => assertUrlMatchesMode('TEST', URA_TEST_ENDPOINT)).not.toThrow();
    expect(() => assertUrlMatchesMode('TEST', 'http://127.0.0.1:9/efris/submit')).not.toThrow();
    expect(() => assertUrlMatchesMode('TEST', 'http://localhost/efris')).not.toThrow();
    expect(() => assertUrlMatchesMode('ACTIVE', URA_PRODUCTION_ENDPOINT)).not.toThrow();
    expect(() => assertUrlMatchesMode('ACTIVE', 'https://efris.ura.go.ug/custom')).not.toThrow();

    for (const url of [URA_PRODUCTION_ENDPOINT, 'https://efris.ura.go.ug/']) {
      expect(() => assertUrlMatchesMode('TEST', url)).toThrow(EfrisProtocolError);
    }
    expect(() => assertUrlMatchesMode('ACTIVE', URA_TEST_ENDPOINT)).toThrow(EfrisProtocolError);
    expect(() => assertUrlMatchesMode('ACTIVE', 'http://127.0.0.1:9/efris')).toThrow(EfrisProtocolError);
    expect(() => assertUrlMatchesMode('ACTIVE', 'http://127.0.0.1:9/efris', { extraProductionHosts: ['127.0.0.1'] })).not.toThrow();
    expect(() => assertUrlMatchesMode('ACTIVE', URA_TEST_ENDPOINT, { extraProductionHosts: ['efristest.ura.go.ug'] })).toThrow(EfrisProtocolError);
    expect(() => assertUrlMatchesMode('ACTIVE', 'https://evil.example/efris')).toThrow(EfrisProtocolError);

    try {
      assertUrlMatchesMode('TEST', URA_PRODUCTION_ENDPOINT);
    } catch (err) {
      expect(err).toBeInstanceOf(EfrisProtocolError);
      expect((err as EfrisProtocolError).code).toBe('EFRIS_MODE_HOST_MISMATCH');
    }

    expect(canonicalizeEndpoint('https://efristest.ura.go.ug/')).toBe(URA_TEST_ENDPOINT);
    expect(canonicalizeEndpoint('https://efrisws.ura.go.ug/')).toBe(URA_PRODUCTION_ENDPOINT);
    expect(canonicalizeEndpoint('https://efris.ura.go.ug/')).toBe('https://efris.ura.go.ug/');
    expect(canonicalizeEndpoint(`${URA_TEST_ENDPOINT}?x=1`)).toContain('/efrisws/ws/taapp/getInformation');
  });

  it('builds a T109 invoice, credit note, and debit note', () => {
    const invoice = buildT109Content({
      docType: 'SALES_INVOICE',
      docRefCode: 'INV-100',
      txnDate: '2026-10-14',
      currency: 'UGX',
      grossAmount: 118000,
      taxAmount: 18000,
      seller,
      buyer: { legalName: 'Acme Ltd', tin: '1000000001', address: 'Jinja', email: 'a@acme.test', phone: '256701000000' },
      lines: [{
        itemCode: 'SKU1',
        description: 'Printed ream',
        quantity: 2,
        unitPrice: 50000,
        taxPercent: 18,
        lineGross: 118000,
      }],
      deviceNo: 'TCS000000001',
      remarks: 'Dispatch',
    });
    const basic = invoice.basicInformation as Record<string, string>;
    expect(basic.invoiceType).toBe('1');
    expect(basic.invoiceKind).toBe('1');
    expect(basic.dataSource).toBe('103');
    expect(basic.deviceNo).toBe('TCS000000001');
    expect(basic.oriInvoiceId).toBe('');
    const goods = invoice.goodsDetails as Array<Record<string, string>>;
    expect(goods).toHaveLength(1);
    expect(goods[0].unitOfMeasure).toBe('101');
    expect(goods[0].itemCode).toBe('SKU1');
    expect(goods[0].unitPrice).toBe('59000.00');
    expect(goods[0].total).toBe('118000.00');
    expect(goods[0].tax).toBe('18000.00');
    const tax = invoice.taxDetails as Array<Record<string, string>>;
    expect(tax[0].taxCategoryCode).toBe('01');
    expect(tax[0].taxAmount).toBe('18000.00');
    const summary = invoice.summary as Record<string, string>;
    expect(summary.grossAmount).toBe('118000.00');
    expect(summary.netAmount).toBe('100000.00');
    const buyer = invoice.buyerDetails as Record<string, string>;
    expect(buyer.buyerType).toBe('0');
    expect(buyer.buyerTin).toBe('1000000001');

    const credit = buildT109Content({
      docType: 'CREDIT_NOTE',
      docRefCode: 'CN-9',
      txnDate: '2026-10-14',
      currency: 'UGX',
      grossAmount: 11800,
      taxAmount: 1800,
      seller,
      buyer: null,
      lines: [],
      oriInvoiceNo: 'FDN-ORIG-1',
    });
    expect((credit.basicInformation as Record<string, string>).invoiceType).toBe('2');
    expect((credit.basicInformation as Record<string, string>).oriInvoiceId).toBe('FDN-ORIG-1');
    expect((credit.buyerDetails as Record<string, string>).buyerType).toBe('1');
    expect(invoiceTypeFor('DEBIT_NOTE')).toBe('3');
    expect(interfaceCodeFor('CREDIT_NOTE', null)).toBe('T109');
    expect(interfaceCodeFor('CREDIT_NOTE', { creditInterface: 'T110' })).toBe('T110');
    expect(interfaceCodeFor('SALES_INVOICE', { interfaceCode: 'T109' })).toBe('T109');
  });

  it('carries the URA goods registration through the T109 goodsDetails', () => {
    const invoice = buildT109Content({
      docType: 'SALES_INVOICE',
      docRefCode: 'INV-URA-1',
      txnDate: '2026-10-19',
      currency: 'UGX',
      grossAmount: 66080,
      taxAmount: 10080,
      seller,
      buyer: null,
      lines: [{
        itemCode: 'Natex A4 superior white Paper 80g/m²',
        description: 'Bond 80 Natex Paper',
        quantity: 1,
        unitPrice: 56000,
        taxPercent: 18,
        lineGross: 66080,
        unitOfMeasure: 'CT',
        goodsCategoryId: '14111507',
        goodsCategoryName: 'Printer or copier paper',
        vatApplicableFlag: '1',
      }],
      deviceNo: 'TCSbbbdfb1846269812',
      remarks: 'ura goods',
    });
    const goods = invoice.goodsDetails as Array<Record<string, string>>;
    expect(goods[0].itemCode).toBe('Natex A4 superior white Paper 80g/m²');
    expect(goods[0].unitOfMeasure).toBe('CT');
    expect(goods[0].goodsCategoryId).toBe('14111507');
    expect(goods[0].goodsCategoryName).toBe('Printer or copier paper');
    expect(goods[0].vatApplicableFlag).toBe('1');
  });

  it('pre-encodes non-ASCII for the offline enabler without touching ASCII', () => {
    // The Aisino TCS re-encodes our base64 content with a single-byte charset, so
    // we pre-encode each UTF-8 code point as Latin-1 mojibake. "²" (U+00B2) is
    // UTF-8 C2 B2, which decodes as "Â²" (U+00C2 U+00B2) in Latin-1 — and the
    // TCS's single-byte re-encode turns that back into C2 B2.
    expect(preEncodeForOfflineEnabler('Natex 80g/m²')).toBe('Natex 80g/mÂ²');
    expect(preEncodeForOfflineEnabler('ASCII only 123')).toBe('ASCII only 123');
    // Round-trip sanity: single-byte encoding the pre-encoded form reproduces the
    // original UTF-8 bytes, which is exactly what URA decodes.
    const original = 'Natex 80g/m²';
    const roundTrip = Buffer.from(preEncodeForOfflineEnabler(original), 'latin1').toString('utf8');
    expect(roundTrip).toBe(original);
  });

  it('reads the misspelled T104 key and the fiscal identifiers from a wrapped body', () => {
    const inner = {
      basicInformation: { invoiceNo: 'FDN-TEST-001', antifakeCode: 'VRC-9' },
      summary: { qrCode: 'https://efristest.ura.go.ug/qr/FDN-TEST-001' },
      passowrdDes: AES_KEY,
    };
    const envelope = {
      data: {
        content: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64'),
        signature: '',
        dataDescription: { codeType: '0', encryptCode: '1', zipCode: '0' },
      },
      returnStateInfo: { returnCode: '00', returnMessage: 'SUCCESS' },
    };
    const unwrapped = unwrapResponse(envelope);
    expect(extractAesKey(unwrapped)).toBe(AES_KEY);
    expect(extractFiscalIdentifiers(unwrapped)).toEqual({
      fdn: 'FDN-TEST-001',
      vrc: 'VRC-9',
      qrRef: 'https://efristest.ura.go.ug/qr/FDN-TEST-001',
    });
  });
});
