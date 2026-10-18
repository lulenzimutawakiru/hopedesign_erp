/**
 * URA EFRIS customer TIN lookup (interface code T119).
 *
 * Wires the CRM "Search EFRIS" action to the URA system-to-system gateway. The
 * lookup resolves the company's active EFRIS configuration, signs a T119
 * envelope with the company device key, and returns only the taxpayer fields
 * the gateway is documented to return. Nothing here creates a customer: the
 * caller reviews the result and any duplicates, then saves explicitly.
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest } from '../../utils.js';
import { logAudit } from '../audit.js';
import { resolveCredentials, resolveFiscalTarget } from './config.js';
import { queryTaxpayerByTin, type UraTaxpayer } from './client.js';

/** Normalise a TIN to its digits, dropping spaces and separators. */
export function normalizeTin(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '');
}

/**
 * Light structural check only: URA TINs are 10 digits. This deliberately does
 * not reproduce URA's modulus-11 check digit — the authoritative answer is the
 * T119 response, which can still report "not found" for a well-formed TIN.
 */
export function isPlausibleTin(raw: unknown): boolean {
  return /^\d{10}$/.test(normalizeTin(raw));
}

export interface CustomerTinDuplicate {
  id: number;
  code: string;
  name: string;
  status: string;
}

export interface CustomerTinLookupResult {
  tin: string;
  found: boolean;
  taxpayer: UraTaxpayer | null;
  duplicates: CustomerTinDuplicate[];
  mode: 'TEST' | 'ACTIVE';
}

async function findCustomersByTin(client: pg.PoolClient, ctx: Ctx, tin: string): Promise<CustomerTinDuplicate[]> {
  const res = await client.query(
    `SELECT c.id, c.code, c.name, c.status
       FROM customers c
      WHERE c.tenant_id = $1 AND c.company_id = $2
        AND regexp_replace(COALESCE(c.tin, ''), '\\D', '', 'g') = $3
      ORDER BY c.id
      LIMIT 8`,
    [ctx.tenantId, ctx.companyId, tin]
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    status: String(r.status),
  }));
}

/**
 * Query URA for a customer by TIN and return a review-ready payload. Scoped to
 * the caller's tenant + company, never creates a record, and logs an audit line
 * for the lookup (TIN + found flag only — no returned taxpayer data is copied
 * into the audit trail).
 */
export async function lookupCustomerTin(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { tin?: unknown }
): Promise<CustomerTinLookupResult> {
  const tin = normalizeTin(input.tin);
  if (!isPlausibleTin(tin)) {
    throw badRequest('Enter a valid 10-digit URA TIN');
  }
  if (ctx.companyId == null) throw badRequest('Company context required');
  const target = await resolveFiscalTarget(client, ctx);
  if (!target) {
    throw badRequest('EFRIS integration is not configured for this company');
  }
  const creds = resolveCredentials(target.config);
  const result = await queryTaxpayerByTin({
    mode: target.config.mode,
    baseUrl: target.config.base_url ?? '',
    tokenUrl: target.config.token_url,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    timeoutSeconds: target.config.timeout_seconds,
    securityFlags: target.config.security_flags,
    tin: target.taxpayer?.tin ?? null,
    lookupTin: tin,
  });
  const duplicates = await findCustomersByTin(client, ctx, tin);
  await logAudit(client, ctx, {
    action: 'lookup',
    resource: 'efris_customer_tin',
    recordCode: tin,
    newValues: { tin, found: result.found },
  });
  return {
    tin,
    found: result.found,
    taxpayer: result.taxpayer,
    duplicates,
    mode: target.config.mode as 'TEST' | 'ACTIVE',
  };
}
