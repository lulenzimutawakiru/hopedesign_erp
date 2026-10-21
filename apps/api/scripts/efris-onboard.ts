/**
 * URA EFRIS sandbox onboarding.
 *
 * One-shot, idempotent script that connects the ERP to the URA EFRIS sandbox
 * (TEST) by writing the two rows the fiscalization engine needs:
 *
 *   * efris_taxpayers      — the registered legal entity (TIN, legal name).
 *   * efris_configurations — a TEST configuration whose base_url points at the
 *                            URA sandbox gateway
 *                            (https://efristest.ura.go.ug/efrisws/ws/taapp/getInformation).
 *
 * Secrets are never written to the database: the configuration stores only the
 * env-var *names* `EFRIS_DEVICE_NO` / `EFRIS_PRIVATE_KEY` as client_id_ref /
 * credentials_ref, and the worker resolves those values from the server
 * environment at submit time. Those two variables must therefore also be
 * present on the API/worker runtime, not just where this script runs.
 *
 * The device number and private key are URA-issued after the fiscal device
 * (this software) is registered with URA. This script refuses to run without
 * them and never echoes the private key.
 *
 * Usage (run from the repo root):
 *
 *   EFRIS_TIN=1234567890 \
 *   EFRIS_LEGAL_NAME='Hope Design Group Ltd' \
 *   EFRIS_DEVICE_NO=ABCD1234 \
 *   EFRIS_PRIVATE_KEY='<single-line PEM: base64 of the PEM, or PEM with \n escapes>' \
 *   EFRIS_PROBE=true \
 *   npm run efris:onboard -w apps/api
 *
 * Optional overrides: EFRIS_TENANT_ID / EFRIS_COMPANY_ID / EFRIS_BRANCH_ID
 * (default 2, the bootstrap org), EFRIS_TAXPAYER_CODE, EFRIS_CONFIG_CODE,
 * EFRIS_CONFIG_NAME, EFRIS_FISCALIZE_ON_POST, EFRIS_AUTO_SUBMIT (both default
 * false, so nothing auto-submits until the operator is ready).
 */
import 'dotenv/config';
import { tx } from '../src/db.js';
import { EfrisClientError, probeEfrisGateway } from '../src/services/efris/client.js';
import { URA_TEST_ENDPOINT } from '../src/services/efris/protocol.js';

const DEVICE_NO_RE = /^[A-Za-z0-9_-]{4,40}$/;

// The Aisino Tax Control Service (the "offline enabler") sits on the local
// machine and owns the T102/T104 handshake, encryption and signing. When the
// device is registered as an offline enabler (Hope Design's is), the ERP posts
// the plaintext envelope to the TCS instead of talking to URA directly.
const OFFLINE_ENABLER_ENDPOINT = 'http://127.0.0.1:9880/efristcs/ws/tcsapp/getInformation';

const env = (key: string): string => (process.env[key] ?? '').trim();
const boolEnv = (key: string): boolean => (env(key) || 'false').toLowerCase() === 'true';

function fail(message: string): never {
  throw new Error(message);
}

function intOr(key: string, fallback: number): number {
  const raw = env(key);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`${key} must be a positive integer`);
  return Math.trunc(n);
}

function intOrNull(key: string): number | null {
  const raw = env(key);
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`${key} must be a positive integer`);
  return Math.trunc(n);
}

function assertPrivateKey(value: string): void {
  if (value.includes('PRIVATE KEY')) return;
  // A single-line base64 of the PEM is also accepted (normalizePrivateKey in
  // protocol.ts applies the same unwrap at submit time).
  const decoded = Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (!decoded.includes('PRIVATE KEY')) {
    fail('EFRIS_PRIVATE_KEY must be a PEM private key (single line: base64 of the PEM, or the PEM with \\n escapes)');
  }
}

