/**
 * Personal Data Protection Office (PDPO) operations surface.
 *
 * PDPO is the Ugandan data-protection regulator (Data Protection and Privacy
 * Act, 2019) and this module is the company's side of the relationship with it:
 * the accountability register, the consent register, the data subject rights
 * queue, the breach register and the filing ledger. services/pdpo/config.ts owns
 * the identity the company files under; this module owns the records.
 *
 * There is no inbound socket here and no money moves. Every record in this file
 * is written by a named human holding a named permission, which is why each
 * register carries created_by/updated_by/handled_by/reported_by and why every
 * change lands in audit_logs through the row triggers created in 0163.
 *
 * Two rules shape the code more than any other:
 *
 *   1. The statutory clocks belong to the database, not to the caller. due_at
 *      and notification_due_at are stamped by BEFORE triggers in 0163 from the
 *      window carried on the row, and late_notification is derived there too.
 *      This module therefore never sends those columns: a service that could
 *      set its own deadline is a service that could quietly miss one.
 *
 *   2. The register has to stay internally consistent, so each transition is
 *      computed here rather than accepted from the client. Completing a
 *      subject request stamps completed_at, refusing one records a reason,
 *      withdrawing a consent stamps withdrawn_at, and whether a transfer is
 *      cross-border is decided by whether destinations were actually named.
 *      The CHECK constraints in 0163 are the backstop, not the first line.
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, conflict, notFound } from '../../utils.js';
import { auditConfig } from '../companyConfig.js';
import {
  PdpoConfigPatch,
  PdpoConfigView,
  PDPO_CODE,
  getPdpoIntegration,
  markPdpoTested,
  pdpoConfigView,
  readPdpoConfig,
  updatePdpoConfig,
} from './config.js';

// ---------------------------------------------------------------- vocabularies
// Mirrored from the CHECK constraints in 0163. They are repeated in TypeScript
// so a caller gets "severity must be one of ..." instead of a foreign-looking
// constraint violation, and so the registers cannot drift into free text.

const LAWFUL_BASES = [
  'CONSENT', 'CONTRACT', 'LEGAL_OBLIGATION', 'VITAL_INTERESTS', 'PUBLIC_TASK', 'LEGITIMATE_INTERESTS',
] as const;

const DATA_CATEGORIES = [
  'IDENTIFIERS', 'CONTACT', 'FINANCIAL', 'EMPLOYMENT', 'HEALTH', 'BIOMETRIC', 'GENETIC',
  'CRIMINAL', 'CHILDREN', 'LOCATION', 'BEHAVIOURAL', 'TECHNICAL', 'SPECIAL_CATEGORY', 'OTHER',
] as const;

/** Subject categories as the RoPA states them (the register's own vocabulary). */
const ACTIVITY_SUBJECTS = [
  'CUSTOMERS', 'EMPLOYEES', 'APPLICANTS', 'SUPPLIERS', 'CONTRACTORS',
  'NEXT_OF_KIN', 'WEBSITE_VISITORS', 'PATIENTS', 'STUDENTS', 'OTHER',
] as const;

/** Subject types as the consent and data subject request registers state them. */
const DATA_SUBJECT_TYPES = [
  'CUSTOMER', 'EMPLOYEE', 'APPLICANT', 'SUPPLIER_CONTACT', 'WEBSITE_VISITOR', 'OTHER',
] as const;

const ACTIVITY_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED'] as const;
const CONSENT_STATUSES = ['GRANTED', 'WITHDRAWN', 'EXPIRED'] as const;
const CONSENT_CHANNELS = ['WEB_FORM', 'SIGNED_FORM', 'EMAIL', 'PHONE', 'PORTAL', 'IN_PERSON'] as const;
const CONSENT_ACTIVE_STATUS = 'GRANTED';

const REQUEST_TYPES = ['ACCESS', 'CORRECTION', 'ERASURE', 'OBJECTION', 'RESTRICTION', 'PORTABILITY'] as const;
const REQUEST_STATUSES = [
  'RECEIVED', 'IN_PROGRESS', 'AWAITING_SUBJECT', 'COMPLETED', 'REFUSED', 'EXTENDED',
] as const;
/** Request statuses that still have a clock running against them. */
const REQUEST_OPEN_STATUSES = ['RECEIVED', 'IN_PROGRESS', 'AWAITING_SUBJECT', 'EXTENDED'] as const;
/** Request statuses that mean the clock has stopped. */
const REQUEST_CLOSED_STATUSES = ['COMPLETED', 'REFUSED'] as const;

const BREACH_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const BREACH_STATUSES = ['OPEN', 'CONTAINED', 'REPORTED', 'NOT_NOTIFIABLE', 'CLOSED'] as const;
/** Breach statuses where the notification clock is still running. */
const BREACH_OPEN_STATUSES = ['OPEN', 'CONTAINED'] as const;

const SUBMISSION_TYPES = [
  'REGISTRATION', 'RENEWAL', 'BREACH_NOTIFICATION', 'SUBJECT_REQUEST_RESPONSE',
  'ANNUAL_RETURN', 'CONSENT_WITHDRAWAL_REPORT', 'OTHER',
] as const;
const SUBMISSION_STATUSES = ['DRAFT', 'FILED', 'ACKNOWLEDGED', 'REJECTED'] as const;
const SUBMISSION_CHANNELS = ['PORTAL', 'EMAIL', 'POST', 'IN_PERSON'] as const;
/** The registers a filing may point at, matching pdpo_submissions_related_table. */
const RELATED_TABLES = [
  'pdpo_breaches', 'pdpo_subject_requests', 'pdpo_processing_activities', 'pdpo_consents',
] as const;

/** PostgreSQL's unique-violation SQLSTATE, raised by uq_pdpo_consents_active. */
const UNIQUE_VIOLATION = '23505';

type Row = Record<string, unknown>;

// ------------------------------------------------------------------- primitives

const requireCompany = (ctx: Ctx): number => {
  if (ctx.companyId == null) throw badRequest('A company context is required');
  return ctx.companyId;
};

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const bool = (v: unknown, fallback = false): boolean => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
};

/** ISO instant, whatever pg handed us (a Date, or a string from a cast). */
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** An instant supplied by a client, rejected rather than silently coerced. */
const instant = (v: unknown, label: string): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) throw badRequest(`${label} must be a date or timestamp`);
  return d.toISOString();
};

const jsonObject = (v: unknown, label: string): Record<string, unknown> => {
  if (v === null || v === undefined || v === '') return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw badRequest(`${label} must be a JSON object`);
    }
  }
  throw badRequest(`${label} must be a JSON object`);
};

const stringArray = (v: unknown): string[] => {
  if (v === null || v === undefined || v === '') return [];
  const raw = Array.isArray(v) ? v : String(v).split(',');
  const out: string[] = [];
  for (const item of raw) {
    const s = String(item ?? '').trim();
    if (s !== '' && !out.includes(s)) out.push(s);
  }
  return out;
};

/** One of a fixed vocabulary, uppercased, with a clear rejection. */
const oneOf = <T extends string>(
  v: unknown,
  allowed: readonly T[],
  label: string,
  fallback?: T
): T => {
  const raw = v === null || v === undefined || v === '' ? null : String(v).trim().toUpperCase();
  if (raw === null) {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${label} is required`);
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    throw badRequest(`${label} must be one of ${allowed.join(', ')}`);
  }
  return raw as T;
};

/**
 * The same membership test as oneOf, but without folding the case. What a
 * filing points at is a PostgreSQL table name, not a vocabulary on the wire,
 * so upper-casing the caller's value can never match one and every filing
 * that named the row it was about would be refused.
 */
const oneOfExact = <T extends string>(
  v: unknown,
  allowed: readonly T[],
  label: string
): T => {
  const raw = v === null || v === undefined || v === '' ? null : String(v).trim();
  if (raw === null) {
    throw badRequest(`${label} is required`);
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    throw badRequest(`${label} must be one of ${allowed.join(', ')}`);
  }
  return raw as T;
};

/** A vocabulary from a list or comma-separated string, deduplicated. */
const manyOf = <T extends string>(v: unknown, allowed: readonly T[], label: string): T[] => {
  const out: T[] = [];
  for (const item of stringArray(v).map((s) => s.toUpperCase())) {
    if (!(allowed as readonly string[]).includes(item)) {
      throw badRequest(`${label} must contain only ${allowed.join(', ')}`);
    }
    if (!out.includes(item as T)) out.push(item as T);
  }
  return out;
};

const requiredText = (v: unknown, label: string, max = 400): string => {
  const s = String(v ?? '').trim();
  if (s === '') throw badRequest(`${label} is required`);
  if (s.length > max) throw badRequest(`${label} must be ${max} characters or fewer`);
  return s;
};

const integer = (v: unknown, label: string, fallback: number, min: number, max: number): number => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${label} must be a whole number between ${min} and ${max}`);
  }
  return n;
};

const pageSize = (v: unknown): number => Math.min(Math.max(num(v) ?? 50, 1), 200);
const pageOffset = (v: unknown): number => Math.max(num(v) ?? 0, 0);

/**
 * Allocate the next register reference, transaction-safely.
 *
 * The shared number_sequences table is used directly rather than the
 * allocateDocNo() helper, because that helper resolves a
 * document_numbering_rules row per document type and these are statutory
 * register references rather than operator-configurable documents: the format
 * is fixed, and a company that renamed its invoices should not thereby change
 * what a breach notification is called. ON CONFLICT ... RETURNING is what makes
 * this safe under concurrency.
 */
