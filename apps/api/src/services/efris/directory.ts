// ============================================================
// EFRIS directory - taxpayer & integration configuration,
// integration error centre and ERP vs EFRIS reconciliation.
// Spec sections 76-78 (platform configuration) and 91-94
// (error centre, retry engine, reconciliation dashboard).
//
// Governance rules honoured here:
//   * Secrets are never accepted, stored or returned. Only the
//     env-backed pointer keys client_id_ref / credentials_ref are
//     persisted; the values are resolved server-side at submit time.
//   * A configuration may only leave DISABLED when those pointer
//     keys actually resolve to real server-side environment secrets.
//   * FISCALIZED is never written by this module. Only the EFRIS
//     background worker writes it, after a confirmed URA FDN and
//     verification code.
// ============================================================
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, conflict, notFound, toCamelRow, toCamelRows } from '../../utils.js';
import { logAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import {
  isEfrisMode,
  assertCredentialsResolvable,
  resolveCredentialValue,
  resolveFiscalTarget,
  type EfrisConfigurationRow,
  type FiscalTarget,
} from './config.js';

/** efris_taxpayers.efris_status - mirrors the CHECK constraint in 0142. */
export const EFRIS_TAXPAYER_STATUSES: readonly string[] = [
  'NOT_CONFIGURED', 'PENDING_REGISTRATION', 'REGISTERED', 'PENDING_INTEGRATION',
  'TESTING', 'ACTIVE', 'SUSPENDED', 'ERROR', 'DISABLED',
];

/** Field names that would carry a raw integration secret. Always rejected. */
const FORBIDDEN_SECRET_FIELDS = [
  'clientSecret', 'client_secret', 'password', 'secret', 'apiKey', 'api_key',
  'token', 'accessToken', 'refreshToken', 'privateKey',
];

const str = (v: unknown): string => String(v ?? '').trim();
const nullable = (v: unknown): string | null => (str(v).length ? str(v) : null);
const intOr = (v: unknown, fallback: number): number => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.trunc(x) : fallback;
};
const boolOr = (v: unknown, fallback: boolean): boolean => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const x = v.trim().toLowerCase();
    if (x === 'true' || x === '1' || x === 'yes' || x === 'on') return true;
    if (x === 'false' || x === '0' || x === 'no' || x === 'off') return false;
  }
  return fallback;
};
const isUniqueViolation = (err: unknown): boolean =>
  !!err && typeof err === 'object' && (err as { code?: string }).code === '23505';

function dateOrNull(v: unknown): string | null {
  const raw = nullable(v);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) throw badRequest('Dates must use the YYYY-MM-DD format');
  return raw.slice(0, 10);
}

function urlOrNull(v: unknown, label: string): string | null {
  const raw = nullable(v);
  if (!raw) return null;
  if (!/^https?:\/\/[^\s]+$/.test(raw)) throw badRequest(`${label} must be a valid http(s) URL`);
  return raw;
}

function modeOrDefault(v: unknown, fallback: 'DISABLED' | 'TEST' | 'ACTIVE'): 'DISABLED' | 'TEST' | 'ACTIVE' {
  if (v == null || str(v) === '') return fallback;
  const m = str(v).toUpperCase();
  if (!isEfrisMode(m)) throw badRequest('EFRIS mode must be DISABLED, TEST or ACTIVE');
  return m;
}

/** Reject any attempt to pass an integration secret through the API. */
function rejectSecretFields(input: Record<string, unknown>): void {
  for (const key of FORBIDDEN_SECRET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] != null && str(input[key]) !== '') {
      throw badRequest(
        'EFRIS secrets are never accepted by the API. Store the value in the server environment and reference it by key.'
      );
    }
  }
}

/** A configuration may only be TEST/ACTIVE when its env pointer keys resolve. */
function assertModeResolvable(
  mode: string,
  pointers: { client_id_ref: string | null; credentials_ref: string | null }
): void {
  if (mode === 'DISABLED') return;
  assertCredentialsResolvable(pointers as EfrisConfigurationRow);
}

// ---------------------------------------------------------------------------
// Taxpayers / registered places of business (spec 76-77).
// ---------------------------------------------------------------------------
export interface EfrisTaxpayerInput {
  code?: unknown;
  legalName?: unknown;
  tradingName?: unknown;
  tin?: unknown;
  vatRegistered?: unknown;
  vatNumber?: unknown;
  taxpayerType?: unknown;
  businessSector?: unknown;
  placeOfBusiness?: unknown;
  address?: unknown;
  contactName?: unknown;
  contactEmail?: unknown;
  contactPhone?: unknown;
  efrisStatus?: unknown;
  environment?: unknown;
  branchId?: unknown;
  credentialsRef?: unknown;
  isDefault?: unknown;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
}

export async function listEfrisTaxpayers(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { status?: string } = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  let where = 'WHERE t.tenant_id = $1 AND t.company_id = $2';
  if (filters.status) {
    params.push(str(filters.status).toUpperCase());
    where += ` AND t.efris_status = $${params.length}`;
  }
  const res = await client.query(
    `SELECT t.*, b.name AS branch_name, b.code AS branch_code
       FROM efris_taxpayers t
       LEFT JOIN branches b ON b.id = t.branch_id
       ${where}
      ORDER BY t.is_default DESC, t.legal_name ASC, t.id ASC`,
    params
  );
  return toCamelRows(res.rows);
}

