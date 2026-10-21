// Meta WhatsApp Cloud API sender + webhook auth primitives. Pure unit tests:
// the Graph API transport is exercised with a mocked global fetch, and the
// signature/hub-challenge checks are tested directly. No database is required.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import {
  isMetaWhatsappConfigured,
  sendWhatsAppViaMetaCloud,
  verifyHubChallenge,
  verifyMetaSignature,
} from '../src/services/metaWhatsapp.js';

function mockFetch(response: unknown, status = 200) {
  const fn = vi.fn(async () => ({ status, ok: status >= 200 && status < 300, json: async () => response }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const configured = () => {
  config.whatsapp.accessToken = 'test-token';
  config.whatsapp.phoneNumberId = '123456789';
  config.whatsapp.apiVersion = 'v21.0';
};

const cleared = () => {
  config.whatsapp.accessToken = '';
  config.whatsapp.phoneNumberId = '';
  config.whatsapp.apiVersion = 'v21.0';
};

afterEach(() => {
  vi.unstubAllGlobals();
  cleared();
});

describe('isMetaWhatsappConfigured', () => {
  it('requires both a token and a phone number id', () => {
    cleared();
    expect(isMetaWhatsappConfigured()).toBe(false);
    config.whatsapp.accessToken = 'x';
    expect(isMetaWhatsappConfigured()).toBe(false);
    config.whatsapp.phoneNumberId = 'y';
    expect(isMetaWhatsappConfigured()).toBe(true);
  });
});

describe('sendWhatsAppViaMetaCloud', () => {
  it('posts a text message and maps the assigned message id', async () => {
    configured();
    const fetchFn = mockFetch({ messages: [{ id: 'wamid.HbG1' }] });
    const result = await sendWhatsAppViaMetaCloud({ to: '+256712345678', text: 'hello' });
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('meta');
    expect(result.providerMessageId).toBe('wamid.HbG1');

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/123456789/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+256712345678',
      type: 'text',
      text: { body: 'hello' },
    });
  });

  it('posts a template message when a template is supplied', async () => {
    configured();
    const fetchFn = mockFetch({ messages: [{ id: 'wamid.HbG2' }] });
    const result = await sendWhatsAppViaMetaCloud({
      to: '256712345678',
      template: { name: 'otp', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: '123456' }] }] },
    });
    expect(result.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('otp');
  });

  it('normalises the recipient to E.164', async () => {
    configured();
    const fetchFn = mockFetch({ messages: [{ id: 'wamid.HbG3' }] });
    await sendWhatsAppViaMetaCloud({ to: '0712345678', text: 'hi' });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).to).toBe('+256712345678');
  });

  it('refuses to send when not configured', async () => {
    cleared();
    const result = await sendWhatsAppViaMetaCloud({ to: '+256712345678', text: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/i);
  });

  it('refuses when text and template are both missing or both present', async () => {
    configured();
    expect((await sendWhatsAppViaMetaCloud({ to: '+256712345678' })).ok).toBe(false);
    expect((await sendWhatsAppViaMetaCloud({ to: '+256712345678', text: 'x', template: { name: 't', language: { code: 'en' } } })).ok).toBe(false);
  });

  it('does not retry a 4xx and surfaces the provider message', async () => {
    configured();
    const fetchFn = mockFetch({ error: { message: 'Template does not exist' } }, 400);
    const result = await sendWhatsAppViaMetaCloud({ to: '+256712345678', text: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Template does not exist');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 then succeeds', async () => {
    configured();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { status: 429, ok: false, json: async () => ({ error: { message: 'rate limited' } }) };
      return { status: 200, ok: true, json: async () => ({ messages: [{ id: 'wamid.retry' }] }) };
    });
    vi.stubGlobal('fetch', fn);
    const result = await sendWhatsAppViaMetaCloud({ to: '+256712345678', text: 'hi' });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('verifyMetaSignature', () => {
  const secret = 'app-secret';
  const sign = (body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a valid signature over the raw body', () => {
    const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }), 'utf8');
    expect(verifyMetaSignature({ rawBody: body, signatureHeader: sign(body.toString('utf8')), appSecret: secret }).ok).toBe(true);
  });

  it('rejects a tampered body', () => {
    const original = JSON.stringify({ n: 1 });
    const check = verifyMetaSignature({
      rawBody: Buffer.from(JSON.stringify({ n: 2 }), 'utf8'),
      signatureHeader: sign(original),
      appSecret: secret,
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('SIGNATURE_INVALID');
  });

  it('rejects a missing header', () => {
    const check = verifyMetaSignature({ rawBody: Buffer.from('{}', 'utf8'), signatureHeader: null, appSecret: secret });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('SIGNATURE_HEADER_MISSING');
  });

  it('rejects a missing secret', () => {
    const check = verifyMetaSignature({ rawBody: Buffer.from('{}', 'utf8'), signatureHeader: 'sha256=abcd', appSecret: '' });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('SECRET_NOT_CONFIGURED');
  });

  it('rejects an unparsable hex value', () => {
    const check = verifyMetaSignature({ rawBody: Buffer.from('{}', 'utf8'), signatureHeader: 'sha256=zz', appSecret: secret });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('SIGNATURE_HEADER_MISSING');
  });
});

describe('verifyHubChallenge', () => {
  afterEach(() => {
    config.whatsapp.verifyToken = '';
  });

  it('echoes the challenge on a matching subscribe handshake', () => {
    config.whatsapp.verifyToken = 'tok';
    expect(verifyHubChallenge({ mode: 'subscribe', token: 'tok', challenge: '123' })).toEqual({ ok: true, challenge: '123' });
  });

  it('refuses a wrong token, wrong mode, or missing challenge', () => {
    config.whatsapp.verifyToken = 'tok';
    expect(verifyHubChallenge({ mode: 'subscribe', token: 'wrong', challenge: '123' }).ok).toBe(false);
    expect(verifyHubChallenge({ mode: 'other', token: 'tok', challenge: '123' }).ok).toBe(false);
    expect(verifyHubChallenge({ mode: 'subscribe', token: 'tok', challenge: '' }).ok).toBe(false);
  });

  it('refuses when no verify token is configured', () => {
    config.whatsapp.verifyToken = '';
    expect(verifyHubChallenge({ mode: 'subscribe', token: '', challenge: '123' }).ok).toBe(false);
  });
});
