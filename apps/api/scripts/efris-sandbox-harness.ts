/**
 * URA EFRIS sandbox verification harness (GAP-7).
 *
 * A tagged, standalone script that proves the *read-only* sandbox calls the
 * integration relies on — T101 (server time / device+key validity) and T119
 * (customer taxpayer lookup). Neither call fiscalizes a document, so a passing
 * run is a legitimate engineering signal without ever issuing an invoice.
 *
 * The fiscalising round-trips (T109 invoice, T110→T111→T108 credit note, T131
 * stock-in) are intentionally **not** hand-rolled here: they must be built by
 * the ERP's own payload builders from real sales/credit/stock records, so they
 * are exercised through the ERP API + worker (see docs/ura/EFRIS_UAT_TEST_PLAN.md
 * and scripts/efris-onboard.ts for the TEST configuration they depend on).
 * Hand-assembling a fiscal payload here would risk inventing a field URA has not
 * documented.
 *
 * NEVER RUN THIS AGAINST PRODUCTION. It points only at the sandbox host; the
 * transport layer (`assertUrlMatchesMode`) refuses a live host for mode TEST.
 *
 * Usage (run from the repo root):
 *
 *   EFRIS_TIN=1234567890 \
 *   EFRIS_DEVICE_NO=ABCD1234 \
 *   EFRIS_PRIVATE_KEY='<PEM>' \
 *   EFRIS_LOOKUP_TIN=1234567894 \
 *   npm run efris:sandbox-harness -w apps/api
 */
import 'dotenv/config';
import { EfrisClientError, probeEfrisGateway, queryTaxpayerByTin } from '../src/services/efris/client.js';
import { URA_TEST_ENDPOINT } from '../src/services/efris/protocol.js';

const env = (key: string): string => (process.env[key] ?? '').trim();

function fail(message: string): never {
  throw new Error(message);
}

function redactedKey(value: string): string {
  if (!value) return '<missing>';
  if (value.includes('PRIVATE KEY')) return '<private key present, not shown>';
  return '<private key present (base64), not shown>';
}

async function main(): Promise<void> {
  const tin = env('EFRIS_TIN');
  const deviceNo = env('EFRIS_DEVICE_NO');
  const privateKey = env('EFRIS_PRIVATE_KEY');
  const baseUrl = env('EFRIS_BASE_URL') || URA_TEST_ENDPOINT;

  if (!tin) fail('EFRIS_TIN is required');
  if (!deviceNo) fail('EFRIS_DEVICE_NO is required');
  if (!privateKey) fail('EFRIS_PRIVATE_KEY is required');

  const host = new URL(baseUrl).hostname.toLowerCase();
  if (!host.includes('efristest.ura.go.ug') && !host.includes('127.0.0.1') && !host.includes('localhost')) {
    fail(`refusing to run: ${host} is not the URA sandbox host (efristest.ura.go.ug)`);
  }

  const opts = {
    mode: 'TEST' as const,
    baseUrl,
    tokenUrl: null,
    grantType: 'client_credentials',
    clientId: deviceNo,
    clientSecret: privateKey,
    timeoutSeconds: 20,
    payload: {},
    tin,
    securityFlags: {},
  };

  console.log('[efris-sandbox] TIN:', tin);
  console.log('[efris-sandbox] deviceNo:', deviceNo);
  console.log('[efris-sandbox] privateKey:', redactedKey(privateKey));
  console.log('[efris-sandbox] sandbox host:', host);

  // 1. T101 server-time probe — proves the gateway, device number and key.
  console.log('\n[efris-sandbox] T101 server-time probe…');
  try {
    const probe = await probeEfrisGateway(opts);
    console.log(`[efris-sandbox] T101 OK  interface=${probe.interfaceCode} returnCode=${probe.returnCode} serverTime=${probe.serverTime ?? '(none)'} message="${probe.message}"`);
  } catch (err) {
    if (err instanceof EfrisClientError) fail(`T101 failed [${err.code}] ${err.message}`);
    fail(`T101 failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. T119 taxpayer lookup — proves the customer TIN query, no fiscalisation.
  const lookupTin = env('EFRIS_LOOKUP_TIN');
  if (lookupTin) {
    console.log(`\n[efris-sandbox] T119 taxpayer lookup (${lookupTin})…`);
    try {
      const lookup = await queryTaxpayerByTin({ ...opts, lookupTin });
      if (lookup.found && lookup.taxpayer) {
        console.log(`[efris-sandbox] T119 OK  legalName=${lookup.taxpayer.legalName ?? '(none)'} businessName=${lookup.taxpayer.businessName ?? '(none)'}`);
      } else {
        console.log('[efris-sandbox] T119 no matching taxpayer returned (found=false)');
      }
    } catch (err) {
      if (err instanceof EfrisClientError) fail(`T119 failed [${err.code}] ${err.message}`);
      fail(`T119 failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log('\n[efris-sandbox] skipping T119 (set EFRIS_LOOKUP_TIN to a customer TIN)');
  }

  console.log('\n[efris-sandbox] read-only sandbox checks passed.');
  console.log('[efris-sandbox] Fiscalising steps (T109/T110/T131) run through the ERP API + worker — see docs/ura/EFRIS_UAT_TEST_PLAN.md.');
}

main().catch((err) => {
  console.error(`[efris-sandbox] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
