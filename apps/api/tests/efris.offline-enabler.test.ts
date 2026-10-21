// URA EFRIS offline-enabler transport (Aisino Tax Control Service). Pure unit
// tests: the client is exercised with a mocked global fetch. No database, no
// network, no private key — the whole point of the offline-enabler path is that
// the ERP posts a *plaintext* envelope to the local TCS and the TCS owns the
// crypto. These tests prove exactly that: no T104 key exchange, no RSA signing,
// no encrypted content.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EfrisClientError,
  submitFiscalDocument,
  usesOfflineEnabler,
  type SubmitFiscalOptions,
} from '../src/services/efris/client.js';

const TCS_ENDPOINT = 'http://127.0.0.1:9880/efristcs/ws/tcsapp/getInformation';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');

/** The envelope the Aisino TCS returns: plaintext, empty signature, codeType 0. */
function tcsEnvelope(content: unknown, returnState: Record<string, string> = { returnCode: '00', returnMessage: 'SUCCESS' }) {
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

function baseOptions(overrides: Partial<SubmitFiscalOptions> = {}): SubmitFiscalOptions {
  return {
    mode: 'TEST',
    baseUrl: TCS_ENDPOINT,
    grantType: 'client_credentials',
    timeoutSeconds: 5,
    payload: { saleType: '1', docRefCode: 'PROBE-1' },
    uraPayload: { saleType: '1', docRefCode: 'PROBE-1' },
    docType: 'SALES_INVOICE',
    tin: '1047578560',
    securityFlags: { protocol: 'offline_enabler' },
    ...overrides,
  };
}

describe('usesOfflineEnabler', () => {
  it('recognises every spelling of the offline-enabler protocol flag', () => {
    for (const protocol of ['offline_enabler', 'OFFLINE_ENABLER', 'enabler', 'ENABLER']) {
      expect(usesOfflineEnabler({ tokenUrl: null, securityFlags: { protocol } })).toBe(true);
    }
  });

  it('does not mistake the online paths for the enabler', () => {
    expect(usesOfflineEnabler({ tokenUrl: null, securityFlags: { protocol: 'ura_s2s' } })).toBe(false);
    expect(usesOfflineEnabler({ tokenUrl: 'https://example.test/oauth/token', securityFlags: {} })).toBe(false);
    expect(usesOfflineEnabler({ tokenUrl: null, securityFlags: {} })).toBe(false);
  });
});

describe('submitFiscalDocument via the offline enabler', () => {
  it('posts a plaintext, empty-signature envelope to the TCS and returns the fiscalised response — with no T104', async () => {
    const fiscalised = { basicInformation: { invoiceNo: 'FDN-TCS-001', antifakeCode: 'VRC-TCS-001' } };
    const fn = mockFetch(tcsEnvelope(fiscalised));

    const result = (await submitFiscalDocument(
      baseOptions({ clientSecret: '' })
    )) as { data?: { content?: { basicInformation?: { invoiceNo?: string } } } };

    // Exactly one HTTP round-trip: the T109 submit. A T104 key exchange (the
    // direct S2S path) would be a second fetch.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBe(TCS_ENDPOINT);

    const request = fn.mock.calls[0][1] as { method: string; body: string };
    expect(request.method).toBe('POST');
    const envelope = JSON.parse(request.body) as {
      data: { content: string; signature: string; dataDescription: Record<string, string> };
      globalInfo: { interfaceCode: string; appId: string };
    };
    // Offline mode: content is base64 *plaintext* (encryptCode 1 / codeType 0),
    // signature is empty — the ERP never holds the private key.
    expect(envelope.data.content).toBe(b64(baseOptions().uraPayload));
    expect(envelope.data.signature).toBe('');
    expect(envelope.data.dataDescription).toEqual({ codeType: '0', encryptCode: '1', zipCode: '0' });
    expect(envelope.globalInfo.interfaceCode).toBe('T109');

    // The TCS's plaintext response is unwrapped into a readable object.
    expect(result.data?.content?.basicInformation?.invoiceNo).toBe('FDN-TCS-001');
  });

  it('requires a TIN before sending anything to the TCS', async () => {
    const fn = mockFetch(tcsEnvelope({}));
    await expect(submitFiscalDocument(baseOptions({ tin: '' }))).rejects.toMatchObject({
      name: 'EfrisClientError',
      code: 'EFRIS_TIN_MISSING',
      stage: 'config',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('pre-encodes non-ASCII content so the TCS single-byte re-encode round-trips UTF-8', async () => {
    const payload = { saleType: '1', docRefCode: 'PROBE-2', goodsDetails: [{ itemCode: 'Natex 80g/m²' }] };
    const fn = mockFetch(tcsEnvelope({}));
    await submitFiscalDocument(baseOptions({ payload, uraPayload: payload }));

    const request = fn.mock.calls[0][1] as { body: string };
    const envelope = JSON.parse(request.body) as { data: { content: string } };
    // The raw content must be base64 of the *pre-encoded* JSON ("Â²"), not the
    // plain "²" — otherwise the TCS forwards U+FFFD to URA.
    const decoded = Buffer.from(envelope.data.content, 'base64').toString('utf8');
    expect(decoded).toContain('Natex 80g/mÂ²');
    expect(decoded).not.toContain('Natex 80g/m²');
  });

  it('surfaces a TCS business rejection with the raw payload intact', async () => {
    const rejection = tcsEnvelope({}, { returnCode: '100', returnMessage: 'Taxpayer does not exist(TCS)' });
    mockFetch(rejection);

    let caught: EfrisClientError | null = null;
    try {
      await submitFiscalDocument(baseOptions());
    } catch (err) {
      caught = err as EfrisClientError;
    }
    expect(caught).toBeInstanceOf(EfrisClientError);
    expect(caught?.code).toBe('EFRIS_BIZ_REJECT');
    expect(caught?.stage).toBe('response');
    expect(caught?.message).toContain('100');
    expect(caught?.message).toContain('Taxpayer does not exist(TCS)');
    expect(caught?.payload).toEqual(rejection);
  });
});