export async function createEfrisTaxpayer(client: pg.PoolClient, ctx: Ctx, input: EfrisTaxpayerInput) {
  rejectSecretFields(input as Record<string, unknown>);
  const code = str(input.code).toUpperCase();
  const legalName = str(input.legalName);
  const tin = str(input.tin);
  if (!code) throw badRequest('Taxpayer code is required');
  if (!legalName) throw badRequest('Legal name is required');
  if (!tin) throw badRequest('TIN is required');
  const efrisStatus = input.efrisStatus == null ? 'NOT_CONFIGURED' : str(input.efrisStatus).toUpperCase();
  if (!EFRIS_TAXPAYER_STATUSES.includes(efrisStatus)) {
    throw badRequest('Unsupported EFRIS registration status');
  }
  const environment = modeOrDefault(input.environment, 'DISABLED');
  const isDefault = boolOr(input.isDefault, false);

  if (isDefault) {
    await client.query(
      `UPDATE efris_taxpayers SET is_default = false
        WHERE tenant_id = $1 AND company_id = $2 AND is_default = true`,
      [ctx.tenantId, ctx.companyId]
    );
  }

  try {
    const res = await client.query(
      `INSERT INTO efris_taxpayers
         (company_id, tenant_id, branch_id, code, legal_name, trading_name, tin,
          vat_registered, vat_number, taxpayer_type, business_sector, place_of_business,
          address, contact_name, contact_email, contact_phone, efris_status, environment,
          credentials_ref, is_default, effective_from, effective_to, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)
       RETURNING *`,
      [
        ctx.companyId, ctx.tenantId,
        input.branchId != null ? Number(input.branchId) : (ctx.branchId ?? null),
        code, legalName, nullable(input.tradingName), tin,
        boolOr(input.vatRegistered, false), nullable(input.vatNumber),
        input.taxpayerType == null ? 'COMPANY' : str(input.taxpayerType).toUpperCase(),
        nullable(input.businessSector), nullable(input.placeOfBusiness),
        nullable(input.address), nullable(input.contactName),
        nullable(input.contactEmail), nullable(input.contactPhone),
        efrisStatus, environment, nullable(input.credentialsRef), isDefault,
        dateOrNull(input.effectiveFrom), dateOrNull(input.effectiveTo),
        ctx.userId ?? null,
      ]
    );
    const row = res.rows[0];
    await logAudit(client, ctx, {
      action: 'EFRIS_TAXPAYER_CREATED',
      resource: 'efris_taxpayer',
      recordId: Number(row.id),
      recordCode: code,
      newValues: { code, legalName, tin, efrisStatus, environment, isDefault },
    });
    await emitEvent(client, ctx, {
      eventType: 'efris.taxpayer.created',
      entityType: 'EFRIS_TAXPAYER',
      entityId: Number(row.id),
      entityCode: code,
      payload: { efrisStatus, environment },
    });
    return toCamelRow(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('A taxpayer with this code or TIN already exists for this company');
    }
    throw err;
  }
}

