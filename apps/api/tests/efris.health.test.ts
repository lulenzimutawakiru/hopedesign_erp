// URA EFRIS scheduled health checks (GAP-6). Unit tests: the gateway probe is
// mocked, and the worker's pool is a fake client that records every INSERT, so
// we can assert the outcome discipline without a database or network.
//
// The invariants proven here:
//   * every active TEST/ACTIVE config yields exactly one health row,
//   * a successful probe records ok=true with the gateway's return code,
//   * a failing probe records ok=false with the error code (never throws),
//   * an offline-enabler config is never probed and records ok=null (manual).
import { afterEach, describe, expect, it, vi } from 'vitest';

const probeMock = vi.fn();
const poolQueryMock = vi.fn();
const connectMock = vi.fn();

vi.mock('../src/services/efris/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/efris/client.js')>();
  return { ...actual, probeEfrisGateway: (...args: unknown[]) => probeMock(...args) };
});

vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>();
  return {
    ...actual,
    pool: { query: (...args: unknown[]) => poolQueryMock(...args), connect: (...args: unknown[]) => connectMock(...args) },
  };
});

import { runEfrisHealthChecks } from '../src/services/efris/health.js';

interface RecordedQuery {
  text: string;
  params: unknown[];
}

function configRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    company_id: 2,
    tenant_id: 2,
    taxpayer_id: 10,
    code: 'EFRIS-1',
    name: 'URA Sandbox',
    mode: 'TEST',
    base_url: 'https://efristest.ura.go.ug/efrisws/ws/taapp/getInformation',
    token_url: null,
    auth_grant_type: 'client_credentials',
    client_id_ref: 'EFRIS_CLIENT_ID',
    credentials_ref: 'EFRIS_CREDENTIALS',
    timeout_seconds: 10,
    max_attempts: 5,
    retry_backoff_seconds: 120,
    poll_interval_seconds: 30,
    fiscalize_sales_on_post: true,
    fiscalize_stock_on_post: true,
    fiscalize_purchases_on_post: false,
    auto_submit: true,
    notify_on_failure: true,
    notify_role_codes: [],
    duplicate_window_seconds: 300,
    payload_mapping: {},
    security_flags: {},
    is_active: true,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    taxpayer_tin: '1047578560',
    ...overrides,
  };
}

function setup(rows: Record<string, unknown>[]) {
  const inserts: RecordedQuery[] = [];
  const queries: RecordedQuery[] = [];
  poolQueryMock.mockReset().mockResolvedValue({ rows });
  const client = {
    query: vi.fn(async (text: string, params: unknown[]) => {
      queries.push({ text, params });
      if (text.includes('INSERT INTO efris_health_checks')) inserts.push({ text, params });
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  connectMock.mockReset().mockResolvedValue(client);
  return { inserts, queries };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('runEfrisHealthChecks', () => {
  it('records one row per active config and persists a successful probe', async () => {
    probeMock.mockResolvedValue({
      ok: true,
      mode: 'TEST',
      host: 'efristest.ura.go.ug',
      interfaceCode: 'T101',
      returnCode: '00',
      message: 'URA sandbox responded',
      serverTime: '2026-11-06 09:00:00',
    });
    const { inserts } = setup([configRow()]);

    const result = await runEfrisHealthChecks(20);
    expect(result.checked).toBe(1);
    expect(probeMock).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
    const params = inserts[0].params;
    expect(params[0]).toBe(2); // company_id
    expect(params[1]).toBe(2); // tenant_id
    expect(params[2]).toBe(1); // config_id
    expect(params[3]).toBe('TEST'); // mode
    expect(params[4]).toBe('URA_S2S'); // protocol
    expect(params[5]).toBe('efristest.ura.go.ug'); // host
    expect(params[6]).toBe(true); // ok
    expect(params[7]).toBe('00'); // return_code
    expect(params[9]).toBe('2026-11-06 09:00:00'); // server_time
  });

  it('records ok=false (never throws) when the probe fails', async () => {
    probeMock.mockRejectedValue(Object.assign(new Error('400 Device does not exist(TCS)'), { code: 'EFRIS_BIZ_REJECT' }));
    const { inserts } = setup([configRow()]);

    const result = await runEfrisHealthChecks(20);
    expect(result.checked).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[6]).toBe(false); // ok
    expect(inserts[0].params[7]).toBe('EFRIS_BIZ_REJECT'); // return_code
    expect(String(inserts[0].params[8])).toContain('Device does not exist');
  });

  it('skips offline-enabler configs: ok=null and the probe is never called', async () => {
    const offline = configRow({
      token_url: 'http://172.18.0.1:9880/efriscs/ws/tcsapp/getInformation',
      security_flags: { protocol: 'offline_enabler' },
    });
    const { inserts } = setup([offline]);

    const result = await runEfrisHealthChecks(20);
    expect(result.checked).toBe(1);
    expect(probeMock).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[4]).toBe('OFFLINE_ENABLER'); // protocol
    expect(inserts[0].params[6]).toBeNull(); // ok
    expect(inserts[0].params[7]).toBe('OFFLINE_ENABLER'); // return_code
  });

  it('returns zero when no active config exists', async () => {
    setup([]);
    const result = await runEfrisHealthChecks(20);
    expect(result.checked).toBe(0);
    expect(probeMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
  });
});
