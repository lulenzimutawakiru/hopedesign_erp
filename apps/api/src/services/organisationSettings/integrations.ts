import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, notFound, toCamelRow } from '../../utils.js';
import { logAudit } from '../audit.js';
import { decryptSecret, encryptSecret } from '../companyConfig.js';

/**
 * Integration registry.
 *
 * Every external system the ERP talks to is described once, here, and the
 * description drives the form, the stored shape and the read-back. The one
 * thing that must never drift is where a secret lives in storage, because a
 * writer that stores `apiKey` while the reader looks for `api_key` produces
 * the worst possible failure: the credential saves cleanly, reads back as
 * absent, and the integration silently fails authentication.
 *
 * So secrets are not spelled out twice. Each integration declares
 * [formField, storedKey] pairs in one SECRET_FIELDS constant, and both
 * writeSecrets() and readSecrets() walk that same constant. There is no second
 * place for the names to be typed, so there is no second place for them to
 * disagree.
 *
 * Secrets are encrypted with encryptSecret() before they touch the database and
 * are never returned by value. A settings screen needs to know only whether a
 * credential is set, so that an empty field means "leave it alone" rather than
 * "erase it" (AC-ORG-010).
 */

export const INTEGRATION_CATEGORIES = [
  'payments', 'communication', 'accounting', 'tax', 'storage', 'analytics', 'regulatory', 'other',
] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export const INTEGRATION_STATUSES = ['CONNECTED', 'DISCONNECTED', 'ERROR', 'TESTING'] as const;

export type IntegrationFieldType = 'text' | 'number' | 'boolean' | 'url' | 'select' | 'env';

export interface IntegrationFieldDef {
  label: string;
  type: IntegrationFieldType;
  required?: boolean;
  options?: readonly string[];
  help?: string;
}

export interface IntegrationDef {
  code: string;
  name: string;
  category: IntegrationCategory;
  blurb: string;
  /** Writes a status of CONNECTED/ERROR and drives the health column. */
  testable?: boolean;
  config: Record<string, IntegrationFieldDef>;
  /**
   * [form field, key inside the stored secrets object]. Declared once, read by
   * both directions.
   */
  secrets: ReadonlyArray<readonly [string, string]>;
}

const ENVIRONMENT_FIELD: IntegrationFieldDef = {
  label: 'Environment',
  type: 'select',
  options: ['SANDBOX', 'PRODUCTION'] as const,
  help: 'Keep SANDBOX until the connection has been proven end to end.',
};

const ENDPOINT_FIELD: IntegrationFieldDef = { label: 'Base endpoint', type: 'url' };

/**
 * The registry. Adding an integration is a change to this array only.
 *
 * The inner array is given an explicit IntegrationDef[] annotation rather than
 * being passed straight to Object.freeze(). Object.freeze infers its element
 * type from the array literal, and the literals differ in shape, so inference
 * collapses them into one union in which every member carries the other
 * members' keys as `?: undefined`. That union then fails to satisfy the
 * Record<string, IntegrationFieldDef> index signature on config, because
 * `undefined` is not an IntegrationFieldDef. Annotating gives each literal a
 * contextual type and each one is then checked on its own merits.
 */
