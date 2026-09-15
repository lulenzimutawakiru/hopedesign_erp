/**
 * Equity bank integration configuration (per company).
 *
 * Like every other external system, the Equity integration is a row in
 * `company_integrations` (category `payments`, code `EQUITY`), so an operator
 * configures it once per company and the notification receiver can resolve an
 * inbound payment back to a bank account, a branch and a tenant.
 *
 * Non-secret settings live in `config`; credentials live in `secrets` and are
 * encrypted at rest through the shared company-config cipher. Nothing here ever
 * returns a credential: the status projection exposes presence flags plus a
 * short fingerprint of the PUBLIC key, which is all an administrator needs in
 * order to confirm that the right signing key is loaded.
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest } from '../../utils.js';
import { auditConfig, decryptSecret, encryptSecret } from '../companyConfig.js';
import { cleanKey, isUsablePublicKey, publicKeyFingerprint } from './security.js';

export const EQUITY_CODE = 'EQUITY';
export const EQUITY_CATEGORY = 'payments';

export type EquityEnvironment = 'SANDBOX' | 'PRODUCTION';

export interface EquityIntegrationRow {
  id: number;
  tenant_id: number;
  company_id: number;
  name: string;
  status: string;
  is_active: boolean;
  config: Record<string, unknown> | null;
  secrets: Record<string, unknown> | null;
  last_tested_at: string | null;
}

export interface EquityConfig {
  environment: EquityEnvironment;
  country: string;
  currency: string;
  bankAccountId: number | null;
  organizationShortCode: string | null;
  tillNumber: string | null;
  gatewayBaseUrl: string | null;
  /** Equity's public key: verifies the Signature header on inbound notifications. */
  publicKey: string | null;
  /** Ours, for outbound calls only. Never leaves the server. */
  privateKey: string | null;
  consumerKey: string | null;
  consumerSecret: string | null;
}

