// ============================================================
// URA EFRIS fiscalization - integration tests (spec 74-103).
//
// These tests prove the governance invariants that make the
// fiscalization module production-safe:
//   * an unconfigured company registers PENDING/DISABLED and can
//     never reach FISCALIZED,
//   * document registration is idempotent (one ERP document = one
//     fiscal transaction, no matter how often it is submitted),
//   * raw integration secrets are rejected on every write path,
//   * a failing URA call is recorded (error centre + sync log) and
//     leaves no fiscal document behind,
//   * configuration reads never leak secret material.
// ============================================================
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { api, auth, loginAs, pool } from './helpers.js';
import { drainEfrisQueue } from '../src/services/efris/processor.js';
import { encryptAesEcb } from '../src/services/efris/protocol.js';

const TENANT_ID = 2;
const COMPANY_ID = 2;
const startedAt = new Date();

/** Run a statement as the test tenant/company so RLS permits the write. */
async function asTenant(text: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_app_context($1,$2,NULL,NULL)', [TENANT_ID, COMPANY_ID]);
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const tag = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const txnIds: number[] = [];
const configIds: number[] = [];
const configCodes: string[] = [];
const taxpayerCodes: string[] = [];
const invoiceIds: number[] = [];

/** Park a configuration so the 20s background worker cannot race the test. */
async function parkConfig(id: number) {
  await asTenant(`UPDATE efris_configurations SET is_active = false, mode = 'DISABLED' WHERE id = $1`, [id]);
}

const URA_AES_KEY = '0123456789abcdef';

/** Local stand-in for the URA getInformation endpoint. Speaks T101, T104 and T109. */
function startUraMock(fdn = 'FDN-TEST-001'): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      let code = '';
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { globalInfo?: { interfaceCode?: string } };
        code = String(body.globalInfo?.interfaceCode ?? '');
      } catch {
        code = '';
      }
      const send = (content: unknown, encrypted: boolean) => {
        const text = JSON.stringify(content);
        const payload = encrypted ? encryptAesEcb(text, URA_AES_KEY) : Buffer.from(text, 'utf8').toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            content: payload,
            signature: '',
            dataDescription: encrypted
              ? { codeType: '1', encryptCode: '2', zipCode: '0' }
              : { codeType: '0', encryptCode: '1', zipCode: '0' },
          },
          returnStateInfo: { returnCode: '00', returnMessage: 'SUCCESS' },
        }));
      };
      if (code === 'T101') {
        send({ serverTime: '2026-10-14 12:00:00' }, false);
        return;
      }
      if (code === 'T104') {
        send({ passowrdDes: URA_AES_KEY }, false);
        return;
      }
      if (code === 'T109' || code === 'T110') {
        send({
          basicInformation: { invoiceNo: fdn, antifakeCode: 'VRC-TEST-001' },
          summary: { qrCode: `https://efristest.ura.go.ug/qr/${fdn}` },
        }, true);
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ returnStateInfo: { returnCode: '99', returnMessage: `unexpected ${code}` } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/efrisws/ws/taapp/getInformation` });
    });
  });
}

function deviceCredentials(): { keyRef: string; deviceRef: string; cleanup: () => void } {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const keyRef = `EFRIS_IT_KEY_${tag()}`;
  const deviceRef = `EFRIS_IT_DEV_${tag()}`;
  process.env[keyRef] = privateKey;
  process.env[deviceRef] = 'TCS000000001';
  return {
    keyRef,
    deviceRef,
    cleanup: () => {
      delete process.env[keyRef];
      delete process.env[deviceRef];
    },
  };
}

async function queueTxn(taxpayerId: number, mode: 'TEST' | 'ACTIVE' = 'TEST') {
  const key = `MANUAL:${mode}:${tag()}`;
  const ins = await asTenant(
    `INSERT INTO efris_transactions
       (company_id, tenant_id, taxpayer_id, fiscal_mode, doc_type, doc_ref_type, doc_ref_id,
        doc_ref_code, txn_date, currency, gross_amount, tax_amount, idempotency_key, status, created_at)
     VALUES ($1,$2,$3,$4,'SALES_INVOICE','customer_invoices',999996,$5,CURRENT_DATE,'UGX',118000,18000,$6,'QUEUED','1970-01-02')
     RETURNING id`,
    [COMPANY_ID, TENANT_ID, taxpayerId, mode, `TS-${key}`, key]
  );
  const txnId = Number(ins.rows[0].id);
  txnIds.push(txnId);
  return txnId;
}

async function drainOwn(txnId: number) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const cur = await asTenant('SELECT status FROM efris_transactions WHERE id = $1', [txnId]);
    const status = String(cur.rows[0]?.status ?? '');
    if (status === 'FISCALIZED' || status === 'FAILED' || status === 'REJECTED') return status;
    await drainEfrisQueue(25);
  }
  const cur = await asTenant('SELECT status FROM efris_transactions WHERE id = $1', [txnId]);
  return String(cur.rows[0]?.status ?? '');
}

/** Create a TEST taxpayer + TEST configuration through the real API. */
async function createTestTarget(
  token: string,
  opts: {
    baseUrl?: string;
    tokenUrl?: string;
    fiscalizeSalesOnPost?: boolean;
    mode?: string;
    clientIdRef?: string;
    credentialsRef?: string;
    securityFlags?: Record<string, unknown>;
    name?: string;
  } = {}
) {
  const tCode = `TT${tag()}`;
  const tp = await api.post('/api/ops/finance/efris/taxpayers').set(auth(token)).send({
    code: tCode,
    legalName: 'Hope Design Group Ltd',
    tradingName: 'Hope Design',
    // tin is UNIQUE (company_id, tin) - every target needs its own registration.
    tin: String(1000000000 + Math.floor(Math.random() * 899999999)),
    vatRegistered: true,
    environment: 'TEST',
    efrisStatus: 'TESTING',
    placeOfBusiness: 'Kampala',
  });
  expect(tp.status).toBe(200);
  taxpayerCodes.push(tCode);

  const cCode = `TC${tag()}`;
  const cfg = await api.post('/api/ops/finance/efris/configurations').set(auth(token)).send({
    code: cCode,
    name: opts.name ?? 'URA EFRIS TEST',
    mode: opts.mode ?? 'TEST',
    taxpayerId: Number(tp.body.data.id),
    fiscalizeSalesOnPost: opts.fiscalizeSalesOnPost === true,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.tokenUrl ? { tokenUrl: opts.tokenUrl } : {}),
    ...(opts.clientIdRef ? { clientIdRef: opts.clientIdRef } : {}),
    ...(opts.credentialsRef ? { credentialsRef: opts.credentialsRef } : {}),
    ...(opts.securityFlags ? { securityFlags: opts.securityFlags } : {}),
  });
  expect(cfg.status).toBe(200);
  configCodes.push(cCode);
  configIds.push(Number(cfg.body.data.id));
  return { taxpayerId: Number(tp.body.data.id), configId: Number(cfg.body.data.id), configCode: cCode };
}

afterAll(async () => {
  for (const id of configIds) await parkConfig(id);

  if (txnIds.length) {
    const ph = txnIds.map((_, i) => `$${i + 1}`).join(',');
    await asTenant(`DELETE FROM efris_sync_logs WHERE efris_transaction_id IN (${ph})`, txnIds);
    await asTenant(`DELETE FROM efris_integration_errors WHERE efris_transaction_id IN (${ph})`, txnIds);
    await asTenant(`DELETE FROM efris_documents WHERE efris_transaction_id IN (${ph})`, txnIds);
    await asTenant(`DELETE FROM efris_transactions WHERE id IN (${ph})`, txnIds);
  }
  if (configIds.length) {
    const ph = configIds.map((_, i) => `$${i + 1}`).join(',');
    await asTenant(`DELETE FROM efris_integration_errors WHERE config_id IN (${ph})`, configIds);
  }
  if (configCodes.length) {
    const ph = configCodes.map((_, i) => `$${i + 1}`).join(',');
    await asTenant(`DELETE FROM efris_configurations WHERE code IN (${ph})`, configCodes);
  }
  if (taxpayerCodes.length) {
    const ph = taxpayerCodes.map((_, i) => `$${i + 1}`).join(',');
    await asTenant(`DELETE FROM efris_taxpayers WHERE code IN (${ph})`, taxpayerCodes);
  }
  // Registration failures are captured outside the transaction, so they carry no
  // transaction id. Remove anything this file produced in that narrow window.
  await asTenant(
    `DELETE FROM efris_integration_errors
      WHERE tenant_id = $1 AND company_id = $2 AND efris_transaction_id IS NULL AND created_at >= $3`,
    [TENANT_ID, COMPANY_ID, startedAt]
  );

  for (const invoiceId of invoiceIds) {
    await asTenant(
      `DELETE FROM journal_lines
        WHERE entry_id IN (
          SELECT id FROM journal_entries
           WHERE tenant_id = $1 AND reference_type = 'customer_invoices' AND reference_id = $2)`,
      [TENANT_ID, invoiceId]
    );
    await asTenant(
      `DELETE FROM journal_entries
        WHERE tenant_id = $1 AND reference_type = 'customer_invoices' AND reference_id = $2`,
      [TENANT_ID, invoiceId]
    );
    await asTenant('DELETE FROM customer_invoices WHERE id = $1 AND tenant_id = $2', [invoiceId, TENANT_ID]);
  }

  await pool.end();
});

describe('URA EFRIS fiscalization', () => {
  it('registers an unconfigured company as PENDING/DISABLED and stays idempotent', async () => {
    const { token } = await loginAs('admin');
    const key = `MANUAL:SALES_INVOICE:${tag()}`;
    const payload = {
      docType: 'SALES_INVOICE',
      docRefType: 'customer_invoices',
      docRefId: 999999,
      docRefCode: `TS-${key}`,
      grossAmount: 118000,
      taxAmount: 18000,
      idempotencyKey: key,
    };

    const first = await api.post('/api/ops/finance/efris').set(auth(token)).send(payload);
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('PENDING');
    expect(first.body.data.fiscalMode).toBe('DISABLED');
    expect(first.body.data.taxpayerId ?? null).toBeNull();
    expect(first.body.data.fiscalizedAt ?? null).toBeNull();
    const txnId = Number(first.body.data.id);
    txnIds.push(txnId);

    // Same ERP document submitted twice must resolve to the same fiscal row.
    const again = await api.post('/api/ops/finance/efris').set(auth(token)).send(payload);
    expect(again.status).toBe(200);
    expect(Number(again.body.data.id)).toBe(txnId);

    const rows = await asTenant(
      'SELECT count(*)::int AS n FROM efris_transactions WHERE tenant_id = $1 AND idempotency_key = $2',
      [TENANT_ID, key]
    );
    expect(rows.rows[0].n).toBe(1);

    const docs = await asTenant(
      'SELECT count(*)::int AS n FROM efris_documents WHERE efris_transaction_id = $1',
      [txnId]
    );
    expect(docs.rows[0].n).toBe(0);
  });

  it('refuses unauthenticated fiscal submission', async () => {
    const res = await api.post('/api/ops/finance/efris').send({
      docType: 'SALES_INVOICE',
      docRefType: 'customer_invoices',
      docRefId: 999998,
      docRefCode: 'TS-UNAUTH',
      grossAmount: 1000,
      idempotencyKey: `UNAUTH:${tag()}`,
    });
    expect(res.status).toBe(401);
  });

  it('auto-registers an approved invoice for fiscalisation and rejects raw secrets', async () => {
    const { token } = await loginAs('admin');
    const target = await createTestTarget(token, { fiscalizeSalesOnPost: true });

    // A payload carrying a raw URA secret must never be accepted.
    const leaked = await api
      .post('/api/ops/finance/efris/configurations')
      .set(auth(token))
      .send({ code: `BAD${tag()}`, name: 'Should be rejected', mode: 'DISABLED', clientSecret: 'top-secret' });
    expect(leaked.status).toBeGreaterThanOrEqual(400);

    const invoiceNo = `TEST-EFRIS-${tag()}`;
    const inv = await asTenant(
      `INSERT INTO customer_invoices
         (company_id, tenant_id, invoice_no, customer_id, invoice_date, currency, status,
          subtotal, discount_amount, tax_amount, total, amount_paid)
       VALUES ($1,$2,$3,1,CURRENT_DATE,'UGX','APPROVED',100000,0,18000,118000,0)
       RETURNING id`,
      [COMPANY_ID, TENANT_ID, invoiceNo]
    );
    const invoiceId = Number(inv.rows[0].id);
    invoiceIds.push(invoiceId);

    const posted = await api.post(`/api/ops/finance/invoices/${invoiceId}/post`).set(auth(token)).send({});
    expect(posted.status).toBe(200);

    const expectedKey = `AUTO:SALES_INVOICE:${invoiceId}`;
    const rows = await asTenant(
      `SELECT id, status, fiscal_mode, gross_amount, tax_amount, taxpayer_id, fiscalized_at
         FROM efris_transactions WHERE tenant_id = $1 AND idempotency_key = $2`,
      [TENANT_ID, expectedKey]
    );
    expect(rows.rows.length).toBe(1);
    const row = rows.rows[0];
    txnIds.push(Number(row.id));
    expect(row.status).toBe('PENDING');
    expect(row.fiscal_mode).toBe('TEST');
    expect(Number(row.gross_amount)).toBe(118000);
    expect(Number(row.tax_amount)).toBe(18000);
    expect(Number(row.taxpayer_id)).toBe(target.taxpayerId);
    expect(row.fiscalized_at).toBeNull();

    // Re-posting a posted invoice must not create a second fiscal transaction.
    await api.post(`/api/ops/finance/invoices/${invoiceId}/post`).set(auth(token)).send({});
    const after = await asTenant(
      'SELECT count(*)::int AS n FROM efris_transactions WHERE tenant_id = $1 AND idempotency_key = $2',
      [TENANT_ID, expectedKey]
    );
    expect(after.rows[0].n).toBe(1);

    await parkConfig(target.configId);
  });

  it('records a failed URA submission instead of fabricating a fiscal document', async () => {
    const { token } = await loginAs('admin');
    // Valid-looking endpoints with no server-side credentials: the client fails
    // in the auth stage before any network I/O is attempted.
    const target = await createTestTarget(token, {
      baseUrl: 'http://127.0.0.1:9/efris/submit',
      tokenUrl: 'http://127.0.0.1:9/oauth/token',
    });

    const key = `MANUAL:RETRY:${tag()}`;
    const ins = await asTenant(
      `INSERT INTO efris_transactions
         (company_id, tenant_id, taxpayer_id, fiscal_mode, doc_type, doc_ref_type, doc_ref_id,
          doc_ref_code, txn_date, currency, gross_amount, tax_amount, idempotency_key, status)
       VALUES ($1,$2,$3,'TEST','SALES_INVOICE','customer_invoices',999997,$4,CURRENT_DATE,'UGX',118000,18000,$5,'QUEUED')
       RETURNING id`,
      [COMPANY_ID, TENANT_ID, target.taxpayerId, `TS-${key}`, key]
    );
    const txnId = Number(ins.rows[0].id);
    txnIds.push(txnId);

    const result = await drainEfrisQueue(10);
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const row = await asTenant(
      'SELECT status, error_code, fiscalized_at FROM efris_transactions WHERE id = $1',
      [txnId]
    );
    expect(row.rows[0].status).toBe('FAILED');
    expect(row.rows[0].error_code).toBe('EFRIS_CREDENTIALS_MISSING');
    expect(row.rows[0].fiscalized_at).toBeNull();

    const errs = await asTenant(
      'SELECT stage, error_code, resolved FROM efris_integration_errors WHERE efris_transaction_id = $1',
      [txnId]
    );
    expect(errs.rows.length).toBe(1);
    expect(errs.rows[0].stage).toBe('auth');
    expect(errs.rows[0].error_code).toBe('EFRIS_CREDENTIALS_MISSING');
    expect(errs.rows[0].resolved).toBe(false);

    const logs = await asTenant(
      'SELECT status FROM efris_sync_logs WHERE efris_transaction_id = $1',
      [txnId]
    );
    expect(logs.rows.length).toBe(1);
    expect(logs.rows[0].status).toBe('FAILED');

    const docs = await asTenant(
      'SELECT count(*)::int AS n FROM efris_documents WHERE efris_transaction_id = $1',
      [txnId]
    );
    expect(docs.rows[0].n).toBe(0);

    await parkConfig(target.configId);
  });

  it('exposes status, reconciliation and secret-free configuration reads', async () => {
    const { token } = await loginAs('admin');

    const status = await api.get('/api/ops/finance/efris/status').set(auth(token));
    expect(status.status).toBe(200);

    const recon = await api.get('/api/ops/finance/efris/reconciliation').set(auth(token));
    expect(recon.status).toBe(200);

    const configs = await api.get('/api/ops/finance/efris/configurations').set(auth(token));
    expect(configs.status).toBe(200);
    expect(JSON.stringify(configs.body)).not.toMatch(/clientSecret|client_secret|password/i);
    for (const cfg of configs.body.data) {
      expect(cfg).not.toHaveProperty('clientIdRef');
      expect(cfg).not.toHaveProperty('credentialsRef');
    }
  });
  it('refuses a mode change with a 400 when the referenced env keys are absent on the server', async () => {
    const { token } = await loginAs('admin');
    // A configuration may sit DISABLED while its pointer keys are absent from the
    // server; only leaving DISABLED is refused. That refusal must be a clean 4xx
    // naming the missing key. It used to be a plain Error, which carries no status,
    // so the API answered 500 "Internal server error" and the operator never learned
    // which environment key to set.
    const absent = `EFRIS_ENV_PROBE_ABSENT_${tag()}`;
    const cCode = `TE${tag()}`;
    const created = await api.post('/api/ops/finance/efris/configurations').set(auth(token)).send({
      code: cCode,
      name: 'URA EFRIS env probe',
      mode: 'DISABLED',
      clientIdRef: absent,
      credentialsRef: absent,
    });
    expect(created.status).toBe(200);
    configCodes.push(cCode);
    const configId = Number(created.body.data.id);
    configIds.push(configId);

    const refused = await api
      .patch(`/api/ops/finance/efris/configurations/${configId}`)
      .set(auth(token))
      .send({ mode: 'TEST' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('EFRIS_CLIENT_ID_MISSING');
    expect(String(refused.body.error.message)).toContain(absent);

    // The same guard covers creation, and it must not write the refused row.
    const refusedCreate = await api.post('/api/ops/finance/efris/configurations').set(auth(token)).send({
      code: `TX${tag()}`,
      name: 'Refused EFRIS config',
      mode: 'ACTIVE',
      clientIdRef: absent,
      credentialsRef: absent,
    });
    expect(refusedCreate.status).toBe(400);
    expect(refusedCreate.body.error.code).toBe('EFRIS_CLIENT_ID_MISSING');

    const after = await asTenant('SELECT mode, is_active FROM efris_configurations WHERE id = $1', [configId]);
    expect(after.rows[0].mode).toBe('DISABLED');

    await parkConfig(configId);
  });

  it('fiscalizes a TEST document against the URA sandbox protocol and refuses the live host', async () => {
    const { token } = await loginAs('admin');
    const creds = deviceCredentials();
    const mock = await startUraMock('FDN-TEST-001');
    try {
      const refusedHost = await api.post('/api/ops/finance/efris/configurations').set(auth(token)).send({
        code: `TH${tag()}`,
        name: 'TEST pointed at production',
        mode: 'TEST',
        baseUrl: 'https://efrisws.ura.go.ug/ws/taapp/getInformation',
        credentialsRef: creds.keyRef,
        securityFlags: { deviceNo: 'TCS000000001' },
      });
      expect(refusedHost.status).toBe(400);
      expect(refusedHost.body.error.code).toBe('EFRIS_MODE_HOST_MISMATCH');

      const target = await createTestTarget(token, {
        baseUrl: mock.url,
        credentialsRef: creds.keyRef,
        clientIdRef: creds.deviceRef,
        securityFlags: { deviceNo: 'TCS000000001' },
      });
      const txnId = await queueTxn(target.taxpayerId, 'TEST');
      expect(await drainOwn(txnId)).toBe('FISCALIZED');

      const row = await asTenant(
        'SELECT status, error_code, fiscalized_at FROM efris_transactions WHERE id = $1',
        [txnId]
      );
      expect(row.rows[0].status).toBe('FISCALIZED');
      expect(row.rows[0].fiscalized_at).toBeTruthy();
      const docs = await asTenant(
        'SELECT fdn, verification_code, qr_ref FROM efris_documents WHERE efris_transaction_id = $1',
        [txnId]
      );
      expect(docs.rows).toHaveLength(1);
      expect(docs.rows[0].fdn).toBe('FDN-TEST-001');
      expect(docs.rows[0].verification_code).toBe('VRC-TEST-001');
      expect(String(docs.rows[0].qr_ref)).toContain('FDN-TEST-001');

      await asTenant(
        `UPDATE efris_configurations SET base_url = $2 WHERE id = $1`,
        [target.configId, 'https://efrisws.ura.go.ug/ws/taapp/getInformation']
      );
      const blockedId = await queueTxn(target.taxpayerId, 'TEST');
      expect(await drainOwn(blockedId)).toBe('FAILED');
      const blocked = await asTenant(
        'SELECT status, error_code FROM efris_transactions WHERE id = $1',
        [blockedId]
      );
      expect(blocked.rows[0].status).toBe('FAILED');
      expect(blocked.rows[0].error_code).toBe('EFRIS_MODE_HOST_MISMATCH');
      const blockedDocs = await asTenant(
        'SELECT count(*)::int AS n FROM efris_documents WHERE efris_transaction_id = $1',
        [blockedId]
      );
      expect(blockedDocs.rows[0].n).toBe(0);
      await parkConfig(target.configId);
    } finally {
      creds.cleanup();
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    }
  }, 60_000);

  it('refuses production until a TEST connection is proven, then fiscalizes ACTIVE on an allowed host', async () => {
    const { token } = await loginAs('admin');
    const creds = deviceCredentials();
    const prior = await asTenant(
      `SELECT id, security_flags
         FROM efris_configurations
        WHERE tenant_id = $1 AND company_id = $2
          AND COALESCE(security_flags->>'sandboxProven', '') = 'true'`,
      [TENANT_ID, COMPANY_ID]
    );
    if (prior.rows.length) {
      await asTenant(
        `UPDATE efris_configurations
            SET security_flags = security_flags - 'sandboxProven' - 'sandboxProvenAt'
          WHERE tenant_id = $1 AND company_id = $2`,
        [TENANT_ID, COMPANY_ID]
      );
    }
    const mock = await startUraMock('FDN-LIVE-001');
    try {
      const refused = await api.post('/api/ops/finance/efris/configurations').set(auth(token)).send({
        code: `TA${tag()}`,
        name: 'Production before proof',
        mode: 'ACTIVE',
        clientIdRef: creds.deviceRef,
        credentialsRef: creds.keyRef,
        securityFlags: { deviceNo: 'TCS000000001' },
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('EFRIS_SANDBOX_NOT_PROVEN');

      const sandbox = await createTestTarget(token, {
        baseUrl: mock.url,
        credentialsRef: creds.keyRef,
        clientIdRef: creds.deviceRef,
        securityFlags: { deviceNo: 'TCS000000001' },
      });
      const probe = await api
        .post(`/api/ops/finance/efris/configurations/${sandbox.configId}/probe`)
        .set(auth(token))
        .send({});
      expect(probe.status).toBe(200);
      expect(probe.body.data.probe.interfaceCode).toBe('T101');
      expect(probe.body.data.configuration.sandboxProven).toBe(true);
      expect(JSON.stringify(probe.body)).not.toMatch(/clientSecret|client_secret|password|PRIVATE KEY/i);
      expect(probe.body.data.configuration).not.toHaveProperty('clientIdRef');
      expect(probe.body.data.configuration).not.toHaveProperty('credentialsRef');

      const listed = await api.get('/api/ops/finance/efris/configurations').set(auth(token));
      const listedRow = (listed.body.data as Array<Record<string, unknown>>).find((row) => String(row.id) === String(sandbox.configId));
      expect(listedRow?.sandboxProven).toBe(true);
      expect(JSON.stringify(listed.body)).not.toMatch(/clientSecret|client_secret|password/i);

      const live = await createTestTarget(token, {
        mode: 'ACTIVE',
        name: 'URA EFRIS production',
        baseUrl: mock.url,
        credentialsRef: creds.keyRef,
        clientIdRef: creds.deviceRef,
        securityFlags: { deviceNo: 'TCS000000001', extraProductionHosts: ['127.0.0.1'] },
      });
      await parkConfig(sandbox.configId);
      const txnId = await queueTxn(live.taxpayerId, 'ACTIVE');
      expect(await drainOwn(txnId)).toBe('FISCALIZED');
      const doc = await asTenant(
        'SELECT fdn, verification_code FROM efris_documents WHERE efris_transaction_id = $1',
        [txnId]
      );
      expect(doc.rows[0].fdn).toBe('FDN-LIVE-001');
      expect(doc.rows[0].verification_code).toBe('VRC-TEST-001');
      const mode = await asTenant('SELECT mode FROM efris_configurations WHERE id = $1', [live.configId]);
      expect(mode.rows[0].mode).toBe('ACTIVE');
      await parkConfig(live.configId);
    } finally {
      for (const row of prior.rows) {
        await asTenant(
          'UPDATE efris_configurations SET security_flags = $2::jsonb WHERE id = $1',
          [row.id, JSON.stringify(row.security_flags)]
        );
      }
      creds.cleanup();
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    }
  }, 60_000);
});
