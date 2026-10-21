// Meta WhatsApp webhook ingest + WhatsApp provider routing. Pure unit tests:
// the database boundary is mocked (detach/tx) and the Meta transport is stubbed
// via global fetch, mirroring the efris customer-lookup suite. No database is
// required.
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { ingestWhatsAppEvent } from '../src/services/whatsapp/ingest.js';
import { sendWhatsApp } from '../src/services/bird.js';

// The ingest module reaches the database through detach/tx; both are driven by
// one shared fake client whose query() returns per-SQL results the tests set.
const dbMock = vi.hoisted(() => {
  const handlers: Record<string, () => unknown> = {};
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    for (const [needle, respond] of Object.entries(handlers)) {
      if (sql.includes(needle)) return respond();
    }
    return { rows: [] };
  });
  const client = { query };
  return {
    handlers,
    query,
    client,
    detach: vi.fn(async (fn: (c: unknown, ctx: unknown) => Promise<unknown>) => fn(client, {})),
    tx: vi.fn(async (fn: (c: unknown, ctx: unknown) => Promise<unknown>, ctx: unknown) => fn(client, ctx)),
  };
});

vi.mock('../src/db.js', () => ({
  detach: dbMock.detach,
  tx: dbMock.tx,
}));

const APP_SECRET = 'test-whatsapp-secret';

function sign(rawBody: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(rawBody, 'utf8').digest('hex');
}

/** Resolve any business number onto tenant 2 (single-tenant today). */
function resolveToTenant2() {
  dbMock.handlers['whatsapp_inbound_resolve_number'] = () => ({
    rows: [{ tenant_id: 2, company_id: 2, branch_id: 2 }],
  });
}

function inboundPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+256700000000', phone_number_id: '123456789' },
              contacts: [{ profile: { name: 'Customer' }, wa_id: '256712345678' }],
              messages: [
                {
                  from: '256712345678',
                  id: 'wamid.inbound.1',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'hello there' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

const clearWhatsAppConfig = () => {
  config.whatsapp.accessToken = '';
  config.whatsapp.phoneNumberId = '';
  config.whatsapp.appSecret = '';
  config.whatsapp.verifyToken = '';
  config.whatsapp.apiVersion = 'v21.0';
};

const clearAtConfig = () => {
  config.africastalking.username = '';
  config.africastalking.apiKey = '';
  config.africastalking.whatsappNumber = '';
};

beforeEach(() => {
  for (const k of Object.keys(dbMock.handlers)) delete dbMock.handlers[k];
  dbMock.query.mockClear();
  dbMock.detach.mockClear();
  dbMock.tx.mockClear();
  clearWhatsAppConfig();
  clearAtConfig();
  config.whatsapp.appSecret = APP_SECRET;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ingestWhatsAppEvent', () => {
  it('files an inbound message and acknowledges success', async () => {
    resolveToTenant2();
    dbMock.handlers["direction = 'INBOUND'"] = () => ({ rows: [] });
    dbMock.handlers['INSERT INTO whatsapp_messages'] = () => ({ rows: [{ id: 101 }] });

    const raw = JSON.stringify(inboundPayload());
    const result = await ingestWhatsAppEvent({
      rawBody: raw,
      headers: { 'x-hub-signature-256': sign(raw) },
      payload: inboundPayload(),
      ip: '1.2.3.4',
      userAgent: 'test',
    });

    expect(result).toEqual({ accepted: true, reason: null, inboundMessages: 1, statusUpdates: 0, retryable: false });

    // The insert carried the sender, the E.164 business number, and the body.
    const insertCall = dbMock.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO whatsapp_messages'));
    expect(insertCall).toBeTruthy();
    const params = insertCall?.[1] as unknown[];
    expect(String(params[0])).toBe('2'); // tenant_id
    expect(String(params[2])).toBe('hello there'); // body
    expect(String(params[4])).toBe('256712345678'); // from_number
  });

  it('updates the outbound row from a delivery-status callback', async () => {
    resolveToTenant2();
    dbMock.handlers['UPDATE whatsapp_messages'] = () => ({ rows: [{ id: 55 }] });

    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { display_phone_number: '+256700000000', phone_number_id: '123456789' },
                statuses: [{ id: 'wamid.outbound.1', status: 'delivered', timestamp: '1700000000', recipient_id: '256712345678' }],
              },
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(payload);
    const result = await ingestWhatsAppEvent({
      rawBody: raw,
      headers: { 'x-hub-signature-256': sign(raw) },
      payload,
      ip: '1.2.3.4',
      userAgent: 'test',
    });

    expect(result).toEqual({ accepted: true, reason: null, inboundMessages: 0, statusUpdates: 1, retryable: false });

    const updateCall = dbMock.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE whatsapp_messages'));
    const params = updateCall?.[1] as unknown[];
    expect(String(params[0])).toBe('DELIVERED'); // status
    expect(String(params[2])).toBe('2'); // tenant_id
    expect(String(params[3])).toBe('wamid.outbound.1'); // provider_message_id
  });

  it('refuses a bad signature without touching tenant data', async () => {
    const raw = JSON.stringify(inboundPayload());
    const result = await ingestWhatsAppEvent({
      rawBody: raw,
      headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
      payload: inboundPayload(),
      ip: '1.2.3.4',
      userAgent: 'test',
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('SIGNATURE_INVALID');
    expect(result.retryable).toBe(false);
    // Only the event ledger write ran; no number resolution or message filing.
    expect(dbMock.tx).not.toHaveBeenCalled();
    expect(dbMock.query.mock.calls.some(([sql]) => String(sql).includes('whatsapp_inbound_resolve_number'))).toBe(false);
  });

  it('acks 200 when no tenant owns the business number', async () => {
    dbMock.handlers['whatsapp_inbound_resolve_number'] = () => ({ rows: [] });

    const raw = JSON.stringify(inboundPayload());
    const result = await ingestWhatsAppEvent({
      rawBody: raw,
      headers: { 'x-hub-signature-256': sign(raw) },
      payload: inboundPayload(),
      ip: '1.2.3.4',
      userAgent: 'test',
    });

    // A permanent refusal is acknowledged (200) so Meta stops retrying, but no
    // message is filed and the result is not a transient error.
    expect(result.accepted).toBe(true);
    expect(result.inboundMessages).toBe(0);
    expect(result.retryable).toBe(false);
  });

  it('marks a database fault retryable so Meta redelivers', async () => {
    resolveToTenant2();
    dbMock.handlers["direction = 'INBOUND'"] = () => ({ rows: [] });
    dbMock.handlers['INSERT INTO whatsapp_messages'] = () => {
      throw new Error('connection reset');
    };

    const raw = JSON.stringify(inboundPayload());
    const result = await ingestWhatsAppEvent({
      rawBody: raw,
      headers: { 'x-hub-signature-256': sign(raw) },
      payload: inboundPayload(),
      ip: '1.2.3.4',
      userAgent: 'test',
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('DB_ERROR');
    expect(result.retryable).toBe(true);
  });
});

describe('sendWhatsApp routing', () => {
  function metaResponse() {
    return { status: 200, ok: true, json: async () => ({ messages: [{ id: 'wamid.meta' }] }) };
  }
  function atResponse() {
    return { status: 200, ok: true, json: async () => ({ messageId: 'at-wa-1', status: 'Submitted' }) };
  }

  it('prefers the Meta Cloud provider when configured', async () => {
    config.whatsapp.accessToken = 'tok';
    config.whatsapp.phoneNumberId = '123456789';
    const fetchFn = vi.fn(async () => metaResponse());
    vi.stubGlobal('fetch', fetchFn);

    const result = await sendWhatsApp({ to: '+256712345678', text: { body: 'hi' } });
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('meta');
    expect(fetchFn.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/123456789/messages');
  });

  it('falls back to Africa’s Talking when Meta is unconfigured', async () => {
    config.africastalking.username = 'sandbox';
    config.africastalking.apiKey = 'key';
    config.africastalking.whatsappNumber = '+256700000000';
    const fetchFn = vi.fn(async () => atResponse());
    vi.stubGlobal('fetch', fetchFn);

    const result = await sendWhatsApp({ to: '+256712345678', text: { body: 'hi' } });
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('africastalking');
    expect(fetchFn.mock.calls[0][0]).toBe('https://chat.africastalking.com/whatsapp/message/send');
  });

  it('fails closed when neither provider is configured', async () => {
    const result = await sendWhatsApp({ to: '+256712345678', text: { body: 'hi' } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/i);
  });
});