export async function updateEfrisTaxpayer(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: EfrisTaxpayerInput
) {
  rejectSecretFields(input as Record<string, unknown>);
  const found = await client.query(
    `SELECT * FROM efris_taxpayers WHERE id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (!found.rows.length) throw notFound('EFRIS taxpayer not found');
  const cur = found.rows[0];

  const sets: string[] = [];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId];
  const push = (col: string, value: unknown): void => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };

  if (input.code !== undefined) push('code', str(input.code).toUpperCase() || cur.code);
  if (input.legalName !== undefined) push('legal_name', str(input.legalName) || cur.legal_name);
  if (input.tradingName !== undefined) push('trading_name', nullable(input.tradingName));
  if (input.tin !== undefined) push('tin', str(input.tin) || cur.tin);
  if (input.vatRegistered !== undefined) push('vat_registered', boolOr(input.vatRegistered, cur.vat_registered));
  if (input.vatNumber !== undefined) push('vat_number', nullable(input.vatNumber));
  if (input.taxpayerType !== undefined) push('taxpayer_type', str(input.taxpayerType).toUpperCase() || cur.taxpayer_type);
  if (input.businessSector !== undefined) push('business_sector', nullable(input.businessSector));
  if (input.placeOfBusiness !== undefined) push('place_of_business', nullable(input.placeOfBusiness));
  if (input.address !== undefined) push('address', nullable(input.address));
  if (input.contactName !== undefined) push('contact_name', nullable(input.contactName));
  if (input.contactEmail !== undefined) push('contact_email', nullable(input.contactEmail));
  if (input.contactPhone !== undefined) push('contact_phone', nullable(input.contactPhone));
  if (input.branchId !== undefined) push('branch_id', input.branchId == null ? null : Number(input.branchId));
  if (input.credentialsRef !== undefined) push('credentials_ref', nullable(input.credentialsRef));
  if (input.effectiveFrom !== undefined) push('effective_from', dateOrNull(input.effectiveFrom));
  if (input.effectiveTo !== undefined) push('effective_to', dateOrNull(input.effectiveTo));

  if (input.efrisStatus !== undefined) {
    const status = str(input.efrisStatus).toUpperCase();
    if (!EFRIS_TAXPAYER_STATUSES.includes(status)) throw badRequest('Unsupported EFRIS registration status');
    push('efris_status', status);
  }
  if (input.environment !== undefined) {
    push('environment', modeOrDefault(input.environment, 'DISABLED'));
  }
  if (input.isDefault !== undefined) {
    const isDefault = boolOr(input.isDefault, cur.is_default);
    if (isDefault && !cur.is_default) {
      await client.query(
        `UPDATE efris_taxpayers SET is_default = false
          WHERE tenant_id = $1 AND company_id = $2 AND is_default = true AND id <> $3`,
        [ctx.tenantId, ctx.companyId, id]
      );
    }
    push('is_default', isDefault);
  }

  if (!sets.length) throw badRequest('No taxpayer fields were supplied');
  params.push(ctx.userId ?? null);
  sets.push(`updated_by = $${params.length}`);
  sets.push(`updated_at = now()`);

  try {
    const res = await client.query(
      `UPDATE efris_taxpayers SET ${sets.join(', ')}
        WHERE id = $1 AND tenant_id = $2 AND company_id = $3
        RETURNING *`,
      params
    );
    const row = res.rows[0];
    await logAudit(client, ctx, {
      action: 'EFRIS_TAXPAYER_UPDATED',
      resource: 'efris_taxpayer',
      recordId: id,
      recordCode: String(row.code),
      oldValues: { efrisStatus: cur.efris_status, environment: cur.environment },
      newValues: { efrisStatus: row.efris_status, environment: row.environment },
    });
    await emitEvent(client, ctx, {
      eventType: 'efris.taxpayer.updated',
      entityType: 'EFRIS_TAXPAYER',
      entityId: id,
      entityCode: String(row.code),
      payload: { efrisStatus: String(row.efris_status), environment: String(row.environment) },
    });
    return toCamelRow(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('A taxpayer with this code or TIN already exists for this company');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Integration configurations (spec 76-78). Secrets are never stored here.
// ---------------------------------------------------------------------------
export interface EfrisConfigurationInput {
  code?: unknown;
  name?: unknown;
  taxpayerId?: unknown;
  mode?: unknown;
  baseUrl?: unknown;
  tokenUrl?: unknown;
  authGrantType?: unknown;
  clientIdRef?: unknown;
  credentialsRef?: unknown;
  timeoutSeconds?: unknown;
  maxAttempts?: unknown;
  retryBackoffSeconds?: unknown;
  pollIntervalSeconds?: unknown;
  fiscalizeSalesOnPost?: unknown;
  autoSubmit?: unknown;
  notifyOnFailure?: unknown;
  notifyRoleCodes?: unknown;
  duplicateWindowSeconds?: unknown;
  payloadMapping?: unknown;
  securityFlags?: unknown;
  isActive?: unknown;
}

/** Public projection: raw env pointer keys are internal plumbing, not UI data. */
function publicConfiguration(row: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...row };
  out.clientIdRefSet = Boolean(row.client_id_ref);
  out.credentialsRefSet = Boolean(row.credentials_ref);
  out.secretsResolvable =
    Boolean(row.client_id_ref) &&
    Boolean(row.credentials_ref) &&
    Boolean(resolveCredentialValue(row.client_id_ref as string | null)) &&
    Boolean(resolveCredentialValue(row.credentials_ref as string | null));
  delete out.client_id_ref;
  delete out.credentials_ref;
  return toCamelRow(out);
}

export async function listEfrisConfigurations(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT c.*, t.legal_name AS taxpayer_legal_name, t.tin AS taxpayer_tin,
            t.efris_status AS taxpayer_status
       FROM efris_configurations c
       LEFT JOIN efris_taxpayers t ON t.id = c.taxpayer_id
      WHERE c.tenant_id = $1 AND c.company_id = $2
      ORDER BY c.is_active DESC, c.mode DESC, c.id DESC`,
    [ctx.tenantId, ctx.companyId]
  );
  return res.rows.map((r) => publicConfiguration(r as Record<string, unknown>));
}

function jsonOr(value: unknown, fallback: Record<string, unknown>): string {
  if (value == null) return JSON.stringify(fallback);
  if (typeof value === 'object') return JSON.stringify(value);
  const raw = str(value);
  if (!raw) return JSON.stringify(fallback);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return JSON.stringify(parsed);
    throw new Error('not an object');
  } catch {
    throw badRequest('Expected a JSON object');
  }
}

function roleCodesOr(value: unknown, fallback: string[]): string {
  if (value == null) return JSON.stringify(fallback);
  if (!Array.isArray(value)) throw badRequest('notifyRoleCodes must be an array of role codes');
  const codes = value.map((x) => str(x)).filter((x) => x.length > 0);
  return JSON.stringify(codes);
}

