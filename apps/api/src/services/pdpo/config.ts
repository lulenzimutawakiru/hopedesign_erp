/**
 * Personal Data Protection Office (PDPO) integration configuration (per company).
 *
 * PDPO is the Ugandan data-protection regulator (Data Protection and Privacy
 * Act, 2019). Unlike the bank feeds this integration has no inbound socket: it
 * is a compliance register and a filing ledger, and what an operator configures
 * here is the identity the company files under and the statutory windows its
 * clocks run on.
 *
 * Like every other external system it is a row in `company_integrations`
 * (category `regulatory`, code `PDPO`), so there is no parallel settings table
 * and "what does this company report to a regulator?" stays a query the
 * database can answer. Non-secret settings live in `config`; credentials live
 * in `secrets` and are encrypted at rest through the shared company-config
 * cipher.
 *
 * Nothing here is returned to a client unprojected. The status projection
 * exposes presence flags only - never the portal API key - because an
 * administrator needs to know that a credential is loaded, not what it is.
 *
 * On the two statutory windows. The Regulations prescribe the periods, and 72
 * hours for a breach and 30 days for a data subject request are the defaults
 * this installation starts from - not constants. Both are configurable here and
 * both are copied onto each register row as it is written, so an installation
 * operating under a different regime changes configuration rather than code,
 * and every row records the window that was actually applied to it.
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest } from '../../utils.js';
import { auditConfig, decryptSecret, encryptSecret } from '../companyConfig.js';

export const PDPO_CODE = 'PDPO';
export const PDPO_CATEGORY = 'regulatory';

/** The window the Regulations prescribe for notifying a breach. */
export const DEFAULT_BREACH_NOTIFICATION_HOURS = 72;
/** The window the Act allows for answering a data subject request. */
export const DEFAULT_SUBJECT_REQUEST_DAYS = 30;

/**
 * How close to expiry a registration has to be before it is called EXPIRING.
 * Long enough to renew without a scramble, short enough that a date a month
 * away is not reported as a problem.
 */
const REGISTRATION_EXPIRY_WARNING_DAYS = 60;

export type PdpoEnvironment = 'SANDBOX' | 'PRODUCTION';

/**
 * Where the company stands with the Office, derived from the recorded
 * certificate rather than asserted. UNREGISTERED is the honest default: an
 * integration with no number recorded has not been shown to be registered, and
 * saying so is more useful than assuming the best.
 */
export type PdpoRegistrationState = 'UNREGISTERED' | 'REGISTERED' | 'EXPIRING' | 'EXPIRED';

