/**
 * Personal Data Protection Office (PDPO) workspace.
 *
 * The Data Protection and Privacy Act, 2019 asks a controller to be able to
 * show, on demand, four things: what personal data it processes and why, what
 * consent it holds, how it answered a data subject who wrote in, and what it
 * did when personal data was breached. Those are the registers on this screen;
 * the fifth tab is the ledger of what has actually been filed with the Office.
 *
 * The screen is deliberately a register and not a workflow. Every row is
 * written by a named person, every change is audited, and the statutory clocks
 * - the window for answering a subject request and the 72-hour breach window -
 * are stamped by the database when the row is written. So what is shown here is
 * what the register will be able to prove to an inspector, not a summary that
 * could drift from it.
 *
 * Two things are absent on purpose. There is no outbound submission call,
 * because the Office publishes no submission API: filing means an operator sent
 * it and recorded that they did. And there is no way to edit a row once it has
 * been answered, reported or filed, because at that point the row is the
 * evidence rather than the plan.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { can, useAuth } from '../auth';
import { navigate, useHashQuery } from '../router';
import { ErrorBanner, Modal, Pager } from '../components/ui';
import { ConfirmDialog, EmptyState, Skeleton } from '../components/os';

type Page<T> = { rows: T[]; total: number; limit: number; offset: number };

/** Mirrors services/pdpo/config.ts. Never carries secret material. */
type PdpoConfigView = {
  configured: boolean;
  integrationId: number | null;
  name: string | null;
  status: string;
  isActive: boolean;
  environment: 'SANDBOX' | 'PRODUCTION';
  registrationNumber: string | null;
  registrationExpiresOn: string | null;
  registrationState: 'UNREGISTERED' | 'REGISTERED' | 'EXPIRING' | 'EXPIRED';
  registrationDaysRemaining: number | null;
  dpoName: string | null;
  dpoEmail: string | null;
  dpoPhone: string | null;
  portalBaseUrl: string | null;
  breachNotificationHours: number;
  subjectRequestDays: number;
  portalApiKeyPresent: boolean;
  lastTestedAt: string | null;
  readyToFile: boolean;
};

type PdpoStatusTotals = {
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
};

type PdpoStatusView = {
  config: PdpoConfigView;
  totals: PdpoStatusTotals;
  warnings: string[];
  nextRequestDueAt: string | null;
  nextBreachDueAt: string | null;
  lastFiledAt: string | null;
};

type PdpoConnectionCheck = { key: string; label: string; ok: boolean; detail: string; critical: boolean };

type PdpoConnectionTestResult = {
  ok: boolean;
  status: 'CONNECTED' | 'ERROR';
  testedAt: string;
  checks: PdpoConnectionCheck[];
  config: PdpoConfigView;
};

type ProcessingActivity = {
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
  createdAt: string | null;
  updatedAt: string | null;
};

type Consent = {
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
};

type SubjectRequest = {
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
  open: boolean;
  overdue: boolean;
  daysRemaining: number | null;
};

type Breach = {
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
  lateNotification: boolean;
  subjectNotifiedAt: string | null;
  reportedBy: number | null;
  closedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  open: boolean;
  overdue: boolean;
  hoursRemaining: number | null;
};

type Filing = {
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
  payload: Record<string, unknown>;
  evidence: Record<string, unknown>;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  draft: boolean;
  filed: boolean;
};

// ------------------------------------------------------------- vocabularies
// Copied from services/pdpo/ops.ts so the pickers offer exactly what the API
// will accept. A value the register refuses is never offered here.

const LAWFUL_BASES = [
  'CONSENT', 'CONTRACT', 'LEGAL_OBLIGATION', 'VITAL_INTERESTS', 'PUBLIC_TASK', 'LEGITIMATE_INTERESTS',
] as const;
const DATA_CATEGORIES = [
  'IDENTIFIERS', 'CONTACT', 'FINANCIAL', 'EMPLOYMENT', 'HEALTH', 'BIOMETRIC', 'GENETIC',
  'CRIMINAL', 'CHILDREN', 'LOCATION', 'BEHAVIOURAL', 'TECHNICAL', 'SPECIAL_CATEGORY', 'OTHER',
] as const;
const ACTIVITY_SUBJECTS = [
  'CUSTOMERS', 'EMPLOYEES', 'APPLICANTS', 'SUPPLIERS', 'CONTRACTORS', 'NEXT_OF_KIN',
  'WEBSITE_VISITORS', 'PATIENTS', 'STUDENTS', 'OTHER',
] as const;
const DATA_SUBJECT_TYPES = [
  'CUSTOMER', 'EMPLOYEE', 'APPLICANT', 'SUPPLIER_CONTACT', 'WEBSITE_VISITOR', 'OTHER',
] as const;
const ACTIVITY_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED'] as const;
const CONSENT_CHANNELS = ['WEB_FORM', 'SIGNED_FORM', 'EMAIL', 'PHONE', 'PORTAL', 'IN_PERSON'] as const;
const REQUEST_TYPES = ['ACCESS', 'CORRECTION', 'ERASURE', 'OBJECTION', 'RESTRICTION', 'PORTABILITY'] as const;
const REQUEST_OPEN_STATUSES = ['RECEIVED', 'IN_PROGRESS', 'AWAITING_SUBJECT', 'EXTENDED'] as const;
const BREACH_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const BREACH_OPEN_STATUSES = ['OPEN', 'CONTAINED'] as const;
const SUBMISSION_TYPES = [
  'REGISTRATION', 'RENEWAL', 'BREACH_NOTIFICATION', 'SUBJECT_REQUEST_RESPONSE',
  'ANNUAL_RETURN', 'CONSENT_WITHDRAWAL_REPORT', 'OTHER',
] as const;
const SUBMISSION_CHANNELS = ['PORTAL', 'EMAIL', 'POST', 'IN_PERSON'] as const;
const RELATED_TABLES = [
  'pdpo_breaches', 'pdpo_subject_requests', 'pdpo_processing_activities', 'pdpo_consents',
] as const;

const SECTIONS = ['overview', 'activities', 'consents', 'requests', 'breaches', 'filings', 'config'] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_META: Record<Section, { label: string; perm: string; blurb: string }> = {
  overview: { label: 'Overview', perm: 'compliance.pdpo.view', blurb: 'Where the register stands and what is due next.' },
  activities: { label: 'Processing', perm: 'compliance.processing_activities.view', blurb: 'What personal data is processed, why, and how long it is kept.' },
  consents: { label: 'Consents', perm: 'compliance.consents.view', blurb: 'Consent held per data subject and purpose, and every withdrawal.' },
  requests: { label: 'Subject requests', perm: 'compliance.subject_requests.view', blurb: 'Access, correction, erasure and the rest, with the statutory clock.' },
  breaches: { label: 'Breaches', perm: 'compliance.breaches.view', blurb: 'Personal data breaches and whether the Office was notified in time.' },
  filings: { label: 'Filings', perm: 'compliance.pdpo.view', blurb: 'What has been filed with the Office, in draft and as sent.' },
  config: { label: 'Configuration', perm: 'compliance.pdpo.manage', blurb: 'The identity the company files under and its statutory windows.' },
};

const LIST_SIZES = [25, 50, 100, 200];

// ------------------------------------------------------------------ helpers

const dash = '\u2014';