export async function createEfrisConfiguration(
  client: pg.PoolClient,
  ctx: Ctx,
  input: EfrisConfigurationInput
) {
  rejectSecretFields(input as Record<string, unknown>);
  const code = str(input.code).toUpperCase();
  const name = str(input.name);
  if (!code) throw badRequest('Configuration code is required');
  if (!name) throw badRequest('Configuration name is required');
  const mode = modeOrDefault(input.mode, 'DISABLED');
  const clientIdRef = nullable(input.clientIdRef);
  const credentialsRef = nullable(input.credentialsRef);
  assertModeResolvable(mode, { client_id_ref: clientIdRef, credentials_ref: credentialsRef });

  let taxpayerId: number | null = input.taxpayerId == null ? null : Number(input.taxpayerId);
  if (taxpayerId == null) {
    const def = await client.query(
      `SELECT id FROM efris_taxpayers
        WHERE tenant_id = $1 AND company_id = $2
        ORDER BY is_default DESC, id ASC LIMIT 1`,
      [ctx.tenantId, ctx.companyId]
    );
    taxpayerId = def.rows.length ? Number(def.rows[0].id) : null;
  }

  try {
    const res = await client.query(
      `INSERT INTO efris_configurations
         (company_id, tenant_id, taxpayer_id, code, name, mode, base_url, token_url,
          auth_grant_type, client_id_ref, credentials_ref, timeout_seconds, max_attempts,
          retry_backoff_seconds, poll_interval_seconds, fiscalize_sales_on_post, auto_submit,
          notify_on_failure, notify_role_codes, duplicate_window_seconds, payload_mapping,
          security_flags, is_active, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21::jsonb,$22::jsonb,$23,$24,$24)
       RETURNING *`,
      [
        ctx.companyId, ctx.tenantId, taxpayerId, code, name, mode,
        urlOrNull(input.baseUrl, 'baseUrl'), urlOrNull(input.tokenUrl, 'tokenUrl'),
        input.authGrantType == null ? 'client_credentials' : str(input.authGrantType),
        clientIdRef, credentialsRef,
        intOr(input.timeoutSeconds, 20), intOr(input.maxAttempts, 5),
        intOr(input.retryBackoffSeconds, 120), intOr(input.pollIntervalSeconds, 30),
        boolOr(input.fiscalizeSalesOnPost, false), boolOr(input.autoSubmit, false),
        boolOr(input.notifyOnFailure, true),
        roleCodesOr(input.notifyRoleCodes, [
          'cfo', 'finance_manager', 'chief_accountant', 'financial_controller', 'tax_officer',
        ]),
        intOr(input.duplicateWindowSeconds, 300),
        jsonOr(input.payloadMapping, {}), jsonOr(input.securityFlags, {}),
        boolOr(input.isActive, true), ctx.userId ?? null,
      ]
    );
    const row = res.rows[0];
    await logAudit(client, ctx, {
      action: 'EFRIS_CONFIGURATION_CREATED',
      resource: 'efris_configuration',
      recordId: Number(row.id),
      recordCode: code,
      newValues: { code, name, mode, taxpayerId, autoSubmit: row.auto_submit },
    });
    await emitEvent(client, ctx, {
      eventType: 'efris.configuration.created',
      entityType: 'EFRIS_CONFIGURATION',
      entityId: Number(row.id),
      entityCode: code,
      payload: { mode },
    });
    return publicConfiguration(row as Record<string, unknown>);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('An EFRIS configuration with this code already exists');
    throw err;
  }
}