const INTEGRATION_DEFS: IntegrationDef[] = [
  {
    code: 'ura_efris',
    name: 'URA / EFRIS',
    category: 'tax',
    blurb: 'Electronic Fiscal Receipting and Invoicing Solution - e-invoices, credit notes and fiscal codes.',
    testable: true,
    config: {
      environment: ENVIRONMENT_FIELD,
      endpoint: { ...ENDPOINT_FIELD, help: 'URA EFRIS API base URL for the selected environment.' },
      tin: { label: 'Taxpayer TIN', type: 'text', required: true },
      device_number: { label: 'Device number', type: 'text' },
      dvc_id: { label: 'Device ID (DVC)', type: 'text' },
      sandbox_verified: { label: 'Sandbox connection proven', type: 'boolean' },
    },
    secrets: [
      ['client_id', 'efris_client_id'],
      ['client_secret', 'efris_client_secret'],
    ],
  },
  {
    code: 'nssf',
    name: 'NSSF',
    category: 'regulatory',
    blurb: 'National Social Security Fund employer returns and contribution schedules.',
    testable: true,
    config: {
      environment: ENVIRONMENT_FIELD,
      endpoint: ENDPOINT_FIELD,
      employer_number: { label: 'NSSF employer number', type: 'text', required: true },
    },
    secrets: [
      ['api_username', 'nssf_username'],
      ['api_password', 'nssf_password'],
    ],
  },
  {
    code: 'equity_bank',
    name: 'Equity Bank',
    category: 'payments',
    blurb: 'Equity Bank collections, disbursements and statement reconciliation.',
    testable: true,
    config: {
      environment: ENVIRONMENT_FIELD,
      endpoint: ENDPOINT_FIELD,
      country: { label: 'Country', type: 'select', options: ['UG', 'KE', 'TZ', 'RW', 'SS'] as const },
      currency: { label: 'Settlement currency', type: 'select', options: ['UGX', 'KES', 'USD'] as const },
      account_number: { label: 'Collection account', type: 'text' },
      merchant_code: { label: 'Merchant code', type: 'text' },
      callback_url: { label: 'Callback URL', type: 'url' },
    },
    secrets: [
      ['consumer_key', 'equity_consumer_key'],
      ['consumer_secret', 'equity_consumer_secret'],
      ['private_key', 'equity_private_key'],
      ['passphrase', 'equity_passphrase'],
    ],
  },
  {
    code: 'kcb_bank',
    name: 'KCB Bank',
    category: 'payments',
    blurb: 'KCB Bank collections, disbursements and statement reconciliation.',
    testable: true,
    config: {
      environment: ENVIRONMENT_FIELD,
      endpoint: ENDPOINT_FIELD,
      country: { label: 'Country', type: 'select', options: ['UG', 'KE', 'TZ', 'RW', 'SS'] as const },
      currency: { label: 'Settlement currency', type: 'select', options: ['UGX', 'KES', 'USD'] as const },
      account_number: { label: 'Collection account', type: 'text' },
      merchant_code: { label: 'Merchant code', type: 'text' },
      callback_url: { label: 'Callback URL', type: 'url' },
    },
    secrets: [
      ['consumer_key', 'kcb_consumer_key'],
      ['consumer_secret', 'kcb_consumer_secret'],
      ['private_key', 'kcb_private_key'],
      ['passphrase', 'kcb_passphrase'],
    ],
  },
  {
    code: 'sms_provider',
    name: 'SMS provider',
    category: 'communication',
    blurb: 'Outbound SMS for notifications, approval reminders and SLA alerts.',
    testable: true,
    config: {
      endpoint: ENDPOINT_FIELD,
      sender_id: { label: 'Sender ID', type: 'text' },
      default_country_code: { label: 'Default country code', type: 'text' },
    },
    secrets: [['api_key', 'sms_api_key']],
  },
  {
    code: 'whatsapp',
    name: 'WhatsApp Business',
    category: 'communication',
    blurb: 'WhatsApp Business messaging for customer and staff notifications.',
    testable: true,
    config: {
      endpoint: ENDPOINT_FIELD,
      phone_number_id: { label: 'Phone number ID', type: 'text' },
      business_account_id: { label: 'Business account ID', type: 'text' },
    },
    secrets: [
      ['access_token', 'whatsapp_access_token'],
      ['app_secret', 'whatsapp_app_secret'],
    ],
  },
  {
    code: 'email_smtp',
    name: 'Email (SMTP)',
    category: 'communication',
    blurb: 'Outbound mail for documents, payslips, statements and notifications.',
    testable: true,
    config: {
      host: { label: 'SMTP host', type: 'text', required: true },
      port: { label: 'SMTP port', type: 'number' },
      secure: { label: 'Implicit TLS', type: 'boolean' },
      from_address: { label: 'From address', type: 'text' },
      from_name: { label: 'From name', type: 'text' },
    },
    secrets: [
      ['username', 'smtp_username'],
      ['password', 'smtp_password'],
    ],
  },
  {
    code: 'payment_gateway',
    name: 'Payment gateway',
    category: 'payments',
    blurb: 'Card and mobile-money collection for online payments.',
    testable: true,
    config: {
      environment: ENVIRONMENT_FIELD,
      endpoint: ENDPOINT_FIELD,
      provider: { label: 'Provider', type: 'text' },
    },
    secrets: [
      ['public_key', 'gateway_public_key'],
      ['secret_key', 'gateway_secret_key'],
      ['webhook_secret', 'gateway_webhook_secret'],
    ],
  },
  {
    code: 'hikvision',
    name: 'Hikvision',
    category: 'other',
    blurb: 'Attendance terminals and access-control event ingestion.',
    testable: true,
    config: {
      endpoint: ENDPOINT_FIELD,
      username: { label: 'Device username', type: 'text' },
      verify_tls: { label: 'Verify TLS certificate', type: 'boolean' },
    },
    secrets: [['password', 'hikvision_password']],
  },
  {
    code: 'pdpo',
    name: 'Personal Data Protection Office',
    category: 'regulatory',
    blurb: 'Data controller registration and breach notification under the Data Protection and Privacy Act.',
    testable: false,
    config: {
      environment: ENVIRONMENT_FIELD,
      registration_number: { label: 'Registration number', type: 'text' },
      registration_expires_on: { label: 'Registration expires on', type: 'text' },
      dpo_name: { label: 'Data protection officer', type: 'text' },
      dpo_email: { label: 'DPO email', type: 'text' },
      dpo_phone: { label: 'DPO phone', type: 'text' },
      portal_base_url: { label: 'Portal base URL', type: 'url' },
    },
    secrets: [['portal_api_key', 'pdpo_portal_api_key']],
  },
  {
    code: 'accounting_bridge',
    name: 'Accounting bridge',
    category: 'accounting',
    blurb: 'External ledger export or synchronisation endpoint.',
    config: {
      endpoint: ENDPOINT_FIELD,
      ledger: { label: 'Target ledger', type: 'text' },
    },
    secrets: [['api_key', 'accounting_api_key']],
  },
];