/** Everything an administrator may see. Never contains secret material. */
export interface EquityConfigView {
  configured: boolean;
  integrationId: number | null;
  name: string | null;
  status: string;
  isActive: boolean;
  environment: EquityEnvironment;
  country: string;
  currency: string;
  bankAccountId: number | null;
  organizationShortCode: string | null;
  tillNumber: string | null;
  gatewayBaseUrl: string | null;
  /** True when a key is stored; `publicKeyFingerprint` says whether it parses. */
  publicKeyPresent: boolean;
  publicKeyFingerprint: string | null;
  envKeyPresent: boolean;
  privateKeyPresent: boolean;
  consumerKeyPresent: boolean;
  consumerSecretPresent: boolean;
  lastTestedAt: string | null;
  /** True only when an inbound notification could actually be verified. */
  readyForNotifications: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const pick = (bag: Record<string, unknown>, key: string): string | null => cleanKey(bag[key]);

/** The single Equity integration row for the acting company, if it exists. */
export async function getEquityIntegration(
  client: pg.PoolClient,
  ctx: Ctx
): Promise<EquityIntegrationRow | null> {
  if (ctx.companyId == null) return null;
  const res = await client.query(
    `SELECT id, tenant_id, company_id, name, status, is_active, config, secrets, last_tested_at
       FROM company_integrations
      WHERE company_id = $1 AND code = $2 AND category = $3
      LIMIT 1`,
    [ctx.companyId, EQUITY_CODE, EQUITY_CATEGORY]
  );
  return res.rows.length > 0 ? (res.rows[0] as EquityIntegrationRow) : null;
}

/**
 * Decode a stored row into its usable form. Credentials are decrypted here and
 * only here; a caller that intends to return anything to a client must use
 * equityConfigView instead.
 */
export function readEquityConfig(row: EquityIntegrationRow | null): EquityConfig {
  const cfg = asRecord(row?.config);
  const sec = asRecord(row?.secrets);
  const environment = (pick(cfg, 'environment') ?? 'SANDBOX').toUpperCase();
  const bankAccountId = Number.parseInt(String(cfg.bank_account_id ?? ''), 10);
  return {
    environment: environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
    country: (pick(cfg, 'country') ?? 'UG').toUpperCase(),
    currency: (pick(cfg, 'currency') ?? 'UGX').toUpperCase(),
    bankAccountId: Number.isInteger(bankAccountId) ? bankAccountId : null,
    organizationShortCode: pick(cfg, 'organization_short_code'),
    tillNumber: pick(cfg, 'till_number'),
    gatewayBaseUrl: pick(cfg, 'gateway_base_url'),
    publicKey: pick(cfg, 'equity_public_key'),
    privateKey: decryptSecret(pick(sec, 'equity_private_key')),
    consumerKey: decryptSecret(pick(sec, 'consumer_key')),
    consumerSecret: decryptSecret(pick(sec, 'consumer_secret')),
  };
}

/**
 * Platform-level verification key. Useful for a single-company deployment or a
 * staging environment; a per-company key in the integration row is checked
 * first so a company can rotate its own key without a redeploy.
 */
export function envVerificationKey(): string | null {
  return cleanKey(process.env.EQUITY_IPN_PUBLIC_KEY);
}

export interface EquityKeyCandidate {
  companyId: number | null;
  tenantId: number | null;
  publicKey: string;
  /** 'ENV' or 'CONFIG:<fingerprint>'. Safe to write into an audit record. */
  source: string;
}

interface ActiveKeyRow {
  company_id: number | string | null;
  tenant_id: number | string | null;
  public_key_pem: string | null;
}

/**
 * Every key that may legitimately sign an inbound notification: the platform
 * environment key plus every active company integration's configured key.
 *
 * The lookup runs through a SECURITY DEFINER helper, which is what makes it
 * work before any tenant context exists - the exact moment a notification
 * arrives and the company it belongs to is still unknown. Only the public half
 * of each key is ever returned.
 */
export async function verificationKeys(client: pg.PoolClient | pg.Pool): Promise<EquityKeyCandidate[]> {
  const out: EquityKeyCandidate[] = [];
  const envKey = envVerificationKey();
  if (envKey && isUsablePublicKey(envKey)) {
    out.push({ companyId: null, tenantId: null, publicKey: envKey, source: 'ENV' });
  }
  const res = await client.query(
    'SELECT company_id, tenant_id, public_key_pem FROM equity_ipn_active_keys()'
  );
  for (const row of res.rows as ActiveKeyRow[]) {
    const pem = cleanKey(row.public_key_pem);
    if (!pem || !isUsablePublicKey(pem)) continue;
    out.push({
      companyId: row.company_id === null ? null : Number(row.company_id),
      tenantId: row.tenant_id === null ? null : Number(row.tenant_id),
      publicKey: pem,
      source: `CONFIG:${publicKeyFingerprint(pem)}`,
    });
  }
  return out;
}

/** Safe projection of the integration for an administrator. */
export function equityConfigView(row: EquityIntegrationRow | null): EquityConfigView {
  const cfg = readEquityConfig(row);
  const fingerprint = publicKeyFingerprint(cfg.publicKey);
  const envKeyPresent = isUsablePublicKey(envVerificationKey());
  return {
    configured: !!row,
    integrationId: row ? Number(row.id) : null,
    name: row?.name ?? null,
    status: row?.status ?? 'DISCONNECTED',
    isActive: row?.is_active ?? false,
    environment: cfg.environment,
    country: cfg.country,
    currency: cfg.currency,
    bankAccountId: cfg.bankAccountId,
    organizationShortCode: cfg.organizationShortCode,
    tillNumber: cfg.tillNumber,
    gatewayBaseUrl: cfg.gatewayBaseUrl,
    publicKeyPresent: !!cleanKey(cfg.publicKey),
    publicKeyFingerprint: fingerprint,
    envKeyPresent,
    privateKeyPresent: !!cfg.privateKey,
    consumerKeyPresent: !!cfg.consumerKey,
    consumerSecretPresent: !!cfg.consumerSecret,
    lastTestedAt: row?.last_tested_at ?? null,
    readyForNotifications: fingerprint !== null || envKeyPresent,
  };
}

export interface EquityConfigPatch {
  environment?: string;
  country?: string | null;
  currency?: string | null;
  bankAccountId?: number | string | null;
  organizationShortCode?: string | null;
  tillNumber?: string | null;
  gatewayBaseUrl?: string | null;
  publicKey?: string | null;
  privateKey?: string | null;
  consumerKey?: string | null;
  consumerSecret?: string | null;
  isActive?: boolean;
}

/**
 * Patch field to the name it is encrypted under in the secrets bag. The stored
 * name is snake_case like every other key in this row, and it has to be the
 * name readEquityConfig looks up: a credential written under one name and read
 * back under another is stored correctly and still reported as absent.
 */
const SECRET_FIELDS: ReadonlyArray<[field: keyof EquityConfigPatch, stored: string]> = [
  ['privateKey', 'equity_private_key'],
  ['consumerKey', 'consumer_key'],
  ['consumerSecret', 'consumer_secret'],
];

/**
 * Apply an administrator's changes to the integration.
 *
 * The settlement account is validated against the acting company, so an
 * integration can never be pointed at another company's ledger. The audit
 * record carries the before/after projection - key fingerprints and presence
 * flags, never key material.
 */
export async function updateEquityConfig(
  client: pg.PoolClient,
  ctx: Ctx,
  patch: EquityConfigPatch
): Promise<EquityConfigView> {
  const tenantId = ctx.tenantId ?? null;
  const companyId = ctx.companyId ?? null;
  if (tenantId === null || companyId === null) {
    throw badRequest('A company context is required to configure Equity');
  }

  const existing = await getEquityIntegration(client, ctx);
  const cfg = { ...asRecord(existing?.config) };
  const sec = { ...asRecord(existing?.secrets) };

  const applyText = (
    bag: Record<string, unknown>,
    key: string,
    value: string | null | undefined
  ) => {
    if (value === undefined) return;
    const clean = cleanKey(value);
    if (clean === null) delete bag[key];
    else bag[key] = clean;
  };

  if (patch.environment !== undefined) {
    const environment = String(patch.environment ?? '').trim().toUpperCase();
    if (environment !== 'SANDBOX' && environment !== 'PRODUCTION') {
      throw badRequest('environment must be SANDBOX or PRODUCTION');
    }
    cfg.environment = environment;
  }
  if (patch.country !== undefined) {
    const country = String(patch.country ?? '').trim().toUpperCase();
    if (country === '') delete cfg.country;
    else if (/^[A-Z]{2}$/.test(country)) cfg.country = country;
    else throw badRequest('country must be an ISO 3166-1 alpha-2 code');
  }
  if (patch.currency !== undefined) {
    const currency = String(patch.currency ?? '').trim().toUpperCase();
    if (currency === '') delete cfg.currency;
    else if (/^[A-Z]{3}$/.test(currency)) cfg.currency = currency;
    else throw badRequest('currency must be an ISO 4217 code');
  }
  applyText(cfg, 'organization_short_code', patch.organizationShortCode);
  applyText(cfg, 'till_number', patch.tillNumber);
  applyText(cfg, 'gateway_base_url', patch.gatewayBaseUrl);
  applyText(cfg, 'equity_public_key', patch.publicKey);

  if (patch.bankAccountId !== undefined) {
    const raw = patch.bankAccountId === null ? '' : String(patch.bankAccountId).trim();
    if (raw === '') {
      delete cfg.bank_account_id;
    } else {
      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('bankAccountId must be a positive integer');
      const owned = await client.query(
        'SELECT 1 FROM bank_accounts WHERE id = $1 AND company_id = $2 AND is_active',
        [id, companyId]
      );
      if (owned.rows.length === 0) {
        throw badRequest('Unknown or inactive bank account for this company');
      }
      cfg.bank_account_id = id;
    }
  }

  for (const [field, secretKey] of SECRET_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    const clean = cleanKey(value);
    if (clean === null) delete sec[secretKey];
    else sec[secretKey] = encryptSecret(clean);
  }

  const isActive = (patch.isActive === undefined ? existing?.is_active ?? true : patch.isActive === true);
  const name = existing?.name ?? 'Equity Bank';
  const status = existing?.status ?? 'DISCONNECTED';

  await client.query(
    `INSERT INTO company_integrations
       (tenant_id, company_id, category, code, name, config, secrets, status, is_active, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)
     ON CONFLICT (tenant_id, company_id, code) DO UPDATE
        SET name = EXCLUDED.name,
            config = EXCLUDED.config,
            secrets = EXCLUDED.secrets,
            is_active = EXCLUDED.is_active,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()`,
    [
      tenantId, companyId, EQUITY_CATEGORY, EQUITY_CODE, name,
      JSON.stringify(cfg), JSON.stringify(sec), status, isActive, ctx.userId ?? null,
    ]
  );

  const saved = await getEquityIntegration(client, ctx);
  await auditConfig(
    client,
    ctx,
    'update',
    'finance.equity.config',
    saved ? Number(saved.id) : null,
    existing ? (equityConfigView(existing) as unknown as Record<string, unknown>) : null,
    saved ? (equityConfigView(saved) as unknown as Record<string, unknown>) : null,
    { code: EQUITY_CODE, category: EQUITY_CATEGORY }
  );
  return equityConfigView(saved);
}

/** Record the outcome of a connection / signing-key self-test. */
export async function markEquityTested(
  client: pg.PoolClient,
  ctx: Ctx,
  status: 'CONNECTED' | 'ERROR' | 'TESTING'
): Promise<void> {
  if (ctx.companyId == null) return;
  await client.query(
    `UPDATE company_integrations
        SET status = $1, last_tested_at = now(), updated_at = now()
      WHERE company_id = $2 AND code = $3 AND category = $4`,
    [status, ctx.companyId, EQUITY_CODE, EQUITY_CATEGORY]
  );
}
