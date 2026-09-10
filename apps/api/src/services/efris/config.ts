import pg from 'pg';
import { Ctx } from '../../db.js';

/**
 * EFRIS configuration & credential resolution (URA EFRIS, spec 74-78).
 *
 * Secrets never live in the ERP database. efris_configurations / efris_taxpayers
 * only carry `client_id_ref` / `credentials_ref` pointers; the actual values are
 * resolved from process.env at submit time by the background worker. The browser
 * and the audit trail therefore never see an integration secret.
 */
export type EfrisMode = 'DISABLED' | 'TEST' | 'ACTIVE';

export const EFRIS_MODES: readonly EfrisMode[] = ['DISABLED', 'TEST', 'ACTIVE'];

export function isEfrisMode(v: unknown): v is EfrisMode {
  return typeof v === 'string' && (EFRIS_MODES as readonly string[]).includes(v);
}

export interface EfrisConfigurationRow {
  id: number;
  company_id: number;
  tenant_id: number;
  taxpayer_id: number | null;
  code: string;
  name: string;
  mode: EfrisMode;
  base_url: string | null;
  token_url: string | null;
  auth_grant_type: string;
  client_id_ref: string | null;
  credentials_ref: string | null;
  timeout_seconds: number;
  max_attempts: number;
  retry_backoff_seconds: number;
  poll_interval_seconds: number;
  fiscalize_sales_on_post: boolean;
  auto_submit: boolean;
  notify_on_failure: boolean;
  notify_role_codes: unknown;
  duplicate_window_seconds: number;
  payload_mapping: Record<string, unknown>;
  security_flags: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EfrisTaxpayerRow {
  id: number;
  company_id: number;
  tenant_id: number;
  branch_id: number | null;
  code: string;
  legal_name: string;
  trading_name: string | null;
  tin: string;
  vat_registered: boolean;
  vat_number: string | null;
  taxpayer_type: string;
  business_sector: string | null;
  place_of_business: string | null;
  address: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  efris_status: string;
  environment: EfrisMode;
  credentials_ref: string | null;
  is_default: boolean;
  effective_from: string | null;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface FiscalTarget {
  config: EfrisConfigurationRow;
  taxpayer: EfrisTaxpayerRow | null;
}

/**
 * Resolve the active TEST/ACTIVE integration configuration for a company inside
 * the current transaction/tenant context. Returns null when the company is not
 * (yet) enabled for EFRIS submission.
 */
export async function resolveFiscalTarget(
  client: pg.PoolClient,
  ctx: Pick<Ctx, 'tenantId' | 'companyId'>
): Promise<FiscalTarget | null> {
  const res = await client.query(
    `SELECT * FROM efris_configurations
      WHERE company_id = $1 AND tenant_id = $2 AND is_active = true AND mode IN ('TEST','ACTIVE')
      ORDER BY id DESC LIMIT 1`,
    [ctx.companyId, ctx.tenantId]
  );
  const config = res.rows[0] as EfrisConfigurationRow | undefined;
  if (!config) return null;
  let taxpayer: EfrisTaxpayerRow | null = null;
  if (config.taxpayer_id != null) {
    const tp = await client.query(
      `SELECT * FROM efris_taxpayers WHERE id = $1 AND tenant_id = $2`,
      [config.taxpayer_id, ctx.tenantId]
    );
    taxpayer = (tp.rows[0] as EfrisTaxpayerRow | undefined) ?? null;
  }
  return { config, taxpayer };
}

/** Read a server-side secret by its env-backed reference (never from the DB). */
export function resolveCredentialValue(ref: string | null | undefined): string | undefined {
  if (!ref) return undefined;
  const key = ref.trim();
  if (!key) return undefined;
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export interface ResolvedCredentials {
  clientId?: string;
  clientSecret?: string;
}

/** Resolve the client credentials for a configuration from the environment. */
export function resolveCredentials(
  config: Pick<EfrisConfigurationRow, 'client_id_ref' | 'credentials_ref'>
): ResolvedCredentials {
  const clientId = resolveCredentialValue(config.client_id_ref);
  const clientSecret = resolveCredentialValue(config.credentials_ref);
  return { clientId, clientSecret };
}

/** Parse the notify_role_codes JSONB column into a string array. */
export function notificationRoleCodes(config: EfrisConfigurationRow): string[] {
  const raw = config.notify_role_codes;
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (raw && typeof raw === 'object') {
    const arr = (raw as Record<string, unknown>).roles;
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

/** Reference keys must point at non-empty environment values before TEST/ACTIVE is allowed. */
export function assertCredentialsResolvable(config: EfrisConfigurationRow): void {
  if (config.client_id_ref && !resolveCredentialValue(config.client_id_ref)) {
    const err = new Error(`EFRIS env secret ${config.client_id_ref} is not set on the server`);
    (err as Error & { code?: string }).code = 'EFRIS_CLIENT_ID_MISSING';
    throw err;
  }
  if (config.credentials_ref && !resolveCredentialValue(config.credentials_ref)) {
    const err = new Error(`EFRIS env secret ${config.credentials_ref} is not set on the server`);
    (err as Error & { code?: string }).code = 'EFRIS_CREDENTIALS_MISSING';
    throw err;
  }
}