export async function updateEfrisConfiguration(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: EfrisConfigurationInput
) {
  rejectSecretFields(input as Record<string, unknown>);
  const found = await client.query(
    `SELECT * FROM efris_configurations WHERE id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (!found.rows.length) throw notFound('EFRIS configuration not found');
  const cur = found.rows[0] as EfrisConfigurationRow;

  const sets: string[] = [];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId];
  const push = (col: string, value: unknown): void => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };

  let nextMode: string = cur.mode;
  let nextClientRef: string | null = cur.client_id_ref;
  let nextCredRef: string | null = cur.credentials_ref;

  if (input.code !== undefined) push('code', str(input.code).toUpperCase() || cur.code);
  if (input.name !== undefined) push('name', str(input.name) || cur.name);
  if (input.taxpayerId !== undefined) {
    push('taxpayer_id', input.taxpayerId == null ? null : Number(input.taxpayerId));
  }
  if (input.baseUrl !== undefined) push('base_url', urlOrNull(input.baseUrl, 'baseUrl'));
  if (input.tokenUrl !== undefined) push('token_url', urlOrNull(input.tokenUrl, 'tokenUrl'));
  if (input.authGrantType !== undefined) push('auth_grant_type', str(input.authGrantType));
  if (input.clientIdRef !== undefined) {
    nextClientRef = nullable(input.clientIdRef);
    push('client_id_ref', nextClientRef);
  }
  if (input.credentialsRef !== undefined) {
    nextCredRef = nullable(input.credentialsRef);
    push('credentials_ref', nextCredRef);
  }
  if (input.timeoutSeconds !== undefined) push('timeout_seconds', intOr(input.timeoutSeconds, cur.timeout_seconds));
  if (input.maxAttempts !== undefined) push('max_attempts', intOr(input.maxAttempts, cur.max_attempts));
  if (input.retryBackoffSeconds !== undefined) {
    push('retry_backoff_seconds', intOr(input.retryBackoffSeconds, cur.retry_backoff_seconds));
  }
  if (input.pollIntervalSeconds !== undefined) {
    push('poll_interval_seconds', intOr(input.pollIntervalSeconds, cur.poll_interval_seconds));
  }
  if (input.fiscalizeSalesOnPost !== undefined) {
    push('fiscalize_sales_on_post', boolOr(input.fiscalizeSalesOnPost, cur.fiscalize_sales_on_post));
  }
  if (input.autoSubmit !== undefined) push('auto_submit', boolOr(input.autoSubmit, cur.auto_submit));
  if (input.notifyOnFailure !== undefined) {
    push('notify_on_failure', boolOr(input.notifyOnFailure, cur.notify_on_failure));
  }
  if (input.notifyRoleCodes !== undefined) {
    push('notify_role_codes', roleCodesOr(input.notifyRoleCodes, []));
  }
  if (input.duplicateWindowSeconds !== undefined) {
    push('duplicate_window_seconds', intOr(input.duplicateWindowSeconds, cur.duplicate_window_seconds));
  }
  if (input.payloadMapping !== undefined) push('payload_mapping', jsonOr(input.payloadMapping, {}));
  if (input.securityFlags !== undefined) push('security_flags', jsonOr(input.securityFlags, {}));
  if (input.isActive !== undefined) push('is_active', boolOr(input.isActive, cur.is_active));
  if (input.mode !== undefined) {
    nextMode = modeOrDefault(input.mode, 'DISABLED');
    assertModeResolvable(nextMode, { client_id_ref: nextClientRef, credentials_ref: nextCredRef });
    push('mode', nextMode);
  } else if (nextClientRef !== cur.client_id_ref || nextCredRef !== cur.credentials_ref) {
    assertModeResolvable(cur.mode, { client_id_ref: nextClientRef, credentials_ref: nextCredRef });
  }

  if (!sets.length) throw badRequest('No configuration fields were supplied');
  params.push(ctx.userId ?? null);
  sets.push(`updated_by = $${params.length}`);
  sets.push(`updated_at = now()`);

  try {
    const res = await client.query(
      `UPDATE efris_configurations SET ${sets.join(', ')}
        WHERE id = $1 AND tenant_id = $2 AND company_id = $3
        RETURNING *`,
      params
    );
    const row = res.rows[0];
    await logAudit(client, ctx, {
      action: 'EFRIS_CONFIGURATION_UPDATED',
      resource: 'efris_configuration',
      recordId: id,
      recordCode: String(row.code),
      oldValues: { mode: cur.mode, isActive: cur.is_active, autoSubmit: cur.auto_submit },
      newValues: { mode: row.mode, isActive: row.is_active, autoSubmit: row.auto_submit },
    });
    await emitEvent(client, ctx, {
      eventType: 'efris.configuration.updated',
      entityType: 'EFRIS_CONFIGURATION',
      entityId: id,
      entityCode: String(row.code),
      payload: { mode: String(row.mode), isActive: Boolean(row.is_active) },
    });
    return publicConfiguration(row as Record<string, unknown>);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('An EFRIS configuration with this code already exists');
    throw err;
  }
}

export interface EfrisIntegrationStatus {
  configured: boolean;
  mode: string;
  active: boolean;
  fiscalizationEnabled: boolean;
  secretsResolvable: boolean;
  taxpayerStatus: string | null;
  environment: string | null;
  companyTinConfigured: boolean;
  openErrors: number;
  pendingTransactions: number;
  fiscalizedTransactions: number;
  failedTransactions: number;
  lastSuccessfulTransactionAt: string | null;
  lastErrorAt: string | null;
  message: string;
}

/**
 * Spec 77 - connection / fiscalization status banner for the admin screen.
 *
 * Reports posture only. It never reveals a secret and it never claims that
 * fiscalization is live unless an ACTIVE or TEST configuration exists whose
 * environment-backed credentials actually resolve on this server.
 */
export async function efrisIntegrationStatus(
  client: pg.PoolClient,
  ctx: Ctx
): Promise<EfrisIntegrationStatus> {
  const cfgRes = await client.query(
    `SELECT c.*, t.legal_name AS taxpayer_legal_name, t.tin AS taxpayer_tin,
            t.efris_status AS taxpayer_status, t.environment AS taxpayer_environment,
            t.vat_registered AS taxpayer_vat_registered, b.name AS branch_name
       FROM efris_configurations c
       LEFT JOIN efris_taxpayers t ON t.id = c.taxpayer_id
       LEFT JOIN branches b ON b.id = t.branch_id
      WHERE c.tenant_id = $1 AND c.company_id = $2
      ORDER BY c.is_active DESC, c.mode DESC, c.id DESC
      LIMIT 1`,
    [ctx.tenantId, ctx.companyId]
  );

  const config = (cfgRes.rows[0] ?? null) as EfrisConfigurationRow | null;

  const txnRes = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('PENDING','QUEUED','PROCESSING','RETRYING','TRANSMITTED'))::int AS pending_transactions,
       COUNT(*) FILTER (WHERE status = 'FISCALIZED')::int AS fiscalized_transactions,
       COUNT(*) FILTER (WHERE status IN ('FAILED','REJECTED'))::int AS failed_transactions,
       MAX(fiscalized_at) FILTER (WHERE status = 'FISCALIZED') AS last_success_at
     FROM efris_transactions
     WHERE tenant_id = $1 AND company_id = $2`,
    [ctx.tenantId, ctx.companyId]
  );
  const txn = (txnRes.rows[0] ?? {}) as Record<string, unknown>;

  const errRes = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE resolved = false)::int AS open_errors,
       MAX(created_at) AS last_error_at
     FROM efris_integration_errors
     WHERE tenant_id = $1 AND company_id = $2`,
    [ctx.tenantId, ctx.companyId]
  );
  const errRow = (errRes.rows[0] ?? {}) as Record<string, unknown>;

  const mode = config?.mode ?? 'DISABLED';
  const active = Boolean(config?.is_active) && mode !== 'DISABLED';
  const secretsResolvable =
    Boolean(config?.client_id_ref) &&
    Boolean(config?.credentials_ref) &&
    Boolean(resolveCredentialValue(config?.client_id_ref)) &&
    Boolean(resolveCredentialValue(config?.credentials_ref));
  const fiscalizationEnabled = active && secretsResolvable;

  let message: string;
  if (!config) {
    message =
      'No EFRIS configuration exists for this company. Fiscalization is inert until a taxpayer and configuration are registered.';
  } else if (mode === 'DISABLED') {
    message = 'EFRIS configuration is present but switched off. No document will be submitted to URA.';
  } else if (!secretsResolvable) {
    message =
      'EFRIS is set to ' + mode + ' but the referenced server-side credentials are not present in the environment. Submission is blocked to avoid unsigned requests.';
  } else if (!Boolean(config.is_active)) {
    message = 'EFRIS configuration is inactive. Fiscalization is paused until it is re-activated.';
  } else {
    message =
      'EFRIS is connected in ' + mode + ' mode. ' + String(txn.pending_transactions ?? 0) + ' transaction(s) awaiting a URA response.';
  }

  return {
    configured: Boolean(config),
    mode,
    active,
    fiscalizationEnabled,
    secretsResolvable,
    taxpayerStatus: (config as unknown as { taxpayer_status?: string | null } | null)?.taxpayer_status ?? null,
    environment: (config as unknown as { taxpayer_environment?: string | null } | null)?.taxpayer_environment ?? null,
    companyTinConfigured: Boolean((config as unknown as { taxpayer_tin?: string | null } | null)?.taxpayer_tin),
    openErrors: Number(errRow.open_errors ?? 0),
    pendingTransactions: Number(txn.pending_transactions ?? 0),
    fiscalizedTransactions: Number(txn.fiscalized_transactions ?? 0),
    failedTransactions: Number(txn.failed_transactions ?? 0),
    lastSuccessfulTransactionAt: txn.last_success_at ? new Date(txn.last_success_at as string).toISOString() : null,
    lastErrorAt: errRow.last_error_at ? new Date(errRow.last_error_at as string).toISOString() : null,
    message,
  };
}

export interface EfrisErrorFilters {
  resolved?: unknown;
  stage?: unknown;
  transactionId?: unknown;
}

/**
 * Spec 91 - EFRIS error centre listing. Open errors always sort first so the
 * operator sees actionable items before historical ones. Bounded to 500 rows.
 */
export async function listEfrisErrors(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: EfrisErrorFilters = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where: string[] = ['e.tenant_id = $1', '(e.company_id = $2 OR e.company_id IS NULL)'];

  if (filters.resolved !== undefined && filters.resolved !== null && nullable(filters.resolved) !== null) {
    params.push(boolOr(filters.resolved, false));
    where.push(`e.resolved = $${params.length}`);
  }
  if (nullable(filters.stage)) {
    params.push(str(filters.stage));
    where.push(`e.stage = $${params.length}`);
  }
  const txnId = Number(filters.transactionId);
  if (Number.isFinite(txnId) && txnId > 0) {
    params.push(Math.trunc(txnId));
    where.push(`e.efris_transaction_id = $${params.length}`);
  }

  const res = await client.query(
    `SELECT e.*,
            t.doc_type, t.doc_ref_type, t.doc_ref_code, t.doc_ref_id,
            t.status AS transaction_status, t.gross_amount, t.tax_amount, t.currency,
            t.attempts AS transaction_attempts, t.next_attempt_at, t.fiscal_mode
       FROM efris_integration_errors e
       LEFT JOIN efris_transactions t ON t.id = e.efris_transaction_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.resolved ASC, e.created_at DESC
      LIMIT 500`,
    params
  );
  return toCamelRows(res.rows);
}

/**
 * Spec 92 - controlled retry engine.
 *
 * A retry never fabricates a fiscal result. It clears the previous failure and
 * returns the transaction to QUEUED so efris_claim_fiscal_batch() can hand it to
 * the worker again; FISCALIZED is still only ever written from a confirmed URA
 * response. Submissions that are already fiscalized, in flight, or terminally
 * voided are refused so the same document cannot be double-reported to URA.
 */
export async function retryEfrisError(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  note?: string | null
) {
  if (!Number.isFinite(id) || id <= 0) throw badRequest('A valid EFRIS error id is required');

  const errRes = await client.query(
    `SELECT * FROM efris_integration_errors
      WHERE id = $1 AND tenant_id = $2
      FOR UPDATE`,
    [id, ctx.tenantId]
  );
  const errRow = errRes.rows[0];
  if (!errRow) throw notFound('EFRIS integration error not found');
  if (errRow.resolved) throw badRequest('This EFRIS error has already been resolved');

  const txnId = Number(errRow.efris_transaction_id);
  if (!Number.isFinite(txnId) || txnId <= 0) {
    throw badRequest('This error is not linked to an EFRIS transaction and cannot be requeued');
  }

  const txnRes = await client.query(
    `SELECT * FROM efris_transactions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [txnId, ctx.tenantId]
  );
  const txn = txnRes.rows[0];
  if (!txn) throw notFound('EFRIS transaction not found');
  if (txn.status === 'FISCALIZED') {
    throw badRequest('This transaction is already fiscalized by URA and cannot be resubmitted');
  }
  if (txn.status === 'PROCESSING') {
    throw badRequest('This transaction is currently being processed by the EFRIS worker');
  }
  if (['CANCELLED', 'VOIDED', 'REJECTED'].includes(String(txn.status))) {
    throw badRequest(`This transaction is ${String(txn.status).toLowerCase()} and cannot be requeued`);
  }

  const target: FiscalTarget | null = await resolveFiscalTarget(client, ctx);
  if (!target) {
    throw badRequest(
      'EFRIS is not enabled for this company. Activate a TEST/ACTIVE integration configuration before retrying fiscalization.'
    );
  }
  assertCredentialsResolvable(target.config);

  await client.query(
    `UPDATE efris_transactions
        SET status = 'QUEUED',
            fiscal_mode = $3,
            taxpayer_id = $4,
            branch_id = $5,
            claimed_at = NULL,
            next_attempt_at = now(),
            error_code = NULL,
            last_error = NULL,
            requested_by = $6,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [
      txnId,
      ctx.tenantId,
      target.config.mode,
      target.config.taxpayer_id ?? null,
      target.taxpayer?.branch_id ?? null,
      ctx.userId ?? null,
    ]
  );

  await client.query(
    `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, request_payload)
     VALUES ($1, $2, 'QUEUED', $3::jsonb)`,
    [
      ctx.tenantId,
      txnId,
      JSON.stringify({
        action: 'retryFailedFiscalization',
        errorId: id,
        errorCode: String(errRow.error_code),
        retriedById: ctx.userId ?? null,
        note: nullable(note),
      }),
    ]
  );

  const errUpd = await client.query(
    `UPDATE efris_integration_errors
        SET retry_count = retry_count + 1
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, ctx.tenantId]
  );

  await logAudit(client, ctx, {
    action: 'EFRIS_ERROR_RETRIED',
    resource: 'efris_integration_error',
    recordId: id,
    recordCode: String(errRow.error_code),
    oldValues: { transactionStatus: String(txn.status), retryCount: Number(errRow.retry_count) },
    newValues: { transactionStatus: 'QUEUED', retryCount: Number(errRow.retry_count) + 1 },
    metadata: { transactionId: txnId, docRefCode: String(txn.doc_ref_code), note: nullable(note) },
  });
  await emitEvent(client, ctx, {
    eventType: 'efris.error.retried',
    entityType: 'EFRIS_TRANSACTION',
    entityId: txnId,
    entityCode: String(txn.doc_ref_code),
    payload: { errorId: id, errorCode: String(errRow.error_code), mode: target.config.mode },
    severity: 'WARN',
  });

  const txnAfter = await client.query(
    `SELECT * FROM efris_transactions WHERE id = $1 AND tenant_id = $2`,
    [txnId, ctx.tenantId]
  );

  return {
    error: toCamelRow(errUpd.rows[0] as Record<string, unknown>),
    transaction: toCamelRow(txnAfter.rows[0] as Record<string, unknown>),
  };
}