/** An instant as a person reads it. */
function when(v: string | null | undefined): string {
  if (!v) return dash;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return dash;
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** A date without the time, for windows measured in days. */
function day(v: string | null | undefined): string {
  if (!v) return dash;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return dash;
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** The value a <input type="date"> round-trips. */
function dayInput(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** How a deadline reads: days left, or how far past it is. */
function dueIn(days: number | null): string {
  if (days === null) return 'no deadline set';
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} past due`;
  if (days === 0) return 'due today';
  return `${days} day${days === 1 ? '' : 's'} left`;
}

/** The same, for the 72-hour breach clock. */
function dueInHours(hours: number | null): string {
  if (hours === null) return 'no deadline set';
  if (hours < 0) return `${Math.abs(hours)}h past due`;
  if (hours < 1) return 'due within the hour';
  return `${Math.round(hours)}h left`;
}

const titleCaseWords = (v: string | null | undefined): string =>
  v === null || v === undefined || v === '' ? dash : v.replace(/_/g, ' ');

/** Parse an evidence/payload box, refusing anything that is not a JSON object. */
function parseJson(raw: string, label: string): Record<string, unknown> {
  const s = raw.trim();
  if (s === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

const TONES: Record<string, string> = {
  DRAFT: 'badge-neutral',
  ACTIVE: 'badge-green',
  SUSPENDED: 'badge-amber',
  RETIRED: 'badge-neutral',
  GRANTED: 'badge-green',
  WITHDRAWN: 'badge-amber',
  EXPIRED: 'badge-neutral',
  RECEIVED: 'badge-blue',
  IN_PROGRESS: 'badge-blue',
  AWAITING_SUBJECT: 'badge-amber',
  EXTENDED: 'badge-amber',
  COMPLETED: 'badge-green',
  REFUSED: 'badge-red',
  OPEN: 'badge-red',
  CONTAINED: 'badge-amber',
  REPORTED: 'badge-blue',
  NOT_NOTIFIABLE: 'badge-neutral',
  CLOSED: 'badge-green',
  FILED: 'badge-blue',
  ACKNOWLEDGED: 'badge-green',
  REJECTED: 'badge-red',
  LOW: 'badge-neutral',
  MEDIUM: 'badge-amber',
  HIGH: 'badge-red',
  CRITICAL: 'badge-critical',
};

function Chip({ value, tone }: { value: string; tone?: string }) {
  return (
    <span className={`badge ${tone ?? TONES[value] ?? 'badge-neutral'}`}>
      <span className="badge-icon" aria-hidden>{'\u25CF'}</span>
      {titleCaseWords(value)}
    </span>
  );
}

function Detail({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div className={mono ? 'cell-mono' : undefined} style={{ marginTop: 2 }}>{value ?? dash}</div>
    </div>
  );
}

function Field({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="muted" style={{ fontSize: 12 }}>{hint}</span>}
    </div>
  );
}

function CheckGroup({
  options, value, onChange, labels,
}: {
  options: readonly string[];
  value: string[];
  onChange: (v: string[]) => void;
  labels?: Record<string, string>;
}) {
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o]);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            className={`btn btn-sm ${on ? 'btn-primary' : 'btn-ghost'}`}
            aria-pressed={on}
            onClick={() => toggle(o)}
          >
            {labels?.[o] ?? titleCaseWords(o)}
          </button>
        );
      })}
    </div>
  );
}

/** Fetch one register page, re-running whenever the caller's key changes. */
function useRegister<T>(path: string, query: string, enabled: boolean, key: number) {
  const [page, setPage] = useState<Page<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) {
      setPage(null);
      setLoading(false);
      setError('');
      return;
    }
    let live = true;
    setLoading(true);
    setError('');
    api<{ data: Page<T> }>(query ? `${path}?${query}` : path)
      .then((r) => { if (live) setPage(r.data ?? null); })
      .catch((e) => {
        if (live) {
          setPage(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [path, query, enabled, key]);
  return { page, loading, error };
}

/** Paging read from and written back to the address bar, so a link is shareable. */
function usePaging(q: URLSearchParams, write: (patch: Record<string, string | number | undefined>) => void) {
  const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
  const sizeParam = Number(q.get('size'));
  const pageSize = LIST_SIZES.includes(sizeParam) ? sizeParam : 25;
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    setPage: (n: number) => write({ page: n === 1 ? undefined : n }),
    setSize: (n: number) => write({ size: n === 25 ? undefined : n, page: undefined }),
  };
}

type DeskProps = {
  q: URLSearchParams;
  write: (patch: Record<string, string | number | undefined>) => void;
  reloadKey: number;
  busy: boolean;
  commit: (ok: string, fn: () => Promise<unknown>) => Promise<boolean>;
  /**
   * A message for the header banner. Used where the outcome needs saying in
   * more than the single line commit() can guess - a register row that was
   * retired rather than deleted, for instance.
   */
  notify: (message: string) => void;
};

const sectionFromPath = (path: string): Section => {
  const parts = path.split('/').filter(Boolean);
  const candidate = parts[1] ?? '';
  return (SECTIONS as readonly string[]).includes(candidate) ? (candidate as Section) : 'overview';
};

// ------------------------------------------------------------------- frame
/**
 * The frame every register shares: the skeleton, then the error, then the empty
 * state, then the rows. Holding it in one place is what stops an empty consent
 * register from reading like a different product to an empty breach register.
 *
 * Both renderings of the rows are built eagerly - the mobile cards and the
 * desktop table - because the stylesheet decides which one a visitor sees, and
 * a stylesheet cannot ask a component to render itself twice.
 */
function RegisterList<T>({
  state, paging, empty, filtered, onClearFilters, cards, table,
}: {
  state: { loading: boolean; error: string; page: Page<T> | null };
  paging: { page: number; pageSize: number; setPage: (n: number) => void; setSize: (n: number) => void };
  empty: { title: string; body: string };
  filtered: boolean;
  onClearFilters: () => void;
  cards: ReactNode;
  table: ReactNode;
}) {
  if (state.loading) return <Skeleton rows={6} />;
  if (state.error) return <ErrorBanner error={state.error} />;
  if ((state.page?.rows.length ?? 0) === 0) {
    return filtered ? (
      <EmptyState
        title="Nothing matches these filters"
        body="The register itself is not empty. The filters are narrowing it, so clear them to see everything."
        action="Clear filters"
        onAction={onClearFilters}
      />
    ) : (
      <EmptyState title={empty.title} body={empty.body} />
    );
  }
  return (
    <>
      <div className="record-cards mobile-only">{cards}</div>
      <div className="table-wrap desktop-only">{table}</div>
      <Pager
        page={paging.page}
        pageSize={paging.pageSize}
        total={state.page?.total ?? 0}
        onPage={paging.setPage}
        onPageSize={paging.setSize}
        pageSizes={LIST_SIZES}
      />
    </>
  );
}

/** The filter row above a register. */
function FilterBar({ children, filtered, onClear }: { children: ReactNode; filtered: boolean; onClear: () => void }) {
  return (
    <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
      {children}
      {filtered && (
        <button className="btn btn-sm btn-ghost" onClick={onClear}>Clear filters</button>
      )}
    </div>
  );
}

/**
 * A search box that writes to the address bar when it is submitted, not on
 * every keystroke. A register read is a database round trip, and firing one per
 * character would make the screen feel slower the faster somebody types.
 */
function SearchBox({ value, label, placeholder, onSearch }: {
  value: string;
  label: string;
  placeholder: string;
  onSearch: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <form
      role="search"
      onSubmit={(e) => { e.preventDefault(); onSearch(draft.trim()); }}
      style={{ display: 'flex', gap: 6, alignItems: 'center' }}
    >
      <input
        className="search-input"
        style={{ maxWidth: 260 }}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button className="btn btn-sm" type="submit">Search</button>
    </form>
  );
}

/**
 * A number box for the filters that take an identifier rather than a word: a
 * consent names the processing activity it was taken under, and the only useful
 * way to ask for one activity's consents is by its id.
 */
function NumberFilter({ value, label, placeholder, applyLabel = 'Apply', onApply }: {
  value: string;
  label: string;
  placeholder: string;
  applyLabel?: string;
  onApply: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <form
      role="search"
      onSubmit={(e) => { e.preventDefault(); onApply(draft.trim()); }}
      style={{ display: 'flex', gap: 6, alignItems: 'center' }}
    >
      <input
        className="search-input"
        style={{ maxWidth: 160 }}
        type="number"
        inputMode="numeric"
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button className="btn btn-sm" type="submit">{applyLabel}</button>
    </form>
  );
}

/** A labelled dropdown, offering only values the register will accept. */
function Select({ value, onChange, options, label, placeholder, labels, width = 190 }: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  label: string;
  placeholder: string;
  labels?: Record<string, string>;
  width?: number;
}) {
  return (
    <select
      className="search-input"
      style={{ maxWidth: width }}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o} value={o}>{labels?.[o] ?? titleCaseWords(o)}</option>
      ))}
    </select>
  );
}

/** A checkbox that says what it does in words, for the boolean filters. */
function FlagToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="badge badge-neutral" style={{ cursor: 'pointer', gap: 6, padding: '4px 10px' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** One number on the overview, with the sentence that stops it being misread. */
function StatCard({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: string }) {
  return (
    <div className="kpi-card">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value.toLocaleString()}
      </span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
}

/** The facts grid shared by a register's expanded row and its mobile card. */
function Facts({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
      {children}
    </div>
  );
}

/** A free-text note about a stored JSON blob, guarded so it cannot leak a wall of JSON. */
function JsonNote({ label, value }: { label: string; value: Record<string, unknown> }) {
  const keys = Object.keys(value ?? {});
  return <Detail label={label} value={keys.length === 0 ? 'Nothing recorded' : `${keys.length} field${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}`} />;
}

/**
 * A confirm dialog that also collects the reason the register wants. Refusals,
 * rejections and withdrawals all have to state why, and a dialog without a
 * reason box would just move that failure to the server.
 */
function ReasonDialog({
  title, body, label, confirmLabel, danger, required, extra, busy, onCancel, onConfirm,
}: {
  title: string;
  body: string;
  label: string;
  confirmLabel: string;
  danger?: boolean;
  required?: boolean;
  extra?: ReactNode;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const blocked = Boolean(required) && reason.trim() === '';
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy || blocked}
            title={blocked ? `${label} is required` : undefined}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="muted">{body}</p>
      {extra}
      <Field label={label} id="pdpo-reason">
        <textarea
          id="pdpo-reason"
          className="search-input"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      {required && (
        <p className="muted" style={{ fontSize: 12 }}>
          This is recorded on the row and cannot be edited afterwards, so write what the register
          should still be able to show later.
        </p>
      )}
    </Modal>
  );
}

// ------------------------------------------------------ record of processing
/** A register state explained, so a picker does not offer four bare words. */
const ACTIVITY_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft - written but not yet in force',
  ACTIVE: 'Active - this processing happens now',
  SUSPENDED: 'Suspended - stopped, not yet closed',
  RETIRED: 'Retired - no longer processed',
};

/** The RoPA fields that are not a code, a name or a status. */
function ActivityFacts({ activity }: { activity: ProcessingActivity }) {
  return (
    <Facts>
      <Detail label="Purpose" value={activity.purpose} />
      <Detail label="Recipients" value={activity.recipients} />
      <Detail label="Retention" value={activity.retentionPeriod} />
      <Detail label="Security measures" value={activity.securityMeasures} />
      <Detail
        label="Transfers outside the country"
        value={
          activity.transferCountries.length === 0
            ? 'None recorded'
            : `${activity.transferCountries.join(', ')}${activity.transferSafeguards ? ` (${activity.transferSafeguards})` : ' with no safeguards recorded'}`
        }
      />
      <Detail
        label="Impact assessment"
        value={activity.dpiaCompleted ? 'Completed' : 'Not completed'}
      />
      <Detail label="Owner" value={activity.ownerUserId === null ? 'Not assigned' : `User #${activity.ownerUserId}`} />
      <Detail label="Last reviewed" value={activity.lastReviewedAt ? day(activity.lastReviewedAt) : 'Never reviewed'} />
      <Detail label="Review due" value={activity.reviewDueAt ? day(activity.reviewDueAt) : 'No review date set'} />
      <Detail label="Written" value={when(activity.createdAt)} />
      <Detail label="Last changed" value={when(activity.updatedAt)} />
    </Facts>
  );
}

/**
 * The RoPA editor.
 *
 * Cross-border is not a checkbox here. Naming a destination country is what
 * makes a transfer a transfer, and the database CHECK enforces exactly that, so
 * the screen offers the list of countries and lets the flag follow it. A tick
 * box with no destination beside it would be an assertion the register could
 * not support.
 */
function ActivityDialog({ activity, busy, error, onClose, onSave }: {
  activity: ProcessingActivity | 'new';
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const current = activity === 'new' ? null : activity;
  const [code, setCode] = useState(current?.code ?? '');
  const [name, setName] = useState(current?.name ?? '');
  const [purpose, setPurpose] = useState(current?.purpose ?? '');
  const [lawfulBasis, setLawfulBasis] = useState(current?.lawfulBasis ?? 'CONSENT');
  const [dataCategories, setDataCategories] = useState<string[]>(current?.dataCategories ?? []);
  const [subjectCategories, setSubjectCategories] = useState<string[]>(current?.subjectCategories ?? []);
  const [recipients, setRecipients] = useState(current?.recipients ?? '');
  const [retentionPeriod, setRetentionPeriod] = useState(current?.retentionPeriod ?? '');
  const [countries, setCountries] = useState((current?.transferCountries ?? []).join(', '));
  const [transferSafeguards, setTransferSafeguards] = useState(current?.transferSafeguards ?? '');
  const [securityMeasures, setSecurityMeasures] = useState(current?.securityMeasures ?? '');
  const [dpiaCompleted, setDpiaCompleted] = useState(current?.dpiaCompleted ?? false);
  const [ownerUserId, setOwnerUserId] = useState(
    current?.ownerUserId === null || current?.ownerUserId === undefined ? '' : String(current.ownerUserId)
  );
  const [status, setStatus] = useState(current?.status ?? 'ACTIVE');
  const [lastReviewedAt, setLastReviewedAt] = useState(dayInput(current?.lastReviewedAt));
  const [reviewDueAt, setReviewDueAt] = useState(dayInput(current?.reviewDueAt));
  const [problem, setProblem] = useState('');

  const destinations = countries.split(',').map((c) => c.trim()).filter(Boolean);

  const submit = () => {
    if (code.trim() === '') return setProblem('A code is required. It is how the rest of the register cites this activity.');
    if (name.trim() === '') return setProblem('A name is required.');
    if (purpose.trim() === '') return setProblem('The purpose is required. An activity with no stated purpose cannot be reviewed or defended.');
    if (destinations.length === 0 && transferSafeguards.trim() !== '') {
      return setProblem('Safeguards were described but no destination country was named, so there is no transfer to protect.');
    }
    setProblem('');
    onSave({
      code: code.trim(),
      name: name.trim(),
      purpose: purpose.trim(),
      lawfulBasis,
      dataCategories,
      subjectCategories,
      recipients: recipients.trim() || null,
      retentionPeriod: retentionPeriod.trim() || null,
      transferCountries: destinations,
      transferSafeguards: destinations.length === 0 ? null : (transferSafeguards.trim() || null),
      securityMeasures: securityMeasures.trim() || null,
      dpiaCompleted,
      ownerUserId: ownerUserId.trim() === '' ? null : Number(ownerUserId),
      status,
      lastReviewedAt: lastReviewedAt === '' ? null : lastReviewedAt,
      reviewDueAt: reviewDueAt === '' ? null : reviewDueAt,
    });
  };

  return (
    <Modal
      title={activity === 'new' ? 'Add a processing activity' : `Edit ${current?.code ?? 'activity'}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {activity === 'new' ? 'Add to register' : 'Save changes'}
          </button>
        </>
      }
    >
      {error && <ErrorBanner error={error} />}
      {problem && <ErrorBanner error={problem} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="Code" id="act-code" hint="Short and stable, for example PAYROLL or CRM-MARKETING.">
          <input id="act-code" className="search-input" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Name" id="act-name">
          <input id="act-name" className="search-input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Lawful basis" id="act-basis" hint="Why the Act permits this processing at all.">
          <select id="act-basis" className="search-input" value={lawfulBasis} onChange={(e) => setLawfulBasis(e.target.value)}>
            {LAWFUL_BASES.map((b) => <option key={b} value={b}>{titleCaseWords(b)}</option>)}
          </select>
        </Field>
        <Field label="Status" id="act-status">
          <select id="act-status" className="search-input" value={status} onChange={(e) => setStatus(e.target.value)}>
            {ACTIVITY_STATUSES.map((s) => <option key={s} value={s}>{ACTIVITY_STATUS_LABELS[s] ?? s}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Purpose" id="act-purpose" hint="What the processing is for, and why it is necessary.">
        <textarea id="act-purpose" className="search-input" rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </Field>

      <Field label="Categories of personal data">
        <CheckGroup options={DATA_CATEGORIES} value={dataCategories} onChange={setDataCategories} />
      </Field>

      <Field label="Categories of data subject">
        <CheckGroup options={ACTIVITY_SUBJECTS} value={subjectCategories} onChange={setSubjectCategories} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="Recipients" id="act-recipients" hint="Who the data is disclosed to.">
          <input id="act-recipients" className="search-input" value={recipients} onChange={(e) => setRecipients(e.target.value)} />
        </Field>
        <Field label="Retention period" id="act-retention" hint="How long it is kept, as the retention policy states it.">
          <input id="act-retention" className="search-input" value={retentionPeriod} onChange={(e) => setRetentionPeriod(e.target.value)} />
        </Field>
        <Field label="Owner (user id)" id="act-owner" hint="The person answerable for this activity.">
          <input id="act-owner" className="search-input" inputMode="numeric" value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)} />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="Last reviewed" id="act-reviewed">
          <input id="act-reviewed" className="search-input" type="date" value={lastReviewedAt} onChange={(e) => setLastReviewedAt(e.target.value)} />
        </Field>
        <Field label="Next review due" id="act-review-due" hint="When this entry is next checked for accuracy.">
          <input id="act-review-due" className="search-input" type="date" value={reviewDueAt} onChange={(e) => setReviewDueAt(e.target.value)} />
        </Field>
      </div>

      <h3 style={{ marginTop: 18 }}>Transfers outside the country</h3>
      <p className="muted">
        Naming a destination is what makes this a restricted transfer, so there is no separate
        cross-border switch to set. Leave the list empty if nothing leaves the country.
      </p>
      <Field label="Destination countries" id="act-countries" hint="Comma separated, for example Kenya, South Africa.">
        <input id="act-countries" className="search-input" value={countries} onChange={(e) => setCountries(e.target.value)} />
      </Field>
      <Field label="Transfer safeguards" id="act-safeguards" hint="The contract, adequacy decision or consent relied on.">
        <input
          id="act-safeguards"
          className="search-input"
          disabled={destinations.length === 0}
          placeholder={destinations.length === 0 ? 'Name a destination first' : ''}
          value={transferSafeguards}
          onChange={(e) => setTransferSafeguards(e.target.value)}
        />
      </Field>

      <h3 style={{ marginTop: 18 }}>Assessment and controls</h3>
      <Field label="Security measures" id="act-security" hint="Encryption, access control, and the rest of what protects this data.">
        <textarea id="act-security" className="search-input" rows={2} value={securityMeasures} onChange={(e) => setSecurityMeasures(e.target.value)} />
      </Field>
      <label className="badge badge-neutral" style={{ cursor: 'pointer', gap: 6, padding: '4px 10px' }}>
        <input type="checkbox" checked={dpiaCompleted} onChange={(e) => setDpiaCompleted(e.target.checked)} />
        A data protection impact assessment has been completed for this activity
      </label>
    </Modal>
  );
}

/**
 * The record of processing activities - the accountability register the Act
 * expects a controller to hold and to be able to produce.
 */
function ActivitiesPanel({ q, write, reloadKey, busy, commit, notify }: DeskProps) {
  const { user } = useAuth();
  const canCreate = can(user, 'compliance.processing_activities.create');
  const canUpdate = can(user, 'compliance.processing_activities.update');
  const canDelete = can(user, 'compliance.processing_activities.delete');

  const search = q.get('q') ?? '';
  const status = q.get('status') ?? '';
  const lawfulBasis = q.get('lawfulBasis') ?? '';
  const dataCategory = q.get('dataCategory') ?? '';
  const subjectCategory = q.get('subjectCategory') ?? '';
  const crossBorder = q.get('crossBorder') ?? '';
  const paging = usePaging(q, write);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (search) p.set('search', search);
    if (status) p.set('status', status);
    if (lawfulBasis) p.set('lawfulBasis', lawfulBasis);
    if (dataCategory) p.set('dataCategory', dataCategory);
    if (subjectCategory) p.set('subjectCategory', subjectCategory);
    if (crossBorder) p.set('crossBorder', crossBorder);
    p.set('limit', String(paging.pageSize));
    p.set('offset', String(paging.offset));
    return p.toString();
  }, [search, status, lawfulBasis, dataCategory, subjectCategory, crossBorder, paging.pageSize, paging.offset]);

  const state = useRegister<ProcessingActivity>('/api/ops/compliance/activities', query, true, reloadKey);
  const rows = state.page?.rows ?? [];

  const [editor, setEditor] = useState<ProcessingActivity | 'new' | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProcessingActivity | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const filtered = Boolean(search || status || lawfulBasis || dataCategory || subjectCategory || crossBorder);
  const clear = () => write({
    q: undefined, status: undefined, lawfulBasis: undefined, dataCategory: undefined,
    subjectCategory: undefined, crossBorder: undefined, page: undefined,
  });

  const save = (payload: Record<string, unknown>) => {
    const target = editor;
    if (target === null) return;
    const id = target === 'new' ? null : target.id;
    return commit(
      id === null ? 'Processing activity added to the register.' : 'Processing activity updated.',
      async () => {
        await api(id === null ? '/api/ops/compliance/activities' : `/api/ops/compliance/activities/${id}`, {
          method: id === null ? 'POST' : 'PATCH',
          body: JSON.stringify(payload),
        });
        setEditor(null);
      }
    );
  };

  const remove = async (activity: ProcessingActivity) => {
    let retired = false;
    const ok = await commit('Processing activity deleted from the register.', async () => {
      const r = await api<{ data: { retired: boolean } }>(
        `/api/ops/compliance/activities/${activity.id}`,
        { method: 'DELETE' }
      );
      retired = r.data?.retired === true;
      setRemoveTarget(null);
    });
    // A row something else points at is retired, not deleted, and the operator
    // has to be told which of the two actually happened.
    if (ok && retired) {
      notify(`${activity.code} was retired rather than deleted, because other register rows still cite it.`);
    }
    return ok;
  };

  const cards = rows.map((a) => (
    <div key={`card-${a.id}`} className="record-card">
      <div className="record-card-top">
        <strong className="cell-mono">{a.code}</strong>
        <Chip value={a.status} />
      </div>
      <div className="record-card-meta">
        <span>{titleCaseWords(a.lawfulBasis)}</span>
        <span>{a.crossBorder ? `Transfers to ${a.transferCountries.join(', ')}` : 'No transfer recorded'}</span>
      </div>
      <div>{a.name}</div>
      <div className="record-card-foot">
        <span className="chip"><span className="chip-k">Retention</span>{a.retentionPeriod ?? dash}</span>
        <span className="chip"><span className="chip-k">Review due</span>{a.reviewDueAt ? day(a.reviewDueAt) : dash}</span>
      </div>
      <div className="row-actions" style={{ marginTop: 8 }}>
        <button className="btn btn-sm btn-ghost" aria-expanded={expanded === a.id}
          onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
          {expanded === a.id ? 'Hide' : 'Details'}
        </button>
        {canUpdate && <button className="btn btn-sm" disabled={busy} onClick={() => setEditor(a)}>Edit</button>}
        {canDelete && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setRemoveTarget(a)}>Delete</button>}
      </div>
      {expanded === a.id && <div style={{ marginTop: 10 }}><ActivityFacts activity={a} /></div>}
    </div>
  ));

  const table = (
    <table className="data">
      <thead>
        <tr>
          <th>Code</th>
          <th>Activity</th>
          <th>Lawful basis</th>
          <th>Data categories</th>
          <th>Status</th>
          <th>Review due</th>
          <th className="cell-num">Actions</th>
        </tr>
      </thead>
      {rows.map((a) => (
        <tbody key={a.id}>
          <tr className={a.reviewDueAt && new Date(a.reviewDueAt).getTime() < Date.now() ? 'row-warn' : undefined}>
            <td className="cell-mono">{a.code}</td>
            <td>
              {a.name}
              {a.crossBorder && (
                <span className="muted" style={{ display: 'block', fontSize: 11.5 }}>
                  Transfers to {a.transferCountries.join(', ')}
                </span>
              )}
            </td>
            <td>{titleCaseWords(a.lawfulBasis)}</td>
            <td>
              {a.dataCategories.length === 0
                ? dash
                : a.dataCategories.slice(0, 3).map((c) => titleCaseWords(c)).join(', ')}
              {a.dataCategories.length > 3 && (
                <span className="muted">{` +${a.dataCategories.length - 3}`}</span>
              )}
            </td>
            <td><Chip value={a.status} /></td>
            <td>{a.reviewDueAt ? day(a.reviewDueAt) : dash}</td>
            <td>
              <div className="row-actions">
                {canUpdate && <button className="btn btn-sm" disabled={busy} onClick={() => setEditor(a)}>Edit</button>}
                {canDelete && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setRemoveTarget(a)}>Delete</button>}
                <button className="btn btn-sm btn-ghost" aria-expanded={expanded === a.id}
                  onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
                  {expanded === a.id ? 'Hide' : 'Details'}
                </button>
              </div>
            </td>
          </tr>
          {expanded === a.id && (
            <tr>
              <td colSpan={7} style={{ background: 'var(--paper-2)' }}>
                <ActivityFacts activity={a} />
              </td>
            </tr>
          )}
        </tbody>
      ))}
    </table>
  );

  return (
    <>
      <FilterBar filtered={filtered} onClear={clear}>
        <SearchBox value={search} label="Search the register" placeholder="Code, name or purpose"
          onSearch={(v) => write({ q: v || undefined, page: undefined })} />
        <Select value={status} onChange={(v) => write({ status: v || undefined, page: undefined })}
          options={ACTIVITY_STATUSES} label="Status" placeholder="Any status" labels={ACTIVITY_STATUS_LABELS} />
        <Select value={lawfulBasis} onChange={(v) => write({ lawfulBasis: v || undefined, page: undefined })}
          options={LAWFUL_BASES} label="Lawful basis" placeholder="Any lawful basis" width={210} />
        <Select value={dataCategory} onChange={(v) => write({ dataCategory: v || undefined, page: undefined })}
          options={DATA_CATEGORIES} label="Data category" placeholder="Any data category" width={200} />
        <Select value={subjectCategory} onChange={(v) => write({ subjectCategory: v || undefined, page: undefined })}
          options={ACTIVITY_SUBJECTS} label="Data subject category" placeholder="Any subject category" width={210} />
        <Select value={crossBorder} onChange={(v) => write({ crossBorder: v || undefined, page: undefined })}
          options={['true', 'false']} label="Transfers" placeholder="Transfers and local"
          labels={{ true: 'Transfers outside the country', false: 'No transfer recorded' }} width={230} />
        {canCreate && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setEditor('new')}>
            Add activity
          </button>
        )}
      </FilterBar>

      <RegisterList
        state={state}
        paging={paging}
        filtered={filtered}
        onClearFilters={clear}
        cards={cards}
        table={table}
        empty={{
          title: 'The record of processing is empty',
          body: 'The Act expects a controller to hold a record of what it processes and why. Add the first activity to start it.',
        }}
      />

      {editor !== null && (
        <ActivityDialog
          activity={editor}
          busy={busy}
          error={state.error}
          onClose={() => setEditor(null)}
          onSave={save}
        />
      )}

      {removeTarget !== null && (
        <ConfirmDialog
          title="Remove this processing activity?"
          body={`${removeTarget.code} - ${removeTarget.name}. If other register rows cite it, it is retired instead of deleted so those rows keep their meaning.`}
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => { void remove(removeTarget); }}
        />
      )}
    </>
  );
}

// -------------------------------------------------------------- clock helpers
/**
 * The registers below stamp the moment something happened, which is a date and
 * a time, where the statutory windows themselves are counted in whole days and
 * use dayInput() above. Either way the row ends up holding an instant.
 */
function stampInput(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A <input type="datetime-local"> value as the instant the API expects. */
const stampValue = (v: string): string | null => {
  const s = v.trim();
  if (s === '') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// ------------------------------------------------------------ consent register
/**
 * Consent is held per subject and per purpose, and a withdrawal is a new fact
 * rather than an edit of the old one: the grant is the evidence that processing
 * was lawful while it lasted, the withdrawal is the evidence that it stopped.
 *
 * That is why there is no edit dialog on this screen and why a live consent has
 * no delete button. The three things an operator can do here are record a
 * consent, withdraw it, and remove a row that has already ended and was logged
 * in error.
 */

const CONSENT_STATUSES = ['GRANTED', 'WITHDRAWN', 'EXPIRED'] as const;

/** The statuses explained, so a picker does not offer three bare words. */
const CONSENT_STATUS_LABELS: Record<string, string> = {
  GRANTED: 'Granted - processing is permitted now',
  WITHDRAWN: 'Withdrawn - the subject took it back',
  EXPIRED: 'Expired - the stated period has run out',
};

/** Everything the consent row holds that is not the subject or the status. */
function ConsentFacts({ consent }: { consent: Consent }) {
  return (
    <Facts>
      <Detail label="Purpose" value={consent.purpose} />
      <Detail label="Lawful basis" value={titleCaseWords(consent.lawfulBasis)} />
      <Detail
        label="Processing activity"
        value={consent.processingActivityCode ?? 'Not tied to one activity'}
        mono={consent.processingActivityCode !== null}
      />
      <Detail label="Data subject type" value={titleCaseWords(consent.subjectType)} />
      <Detail label="How it was captured" value={consent.channel ? titleCaseWords(consent.channel) : 'Not recorded'} />
      <Detail label="Wording version" value={consent.wordingVersion ?? 'Not recorded'} />
      <Detail label="Granted" value={when(consent.grantedAt)} />
      <Detail label="Expires" value={consent.expiresAt ? when(consent.expiresAt) : 'No expiry, runs until withdrawn'} />
      <Detail label="Withdrawn" value={consent.withdrawnAt ? when(consent.withdrawnAt) : 'Still granted'} />
      <Detail label="Why it was withdrawn" value={consent.withdrawalReason} />
      <Detail
        label="Captured by"
        value={consent.capturedBy === null ? 'Not recorded' : `User #${consent.capturedBy}`}
      />
      <Detail label="Written" value={when(consent.createdAt)} />
      <JsonNote label="Evidence" value={consent.evidence} />
    </Facts>
  );
}

/**
 * Record a consent.
 *
 * The expiry is optional because a consent with no stated period runs until it
 * is withdrawn, which is a normal arrangement - but an expiry that is not after
 * the grant is refused here as well as in the database, so the operator is told
 * before the round trip rather than after it.
 */
function ConsentDialog({ busy, error, onClose, onSave }: {
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const [subjectReference, setSubjectReference] = useState('');
  const [subjectType, setSubjectType] = useState('CUSTOMER');
  const [activityId, setActivityId] = useState('');
  const [purpose, setPurpose] = useState('');
  const [lawfulBasis, setLawfulBasis] = useState('CONSENT');
  const [channel, setChannel] = useState('');
  const [wordingVersion, setWordingVersion] = useState('');
  const [grantedAt, setGrantedAt] = useState(stampInput(new Date().toISOString()));
  const [expiresAt, setExpiresAt] = useState('');
  const [evidence, setEvidence] = useState('');
  const [problem, setProblem] = useState('');

  const submit = () => {
    if (subjectReference.trim() === '') {
      return setProblem('A subject reference is required. Without one this row cannot be tied to a person who asks what is held about them.');
    }
    if (purpose.trim() === '') {
      return setProblem('The purpose is required. Consent is consent to something, and the register has to say what.');
    }
    const grant = stampValue(grantedAt);
    const expiry = stampValue(expiresAt);
    if (grant === null) return setProblem('The time the consent was given is required, and has to be a real date and time.');
    if (expiry !== null && new Date(expiry).getTime() <= new Date(grant).getTime()) {
      return setProblem('The expiry has to be after the consent was given, or it was never valid.');
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJson(evidence, 'Evidence');
    } catch (e) {
      return setProblem(e instanceof Error ? e.message : String(e));
    }
    setProblem('');
    onSave({
      subjectReference: subjectReference.trim(),
      subjectType,
      processingActivityId: activityId.trim() === '' ? null : Number(activityId),
      purpose: purpose.trim(),
      lawfulBasis,
      channel: channel === '' ? null : channel,
      wordingVersion: wordingVersion.trim() || null,
      grantedAt: grant,
      expiresAt: expiry,
      evidence: parsed,
    });
  };

  return (
    <Modal
      title="Record a consent"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>Record consent</button>
        </>
      }
    >
      {error && <ErrorBanner error={error} />}
      {problem && <ErrorBanner error={problem} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="Subject reference" id="cons-subject" hint="How the person is identified on this register. A customer number, staff number or email.">
          <input id="cons-subject" className="search-input" value={subjectReference}
            onChange={(e) => setSubjectReference(e.target.value)} />
        </Field>
        <Field label="Subject type" id="cons-subject-type">
          <select id="cons-subject-type" className="search-input" value={subjectType}
            onChange={(e) => setSubjectType(e.target.value)}>
            {DATA_SUBJECT_TYPES.map((t) => <option key={t} value={t}>{titleCaseWords(t)}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Purpose" id="cons-purpose" hint="What the subject agreed to. Keep it as narrow as the wording they saw.">
        <input id="cons-purpose" className="search-input" value={purpose}
          onChange={(e) => setPurpose(e.target.value)} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="Lawful basis" id="cons-basis" hint="Consent is the norm here; another basis is recorded when it is what actually applies.">
          <select id="cons-basis" className="search-input" value={lawfulBasis}
            onChange={(e) => setLawfulBasis(e.target.value)}>
            {LAWFUL_BASES.map((b) => <option key={b} value={b}>{titleCaseWords(b)}</option>)}
          </select>
        </Field>
        <Field label="Processing activity (id)" id="cons-activity" hint="Optional. Ties this consent to the activity it authorises.">
          <input id="cons-activity" className="search-input" inputMode="numeric" value={activityId}
            onChange={(e) => setActivityId(e.target.value)} />
        </Field>
        <Field label="Channel" id="cons-channel" hint="Where the consent was captured.">
          <select id="cons-channel" className="search-input" value={channel}
            onChange={(e) => setChannel(e.target.value)}>
            <option value="">Not recorded</option>
            {CONSENT_CHANNELS.map((c) => <option key={c} value={c}>{titleCaseWords(c)}</option>)}
          </select>
        </Field>
        <Field label="Wording version" id="cons-wording" hint="Which version of the notice the subject actually agreed to.">
          <input id="cons-wording" className="search-input" value={wordingVersion}
            onChange={(e) => setWordingVersion(e.target.value)} />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="Given at" id="cons-granted">
          <input id="cons-granted" className="search-input" type="datetime-local" value={grantedAt}
            onChange={(e) => setGrantedAt(e.target.value)} />
        </Field>
        <Field label="Expires at" id="cons-expires" hint="Leave empty if it runs until it is withdrawn.">
          <input id="cons-expires" className="search-input" type="datetime-local" value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)} />
        </Field>
      </div>

      <Field label="Evidence" id="cons-evidence" hint="Optional JSON: the tick box record, the form id, the IP address. Anything an inspector could check.">
        <textarea id="cons-evidence" className="search-input" rows={3} value={evidence}
          onChange={(e) => setEvidence(e.target.value)} />
      </Field>
    </Modal>
  );
}

/** The consent register itself. */
function ConsentsPanel({ q, write, reloadKey, busy, commit, notify }: DeskProps) {
  const { user } = useAuth();
  const canCreate = can(user, 'compliance.consents.create');
  const canWithdraw = can(user, 'compliance.consents.withdraw');
  const canDelete = can(user, 'compliance.consents.delete');

  const search = q.get('q') ?? '';
  const status = q.get('status') ?? '';
  const subjectType = q.get('subjectType') ?? '';
  const purpose = q.get('purpose') ?? '';
  const activityId = q.get('activityId') ?? '';
  const paging = usePaging(q, write);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (search) p.set('search', search);
    if (status) p.set('status', status);
    if (subjectType) p.set('subjectType', subjectType);
    if (purpose) p.set('purpose', purpose);
    if (activityId) p.set('processingActivityId', activityId);
    p.set('limit', String(paging.pageSize));
    p.set('offset', String(paging.offset));
    return p.toString();
  }, [search, status, subjectType, purpose, activityId, paging.pageSize, paging.offset]);

  const state = useRegister<Consent>('/api/ops/compliance/consents', query, true, reloadKey);
  const rows = state.page?.rows ?? [];

  const [creating, setCreating] = useState(false);
  const [withdrawTarget, setWithdrawTarget] = useState<Consent | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Consent | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const filtered = Boolean(search || status || subjectType || purpose || activityId);
  const clear = () => write({
    q: undefined, status: undefined, subjectType: undefined, purpose: undefined,
    activityId: undefined, page: undefined,
  });

  const save = (payload: Record<string, unknown>) =>
    commit('Consent recorded against the subject.', async () => {
      await api('/api/ops/compliance/consents', { method: 'POST', body: JSON.stringify(payload) });
      setCreating(false);
    });

  const withdraw = async (consent: Consent, reason: string) => {
    const ok = await commit('Consent withdrawn.', async () => {
      await api(`/api/ops/compliance/consents/${consent.id}/withdraw`, {
        method: 'POST',
        body: JSON.stringify({ withdrawalReason: reason }),
      });
      setWithdrawTarget(null);
    });
    if (ok) {
      // A withdrawal is not bookkeeping: everything the business was doing under
      // this consent has to stop, and the register line alone would not say so.
      notify(`Withdrawn. Stop processing ${consent.purpose} for ${consent.subjectReference}, and tell anyone the data was shared with.`);
    }
    return ok;
  };

  const remove = (consent: Consent) =>
    commit('Consent record deleted.', async () => {
      await api(`/api/ops/compliance/consents/${consent.id}`, { method: 'DELETE' });
      setRemoveTarget(null);
    });

  const cards = rows.map((c) => (
    <div key={`card-${c.id}`} className="record-card">
      <div className="record-card-top">
        <strong>{c.subjectReference}</strong>
        <Chip value={c.status} />
      </div>
      <div className="record-card-meta">
        <span>{c.purpose}</span>
        <span>{titleCaseWords(c.lawfulBasis)}</span>
      </div>
      <div className="record-card-foot">
        <span className="chip"><span className="chip-k">Granted</span>{day(c.grantedAt)}</span>
        <span className="chip"><span className="chip-k">Expires</span>{c.expiresAt ? day(c.expiresAt) : 'No end date'}</span>
      </div>
      <div className="row-actions" style={{ marginTop: 8 }}>
        <button className="btn btn-sm btn-ghost" aria-expanded={expanded === c.id}
          onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
          {expanded === c.id ? 'Hide' : 'Details'}
        </button>
        {canWithdraw && c.status === 'GRANTED' && (
          <button className="btn btn-sm" disabled={busy} onClick={() => setWithdrawTarget(c)}>Withdraw</button>
        )}
        {canDelete && c.status !== 'GRANTED' && (
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setRemoveTarget(c)}>Delete</button>
        )}
      </div>
      {expanded === c.id && <div style={{ marginTop: 10 }}><ConsentFacts consent={c} /></div>}
    </div>
  ));

  const table = (
    <table className="data">
      <thead>
        <tr>
          <th>Subject</th>
          <th>Purpose</th>
          <th>Activity</th>
          <th>Lawful basis</th>
          <th>Status</th>
          <th>Granted</th>
          <th>Expires</th>
          <th className="cell-num">Actions</th>
        </tr>
      </thead>
      {rows.map((c) => (
        <tbody key={c.id}>
          <tr>
            <td>{c.subjectReference}</td>
            <td>{c.purpose}</td>
            <td className="cell-mono">{c.processingActivityCode ?? dash}</td>
            <td>{titleCaseWords(c.lawfulBasis)}</td>
            <td><Chip value={c.status} /></td>
            <td>{day(c.grantedAt)}</td>
            <td>{c.expiresAt ? day(c.expiresAt) : 'No end date'}</td>
            <td>
              <div className="row-actions">
                {canWithdraw && c.status === 'GRANTED' && (
                  <button className="btn btn-sm" disabled={busy} onClick={() => setWithdrawTarget(c)}>Withdraw</button>
                )}
                {canDelete && c.status !== 'GRANTED' && (
                  <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setRemoveTarget(c)}>Delete</button>
                )}
                <button className="btn btn-sm btn-ghost" aria-expanded={expanded === c.id}
                  onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                  {expanded === c.id ? 'Hide' : 'Details'}
                </button>
              </div>
            </td>
          </tr>
          {expanded === c.id && (
            <tr>
              <td colSpan={8} style={{ background: 'var(--paper-2)' }}>
                <ConsentFacts consent={c} />
              </td>
            </tr>
          )}
        </tbody>
      ))}
    </table>
  );

  return (
    <>
      <FilterBar filtered={filtered} onClear={clear}>
        <SearchBox value={search} label="Search the consent register" placeholder="Subject, purpose or wording"
          onSearch={(v) => write({ q: v || undefined, page: undefined })} />
        <Select value={status} onChange={(v) => write({ status: v || undefined, page: undefined })}
          options={CONSENT_STATUSES} label="Consent status" placeholder="Any status" labels={CONSENT_STATUS_LABELS} />
        <Select value={subjectType} onChange={(v) => write({ subjectType: v || undefined, page: undefined })}
          options={DATA_SUBJECT_TYPES} label="Data subject type" placeholder="Any subject type" width={200} />
        <SearchBox value={purpose} label="Filter by purpose" placeholder="Exact purpose"
          onSearch={(v) => write({ purpose: v || undefined, page: undefined })} />
        <NumberFilter value={activityId} label="Filter by processing activity id" placeholder="Activity id"
          onApply={(v) => write({ activityId: v || undefined, page: undefined })} />
        {canCreate && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setCreating(true)}>
            Record consent
          </button>
        )}
      </FilterBar>

      <RegisterList
        state={state}
        paging={paging}
        filtered={filtered}
        onClearFilters={clear}
        cards={cards}
        table={table}
        empty={{
          title: 'No consent is recorded',
          body: 'Consent relies on being able to show what a person agreed to and when. Record the first one, or change the filters if the register is simply narrowed.',
        }}
      />

      {creating && (
        <ConsentDialog busy={busy} error={state.error} onClose={() => setCreating(false)} onSave={save} />
      )}

      {withdrawTarget !== null && (
        <ReasonDialog
          title="Withdraw this consent?"
          body={`${withdrawTarget.subjectReference} consented to ${withdrawTarget.purpose}. A withdrawal is recorded beside the grant and cannot be undone - a new consent has to be recorded instead.`}
          label="Why the subject withdrew it"
          confirmLabel="Withdraw consent"
          danger
          required
          busy={busy}
          onCancel={() => setWithdrawTarget(null)}
          onConfirm={(reason) => { void withdraw(withdrawTarget, reason); }}
        />
      )}

      {removeTarget !== null && (
        <ConfirmDialog
          title="Delete this consent record?"
          body={`${removeTarget.subjectReference} - ${removeTarget.purpose}, ${titleCaseWords(removeTarget.status).toLowerCase()}. Use this only for a row logged in error; a withdrawn consent is usually worth keeping, because it is the evidence that processing stopped.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => { void remove(removeTarget); }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------- data subject rights
/**
 * The queue of requests from the people whose data the company holds: access,
 * correction, erasure, objection, restriction and portability.
 *
 * A request is a statutory clock rather than a ticket. It starts when the
 * subject writes in, not when somebody notices, which is why the received time
 * is on the form; and the window is copied onto the row rather than read from
 * the configuration each time, so an installation that lengthens its own window
 * cannot move a deadline it has already communicated to a subject.
 *
 * The two ends of a request are decisions, not edits. Completing one records
 * what was done; refusing one records why, and the reason is required because
 * the subject can challenge it. Neither is reachable by editing the row, and an
 * answered request cannot be deleted at all, because the row is the evidence of
 * whether the deadline was met.
 */

const REQUEST_STATUS_LABELS: Record<string, string> = {
  RECEIVED: 'Received - logged, not yet acknowledged',
  IN_PROGRESS: 'In progress - acknowledged and being worked',
  AWAITING_SUBJECT: 'Awaiting the subject - the clock keeps running',
  EXTENDED: 'Extended - the window was pushed out, with the reason on the row',
  COMPLETED: 'Completed - the subject was answered',
  REFUSED: 'Refused - the subject was told no, with the reason on the row',
};

const REQUEST_STATUS_FILTERS = [
  'RECEIVED', 'IN_PROGRESS', 'AWAITING_SUBJECT', 'EXTENDED', 'COMPLETED', 'REFUSED',
] as const;

/** Open or closed, as a filter a person can read. */
const REQUEST_OPEN_FILTERS = ['true', 'false'] as const;
const REQUEST_OPEN_FILTER_LABELS: Record<string, string> = {
  true: 'Still running',
  false: 'Closed - answered or refused',
};

/** Everything the request row holds besides the subject and the status. */
function RequestFacts({ request }: { request: SubjectRequest }) {
  const window = request.responseWindowDays + ' day' + (request.responseWindowDays === 1 ? '' : 's');
  return (
    <>
      <Facts>
        <Detail label="Reference" value={request.reference} mono />
        <Detail label="Request" value={titleCaseWords(request.requestType)} />
        <Detail label="Subject" value={request.subjectReference} />
        <Detail label="Subject type" value={titleCaseWords(request.subjectType)} />
        <Detail label="Received" value={when(request.receivedAt)} />
        <Detail label="Window" value={window} />
        <Detail label="Due" value={day(request.dueAt)} />
        <Detail label="Clock" value={request.open ? dueIn(request.daysRemaining) : 'Closed'} />
        <Detail label="Acknowledged" value={when(request.acknowledgedAt)} />
        <Detail label="Decided" value={when(request.completedAt)} />
        <Detail
          label="Handled by"
          value={request.handledBy === null ? 'Nobody assigned' : 'User ' + request.handledBy}
        />
        <Detail
          label="Extension"
          value={request.extensionDays > 0 ? request.extensionDays + ' day(s)' : 'None'}
        />
      </Facts>
      {request.extensionReason && (
        <p style={{ marginTop: 10 }}>
          <strong>Why the window was extended.</strong> {request.extensionReason}
        </p>
      )}
      {request.outcomeSummary && (
        <p style={{ marginTop: 10 }}>
          <strong>Outcome.</strong> {request.outcomeSummary}
        </p>
      )}
      {request.refusalReason && (
        <p style={{ marginTop: 10 }}>
          <strong>Refused because.</strong> {request.refusalReason}
        </p>
      )}
      <div style={{ marginTop: 10 }}>
        <JsonNote label="Evidence" value={request.evidence} />
      </div>
    </>
  );
}

/**
 * Log or amend a request.
 *
 * The window and the extension are both on the form because both are copied
 * onto the row: the register has to be able to say afterwards what deadline was
 * in force at the time, not what the deadline would be under today's settings.
 */
function RequestDialog({ request, busy, error, onClose, onSave }: {
  request: SubjectRequest | 'new';
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const current = request === 'new' ? null : request;
  const [requestType, setRequestType] = useState(current?.requestType ?? 'ACCESS');
  const [subjectReference, setSubjectReference] = useState(current?.subjectReference ?? '');
  const [subjectType, setSubjectType] = useState(current?.subjectType ?? 'CUSTOMER');
  const [receivedAt, setReceivedAt] = useState(stampInput(current?.receivedAt ?? new Date().toISOString()));
  const [windowDays, setWindowDays] = useState(current === null ? '' : String(current.responseWindowDays));
  const [extensionDays, setExtensionDays] = useState(current === null ? '0' : String(current.extensionDays));
  const [extensionReason, setExtensionReason] = useState(current?.extensionReason ?? '');
  const [status, setStatus] = useState(current?.status ?? 'RECEIVED');
  const [outcomeSummary, setOutcomeSummary] = useState(current?.outcomeSummary ?? '');
  const [handledBy, setHandledBy] = useState(
    current?.handledBy === null || current?.handledBy === undefined ? '' : String(current.handledBy)
  );
  const [evidence, setEvidence] = useState('');
  const [problem, setProblem] = useState('');

  const extraDays = extensionDays.trim() === '' ? 0 : Number(extensionDays);

  const submit = () => {
    if (subjectReference.trim() === '') {
      return setProblem('Say who asked. The subject reference is how the register finds this person at all.');
    }
    if (!Number.isFinite(extraDays) || extraDays < 0 || extraDays > 180) {
      return setProblem('An extension is a whole number of days between 0 and 180.');
    }
    if (extraDays > 0 && extensionReason.trim() === '') {
      return setProblem(
        'An extension has to say why. The subject is entitled to the reason, and the register cannot hold an extension without one.'
      );
    }
    let windowValue: number | undefined;
    if (windowDays.trim() !== '') {
      const n = Number(windowDays);
      if (!Number.isInteger(n) || n < 1 || n > 365) {
        return setProblem('The response window is a whole number of days between 1 and 365.');
      }
      windowValue = n;
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = parseJson(evidence, 'Evidence');
    } catch (e) {
      return setProblem(e instanceof Error ? e.message : String(e));
    }
    setProblem('');

    const payload: Record<string, unknown> = {
      requestType,
      subjectReference: subjectReference.trim(),
      subjectType,
      responseWindowDays: windowValue,
      extensionDays: extraDays,
      // The pair travels together in both directions: a reason with no extension
      // and an extension with no reason are each refused.
      extensionReason: extraDays > 0 ? extensionReason.trim() : null,
      status: extraDays > 0 ? 'EXTENDED' : status,
      handledBy: handledBy.trim() === '' ? null : Number(handledBy),
      evidence: parsed,
    };
    // An empty box means the time was not recorded. Sending null for a column
    // the register fills in itself would blank it, so the key is left out and
    // the row keeps what it already holds.
    if (receivedAt.trim() !== '') payload.receivedAt = stampValue(receivedAt);
    if (current !== null) payload.outcomeSummary = outcomeSummary.trim() || null;
    onSave(payload);
  };

  return (
    <Modal
      title={request === 'new' ? 'Log a data subject request' : 'Amend ' + (current?.reference ?? 'request')}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {request === 'new' ? 'Log the request' : 'Save changes'}
          </button>
        </>
      }
    >
      {error && <ErrorBanner error={error} />}
      {problem && <ErrorBanner error={problem} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="Right being exercised" id="req-type">
          <select id="req-type" className="search-input" value={requestType}
            onChange={(e) => setRequestType(e.target.value)}>
            {REQUEST_TYPES.map((t) => <option key={t} value={t}>{titleCaseWords(t)}</option>)}
          </select>
        </Field>
        <Field
          label="Subject reference"
          id="req-subject"
          hint="How the person is identified on the other registers. A customer number, staff number or email."
        >
          <input id="req-subject" className="search-input" value={subjectReference}
            onChange={(e) => setSubjectReference(e.target.value)} />
        </Field>
        <Field label="Subject type" id="req-subject-type">
          <select id="req-subject-type" className="search-input" value={subjectType}
            onChange={(e) => setSubjectType(e.target.value)}>
            {DATA_SUBJECT_TYPES.map((t) => <option key={t} value={t}>{titleCaseWords(t)}</option>)}
          </select>
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field
          label="Received at"
          id="req-received"
          hint="When the subject wrote in, not when somebody opened this screen. The clock runs from here."
        >
          <input id="req-received" className="search-input" type="datetime-local" value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)} />
        </Field>
        <Field
          label="Response window (days)"
          id="req-window"
          hint="Defaults to the company's configured window and is copied onto this row, so changing the configuration later does not move a deadline already communicated."
        >
          <input id="req-window" className="search-input" inputMode="numeric" value={windowDays}
            placeholder="Company default" onChange={(e) => setWindowDays(e.target.value)} />
        </Field>
        <Field label="Assignment (user id)" id="req-handled" hint="Optional. Who is answering it.">
          <input id="req-handled" className="search-input" inputMode="numeric" value={handledBy}
            onChange={(e) => setHandledBy(e.target.value)} />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field
          label="Extension (days)"
          id="req-extension"
          hint="Optional, up to 180. An extension is only lawful once the subject has been told, so the reason below is required with it."
        >
          <input id="req-extension" className="search-input" inputMode="numeric" value={extensionDays}
            onChange={(e) => setExtensionDays(e.target.value)} />
        </Field>
        {extraDays > 0 ? (
          <Field
            label="Status"
            id="req-status-extended"
            hint="A request with an extension is recorded as extended, whatever its progress, because that is what the subject was told."
          >
            <input id="req-status-extended" className="search-input" value="EXTENDED" readOnly disabled />
          </Field>
        ) : (
          <Field label="Status" id="req-status">
            <select id="req-status" className="search-input" value={status}
              onChange={(e) => setStatus(e.target.value)}>
              {REQUEST_OPEN_STATUSES.map((s) => (
                <option key={s} value={s}>{REQUEST_STATUS_LABELS[s] ?? titleCaseWords(s)}</option>
              ))}
            </select>
          </Field>
        )}
      </div>

      {extraDays > 0 && (
        <Field label="Why the window was extended" id="req-extension-reason">
          <textarea id="req-extension-reason" className="search-input" rows={2} value={extensionReason}
            onChange={(e) => setExtensionReason(e.target.value)} />
        </Field>
      )}

      {current !== null && (
        <Field
          label="Outcome summary"
          id="req-outcome-summary"
          hint="Optional here. Completing or refusing the request records the outcome properly; this is for a note that belongs on the row meanwhile."
        >
          <textarea id="req-outcome-summary" className="search-input" rows={2} value={outcomeSummary}
            onChange={(e) => setOutcomeSummary(e.target.value)} />
        </Field>
      )}

      <Field
        label="Evidence"
        id="req-evidence"
        hint="Optional JSON: the message that arrived, the mailbox it came from, anything an inspector could check."
      >
        <textarea id="req-evidence" className="search-input" rows={3} value={evidence}
          onChange={(e) => setEvidence(e.target.value)} />
      </Field>
    </Modal>
  );
}

/**
 * The outcome is the record of what the subject was actually given, so it is
 * required. Completing a request with nothing written down is the same, later,
 * as not having answered it.
 */
function CompleteRequestDialog({ request, busy, error, onClose, onConfirm }: {
  request: SubjectRequest;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (outcome: string) => void;
}) {
  const [outcome, setOutcome] = useState('');
  const blocked = outcome.trim() === '';
  return (
    <Modal
      title={'Complete ' + request.reference}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || blocked} onClick={() => onConfirm(outcome.trim())}>
            Mark as answered
          </button>
        </>
      }
    >
      {error && <ErrorBanner error={error} />}
      <p className="muted">
        {titleCaseWords(request.requestType)} asked by {request.subjectReference}, received{' '}
        {when(request.receivedAt)} and due {day(request.dueAt)}.
      </p>
      <Field
        label="What was done"
        id="req-complete"
        hint="For an access request, what was sent and when. For a correction, what was changed. Enough that a reader can follow it without asking."
      >
        <textarea id="req-complete" className="search-input" rows={4} value={outcome}
          onChange={(e) => setOutcome(e.target.value)} />
      </Field>
      {blocked && (
        <p className="muted" style={{ fontSize: 12 }}>
          This cannot be saved empty. The row has to say what the subject was given.
        </p>
      )}
    </Modal>
  );
}

/** The data subject rights queue itself. */
function RequestsPanel({ q, write, reloadKey, busy, commit, notify }: DeskProps) {
  const { user } = useAuth();
  const canCreate = can(user, 'compliance.subject_requests.create');
  const canUpdate = can(user, 'compliance.subject_requests.update');
  const canFulfil = can(user, 'compliance.subject_requests.fulfil');
  const canRefuse = can(user, 'compliance.subject_requests.refuse');

  const search = q.get('q') ?? '';
  const status = q.get('status') ?? '';
  const requestType = q.get('requestType') ?? '';
  const subjectType = q.get('subjectType') ?? '';
  const subjectReference = q.get('subjectReference') ?? '';
  const openFilter = q.get('open') ?? '';
  const overdue = q.get('overdue') === 'true';
  const paging = usePaging(q, write);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (search) p.set('search', search);
    if (status) p.set('status', status);
    if (requestType) p.set('requestType', requestType);
    if (subjectType) p.set('subjectType', subjectType);
    if (subjectReference) p.set('subjectReference', subjectReference);
    if (openFilter) p.set('open', openFilter);
    if (overdue) p.set('overdue', 'true');
    p.set('limit', String(paging.pageSize));
    p.set('offset', String(paging.offset));
    return p.toString();
  }, [search, status, requestType, subjectType, subjectReference, openFilter, overdue, paging.pageSize, paging.offset]);

  const state = useRegister<SubjectRequest>('/api/ops/compliance/subject-requests', query, true, reloadKey);
  const rows = state.page?.rows ?? [];

  const [editor, setEditor] = useState<SubjectRequest | 'new' | null>(null);
  const [completeTarget, setCompleteTarget] = useState<SubjectRequest | null>(null);
  const [refuseTarget, setRefuseTarget] = useState<SubjectRequest | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SubjectRequest | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const filtered = Boolean(
    search || status || requestType || subjectType || subjectReference || openFilter || overdue
  );
  const clear = () => write({
    q: undefined, status: undefined, requestType: undefined, subjectType: undefined,
    subjectReference: undefined, open: undefined, overdue: undefined, page: undefined,
  });

  const save = (payload: Record<string, unknown>) => {
    const target = editor;
    if (target === null) return;
    const id = target === 'new' ? null : target.id;
    return commit(
      id === null ? 'Request logged. The clock is running from the received time.' : 'Request updated.',
      async () => {
        await api(
          id === null ? '/api/ops/compliance/subject-requests' : '/api/ops/compliance/subject-requests/' + id,
          { method: id === null ? 'POST' : 'PATCH', body: JSON.stringify(payload) }
        );
        setEditor(null);
      }
    );
  };

  const acknowledge = async (r: SubjectRequest) => {
    const ok = await commit('Acknowledgement recorded.', async () => {
      await api('/api/ops/compliance/subject-requests/' + r.id + '/acknowledge', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    });
    // Acknowledging is the first thing the Office asks to see, and it is the
    // step that tells the subject their request did not vanish.
    if (ok) notify('Acknowledged. Tell ' + r.subjectReference + ' it arrived, then answer it by ' + day(r.dueAt) + '.');
    return ok;
  };

  const complete = async (r: SubjectRequest, outcome: string) => {
    const ok = await commit('Request marked as answered.', async () => {
      await api('/api/ops/compliance/subject-requests/' + r.id + '/complete', {
        method: 'POST',
        body: JSON.stringify({ outcomeSummary: outcome }),
      });
      setCompleteTarget(null);
    });
    if (ok) notify('Answered. Send ' + r.subjectReference + ' the outcome if that has not gone out yet.');
    return ok;
  };

  const refuse = async (r: SubjectRequest, reason: string) => {
    const ok = await commit('Request refused, with the reason on the row.', async () => {
      await api('/api/ops/compliance/subject-requests/' + r.id + '/refuse', {
        method: 'POST',
        body: JSON.stringify({ refusalReason: reason }),
      });
      setRefuseTarget(null);
    });
    // A refusal is the one outcome a subject can challenge, so the reason has to
    // stand on its own and the subject has to be told.
    if (ok) notify('Refused. ' + r.subjectReference + ' can challenge this, so tell them and stand by the reason.');
    return ok;
  };

  const remove = (r: SubjectRequest) =>
    commit('Request deleted from the register.', async () => {
      await api('/api/ops/compliance/subject-requests/' + r.id, { method: 'DELETE' });
      setRemoveTarget(null);
    });

  const actionsFor = (r: SubjectRequest) => (
    <>
      {canUpdate && r.open && r.acknowledgedAt === null && (
        <button className="btn btn-sm" disabled={busy} onClick={() => { void acknowledge(r); }}>
          Acknowledge
        </button>
      )}
      {canUpdate && r.open && (
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setEditor(r)}>Amend</button>
      )}
      {canFulfil && r.open && (
        <button className="btn btn-sm" disabled={busy} onClick={() => setCompleteTarget(r)}>Complete</button>
      )}
      {canRefuse && r.open && (
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setRefuseTarget(r)}>Refuse</button>
      )}
      {canUpdate && !r.acknowledgedAt && !r.completedAt && (
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setRemoveTarget(r)}>Delete</button>
      )}
    </>
  );

  const cards = rows.map((r) => (
    <div key={'card-' + r.id} className="record-card">
      <div className="record-card-top">
        <strong className="cell-mono">{r.reference}</strong>
        <Chip value={r.status} />
      </div>
      <div className="record-card-meta">
        <span>{titleCaseWords(r.requestType)}</span>
        <span>{r.subjectReference}</span>
      </div>
      <div className="record-card-foot">
        <span className="chip"><span className="chip-k">Received</span>{day(r.receivedAt)}</span>
        <span className="chip"><span className="chip-k">Due</span>{day(r.dueAt)}</span>
        <span className="chip"><span className="chip-k">Clock</span>{dueIn(r.daysRemaining)}</span>
      </div>
      <div className="row-actions" style={{ marginTop: 8 }}>
        {actionsFor(r)}
        <button className="btn btn-sm btn-ghost" aria-expanded={expanded === r.id}
          onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
          {expanded === r.id ? 'Hide' : 'Details'}
        </button>
      </div>
      {expanded === r.id && <div style={{ marginTop: 10 }}><RequestFacts request={r} /></div>}
    </div>
  ));

  const table = (
    <table className="data">
      <thead>
        <tr>
          <th>Reference</th>
          <th>Request</th>
          <th>Subject</th>
          <th>Received</th>
          <th>Due</th>
          <th>Clock</th>
          <th>Status</th>
          <th className="cell-num">Actions</th>
        </tr>
      </thead>
      {rows.map((r) => (
        <tbody key={r.id}>
          <tr className={r.overdue ? 'row-warn' : undefined}>
            <td className="cell-mono">{r.reference}</td>
            <td>{titleCaseWords(r.requestType)}</td>
            <td>{r.subjectReference}</td>
            <td>{day(r.receivedAt)}</td>
            <td>{day(r.dueAt)}</td>
            <td>{r.open ? dueIn(r.daysRemaining) : dash}</td>
            <td>
              <Chip value={r.status} />
              {r.overdue && <span className="badge badge-red" style={{ marginLeft: 6 }}>Past due</span>}
            </td>
            <td>
              <div className="row-actions">
                {actionsFor(r)}
                <button className="btn btn-sm btn-ghost" aria-expanded={expanded === r.id}
                  onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                  {expanded === r.id ? 'Hide' : 'Details'}
                </button>
              </div>
            </td>
          </tr>
          {expanded === r.id && (
            <tr>
              <td colSpan={8} style={{ background: 'var(--paper-2)' }}>
                <RequestFacts request={r} />
              </td>
            </tr>
          )}
        </tbody>
      ))}
    </table>
  );

  return (
    <>
      <FilterBar filtered={filtered} onClear={clear}>
        <SearchBox value={search} label="Search the request queue" placeholder="Reference or subject"
          onSearch={(v) => write({ q: v || undefined, page: undefined })} />
        <Select value={status} onChange={(v) => write({ status: v || undefined, page: undefined })}
          options={REQUEST_STATUS_FILTERS} label="Request status" placeholder="Any status"
          labels={REQUEST_STATUS_LABELS} width={230} />
        <Select value={requestType} onChange={(v) => write({ requestType: v || undefined, page: undefined })}
          options={REQUEST_TYPES} label="Right exercised" placeholder="Any request type" width={200} />
        <Select value={subjectType} onChange={(v) => write({ subjectType: v || undefined, page: undefined })}
          options={DATA_SUBJECT_TYPES} label="Data subject type" placeholder="Any subject type" width={200} />
        <Select value={openFilter} onChange={(v) => write({ open: v || undefined, page: undefined })}
          options={REQUEST_OPEN_FILTERS} label="Whether the request is still running"
          placeholder="Open and closed" labels={REQUEST_OPEN_FILTER_LABELS} width={230} />
        <SearchBox value={subjectReference} label="Filter by subject reference" placeholder="Exact subject reference"
          onSearch={(v) => write({ subjectReference: v || undefined, page: undefined })} />
        <FlagToggle label="Past due only" checked={overdue}
          onChange={(v) => write({ overdue: v ? 'true' : undefined, page: undefined })} />
        {canCreate && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setEditor('new')}>
            Log request
          </button>
        )}
      </FilterBar>

      <RegisterList
        state={state}
        paging={paging}
        filtered={filtered}
        onClearFilters={clear}
        cards={cards}
        table={table}
        empty={{
          title: 'No data subject request is logged',
          body: 'A request that was answered but never logged cannot be shown to have been answered. Log the first one, or change the filters if the queue is simply narrowed.',
        }}
      />

      {editor !== null && (
        <RequestDialog request={editor} busy={busy} error={state.error}
          onClose={() => setEditor(null)} onSave={save} />
      )}

      {completeTarget !== null && (
        <CompleteRequestDialog request={completeTarget} busy={busy} error={state.error}
          onClose={() => setCompleteTarget(null)}
          onConfirm={(outcome) => { void complete(completeTarget, outcome); }} />
      )}

      {refuseTarget !== null && (
        <ReasonDialog
          title={'Refuse ' + refuseTarget.reference + '?'}
          body={
            refuseTarget.subjectReference + ' asked for '
            + titleCaseWords(refuseTarget.requestType).toLowerCase()
            + '. Refusing closes the request and the reason stays on the row, where the subject is entitled to see it.'
          }
          label="Why the request is refused"
          confirmLabel="Refuse the request"
          danger
          required
          busy={busy}
          onCancel={() => setRefuseTarget(null)}
          onConfirm={(reason) => { void refuse(refuseTarget, reason); }}
        />
      )}

      {removeTarget !== null && (
        <ConfirmDialog
          title="Delete this request?"
          body={
            removeTarget.reference
            + ' has not been acknowledged yet, so it can still go. Use this only for a row logged in error: once it has been acknowledged the row is the evidence of how the deadline was handled.'
          }
          confirmLabel="Delete"
          danger
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => { void remove(removeTarget); }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------ personal data breaches
/**
 * The personal data breach register.
 *
 * The clock here is the one the Act is strict about: a notifiable breach has to
 * reach the Office within 72 hours of the company becoming aware of it. The
 * database stamps the deadline when the row is written and derives
 * late_notification from it, so a notification that missed the window is
 * recorded as late however calmly it is entered here. That is deliberate - the
 * register exists to be shown to an inspector, not to make the company look
 * prompt.
 *
 * Two different questions are kept apart. Whether a breach is notifiable at all
 * is a judgement, recorded on the row and reversible. Whether it has been
 * reported is an event, with a timestamp and the Office's own reference, and it
 * is reached through its own call rather than by editing a field. A breach
 * assessed as not notifiable has to be re-assessed as notifiable before it can
 * be reported, because holding both at once is a contradiction the register
 * refuses to store.
 */

const BREACH_STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open - discovered, containment still running',
  CONTAINED: 'Contained - the leak is stopped, the assessment continues',
  REPORTED: 'Reported - the Office has been told',
  NOT_NOTIFIABLE: 'Not notifiable - assessed out, with the reasoning still on the row',
  CLOSED: 'Closed - nothing further is owed on it',
};

const BREACH_STATUS_FILTERS = [
  'OPEN', 'CONTAINED', 'REPORTED', 'NOT_NOTIFIABLE', 'CLOSED',
] as const;

/** The notifiable flag as a filter a person can read. */
const BREACH_NOTIFIABLE_FILTERS = ['true', 'false'] as const;
const BREACH_NOTIFIABLE_FILTER_LABELS: Record<string, string> = {
  true: 'Notifiable to the Office',
  false: 'Assessed as not notifiable',
};

/** Everything the breach row holds, for the expanded row and the mobile card. */
function BreachFacts({ breach }: { breach: Breach }) {
  const window = breach.notificationWindowHours + ' hour'
    + (breach.notificationWindowHours === 1 ? '' : 's') + ' from discovery';
  const affected = breach.affectedSubjects.toLocaleString() + ' subject(s), '
    + breach.affectedRecords.toLocaleString() + ' record(s)';
  return (
    <>
      <Facts>
        <Detail label="Reference" value={breach.reference} mono />
        <Detail label="Severity" value={titleCaseWords(breach.severity)} />
        <Detail label="Occurred" value={when(breach.occurredAt)} />
        <Detail label="Discovered" value={when(breach.discoveredAt)} />
        <Detail label="Notification due" value={when(breach.notificationDueAt)} />
        <Detail label="Window" value={window} />
        <Detail label="Time left" value={breach.open ? dueInHours(breach.hoursRemaining) : 'Closed'} />
        <Detail
          label="Notifiable"
          value={breach.notifiable ? 'Yes - the Office is owed a notification' : 'No - assessed out'}
        />
        <Detail label="Notified" value={breach.notifiedAt ? when(breach.notifiedAt) : 'Not yet reported'} />
        <Detail label="Office reference" value={breach.notificationReference} mono />
        <Detail
          label="Subjects told"
          value={breach.subjectNotifiedAt ? when(breach.subjectNotifiedAt) : 'Not recorded'}
        />
        <Detail label="Affected" value={affected} />
        <Detail
          label="Reported by"
          value={breach.reportedBy === null ? 'Nobody recorded' : 'User ' + breach.reportedBy}
        />
        <Detail label="Closed" value={breach.closedAt ? when(breach.closedAt) : 'Still open'} />
      </Facts>
      {breach.dataCategories.length > 0 && (
        <p style={{ marginTop: 10 }}>
          <strong>Categories of personal data involved.</strong>{' '}
          {breach.dataCategories.map((c) => titleCaseWords(c)).join(', ')}
        </p>
      )}
      {breach.lateNotification && (
        <p style={{ marginTop: 10 }}>
          <strong style={{ color: 'var(--danger)' }}>This notification was late.</strong>{' '}
          It reached the Office after the window this register stamped at discovery, and the row
          keeps saying so.
        </p>
      )}
      <p style={{ marginTop: 10 }}>
        <strong>What happened.</strong> {breach.nature}
      </p>
      {breach.likelyConsequences && (
        <p style={{ marginTop: 10 }}>
          <strong>Likely consequences.</strong> {breach.likelyConsequences}
        </p>
      )}
      {breach.containmentMeasures && (
        <p style={{ marginTop: 10 }}>
          <strong>What was done about it.</strong> {breach.containmentMeasures}
        </p>
      )}
      {!breach.notifiable && (
        <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          This row is assessed as not notifiable. That judgement is reversible, but it has to be
          reversed before the breach can be reported, because a notification and a not-notifiable
          assessment cannot both be true.
        </p>
      )}
    </>
  );
}

/**
 * Log or amend a breach.
 *
 * The discovery time is the field the whole notification window hangs off, so it
 * is on the form with a note saying so: a breach re-timed later to look prompt
 * is exactly what an inspector looks for. The window is copied onto the row, so
 * an installation that lengthens its own window cannot move a deadline that was
 * already in force when the breach was discovered.
 */
function BreachDialog({ breach, busy, error, onClose, onSave }: {
  breach: Breach | 'new';
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const current = breach === 'new' ? null : breach;
  const [title, setTitle] = useState(current?.title ?? '');
  const [nature, setNature] = useState(current?.nature ?? '');
  const [severity, setSeverity] = useState(current?.severity ?? 'MEDIUM');
  const [occurredAt, setOccurredAt] = useState(stampInput(current?.occurredAt ?? ''));
  const [discoveredAt, setDiscoveredAt] = useState(
    stampInput(current?.discoveredAt ?? new Date().toISOString())
  );
  const [windowHours, setWindowHours] = useState(
    current === null ? '' : String(current.notificationWindowHours)
  );
  const [dataCategories, setDataCategories] = useState<string[]>(current?.dataCategories ?? []);
  const [affectedSubjects, setAffectedSubjects] = useState(
    current === null ? '0' : String(current.affectedSubjects)
  );
  const [affectedRecords, setAffectedRecords] = useState(
    current === null ? '0' : String(current.affectedRecords)
  );
  const [likelyConsequences, setLikelyConsequences] = useState(current?.likelyConsequences ?? '');
  const [containmentMeasures, setContainmentMeasures] = useState(current?.containmentMeasures ?? '');
  const [notifiable, setNotifiable] = useState(current === null ? true : current.notifiable);
  const [status, setStatus] = useState(current?.status ?? 'OPEN');
  const [problem, setProblem] = useState('');

  const statusEditable = current === null
    || (current.status !== 'CLOSED' && current.status !== 'REPORTED');

  const submit = () => {
    if (title.trim() === '') {
      return setProblem('Give the incident a short title. It is how the row is found later.');
    }
    if (nature.trim() === '') {
      return setProblem(
        'Describe what happened. The nature of the breach is the one field the Office asks for first.'
      );
    }
    const discoveredValue = stampValue(discoveredAt);
    if (discoveredValue === null) {
      return setProblem('The discovery time is what the notification window runs from, so it has to be given.');
    }
    const occurredValue = stampValue(occurredAt);
    if (occurredValue !== null && new Date(discoveredValue).getTime() < new Date(occurredValue).getTime()) {
      return setProblem('The breach cannot be discovered before it happened. Check the two times.');
    }
    let windowValue: number | undefined;
    if (windowHours.trim() !== '') {
      const n = Number(windowHours);
      if (!Number.isInteger(n) || n < 1 || n > 720) {
        return setProblem('The notification window is a whole number of hours between 1 and 720.');
      }
      windowValue = n;
    }
    const subjects = Number(affectedSubjects.trim() === '' ? '0' : affectedSubjects);
    const records = Number(affectedRecords.trim() === '' ? '0' : affectedRecords);
    if (!Number.isInteger(subjects) || subjects < 0) {
      return setProblem('The number of affected subjects is a whole number, zero or more.');
    }
    if (!Number.isInteger(records) || records < 0) {
      return setProblem('The number of affected records is a whole number, zero or more.');
    }
    setProblem('');

    const payload: Record<string, unknown> = {
      title: title.trim(),
      nature: nature.trim(),
      severity,
      occurredAt: occurredValue,
      discoveredAt: discoveredValue,
      notificationWindowHours: windowValue,
      dataCategories,
      affectedSubjects: subjects,
      affectedRecords: records,
      likelyConsequences: likelyConsequences.trim() || null,
      containmentMeasures: containmentMeasures.trim() || null,
      notifiable,
    };
    // The status is derived from the notifiable assessment, so it is only sent
    // while the row is still one of the two open statuses. Sending it for a
    // reported row would move a breach back out of the state that records the
    // notification ever happened.
    if (current === null) {
      if (status !== 'OPEN') payload.status = status;
    } else if (statusEditable) {
      payload.status = status;
    }
    onSave(payload);
  };

  return (
    <Modal
      title={breach === 'new' ? 'Log a personal data breach' : 'Amend ' + (current?.reference ?? 'breach')}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {breach === 'new' ? 'Log the breach' : 'Save changes'}
          </button>
        </>
      }
    >
      {error && <ErrorBanner error={error} />}
      {problem && <ErrorBanner error={problem} />}

      <Field label="Title" id="br-title" hint="Short and specific: what was exposed, and where.">
        <input id="br-title" className="search-input" value={title}
          onChange={(e) => setTitle(e.target.value)} />
      </Field>

      <Field
        label="What happened"
        id="br-nature"
        hint="The nature of the breach. Who could see what, and how the exposure came about."
      >
        <textarea id="br-nature" className="search-input" rows={4} value={nature}
          onChange={(e) => setNature(e.target.value)} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="Severity" id="br-severity">
          <select id="br-severity" className="search-input" value={severity}
            onChange={(e) => setSeverity(e.target.value)}>
            {BREACH_SEVERITIES.map((s) => <option key={s} value={s}>{titleCaseWords(s)}</option>)}
          </select>
        </Field>
        <Field
          label="Occurred at"
          id="br-occurred"
          hint="Optional, and often unknown. Leave it empty rather than guessing."
        >
          <input id="br-occurred" className="search-input" type="datetime-local" value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)} />
        </Field>
        <Field
          label="Discovered at"
          id="br-discovered"
          hint="When the company became aware of it. Defaults to now, and this is the time the notification window runs from."
        >
          <input id="br-discovered" className="search-input" type="datetime-local" value={discoveredAt}
            onChange={(e) => setDiscoveredAt(e.target.value)} />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field
          label="Notification window (hours)"
          id="br-window"
          hint="Defaults to the company's configured window and is copied onto this row, so a deadline already in force does not move."
        >
          <input id="br-window" className="search-input" inputMode="numeric" value={windowHours}
            placeholder="Company default" onChange={(e) => setWindowHours(e.target.value)} />
        </Field>
        <Field label="Affected subjects" id="br-subjects" hint="A count. An estimate is better than a blank.">
          <input id="br-subjects" className="search-input" inputMode="numeric" value={affectedSubjects}
            onChange={(e) => setAffectedSubjects(e.target.value)} />
        </Field>
        <Field label="Affected records" id="br-records">
          <input id="br-records" className="search-input" inputMode="numeric" value={affectedRecords}
            onChange={(e) => setAffectedRecords(e.target.value)} />
        </Field>
      </div>

      <Field
        label="Categories of personal data"
        id="br-categories"
        hint="What kinds of data were involved. Special category data raises the stakes and is worth recording even when the count is small."
      >
        <CheckGroup options={DATA_CATEGORIES} value={dataCategories} onChange={setDataCategories} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        <Field
          label="Likely consequences"
          id="br-consequences"
          hint="What could follow for the people whose data it was. This is what the Office weighs."
        >
          <textarea id="br-consequences" className="search-input" rows={3} value={likelyConsequences}
            onChange={(e) => setLikelyConsequences(e.target.value)} />
        </Field>
        <Field
          label="What was done about it"
          id="br-containment"
          hint="Containment and remediation, as it stands today. It can be added to later."
        >
          <textarea id="br-containment" className="search-input" rows={3} value={containmentMeasures}
            onChange={(e) => setContainmentMeasures(e.target.value)} />
        </Field>
      </div>

      <Field
        label="Assessment"
        id="br-notifiable"
        hint="A breach is notifiable when it risks the rights and freedoms of the people involved. Deciding it is not notifiable is a recorded decision, not a way of closing the row quietly."
      >
        <FlagToggle label="Notifiable to the Office" checked={notifiable}
          onChange={setNotifiable} />
      </Field>

      {statusEditable && (
        <Field
          label="Status"
          id="br-status"
          hint="Open or contained. Reporting and closing have their own steps because each records evidence this field cannot."
        >
          <select id="br-status" className="search-input" value={status}
            onChange={(e) => setStatus(e.target.value)}>
            {BREACH_OPEN_STATUSES.map((s) => (
              <option key={s} value={s}>{BREACH_STATUS_LABELS[s] ?? titleCaseWords(s)}</option>
            ))}
          </select>
        </Field>
      )}

      {!notifiable && (
        <p className="muted" style={{ fontSize: 12 }}>
          Saving with this assessment records the breach as not notifiable. If that changes, amend
          the row again and report it.
        </p>
      )}
    </Modal>
  );
}

/**
 * Report the breach to the Office.
 *
 * The time and the Office's own reference are the evidence, so both are asked
 * for here rather than assumed. Whether the notification was in time is not
 * decided on this form: the register compares the time given with the deadline
 * it stamped, and says plainly when the window was missed.
 */
function ReportBreachDialog({ breach, busy, error, onClose, onConfirm }: {
  breach: Breach;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (payload: Record<string, unknown>) => void;
}) {
  const [notifiedAt, setNotifiedAt] = useState(stampInput(new Date().toISOString()));
  const [reference, setReference] = useState(breach.notificationReference ?? '');
  const [problem, setProblem] = useState('');

  const typed = stampValue(notifiedAt);
  const late = typed !== null && breach.notificationDueAt !== null
    && new Date(typed).getTime() > new Date(breach.notificationDueAt).getTime();

  const submit = () => {
    if (typed === null) {
      return setProblem('Say when it was sent. That time is what decides whether the window was met.');
    }
    setProblem('');
    onConfirm({
      notifiedAt: typed,
      notificationReference: reference.trim() || null,
    });
  };

  return (
    <Modal
      title={'Report ' + breach.reference + ' to the Office'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            Mark as reported
          </button>
        </>
      }
    >
      {error && <ErrorBanner error={error} />}
      {problem && <ErrorBanner error={problem} />}
      <p className="muted">
        The window on this breach closed {when(breach.notificationDueAt)}. Recording the
        notification does not change that; the register compares the two and keeps the answer.
      </p>
      {late && (
        <p style={{ color: 'var(--danger)' }}>
          The time entered is after the window. The register will record this as a late
          notification, which is a finding in itself - and worth explaining while the reason is
          still known.
        </p>
      )}
      <Field
        label="Sent at"
        id="br-report-at"
        hint="When the notification left the company, not when it is being typed in."
      >
        <input id="br-report-at" className="search-input" type="datetime-local" value={notifiedAt}
          onChange={(e) => setNotifiedAt(e.target.value)} />
      </Field>
      <Field
        label="The Office's reference"
        id="br-report-ref"
        hint="Optional. Whatever the acknowledgement carries, so a later question can be matched to it."
      >
        <input id="br-report-ref" className="search-input" value={reference}
          onChange={(e) => setReference(e.target.value)} />
      </Field>
    </Modal>
  );
}

/** The breach register itself. */
function BreachesPanel({ q, write, reloadKey, busy, commit, notify }: DeskProps) {
  const { user } = useAuth();
  const canCreate = can(user, 'compliance.breaches.create');
  const canUpdate = can(user, 'compliance.breaches.update');
  const canReport = can(user, 'compliance.breaches.report');
  const canClose = can(user, 'compliance.breaches.close');

  const search = q.get('q') ?? '';
  const status = q.get('status') ?? '';
  const severity = q.get('severity') ?? '';
  const notifiable = q.get('notifiable') ?? '';
  const openFilter = q.get('open') ?? '';
  const overdue = q.get('overdue') === 'true';
  const paging = usePaging(q, write);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (search) p.set('search', search);
    if (status) p.set('status', status);
    if (severity) p.set('severity', severity);
    if (notifiable) p.set('notifiable', notifiable);
    if (openFilter) p.set('open', openFilter);
    if (overdue) p.set('overdue', 'true');
    p.set('limit', String(paging.pageSize));
    p.set('offset', String(paging.offset));
    return p.toString();
  }, [search, status, severity, notifiable, openFilter, overdue, paging.pageSize, paging.offset]);

  const state = useRegister<Breach>('/api/ops/compliance/breaches', query, true, reloadKey);
  const rows = state.page?.rows ?? [];

  const [editor, setEditor] = useState<Breach | 'new' | null>(null);
  const [reportTarget, setReportTarget] = useState<Breach | null>(null);
  const [closeTarget, setCloseTarget] = useState<Breach | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Breach | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const filtered = Boolean(search || status || severity || notifiable || openFilter || overdue);
  const clear = () => write({
    q: undefined, status: undefined, severity: undefined, notifiable: undefined,
    open: undefined, overdue: undefined, page: undefined,
  });

  const save = (payload: Record<string, unknown>) => {
    const target = editor;
    if (target === null) return;
    const id = target === 'new' ? null : target.id;
    return commit(
      id === null
        ? 'Breach logged. The notification window is running from the discovery time.'
        : 'Breach updated.',
      async () => {
        await api(
          id === null ? '/api/ops/compliance/breaches' : '/api/ops/compliance/breaches/' + id,
          { method: id === null ? 'POST' : 'PATCH', body: JSON.stringify(payload) }
        );
        setEditor(null);
      }
    );
  };

  const report = async (b: Breach, payload: Record<string, unknown>) => {
    const ok = await commit('Reported to the Office, with the time on the row.', async () => {
      await api('/api/ops/compliance/breaches/' + b.id + '/report', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setReportTarget(null);
    });
    // The Office's reference is the only thing that ties a later question to
    // this notification, so it is worth asking the operator to keep it.
    if (ok) notify('Reported. Keep ' + b.reference + ' and the Office reference together in case of a follow-up.');
    return ok;
  };

  const close = async (b: Breach) => {
    const ok = await commit('Breach closed.', async () => {
      await api('/api/ops/compliance/breaches/' + b.id + '/close', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setCloseTarget(null);
    });
    if (ok) notify('Closed. If the Office asks anything further, the row is the record of what was sent.');
    return ok;
  };

  const remove = (b: Breach) =>
    commit('Breach deleted from the register.', async () => {
      await api('/api/ops/compliance/breaches/' + b.id, { method: 'DELETE' });
      setRemoveTarget(null);
    });

  const closable = (b: Breach) => !(b.notifiable && b.notifiedAt === null);

  const actionsFor = (b: Breach) => (
    <>
      {canUpdate && b.open && (
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setEditor(b)}>Amend</button>
      )}
      {canReport && b.open && b.notifiable && (
        <button className="btn btn-sm" disabled={busy} onClick={() => setReportTarget(b)}>Report</button>
      )}
      {canClose && b.open && (
        <button
          className="btn btn-sm btn-ghost"
          disabled={busy || !closable(b)}
          title={closable(b)
            ? undefined
            : 'Report it to the Office first, or re-assess it as not notifiable, before closing it.'}
          onClick={() => setCloseTarget(b)}
        >
          Close
        </button>
      )}
      {canUpdate && b.open && b.notifiedAt === null && (
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setRemoveTarget(b)}>Delete</button>
      )}
    </>
  );

  const cards = rows.map((b) => (
    <div key={'card-' + b.id} className="record-card">
      <div className="record-card-top">
        <strong className="cell-mono">{b.reference}</strong>
        <Chip value={b.status} />
      </div>
      <div className="record-card-meta">
        <span>{b.title}</span>
        <span>{titleCaseWords(b.severity)}</span>
      </div>
      <div className="record-card-foot">
        <span className="chip"><span className="chip-k">Discovered</span>{day(b.discoveredAt)}</span>
        <span className="chip"><span className="chip-k">Due</span>{when(b.notificationDueAt)}</span>
        <span className="chip">
          <span className="chip-k">Left</span>{b.open ? dueInHours(b.hoursRemaining) : 'Closed'}
        </span>
      </div>
      <div className="row-actions" style={{ marginTop: 8 }}>
        {actionsFor(b)}
        <button className="btn btn-sm btn-ghost" aria-expanded={expanded === b.id}
          onClick={() => setExpanded(expanded === b.id ? null : b.id)}>
          {expanded === b.id ? 'Hide' : 'Details'}
        </button>
      </div>
      {expanded === b.id && <div style={{ marginTop: 10 }}><BreachFacts breach={b} /></div>}
    </div>
  ));

  const table = (
    <table className="data">
      <thead>
        <tr>
          <th>Reference</th>
          <th>Title</th>
          <th>Severity</th>
          <th>Discovered</th>
          <th>Notification due</th>
          <th>Left</th>
          <th>Status</th>
          <th className="cell-num">Actions</th>
        </tr>
      </thead>
      {rows.map((b) => (
        <tbody key={b.id}>
          <tr className={b.overdue ? 'row-warn' : undefined}>
            <td className="cell-mono">{b.reference}</td>
            <td>{b.title}</td>
            <td>{titleCaseWords(b.severity)}</td>
            <td>{day(b.discoveredAt)}</td>
            <td>{when(b.notificationDueAt)}</td>
            <td>{b.open ? dueInHours(b.hoursRemaining) : dash}</td>
            <td>
              <Chip value={b.status} />
              {b.notifiable && b.notifiedAt === null && b.open && (
                <span className="badge badge-amber" style={{ marginLeft: 6 }}>Owes a notification</span>
              )}
              {b.lateNotification && (
                <span className="badge badge-red" style={{ marginLeft: 6 }}>Late</span>
              )}
            </td>
            <td>
              <div className="row-actions">
                {actionsFor(b)}
                <button className="btn btn-sm btn-ghost" aria-expanded={expanded === b.id}
                  onClick={() => setExpanded(expanded === b.id ? null : b.id)}>
                  {expanded === b.id ? 'Hide' : 'Details'}
                </button>
              </div>
            </td>
          </tr>
          {expanded === b.id && (
            <tr>
              <td colSpan={8} style={{ background: 'var(--paper-2)' }}>
                <BreachFacts breach={b} />
              </td>
            </tr>
          )}
        </tbody>
      ))}
    </table>
  );

  return (
    <>
      <FilterBar filtered={filtered} onClear={clear}>
        <SearchBox value={search} label="Search the breach register" placeholder="Reference or title"
          onSearch={(v) => write({ q: v || undefined, page: undefined })} />
        <Select value={status} onChange={(v) => write({ status: v || undefined, page: undefined })}
          options={BREACH_STATUS_FILTERS} label="Breach status" placeholder="Any status"
          labels={BREACH_STATUS_LABELS} width={250} />
        <Select value={severity} onChange={(v) => write({ severity: v || undefined, page: undefined })}
          options={BREACH_SEVERITIES} label="Severity" placeholder="Any severity" width={170} />
        <Select value={notifiable} onChange={(v) => write({ notifiable: v || undefined, page: undefined })}
          options={BREACH_NOTIFIABLE_FILTERS} label="Whether the breach is notifiable"
          placeholder="Notifiable and not" labels={BREACH_NOTIFIABLE_FILTER_LABELS} width={240} />
        <Select value={openFilter} onChange={(v) => write({ open: v || undefined, page: undefined })}
          options={REQUEST_OPEN_FILTERS} label="Whether the breach is still open"
          placeholder="Open and closed" labels={REQUEST_OPEN_FILTER_LABELS} width={210} />
        <FlagToggle label="Past the window" checked={overdue}
          onChange={(v) => write({ overdue: v ? 'true' : undefined, page: undefined })} />
        {canCreate && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setEditor('new')}>
            Log breach
          </button>
        )}
      </FilterBar>

      <RegisterList
        state={state}
        paging={paging}
        filtered={filtered}
        onClearFilters={clear}
        cards={cards}
        table={table}
        empty={{
          title: 'No personal data breach is logged',
          body: 'An empty register means either that nothing has gone wrong, or that nothing was written down. Log the first one, or change the filters if the register is simply narrowed.',
        }}
      />

      {editor !== null && (
        <BreachDialog breach={editor} busy={busy} error={state.error}
          onClose={() => setEditor(null)} onSave={save} />
      )}

      {reportTarget !== null && (
        <ReportBreachDialog breach={reportTarget} busy={busy} error={state.error}
          onClose={() => setReportTarget(null)}
          onConfirm={(payload) => { void report(reportTarget, payload); }} />
      )}

      {closeTarget !== null && (
        <ConfirmDialog
          title="Close this breach?"
          body={
            closeTarget.reference
            + ' has been assessed as '
            + (closeTarget.notifiable ? 'notifiable' : 'not notifiable')
            + '. Closing records that nothing further is owed on it. The row stays, with the notification and the times it carries.'
          }
          confirmLabel="Close the breach"
          onCancel={() => setCloseTarget(null)}
          onConfirm={() => { void close(closeTarget); }}
        />
      )}

      {removeTarget !== null && (
        <ConfirmDialog
          title="Delete this breach?"
          body={
            removeTarget.reference
            + ' has not been reported, so it can still go. Use this only for a row logged in error: once a notification has gone to the Office, deleting our copy would not un-send it.'
          }
          confirmLabel="Delete"
          danger
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => { void remove(removeTarget); }}
        />
      )}
    </>
  );
}

// ----------------------------------------------------------- filing ledger
/**
 * What has been filed with the Office.
 *
 * Nothing on this screen talks to the Office. The Data Protection and Privacy
 * Act requires a controller to register, to notify breaches and to answer
 * subjects, but the Office publishes no submission API: filing happens on the
 * Office's own portal, by post, or in person. So this is not an outbound
 * integration and does not pretend to be one. What it is, is the record that
 * somebody sent something and when - which is the part the company has to be
 * able to show afterwards.
 *
 * That shapes the row. A filing starts as a draft, which is the version being
 * worked on, and only becomes a filing when it is sent, at which point the
 * status, the time and the sender are stamped by the server and the content
 * stops being editable: the row is now the evidence of what went out. The
 * Office's own acknowledgement reference closes the loop, and a rejection is
 * kept with the reason the Office gave rather than being quietly re-drafted.
 */

const SUBMISSION_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft - prepared here, not sent yet',
  FILED: 'Filed - sent to the Office, not yet acknowledged',
  ACKNOWLEDGED: 'Acknowledged - the Office confirmed it',
  REJECTED: 'Rejected - the Office refused it, with the reason on the row',
};

const SUBMISSION_STATUS_FILTERS = ['DRAFT', 'FILED', 'ACKNOWLEDGED', 'REJECTED'] as const;

/** Everything the filing row holds, for the expanded row and the mobile card. */
function FilingFacts({ filing }: { filing: Filing }) {
  const linked = filing.relatedTable === null
    ? 'Not linked to a register row'
    : titleCaseWords(filing.relatedTable) + ' #' + filing.relatedId;
  return (
    <>
      <Facts>
        <Detail label="Type" value={titleCaseWords(filing.submissionType)} />
        <Detail label="Channel" value={titleCaseWords(filing.channel)} />
        <Detail label="Status" value={titleCaseWords(filing.status)} />
        <Detail label="Filed" value={filing.filedAt ? when(filing.filedAt) : 'Not sent yet'} />
        <Detail
          label="Filed by"
          value={filing.filedBy === null ? 'Nobody recorded' : 'User ' + filing.filedBy}
        />
        <Detail label="Linked to" value={linked} />
        <Detail label="Office reference" value={filing.acknowledgementReference} mono />
        <Detail
          label="Acknowledged"
          value={filing.acknowledgedAt ? when(filing.acknowledgedAt) : 'Not acknowledged'}
        />
        <Detail label="Prepared" value={when(filing.createdAt)} />
        <Detail label="Last changed" value={when(filing.updatedAt)} />
      </Facts>
      <p style={{ marginTop: 10 }}>
        <strong>Subject of the filing.</strong> {filing.subject}
      </p>
      {filing.notes && (
        <p style={{ marginTop: 10 }}>
          <strong>Notes.</strong> {filing.notes}
        </p>
      )}
      {filing.rejectionReason && (
        <p style={{ marginTop: 10 }}>
          <strong style={{ color: 'var(--danger)' }}>The Office rejected this.</strong>{' '}
          {filing.rejectionReason}
        </p>
      )}
      <div style={{ marginTop: 10 }}>
        <JsonNote label="Payload sent" value={filing.payload} />
      </div>
      <div style={{ marginTop: 6 }}>
        <JsonNote label="Evidence" value={filing.evidence} />
      </div>
    </>
  );
}

/**
 * Prepare or amend a draft filing.
 *
 * The payload and the evidence are the two things that make a filing worth
 * more than a note that says "we told them": the payload is what the Office was
 * given, and the evidence is what came back. Both are optional while drafting,
 * because a draft is allowed to be unfinished.
 */
function FilingDialog({ filing, busy, error, onClose, onSave }: {
  filing: Filing | 'new';
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const current = filing === 'new' ? null : filing;
  const [submissionType, setSubmissionType] = useState(current?.submissionType ?? 'REGISTRATION');
  const [subject, setSubject] = useState(current?.subject ?? '');
  const [relatedTable, setRelatedTable] = useState(current?.relatedTable ?? '');
  const [relatedId, setRelatedId] = useState(
    current?.relatedId === null || current?.relatedId === undefined ? '' : String(current.relatedId)
  );
  const [channel, setChannel] = useState(current?.channel ?? 'PORTAL');
  const [payload, setPayload] = useState(
    current === null || Object.keys(current.payload).length === 0
      ? ''
      : JSON.stringify(current.payload, null, 2)
  );
  const [evidence, setEvidence] = useState(
    current === null || Object.keys(current.evidence).length === 0
      ? ''
      : JSON.stringify(current.evidence, null, 2)
  );
  const [notes, setNotes] = useState(current?.notes ?? '');
  const [problem, setProblem] = useState('');

  // A filing already linked to a register row keeps that link: the register does
  // not unlink a filing from what it refers to, only re-point it.
  const linkFixed = current !== null && current.relatedTable !== null;

  const submit = () => {
    if (subject.trim() === '') {
      return setProblem(
        'Say what the filing is about. "Annual return, 2026" or "Breach notification PDPO-BR-2026-0001".'
      );
    }
    let parsedPayload: Record<string, unknown>;
    let parsedEvidence: Record<string, unknown>;
    try {
      parsedPayload = parseJson(payload, 'The payload');
      parsedEvidence = parseJson(evidence, 'The evidence');
    } catch (e) {
      return setProblem(e instanceof Error ? e.message : String(e));
    }
    if (relatedTable !== '' && relatedId.trim() === '') {
      return setProblem(
        'A link needs both halves. Give the id of the row this filing refers to, or set the link back to none.'
      );
    }
    if (relatedTable === '' && relatedId.trim() !== '') {
      return setProblem('Choose which register the id belongs to, or clear the id.');
    }
    setProblem('');

    const text: Record<string, unknown> = {
      submissionType,
      subject: subject.trim(),
      channel,
      payload: parsedPayload,
      evidence: parsedEvidence,
      notes: notes.trim() || null,
    };
    if (relatedTable !== '') {
      text.relatedTable = relatedTable;
      text.relatedId = Number(relatedId);
    }
    onSave(text);
  };

  return (
    <Modal
      title={filing === 'new' ? 'Prepare a filing' : 'Amend draft filing'}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {filing === 'new' ? 'Save the draft' : 'Save changes'}
          </button>
        </>
      }
    >
      {error && <ErrorBanner error={error} />}
      {problem && <ErrorBanner error={problem} />}
      <p className="muted">
        This saves a draft. Nothing leaves the building until the draft is filed, and filing here
        records that somebody sent it - the sending itself happens on the Office's own portal.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="What is being filed" id="fl-type">
          <select id="fl-type" className="search-input" value={submissionType}
            onChange={(e) => setSubmissionType(e.target.value)}>
            {SUBMISSION_TYPES.map((t) => <option key={t} value={t}>{titleCaseWords(t)}</option>)}
          </select>
        </Field>
        <Field
          label="How it goes to the Office"
          id="fl-channel"
          hint="Where the filing is actually sent. The portal is the usual route; post and in person are recorded the same way."
        >
          <select id="fl-channel" className="search-input" value={channel}
            onChange={(e) => setChannel(e.target.value)}>
            {SUBMISSION_CHANNELS.map((c) => <option key={c} value={c}>{titleCaseWords(c)}</option>)}
          </select>
        </Field>
      </div>

      <Field
        label="Subject"
        id="fl-subject"
        hint="One line naming the filing, so the ledger reads without opening anything."
      >
        <input id="fl-subject" className="search-input" value={subject}
          onChange={(e) => setSubject(e.target.value)} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field
          label="Linked register"
          id="fl-related-table"
          hint={linkFixed
            ? 'This filing is already linked. The link can be re-pointed but not cleared, because a filing that referred to something still does.'
            : 'Optional. Point the filing at the row it is about, so the register and the ledger agree.'}
        >
          <select id="fl-related-table" className="search-input" value={relatedTable}
            onChange={(e) => {
              setRelatedTable(e.target.value);
              if (e.target.value === '') setRelatedId('');
            }}>
            {!linkFixed && <option value="">Not linked</option>}
            {RELATED_TABLES.map((t) => <option key={t} value={t}>{titleCaseWords(t)}</option>)}
          </select>
        </Field>
        <Field label="Row id" id="fl-related-id" hint="The id on that register. Both halves travel together.">
          <input id="fl-related-id" className="search-input" inputMode="numeric" value={relatedId}
            disabled={relatedTable === ''} onChange={(e) => setRelatedId(e.target.value)} />
        </Field>
      </div>

      <Field
        label="Payload"
        id="fl-payload"
        hint="Optional JSON: what the Office is being given. Leave it empty for a draft that is still being worked on."
      >
        <textarea id="fl-payload" className="search-input" rows={4} value={payload}
          onChange={(e) => setPayload(e.target.value)} />
      </Field>

      <Field
        label="Evidence"
        id="fl-evidence"
        hint="Optional JSON: the receipt, the acknowledgement, the file name that was uploaded - anything that shows it was sent."
      >
        <textarea id="fl-evidence" className="search-input" rows={3} value={evidence}
          onChange={(e) => setEvidence(e.target.value)} />
      </Field>

      <Field label="Notes" id="fl-notes">
        <textarea id="fl-notes" className="search-input" rows={2} value={notes}
          onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Modal>
  );
}

/**
 * Record the Office's own reference for a filing.
 *
 * The reference is what turns "we sent it" into "they have it": it is the only
 * thing that lets a later question be matched to this row, so it is required
 * when the row does not already carry one.
 */
function AcknowledgeFilingDialog({ filing, busy, error, onClose, onConfirm }: {
  filing: Filing;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (reference: string) => void;
}) {
  const [reference, setReference] = useState(filing.acknowledgementReference ?? '');
  const blocked = reference.trim() === '';
  return (
    <Modal
      title="Record the Office's acknowledgement"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || blocked}
            onClick={() => onConfirm(reference.trim())}>
            Record it
          </button>
        </>
      }
    >
      {error && <ErrorBanner error={error} />}
      <p className="muted">
        {filing.subject} was filed {when(filing.filedAt)}. The reference below is the Office's own
        identifier for it, taken from whatever they sent back.
      </p>
      <Field
        label="Acknowledgement reference"
        id="fl-ack-ref"
        hint="Required. Without it the row cannot be tied to anything the Office holds."
      >
        <input id="fl-ack-ref" className="search-input" value={reference}
          onChange={(e) => setReference(e.target.value)} />
      </Field>
    </Modal>
  );
}

/** The filing ledger itself. */
function FilingsPanel({ q, write, reloadKey, busy, commit, notify }: DeskProps) {
  const { user } = useAuth();
  const canFile = can(user, 'compliance.pdpo.file');

  const search = q.get('q') ?? '';
  const status = q.get('status') ?? '';
  const submissionType = q.get('submissionType') ?? '';
  const channel = q.get('channel') ?? '';
  const relatedTable = q.get('relatedTable') ?? '';
  const relatedId = q.get('relatedId') ?? '';
  const paging = usePaging(q, write);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (search) p.set('search', search);
    if (status) p.set('status', status);
    if (submissionType) p.set('submissionType', submissionType);
    if (channel) p.set('channel', channel);
    if (relatedTable) p.set('relatedTable', relatedTable);
    if (relatedId) p.set('relatedId', relatedId);
    p.set('limit', String(paging.pageSize));
    p.set('offset', String(paging.offset));
    return p.toString();
  }, [search, status, submissionType, channel, relatedTable, relatedId, paging.pageSize, paging.offset]);

  const state = useRegister<Filing>('/api/ops/compliance/filings', query, true, reloadKey);
  const rows = state.page?.rows ?? [];

  const [editor, setEditor] = useState<Filing | 'new' | null>(null);
  const [fileTarget, setFileTarget] = useState<Filing | null>(null);
  const [ackTarget, setAckTarget] = useState<Filing | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Filing | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Filing | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const filtered = Boolean(search || status || submissionType || channel || relatedTable || relatedId);
  const clear = () => write({
    q: undefined, status: undefined, submissionType: undefined, channel: undefined,
    relatedTable: undefined, relatedId: undefined, page: undefined,
  });

  const save = (payload: Record<string, unknown>) => {
    const target = editor;
    if (target === null) return;
    const id = target === 'new' ? null : target.id;
    return commit(id === null ? 'Draft filing saved.' : 'Draft filing updated.', async () => {
      await api(
        id === null ? '/api/ops/compliance/filings' : '/api/ops/compliance/filings/' + id,
        { method: id === null ? 'POST' : 'PATCH', body: JSON.stringify(payload) }
      );
      setEditor(null);
    });
  };

  const send = async (f: Filing) => {
    const ok = await commit('Filed. The time and the sender are on the row.', async () => {
      await api('/api/ops/compliance/filings/' + f.id + '/file', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setFileTarget(null);
    });
    // Filing is the moment the row stops being a plan. Saying so is worth a
    // sentence, because the next step is somebody else's.
    if (ok) notify('Filed. Record the Office acknowledgement when it comes back, so the ledger closes.');
    return ok;
  };

  const acknowledge = async (f: Filing, reference: string) => {
    const ok = await commit('Acknowledgement recorded.', async () => {
      await api('/api/ops/compliance/filings/' + f.id + '/acknowledge', {
        method: 'POST',
        body: JSON.stringify({ acknowledgementReference: reference }),
      });
      setAckTarget(null);
    });
    if (ok) notify('Acknowledged. ' + reference + ' is now on the row and can be quoted back to the Office.');
    return ok;
  };

  const reject = async (f: Filing, reason: string) => {
    const ok = await commit('Rejection recorded, with the reason the Office gave.', async () => {
      await api('/api/ops/compliance/filings/' + f.id + '/reject', {
        method: 'POST',
        body: JSON.stringify({ rejectionReason: reason }),
      });
      setRejectTarget(null);
    });
    if (ok) notify('Rejected. Prepare a fresh draft rather than editing this one: this row is what the Office refused.');
    return ok;
  };

  const remove = (f: Filing) =>
    commit('Draft deleted.', async () => {
      await api('/api/ops/compliance/filings/' + f.id, { method: 'DELETE' });
      setRemoveTarget(null);
    });

  const linked = (f: Filing) =>
    f.relatedTable === null ? dash : titleCaseWords(f.relatedTable) + ' #' + f.relatedId;

  const actionsFor = (f: Filing) => (
    <>
      {canFile && f.draft && (
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setEditor(f)}>Amend</button>
      )}
      {canFile && f.draft && (
        <button className="btn btn-sm" disabled={busy} onClick={() => setFileTarget(f)}>File it</button>
      )}
      {canFile && f.filed && f.status !== 'ACKNOWLEDGED' && f.status !== 'REJECTED' && (
        <button className="btn btn-sm" disabled={busy} onClick={() => setAckTarget(f)}>Acknowledge</button>
      )}
      {canFile && f.filed && f.status !== 'REJECTED' && (
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setRejectTarget(f)}>Rejected</button>
      )}
      {canFile && f.draft && (
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setRemoveTarget(f)}>Delete</button>
      )}
    </>
  );

  const cards = rows.map((f) => (
    <div key={'card-' + f.id} className="record-card">
      <div className="record-card-top">
        <strong>{titleCaseWords(f.submissionType)}</strong>
        <Chip value={f.status} />
      </div>
      <div className="record-card-meta">
        <span>{f.subject}</span>
        <span>{titleCaseWords(f.channel)}</span>
      </div>
      <div className="record-card-foot">
        <span className="chip">
          <span className="chip-k">Filed</span>{f.filedAt ? day(f.filedAt) : 'Draft'}
        </span>
        <span className="chip"><span className="chip-k">Linked to</span>{linked(f)}</span>
        <span className="chip">
          <span className="chip-k">Office ref</span>{f.acknowledgementReference ?? dash}
        </span>
      </div>
      <div className="row-actions" style={{ marginTop: 8 }}>
        {actionsFor(f)}
        <button className="btn btn-sm btn-ghost" aria-expanded={expanded === f.id}
          onClick={() => setExpanded(expanded === f.id ? null : f.id)}>
          {expanded === f.id ? 'Hide' : 'Details'}
        </button>
      </div>
      {expanded === f.id && <div style={{ marginTop: 10 }}><FilingFacts filing={f} /></div>}
    </div>
  ));

  const table = (
    <table className="data">
      <thead>
        <tr>
          <th>Type</th>
          <th>Subject</th>
          <th>Channel</th>
          <th>Linked to</th>
          <th>Filed</th>
          <th>Status</th>
          <th className="cell-num">Actions</th>
        </tr>
      </thead>
      {rows.map((f) => (
        <tbody key={f.id}>
          <tr className={f.status === 'REJECTED' ? 'row-warn' : undefined}>
            <td>{titleCaseWords(f.submissionType)}</td>
            <td>{f.subject}</td>
            <td>{titleCaseWords(f.channel)}</td>
            <td>{linked(f)}</td>
            <td className="cell-mono">{f.filedAt ? day(f.filedAt) : dash}</td>
            <td>
              <Chip value={f.status} />
              {f.acknowledgementReference && (
                <span className="cell-mono" style={{ marginLeft: 6 }}>{f.acknowledgementReference}</span>
              )}
            </td>
            <td>
              <div className="row-actions">
                {actionsFor(f)}
                <button className="btn btn-sm btn-ghost" aria-expanded={expanded === f.id}
                  onClick={() => setExpanded(expanded === f.id ? null : f.id)}>
                  {expanded === f.id ? 'Hide' : 'Details'}
                </button>
              </div>
            </td>
          </tr>
          {expanded === f.id && (
            <tr>
              <td colSpan={7} style={{ background: 'var(--paper-2)' }}>
                <FilingFacts filing={f} />
              </td>
            </tr>
          )}
        </tbody>
      ))}
    </table>
  );

  return (
    <>
      <p className="muted" style={{ marginBottom: 10 }}>
        Nothing on this screen talks to the Office. The Act requires the company to register, to
        notify breaches and to answer subjects, but the Office publishes no submission API: the
        filing itself happens on the Office&rsquo;s own portal, by post or in person. This ledger is
        the record that somebody sent it and when, which is the part the company has to be able to
        show afterwards.
      </p>

      <FilterBar filtered={filtered} onClear={clear}>
        <SearchBox value={search} label="Search the filing ledger" placeholder="Subject or reference"
          onSearch={(v) => write({ q: v || undefined, page: undefined })} />
        <Select value={status} onChange={(v) => write({ status: v || undefined, page: undefined })}
          options={SUBMISSION_STATUS_FILTERS} label="Filing status" placeholder="Any status"
          labels={SUBMISSION_STATUS_LABELS} width={250} />
        <Select value={submissionType} onChange={(v) => write({ submissionType: v || undefined, page: undefined })}
          options={SUBMISSION_TYPES} label="What is being filed" placeholder="Any type" width={220} />
        <Select value={channel} onChange={(v) => write({ channel: v || undefined, page: undefined })}
          options={SUBMISSION_CHANNELS} label="How it was sent" placeholder="Any channel" width={180} />
        <Select value={relatedTable} onChange={(v) => write({ relatedTable: v || undefined, page: undefined })}
          options={RELATED_TABLES} label="Linked register" placeholder="Any register"
          labels={{ pdpo_breaches: 'Breaches', pdpo_subject_requests: 'Subject requests', pdpo_processing_activities: 'Processing', pdpo_consents: 'Consents' }} width={200} />
        <NumberFilter value={relatedId} label="Linked row id" placeholder="Row id"
          onApply={(v) => write({ relatedId: v || undefined, page: undefined })} />
        {canFile && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setEditor('new')}>
            Prepare filing
          </button>
        )}
      </FilterBar>

      <RegisterList
        state={state}
        paging={paging}
        filtered={filtered}
        onClearFilters={clear}
        cards={cards}
        table={table}
        empty={{
          title: 'Nothing has been filed with the Office yet',
          body: 'The register, the renewals and every breach notification the company owes end up here. Prepare a draft to get the content right before it goes out, and record it as filed once it has.',
        }}
      />

      {editor !== null && (
        <FilingDialog filing={editor} busy={busy} error={state.error}
          onClose={() => setEditor(null)} onSave={save} />
      )}

      {fileTarget !== null && (
        <ConfirmDialog
          title="Record this as filed?"
          body={
            'This stamps ' + fileTarget.subject + ' with the time and the person filing it, and the content stops being editable from then on. File it only once it has actually gone to the Office.'
          }
          confirmLabel="File it"
          onCancel={() => setFileTarget(null)}
          onConfirm={() => { void send(fileTarget); }}
        />
      )}

      {ackTarget !== null && (
        <AcknowledgeFilingDialog filing={ackTarget} busy={busy} error={state.error}
          onClose={() => setAckTarget(null)}
          onConfirm={(reference) => { void acknowledge(ackTarget, reference); }} />
      )}

      {rejectTarget !== null && (
        <ReasonDialog
          title="Record the Office's rejection"
          body={
            'This closes ' + rejectTarget.subject + ' as rejected and keeps the reason. A rejected filing is not edited back into shape: the row is what the Office refused, and a corrected filing is prepared as a new one.'
          }
          label="The reason the Office gave"
          confirmLabel="Record the rejection"
          danger
          required
          busy={busy}
          onCancel={() => setRejectTarget(null)}
          onConfirm={(reason) => { void reject(rejectTarget, reason); }}
        />
      )}

      {removeTarget !== null && (
        <ConfirmDialog
          title="Delete this draft?"
          body={
            'The draft for ' + removeTarget.subject + ' has not been sent, so nothing depends on it yet. Deleting it leaves no trace of what was being prepared.'
          }
          confirmLabel="Delete"
          danger
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => { void remove(removeTarget); }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ summary

/** A tick or a cross for one line of the self-test. */
function PdpoCheckChip({ ok }: { ok: boolean }) {
  return (
    <span className={'badge ' + (ok ? 'badge-green' : 'badge-red')}>
      <span className="badge-icon" aria-hidden>{ok ? '\u2713' : '\u2715'}</span>
      {ok ? 'Pass' : 'Fail'}
    </span>
  );
}

/**
 * Whether a secret is stored. The API reports that a key exists, never what it
 * is, so this is the most the screen can honestly say about it.
 */
function PdpoSecretState({ label, present, note }: { label: string; present: boolean; note: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span className={'badge ' + (present ? 'badge-green' : 'badge-neutral')}>
        <span className="badge-icon" aria-hidden>{'\u25CF'}</span>
        {present ? label + ' stored' : label + ' not set'}
      </span>
      <span className="muted" style={{ fontSize: 12 }}>{note}</span>
    </div>
  );
}

const REGISTRATION_LABELS: Record<PdpoConfigView['registrationState'], string> = {
  UNREGISTERED: 'Not registered with the Office',
  REGISTERED: 'Registered with the Office',
  EXPIRING: 'Registration expiring',
  EXPIRED: 'Registration expired',
};

const REGISTRATION_TONES: Record<PdpoConfigView['registrationState'], string> = {
  UNREGISTERED: 'badge-neutral',
  REGISTERED: 'badge-green',
  EXPIRING: 'badge-amber',
  EXPIRED: 'badge-red',
};

const ENVIRONMENT_LABELS: Record<PdpoConfigView['environment'], string> = {
  SANDBOX: 'Sandbox',
  PRODUCTION: 'Production',
};

/** Whole days from now until an instant. Negative once the instant has passed. */
function daysAway(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

/** The same in hours, to one decimal place, because the breach window is hours. */
function hoursAway(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round(((t - Date.now()) / 3_600_000) * 10) / 10;
}

/** The remaining certificate days as a person reads them. */
function registrationDays(days: number | null): string {
  if (days === null) return dash;
  return String(days) + ' day' + (days === 1 ? '' : 's');
}

/**
 * Every number the status endpoint returns, with the sentence that stops it
 * being misread. The list is exhaustive over PdpoStatusTotals on purpose: a new
 * counter on the server should force a decision here rather than go unshown.
 */
const COUNT_CARDS: Array<{ label: string; key: keyof PdpoStatusTotals; sub: string; tone?: string }> = [
  { label: 'Activities active', key: 'activitiesActive', sub: 'Still processed under a lawful basis.' },
  { label: 'Activities retired', key: 'activitiesRetired', sub: 'Kept for the record, no longer processed.' },
  { label: 'Consents held', key: 'consentsGranted', sub: 'Live consent, per subject and purpose.' },
  { label: 'Consents withdrawn', key: 'consentsWithdrawn', sub: 'Withdrawn by the subject.' },
  { label: 'Consents expired', key: 'consentsExpired', sub: 'Past the expiry the subject agreed to.' },
  { label: 'Requests open', key: 'requestsOpen', sub: 'Subject requests still being answered.' },
  { label: 'Requests overdue', key: 'requestsOverdue', sub: 'Past the statutory response date.', tone: 'danger' },
  { label: 'Requests closed', key: 'requestsClosed', sub: 'Answered, refused or withdrawn.' },
  { label: 'Breaches open', key: 'breachesOpen', sub: 'Not yet contained.' },
  { label: 'Breaches overdue', key: 'breachesOverdue', sub: 'The notification window has closed.', tone: 'danger' },
  { label: 'Breaches notified', key: 'breachesNotified', sub: 'The Office has been told.' },
  { label: 'Notified late', key: 'breachesLate', sub: 'Told after the window had closed.', tone: 'warn' },
  { label: 'Filings in draft', key: 'submissionsDraft', sub: 'Prepared but not yet sent.' },
  { label: 'Filings sent', key: 'submissionsFiled', sub: 'Recorded as sent to the Office.' },
  { label: 'Filings acknowledged', key: 'submissionsAcknowledged', sub: 'The Office replied with a reference.' },
  { label: 'Filings rejected', key: 'submissionsRejected', sub: 'The Office refused the filing.', tone: 'danger' },
];

// ---------------------------------------------------------------- overview

/**
 * The overview reads the status endpoint rather than a register page. It is a
 * single object describing the whole workspace, so there is nothing to page
 * through: every register is summarised here and detailed on its own tab.
 */
function PdpoOverviewPanel({ reloadKey }: { reloadKey: number }) {
  const [status, setStatus] = useState<PdpoStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    api<{ data: PdpoStatusView }>('/api/ops/compliance/status')
      .then((r) => { if (live) setStatus(r.data ?? null); })
      .catch((e) => {
        if (live) {
          setStatus(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [reloadKey]);

  if (loading) return <Skeleton rows={6} />;
  if (error) return <ErrorBanner error={error} />;
  if (!status) {
    return (
      <EmptyState
        title="Nothing to report yet"
        body="The status endpoint returned no reading for this company."
      />
    );
  }

  const { config, totals, warnings } = status;
  const ready = config.readyToFile;
  const nextRequest = daysAway(status.nextRequestDueAt);
  const nextBreach = hoursAway(status.nextBreachDueAt);

  return (
    <>
      <section className="card card-pad">
        <div className="card-head">
          <h3>Readiness to file</h3>
          <span className={'badge ' + (ready ? 'badge-green' : 'badge-amber')}>
            <span className="badge-icon" aria-hidden>{ready ? '\u2713' : '\u26A0'}</span>
            {ready ? 'Ready to file' : 'Not ready'}
          </span>
        </div>
        <p className="muted">
          {ready
            ? 'The registration, the named data protection officer and both statutory windows are recorded, so a filing can be prepared and sent.'
            : 'A filing cannot be sent until the gaps below are closed. Each one is a field on the Configuration tab.'}
        </p>
        {warnings.length > 0 ? (
          <ul style={{ margin: '8px 0 0 18px' }}>
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        ) : (
          <p style={{ margin: '8px 0 0', color: 'var(--success)' }}>No outstanding configuration problems.</p>
        )}
      </section>

      <div className="kpi-grid">
        {COUNT_CARDS.map((c) => (
          <StatCard key={c.key} label={c.label} value={totals[c.key] ?? 0} sub={c.sub} tone={c.tone} />
        ))}
      </div>

      <section className="card card-pad">
        <div className="card-head"><h3>What is due next</h3></div>
        <Facts>
          <Detail
            label="Next subject request"
            value={status.nextRequestDueAt
              ? dueIn(nextRequest) + ' \u00B7 ' + day(status.nextRequestDueAt)
              : 'None outstanding'}
          />
          <Detail
            label="Next breach notification"
            value={status.nextBreachDueAt
              ? dueInHours(nextBreach) + ' \u00B7 ' + when(status.nextBreachDueAt)
              : 'None outstanding'}
          />
          <Detail label="Last filed with the Office" value={when(status.lastFiledAt)} />
        </Facts>
      </section>

      <section className="card card-pad">
        <div className="card-head">
          <h3>Office identity</h3>
          <span className={'badge ' + REGISTRATION_TONES[config.registrationState]}>
            <span className="badge-icon" aria-hidden>{'\u25CF'}</span>
            {REGISTRATION_LABELS[config.registrationState]}
          </span>
        </div>
        <Facts>
          <Detail label="Certificate number" value={config.registrationNumber} mono />
          <Detail label="Certificate expires" value={day(config.registrationExpiresOn)} />
          <Detail label="Days remaining" value={registrationDays(config.registrationDaysRemaining)} />
          <Detail label="Data protection officer" value={config.dpoName} />
          <Detail label="DPO email" value={config.dpoEmail} />
          <Detail label="DPO phone" value={config.dpoPhone} />
          <Detail label="Environment" value={ENVIRONMENT_LABELS[config.environment]} />
          <Detail label="Portal address" value={config.portalBaseUrl} mono />
          <Detail label="Breach notification window" value={String(config.breachNotificationHours) + ' hours'} />
          <Detail label="Subject request window" value={String(config.subjectRequestDays) + ' days'} />
          <Detail label="Last self-test" value={when(config.lastTestedAt)} />
        </Facts>
      </section>
    </>
  );
}

// ------------------------------------------------------------------- config

/** One register inside the inspection pack, as the export endpoint returns it. */
type PdpoExportRegister = { rows: unknown[]; total: number; truncated: boolean };

/** The whole inspection pack: every register, plus the identity it is filed under. */
type PdpoExportPack = {
  generatedAt: string;
  config: PdpoConfigView;
  processingActivities: PdpoExportRegister;
  consents: PdpoExportRegister;
  subjectRequests: PdpoExportRegister;
  breaches: PdpoExportRegister;
  filings: PdpoExportRegister;
};

/**
 * The identity the company files under, the two statutory windows, and the
 * portal key. Nothing secret is ever read back: the API reports whether a key
 * is stored, not what it is, so the key box always starts empty.
 */
function PdpoConfigPanel({ reloadKey, busy, commit, notify }: {
  reloadKey: number;
  busy: boolean;
  commit: (ok: string, fn: () => Promise<unknown>) => Promise<boolean>;
  notify: (message: string) => void;
}) {
  const { user } = useAuth();
  const canExport = can(user, 'compliance.pdpo.export');

  const [config, setConfig] = useState<PdpoConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<PdpoConnectionTestResult | null>(null);
  const [savedWarnings, setSavedWarnings] = useState<string[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [downloadedAt, setDownloadedAt] = useState('');
  const [clipped, setClipped] = useState<string[]>([]);

  const [environment, setEnvironment] = useState<PdpoConfigView['environment']>('SANDBOX');
  const [isActive, setIsActive] = useState(false);
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [registrationExpiresOn, setRegistrationExpiresOn] = useState('');
  const [dpoName, setDpoName] = useState('');
  const [dpoEmail, setDpoEmail] = useState('');
  const [dpoPhone, setDpoPhone] = useState('');
  const [portalBaseUrl, setPortalBaseUrl] = useState('');
  const [breachNotificationHours, setBreachNotificationHours] = useState('72');
  const [subjectRequestDays, setSubjectRequestDays] = useState('30');
  const [portalApiKey, setPortalApiKey] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    api<{ data: PdpoConfigView }>('/api/ops/compliance/config')
      .then((r) => {
        if (!live) return;
        const v = r.data ?? null;
        setConfig(v);
        if (v) {
          setEnvironment(v.environment);
          setIsActive(v.isActive);
          setRegistrationNumber(v.registrationNumber ?? '');
          setRegistrationExpiresOn(dayInput(v.registrationExpiresOn));
          setDpoName(v.dpoName ?? '');
          setDpoEmail(v.dpoEmail ?? '');
          setDpoPhone(v.dpoPhone ?? '');
          setPortalBaseUrl(v.portalBaseUrl ?? '');
          setBreachNotificationHours(String(v.breachNotificationHours));
          setSubjectRequestDays(String(v.subjectRequestDays));
          setPortalApiKey('');
        }
      })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [reloadKey]);

  /**
   * The server is the authority on what is still missing, so the sentence after
   * saving repeats what it reported rather than re-deriving it from the form.
   */
  const save = async () => {
    let warnings: string[] = [];
    const ok = await commit('Configuration saved', async () => {
      const r = await api<{ data: { config: PdpoConfigView; warnings: string[] } }>('/api/ops/compliance/config', {
        method: 'PATCH',
        body: JSON.stringify({
          environment,
          isActive,
          registrationNumber,
          registrationExpiresOn,
          dpoName,
          dpoEmail,
          dpoPhone,
          portalBaseUrl,
          breachNotificationHours: Number(breachNotificationHours),
          subjectRequestDays: Number(subjectRequestDays),
          portalApiKey,
        }),
      });
      warnings = r.data?.warnings ?? [];
      setSavedWarnings(warnings);
      if (r.data?.config) setConfig(r.data.config);
      setPortalApiKey('');
    });
    if (ok) {
      notify(warnings.length === 0
        ? 'Configuration saved. Nothing is outstanding.'
        : 'Configuration saved with ' + String(warnings.length) + (warnings.length === 1 ? ' item still to do.' : ' items still to do.'));
    }
  };

  /** The self-test is a read-only round trip: it reports, it does not change. */
  const runTest = async () => {
    setTesting(true);
    setError('');
    try {
      const r = await api<{ data: PdpoConnectionTestResult }>('/api/ops/compliance/test-connection', { method: 'POST' });
      setTestResult(r.data ?? null);
      if (r.data?.config) setConfig(r.data.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  /**
   * The inspection pack is built from the registers rather than from this
   * screen, and is handed over as a file. A register the server had to clip is
   * called out afterwards rather than silently trimmed.
   */
  const download = async () => {
    setDownloading(true);
    setError('');
    try {
      const r = await api<{ data: PdpoExportPack }>('/api/ops/compliance/export');
      const pack = r.data;
      const registers: Array<[string, PdpoExportRegister]> = [
        ['Processing activities', pack.processingActivities],
        ['Consents', pack.consents],
        ['Subject requests', pack.subjectRequests],
        ['Breaches', pack.breaches],
        ['Filings', pack.filings],
      ];
      const short: string[] = [];
      for (const [label, register] of registers) {
        if (register.truncated) {
          short.push(label + ' - ' + String(register.rows.length) + ' of ' + String(register.total));
        }
      }
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'pdpo-inspection-pack-' + pack.generatedAt.slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setClipped(short);
      setDownloadedAt(pack.generatedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  };

  if (loading) return <Skeleton rows={8} />;

  return (
    <>
      {error && <ErrorBanner error={error} />}

      <section className="card card-pad">
        <div className="card-head">
          <h3>Where the company stands with the Office</h3>
          {config && (
            <span className={'badge ' + REGISTRATION_TONES[config.registrationState]}>
              <span className="badge-icon" aria-hidden>{'\u25CF'}</span>
              {REGISTRATION_LABELS[config.registrationState]}
            </span>
          )}
        </div>
        {config === null ? (
          <p className="muted">Nothing is stored for this company yet.</p>
        ) : (
          <Facts>
            <Detail label="Integration" value={config.name} />
            <Detail label="Status" value={titleCaseWords(config.status)} />
            <Detail label="Active" value={config.isActive ? 'Yes' : 'No'} />
            <Detail label="Environment" value={ENVIRONMENT_LABELS[config.environment]} />
            <Detail label="Certificate number" value={config.registrationNumber} mono />
            <Detail label="Certificate expires" value={day(config.registrationExpiresOn)} />
            <Detail label="Days remaining" value={registrationDays(config.registrationDaysRemaining)} />
            <Detail label="Ready to file" value={config.readyToFile ? 'Yes' : 'No'} />
            <Detail label="Last self-test" value={when(config.lastTestedAt)} />
          </Facts>
        )}
      </section>

      <section className="card card-pad">
        <div className="card-head">
          <h3>Identity and windows</h3>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => { void save(); }}>Save</button>
        </div>
        <p className="muted">
          These are the facts a filing is made under: who the company is, who answers for
          personal data, and how long the Act gives it to answer a subject and to notify a
          breach. Clearing a box removes the value rather than storing an empty one.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
          <Field label="Environment" hint="Sandbox exercises the checks without the live Office." id="pdpo-environment">
            <select
              id="pdpo-environment"
              className="search-input"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value as PdpoConfigView['environment'])}
            >
              <option value="SANDBOX">Sandbox</option>
              <option value="PRODUCTION">Production</option>
            </select>
          </Field>
          <Field label="Certificate number" hint="The registration number the Office issued." id="pdpo-registration-number">
            <input
              id="pdpo-registration-number"
              className="search-input"
              value={registrationNumber}
              onChange={(e) => setRegistrationNumber(e.target.value)}
              placeholder="PDPO/2026/00123"
            />
          </Field>
          <Field label="Certificate expires" hint="Leave empty if the certificate does not expire." id="pdpo-registration-expires">
            <input
              id="pdpo-registration-expires"
              className="search-input"
              type="date"
              value={registrationExpiresOn}
              onChange={(e) => setRegistrationExpiresOn(e.target.value)}
            />
          </Field>
          <Field label="Breach window (hours)" hint="The Act allows 72 hours from discovery." id="pdpo-breach-hours">
            <input
              id="pdpo-breach-hours"
              className="search-input"
              type="number"
              min={1}
              max={720}
              value={breachNotificationHours}
              onChange={(e) => setBreachNotificationHours(e.target.value)}
            />
          </Field>
          <Field label="Subject request window (days)" hint="How long the company allows itself to answer a data subject." id="pdpo-request-days">
            <input
              id="pdpo-request-days"
              className="search-input"
              type="number"
              min={1}
              max={365}
              value={subjectRequestDays}
              onChange={(e) => setSubjectRequestDays(e.target.value)}
            />
          </Field>
          <Field label="Portal address" hint="Where the Office is reached. Recorded, not called." id="pdpo-portal-url">
            <input
              id="pdpo-portal-url"
              className="search-input"
              value={portalBaseUrl}
              onChange={(e) => setPortalBaseUrl(e.target.value)}
              placeholder="https://..."
            />
          </Field>
          <Field label="Data protection officer" hint="The person accountable under the Act." id="pdpo-dpo-name">
            <input
              id="pdpo-dpo-name"
              className="search-input"
              value={dpoName}
              onChange={(e) => setDpoName(e.target.value)}
            />
          </Field>
          <Field label="DPO email" id="pdpo-dpo-email">
            <input
              id="pdpo-dpo-email"
              className="search-input"
              type="email"
              value={dpoEmail}
              onChange={(e) => setDpoEmail(e.target.value)}
            />
          </Field>
          <Field label="DPO phone" id="pdpo-dpo-phone">
            <input
              id="pdpo-dpo-phone"
              className="search-input"
              value={dpoPhone}
              onChange={(e) => setDpoPhone(e.target.value)}
            />
          </Field>
          <Field label="New portal API key" hint="Stored as written and never read back." id="pdpo-portal-key">
            <input
              id="pdpo-portal-key"
              className="search-input"
              type="password"
              autoComplete="new-password"
              value={portalApiKey}
              onChange={(e) => setPortalApiKey(e.target.value)}
            />
          </Field>
        </div>

        <div style={{ marginTop: 12 }}>
          <PdpoSecretState
            label="Portal API key"
            present={config?.portalApiKeyPresent ?? false}
            note="Leave empty to keep the stored key."
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <FlagToggle
            label={isActive ? 'Integration active' : 'Integration switched off'}
            checked={isActive}
            onChange={setIsActive}
          />
          <p className="muted" style={{ marginTop: 6 }}>
            While the integration is off, a filing can still be drafted but not recorded
            as sent.
          </p>
        </div>

        {savedWarnings.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <strong>Still to do</strong>
            <ul style={{ margin: '6px 0 0 18px' }}>
              {savedWarnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
        )}
      </section>

      <section className="card card-pad">
        <div className="card-head">
          <h3>Self-test</h3>
          <button className="btn btn-sm" disabled={testing} onClick={() => { void runTest(); }}>
            {testing ? 'Testing...' : 'Run self-test'}
          </button>
        </div>
        <p className="muted">
          The self-test reads back what is stored and reports each check. A critical
          failure means a filing could not be recorded as sent while the integration
          stands as it does.
        </p>
        {testResult === null ? (
          <p className="muted">Not run in this session yet.</p>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span className={'badge ' + (testResult.ok ? 'badge-green' : 'badge-red')}>
                <span className="badge-icon" aria-hidden>{testResult.ok ? '\u2713' : '\u2715'}</span>
                {testResult.status === 'CONNECTED' ? 'Connected' : 'Error'}
              </span>
              <span className="muted">{when(testResult.testedAt)}</span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Result</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {testResult.checks.map((c) => (
                    <tr key={c.key}>
                      <td>
                        {c.label}
                        {c.critical && <span className="muted"> (critical)</span>}
                      </td>
                      <td><PdpoCheckChip ok={c.ok} /></td>
                      <td className="muted">{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="card card-pad">
        <div className="card-head">
          <h3>Inspection pack</h3>
          {canExport && (
            <button className="btn btn-sm" disabled={downloading} onClick={() => { void download(); }}>
              {downloading ? 'Preparing...' : (downloadedAt === '' ? 'Download the inspection pack' : 'Download again')}
            </button>
          )}
        </div>
        <p className="muted">
          One JSON file holding every register as it stands - processing activities,
          consents, subject requests, breaches and filings - together with the identity
          the company files under. It is generated from the registers rather than from
          this screen, so it is what an inspector would be shown.
        </p>
        {!canExport && (
          <p className="muted">
            Exporting the inspection pack needs the <b>compliance.pdpo.export</b> permission.
          </p>
        )}
        {downloadedAt !== '' && <p className="muted">Generated {when(downloadedAt)}.</p>}
        {clipped.length > 0 && (
          <div>
            <b>The pack is not complete.</b> The server caps each register at 200 rows, and these were clipped:
            <ul style={{ margin: '6px 0 0 18px' }}>
              {clipped.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </div>
        )}
        {clipped.length === 0 && downloadedAt !== '' && (
          <p className="muted">No register was clipped: every row is in the file.</p>
        )}
      </section>
    </>
  );
}

// --------------------------------------------------------------- workspace

/**
 * The data protection workspace. The section lives in the path rather than the
 * query string, so a link to the breach register, for example, can be pasted
 * into an email and still open on that register.
 */
export default function CompliancePdpo({ path }: { path: string }) {
  const { user } = useAuth();
  const qs = useHashQuery();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const section = sectionFromPath(path);
  const meta = SECTION_META[section];

  /** Move to another section, keeping the filters but dropping the page number. */
  const go = (s: Section) => {
    const next: Record<string, string> = {};
    qs.forEach((v, k) => { if (k !== 'page') next[k] = v; });
    navigate('/compliance' + (s === 'overview' ? '' : '/' + s), { query: next });
  };

  /** Filters are written back to the address bar so the view is shareable. */
  const write = useCallback((patch: Record<string, string | number | undefined>) => {
    const next: Record<string, string> = {};
    qs.forEach((v, k) => { next[k] = v; });
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') delete next[k];
      else next[k] = String(v);
    }
    navigate('/compliance' + (section === 'overview' ? '' : '/' + section), { query: next });
  }, [qs, section]);

  /**
   * Every write goes through here: one place sets the busy flag, clears the last
   * error and, on success, forces the registers to re-read.
   */
  const commit = useCallback(async (ok: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setNotice(ok);
      setReloadKey((n) => n + 1);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const notify = useCallback((message: string) => { setNotice(message); }, []);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="adm">Compliance</p>
          <h1>Data protection</h1>
          <p className="muted">{meta.blurb}</p>
        </div>
      </header>

      <nav className="toolbar" aria-label="Data protection sections" style={{ gap: 6 }}>
        {SECTIONS.map((s) => {
          if (!can(user, SECTION_META[s].perm)) return null;
          return (
            <button
              key={s}
              className={'btn btn-sm' + (section === s ? ' btn-primary' : ' btn-ghost')}
              aria-current={section === s ? 'page' : undefined}
              onClick={() => go(s)}
            >
              {SECTION_META[s].label}
            </button>
          );
        })}
      </nav>

      {error && <ErrorBanner error={error} />}
      {notice && <div className="notice-banner" role="status">{notice}</div>}

      {!can(user, meta.perm) ? (
        <EmptyState
          title="This section is not yours to see"
          body={'It needs the ' + meta.perm + ' permission.'}
        />
      ) : (
        <>
          {section === 'overview' && <PdpoOverviewPanel reloadKey={reloadKey} />}
          {section === 'activities' && (
            <ActivitiesPanel q={qs} write={write} reloadKey={reloadKey} busy={busy} commit={commit} notify={notify} />
          )}
          {section === 'consents' && (
            <ConsentsPanel q={qs} write={write} reloadKey={reloadKey} busy={busy} commit={commit} notify={notify} />
          )}
          {section === 'requests' && (
            <RequestsPanel q={qs} write={write} reloadKey={reloadKey} busy={busy} commit={commit} notify={notify} />
          )}
          {section === 'breaches' && (
            <BreachesPanel q={qs} write={write} reloadKey={reloadKey} busy={busy} commit={commit} notify={notify} />
          )}
          {section === 'filings' && (
            <FilingsPanel q={qs} write={write} reloadKey={reloadKey} busy={busy} commit={commit} notify={notify} />
          )}
          {section === 'config' && (
            <PdpoConfigPanel reloadKey={reloadKey} busy={busy} commit={commit} notify={notify} />
          )}
        </>
      )}
    </div>
  );
}