export interface PdpoIntegrationRow {
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

export interface PdpoConfig {
  environment: PdpoEnvironment;
  registrationNumber: string | null;
  registrationExpiresOn: string | null;
  dpoName: string | null;
  dpoEmail: string | null;
  dpoPhone: string | null;
  portalBaseUrl: string | null;
  breachNotificationHours: number;
  subjectRequestDays: number;
  /** Unused today: the Office publishes no submission API. */
  portalApiKey: string | null;
}

/** Everything an administrator may see. Never contains secret material. */
export interface PdpoConfigView {
  configured: boolean;
  integrationId: number | null;
  name: string | null;
  status: string;
  isActive: boolean;
  environment: PdpoEnvironment;
  registrationNumber: string | null;
  registrationExpiresOn: string | null;
  registrationState: PdpoRegistrationState;
  /** Whole days until the certificate lapses; negative once it has. */
  registrationDaysRemaining: number | null;
  dpoName: string | null;
  dpoEmail: string | null;
  dpoPhone: string | null;
  portalBaseUrl: string | null;
  breachNotificationHours: number;
  subjectRequestDays: number;
  portalApiKeyPresent: boolean;
  lastTestedAt: string | null;
  /** True only when a filing could actually be prepared and attributed. */
  readyToFile: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Trim a configured value; blank becomes null so a cleared field really clears. */
const cleanKey = (value: unknown): string | null => {
  const s = String(value ?? '').trim();
  return s.length === 0 ? null : s;
};

const pick = (bag: Record<string, unknown>, key: string): string | null => cleanKey(bag[key]);

/** A positive integer inside a range, or the fallback when the field is blank. */
const pickInt = (bag: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number => {
  const raw = cleanKey(bag[key]);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
};

/** ISO day count from `YYYY-MM-DD` to today, using UTC midnight on both ends. */
const daysUntil = (isoDate: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const parsed = new Date(target);
  if (Number.isNaN(parsed.getTime())) return null;
  // Reject dates the Date constructor silently rolls over (2026-02-31).
  if (parsed.getUTCMonth() !== Number(m[2]) - 1 || parsed.getUTCDate() !== Number(m[3])) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - todayUtc) / 86_400_000);
};

/**
 * Classify a recorded registration. `EXPIRING` is not a status the Office has;
 * it is the one this ERP needs, because a lapsed registration is a compliance
 * failure that should be visible before the date rather than after it.
 */
export function registrationState(
  registrationNumber: string | null,
  registrationExpiresOn: string | null
): PdpoRegistrationState {
  if (!registrationNumber) return 'UNREGISTERED';
  if (!registrationExpiresOn) return 'REGISTERED';
  const days = daysUntil(registrationExpiresOn);
  if (days === null) return 'REGISTERED';
  if (days < 0) return 'EXPIRED';
  if (days <= REGISTRATION_EXPIRY_WARNING_DAYS) return 'EXPIRING';
  return 'REGISTERED';
}

/** The single PDPO integration row for the acting company, if it exists. */
export async function getPdpoIntegration(
  client: pg.PoolClient,
  ctx: Ctx
): Promise<PdpoIntegrationRow | null> {
  if (ctx.companyId == null) return null;
  const res = await client.query(
    `SELECT id, tenant_id, company_id, name, status, is_active, config, secrets, last_tested_at
       FROM company_integrations
      WHERE company_id = $1 AND code = $2 AND category = $3
      LIMIT 1`,
    [ctx.companyId, PDPO_CODE, PDPO_CATEGORY]
  );
  return res.rows.length > 0 ? (res.rows[0] as PdpoIntegrationRow) : null;
}

/**
 * Decode a stored row into its usable form. The portal key is decrypted here
 * and only here; a caller that intends to return anything to a client must use
 * pdpoConfigView instead.
 */
export function readPdpoConfig(row: PdpoIntegrationRow | null): PdpoConfig {
  const cfg = asRecord(row?.config);
  const sec = asRecord(row?.secrets);
  const environment = (pick(cfg, 'environment') ?? 'SANDBOX').toUpperCase();
  return {
    environment: environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
    registrationNumber: pick(cfg, 'registration_number'),
    registrationExpiresOn: pick(cfg, 'registration_expires_on'),
    dpoName: pick(cfg, 'dpo_name'),
    dpoEmail: pick(cfg, 'dpo_email'),
    dpoPhone: pick(cfg, 'dpo_phone'),
    portalBaseUrl: pick(cfg, 'portal_base_url'),
    breachNotificationHours: pickInt(
      cfg,
      'breach_notification_hours',
      DEFAULT_BREACH_NOTIFICATION_HOURS,
      1,
      720
    ),
    subjectRequestDays: pickInt(cfg, 'subject_request_days', DEFAULT_SUBJECT_REQUEST_DAYS, 1, 365),
    portalApiKey: decryptSecret(pick(sec, 'portal_api_key')),
  };
}

/** Safe projection of the integration for an administrator. */
export function pdpoConfigView(row: PdpoIntegrationRow | null): PdpoConfigView {
  const cfg = readPdpoConfig(row);
  return {
    configured: !!row,
    integrationId: row ? Number(row.id) : null,
    name: row?.name ?? null,
    status: row?.status ?? 'DISCONNECTED',
    isActive: row?.is_active ?? false,
    environment: cfg.environment,
    registrationNumber: cfg.registrationNumber,
    registrationExpiresOn: cfg.registrationExpiresOn,
    registrationState: registrationState(cfg.registrationNumber, cfg.registrationExpiresOn),
    registrationDaysRemaining: cfg.registrationExpiresOn ? daysUntil(cfg.registrationExpiresOn) : null,
    dpoName: cfg.dpoName,
    dpoEmail: cfg.dpoEmail,
    dpoPhone: cfg.dpoPhone,
    portalBaseUrl: cfg.portalBaseUrl,
    breachNotificationHours: cfg.breachNotificationHours,
    subjectRequestDays: cfg.subjectRequestDays,
    portalApiKeyPresent: !!cfg.portalApiKey,
    lastTestedAt: row?.last_tested_at ?? null,
    // A filing has to say who made it and under which registration, so both
    // halves have to be present before the register is worth filing from.
    readyToFile: !!cfg.registrationNumber && !!cfg.dpoEmail && !!cfg.portalBaseUrl,
  };
}

export interface PdpoConfigPatch {
  environment?: string;
  registrationNumber?: string | null;
  registrationExpiresOn?: string | null;
  dpoName?: string | null;
  dpoEmail?: string | null;
  dpoPhone?: string | null;
  portalBaseUrl?: string | null;
  breachNotificationHours?: number | string | null;
  subjectRequestDays?: number | string | null;
  portalApiKey?: string | null;
  isActive?: boolean;
}

/**
 * Patch field to the name it is encrypted under in the secrets bag. The stored
 * name is snake_case like every other key in this row, and it has to be the
 * name readPdpoConfig looks up: a credential written under one name and read
 * back under another is stored correctly and still reported as absent.
 */
const SECRET_FIELDS: ReadonlyArray<[field: keyof PdpoConfigPatch, stored: string]> = [
  ['portalApiKey', 'portal_api_key'],
];

/**
 * Apply an administrator's changes to the integration.
 *
 * The windows are validated here as well as by the CHECK on each register row,
 * because a window that is rejected at configuration time is far easier to
 * understand than one rejected hours later when a breach is being filed. The
 * audit record carries the before/after projection - presence flags, never the
 * portal key.
 */
export async function updatePdpoConfig(
  client: pg.PoolClient,
  ctx: Ctx,
  patch: PdpoConfigPatch
): Promise<PdpoConfigView> {
  const tenantId = ctx.tenantId ?? null;
  const companyId = ctx.companyId ?? null;
  if (tenantId === null || companyId === null) {
    throw badRequest('A company context is required to configure PDPO');
  }

  const existing = await getPdpoIntegration(client, ctx);
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

  applyText(cfg, 'registration_number', patch.registrationNumber);
  applyText(cfg, 'dpo_name', patch.dpoName);
  applyText(cfg, 'dpo_phone', patch.dpoPhone);

  if (patch.dpoEmail !== undefined) {
    const email = cleanKey(patch.dpoEmail);
    if (email === null) delete cfg.dpo_email;
    else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) cfg.dpo_email = email;
    else throw badRequest('dpoEmail must be an email address');
  }