async function main(): Promise<void> {
  const tenantId = intOr('EFRIS_TENANT_ID', 2);
  const companyId = intOr('EFRIS_COMPANY_ID', 2);
  const branchId = intOrNull('EFRIS_BRANCH_ID');

  const tin = env('EFRIS_TIN');
  const legalName = env('EFRIS_LEGAL_NAME');
  const deviceNo = env('EFRIS_DEVICE_NO');
  const privateKey = env('EFRIS_PRIVATE_KEY');

  // Transport: direct system-to-system (default) or the Aisino offline enabler.
  const protocol = (env('EFRIS_PROTOCOL') || 's2s').toLowerCase();
  const offlineEnabler = protocol === 'offline_enabler' || protocol === 'enabler';
  const baseUrl = offlineEnabler
    ? (env('EFRIS_BASE_URL') || OFFLINE_ENABLER_ENDPOINT)
    : URA_TEST_ENDPOINT;
  const securityFlags = offlineEnabler
    ? JSON.stringify({ protocol: 'offline_enabler' })
    : '{}';

  if (!tin) fail('EFRIS_TIN is required (the URA-issued taxpayer TIN)');
  if (!legalName) fail('EFRIS_LEGAL_NAME is required (the registered legal name)');
  if (!deviceNo) fail('EFRIS_DEVICE_NO is required (the URA-issued fiscal device / TCU number)');
  if (!DEVICE_NO_RE.test(deviceNo)) fail('EFRIS_DEVICE_NO must be 4-40 characters of [A-Za-z0-9_-]');
  // The offline enabler (Aisino TCS) owns the private key and the T102/T104
  // handshake, so the ERP never needs the device key in that transport.
  if (!offlineEnabler) {
    if (!privateKey) fail('EFRIS_PRIVATE_KEY is required (the URA-issued device private key, PEM)');
    assertPrivateKey(privateKey);
  }

  const taxpayerCode = env('EFRIS_TAXPAYER_CODE') || `TP-${tin}`;
  const configCode = env('EFRIS_CONFIG_CODE') || 'TEST-SANDBOX';
  const configName = env('EFRIS_CONFIG_NAME') || 'URA EFRIS Sandbox (TEST)';
  const fiscalizeOnPost = boolEnv('EFRIS_FISCALIZE_ON_POST');
  const autoSubmit = boolEnv('EFRIS_AUTO_SUBMIT');
  const runProbe = boolEnv('EFRIS_PROBE');
  const force = boolEnv('EFRIS_FORCE');

  const ctx = { tenantId, companyId, branchId };

  // 1. Taxpayer — idempotent on (company_id, tin). Never downgrades an existing
  //    TEST/ACTIVE environment.
  const taxpayerId = await tx(async (client) => {
    const existing = await client.query(
      `SELECT id, environment, efris_status FROM efris_taxpayers
        WHERE tenant_id = $1 AND company_id = $2 AND tin = $3`,
      [tenantId, companyId, tin]
    );
    if (existing.rows.length) {
      const row = existing.rows[0] as { id: number; environment: string; efris_status: string };
      await client.query(
        `UPDATE efris_taxpayers
            SET environment = CASE WHEN environment IN ('TEST','ACTIVE') THEN environment ELSE 'TEST' END,
                efris_status = CASE WHEN efris_status IN ('ACTIVE','TESTING','REGISTERED') THEN efris_status ELSE 'TESTING' END,
                legal_name = $4,
                updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
        [row.id, tenantId, companyId, legalName]
      );
      console.log(`[efris-onboard] taxpayer ${row.id} already exists (${tin}); environment is now ${row.environment === 'TEST' || row.environment === 'ACTIVE' ? row.environment : 'TEST'}`);
      return row.id;
    }

    const ins = await client.query(
      `INSERT INTO efris_taxpayers
         (company_id, tenant_id, branch_id, code, legal_name, trading_name, tin,
          vat_registered, vat_number, taxpayer_type, place_of_business, address,
          contact_email, contact_phone, efris_status, environment, credentials_ref, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'COMPANY',$10,$11,$12,$13,'TESTING','TEST','EFRIS_PRIVATE_KEY',true)
       ON CONFLICT (company_id, tin) DO NOTHING
       RETURNING id`,
      [
        companyId, tenantId, branchId, taxpayerCode, legalName,
        env('EFRIS_TRADING_NAME') || null, tin,
        boolEnv('EFRIS_VAT_REGISTERED'), env('EFRIS_VAT_NUMBER') || null,
        env('EFRIS_PLACE_OF_BUSINESS') || null, env('EFRIS_ADDRESS') || null,
        env('EFRIS_CONTACT_EMAIL') || null, env('EFRIS_CONTACT_PHONE') || null,
      ]
    );
    if (ins.rows.length) {
      console.log(`[efris-onboard] taxpayer created (${tin}) id=${Number(ins.rows[0].id)}`);
      return Number(ins.rows[0].id);
    }
    const again = await client.query(
      `SELECT id FROM efris_taxpayers WHERE tenant_id = $1 AND company_id = $2 AND tin = $3`,
      [tenantId, companyId, tin]
    );
    if (!again.rows.length) fail('taxpayer insert did not produce a row');
    console.log(`[efris-onboard] taxpayer already exists (${tin}) id=${Number(again.rows[0].id)}`);
    return Number(again.rows[0].id);
  }, ctx);

  // 2. Configuration — idempotent on (company_id, code). Refuses to downgrade an
  //    existing ACTIVE configuration unless EFRIS_FORCE=true.
  const configId = await tx(async (client) => {
    const existing = await client.query(
      `SELECT id, mode FROM efris_configurations
        WHERE tenant_id = $1 AND company_id = $2 AND code = $3`,
      [tenantId, companyId, configCode]
    );
    if (existing.rows.length) {
      const row = existing.rows[0] as { id: number; mode: string };
      if (row.mode === 'ACTIVE' && !force) {
        fail(`configuration ${row.id} is ACTIVE; refusing to change it. Use a different EFRIS_CONFIG_CODE or set EFRIS_FORCE=true.`);
      }
      await client.query(
        `UPDATE efris_configurations
            SET mode = 'TEST',
                base_url = $4,
                taxpayer_id = $5,
                client_id_ref = 'EFRIS_DEVICE_NO',
                credentials_ref = 'EFRIS_PRIVATE_KEY',
                security_flags = COALESCE(security_flags, '{}'::jsonb) || $8::jsonb,
                is_active = true,
                fiscalize_sales_on_post = $6,
                auto_submit = $7,
                updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
        [row.id, tenantId, companyId, baseUrl, taxpayerId, fiscalizeOnPost, autoSubmit, securityFlags]
      );
      console.log(`[efris-onboard] configuration ${row.id} updated (mode TEST${offlineEnabler ? ', offline enabler' : ''})`);
      return row.id;
    }

    const ins = await client.query(
      `INSERT INTO efris_configurations
         (company_id, tenant_id, taxpayer_id, code, name, mode, base_url,
          auth_grant_type, client_id_ref, credentials_ref, security_flags,
          fiscalize_sales_on_post, auto_submit, is_active)
       VALUES ($1,$2,$3,$4,$5,'TEST',$6,'client_credentials','EFRIS_DEVICE_NO',
               'EFRIS_PRIVATE_KEY',$7::jsonb,$8,$9,true)
       ON CONFLICT (company_id, code) DO NOTHING
       RETURNING id`,
      [companyId, tenantId, taxpayerId, configCode, configName, baseUrl, securityFlags, fiscalizeOnPost, autoSubmit]
    );
    if (ins.rows.length) {
      console.log(`[efris-onboard] configuration created (mode TEST${offlineEnabler ? ', offline enabler' : ''}) id=${Number(ins.rows[0].id)}`);
      return Number(ins.rows[0].id);
    }
    const again = await client.query(
      `SELECT id FROM efris_configurations WHERE tenant_id = $1 AND company_id = $2 AND code = $3`,
      [tenantId, companyId, configCode]
    );
    if (!again.rows.length) fail('configuration insert did not produce a row');
    console.log(`[efris-onboard] configuration already exists id=${Number(again.rows[0].id)}`);
    return Number(again.rows[0].id);
  }, ctx);

  console.log(
    `[efris-onboard] ready: taxpayer=${taxpayerId} config=${configId} mode=TEST ${offlineEnabler ? `transport=offline-enabler endpoint=${baseUrl}` : 'host=efristest.ura.go.ug'}`
  );

  // 3. Optional: prove the sandbox with a T101 probe. Never fiscalizes a document;
  //    a successful TEST proof is what later unlocks ACTIVE. The offline enabler
  //    has no direct T101 handshake — the TCS owns T102/T104 — so there is
  //    nothing to probe here.
  if (offlineEnabler) {
    console.log('[efris-onboard] offline-enabler transport: the TCS owns the T102/T104 handshake; no direct T101 probe');
    return;
  }
  if (!runProbe) {
    console.log('[efris-onboard] skipping probe (set EFRIS_PROBE=true to run the T101 proof)');
    return;
  }

  console.log('[efris-onboard] probing the URA sandbox (T101)…');
  let probe;
  try {
    probe = await probeEfrisGateway({
      mode: 'TEST',
      baseUrl: URA_TEST_ENDPOINT,
      tokenUrl: null,
      grantType: 'client_credentials',
      clientId: deviceNo,
      clientSecret: privateKey,
      timeoutSeconds: 20,
      payload: {},
      tin,
      securityFlags: {},
    });
  } catch (err) {
    if (err instanceof EfrisClientError) {
      fail(`probe failed [${err.code}] ${err.message}`);
    }
    fail(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await tx(async (client) => {
    const patch = {
      sandboxProven: true,
      sandboxProvenAt: new Date().toISOString(),
      lastProbeAt: new Date().toISOString(),
      lastProbeOk: true,
      lastProbeMode: 'TEST',
      lastProbeMessage: probe.message,
      lastProbeInterface: probe.interfaceCode,
    };
    await client.query(
      `UPDATE efris_configurations
          SET security_flags = COALESCE(security_flags, '{}'::jsonb) || $4::jsonb,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
      [configId, tenantId, companyId, JSON.stringify(patch)]
    );
  }, ctx);

  console.log(`[efris-onboard] sandbox proven (${probe.interfaceCode}): ${probe.message}`);
}

main().catch((err) => {
  console.error(`[efris-onboard] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