/**
 * Spec 91 - close an EFRIS error with a recorded resolution.
 *
 * Archiving is a governance action, not a fiscal one: it records why an error
 * was accepted as closed. When cancelTransaction is requested the linked ERP
 * transaction is moved to CANCELLED so it stops being claimable - which is
 * refused outright if URA has already fiscalized it.
 */
export async function archiveEfrisError(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  resolution: string,
  options: { cancelTransaction?: unknown } = {}
) {
  if (!Number.isFinite(id) || id <= 0) throw badRequest('A valid EFRIS error id is required');
  const note = str(resolution);
  if (note.length < 5) throw badRequest('A resolution note of at least 5 characters is required');

  const errRes = await client.query(
    `SELECT * FROM efris_integration_errors
      WHERE id = $1 AND tenant_id = $2
      FOR UPDATE`,
    [id, ctx.tenantId]
  );
  const errRow = errRes.rows[0];
  if (!errRow) throw notFound('EFRIS integration error not found');
  if (errRow.resolved) return toCamelRow(errRow as Record<string, unknown>);

  const txnId = Number(errRow.efris_transaction_id);
  const cancelTxn = boolOr(options.cancelTransaction, false)
    && Number.isFinite(txnId)
    && txnId > 0;
  let cancelled = false;

  if (cancelTxn) {
    const txnRes = await client.query(
      `SELECT * FROM efris_transactions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [txnId, ctx.tenantId]
    );
    const txn = txnRes.rows[0];
    if (!txn) throw notFound('EFRIS transaction not found');
    if (txn.status === 'FISCALIZED') {
      throw badRequest('This transaction is already fiscalized by URA and cannot be cancelled');
    }
    if (txn.status === 'PROCESSING') {
      throw badRequest('This transaction is currently being processed and cannot be cancelled');
    }
    await client.query(
      `UPDATE efris_transactions
          SET status = 'CANCELLED', claimed_at = NULL, next_attempt_at = NULL, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [txnId, ctx.tenantId]
    );
    await client.query(
      `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, request_payload)
       VALUES ($1, $2, 'CANCELLED', $3::jsonb)`,
      [
        ctx.tenantId,
        txnId,
        JSON.stringify({
          action: 'cancelAfterFiscalizationError',
          errorId: id,
          cancelledById: ctx.userId ?? null,
          resolution: note,
        }),
      ]
    );
    cancelled = true;
  }

  const upd = await client.query(
    `UPDATE efris_integration_errors
        SET resolved = true,
            resolved_by = $3,
            resolved_at = now(),
            resolution = $4
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, ctx.tenantId, ctx.userId ?? null, note]
  );

  await logAudit(client, ctx, {
    action: 'EFRIS_ERROR_ARCHIVED',
    resource: 'efris_integration_error',
    recordId: id,
    recordCode: String(errRow.error_code),
    oldValues: { resolved: false },
    newValues: { resolved: true, transactionCancelled: cancelled },
    metadata: { transactionId: Number.isFinite(txnId) ? txnId : null, resolution: note },
  });
  await emitEvent(client, ctx, {
    eventType: 'efris.error.archived',
    entityType: 'EFRIS_INTEGRATION_ERROR',
    entityId: id,
    entityCode: String(errRow.error_code),
    payload: { resolution: note, transactionCancelled: cancelled },
    severity: 'INFO',
  });

  return toCamelRow(upd.rows[0] as Record<string, unknown>);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dateOnlyOrDefault(v: unknown, fallback: string): string {
  const raw = nullable(v);
  if (raw && DATE_ONLY.test(raw)) return raw;
  return fallback;
}

/**
 * Spec 94 - ERP vs EFRIS reconciliation.
 *
 * Compares what the ERP recorded against what URA actually confirmed. The ERP
 * side counts every non-voided customer invoice in the window; the fiscal side
 * counts only transactions with a terminal fiscal status. Any gap between the
 * two surfaces as a variance plus an alert - it is never smoothed over.
 */
export async function efrisReconciliation(
  client: pg.PoolClient,
  ctx: Ctx,
  from?: string | null,
  to?: string | null
) {
  const now = new Date();
  const toDate = dateOnlyOrDefault(to, now.toISOString().slice(0, 10));
  const fromDate = dateOnlyOrDefault(
    from,
    new Date(now.getTime() - 29 * 86400000).toISOString().slice(0, 10)
  );

  const erpRes = await client.query(
    `SELECT COUNT(*)::int AS invoice_count,
            COALESCE(SUM(total), 0) AS sales_total,
            COALESCE(SUM(tax_amount), 0) AS tax_total
       FROM customer_invoices
      WHERE tenant_id = $1 AND company_id = $2
        AND status <> 'VOID'
        AND invoice_date >= $3::date AND invoice_date <= $4::date`,
    [ctx.tenantId, ctx.companyId, fromDate, toDate]
  );
  const erp = (erpRes.rows[0] ?? {}) as Record<string, unknown>;

  const fiscalRes = await client.query(
    `SELECT status,
            COUNT(*)::int AS count,
            COALESCE(SUM(gross_amount), 0) AS gross_total,
            COALESCE(SUM(tax_amount), 0) AS tax_total
       FROM efris_transactions
      WHERE tenant_id = $1 AND company_id = $2
        AND txn_date >= $3::date AND txn_date <= $4::date
      GROUP BY status`,
    [ctx.tenantId, ctx.companyId, fromDate, toDate]
  );

  const byStatus: Record<string, { count: number; grossTotal: number; taxTotal: number }> = {};
  let fiscalizedCount = 0;
  let fiscalizedSalesTotal = 0;
  let fiscalizedTaxTotal = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let cancelledCount = 0;
  let totalCount = 0;

  for (const r of fiscalRes.rows as Array<Record<string, unknown>>) {
    const status = String(r.status);
    const count = Number(r.count ?? 0);
    const gross = Number(r.gross_total ?? 0);
    const tax = Number(r.tax_total ?? 0);
    byStatus[status] = { count, grossTotal: gross, taxTotal: tax };
    totalCount += count;
    if (status === 'FISCALIZED') {
      fiscalizedCount += count;
      fiscalizedSalesTotal += gross;
      fiscalizedTaxTotal += tax;
    } else if (['PENDING', 'QUEUED', 'PROCESSING', 'RETRYING', 'TRANSMITTED'].includes(status)) {
      pendingCount += count;
    } else if (['FAILED', 'REJECTED'].includes(status)) {
      failedCount += count;
    } else if (['CANCELLED', 'VOIDED'].includes(status)) {
      cancelledCount += count;
    }
  }

  const matchRes = await client.query(
    `SELECT COUNT(DISTINCT i.id)::int AS matched
       FROM customer_invoices i
       JOIN efris_transactions t
         ON t.doc_ref_id = i.id
        AND t.doc_ref_type IN ('CUSTOMER_INVOICE', 'SALES_INVOICE')
        AND t.tenant_id = i.tenant_id
        AND t.status = 'FISCALIZED'
      WHERE i.tenant_id = $1 AND i.company_id = $2
        AND i.status <> 'VOID'
        AND i.invoice_date >= $3::date AND i.invoice_date <= $4::date`,
    [ctx.tenantId, ctx.companyId, fromDate, toDate]
  );
  const matchedInvoices = Number((matchRes.rows[0] ?? {}).matched ?? 0);
  const invoiceCount = Number(erp.invoice_count ?? 0);

  const errRes = await client.query(
    `SELECT COUNT(*) FILTER (WHERE resolved = false)::int AS open_errors,
            COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS errors_last_24h
       FROM efris_integration_errors
      WHERE tenant_id = $1 AND company_id = $2`,
    [ctx.tenantId, ctx.companyId]
  );
  const errRow = (errRes.rows[0] ?? {}) as Record<string, unknown>;
  const openErrors = Number(errRow.open_errors ?? 0);

  const status = await efrisIntegrationStatus(client, ctx);

  const round2 = (v: number) => Math.round(v * 100) / 100;
  const varianceSales = round2(Number(erp.sales_total ?? 0) - fiscalizedSalesTotal);
  const varianceTax = round2(Number(erp.tax_total ?? 0) - fiscalizedTaxTotal);
  const unreconciledInvoices = Math.max(invoiceCount - matchedInvoices, 0);

  return {
    range: { from: fromDate, to: toDate },
    generatedAt: new Date().toISOString(),
    configuration: {
      configured: status.configured,
      mode: status.mode,
      active: status.active,
      fiscalizationEnabled: status.fiscalizationEnabled,
      message: status.message,
    },
    erp: {
      invoiceCount,
      salesTotal: Number(erp.sales_total ?? 0),
      taxTotal: Number(erp.tax_total ?? 0),
    },
    fiscal: {
      totalCount,
      byStatus,
      fiscalizedCount,
      fiscalizedSalesTotal: round2(fiscalizedSalesTotal),
      fiscalizedTaxTotal: round2(fiscalizedTaxTotal),
      pendingCount,
      failedCount,
      cancelledCount,
    },
    reconciliation: {
      matchedInvoices,
      unreconciledInvoices,
      varianceSales,
      varianceTax,
      balanced: varianceSales === 0 && varianceTax === 0 && unreconciledInvoices === 0,
    },
    alerts: {
      openErrors,
      errorsLast24h: Number(errRow.errors_last_24h ?? 0),
      hasFailedFiscalization: failedCount > 0,
      hasUnreconciledTransactions: unreconciledInvoices > 0,
      hasFinanceVariance: varianceSales !== 0 || varianceTax !== 0,
      connectionConfigured: status.fiscalizationEnabled,
    },
  };
}
