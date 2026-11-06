/**
 * Scheduled EFRIS gateway health checks (GAP-6 remediation).
 *
 * A periodic worker probes every active TEST/ACTIVE configuration with a
 * READ-ONLY call (T101 server time for the URA system-to-system gateway, or an
 * OAuth token request) and records the outcome in efris_health_checks. This
 * surfaces credential, device-registration and connectivity failures without
 * waiting for a live fiscal document to be rejected — no fiscal document is
 * ever submitted here.
 *
 * The offline-enabler (Aisino TCS) transport holds its device private key on
 * the TCS, not the ERP, so it cannot run the T101 probe (which demands the
 * device key). Those configurations are recorded with `ok = NULL` so the
 * dashboard can show "manual verification required" instead of a false failure.
 */
import pg from 'pg';
import { pool } from '../../db.js';
import { Ctx } from '../../db.js';
import { toCamelRows } from '../../utils.js';
import {
  resolveCredentials,
  resolveCredentialValue,
  type EfrisConfigurationRow,
} from './config.js';
import {
  EfrisClientError,
  probeEfrisGateway,
  usesOauthGateway,
  usesOfflineEnabler,
} from './client.js';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function errCode(err: unknown): string {
  if (err instanceof EfrisClientError) return err.code;
  if (err instanceof Error && (err as Error & { code?: string }).code) {
    return String((err as Error & { code?: string }).code);
  }
  return 'EFRIS_PROBE_ERROR';
}

interface HealthConfigRow extends EfrisConfigurationRow {
  taxpayer_tin: string | null;
}

function protocolOf(config: EfrisConfigurationRow): string {
  const opts = { tokenUrl: config.token_url, securityFlags: config.security_flags };
  if (usesOfflineEnabler(opts)) return 'OFFLINE_ENABLER';
  if (usesOauthGateway(opts)) return 'OAUTH';
  return 'URA_S2S';
}

function hostOf(config: EfrisConfigurationRow): string | null {
  const target = (config.token_url ?? config.base_url ?? '').trim();
  if (!target) return null;
  try {
    return new URL(target).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Probe one active TEST/ACTIVE configuration and persist the result. Never
 * throws: a failed or skipped probe is a valid health record, not an error.
 */
async function checkConfig(client: pg.PoolClient, config: HealthConfigRow): Promise<void> {
  // Session-level app context so the RLS policy (tenant_isolation) admits the
  // INSERT and the audit trigger can attribute the row.
  await client.query('SELECT set_app_context($1,$2,$3,$4)', [
    config.tenant_id,
    config.company_id,
    null,
    null,
  ]);

  const protocol = protocolOf(config);
  const host = hostOf(config);
  const opts = {
    tokenUrl: config.token_url,
    securityFlags: config.security_flags,
  };

  let ok: boolean | null;
  let returnCode: string | null;
  let message: string;
  let serverTime: string | null = null;

  if (usesOfflineEnabler(opts)) {
    // The TCS owns the device key, so T101 cannot run from the ERP. Record a
    // manual-verification marker rather than a spurious failure.
    ok = null;
    returnCode = 'OFFLINE_ENABLER';
    message = 'Offline enabler (Aisino TCS) holds the device key on the device; verify the TCS locally.';
  } else {
    const creds = resolveCredentials(config);
    try {
      const probe = await probeEfrisGateway({
        mode: config.mode,
        baseUrl: config.base_url ?? '',
        tokenUrl: config.token_url,
        grantType: config.auth_grant_type || 'client_credentials',
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        timeoutSeconds: Math.min(Number(config.timeout_seconds) || 20, 20),
        payload: {},
        tin: config.taxpayer_tin,
        securityFlags: config.security_flags,
      });
      ok = true;
      returnCode = probe.returnCode;
      message = probe.message;
      serverTime = probe.serverTime;
    } catch (err) {
      ok = false;
      returnCode = errCode(err);
      message = errMsg(err);
    }
  }

  await client.query(
    `INSERT INTO efris_health_checks
       (company_id, tenant_id, config_id, mode, protocol, host, ok, return_code, message, server_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      config.company_id,
      config.tenant_id,
      config.id,
      config.mode,
      protocol,
      host,
      ok,
      returnCode,
      message.slice(0, 2000),
      serverTime,
    ]
  );
}

/**
 * Probe every active TEST/ACTIVE configuration and record a health row for
 * each. Runs without an end-user session; guarded by singleFlight in the
 * scheduler so it never runs from two replicas at once.
 */
export async function runEfrisHealthChecks(batch = 20): Promise<{ checked: number }> {
  const res = await pool.query(
    `SELECT c.*, t.tin AS taxpayer_tin
       FROM efris_configurations c
       LEFT JOIN efris_taxpayers t ON t.id = c.taxpayer_id
      WHERE c.is_active = true AND c.mode IN ('TEST','ACTIVE')
      ORDER BY c.id
      LIMIT $1`,
    [batch]
  );
  const rows = res.rows as unknown as HealthConfigRow[];
  if (rows.length === 0) return { checked: 0 };

  const client = await pool.connect();
  try {
    for (const config of rows) {
      try {
        await checkConfig(client, config);
      } catch (err) {
        console.error('[efris][health]', errMsg(err));
      }
    }
    return { checked: rows.length };
  } finally {
    client.release();
  }
}

/** Single tick used by the API scheduler (idempotent, never throws). */
export async function runEfrisHealthCheckTick(): Promise<void> {
  try {
    await runEfrisHealthChecks(20);
  } catch (err) {
    console.error('[efris][health]', errMsg(err));
  }
}

export interface EfrisHealthFilters {
  configId?: number;
  limit?: number;
}

/**
 * Latest health checks for the caller's company, newest first. Mirrors the
 * error-centre shape: an operator gets the recent probe history per config.
 */
export async function listEfrisHealthChecks(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: EfrisHealthFilters = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where: string[] = ['h.tenant_id = $1', 'h.company_id = $2'];
  if (filters.configId != null && Number.isFinite(Number(filters.configId))) {
    params.push(Math.trunc(Number(filters.configId)));
    where.push(`h.config_id = $${params.length}`);
  }
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  params.push(limit);

  const res = await client.query(
    `SELECT h.*, c.code AS config_code, c.name AS config_name
       FROM efris_health_checks h
       LEFT JOIN efris_configurations c ON c.id = h.config_id
      WHERE ${where.join(' AND ')}
      ORDER BY h.checked_at DESC
      LIMIT $${params.length}`,
    params
  );
  return toCamelRows(res.rows);
}

/** Re-exported so the status banner can surface the most recent check. */
export async function latestEfrisHealthCheck(
  client: pg.PoolClient,
  ctx: Ctx,
  configId?: number | null
): Promise<Record<string, unknown> | null> {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let cfg = '';
  if (configId != null && Number.isFinite(Number(configId))) {
    params.push(Math.trunc(Number(configId)));
    cfg = `AND h.config_id = $${params.length}`;
  }
  const res = await client.query(
    `SELECT h.* FROM efris_health_checks h
      WHERE h.tenant_id = $1 AND h.company_id = $2 ${cfg}
      ORDER BY h.checked_at DESC
      LIMIT 1`,
    params
  );
  return res.rows[0] ? toCamelRows([res.rows[0]])[0] : null;
}
