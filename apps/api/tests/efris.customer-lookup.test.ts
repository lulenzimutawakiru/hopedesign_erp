// URA EFRIS customer TIN lookup (T119). Pure unit tests: the client's transport
// is exercised with a mocked global fetch; the mapping and validation helpers
// are tested directly. No database is required.
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractTaxpayer,
  queryTaxpayerByTin,
  type TaxpayerLookupOptions,
} from '../src/services/efris/client.js';
import { isPlausibleTin, normalizeTin } from '../src/services/efris/taxpayer.js';

function keyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');

function uraEnvelope(content: unknown, returnState: Record<string, string> = { returnCode: '00', returnMessage: 'SUCCESS' }) {
  return {
    data: {
      content: b64(content),
      signature: '',
      dataDescription: { codeType: '0', encryptCode: '1', zipCode: '0' },
    },
    returnStateInfo: returnState,
  };
}

function mockFetch(response: unknown, status = 200) {
  const fn = vi.fn(async () => ({ status, json: async () => response }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function baseOptions(overrides: Partial<TaxpayerLookupOptions> = {}): TaxpayerLookupOptions {
  return {
    mode: 'TEST',
    baseUrl: 'https://efristest.ura.go.ug/efrisws/ws/taapp/getInformation',
    clientId: 'TCS-DEV-001',
    clientSecret: keyPair().privateKey,
    timeoutSeconds: 5,
    securityFlags: { deviceNo: 'TCS-DEV-001' },
    tin: '1000000000',
    lookupTin: '1000000001',
    ...overrides,
  };
}

describe('normalizeTin / isPlausibleTin', () => {
  it('strips spaces, dashes and non-digits', () => {
    expect(normalizeTin(' 100-0000-000 ')).toBe('1000000000');
    expect(normalizeTin('1000000000')).toBe('1000000000');
    expect(normalizeTin('')).toBe('');
    expect(normalizeTin(null)).toBe('');
  });

  it('accepts exactly 10 digits and rejects anything else', () => {
    expect(isPlausibleTin('1000000000')).toBe(true);
    expect(isPlausibleTin('100-000-0000')).toBe(true);
    expect(isPlausibleTin('123456789')).toBe(false);
    expect(isPlausibleTin('12345678901')).toBe(false);
    expect(isPlausibleTin('100000000X')).toBe(false);
    expect(isPlausibleTin('')).toBe(false);
    expect(isPlausibleTin(undefined)).toBe(false);
  });
});

describe('extractTaxpayer', () => {
  const full = {
    tin: '1000000001',
    governmentTIN: 'GOV-001',
    legalName: 'Acme Uganda Ltd',
    businessName: 'Acme',
    address: 'Kampala',
    contactEmail: 'billing@acme.ug',
    contactNumber: '256700000000',
    taxpayerType: 'COMPANY',
    secretFieldThatUraMightAdd: 'should-be-dropped',
  };

  it('maps only the documented URA fields', () => {
    const t = extractTaxpayer({ taxpayer: full });
    expect(t).toEqual({
      tin: '1000000001',
      governmentTin: 'GOV-001',
      legalName: 'Acme Uganda Ltd',
      businessName: 'Acme',
      address: 'Kampala',
      contactEmail: 'billing@acme.ug',
      contactNumber: '256700000000',
      taxpayerType: 'COMPANY',
    });
    // Unknown fields never leak into the DTO.
    expect(t && (t as Record<string, unknown>).secretFieldThatUraMightAdd).toBeUndefined();
  });

  it('maps snake_case response variants', () => {
    const t = extractTaxpayer({
      taxpayer: { tin: '1000000001', legal_name: 'Acme', business_name: 'Acme Trading', contact_email: 'a@b.ug', contact_number: '0700' },
    });
    expect(t?.legalName).toBe('Acme');
    expect(t?.businessName).toBe('Acme Trading');
    expect(t?.contactEmail).toBe('a@b.ug');
    expect(t?.contactNumber).toBe('0700');
  });

  it('returns null when the response has no taxpayer object', () => {
    expect(extractTaxpayer({ message: 'not found' })).toBeNull();
    expect(extractTaxpayer(null)).toBeNull();
  });
});

describe('queryTaxpayerByTin', () => {
  it('sends a signed T119 envelope and parses the taxpayer', async () => {
    const fetchFn = mockFetch(uraEnvelope({
      taxpayer: { tin: '1000000001', legalName: 'Acme Uganda Ltd', businessName: 'Acme' },
    }));
    const result = await queryTaxpayerByTin(baseOptions());
    expect(result.found).toBe(true);
    expect(result.taxpayer?.tin).toBe('1000000001');
    expect(result.taxpayer?.legalName).toBe('Acme Uganda Ltd');

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('efristest.ura.go.ug');
    const body = JSON.parse(String(init.body)) as { globalInfo: { interfaceCode: string }; data: { content: string; dataDescription: Record<string, string> } };
    expect(body.globalInfo.interfaceCode).toBe('T119');
    expect(body.data.dataDescription.codeType).toBe('0');
    // The unencrypted content is base64 of `{ tin, ninBrn: '' }`.
    const decoded = JSON.parse(Buffer.from(body.data.content, 'base64').toString('utf8'));
    expect(decoded).toEqual({ tin: '1000000001', ninBrn: '' });
    expect(body.data.signature).not.toBe('');
  });

  it('returns found:false when URA has no taxpayer for the TIN', async () => {
    mockFetch(uraEnvelope({ message: 'The taxpayer does not exist or the state is abnormal!' }));
    const result = await queryTaxpayerByTin(baseOptions());
    expect(result.found).toBe(false);
    expect(result.taxpayer).toBeNull();
  });

  it('refuses DISABLED mode without calling URA', async () => {
    const fetchFn = mockFetch({});
    await expect(queryTaxpayerByTin(baseOptions({ mode: 'DISABLED' }))).rejects.toMatchObject({ code: 'EFRIS_MODE_DISABLED' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses the OAuth transport for T119', async () => {
    await expect(queryTaxpayerByTin(baseOptions({ tokenUrl: 'https://auth.example.com/token' })))
      .rejects.toMatchObject({ code: 'EFRIS_LOOKUP_TRANSPORT' });
  });

  it('surfaces a URA business rejection', async () => {
    mockFetch(uraEnvelope({}, { returnCode: '99', returnMessage: 'TIN not found' }));
    await expect(queryTaxpayerByTin(baseOptions())).rejects.toMatchObject({ code: 'EFRIS_BIZ_REJECT' });
  });

  it('requires a device private key', async () => {
    mockFetch({});
    await expect(queryTaxpayerByTin(baseOptions({ clientSecret: undefined })))
      .rejects.toMatchObject({ code: 'EFRIS_PRIVATE_KEY_MISSING' });
  });
});