async function allocateReference(
  client: pg.PoolClient,
  ctx: Ctx,
  kind: string,
  prefix: string
): Promise<string> {
  const companyId = requireCompany(ctx);
  const year = new Date().getFullYear();
  const res = await client.query<{ last_seq: string | number }>(
    `INSERT INTO number_sequences (tenant_id, seq_key, doc_year, last_seq)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (tenant_id, seq_key, doc_year)
     DO UPDATE SET last_seq = number_sequences.last_seq + 1, updated_at = now()
     RETURNING last_seq`,
    [ctx.tenantId ?? null, `${PDPO_CODE}:${kind}:${companyId}`, year]
  );
  const seq = Number(res.rows[0]?.last_seq ?? 1);
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

/** Read one register row, or fail closed: a row we cannot see does not exist. */
async function loadRow(
  client: pg.PoolClient,
  table: string,
  companyId: number,
  id: number,
  label: string
): Promise<Row> {
  if (!Number.isInteger(id) || id <= 0) throw badRequest(`${label} id is required`);
  const res = await client.query(
    `SELECT * FROM ${table} WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  if (res.rows.length === 0) throw notFound(`${label} not found`);
  return res.rows[0] as Row;
}

/**
 * Turn a 23505 from uq_pdpo_consents_active into something an operator can act
 * on. The index is the invariant - one live consent per subject and purpose -
 * so the message says which subject and purpose collided.
 */
const isDuplicateConsent = (err: unknown): boolean =>
  (err as { code?: string } | null)?.code === UNIQUE_VIOLATION;

// ---------------------------------------------- helpers shared by the registers
/**
 * A compile-time vocabulary rendered as a SQL literal list.
 *
 * Only ever fed from the constants at the top of this file - never from a
 * request body - so an IN (...) clause is built from the same list the
 * TypeScript checks against and the two cannot drift apart.
 */
const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

/** Whole days from now until an instant, negative once it has passed. */
const daysUntil = (isoInstant: string | null): number | null => {
  if (isoInstant === null) return null;
  const t = new Date(isoInstant).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
};

/** Hours from now until an instant, negative once it has passed. */
const hoursUntil = (isoInstant: string | null): number | null => {
  if (isoInstant === null) return null;
  const t = new Date(isoInstant).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round(((t - Date.now()) / 3_600_000) * 10) / 10;
};
// ------------------------------------------------------------------ config
/**
 * The integration as the compliance workspace reads it. Warnings are computed
 * on the way out rather than stored, so a screen can explain what is missing
 * instead of only showing a blank field.
 */
export async function pdpoConfig(client: pg.PoolClient, ctx: Ctx): Promise<PdpoConfigView> {
  const row = await getPdpoIntegration(client, ctx);
  return pdpoConfigView(row);
}

/** Optional text in the shape the config layer expects (undefined = untouched). */
const optionalText = (v: unknown): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/**
 * Project an operator's payload onto the patch the config layer accepts.
 *
 * Only keys actually present are carried across: a PATCH that omits the DPO
 * email must leave the stored one alone, and a field sent as an empty string
 * must clear it. That distinction is the whole reason this is not a spread.
 */
export function pdpoConfigPatchFrom(body: Record<string, unknown>): PdpoConfigPatch {
  const patch: PdpoConfigPatch = {};
  if (body.environment !== undefined) {
    patch.environment = String(body.environment ?? '').trim().toUpperCase();
  }
  for (const field of [
    'registrationNumber', 'registrationExpiresOn', 'dpoName', 'dpoEmail', 'dpoPhone',
    'portalBaseUrl', 'portalApiKey',
  ] as const) {
    const value = optionalText(body[field]);
    if (value !== undefined) patch[field] = value;
  }
  for (const field of ['breachNotificationHours', 'subjectRequestDays'] as const) {
    const raw = optionalText(body[field]);
    if (raw !== undefined) patch[field] = raw;
  }
  if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;
  return patch;
}

export interface PdpoConfigSaveResult {
  config: PdpoConfigView;
  warnings: string[];
}

/**
 * What still has to be true before a filing could be prepared on the company's
 * behalf. A missing registration number means the company is not (or is not
 * recorded as) registered; a missing officer is a statutory appointment the Act
 * requires. These are warnings rather than refusals: an unregistered controller
 * still has to keep a breach register.
 */
function configWarnings(config: PdpoConfigView): string[] {
  const warnings: string[] = [];
  if (config.integrationId === null) {
    warnings.push('No PDPO integration row exists for this company yet. Save the form to create it.');
  }
  if (!config.registrationNumber) {
    warnings.push('No registration number is recorded, so a filing cannot be attributed to a certificate.');
  }
  if (config.registrationState === 'EXPIRED') {
    warnings.push(`The registration lapsed on ${config.registrationExpiresOn}. Renew before the next annual return.`);
  } else if (config.registrationState === 'EXPIRING') {
    warnings.push(
      `The registration expires on ${config.registrationExpiresOn} (${config.registrationDaysRemaining} days).`
    );
  }
  if (!config.dpoEmail) {
    warnings.push(
      'No Data Protection Officer email is recorded. The Act requires a designated officer the Office can reach.'
    );
  }
  return warnings;
}

/** Save configuration and report what is still missing. */
export async function updatePdpoFromPatch(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<PdpoConfigSaveResult> {
  const config = await updatePdpoConfig(client, ctx, pdpoConfigPatchFrom(body));
  return { config, warnings: configWarnings(config) };
}

export interface PdpoConnectionCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** True when a failure here means a filing could not be attributed. */
  critical: boolean;
}

export interface PdpoConnectionTestResult {
  ok: boolean;
  status: 'CONNECTED' | 'ERROR';
  testedAt: string;
  checks: PdpoConnectionCheck[];
  config: PdpoConfigView;
}

/** A single count from a counting query. */
async function scalar(client: pg.PoolClient, sql: string, params: unknown[]): Promise<number> {
  const res = await client.query<{ c: string | number }>(sql, params);
  return Number(res.rows[0]?.c ?? 0);
}

/**
 * Confirm the register is in a state where a filing could actually be prepared
 * and attributed.
 *
 * There is no endpoint to knock on: the Office publishes no submission API, and
 * a request we are not onboarded to send would prove nothing except that it can
 * be refused. What the test therefore proves is everything that would make a
 * filing unattributable - whether the integration exists and is switched on,
 * whether a certificate is on record and in date, whether an officer is named
 * to sign, whether the statutory windows are set, and whether the accountability
 * register has anything in it. The outcome is written onto the integration row
 * and into the audit trail.
 */
export async function testPdpoConnection(
  client: pg.PoolClient,
  ctx: Ctx
): Promise<PdpoConnectionTestResult> {
  const companyId = requireCompany(ctx);
  const row = await getPdpoIntegration(client, ctx);
  const view = pdpoConfigView(row);
  const stored = readPdpoConfig(row);
  const activityCount = await scalar(
    client,
    `SELECT count(*)::int AS c FROM pdpo_processing_activities
      WHERE company_id = $1 AND status <> 'RETIRED'`,
    [companyId]
  );

  const checks: PdpoConnectionCheck[] = [
    {
      key: 'integration',
      label: 'Integration record',
      ok: view.configured && view.isActive,
      detail: !view.configured
        ? 'No PDPO integration exists for this company yet'
        : view.isActive
          ? `Active for company ${companyId}`
          : 'The integration exists but is switched off, so no filing can be attributed',
      critical: true,
    },
    {
      key: 'registration',
      label: 'Certificate of registration',
      ok: view.registrationNumber !== null && view.registrationState !== 'EXPIRED',
      detail:
        view.registrationNumber === null
          ? 'No certificate number is recorded'
          : view.registrationState === 'EXPIRED'
            ? `Certificate ${view.registrationNumber} lapsed on ${view.registrationExpiresOn}`
            : view.registrationState === 'EXPIRING'
              ? `Certificate ${view.registrationNumber} expires in ${view.registrationDaysRemaining} days`
              : `Certificate ${view.registrationNumber} on record`,
      critical: true,
    },
    {
      key: 'officer',
      label: 'Data Protection Officer',
      ok: view.dpoEmail !== null,
      detail:
        view.dpoEmail ?? 'No officer email is recorded, so the Office has no address to correspond with',
      critical: true,
    },
    {
      key: 'clock',
      label: 'Statutory windows',
      ok: stored.breachNotificationHours > 0 && stored.subjectRequestDays > 0,
      detail: `Breach notification ${stored.breachNotificationHours} h, subject request ${stored.subjectRequestDays} days`,
      critical: true,
    },
    {
      key: 'register',
      label: 'Record of processing activities',
      ok: activityCount > 0,
      detail:
        activityCount > 0
          ? `${activityCount} active processing ${activityCount === 1 ? 'activity' : 'activities'} on the register`
          : 'The accountability register is empty; the Act expects a record of processing to exist',
      critical: false,
    },
    {
      key: 'portal',
      label: 'Filing channel',
      ok: view.portalBaseUrl !== null,
      detail:
        view.portalBaseUrl ??
        'No portal address recorded. A filing is still recorded here, but the address is worth having to hand.',
      critical: false,
    },
  ];

  const ok = checks.every((c) => !c.critical || c.ok);
  await markPdpoTested(client, ctx, ok ? 'CONNECTED' : 'ERROR');
  await auditConfig(
    client,
    ctx,
    'test',
    'compliance.pdpo.config',
    view.integrationId,
    null,
    { ok, checks: checks.map((c) => ({ key: c.key, ok: c.ok })) },
    { code: PDPO_CODE }
  );

  const saved = await getPdpoIntegration(client, ctx);
  return {
    ok,
    status: ok ? 'CONNECTED' : 'ERROR',
    testedAt: new Date().toISOString(),
    checks,
    config: pdpoConfigView(saved),
  };
}

// ---------------------------------------------------- record of processing (RoPA)
/**
 * A nullable column that is only touched when the key appears in the payload.
 * `undefined` means "leave what is stored alone"; an explicit null means
 * "clear it". Without this distinction a PATCH that only renamed an activity
 * would silently wipe its retention period.
 */
const patchable = <T>(
  body: Record<string, unknown>,
  key: string,
  parse: (v: unknown) => T | null
): T | null | undefined => {
  if (!(key in body)) return undefined;
  return parse(body[key]);
};

/** A PostgreSQL text[] as JS sees it (an array, or nothing). */
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

export interface ProcessingActivityView {
  id: number;
  code: string;
  name: string;
  purpose: string;
  lawfulBasis: string;
  dataCategories: string[];
  subjectCategories: string[];
  recipients: string | null;
  retentionPeriod: string | null;
  crossBorder: boolean;
  transferCountries: string[];
  transferSafeguards: string | null;
  securityMeasures: string | null;
  dpiaCompleted: boolean;
  ownerUserId: number | null;
  status: string;
  lastReviewedAt: string | null;
  reviewDueAt: string | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function processingActivityView(row: Row): ProcessingActivityView {
  return {
    id: Number(row.id),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    purpose: String(row.purpose ?? ''),
    lawfulBasis: String(row.lawful_basis ?? ''),
    dataCategories: stringList(row.data_categories),
    subjectCategories: stringList(row.subject_categories),
    recipients: text(row.recipients),
    retentionPeriod: text(row.retention_period),
    crossBorder: row.cross_border === true,
    transferCountries: stringList(row.transfer_countries),
    transferSafeguards: text(row.transfer_safeguards),
    securityMeasures: text(row.security_measures),
    dpiaCompleted: row.dpia_completed === true,
    ownerUserId: num(row.owner_user_id),
    status: String(row.status ?? ''),
    lastReviewedAt: iso(row.last_reviewed_at),
    reviewDueAt: iso(row.review_due_at),
    createdBy: num(row.created_by),
    updatedBy: num(row.updated_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * The cross-border pair, decided here rather than accepted from the client.
 * The CHECK in 0163 requires the flag to agree with whether destinations were
 * actually named, so the honest reading is: naming a country IS the transfer.
 * A caller who says "cross-border" without saying where is refused, because a
 * transfer with no destination is precisely the thing the register cannot show.
 */
function transferPair(body: Record<string, unknown>, current: ProcessingActivityView | null): {
  crossBorder: boolean;
  transferCountries: string[];
} {
  const raw = patchable(body, 'transferCountries', (v) => stringArray(v).map((s) => s.toUpperCase()));
  // `undefined` leaves the destinations alone; an explicit null clears them.
  const countries = raw === undefined ? (current?.transferCountries ?? []) : (raw ?? []);
  if (countries.length > 0) return { crossBorder: true, transferCountries: countries };

  const claimed = patchable(body, 'crossBorder', (v) => bool(v, false));
  const wantsTransfer = claimed === undefined ? (current?.crossBorder ?? false) : claimed;
  if (wantsTransfer) {
    throw badRequest('crossBorder requires at least one destination country to be named');
  }
  return { crossBorder: false, transferCountries: [] };
}

/** The RoPA columns every read and write shares, so the projection stays whole. */
const ACTIVITY_COLUMNS = `id, code, name, purpose, lawful_basis, data_categories, subject_categories,
  recipients, retention_period, cross_border, transfer_countries, transfer_safeguards,
  security_measures, dpia_completed, owner_user_id, status, last_reviewed_at, review_due_at,
  created_by, updated_by, created_at, updated_at`;

export interface ProcessingActivityListOptions {
  search?: string | null;
  status?: string | null;
  lawfulBasis?: string | null;
  dataCategory?: string | null;
  subjectCategory?: string | null;
  crossBorder?: boolean | null;
  limit?: number | null;
  offset?: number | null;
}

export interface Page<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
}

export async function listProcessingActivities(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: ProcessingActivityListOptions = {}
): Promise<Page<ProcessingActivityView>> {
  const companyId = requireCompany(ctx);
  const params: unknown[] = [companyId];
  let where = 'company_id = $1';

  const term = text(opts.search)?.trim();
  if (term) {
    params.push(`%${term}%`);
    where += ` AND (code ILIKE $${params.length} OR name ILIKE $${params.length} OR purpose ILIKE $${params.length})`;
  }
  if (opts.status) {
    params.push(oneOf(opts.status, ACTIVITY_STATUSES, 'status'));
    where += ` AND status = $${params.length}`;
  }
  if (opts.lawfulBasis) {
    params.push(oneOf(opts.lawfulBasis, LAWFUL_BASES, 'lawfulBasis'));
    where += ` AND lawful_basis = $${params.length}`;
  }
  if (opts.dataCategory) {
    params.push(manyOf(opts.dataCategory, DATA_CATEGORIES, 'dataCategory'));
    where += ` AND data_categories && $${params.length}::text[]`;
  }
  if (opts.subjectCategory) {
    params.push(manyOf(opts.subjectCategory, ACTIVITY_SUBJECTS, 'subjectCategory'));
    where += ` AND subject_categories && $${params.length}::text[]`;
  }
  if (opts.crossBorder !== null && opts.crossBorder !== undefined) {
    params.push(opts.crossBorder === true);
    where += ` AND cross_border = $${params.length}`;
  }

  const limit = Math.min(Math.max(num(opts.limit) ?? 50, 1), 200);
  const offset = Math.max(num(opts.offset) ?? 0, 0);
  const total = await scalar(client, `SELECT count(*)::int AS c FROM pdpo_processing_activities WHERE ${where}`, params);
  const res = await client.query(
    `SELECT ${ACTIVITY_COLUMNS} FROM pdpo_processing_activities
      WHERE ${where}
      ORDER BY status = 'RETIRED', code
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return { rows: (res.rows as Row[]).map(processingActivityView), total, limit, offset };
}

export async function getProcessingActivity(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number
): Promise<ProcessingActivityView> {
  const row = await loadRow(client, 'pdpo_processing_activities', requireCompany(ctx), id, 'Processing activity');
  return processingActivityView(row);
}

export async function createProcessingActivity(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<ProcessingActivityView> {
  const companyId = requireCompany(ctx);
  const transfer = transferPair(body, null);
  const values = {
    code: requiredText(body.code, 'code', 60).toUpperCase(),
    name: requiredText(body.name, 'name', 200),
    purpose: requiredText(body.purpose, 'purpose', 4000),
    lawfulBasis: oneOf(body.lawfulBasis, LAWFUL_BASES, 'lawfulBasis'),
    dataCategories: manyOf(body.dataCategories, DATA_CATEGORIES, 'dataCategories'),
    subjectCategories: manyOf(body.subjectCategories, ACTIVITY_SUBJECTS, 'subjectCategories'),
    recipients: text(body.recipients),
    retentionPeriod: text(body.retentionPeriod),
    transferSafeguards: text(body.transferSafeguards),
    securityMeasures: text(body.securityMeasures),
    dpiaCompleted: bool(body.dpiaCompleted, false),
    ownerUserId: num(body.ownerUserId),
    status: oneOf(body.status, ACTIVITY_STATUSES, 'status', 'ACTIVE'),
    lastReviewedAt: instant(body.lastReviewedAt, 'lastReviewedAt'),
    reviewDueAt: instant(body.reviewDueAt, 'reviewDueAt'),
  };

  try {
    const res = await client.query(
      `INSERT INTO pdpo_processing_activities
         (tenant_id, company_id, code, name, purpose, lawful_basis, data_categories, subject_categories,
          recipients, retention_period, cross_border, transfer_countries, transfer_safeguards,
          security_measures, dpia_completed, owner_user_id, status, last_reviewed_at, review_due_at,
          created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12::text[],$13,$14,$15,$16,$17,$18,$19,$20,$20)
       RETURNING ${ACTIVITY_COLUMNS}`,
      [
        ctx.tenantId ?? null, companyId, values.code, values.name, values.purpose, values.lawfulBasis,
        values.dataCategories, values.subjectCategories, values.recipients, values.retentionPeriod,
        transfer.crossBorder, transfer.transferCountries, values.transferSafeguards, values.securityMeasures,
        values.dpiaCompleted, values.ownerUserId, values.status, values.lastReviewedAt, values.reviewDueAt,
        ctx.userId ?? null,
      ]
    );
    const created = processingActivityView(res.rows[0] as Row);
    await auditConfig(client, ctx, 'create', 'compliance.processing_activity', created.id, null, created as unknown as Record<string, unknown>, { code: created.code });
    return created;
  } catch (err) {
    if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
      throw conflict(`A processing activity with code ${values.code} already exists for this company`);
    }
    throw err;
  }
}

export async function updateProcessingActivity(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<ProcessingActivityView> {
  const companyId = requireCompany(ctx);
  const before = await getProcessingActivity(client, ctx, id);
  const transfer = transferPair(body, before);

  const pickText = (key: string, current: string | null): string | null => {
    const v = patchable(body, key, (x) => text(x));
    return v === undefined ? current : v;
  };
  const pickInstant = (key: string, current: string | null): string | null => {
    const v = patchable(body, key, (x) => instant(x, key));
    return v === undefined ? current : v;
  };

  const values = {
    code: body.code === undefined ? before.code : requiredText(body.code, 'code', 60).toUpperCase(),
    name: body.name === undefined ? before.name : requiredText(body.name, 'name', 200),
    purpose: body.purpose === undefined ? before.purpose : requiredText(body.purpose, 'purpose', 4000),
    lawfulBasis: body.lawfulBasis === undefined ? before.lawfulBasis : oneOf(body.lawfulBasis, LAWFUL_BASES, 'lawfulBasis'),
    dataCategories: body.dataCategories === undefined ? before.dataCategories : manyOf(body.dataCategories, DATA_CATEGORIES, 'dataCategories'),
    subjectCategories: body.subjectCategories === undefined ? before.subjectCategories : manyOf(body.subjectCategories, ACTIVITY_SUBJECTS, 'subjectCategories'),
    recipients: pickText('recipients', before.recipients),
    retentionPeriod: pickText('retentionPeriod', before.retentionPeriod),
    transferSafeguards: pickText('transferSafeguards', before.transferSafeguards),
    securityMeasures: pickText('securityMeasures', before.securityMeasures),
    dpiaCompleted: body.dpiaCompleted === undefined ? before.dpiaCompleted : bool(body.dpiaCompleted, false),
    ownerUserId: (() => {
      const v = patchable(body, 'ownerUserId', (x) => num(x));
      return v === undefined ? before.ownerUserId : v;
    })(),
    status: body.status === undefined ? before.status : oneOf(body.status, ACTIVITY_STATUSES, 'status'),
    lastReviewedAt: pickInstant('lastReviewedAt', before.lastReviewedAt),
    reviewDueAt: pickInstant('reviewDueAt', before.reviewDueAt),
  };

  try {
    const res = await client.query(
      `UPDATE pdpo_processing_activities
          SET code = $3, name = $4, purpose = $5, lawful_basis = $6,
              data_categories = $7::text[], subject_categories = $8::text[],
              recipients = $9, retention_period = $10,
              cross_border = $11, transfer_countries = $12::text[], transfer_safeguards = $13,
              security_measures = $14, dpia_completed = $15, owner_user_id = $16, status = $17,
              last_reviewed_at = $18, review_due_at = $19, updated_by = $20
        WHERE company_id = $1 AND id = $2
        RETURNING ${ACTIVITY_COLUMNS}`,
      [
        companyId, id, values.code, values.name, values.purpose, values.lawfulBasis,
        values.dataCategories, values.subjectCategories, values.recipients, values.retentionPeriod,
        transfer.crossBorder, transfer.transferCountries, values.transferSafeguards, values.securityMeasures,
        values.dpiaCompleted, values.ownerUserId, values.status, values.lastReviewedAt, values.reviewDueAt,
        ctx.userId ?? null,
      ]
    );
    const after = processingActivityView(res.rows[0] as Row);
    await auditConfig(client, ctx, 'update', 'compliance.processing_activity', id, before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, { code: after.code });
    return after;
  } catch (err) {
    if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
      throw conflict(`A processing activity with code ${values.code} already exists for this company`);
    }
    throw err;
  }
}

/**
 * Retire rather than delete when the activity is referenced.
 *
 * A RoPA row is evidence that a processing operation existed and what was
 * decided about it, and a consent or a filing may still point at it. Deleting
 * is allowed only while nothing refers to the row; otherwise the register would
 * lose the context of records that survive it, so the caller is told to retire
 * it instead.
 */
export async function deleteProcessingActivity(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number
): Promise<{ id: number; deleted: boolean; retired: boolean }> {
  const companyId = requireCompany(ctx);
  const before = await getProcessingActivity(client, ctx, id);
  const references = await scalar(
    client,
    `SELECT (
        (SELECT count(*) FROM pdpo_consents WHERE company_id = $1 AND processing_activity_id = $2)
      + (SELECT count(*) FROM pdpo_submissions
          WHERE company_id = $1 AND related_table = 'pdpo_processing_activities' AND related_id = $2)
     )::int AS c`,
    [companyId, id]
  );
  if (references > 0) {
    throw badRequest(
      `${references} register ${references === 1 ? 'entry refers' : 'entries refer'} to this activity, so it cannot be deleted. Retire it instead.`
    );
  }
  await client.query('DELETE FROM pdpo_processing_activities WHERE company_id = $1 AND id = $2', [companyId, id]);
  await auditConfig(client, ctx, 'delete', 'compliance.processing_activity', id, before as unknown as Record<string, unknown>, null, { code: before.code });
  return { id, deleted: true, retired: false };
}

// ------------------------------------------------------------- consent register
export interface ConsentView {
  id: number;
  subjectReference: string;
  subjectType: string;
  processingActivityId: number | null;
  processingActivityCode: string | null;
  purpose: string;
  lawfulBasis: string;
  status: string;
  channel: string | null;
  wordingVersion: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  withdrawnAt: string | null;
  withdrawalReason: string | null;
  evidence: Record<string, unknown>;
  capturedBy: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function consentView(row: Row): ConsentView {
  return {
    id: Number(row.id),
    subjectReference: String(row.subject_reference ?? ''),
    subjectType: String(row.subject_type ?? ''),
    processingActivityId: num(row.processing_activity_id),
    processingActivityCode: text(row.processing_activity_code),
    purpose: String(row.purpose ?? ''),
    lawfulBasis: String(row.lawful_basis ?? ''),
    status: String(row.status ?? ''),
    channel: text(row.channel),
    wordingVersion: text(row.wording_version),
    grantedAt: iso(row.granted_at),
    expiresAt: iso(row.expires_at),
    withdrawnAt: iso(row.withdrawn_at),
    withdrawalReason: text(row.withdrawal_reason),
    evidence: (row.evidence && typeof row.evidence === 'object' ? row.evidence : {}) as Record<string, unknown>,
    capturedBy: num(row.captured_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** The consent columns, joined to the activity code so the register reads. */
const CONSENT_SELECT = `c.id, c.subject_reference, c.subject_type, c.processing_activity_id,
  c.purpose, c.lawful_basis, c.status, c.channel, c.wording_version, c.granted_at, c.expires_at,
  c.withdrawn_at, c.withdrawal_reason, c.evidence, c.captured_by, c.created_at, c.updated_at,
  a.code AS processing_activity_code`;

export interface ConsentListOptions {
  search?: string | null;
  status?: string | null;
  subjectType?: string | null;
  purpose?: string | null;
  processingActivityId?: number | null;
  limit?: number | null;
  offset?: number | null;
}

export async function listConsents(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: ConsentListOptions = {}
): Promise<Page<ConsentView>> {
  const companyId = requireCompany(ctx);
  const params: unknown[] = [companyId];
  let where = 'c.company_id = $1';

  const term = text(opts.search)?.trim();
  if (term) {
    params.push(`%${term}%`);
    where += ` AND (c.subject_reference ILIKE $${params.length} OR c.purpose ILIKE $${params.length})`;
  }
  if (opts.status) {
    params.push(oneOf(opts.status, CONSENT_STATUSES, 'status'));
    where += ` AND c.status = $${params.length}`;
  }
  if (opts.subjectType) {
    params.push(oneOf(opts.subjectType, DATA_SUBJECT_TYPES, 'subjectType'));
    where += ` AND c.subject_type = $${params.length}`;
  }
  const purpose = text(opts.purpose)?.trim();
  if (purpose) {
    params.push(purpose);
    where += ` AND c.purpose = $${params.length}`;
  }
  if (opts.processingActivityId !== null && opts.processingActivityId !== undefined) {
    params.push(Number(opts.processingActivityId));
    where += ` AND c.processing_activity_id = $${params.length}`;
  }

  const limit = Math.min(Math.max(num(opts.limit) ?? 50, 1), 200);
  const offset = Math.max(num(opts.offset) ?? 0, 0);
  const total = await scalar(client, `SELECT count(*)::int AS c FROM pdpo_consents c WHERE ${where}`, params);
  const res = await client.query(
    `SELECT ${CONSENT_SELECT}
       FROM pdpo_consents c
       LEFT JOIN pdpo_processing_activities a ON a.id = c.processing_activity_id
      WHERE ${where}
      ORDER BY c.granted_at DESC, c.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return { rows: (res.rows as Row[]).map(consentView), total, limit, offset };
}

async function readConsent(client: pg.PoolClient, companyId: number, id: number): Promise<ConsentView> {
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Consent id is required');
  const res = await client.query(
    `SELECT ${CONSENT_SELECT}
       FROM pdpo_consents c
       LEFT JOIN pdpo_processing_activities a ON a.id = c.processing_activity_id
      WHERE c.company_id = $1 AND c.id = $2`,
    [companyId, id]
  );
  if (res.rows.length === 0) throw notFound('Consent not found');
  return consentView(res.rows[0] as Row);
}

export async function getConsent(client: pg.PoolClient, ctx: Ctx, id: number): Promise<ConsentView> {
  return readConsent(client, requireCompany(ctx), id);
}

/** The one live consent per subject and purpose, enforced by a partial index. */
const CONSENT_DUPLICATE_MESSAGE =
  'An active consent already exists for this subject and purpose. Withdraw it first, or record the new one against a different purpose.';

export async function createConsent(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<ConsentView> {
  const companyId = requireCompany(ctx);
  const subjectReference = requiredText(body.subjectReference, 'subjectReference', 200);
  const purpose = requiredText(body.purpose, 'purpose', 200);
  const activityId = num(body.processingActivityId);
  if (activityId !== null) {
    await loadRow(client, 'pdpo_processing_activities', companyId, activityId, 'Processing activity');
  }

  const grantedAt = instant(body.grantedAt, 'grantedAt') ?? new Date().toISOString();
  const expiresAt = instant(body.expiresAt, 'expiresAt');
  if (expiresAt !== null && new Date(expiresAt).getTime() <= new Date(grantedAt).getTime()) {
    throw badRequest('expiresAt must be after grantedAt');
  }

  try {
    const res = await client.query(
      `INSERT INTO pdpo_consents
         (tenant_id, company_id, subject_reference, subject_type, processing_activity_id, purpose,
          lawful_basis, status, channel, wording_version, granted_at, expires_at, evidence, captured_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'GRANTED',$8,$9,$10,$11,$12::jsonb,$13)
       RETURNING id`,
      [
        ctx.tenantId ?? null, companyId, subjectReference,
        oneOf(body.subjectType, DATA_SUBJECT_TYPES, 'subjectType'),
        activityId, purpose,
        oneOf(body.lawfulBasis, LAWFUL_BASES, 'lawfulBasis', 'CONSENT'),
        body.channel === undefined || body.channel === null || body.channel === ''
          ? null
          : oneOf(body.channel, CONSENT_CHANNELS, 'channel'),
        text(body.wordingVersion), grantedAt, expiresAt,
        JSON.stringify(jsonObject(body.evidence, 'evidence')),
        ctx.userId ?? null,
      ]
    );
    const created = await readConsent(client, companyId, Number(res.rows[0].id));
    await auditConfig(client, ctx, 'create', 'compliance.consent', created.id, null, created as unknown as Record<string, unknown>, {});
    return created;
  } catch (err) {
    if (isDuplicateConsent(err)) throw conflict(CONSENT_DUPLICATE_MESSAGE);
    throw err;
  }
}

/**
 * Withdraw a consent. The row is never deleted and never rewritten: the grant
 * is the evidence that processing was lawful while it lasted, and the
 * withdrawal is the evidence that it stopped. The partial unique index only
 * covers GRANTED rows, so re-consenting afterwards is a new row with its own
 * wording and date, and both halves of the history survive.
 */
export async function withdrawConsent(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<ConsentView> {
  const companyId = requireCompany(ctx);
  const before = await readConsent(client, companyId, id);
  if (before.status === 'WITHDRAWN') {
    throw conflict('This consent has already been withdrawn');
  }
  if (before.status === 'EXPIRED') {
    throw conflict('This consent has already expired and cannot be withdrawn');
  }

  const withdrawnAt = instant(body.withdrawnAt, 'withdrawnAt') ?? new Date().toISOString();
  await client.query(
    `UPDATE pdpo_consents
        SET status = 'WITHDRAWN', withdrawn_at = $3, withdrawal_reason = $4
      WHERE company_id = $1 AND id = $2`,
    [companyId, id, withdrawnAt, text(body.reason) ?? text(body.withdrawalReason)]
  );
  const after = await readConsent(client, companyId, id);
  await auditConfig(client, ctx, 'withdraw', 'compliance.consent', id, before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, {});
  return after;
}

/**
 * Delete a consent record.
 *
 * Only a consent that has already stopped - withdrawn or expired - can be
 * removed, and only because the register has kept the withdrawal row that
 * replaced it. Deleting a live consent would erase the evidence that
 * processing was ever permitted, which is the one thing this register exists
 * to be able to show, so the caller is told to withdraw it first.
 */
export async function deleteConsent(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number
): Promise<{ id: number; deleted: boolean }> {
  const companyId = requireCompany(ctx);
  const before = await readConsent(client, companyId, id);
  if (before.status === 'GRANTED') {
    throw badRequest('A live consent cannot be deleted. Withdraw it first so the register shows when it ended.');
  }
  const references = await scalar(
    client,
    `SELECT count(*)::int AS c FROM pdpo_submissions
      WHERE company_id = $1 AND related_table = 'pdpo_consents' AND related_id = $2`,
    [companyId, id]
  );
  if (references > 0) {
    throw badRequest('A filing refers to this consent, so it cannot be deleted');
  }
  await client.query('DELETE FROM pdpo_consents WHERE company_id = $1 AND id = $2', [companyId, id]);
  await auditConfig(client, ctx, 'delete', 'compliance.consent', id, before as unknown as Record<string, unknown>, null, {});
  return { id, deleted: true };
}
// ------------------------------------------------------------------- status
/**
 * The workspace dashboard: what is open, what is late, and what has been filed.
 *
 * Every figure is counted from the registers rather than cached, because a
 * compliance screen that lags its own register is worse than no screen at all.
 * The two "next due" clocks are the ones an operator is actually working
 * against: the soonest subject-request deadline and the soonest breach
 * notification deadline that has not been met.
 */
export interface PdpoStatusTotals {
  activitiesActive: number;
  activitiesRetired: number;
  consentsGranted: number;
  consentsWithdrawn: number;
  consentsExpired: number;
  requestsOpen: number;
  requestsOverdue: number;
  requestsClosed: number;
  breachesOpen: number;
  breachesOverdue: number;
  breachesNotified: number;
  breachesLate: number;
  submissionsDraft: number;
  submissionsFiled: number;
  submissionsAcknowledged: number;
  submissionsRejected: number;
}

export interface PdpoStatusView {
  config: PdpoConfigView;
  totals: PdpoStatusTotals;
  /** What is missing or late, in the words of the person who has to fix it. */
  warnings: string[];
  /** The soonest statutory deadline still running, or null when none is. */
  nextRequestDueAt: string | null;
  nextBreachDueAt: string | null;
  lastFiledAt: string | null;
}

export async function pdpoStatus(client: pg.PoolClient, ctx: Ctx): Promise<PdpoStatusView> {
  const companyId = requireCompany(ctx);
  const row = await getPdpoIntegration(client, ctx);
  const config = pdpoConfigView(row);

  const res = await client.query<{ totals: Record<string, unknown>; next_request_due_at: unknown; next_breach_due_at: unknown; last_filed_at: unknown }>(
    `SELECT jsonb_build_object(
        'activitiesActive', (SELECT count(*) FROM pdpo_processing_activities
                              WHERE company_id = $1 AND status <> 'RETIRED'),
        'activitiesRetired', (SELECT count(*) FROM pdpo_processing_activities
                               WHERE company_id = $1 AND status = 'RETIRED'),
        'consentsGranted', (SELECT count(*) FROM pdpo_consents
                             WHERE company_id = $1 AND status = 'GRANTED'),
        'consentsWithdrawn', (SELECT count(*) FROM pdpo_consents
                               WHERE company_id = $1 AND status = 'WITHDRAWN'),
        'consentsExpired', (SELECT count(*) FROM pdpo_consents
                             WHERE company_id = $1 AND status = 'EXPIRED'),
        'requestsOpen', (SELECT count(*) FROM pdpo_subject_requests
                          WHERE company_id = $1 AND status IN (${sqlList(REQUEST_OPEN_STATUSES)})),
        'requestsOverdue', (SELECT count(*) FROM pdpo_subject_requests
                             WHERE company_id = $1 AND status IN (${sqlList(REQUEST_OPEN_STATUSES)})
                               AND due_at IS NOT NULL AND due_at < now()),
        'requestsClosed', (SELECT count(*) FROM pdpo_subject_requests
                            WHERE company_id = $1 AND status IN (${sqlList(REQUEST_CLOSED_STATUSES)})),
        'breachesOpen', (SELECT count(*) FROM pdpo_breaches
                          WHERE company_id = $1 AND status IN (${sqlList(BREACH_OPEN_STATUSES)})),
        'breachesOverdue', (SELECT count(*) FROM pdpo_breaches
                             WHERE company_id = $1 AND status IN (${sqlList(BREACH_OPEN_STATUSES)})
                               AND notified_at IS NULL AND notification_due_at < now()),
        'breachesNotified', (SELECT count(*) FROM pdpo_breaches
                              WHERE company_id = $1 AND notified_at IS NOT NULL),
        'breachesLate', (SELECT count(*) FROM pdpo_breaches
                          WHERE company_id = $1 AND late_notification),
        'submissionsDraft', (SELECT count(*) FROM pdpo_submissions
                              WHERE company_id = $1 AND status = 'DRAFT'),
        'submissionsFiled', (SELECT count(*) FROM pdpo_submissions
                              WHERE company_id = $1 AND status = 'FILED'),
        'submissionsAcknowledged', (SELECT count(*) FROM pdpo_submissions
                                     WHERE company_id = $1 AND status = 'ACKNOWLEDGED'),
        'submissionsRejected', (SELECT count(*) FROM pdpo_submissions
                                 WHERE company_id = $1 AND status = 'REJECTED')
      ) AS totals,
      (SELECT min(due_at) FROM pdpo_subject_requests
        WHERE company_id = $1 AND status IN (${sqlList(REQUEST_OPEN_STATUSES)})) AS next_request_due_at,
      (SELECT min(notification_due_at) FROM pdpo_breaches
        WHERE company_id = $1 AND status IN (${sqlList(BREACH_OPEN_STATUSES)}) AND notified_at IS NULL) AS next_breach_due_at,
      (SELECT max(filed_at) FROM pdpo_submissions WHERE company_id = $1) AS last_filed_at`,
    [companyId]
  );

  const raw = res.rows[0]?.totals ?? {};
  const count = (key: keyof PdpoStatusTotals): number => num(raw[key]) ?? 0;
  const totals: PdpoStatusTotals = {
    activitiesActive: count('activitiesActive'),
    activitiesRetired: count('activitiesRetired'),
    consentsGranted: count('consentsGranted'),
    consentsWithdrawn: count('consentsWithdrawn'),
    consentsExpired: count('consentsExpired'),
    requestsOpen: count('requestsOpen'),
    requestsOverdue: count('requestsOverdue'),
    requestsClosed: count('requestsClosed'),
    breachesOpen: count('breachesOpen'),
    breachesOverdue: count('breachesOverdue'),
    breachesNotified: count('breachesNotified'),
    breachesLate: count('breachesLate'),
    submissionsDraft: count('submissionsDraft'),
    submissionsFiled: count('submissionsFiled'),
    submissionsAcknowledged: count('submissionsAcknowledged'),
    submissionsRejected: count('submissionsRejected'),
  };

  // Configuration gaps first, then the two failures the Act measures the
  // company on: an unanswered subject request and an unreported breach.
  const warnings = configWarnings(config);
  if (totals.requestsOverdue > 0) {
    warnings.push(
      `${totals.requestsOverdue} data subject ${totals.requestsOverdue === 1 ? 'request is' : 'requests are'} past the statutory response date.`
    );
  }
  if (totals.breachesOverdue > 0) {
    warnings.push(
      `${totals.breachesOverdue} notifiable ${totals.breachesOverdue === 1 ? 'breach is' : 'breaches are'} past the notification window and has not been reported to the Office.`
    );
  }
  if (totals.breachesLate > 0) {
    warnings.push(
      `${totals.breachesLate} ${totals.breachesLate === 1 ? 'breach was' : 'breaches were'} notified after the window closed; the Office will ask why.`
    );
  }
  if (totals.submissionsDraft > 0) {
    warnings.push(`${totals.submissionsDraft} filing ${totals.submissionsDraft === 1 ? 'is' : 'are'} still in draft.`);
  }

  return {
    config,
    totals,
    warnings,
    nextRequestDueAt: iso(res.rows[0]?.next_request_due_at),
    nextBreachDueAt: iso(res.rows[0]?.next_breach_due_at),
    lastFiledAt: iso(res.rows[0]?.last_filed_at),
  };
}

// ------------------------------------------------------- data subject rights
/**
 * The data subject rights queue.
 *
 * due_at is never sent by this module. 0163 stamps it from received_at plus the
 * window carried on the row, so a deadline cannot be edited away by whoever
 * finds it inconvenient, and an extension is recorded as extension_days rather
 * than by moving received_at - the date the subject wrote in has to stay the
 * date the clock started.
 *
 * The two closing transitions are separate calls rather than a status field,
 * because completing and refusing a request are different decisions with
 * different evidence: one has an outcome, the other has a reason.
 */
export interface SubjectRequestView {
  id: number;
  reference: string;
  requestType: string;
  subjectReference: string;
  subjectType: string;
  receivedAt: string | null;
  responseWindowDays: number;
  extensionDays: number;
  dueAt: string | null;
  status: string;
  acknowledgedAt: string | null;
  completedAt: string | null;
  extensionReason: string | null;
  refusalReason: string | null;
  outcomeSummary: string | null;
  handledBy: number | null;
  evidence: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  /** True while the statutory clock is still running against this request. */
  open: boolean;
  /** Open and past due_at: the date the Act gives for answering has passed. */
  overdue: boolean;
  /** Whole days left, negative once the date has passed. */
  daysRemaining: number | null;
}

export function subjectRequestView(row: Row): SubjectRequestView {
  const status = String(row.status ?? '');
  const open = (REQUEST_OPEN_STATUSES as readonly string[]).includes(status);
  const dueAt = iso(row.due_at);
  return {
    id: Number(row.id),
    reference: String(row.reference ?? ''),
    requestType: String(row.request_type ?? ''),
    subjectReference: String(row.subject_reference ?? ''),
    subjectType: String(row.subject_type ?? ''),
    receivedAt: iso(row.received_at),
    responseWindowDays: num(row.response_window_days) ?? 0,
    extensionDays: num(row.extension_days) ?? 0,
    dueAt,
    status,
    acknowledgedAt: iso(row.acknowledged_at),
    completedAt: iso(row.completed_at),
    extensionReason: text(row.extension_reason),
    refusalReason: text(row.refusal_reason),
    outcomeSummary: text(row.outcome_summary),
    handledBy: num(row.handled_by),
    evidence: (row.evidence && typeof row.evidence === 'object' ? row.evidence : {}) as Record<string, unknown>,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    open,
    overdue: open && dueAt !== null && new Date(dueAt).getTime() < Date.now(),
    daysRemaining: daysUntil(dueAt),
  };
}

const REQUEST_COLUMNS = `id, reference, request_type, subject_reference, subject_type, received_at,
  response_window_days, extension_days, due_at, status, acknowledged_at, completed_at,
  extension_reason, refusal_reason, outcome_summary, handled_by, evidence, created_at, updated_at`;

export interface SubjectRequestListOptions {
  search?: string | null;
  status?: string | null;
  requestType?: string | null;
  subjectType?: string | null;
  subjectReference?: string | null;
  /** true: only requests past due_at. false: only ones still inside the window. */
  overdue?: boolean | null;
  /** true: still running. false: completed or refused. */
  open?: boolean | null;
  limit?: number | null;
  offset?: number | null;
}

export async function listSubjectRequests(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: SubjectRequestListOptions = {}
): Promise<Page<SubjectRequestView>> {
  const companyId = requireCompany(ctx);
  const params: unknown[] = [companyId];
  let where = 'company_id = $1';

  const term = text(opts.search)?.trim();
  if (term) {
    params.push(`%${term}%`);
    where += ` AND (reference ILIKE $${params.length} OR subject_reference ILIKE $${params.length})`;
  }
  if (opts.status) {
    params.push(oneOf(opts.status, REQUEST_STATUSES, 'status'));
    where += ` AND status = $${params.length}`;
  }
  if (opts.requestType) {
    params.push(oneOf(opts.requestType, REQUEST_TYPES, 'requestType'));
    where += ` AND request_type = $${params.length}`;
  }
  if (opts.subjectType) {
    params.push(oneOf(opts.subjectType, DATA_SUBJECT_TYPES, 'subjectType'));
    where += ` AND subject_type = $${params.length}`;
  }
  const subjectReference = text(opts.subjectReference)?.trim();
  if (subjectReference) {
    params.push(subjectReference);
    where += ` AND subject_reference = $${params.length}`;
  }
  if (opts.open === true) where += ` AND status IN (${sqlList(REQUEST_OPEN_STATUSES)})`;
  if (opts.open === false) where += ` AND status IN (${sqlList(REQUEST_CLOSED_STATUSES)})`;
  if (opts.overdue === true) {
    where += ` AND status IN (${sqlList(REQUEST_OPEN_STATUSES)}) AND due_at IS NOT NULL AND due_at < now()`;
  }
  if (opts.overdue === false) {
    where += ` AND status IN (${sqlList(REQUEST_OPEN_STATUSES)}) AND (due_at IS NULL OR due_at >= now())`;
  }

  const limit = pageSize(opts.limit);
  const offset = pageOffset(opts.offset);
  const total = await scalar(client, `SELECT count(*)::int AS c FROM pdpo_subject_requests WHERE ${where}`, params);
  const res = await client.query(
    `SELECT ${REQUEST_COLUMNS} FROM pdpo_subject_requests
      WHERE ${where}
      ORDER BY (status IN (${sqlList(REQUEST_CLOSED_STATUSES)})), due_at ASC NULLS LAST, id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return { rows: (res.rows as Row[]).map(subjectRequestView), total, limit, offset };
}

async function readSubjectRequest(
  client: pg.PoolClient,
  companyId: number,
  id: number
): Promise<SubjectRequestView> {
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Subject request id is required');
  const res = await client.query(
    `SELECT ${REQUEST_COLUMNS} FROM pdpo_subject_requests WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  if (res.rows.length === 0) throw notFound('Subject request not found');
  return subjectRequestView(res.rows[0] as Row);
}

export async function getSubjectRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number
): Promise<SubjectRequestView> {
  return readSubjectRequest(client, requireCompany(ctx), id);
}

/** The extension pair, which the CHECK in 0163 requires to agree. */
function extensionPair(
  body: Record<string, unknown>,
  current: { extensionDays: number; extensionReason: string | null }
): { extensionDays: number; extensionReason: string | null } {
  const days = body.extensionDays === undefined
    ? current.extensionDays
    : integer(body.extensionDays, 'extensionDays', 0, 0, 180);
  const reason = body.extensionReason === undefined
    ? current.extensionReason
    : text(body.extensionReason);
  if (days > 0 && !reason) {
    throw badRequest('extensionReason is required when the response window is extended');
  }
  if (days === 0 && reason) {
    throw badRequest('extensionReason is only used when extensionDays is greater than zero');
  }
  return { extensionDays: days, extensionReason: days > 0 ? reason : null };
}

export async function createSubjectRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<SubjectRequestView> {
  const companyId = requireCompany(ctx);
  // The window defaults to the company's configured one and is then copied onto
  // the row, so an installation that changes its configuration does not
  // retroactively move a deadline that has already been communicated.
  const stored = readPdpoConfig(await getPdpoIntegration(client, ctx));
  const windowDays = integer(body.responseWindowDays, 'responseWindowDays', stored.subjectRequestDays, 1, 365);
  const extension = extensionPair(body, { extensionDays: 0, extensionReason: null });
  // A request is created open. Closing it is a separate, recorded decision.
  const status = extension.extensionDays > 0
    ? 'EXTENDED'
    : oneOf(body.status, REQUEST_OPEN_STATUSES, 'status', 'RECEIVED');
  const reference = await allocateReference(client, ctx, 'SAR', 'PDPO-SAR');

  const res = await client.query(
    `INSERT INTO pdpo_subject_requests
       (tenant_id, company_id, reference, request_type, subject_reference, subject_type,
        received_at, response_window_days, extension_days, status, extension_reason, handled_by, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8,$9,$10,$11,$12,$13::jsonb)
     RETURNING ${REQUEST_COLUMNS}`,
    [
      ctx.tenantId ?? null, companyId, reference,
      oneOf(body.requestType, REQUEST_TYPES, 'requestType'),
      requiredText(body.subjectReference, 'subjectReference', 200),
      oneOf(body.subjectType, DATA_SUBJECT_TYPES, 'subjectType'),
      instant(body.receivedAt, 'receivedAt'),
      windowDays, extension.extensionDays, status, extension.extensionReason,
      num(body.handledBy) ?? ctx.userId ?? null,
      JSON.stringify(jsonObject(body.evidence, 'evidence')),
    ]
  );
  const created = subjectRequestView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'create', 'compliance.subject_request', created.id, null,
    created as unknown as Record<string, unknown>, { reference: created.reference }
  );
  return created;
}

export async function updateSubjectRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<SubjectRequestView> {
  const companyId = requireCompany(ctx);
  const before = await readSubjectRequest(client, companyId, id);
  if (!before.open) {
    throw conflict(
      `${before.reference} is ${before.status.toLowerCase()} and can no longer be edited. Its record is the evidence of what was done with the request.`
    );
  }
  const extension = extensionPair(body, before);
  const status = body.status === undefined
    ? before.status
    : oneOf(body.status, REQUEST_OPEN_STATUSES, 'status');

  const res = await client.query(
    `UPDATE pdpo_subject_requests
        SET request_type = $3, subject_reference = $4, subject_type = $5, received_at = $6,
            response_window_days = $7, extension_days = $8, extension_reason = $9, status = $10,
            outcome_summary = $11, handled_by = $12, evidence = $13::jsonb
      WHERE company_id = $1 AND id = $2
      RETURNING ${REQUEST_COLUMNS}`,
    [
      companyId, id,
      body.requestType === undefined ? before.requestType : oneOf(body.requestType, REQUEST_TYPES, 'requestType'),
      body.subjectReference === undefined
        ? before.subjectReference
        : requiredText(body.subjectReference, 'subjectReference', 200),
      body.subjectType === undefined ? before.subjectType : oneOf(body.subjectType, DATA_SUBJECT_TYPES, 'subjectType'),
      body.receivedAt === undefined ? before.receivedAt : instant(body.receivedAt, 'receivedAt'),
      body.responseWindowDays === undefined
        ? before.responseWindowDays
        : integer(body.responseWindowDays, 'responseWindowDays', before.responseWindowDays, 1, 365),
      extension.extensionDays, extension.extensionReason, status,
      body.outcomeSummary === undefined ? before.outcomeSummary : text(body.outcomeSummary),
      body.handledBy === undefined ? before.handledBy : num(body.handledBy),
      JSON.stringify(body.evidence === undefined ? before.evidence : jsonObject(body.evidence, 'evidence')),
    ]
  );
  const after = subjectRequestView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'update', 'compliance.subject_request', id,
    before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>,
    { reference: after.reference }
  );
  return after;
}

/**
 * Record that the subject has been told the request was received. This is the
 * first thing the Office asks to see: the clock starts when the subject writes
 * in, not when somebody notices.
 */
export async function acknowledgeSubjectRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown> = {}
): Promise<SubjectRequestView> {
  const companyId = requireCompany(ctx);
  const before = await readSubjectRequest(client, companyId, id);
  if (!before.open) throw conflict(`${before.reference} is already closed`);
  if (before.acknowledgedAt !== null) {
    throw conflict(`${before.reference} has already been acknowledged`);
  }
  const acknowledgedAt = instant(body.acknowledgedAt, 'acknowledgedAt') ?? new Date().toISOString();
  const res = await client.query(
    `UPDATE pdpo_subject_requests
        SET acknowledged_at = $3,
            status = CASE WHEN status = 'RECEIVED' THEN 'IN_PROGRESS' ELSE status END,
            handled_by = COALESCE(handled_by, $4)
      WHERE company_id = $1 AND id = $2
      RETURNING ${REQUEST_COLUMNS}`,
    [companyId, id, acknowledgedAt, ctx.userId ?? null]
  );
  const after = subjectRequestView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'acknowledge', 'compliance.subject_request', id,
    before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>,
    { reference: after.reference }
  );
  return after;
}

export async function completeSubjectRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<SubjectRequestView> {
  const companyId = requireCompany(ctx);
  const before = await readSubjectRequest(client, companyId, id);
  if (!before.open) throw conflict(`${before.reference} is already closed`);
  const outcomeSummary = requiredText(body.outcomeSummary, 'outcomeSummary', 4000);
  const completedAt = instant(body.completedAt, 'completedAt') ?? new Date().toISOString();

  const res = await client.query(
    `UPDATE pdpo_subject_requests
        SET status = 'COMPLETED', completed_at = $3, outcome_summary = $4, refusal_reason = NULL,
            handled_by = COALESCE($5, handled_by)
      WHERE company_id = $1 AND id = $2
      RETURNING ${REQUEST_COLUMNS}`,
    [companyId, id, completedAt, outcomeSummary, ctx.userId ?? null]
  );
  const after = subjectRequestView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'complete', 'compliance.subject_request', id,
    before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>,
    { reference: after.reference }
  );
  return after;
}

/**
 * Refuse a request, with the reason on the record.
 *
 * A refusal is a decision the subject can challenge, so the reason is required
 * by the CHECK in 0163 as well as here, and the summary of what was considered
 * is kept alongside it.
 */
export async function refuseSubjectRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<SubjectRequestView> {
  const companyId = requireCompany(ctx);
  const before = await readSubjectRequest(client, companyId, id);
  if (!before.open) throw conflict(`${before.reference} is already closed`);
  const refusalReason = requiredText(body.refusalReason ?? body.reason, 'refusalReason', 2000);
  const completedAt = instant(body.completedAt, 'completedAt') ?? new Date().toISOString();

  const res = await client.query(
    `UPDATE pdpo_subject_requests
        SET status = 'REFUSED', completed_at = $3, refusal_reason = $4,
            outcome_summary = COALESCE($5, outcome_summary),
            handled_by = COALESCE($6, handled_by)
      WHERE company_id = $1 AND id = $2
      RETURNING ${REQUEST_COLUMNS}`,
    [companyId, id, completedAt, refusalReason, text(body.outcomeSummary), ctx.userId ?? null]
  );
  const after = subjectRequestView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'refuse', 'compliance.subject_request', id,
    before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>,
    { reference: after.reference, refusalReason }
  );
  return after;
}

/**
 * Remove a request that was logged in error.
 *
 * Only a request nobody has acted on yet can be deleted. Once it has been
 * acknowledged - let alone answered - the row is the evidence that the company
 * met, or missed, a statutory deadline, and deleting it would be the one edit
 * that makes the register useless in front of an inspector.
 */
export async function deleteSubjectRequest(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number
): Promise<{ id: number; deleted: boolean }> {
  const companyId = requireCompany(ctx);
  const before = await readSubjectRequest(client, companyId, id);
  if (before.acknowledgedAt !== null || before.completedAt !== null) {
    throw badRequest(
      `${before.reference} has already been acknowledged, so it cannot be deleted. Refuse or complete it instead.`
    );
  }
  const references = await scalar(
    client,
    `SELECT count(*)::int AS c FROM pdpo_submissions
      WHERE company_id = $1 AND related_table = 'pdpo_subject_requests' AND related_id = $2`,
    [companyId, id]
  );
  if (references > 0) throw badRequest('A filing refers to this request, so it cannot be deleted');

  await client.query('DELETE FROM pdpo_subject_requests WHERE company_id = $1 AND id = $2', [companyId, id]);
  await auditConfig(
    client, ctx, 'delete', 'compliance.subject_request', id,
    before as unknown as Record<string, unknown>, null, { reference: before.reference }
  );
  return { id, deleted: true };
}
// ------------------------------------------------------------ breach register
/**
 * The personal data breach register and the 72-hour clock.
 *
 * notification_due_at and late_notification are stamped and derived by the
 * BEFORE trigger in 0163 from discovered_at plus the window on the row. This
 * module deliberately never writes either: the deadline runs from discovery,
 * not from when somebody opened a ticket, and a service that could set its own
 * deadline could quietly move a late notification inside the window.
 *
 * `notifiable = false` is a decision that the Office need not be told, which is
 * itself a decision an inspector will ask to have justified - so the two flags
 * are kept consistent here exactly as the CHECK constraint requires, in both
 * directions.
 */
export interface BreachView {
  id: number;
  reference: string;
  title: string;
  nature: string;
  severity: string;
  occurredAt: string | null;
  discoveredAt: string | null;
  notificationWindowHours: number;
  notificationDueAt: string | null;
  dataCategories: string[];
  affectedSubjects: number;
  affectedRecords: number;
  likelyConsequences: string | null;
  containmentMeasures: string | null;
  notifiable: boolean;
  status: string;
  notifiedAt: string | null;
  notificationReference: string | null;
  /** Derived by the trigger: notified after notification_due_at. */
  lateNotification: boolean;
  subjectNotifiedAt: string | null;
  reportedBy: number | null;
  closedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** True while the notification clock is still running. */
  open: boolean;
  /** Open, notifiable, not yet reported, and past the window. */
  overdue: boolean;
  /** Hours left to notify, negative once the window has closed. */
  hoursRemaining: number | null;
}

export function breachView(row: Row): BreachView {
  const status = String(row.status ?? '');
  const notifiable = row.notifiable === true;
  const notifiedAt = iso(row.notified_at);
  const notificationDueAt = iso(row.notification_due_at);
  const open = (BREACH_OPEN_STATUSES as readonly string[]).includes(status);
  return {
    id: Number(row.id),
    reference: String(row.reference ?? ''),
    title: String(row.title ?? ''),
    nature: String(row.nature ?? ''),
    severity: String(row.severity ?? ''),
    occurredAt: iso(row.occurred_at),
    discoveredAt: iso(row.discovered_at),
    notificationWindowHours: num(row.notification_window_hours) ?? 0,
    notificationDueAt,
    dataCategories: stringList(row.data_categories),
    affectedSubjects: num(row.affected_subjects) ?? 0,
    affectedRecords: num(row.affected_records) ?? 0,
    likelyConsequences: text(row.likely_consequences),
    containmentMeasures: text(row.containment_measures),
    notifiable,
    status,
    notifiedAt,
    notificationReference: text(row.notification_reference),
    lateNotification: row.late_notification === true,
    subjectNotifiedAt: iso(row.subject_notified_at),
    reportedBy: num(row.reported_by),
    closedAt: iso(row.closed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    open,
    overdue:
      open && notifiable && notifiedAt === null && notificationDueAt !== null &&
      new Date(notificationDueAt).getTime() < Date.now(),
    hoursRemaining: hoursUntil(notificationDueAt),
  };
}

const BREACH_COLUMNS = `id, reference, title, nature, severity, occurred_at, discovered_at,
  notification_window_hours, notification_due_at, data_categories, affected_subjects,
  affected_records, likely_consequences, containment_measures, notifiable, status, notified_at,
  notification_reference, late_notification, subject_notified_at, reported_by, closed_at,
  created_at, updated_at`;

export interface BreachListOptions {
  search?: string | null;
  status?: string | null;
  severity?: string | null;
  notifiable?: boolean | null;
  /** true: the notification clock is still running. */
  open?: boolean | null;
  /** true: notifiable, unreported and past the window. */
  overdue?: boolean | null;
  limit?: number | null;
  offset?: number | null;
}

export async function listBreaches(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: BreachListOptions = {}
): Promise<Page<BreachView>> {
  const companyId = requireCompany(ctx);
  const params: unknown[] = [companyId];
  let where = 'company_id = $1';

  const term = text(opts.search)?.trim();
  if (term) {
    params.push(`%${term}%`);
    where += ` AND (reference ILIKE $${params.length} OR title ILIKE $${params.length} OR nature ILIKE $${params.length})`;
  }
  if (opts.status) {
    params.push(oneOf(opts.status, BREACH_STATUSES, 'status'));
    where += ` AND status = $${params.length}`;
  }
  if (opts.severity) {
    params.push(oneOf(opts.severity, BREACH_SEVERITIES, 'severity'));
    where += ` AND severity = $${params.length}`;
  }
  if (opts.notifiable === true) where += ' AND notifiable';
  if (opts.notifiable === false) where += ' AND NOT notifiable';
  if (opts.open === true) where += ` AND status IN (${sqlList(BREACH_OPEN_STATUSES)})`;
  if (opts.open === false) where += ` AND status NOT IN (${sqlList(BREACH_OPEN_STATUSES)})`;
  if (opts.overdue === true) {
    where += ` AND status IN (${sqlList(BREACH_OPEN_STATUSES)}) AND notifiable
               AND notified_at IS NULL AND notification_due_at < now()`;
  }
  if (opts.overdue === false) {
    where += ` AND status IN (${sqlList(BREACH_OPEN_STATUSES)})
               AND (NOT notifiable OR notified_at IS NOT NULL OR notification_due_at >= now())`;
  }

  const limit = pageSize(opts.limit);
  const offset = pageOffset(opts.offset);
  const total = await scalar(client, `SELECT count(*)::int AS c FROM pdpo_breaches WHERE ${where}`, params);
  const res = await client.query(
    `SELECT ${BREACH_COLUMNS} FROM pdpo_breaches
      WHERE ${where}
      ORDER BY (status NOT IN (${sqlList(BREACH_OPEN_STATUSES)})), notification_due_at ASC NULLS LAST,
               discovered_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return { rows: (res.rows as Row[]).map(breachView), total, limit, offset };
}

async function readBreach(client: pg.PoolClient, companyId: number, id: number): Promise<BreachView> {
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Breach id is required');
  const res = await client.query(
    `SELECT ${BREACH_COLUMNS} FROM pdpo_breaches WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  if (res.rows.length === 0) throw notFound('Breach not found');
  return breachView(res.rows[0] as Row);
}

export async function getBreach(client: pg.PoolClient, ctx: Ctx, id: number): Promise<BreachView> {
  return readBreach(client, requireCompany(ctx), id);
}

/**
 * Keep `notifiable` and the NOT_NOTIFIABLE status in agreement, whichever of the
 * two the caller moved. The CHECK in 0163 refuses the combination; fixing it up
 * here means a caller changing only one of them gets a coherent row instead of
 * a constraint error they cannot interpret.
 */
function notifiablePair(
  notifiable: boolean,
  status: string
): { notifiable: boolean; status: string } {
  if (!notifiable) return { notifiable: false, status: 'NOT_NOTIFIABLE' };
  if (status === 'NOT_NOTIFIABLE') return { notifiable: true, status: 'OPEN' };
  return { notifiable: true, status };
}

/** The discovery clock cannot start before the incident did. */
function checkDiscovery(occurredAt: string | null, discoveredAt: string | null): void {
  if (occurredAt !== null && discoveredAt !== null && new Date(discoveredAt).getTime() < new Date(occurredAt).getTime()) {
    throw badRequest('discoveredAt cannot be earlier than occurredAt');
  }
}

export async function createBreach(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<BreachView> {
  const companyId = requireCompany(ctx);
  const stored = readPdpoConfig(await getPdpoIntegration(client, ctx));
  const occurredAt = instant(body.occurredAt, 'occurredAt');
  const discoveredAt = instant(body.discoveredAt, 'discoveredAt') ?? new Date().toISOString();
  checkDiscovery(occurredAt, discoveredAt);

  const pair = notifiablePair(bool(body.notifiable, true), 'OPEN');
  const reference = await allocateReference(client, ctx, 'BR', 'PDPO-BR');

  const res = await client.query(
    `INSERT INTO pdpo_breaches
       (tenant_id, company_id, reference, title, nature, severity, occurred_at, discovered_at,
        notification_window_hours, data_categories, affected_subjects, affected_records,
        likely_consequences, containment_measures, notifiable, status, reported_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,$14,$15,$16,$17)
     RETURNING ${BREACH_COLUMNS}`,
    [
      ctx.tenantId ?? null, companyId, reference,
      requiredText(body.title, 'title', 200),
      requiredText(body.nature, 'nature', 4000),
      oneOf(body.severity, BREACH_SEVERITIES, 'severity', 'MEDIUM'),
      occurredAt, discoveredAt,
      integer(body.notificationWindowHours, 'notificationWindowHours', stored.breachNotificationHours, 1, 720),
      manyOf(body.dataCategories, DATA_CATEGORIES, 'dataCategories'),
      integer(body.affectedSubjects, 'affectedSubjects', 0, 0, 2_147_483_647),
      integer(body.affectedRecords, 'affectedRecords', 0, 0, 2_147_483_647),
      text(body.likelyConsequences), text(body.containmentMeasures),
      pair.notifiable, pair.status,
      num(body.reportedBy) ?? ctx.userId ?? null,
    ]
  );
  const created = breachView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'create', 'compliance.breach', created.id, null,
    created as unknown as Record<string, unknown>,
    { reference: created.reference, severity: created.severity, notifiable: created.notifiable }
  );
  return created;
}

export async function updateBreach(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<BreachView> {
  const companyId = requireCompany(ctx);
  const before = await readBreach(client, companyId, id);
  if (before.status === 'CLOSED') {
    throw conflict(`${before.reference} is closed. Reopen it first if the assessment has changed.`);
  }
  // REPORTED and CLOSED are outcomes with their own evidence, so they are
  // reached through their own calls rather than by sending a status.
  const requestedStatus = body.status === undefined
    ? before.status
    : oneOf(body.status, BREACH_OPEN_STATUSES, 'status');
  const pair = notifiablePair(
    body.notifiable === undefined ? before.notifiable : bool(body.notifiable, before.notifiable),
    requestedStatus
  );

  const occurredAt = body.occurredAt === undefined ? before.occurredAt : instant(body.occurredAt, 'occurredAt');
  const discoveredAt = body.discoveredAt === undefined
    ? before.discoveredAt
    : instant(body.discoveredAt, 'discoveredAt');
  checkDiscovery(occurredAt, discoveredAt);

  const res = await client.query(
    `UPDATE pdpo_breaches
        SET title = $3, nature = $4, severity = $5, occurred_at = $6, discovered_at = $7,
            notification_window_hours = $8, data_categories = $9::text[], affected_subjects = $10,
            affected_records = $11, likely_consequences = $12, containment_measures = $13,
            notifiable = $14, status = $15, subject_notified_at = $16
      WHERE company_id = $1 AND id = $2
      RETURNING ${BREACH_COLUMNS}`,
    [
      companyId, id,
      body.title === undefined ? before.title : requiredText(body.title, 'title', 200),
      body.nature === undefined ? before.nature : requiredText(body.nature, 'nature', 4000),
      body.severity === undefined ? before.severity : oneOf(body.severity, BREACH_SEVERITIES, 'severity'),
      occurredAt, discoveredAt,
      body.notificationWindowHours === undefined
        ? before.notificationWindowHours
        : integer(body.notificationWindowHours, 'notificationWindowHours', before.notificationWindowHours, 1, 720),
      body.dataCategories === undefined ? before.dataCategories : manyOf(body.dataCategories, DATA_CATEGORIES, 'dataCategories'),
      body.affectedSubjects === undefined
        ? before.affectedSubjects
        : integer(body.affectedSubjects, 'affectedSubjects', 0, 0, 2_147_483_647),
      body.affectedRecords === undefined
        ? before.affectedRecords
        : integer(body.affectedRecords, 'affectedRecords', 0, 0, 2_147_483_647),
      body.likelyConsequences === undefined ? before.likelyConsequences : text(body.likelyConsequences),
      body.containmentMeasures === undefined ? before.containmentMeasures : text(body.containmentMeasures),
      pair.notifiable, pair.status,
      body.subjectNotifiedAt === undefined
        ? before.subjectNotifiedAt
        : instant(body.subjectNotifiedAt, 'subjectNotifiedAt'),
    ]
  );
  const after = breachView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'update', 'compliance.breach', id,
    before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>,
    { reference: after.reference }
  );
  return after;
}

/**
 * Report the breach to the Office.
 *
 * Whether this beat the window is not decided here: the trigger compares
 * notified_at with the deadline it stamped itself, so a late notification is
 * recorded as late whatever the caller believes. A breach already assessed as
 * not notifiable has to be re-assessed as notifiable before it can be reported,
 * because saying both at once is a contradiction the register refuses to hold.
 */
export async function reportBreach(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<BreachView> {
  const companyId = requireCompany(ctx);
  const before = await readBreach(client, companyId, id);
  if (!before.open) throw conflict(`${before.reference} is already ${before.status.toLowerCase()}`);
  if (!before.notifiable) {
    throw badRequest(
      `${before.reference} is recorded as not notifiable. Re-assess it as notifiable before reporting it to the Office.`
    );
  }
  const notifiedAt = instant(body.notifiedAt, 'notifiedAt') ?? new Date().toISOString();

  const res = await client.query(
    `UPDATE pdpo_breaches
        SET status = 'REPORTED', notified_at = $3, notification_reference = $4,
            reported_by = COALESCE(reported_by, $5)
      WHERE company_id = $1 AND id = $2
      RETURNING ${BREACH_COLUMNS}`,
    [companyId, id, notifiedAt, text(body.notificationReference), ctx.userId ?? null]
  );
  const after = breachView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'report', 'compliance.breach', id,
    before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>,
    {
      reference: after.reference,
      lateNotification: after.lateNotification,
      notificationReference: after.notificationReference,
    }
  );
  return after;
}

/**
 * Close the breach. A notifiable breach that was never reported cannot be
 * closed: it either gets reported, or it gets re-assessed as not notifiable,
 * and both of those leave a trace.
 */
export async function closeBreach(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown> = {}
): Promise<BreachView> {
  const companyId = requireCompany(ctx);
  const before = await readBreach(client, companyId, id);
  if (before.status === 'CLOSED') throw conflict(`${before.reference} is already closed`);
  if (before.notifiable && before.notifiedAt === null) {
    throw badRequest(
      `${before.reference} is notifiable and has not been reported. Report it to the Office, or re-assess it as not notifiable, before closing it.`
    );
  }
  const closedAt = instant(body.closedAt, 'closedAt') ?? new Date().toISOString();

  const res = await client.query(
    `UPDATE pdpo_breaches
        SET status = 'CLOSED', closed_at = $3
      WHERE company_id = $1 AND id = $2
      RETURNING ${BREACH_COLUMNS}`,
    [companyId, id, closedAt]
  );
  const after = breachView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'close', 'compliance.breach', id,
    before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>,
    { reference: after.reference }
  );
  return after;
}

/**
 * Remove a breach logged in error. Only a breach that is still open and has not
 * been reported can go, for the same reason a subject request can only be
 * deleted before it has been acted on: a notification that reached the Office
 * cannot be un-sent by deleting our copy of it.
 */
export async function deleteBreach(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number
): Promise<{ id: number; deleted: boolean }> {
  const companyId = requireCompany(ctx);
  const before = await readBreach(client, companyId, id);
  if (!before.open) {
    throw badRequest(`${before.reference} is ${before.status.toLowerCase()} and cannot be deleted`);
  }
  if (before.notifiedAt !== null) {
    throw badRequest(`${before.reference} has already been reported to the Office, so it cannot be deleted`);
  }
  const references = await scalar(
    client,
    `SELECT count(*)::int AS c FROM pdpo_submissions
      WHERE company_id = $1 AND related_table = 'pdpo_breaches' AND related_id = $2`,
    [companyId, id]
  );
  if (references > 0) throw badRequest('A filing refers to this breach, so it cannot be deleted');

  await client.query('DELETE FROM pdpo_breaches WHERE company_id = $1 AND id = $2', [companyId, id]);
  await auditConfig(
    client, ctx, 'delete', 'compliance.breach', id,
    before as unknown as Record<string, unknown>, null, { reference: before.reference }
  );
  return { id, deleted: true };
}
// ------------------------------------------------------------ filing ledger
/**
 * The filing ledger: one row per thing sent to the Office, of any kind.
 *
 * This is the cover sheet an inspection starts from - what was sent, when, by
 * whom, over which channel, and what came back - so the transitions are one-way
 * and evidenced: a draft is filed, a filing is acknowledged or rejected, and
 * none of those steps is reversible by editing the row. A draft may be edited
 * freely and deleted outright, because nothing has left the building yet.
 *
 * Nothing here talks to the Office. The portal address in the configuration is
 * where an operator goes; this register is what proves they went.
 */
export interface SubmissionView {
  id: number;
  submissionType: string;
  subject: string;
  relatedTable: string | null;
  relatedId: number | null;
  channel: string;
  status: string;
  filedAt: string | null;
  filedBy: number | null;
  acknowledgementReference: string | null;
  acknowledgedAt: string | null;
  rejectionReason: string | null;
  /** The regulator-ready extract exactly as it was filed. */
  payload: Record<string, unknown>;
  evidence: Record<string, unknown>;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Still editable: nothing has been sent yet. */
  draft: boolean;
  /** Sent, whatever came back. */
  filed: boolean;
}

export function submissionView(row: Row): SubmissionView {
  const status = String(row.status ?? '');
  const filedAt = iso(row.filed_at);
  return {
    id: Number(row.id),
    submissionType: String(row.submission_type ?? ''),
    subject: String(row.subject ?? ''),
    relatedTable: text(row.related_table),
    relatedId: num(row.related_id),
    channel: String(row.channel ?? ''),
    status,
    filedAt,
    filedBy: num(row.filed_by),
    acknowledgementReference: text(row.acknowledgement_reference),
    acknowledgedAt: iso(row.acknowledged_at),
    rejectionReason: text(row.rejection_reason),
    payload: (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>,
    evidence: (row.evidence && typeof row.evidence === 'object' ? row.evidence : {}) as Record<string, unknown>,
    notes: text(row.notes),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    draft: status === 'DRAFT',
    filed: filedAt !== null,
  };
}

const SUBMISSION_COLUMNS = `id, submission_type, subject, related_table, related_id, channel, status,
  filed_at, filed_by, acknowledgement_reference, acknowledged_at, rejection_reason, payload,
  evidence, notes, created_at, updated_at`;

export interface SubmissionListOptions {
  search?: string | null;
  status?: string | null;
  submissionType?: string | null;
  channel?: string | null;
  relatedTable?: string | null;
  relatedId?: number | null;
  limit?: number | null;
  offset?: number | null;
}

export async function listSubmissions(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: SubmissionListOptions = {}
): Promise<Page<SubmissionView>> {
  const companyId = requireCompany(ctx);
  const params: unknown[] = [companyId];
  let where = 'company_id = $1';

  const term = text(opts.search)?.trim();
  if (term) {
    params.push(`%${term}%`);
    where += ` AND (subject ILIKE $${params.length} OR acknowledgement_reference ILIKE $${params.length})`;
  }
  if (opts.status) {
    params.push(oneOf(opts.status, SUBMISSION_STATUSES, 'status'));
    where += ` AND status = $${params.length}`;
  }
  if (opts.submissionType) {
    params.push(oneOf(opts.submissionType, SUBMISSION_TYPES, 'submissionType'));
    where += ` AND submission_type = $${params.length}`;
  }
  if (opts.channel) {
    params.push(oneOf(opts.channel, SUBMISSION_CHANNELS, 'channel'));
    where += ` AND channel = $${params.length}`;
  }
  if (opts.relatedTable) {
    params.push(oneOfExact(opts.relatedTable, RELATED_TABLES, 'relatedTable'));
    where += ` AND related_table = $${params.length}`;
  }
  if (opts.relatedId !== null && opts.relatedId !== undefined) {
    params.push(Number(opts.relatedId));
    where += ` AND related_id = $${params.length}`;
  }

  const limit = pageSize(opts.limit);
  const offset = pageOffset(opts.offset);
  const total = await scalar(client, `SELECT count(*)::int AS c FROM pdpo_submissions WHERE ${where}`, params);
  const res = await client.query(
    `SELECT ${SUBMISSION_COLUMNS} FROM pdpo_submissions
      WHERE ${where}
      ORDER BY (status = 'DRAFT') DESC, COALESCE(filed_at, created_at) DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return { rows: (res.rows as Row[]).map(submissionView), total, limit, offset };
}

async function readSubmission(
  client: pg.PoolClient,
  companyId: number,
  id: number
): Promise<SubmissionView> {
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Filing id is required');
  const res = await client.query(
    `SELECT ${SUBMISSION_COLUMNS} FROM pdpo_submissions WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  if (res.rows.length === 0) throw notFound('Filing not found');
  return submissionView(res.rows[0] as Row);
}

export async function getSubmission(client: pg.PoolClient, ctx: Ctx, id: number): Promise<SubmissionView> {
  return readSubmission(client, requireCompany(ctx), id);
}

/** The registers a filing may point at, so a dangling reference is refused. */
async function assertRelatedExists(
  client: pg.PoolClient,
  companyId: number,
  relatedTable: string | null,
  relatedId: number | null
): Promise<void> {
  if (relatedTable === null && relatedId === null) return;
  if (relatedTable === null || relatedId === null) {
    throw badRequest('relatedTable and relatedId have to be supplied together, or not at all');
  }
  if (relatedTable === 'pdpo_consents') {
    await readConsent(client, companyId, relatedId);
    return;
  }
  const label =
    relatedTable === 'pdpo_breaches' ? 'Breach'
      : relatedTable === 'pdpo_subject_requests' ? 'Subject request'
        : 'Processing activity';
  await loadRow(client, relatedTable, companyId, relatedId, label);
}

/** The related pair as a validated (table, id) pair, or (null, null). */
function relatedPair(body: Record<string, unknown>): { table: string | null; id: number | null } {
  const table = body.relatedTable === undefined
    ? null
    : oneOfExact(body.relatedTable, RELATED_TABLES, 'relatedTable');
  const id = body.relatedId === undefined ? null : num(body.relatedId);
  if ((table === null) !== (id === null)) {
    throw badRequest('relatedTable and relatedId have to be supplied together, or not at all');
  }
  return { table, id };
}

export async function createSubmission(
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<SubmissionView> {
  const companyId = requireCompany(ctx);
  const pair = relatedPair(body);
  await assertRelatedExists(client, companyId, pair.table, pair.id);

  // A filing is created as a draft and only becomes a filing when it is sent,
  // so the status is never taken from the caller.
  const res = await client.query(
    `INSERT INTO pdpo_submissions
       (tenant_id, company_id, submission_type, subject, related_table, related_id, channel,
        status, payload, evidence, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8::jsonb,$9::jsonb,$10)
     RETURNING ${SUBMISSION_COLUMNS}`,
    [
      ctx.tenantId ?? null, companyId,
      oneOf(body.submissionType, SUBMISSION_TYPES, 'submissionType'),
      requiredText(body.subject, 'subject', 400),
      pair.table, pair.id,
      oneOf(body.channel, SUBMISSION_CHANNELS, 'channel', 'PORTAL'),
      JSON.stringify(jsonObject(body.payload, 'payload')),
      JSON.stringify(jsonObject(body.evidence, 'evidence')),
      text(body.notes),
    ]
  );
  const created = submissionView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'create', 'compliance.submission', created.id, null,
    created as unknown as Record<string, unknown>,
    { submissionType: created.submissionType }
  );
  return created;
}

export async function updateSubmission(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<SubmissionView> {
  const companyId = requireCompany(ctx);
  const before = await readSubmission(client, companyId, id);
  if (!before.draft) {
    throw conflict(
      `${before.status === 'REJECTED' ? 'A rejected filing' : 'A filed record'} cannot be edited. Its content is the evidence of what was sent.`
    );
  }
  const pair = body.relatedTable === undefined && body.relatedId === undefined
    ? { table: before.relatedTable, id: before.relatedId }
    : relatedPair(body);
  await assertRelatedExists(client, companyId, pair.table, pair.id);

  const res = await client.query(
    `UPDATE pdpo_submissions
        SET submission_type = $3, subject = $4, related_table = $5, related_id = $6, channel = $7,
            payload = $8::jsonb, evidence = $9::jsonb, notes = $10
      WHERE company_id = $1 AND id = $2
      RETURNING ${SUBMISSION_COLUMNS}`,
    [
      companyId, id,
      body.submissionType === undefined
        ? before.submissionType
        : oneOf(body.submissionType, SUBMISSION_TYPES, 'submissionType'),
      body.subject === undefined ? before.subject : requiredText(body.subject, 'subject', 400),
      pair.table, pair.id,
      body.channel === undefined ? before.channel : oneOf(body.channel, SUBMISSION_CHANNELS, 'channel'),
      JSON.stringify(body.payload === undefined ? before.payload : jsonObject(body.payload, 'payload')),
      JSON.stringify(body.evidence === undefined ? before.evidence : jsonObject(body.evidence, 'evidence')),
      body.notes === undefined ? before.notes : text(body.notes),
    ]
  );
  const after = submissionView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'update', 'compliance.submission', id,
    before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>,
    { submissionType: after.submissionType }
  );
  return after;
}

/**
 * Send the filing.
 *
 * There is no outbound call: the Office publishes no submission API, so filing
 * means an operator sent it through the portal or by post, and this records
 * that they did. What the guard checks is that there is something to file
 * under - an integration row for the company - because a filing with no
 * registered identity behind it is not a filing.
 *
 * filed_at and filed_by are stamped here rather than taken from the payload:
 * who sent it and when is the whole evidential value of the row.
 */
export async function fileSubmission(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown> = {}
): Promise<SubmissionView> {
  const companyId = requireCompany(ctx);
  const before = await readSubmission(client, companyId, id);
  if (!before.draft) throw conflict(`${before.status === 'FILED' ? 'This filing has' : 'This record has'} already been filed`);
  if (ctx.userId == null) throw badRequest('A filing has to record who sent it, and no user is in context');
  const integration = await getPdpoIntegration(client, ctx);
  if (!integration) {
    throw badRequest('Configure the PDPO integration before filing, so the filing has a registration to be attributed to');
  }

  const res = await client.query(
    `UPDATE pdpo_submissions
        SET status = 'FILED', filed_at = now(), filed_by = $3,
            payload = $4::jsonb,
            evidence = $5::jsonb,
            notes = COALESCE($6, notes)
      WHERE company_id = $1 AND id = $2
      RETURNING ${SUBMISSION_COLUMNS}`,
    [
      companyId, id, ctx.userId,
      JSON.stringify(body.payload === undefined ? before.payload : jsonObject(body.payload, 'payload')),
      JSON.stringify(body.evidence === undefined ? before.evidence : jsonObject(body.evidence, 'evidence')),
      body.notes === undefined ? null : text(body.notes),
    ]
  );
  const after = submissionView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'file', 'compliance.submission', id,
    before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>,
    { submissionType: after.submissionType, channel: after.channel }
  );
  return after;
}

/** Record the Office's acknowledgement, which is what closes the loop. */
export async function acknowledgeSubmission(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown> = {}
): Promise<SubmissionView> {
  const companyId = requireCompany(ctx);
  const before = await readSubmission(client, companyId, id);
  if (before.status === 'ACKNOWLEDGED') throw conflict('This filing has already been acknowledged');
  if (before.filedAt === null) throw conflict('A filing that has not been sent cannot be acknowledged');
  if (before.status === 'REJECTED') throw conflict('This filing was rejected; re-file it as a new draft');

  const reference = text(body.acknowledgementReference) ?? before.acknowledgementReference;
  if (reference === null) {
    throw badRequest('acknowledgementReference is required: it is the Office\u2019s own reference for the filing');
  }
  const acknowledgedAt = instant(body.acknowledgedAt, 'acknowledgedAt') ?? new Date().toISOString();

  const res = await client.query(
    `UPDATE pdpo_submissions
        SET status = 'ACKNOWLEDGED', acknowledged_at = $3, acknowledgement_reference = $4
      WHERE company_id = $1 AND id = $2
      RETURNING ${SUBMISSION_COLUMNS}`,
    [companyId, id, acknowledgedAt, reference]
  );
  const after = submissionView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'acknowledge', 'compliance.submission', id,
    before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>,
    { acknowledgementReference: after.acknowledgementReference }
  );
  return after;
}

/** Record that the Office refused the filing, with the reason it gave. */
export async function rejectSubmission(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  body: Record<string, unknown>
): Promise<SubmissionView> {
  const companyId = requireCompany(ctx);
  const before = await readSubmission(client, companyId, id);
  if (before.filedAt === null) throw conflict('A filing that has not been sent cannot be rejected');
  if (before.status === 'REJECTED') throw conflict('This filing has already been rejected');
  const rejectionReason = requiredText(body.rejectionReason ?? body.reason, 'rejectionReason', 2000);

  const res = await client.query(
    `UPDATE pdpo_submissions
        SET status = 'REJECTED', rejection_reason = $3,
            acknowledgement_reference = COALESCE($4, acknowledgement_reference)
      WHERE company_id = $1 AND id = $2
      RETURNING ${SUBMISSION_COLUMNS}`,
    [companyId, id, rejectionReason, text(body.acknowledgementReference)]
  );
  const after = submissionView(res.rows[0] as Row);
  await auditConfig(
    client, ctx, 'reject', 'compliance.submission', id,
    before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>,
    { rejectionReason }
  );
  return after;
}

/** Delete a draft. Once sent, the row is the proof that it was sent. */
export async function deleteSubmission(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number
): Promise<{ id: number; deleted: boolean }> {
  const companyId = requireCompany(ctx);
  const before = await readSubmission(client, companyId, id);
  if (!before.draft) {
    throw badRequest('Only a draft filing can be deleted. A sent filing is the evidence that it was sent.');
  }
  await client.query('DELETE FROM pdpo_submissions WHERE company_id = $1 AND id = $2', [companyId, id]);
  await auditConfig(
    client, ctx, 'delete', 'compliance.submission', id,
    before as unknown as Record<string, unknown>, null, { submissionType: before.submissionType }
  );
  return { id, deleted: true };
}