export const INTEGRATION_REGISTRY: readonly IntegrationDef[] = Object.freeze(INTEGRATION_DEFS);

const REGISTRY_BY_CODE = new Map(INTEGRATION_REGISTRY.map((d) => [d.code, d]));

export function integrationRegistry(): readonly IntegrationDef[] {
  return INTEGRATION_REGISTRY;
}

export function getIntegrationDef(code: string): IntegrationDef {
  const def = REGISTRY_BY_CODE.get(code);
  if (!def) throw notFound('Unknown integration: ' + code);
  return def;
}

function requireCompany(ctx: Ctx): number {
  if (ctx.companyId == null) {
    throw badRequest('An active company context is required to configure integrations');
  }
  return Number(ctx.companyId);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function text(v: unknown, field: string, required = false): string | null {
  if (v === null || v === undefined) {
    if (required) throw badRequest(field + ' is required');
    return null;
  }
  const s = String(v).trim();
  if (s === '') {
    if (required) throw badRequest(field + ' is required');
    return null;
  }
  return s;
}

function bool(v: unknown, dflt: boolean): boolean {
  if (v === null || v === undefined || v === '') return dflt;
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  throw badRequest('Expected a boolean value');
}

/** Coerce one config field against its declared type. */
function coerceField(field: string, def: IntegrationFieldDef, raw: unknown): unknown {
  switch (def.type) {
    case 'boolean':
      return bool(raw, false);
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw badRequest(field + ' must be a number');
      return n;
    }
    case 'select': {
      const s = text(raw, field);
      if (s === null) return null;
      if (def.options && !def.options.includes(s)) {
        throw badRequest(field + ' must be one of: ' + def.options.join(', '));
      }
      return s;
    }
    case 'url': {
      const s = text(raw, field);
      if (s === null) return null;
      if (!/^https?:\/\//i.test(s)) throw badRequest(field + ' must be an http(s) URL');
      return s;
    }
    default:
      return text(raw, field, def.required === true);
  }
}

// ===================== read side =====================

/**
 * Decrypt the secret map.
 *
 * Uses the same SECRET_FIELDS pairing as the writer, so a stored key can only
 * be missed if the registry itself is wrong - which the tests assert.
 */
export function readSecrets(def: IntegrationDef, row: Record<string, unknown> | null) {
  const stored = asRecord(row?.secrets);
  const out: Record<string, string | null> = {};
  for (const [field, storedKey] of def.secrets) {
    const raw = stored[storedKey];
    out[field] = raw === undefined || raw === null || String(raw).length === 0
      ? null
      : decryptSecret(String(raw));
  }
  return out;
}

/** Encrypted-or-not, for the "is a credential set?" indicator. */
function secretPresence(def: IntegrationDef, row: Record<string, unknown> | null) {
  const stored = asRecord(row?.secrets);
  const out: Record<string, boolean> = {};
  for (const [field, storedKey] of def.secrets) {
    const raw = stored[storedKey];
    out[field] = raw !== undefined && raw !== null && String(raw).length > 0;
  }
  return out;
}

/** What an administrator sees: config values, never secret values. */
export async function getIntegration(client: pg.PoolClient, ctx: Ctx, code: string) {
  const def = getIntegrationDef(code);
  const row = await loadRow(client, ctx, code);
  const cfg = asRecord(row?.config);
  const values: Record<string, unknown> = {};
  for (const [field, fieldDef] of Object.entries(def.config)) {
    if (fieldDef.type === 'boolean') values[field] = cfg[field] === undefined ? false : !!cfg[field];
    else values[field] = cfg[field] === undefined ? null : cfg[field];
  }
  return {
    code: def.code,
    name: def.name,
    category: def.category,
    blurb: def.blurb,
    testable: def.testable === true,
    fields: def.config,
    values,
    secrets: secretPresence(def, row),
    secretFields: def.secrets.map(([field]) => field),
    configured: !!row,
    status: row ? row.status : 'DISCONNECTED',
    isActive: row ? row.is_active === true : false,
    lastTestedAt: row ? row.last_tested_at : null,
    health: {
      lastSuccessAt: cfg.last_success_at ?? null,
      lastFailureAt: cfg.last_failure_at ?? null,
      lastError: cfg.last_error ?? null,
    },
  };
}

export async function listIntegrations(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT code FROM company_integrations WHERE tenant_id = $1 AND company_id = $2`,
    [ctx.tenantId ?? null, requireCompany(ctx)]
  );
  const configured = new Set(res.rows.map((r) => String(r.code)));
  return INTEGRATION_REGISTRY.map((def) => ({
    code: def.code,
    name: def.name,
    category: def.category,
    blurb: def.blurb,
    configured: configured.has(def.code),
  }));
}

async function loadRow(client: pg.PoolClient, ctx: Ctx, code: string) {
  getIntegrationDef(code);
  const res = await client.query(
    `SELECT * FROM company_integrations
      WHERE tenant_id = $1 AND company_id = $2 AND code = $3 LIMIT 1`,
    [ctx.tenantId ?? null, requireCompany(ctx), code]
  );
  return res.rows.length > 0 ? (res.rows[0] as Record<string, unknown>) : null;
}

// ===================== write side =====================

/**
 * Save an integration.
 *
 * Config values are merged over what is stored. Secrets are written only when
 * a non-empty value arrives, so a screen that shows blank secret fields cannot
 * blank the credential by omission; clearing is an explicit act via
 * clearSecrets.
 */
export async function saveIntegration(
  client: pg.PoolClient,
  ctx: Ctx,
  code: string,
  body: Record<string, unknown>
) {
  const def = getIntegrationDef(code);
  const before = await loadRow(client, ctx, code);
  const beforeConfig = asRecord(before?.config);
  const beforeSecrets = asRecord(before?.secrets);

  // Config values and credentials may arrive flat, or nested as
  // { values: {...}, secrets: {...} }. Both are merged into the one lookup map
  // the write loop below reads from, because that loop looks for a credential
  // in the same place as a config field: a payload that nested its secrets and
  // was told nothing would look like a successful save that quietly kept the
  // old key, which is the one outcome AC-ORG-010 cannot tolerate.
  const incoming: Record<string, unknown> = {
    ...asRecord(body.values !== undefined ? body.values : body),
    ...asRecord(body.secrets),
  };
  const config: Record<string, unknown> = { ...beforeConfig };

  for (const [field, fieldDef] of Object.entries(def.config)) {
    if (incoming[field] === undefined) continue;
    const value = coerceField(field, fieldDef, incoming[field]);
    if (value === null && fieldDef.required === true) continue;
    config[field] = value;
  }

  // Health is system-written; never let a form overwrite it.
  delete config.last_success_at;
  delete config.last_failure_at;
  delete config.last_error;
  config.last_success_at = beforeConfig.last_success_at ?? null;
  config.last_failure_at = beforeConfig.last_failure_at ?? null;
  config.last_error = beforeConfig.last_error ?? null;

  const secrets: Record<string, unknown> = { ...beforeSecrets };
  const clear = new Set(
    (Array.isArray(body.clearSecrets) ? body.clearSecrets : []).map((s) => String(s))
  );
  const written: string[] = [];
  const cleared: string[] = [];
  for (const [field, storedKey] of def.secrets) {
    const raw = incoming[field];
    const wantsWrite = raw !== undefined && raw !== null && String(raw).length > 0;
    if (clear.has(field)) {
      delete secrets[storedKey];
      cleared.push(field);
      continue;
    }
    if (!wantsWrite) continue;
    secrets[storedKey] = encryptSecret(String(raw));
    written.push(field);
  }

  const status = text(body.status, 'status') ?? (before ? String(before.status) : 'DISCONNECTED');
  if (!(INTEGRATION_STATUSES as readonly string[]).includes(status)) {
    throw badRequest('status must be one of: ' + INTEGRATION_STATUSES.join(', '));
  }

  const name = text(body.name, 'name') ?? def.name;
  const res = await client.query(
    `INSERT INTO company_integrations
        (tenant_id, company_id, category, code, name, description, config, secrets,
         status, is_active, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
     ON CONFLICT (tenant_id, company_id, code)
     DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        config = EXCLUDED.config,
        secrets = EXCLUDED.secrets,
        status = EXCLUDED.status,
        is_active = EXCLUDED.is_active,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
     RETURNING *`,
    [
      ctx.tenantId ?? null, requireCompany(ctx), def.category, def.code, name, def.blurb,
      JSON.stringify(config), JSON.stringify(secrets),
      status,
      body.is_active === undefined && body.isActive === undefined
        ? (before ? before.is_active === true : true)
        : bool(body.is_active ?? body.isActive, true),
      ctx.userId ?? null,
    ]
  );

  // The audit entry records which credentials changed, never their values.
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'organisation.settings.integration',
    recordId: Number(res.rows[0].id),
    recordCode: def.code,
    oldValues: before,
    newValues: {
      code: def.code,
      category: def.category,
      name,
      status,
      config,
      secrets_changed: written,
      secrets_cleared: cleared,
    },
    metadata: { secretsWritten: written, secretsCleared: cleared },
  });

  return getIntegration(client, ctx, code);
}

/**
 * Record the outcome of a connection test.
 *
 * Health is written from exactly one place so the last-success and last-failure
 * stamps cannot fight each other, and an error string is truncated rather than
 * allowed to bloat the row.
 */
export async function recordIntegrationTest(
  client: pg.PoolClient,
  ctx: Ctx,
  code: string,
  outcome: { ok: boolean; detail?: string | null }
) {
  const def = getIntegrationDef(code);
  const row = await loadRow(client, ctx, code);
  if (!row) throw badRequest('Configure the integration before testing it');
  const config = asRecord(row.config);
  const now = new Date().toISOString();
  const detail = outcome.detail == null ? null : String(outcome.detail).slice(0, 2000);
  config.last_success_at = outcome.ok ? now : (config.last_success_at ?? null);
  config.last_failure_at = outcome.ok ? (config.last_failure_at ?? null) : now;
  config.last_error = outcome.ok ? null : detail;

  const res = await client.query(
    `UPDATE company_integrations
        SET config = $4::jsonb, status = $5, last_tested_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND company_id = $2 AND code = $3
      RETURNING *`,
    [
      ctx.tenantId ?? null, requireCompany(ctx), code,
      JSON.stringify(config),
      outcome.ok ? 'CONNECTED' : 'ERROR',
    ]
  );
  if (res.rows.length === 0) throw notFound('No such integration: ' + code);

  await client.query(
    `INSERT INTO integration_logs (tenant_id, integration, event, direction, status, request, response)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [
      ctx.tenantId ?? null, def.code, 'connection_test', 'OUTBOUND',
      outcome.ok ? 'SUCCESS' : 'FAILED',
      JSON.stringify({ code: def.code, environment: config.environment ?? null }),
      JSON.stringify({ ok: outcome.ok, detail }),
    ]
  );

  await logAudit(client, ctx, {
    action: 'test',
    resource: 'organisation.settings.integration',
    recordId: Number(res.rows[0].id),
    recordCode: def.code,
    newValues: { status: res.rows[0].status, ok: outcome.ok, detail },
  });

  return getIntegration(client, ctx, code);
}

export async function listIntegrationLogs(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { code?: string | null; limit?: number } = {}
) {
  const limit = Math.min(Math.max(Number(opts.limit ?? 50) || 50, 1), 200);
  const res = await client.query(
    `SELECT * FROM integration_logs
      WHERE tenant_id = $1 AND ($2::text IS NULL OR integration = $2)
      ORDER BY created_at DESC LIMIT $3`,
    [ctx.tenantId ?? null, opts.code ?? null, limit]
  );
  return res.rows.map((r) => toCamelRow(r));
}