  if (patch.portalBaseUrl !== undefined) {
    const url = cleanKey(patch.portalBaseUrl);
    if (url === null) delete cfg.portal_base_url;
    else if (/^https?:\/\//i.test(url)) cfg.portal_base_url = url;
    else throw badRequest('portalBaseUrl must be an http(s) URL');
  }

  if (patch.registrationExpiresOn !== undefined) {
    const raw = cleanKey(patch.registrationExpiresOn);
    if (raw === null) delete cfg.registration_expires_on;
    else if (daysUntil(raw) === null) throw badRequest('registrationExpiresOn must be a YYYY-MM-DD date');
    else cfg.registration_expires_on = raw;
  }

  if (patch.breachNotificationHours !== undefined) {
    const raw = cleanKey(patch.breachNotificationHours);
    if (raw === null) {
      delete cfg.breach_notification_hours;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 720) {
        throw badRequest('breachNotificationHours must be a whole number of hours between 1 and 720');
      }
      cfg.breach_notification_hours = n;
    }
  }

  if (patch.subjectRequestDays !== undefined) {
    const raw = cleanKey(patch.subjectRequestDays);
    if (raw === null) {
      delete cfg.subject_request_days;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 365) {
        throw badRequest('subjectRequestDays must be a whole number of days between 1 and 365');
      }
      cfg.subject_request_days = n;
    }
  }

  for (const [field, secretKey] of SECRET_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    const clean = cleanKey(value);
    if (clean === null) delete sec[secretKey];
    else sec[secretKey] = encryptSecret(clean);
  }

  const isActive = patch.isActive === undefined ? existing?.is_active ?? true : patch.isActive === true;
  const name = existing?.name ?? 'Personal Data Protection Office';
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
      tenantId, companyId, PDPO_CATEGORY, PDPO_CODE, name,
      JSON.stringify(cfg), JSON.stringify(sec), status, isActive, ctx.userId ?? null,
    ]
  );

  const saved = await getPdpoIntegration(client, ctx);
  await auditConfig(
    client,
    ctx,
    'update',
    'compliance.pdpo.config',
    saved ? Number(saved.id) : null,
    existing ? (pdpoConfigView(existing) as unknown as Record<string, unknown>) : null,
    saved ? (pdpoConfigView(saved) as unknown as Record<string, unknown>) : null,
    { code: PDPO_CODE, category: PDPO_CATEGORY }
  );
  return pdpoConfigView(saved);
}

/** Record the outcome of a configuration self-test. */
export async function markPdpoTested(
  client: pg.PoolClient,
  ctx: Ctx,
  status: 'CONNECTED' | 'ERROR' | 'TESTING'
): Promise<void> {
  if (ctx.companyId == null) return;
  await client.query(
    `UPDATE company_integrations
        SET status = $1, last_tested_at = now(), updated_at = now()
      WHERE company_id = $2 AND code = $3 AND category = $4`,
    [status, ctx.companyId, PDPO_CODE, PDPO_CATEGORY]
  );
}
