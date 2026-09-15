import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../api';
import { ErrorBanner, Modal, PageLoader } from '../components/ui';
import { can, useAuth } from '../auth';
import { navigate } from '../router';

/**
 * Organisation Settings - the ERP control plane.
 *
 * Every value on this screen is read from, and written back to, the
 * organisation settings API. Nothing here is a local toggle: the catalogue the
 * server publishes drives which inputs exist, which of them are secret, which
 * are immutable and which need a typed confirmation, and the server re-checks
 * all of that on the way in. The screen's job is to make a refusal legible
 * before it happens rather than to be the thing that enforces it.
 *
 * Writes are gated per category, so a payroll manager reaches this page and
 * edits payroll without being able to rewrite tax law; the buttons that would
 * fail are disabled here and refused with a 403 if called anyway.
 */

type SettingType =
  | 'text' | 'textarea' | 'number' | 'boolean' | 'select'
  | 'color' | 'url' | 'email' | 'tel' | 'date';

type Kind =
  | 'settings' | 'structure' | 'security_policy' | 'tax'
  | 'approvals' | 'signatures' | 'integrations' | 'retention' | 'audit';

type Draft = string | boolean;
type Row = Record<string, unknown>;

interface SettingDef {
  label: string;
  help?: string;
  type: SettingType;
  options?: string[];
  default?: string | number | boolean;
  group?: string;
  secret?: boolean;
  min?: number;
  max?: number;
}

interface FieldDef {
  key: string;
  kind: string;
  options?: string[] | null;
  required?: boolean;
}

interface Category {
  id: string;
  label: string;
  group: string;
  blurb: string;
  kind: Kind;
  manage: string;
  settings?: Record<string, SettingDef>;
  root?: boolean;
  companyScoped?: boolean;
  branchScoped?: boolean;
  required?: string[];
  fields?: FieldDef[];
}

interface Catalogue {
  groups: string[];
  categories: Category[];
  viewPermission: string;
  immutableKeys: string[];
  dangerousKeys: string[];
}

interface CategoryView {
  category: Category;
  kind: Kind;
  values?: Record<string, unknown>;
  secrets?: Record<string, boolean>;
  list?: unknown;
  overview?: Record<string, unknown> | null;
  readOnly?: boolean;
}

interface HistoryEntry {
  id: string;
  at: string | null;
  actor: string | null;
  action: string;
  key: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  ip: string | null;
}

const BASE = '/api/ops/organisation-settings';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^https?:\/\/\S+$/i;
const PHONE_RE = /^\+?[0-9\s().-]{6,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isBlank = (v: unknown) => v === null || v === undefined || v === '';

const toDraft = (v: unknown): Draft =>
  isBlank(v) ? '' : typeof v === 'boolean' ? v : String(v);

/** Compares a draft against a stored value without turning false into an empty string. */
const sameDraft = (a: Draft | undefined, b: unknown): boolean => {
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  return String(a ?? '') === String(b ?? '');
};

const fmt = (v: unknown) =>
  isBlank(v) ? '-' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);

const fmtWhen = (v: unknown) => {
  if (isBlank(v)) return '-';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime())
    ? String(v)
    : d.toLocaleString('en-UG', { dateStyle: 'medium', timeStyle: 'short' });
};

const messageOf = (e: unknown): string => {
  if (e instanceof ApiError) {
    return e.status === 403
      ? 'You do not have permission to change this. ' + e.message
      : e.message;
  }
  return e instanceof Error ? e.message : 'Request failed';
};

const str = (v: unknown): string => (isBlank(v) ? '' : String(v));
const arr = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const rowsOf = (v: unknown): Row[] => arr((v as { rows?: unknown } | null)?.rows);

const titleCase = (v: unknown) =>
  str(v)
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

const tone = (v: unknown): string => {
  const s = str(v).toUpperCase();
  if (['ACTIVE', 'CONNECTED', 'APPROVED', 'OPEN', 'OK', 'SUCCESS', 'UP'].includes(s)) return 'green';
  if (['DRAFT', 'PENDING', 'TESTING', 'SOFT_CLOSE', 'INACTIVE', 'SUSPENDED', 'EXPIRED', 'DEGRADED'].includes(s)) return 'amber';
  if (['ARCHIVED', 'REVOKED', 'REJECTED', 'ERROR', 'DISCONNECTED', 'LOCKED', 'CLOSED', 'DOWN'].includes(s)) return 'red';
  return 'neutral';
};

/** A tone-coloured status chip. Badge() in ui.tsx only knows business statuses. */
function Chip({ value, label }: { value: unknown; label?: string }) {
  const text = label ?? (isBlank(value) ? 'Not set' : titleCase(value));
  return <span className={'badge badge-' + tone(value)}>{text}</span>;
}

function valueProblem(def: SettingDef, draft: Draft | undefined): string | null {
  if (def.type === 'boolean') return null;
  const raw = draft === undefined ? '' : String(draft);
  if (!raw) return null;
  if (def.type === 'color' && !HEX_RE.test(raw)) return 'Use a hex colour such as #1261A0.';
  if (def.type === 'email' && !EMAIL_RE.test(raw)) return 'Enter a valid email address.';
  if (def.type === 'url' && !URL_RE.test(raw)) return 'Enter a full URL starting with http:// or https://.';
  if (def.type === 'tel' && !PHONE_RE.test(raw)) return 'Enter a valid phone number.';
  if (def.type === 'date' && !DATE_RE.test(raw)) return 'Use YYYY-MM-DD.';
  if (def.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return 'Enter a number.';
    if (def.min != null && n < def.min) return 'Must be at least ' + def.min + '.';
    if (def.max != null && n > def.max) return 'Must be at most ' + def.max + '.';
  }
  if (def.type === 'select' && def.options && def.options.length > 0 && !def.options.includes(raw)) {
    return 'Choose one of: ' + def.options.join(', ') + '.';
  }
  return null;
}

/**
 * One input, chosen by the declared type.
 *
 * The control carries no class of its own: the settings rows style it through
 * .setting-control and the record forms style it through .field, so the same
 * element looks right in both places without a second design system.
 */
function FieldInput({
  type,
  options,
  value,
  disabled,
  placeholder,
  onChange,
}: {
  type: SettingType;
  options?: string[];
  value: Draft;
  disabled?: boolean;
  placeholder?: string;
  onChange: (v: Draft) => void;
}) {
  if (type === 'boolean') {
    return (
      <label className="check">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{value === true ? 'Enabled' : 'Disabled'}</span>
      </label>
    );
  }
  if (type === 'select') {
    const opts = options ?? [];
    return (
      <select
        value={String(value ?? '')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Not set</option>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (type === 'textarea') {
    return (
      <textarea
        rows={3}
        value={String(value ?? '')}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (type === 'color') {
    const v = String(value ?? '');
    return (
      <div className="setting-color-wrap">
        <input
          type="color"
          className="setting-swatch"
          value={HEX_RE.test(v) ? v : '#1261A0'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          type="text"
          className="setting-color-text"
          value={v}
          disabled={disabled}
          placeholder="#1261A0"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }
  const html =
    type === 'number' ? 'number'
    : type === 'date' ? 'date'
    : type === 'email' ? 'email'
    : type === 'tel' ? 'tel'
    : 'text';
  return (
    <input
      type={html}
      value={String(value ?? '')}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Empty({ children }: { children: string }) {
  return <div className="empty-state">{children}</div>;
}

function PanelError({ error }: { error: unknown }) {
  if (!error) return null;
  return <ErrorBanner error={error} />;
}

/** Loads one GET endpoint and exposes a reload trigger. */
function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    api<{ data: T }>(path)
      .then((r) => {
        if (!alive) return;
        setData(r.data);
        setError(null);
      })
      .catch((e) => {
        if (alive) setError(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [path, tick]);
  return {
    data,
    error,
    loading,
    reload: useCallback(() => setTick((t) => t + 1), []),
  };
}

/** A small "field label + control + inline error" block for the record modals. */
function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={'field' + (error ? ' field-invalid' : '')}>
      <label className={required ? 'field-required' : undefined}>{label}</label>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

/** Renders rows against a column list, for the categories that are lists. */
function RecordTable({
  columns,
  rows,
  empty,
}: {
  columns: Array<{ key: string; label: string; render?: (row: Row) => ReactNode }>;
  rows: Row[];
  empty: string;
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={str(row.id) || String(i)}>
              {columns.map((c) => (
                <td key={c.key}>{c.render ? c.render(row) : fmt(row[c.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Two columns of before/after, used by the history and audit tables. */
function BeforeAfter({ before, after }: { before: unknown; after: unknown }) {
  return (
    <span className="audit-diff">
      <span className="audit-old">{fmt(before)}</span>
      <span className="audit-arrow"> &rarr; </span>
      <span className="audit-new">{fmt(after)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Settings form (kind: 'settings')
// ---------------------------------------------------------------------------

/**
 * The generic settings editor.
 *
 * Grouped by the catalogue's own `group` field rather than by anything this
 * file decides, so a category gains a sub-section by declaring one. A secret is
 * never rendered as a value - the server sends presence only - so the row shows
 * whether one is stored and offers a replace or a clear instead.
 */
function SettingsForm({
  category,
  values,
  secrets,
  drafts,
  dirty,
  errors,
  disabled,
  immutableKeys,
  clearedSecrets,
  onDraft,
  onResetKey,
  onToggleClear,
}: {
  category: Category;
  values: Record<string, unknown>;
  secrets: Record<string, boolean>;
  drafts: Record<string, Draft>;
  dirty: string[];
  errors: Record<string, string>;
  disabled: boolean;
  immutableKeys: string[];
  clearedSecrets: string[];
  onDraft: (key: string, v: Draft) => void;
  onResetKey: (key: string) => void;
  onToggleClear: (key: string, on: boolean) => void;
}) {
  const defs = category.settings ?? {};
  const keys = Object.keys(defs);
  const groups: string[] = [];
  for (const key of keys) {
    const g = defs[key].group ?? 'General';
    if (!groups.includes(g)) groups.push(g);
  }
  const dirtySet = new Set(dirty);
  const immutable = new Set(immutableKeys);

  if (keys.length === 0) {
    return <Empty>This category holds no editable settings.</Empty>;
  }

  const renderRow = (key: string) => {
    const def = defs[key];
    const locked = immutable.has(key);
    const isSecret = def.secret === true || secrets[key] !== undefined;
    const cleared = clearedSecrets.includes(key);
    const isDirty = dirtySet.has(key);
    const problem = errors[key] ?? null;
    const draft: Draft = isSecret ? (drafts[key] ?? '') : (drafts[key] ?? toDraft(values[key]));

    return (
      <div key={key} className={'setting-row' + (isDirty ? ' dirty' : '')}>
        <div className="setting-info">
          <div className="setting-label">
            {def.label}
            {locked && <span className="badge badge-neutral">Fixed</span>}
          </div>
          {def.help && <span className="field-hint">{def.help}</span>}
          <span className="muted" style={{ fontSize: 11 }}>{key}</span>
        </div>

        <div className={'setting-control' + (problem ? ' setting-err' : '')}>
          {isSecret ? (
            <div className="setting-input-wrap">
              <input
                type="password"
                value={String(draft ?? '')}
                disabled={disabled || locked || cleared}
                placeholder={secrets[key] ? 'Stored - type to replace' : 'Not set'}
                onChange={(e) => onDraft(key, e.target.value)}
              />
              <Chip
                value={cleared ? 'REVOKED' : secrets[key] ? 'ACTIVE' : 'INACTIVE'}
                label={cleared ? 'Cleared on save' : secrets[key] ? 'Stored' : 'Not set'}
              />
            </div>
          ) : (
            <div className="setting-input-wrap">
              <FieldInput
                type={def.type}
                options={def.options}
                value={draft}
                disabled={disabled || locked}
                placeholder={def.default === undefined ? undefined : String(def.default)}
                onChange={(v) => onDraft(key, v)}
              />
            </div>
          )}

          {isSecret && !locked && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={disabled || (!secrets[key] && !cleared)}
              onClick={() => onToggleClear(key, !cleared)}
            >
              {cleared ? 'Keep stored value' : 'Clear stored value'}
            </button>
          )}

          {isDirty && !locked && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={disabled}
              title={
                def.default === undefined
                  ? 'Revert to the stored value'
                  : 'Revert to ' + String(def.default)
              }
              onClick={() => onResetKey(key)}
            >
              Reset
            </button>
          )}

          {problem && <span className="setting-row-error field-error">{problem}</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="setting-sections">
      {groups.map((group) => (
        <section className="setting-section" key={group}>
          <div className="setting-section-head">
            <h4>{group}</h4>
            <span className="muted" style={{ fontSize: 11 }}>
              {keys.filter((k) => (defs[k].group ?? 'General') === group).length} settings
            </span>
          </div>
          <div className="setting-list">
            {keys.filter((k) => (defs[k].group ?? 'General') === group).map(renderRow)}
          </div>
        </section>
      ))}
      {category.id === 'profile' && (
        <p className="setting-managed-note">
          Identity fields are mirrored onto the company record, so a change here reaches invoices,
          quotations, purchase orders and reports without a deployment.
        </p>
      )}
    </div>
  );
}
// ---------------------------------------------------------------------------
// Shared panel plumbing
// ---------------------------------------------------------------------------

/** Runs one write and keeps its busy/error/ok state local to the panel. */
function useAction(onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = useCallback(
    async (fn: () => Promise<unknown>, message: string) => {
      setBusy(true);
      setError(null);
      setOk(null);
      try {
        await fn();
        setOk(message);
        if (onDone) onDone();
      } catch (e) {
        setError(e);
      } finally {
        setBusy(false);
      }
    },
    [onDone]
  );
  return { busy, error, ok, run, setError, setOk };
}

/** The one-line result strip above a panel's own tables. */
function PanelNote({ error, ok }: { error?: unknown; ok?: string | null }) {
  if (error) return <ErrorBanner error={error} />;
  if (!ok) return null;
  return <div className="notice-banner">{ok}</div>;
}

/** Loads an endpoint and hands the payload to a render function. */
function Loader<T>({
  path,
  children,
}: {
  path: string;
  children: (data: T, reload: () => void) => ReactNode;
}) {
  const { data, error, loading, reload } = useLoad<T>(path);
  if (error) return <ErrorBanner error={error} />;
  if (data === null) return <PageLoader />;
  if (loading && data === null) return <PageLoader />;
  return <>{children(data, reload)}</>;
}

/** A mandatory free-text justification, used by the audited transitions. */
function Reason({
  value,
  onChange,
  label,
  hint,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label ?? 'Reason'} hint={hint ?? 'Recorded against the change on the audit trail.'} required>
      <textarea
        rows={2}
        value={value}
        disabled={disabled}
        placeholder="Why is this change being made?"
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
const LIFECYCLE: Array<{ action: string; label: string }> = [
  { action: 'activate', label: 'Activate' },
  { action: 'deactivate', label: 'Deactivate' },
  { action: 'archive', label: 'Archive' },
  { action: 'restore', label: 'Restore' },
];

/** Which transitions are offered for a row in a given status. */
const LIFECYCLE_TARGET: Record<string, string[]> = {
  ACTIVE: ['deactivate', 'archive'],
  INACTIVE: ['activate', 'archive'],
  ARCHIVED: ['restore'],
};

/** Maps a structure field kind onto one of the generic input types. */
const fieldInputType = (kind: string): SettingType =>
  kind === 'number' ? 'number' : kind === 'boolean' ? 'boolean' : kind === 'json' ? 'textarea' : 'text';

/** The extra columns worth showing per structure entity, beyond code/name. */
const STRUCTURE_EXTRA: Record<string, string[]> = {
  companies: ['currency', 'tin'],
  branches: ['address', 'phone'],
  departments: ['branchId'],
  divisions: ['branchId', 'description'],
  locations: ['type', 'city'],
  warehouses: ['type', 'isSecure'],
  cost_centres: ['description', 'branchId'],
};

/**
 * Companies, branches, departments, divisions, locations, warehouses and cost
 * centres all render through this one panel. The catalogue supplies the
 * writable field list, so adding a column to an entity is a server-side change
 * and needs no new screen here.
 *
 * Lifecycle is deliberately kept out of the edit form. Activating, archiving
 * and restoring are separate, individually audited transitions, and archiving
 * carries a reason; folding them into a save would let an edit quietly retire
 * a branch.
 */
function StructurePanel({
  category,
  rows,
  mayManage,
  onChanged,
}: {
  category: Category;
  rows: Row[];
  mayManage: boolean;
  onChanged: () => void;
}) {
  const act = useAction(onChanged);
  const defs = useMemo(() => category.fields ?? [], [category]);
  const required = category.required ?? [];
  const label = category.label;

  const [editing, setEditing] = useState<Row | null>(null);
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const [pending, setPending] = useState<{ row: Row; action: string } | null>(null);
  const [reason, setReason] = useState('');

  const begin = (row: Row | null) => {
    const next: Record<string, Draft> = {};
    for (const d of defs) next[d.key] = toDraft(row ? row[d.key] : '');
    setDrafts(next);
    setProblem(null);
    setEditing(row);
    setOpen(true);
  };

  const commit = () => {
    const body: Record<string, unknown> = {};
    for (const d of defs) {
      const v = drafts[d.key];
      if (d.kind === 'boolean') body[d.key] = v === true;
      else if (d.kind === 'number') body[d.key] = isBlank(v) ? null : Number(v);
      else if (d.kind === 'json') {
        const raw = str(v).trim();
        if (!raw) body[d.key] = null;
        else {
          try {
            body[d.key] = JSON.parse(raw);
          } catch {
            setProblem(titleCase(d.key) + ' is not valid JSON.');
            return;
          }
        }
      } else {
        const raw = str(v).trim();
        body[d.key] = raw === '' ? null : raw;
      }
    }
    for (const key of required) {
      if (isBlank(body[key])) {
        setProblem(titleCase(key) + ' is required.');
        return;
      }
    }
    const id = editing ? Number(editing.id) : null;
    setProblem(null);
    setOpen(false);
    void act.run(
      () =>
        api(BASE + '/structure/' + category.id + (id ? '/' + String(id) : ''), {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
        }),
      label + (id ? ' saved.' : ' created.')
    );
  };

  const confirmLifecycle = () => {
    if (!pending) return;
    const { row, action } = pending;
    const code = str(row.code) || str(row.name) || String(row.id);
    if (action === 'archive' && reason.trim().length === 0) return;
    setPending(null);
    void act.run(
      () =>
        api(BASE + '/structure/' + category.id + '/' + String(row.id) + '/' + action, {
          method: 'POST',
          body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      label + ' ' + code + ' ' + action + 'd.'
    );
    setReason('');
  };

  const extra = STRUCTURE_EXTRA[category.id] ?? [];
  const columns = [
    { key: 'code', label: 'Code' },
    { key: 'name', label: 'Name' },
    ...extra.map((k) => ({ key: k, label: titleCase(k) })),
    { key: 'status', label: 'Status', render: (row: Row) => <Chip value={row.status} /> },
    {
      key: 'actions',
      label: '',
      render: (row: Row) => (
        <div className="head-actions">
          {mayManage && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => begin(row)}>
              Edit
            </button>
          )}
          {mayManage &&
            (LIFECYCLE_TARGET[str(row.status)] ?? []).map((action) => (
              <button
                key={action}
                type="button"
                className={'btn btn-sm ' + (action === 'archive' ? 'btn-ghost-danger' : 'btn-ghost')}
                disabled={act.busy}
                onClick={() => {
                  setReason('');
                  setPending({ row, action });
                }}
              >
                {LIFECYCLE.find((l) => l.action === action)?.label ?? titleCase(action)}
              </button>
            ))}
        </div>
      ),
    },
  ];

  return (
    <div className="stack">
      <PanelNote error={act.error} ok={act.ok} />

      {!mayManage && (
        <p className="setting-managed-note">
          You can see the organisation structure but not change it. That needs
          {' '}organisation.structure.manage.
        </p>
      )}

      <div className="card">
        <div className="card-head">
          <h3>{label} records</h3>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!mayManage || act.busy}
            onClick={() => begin(null)}
          >
            New {label.toLowerCase()}
          </button>
        </div>
        <div className="card-pad">
          <RecordTable columns={columns} rows={rows} empty={'No ' + label.toLowerCase() + ' records yet.'} />
        </div>
      </div>

      {open && (
        <Modal
          title={(editing ? 'Edit ' : 'New ') + label.toLowerCase()}
          onClose={() => setOpen(false)}
          wide
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={commit}>
                {act.busy ? 'Saving...' : 'Save'}
              </button>
            </>
          }
        >
          {problem && <ErrorBanner error={new Error(problem)} />}
          <div className="form-grid">
            {defs.map((d: FieldDef) => (
              <Field
                key={d.key}
                label={titleCase(d.key)}
                required={required.includes(d.key)}
                hint={d.options ? 'One of: ' + d.options.join(', ') : undefined}
              >
                <FieldInput
                  type={fieldInputType(d.kind)}
                  options={d.options ?? undefined}
                  value={drafts[d.key] ?? ''}
                  disabled={act.busy}
                  onChange={(v) => setDrafts((prev) => ({ ...prev, [d.key]: v }))}
                />
              </Field>
            ))}
          </div>
        </Modal>
      )}

      {pending && (
        <Modal
          title={titleCase(pending.action) + ' ' + label.toLowerCase()}
          onClose={() => setPending(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={act.busy || (pending.action === 'archive' && reason.trim().length === 0)}
                onClick={confirmLifecycle}
              >
                {titleCase(pending.action)}
              </button>
            </>
          }
        >
          <p className="muted">
            {label} {str(pending.row.code) || str(pending.row.name)} will be marked{' '}
            {titleCase(pending.action)}. This is recorded on the audit trail.
          </p>
          <Reason
            value={reason}
            onChange={setReason}
            label={pending.action === 'archive' ? 'Reason (required)' : 'Reason'}
          />
        </Modal>
      )}
    </div>
  );
}
// ---------------------------------------------------------------------------
// Tax (kind: 'tax')
// ---------------------------------------------------------------------------

const TAX_TYPES = ['VAT', 'PAYE', 'NSSF', 'WHT', 'CORPORATE', 'EXCISE', 'STAMP_DUTY', 'LOCAL_SERVICE', 'OTHER'];
const RATE_STATUSES = ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'REVOKED'];

const todayISO = () => new Date().toISOString().slice(0, 10);

const blankRate = (): Record<string, Draft> => ({
  taxCode: '',
  taxName: '',
  taxType: 'VAT',
  rate: '',
  effectiveFrom: todayISO(),
  appliesTo: 'ALL',
  isInclusive: false,
  isCompound: false,
  sourceReference: '',
  notes: '',
});

/**
 * Tax configuration.
 *
 * A rate is never edited in place. Changing a rate closes the open revision and
 * opens a new one with its own effective date, because a historical tax
 * calculation has to stay reproducible - a payslip run in March must still
 * compute from March's PAYE bands after the bands change in July. The screen
 * therefore offers revise, close and delete-an-open-draft, and never edit.
 */
function TaxPanel({ mayManage, onChanged }: { mayManage: boolean; onChanged: () => void }) {
  const act = useAction(onChanged);
  const [history, setHistory] = useState(false);
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState<Row | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [closeTo, setCloseTo] = useState('');
  const [form, setForm] = useState<Record<string, Draft>>(blankRate);

  const set = (k: string, v: Draft) => setForm((f) => ({ ...f, [k]: v }));

  const openDraft = () => {
    setForm(blankRate());
    setProblem(null);
    setReason('');
    setCreating(true);
  };

  const create = () => {
    const code = str(form.taxCode).trim();
    const name = str(form.taxName).trim();
    const from = str(form.effectiveFrom).trim();
    if (!code || !name || !from) {
      setProblem('Tax code, tax name and effective from are all required.');
      return;
    }
    if (!DATE_RE.test(from)) {
      setProblem('Effective from must be YYYY-MM-DD.');
      return;
    }
    const rawRate = str(form.rate).trim();
    setProblem(null);
    setCreating(false);
    void act.run(
      () =>
        api(BASE + '/tax/rates', {
          method: 'POST',
          body: JSON.stringify({
            taxCode: code,
            taxName: name,
            taxType: str(form.taxType),
            rate: rawRate === '' ? null : Number(rawRate),
            isInclusive: form.isInclusive === true,
            isCompound: form.isCompound === true,
            appliesTo: str(form.appliesTo) || 'ALL',
            effectiveFrom: from,
            sourceReference: str(form.sourceReference).trim() || null,
            notes: str(form.notes).trim() || null,
            reason: reason.trim() || null,
          }),
        }),
      'Revision for ' + code + ' opened.'
    );
    setReason('');
  };

  const close = () => {
    if (!closing) return;
    const to = closeTo.trim();
    if (!DATE_RE.test(to)) {
      setProblem('Give the closing date as YYYY-MM-DD.');
      return;
    }
    const id = Number(closing.id);
    setProblem(null);
    setClosing(null);
    void act.run(
      () =>
        api(BASE + '/tax/rates/' + String(id) + '/close', {
          method: 'POST',
          body: JSON.stringify({ effectiveTo: to, reason: reason.trim() || null }),
        }),
      'Tax revision closed.'
    );
    setReason('');
  };

  const remove = (row: Row) => {
    void act.run(
      () => api(BASE + '/tax/rates/' + String(row.id), { method: 'DELETE' }),
      'Unopened revision removed.'
    );
  };

  const columns = [
    { key: 'taxCode', label: 'Code' },
    { key: 'taxName', label: 'Name' },
    { key: 'taxType', label: 'Type' },
    { key: 'rate', label: 'Rate', render: (r: Row) => (isBlank(r.rate) ? 'Banded' : str(r.rate) + '%') },
    { key: 'effectiveFrom', label: 'From' },
    { key: 'effectiveTo', label: 'To', render: (r: Row) => fmt(r.effectiveTo) },
    { key: 'status', label: 'Status', render: (r: Row) => <Chip value={r.status} /> },
    {
      key: 'actions',
      label: '',
      render: (r: Row) => (
        <div className="head-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setInspecting(str(r.taxCode))}>
            History
          </button>
          {mayManage && str(r.status) !== 'SUPERSEDED' && str(r.status) !== 'REVOKED' && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={act.busy}
              onClick={() => {
                setCloseTo('');
                setReason('');
                setClosing(r);
              }}
            >
              Close
            </button>
          )}
          {mayManage && str(r.status) === 'DRAFT' && (
            <button type="button" className="btn btn-sm btn-ghost-danger" disabled={act.busy} onClick={() => remove(r)}>
              Remove
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="stack">
      <PanelNote error={act.error} ok={act.ok} />
      <div className="card">
        <div className="card-head">
          <h3>Tax rates</h3>
          <div className="head-actions">
            <label className="check">
              <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
              <span>Include superseded revisions</span>
            </label>
            <button type="button" className="btn btn-sm btn-primary" disabled={!mayManage || act.busy} onClick={openDraft}>
              New revision
            </button>
          </div>
        </div>
        <div className="card-pad">
          <Loader<{ rows: Row[] }> path={BASE + '/tax/rates?includeHistory=' + String(history)}>
            {(data) => (
              <RecordTable columns={columns} rows={rowsOf(data)} empty="No tax rates are configured for this company." />
            )}
          </Loader>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Tax categories</h3>
          <span className="muted">Highest priority wins when an item matches several categories.</span>
        </div>
        <div className="card-pad">
          <Loader<{ rows: Row[] }> path={BASE + '/tax/categories'}>
            {(data) => (
              <RecordTable
                columns={[
                  { key: 'code', label: 'Code' },
                  { key: 'name', label: 'Name' },
                  { key: 'priority', label: 'Priority' },
                  { key: 'isActive', label: 'Active', render: (r: Row) => <Chip value={r.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
                ]}
                rows={rowsOf(data)}
                empty="No tax categories are configured."
              />
            )}
          </Loader>
        </div>
      </div>

      {creating && (
        <Modal
          title="Open a tax rate revision"
          onClose={() => setCreating(false)}
          wide
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={create}>
                {act.busy ? 'Saving...' : 'Open revision'}
              </button>
            </>
          }
        >
          {problem && <ErrorBanner error={new Error(problem)} />}
          <div className="form-grid">
            <Field label="Tax code" required hint="For example VAT_STANDARD or PAYE.">
              <input type="text" value={str(form.taxCode)} onChange={(e) => set('taxCode', e.target.value)} />
            </Field>
            <Field label="Tax name" required>
              <input type="text" value={str(form.taxName)} onChange={(e) => set('taxName', e.target.value)} />
            </Field>
            <Field label="Tax type">
              <select value={str(form.taxType)} onChange={(e) => set('taxType', e.target.value)}>
                {TAX_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Rate %" hint="Leave empty for a banded tax such as PAYE.">
              <input type="number" value={str(form.rate)} onChange={(e) => set('rate', e.target.value)} />
            </Field>
            <Field label="Effective from" required>
              <input type="date" value={str(form.effectiveFrom)} onChange={(e) => set('effectiveFrom', e.target.value)} />
            </Field>
            <Field label="Applies to">
              <input type="text" value={str(form.appliesTo)} onChange={(e) => set('appliesTo', e.target.value)} />
            </Field>
            <Field label="Source reference" hint="The statutory instrument or URA notice this revision comes from.">
              <input
                type="text"
                value={str(form.sourceReference)}
                onChange={(e) => set('sourceReference', e.target.value)}
              />
            </Field>
            <Field label="Inclusive of tax">
              <FieldInput type="boolean" value={form.isInclusive === true} onChange={(v) => set('isInclusive', v)} />
            </Field>
            <Field label="Compound">
              <FieldInput type="boolean" value={form.isCompound === true} onChange={(v) => set('isCompound', v)} />
            </Field>
          </div>
          <Field label="Notes">
            <textarea rows={2} value={str(form.notes)} onChange={(e) => set('notes', e.target.value)} />
          </Field>
          <Reason value={reason} onChange={setReason} hint="Stored on the revision and on the audit trail." />
        </Modal>
      )}

      {closing && (
        <Modal
          title={'Close revision ' + str(closing.taxCode)}
          onClose={() => setClosing(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setClosing(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={act.busy} onClick={close}>
                Close revision
              </button>
            </>
          }
        >
          {problem && <ErrorBanner error={new Error(problem)} />}
          <p className="muted">
            Closing {' '}
            {str(closing.taxCode)} at {str(closing.rate) || 'banded'}% ends its life on the date below. A closed
            revision cannot be deleted, so documents already priced with it stay reproducible.
          </p>
          <Field label="Effective to" required hint="Must be after the revision's own effective-from date.">
            <input type="date" value={closeTo} onChange={(e) => setCloseTo(e.target.value)} />
          </Field>
          <Reason value={reason} onChange={setReason} />
        </Modal>
      )}

      {inspecting && (
        <Modal title={'Rate history - ' + inspecting} onClose={() => setInspecting(null)} wide>
          <Loader<{ taxCode: string; revisions: Row[] }> path={BASE + '/tax/rates/' + inspecting + '/history'}>
            {(data) => (
              <RecordTable
                columns={[
                  { key: 'rate', label: 'Rate', render: (r: Row) => (isBlank(r.rate) ? 'Banded' : str(r.rate) + '%') },
                  { key: 'effectiveFrom', label: 'From' },
                  { key: 'effectiveTo', label: 'To', render: (r: Row) => fmt(r.effectiveTo) },
                  { key: 'status', label: 'Status', render: (r: Row) => <Chip value={r.status} /> },
                  { key: 'sourceReference', label: 'Source' },
                ]}
                rows={rowsOf({ rows: data.revisions })}
                empty="No revisions recorded for this code."
              />
            )}
          </Loader>
        </Modal>
      )}

      <p className="setting-managed-note">
        Statuses a revision can hold: {RATE_STATUSES.join(', ')}. Revisions are immutable once closed.
      </p>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Numbering and sequences (kind: 'settings', hybrid)
// ---------------------------------------------------------------------------

const RESET_FREQUENCIES = ['NONE', 'YEAR', 'FISCAL_YEAR', 'MONTH', 'QUARTER'];

const NUMBERING_DOC_TYPES = [
  'INVOICE', 'QUOTATION', 'SALES_ORDER', 'DELIVERY_NOTE', 'CREDIT_NOTE', 'DEBIT_NOTE',
  'PURCHASE_ORDER', 'PURCHASE_REQUISITION', 'GRN', 'RECEIPT', 'PAYMENT_VOUCHER',
  'JOURNAL_VOUCHER', 'PAYSLIP', 'EMPLOYEE', 'LEAVE', 'ASSET', 'CONTRACT', 'REPORT',
  'STATEMENT', 'JOB_CARD', 'PRODUCTION_ORDER', 'MATERIAL_ISSUE', 'STOCK_TRANSFER',
  'SERVICE_DESK', 'RAW_MATERIAL', 'WIP', 'FINISHED_GOODS', 'PALLET',
];

/** A format the server will accept: it has to say where the number goes. */
const formatOk = (v: string) => v.indexOf('{SEQ}') >= 0 || /\{#+\}/.test(v);

const blankRule = (): Record<string, Draft> => ({
  docType: 'INVOICE',
  prefix: 'INV',
  format: '{PREFIX}-{YYYY}-{SEQ}',
  pad: '6',
  resetFrequency: 'YEAR',
  suffix: '',
  description: '',
  includeYear: true,
  includeBranch: false,
  includeDepartment: false,
  tenantWide: false,
});

/** The doc type a counter belongs to. seq_key is TYPE:company:branch:period. */
const seqDocType = (seqKey: unknown) => str(seqKey).split(':')[0] || '-';

/**
 * Document numbering.
 *
 * The counters themselves live in number_sequences and are allocated by a
 * single upsert, so this panel deliberately does not own them - it shows what a
 * rule will produce and allows a deliberate, reason-gated reset.
 *
 * Preview never consumes a number: the server peeks at the counter without
 * advancing it, so pressing the button is safe and repeatable.
 */
function NumberingPanel({ mayManage, onChanged }: { mayManage: boolean; onChanged: () => void }) {
  const rules = useLoad<Row[]>(BASE + '/numbering/rules?includeInactive=1');
  const seqs = useLoad<Row[]>(BASE + '/numbering/sequences?limit=200');
  const act = useAction(() => {
    rules.reload();
    seqs.reload();
    onChanged();
  });

  const [editing, setEditing] = useState<Row | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, Draft>>(blankRule);
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [resetting, setResetting] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [nextSeq, setNextSeq] = useState('');
  const [force, setForce] = useState(false);

  const set = (k: string, v: Draft) => setForm((f) => ({ ...f, [k]: v }));

  const begin = (row: Row | null) => {
    setForm(
      row
        ? {
            docType: str(row.docType),
            prefix: str(row.prefix),
            format: str(row.format),
            pad: String(row.pad ?? 6),
            resetFrequency: str(row.resetFrequency) || 'YEAR',
            suffix: str(row.suffix),
            description: str(row.description),
            includeYear: row.includeYear === true,
            includeBranch: row.includeBranch === true,
            includeDepartment: row.includeDepartment === true,
            tenantWide: row.tenantWide === true,
          }
        : blankRule()
    );
    setProblem(null);
    setEditing(row);
    setOpen(true);
  };

  const commit = () => {
    const prefix = str(form.prefix).trim();
    const format = str(form.format).trim();
    if (!prefix) {
      setProblem('A prefix is required.');
      return;
    }
    if (!formatOk(format)) {
      setProblem('The format must contain {SEQ} or a hashed width such as {####}.');
      return;
    }
    const body: Record<string, unknown> = {
      docType: str(form.docType),
      prefix,
      format,
      pad: isBlank(form.pad) ? 6 : Number(form.pad),
      resetFrequency: str(form.resetFrequency) || 'YEAR',
      suffix: str(form.suffix).trim() || null,
      description: str(form.description).trim() || null,
      includeYear: form.includeYear === true,
      includeBranch: form.includeBranch === true,
      includeDepartment: form.includeDepartment === true,
      tenantWide: form.tenantWide === true,
    };
    const id = editing ? Number(editing.id) : null;
    setProblem(null);
    setOpen(false);
    void act.run(
      () =>
        api(BASE + '/numbering/rules' + (id ? '/' + String(id) : ''), {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
        }),
      'Rule for ' + String(body.docType) + ' saved.'
    );
  };

  const toggle = (row: Row) => {
    const next = row.isActive !== true;
    void act.run(
      () =>
        api(BASE + '/numbering/rules/' + String(row.id) + '/active', {
          method: 'POST',
          body: JSON.stringify({ active: next }),
        }),
      str(row.docType) + (next ? ' enabled.' : ' disabled.')
    );
  };

  const confirmReset = () => {
    if (!resetting) return;
    const docType = str(resetting.docType);
    const trimmed = reason.trim();
    if (trimmed.length === 0) return;
    const body: Record<string, unknown> = { reason: trimmed, force };
    if (nextSeq.trim()) body.nextSeq = Number(nextSeq.trim());
    else body.toStart = true;
    setResetting(null);
    setNextSeq('');
    setForce(false);
    void act.run(
      () => api(BASE + '/numbering/sequences/' + docType + '/reset', { method: 'POST', body: JSON.stringify(body) }),
      docType + ' counter reset.'
    );
    setReason('');
  };

  const seed = () => {
    void act.run(
      () => api(BASE + '/numbering/seed', { method: 'POST', body: '{}' }),
      'Missing rules seeded.'
    );
  };

  if (rules.data === null) {
    if (rules.error) return <ErrorBanner error={rules.error} />;
    return <PageLoader />;
  }

  const ruleRows = Array.isArray(rules.data) ? (rules.data as Row[]) : [];
  const seqRows = Array.isArray(seqs.data) ? (seqs.data as Row[]) : [];

  const columns = [
    { key: 'docType', label: 'Document' },
    { key: 'prefix', label: 'Prefix' },
    { key: 'format', label: 'Format' },
    { key: 'resetFrequency', label: 'Resets', render: (r: Row) => titleCase(r.resetFrequency) },
    {
      key: 'isActive',
      label: 'Status',
      render: (r: Row) => <Chip value={r.isActive === true ? 'ACTIVE' : 'INACTIVE'} />,
    },
    {
      key: 'actions',
      label: '',
      render: (r: Row) => (
        <div className="head-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPreview(str(r.docType))}>
            Preview
          </button>
          {mayManage && (
            <button type="button" className="btn btn-sm btn-ghost" disabled={act.busy} onClick={() => begin(r)}>
              Edit
            </button>
          )}
          {mayManage && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={act.busy}
              onClick={() => {
                setReason('');
                setNextSeq('');
                setForce(false);
                setResetting(r);
              }}
            >
              Reset counter
            </button>
          )}
          {mayManage && (
            <button type="button" className="btn btn-sm btn-ghost" disabled={act.busy} onClick={() => toggle(r)}>
              {r.isActive === true ? 'Disable' : 'Enable'}
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="stack">
      <PanelNote error={rules.error ?? seqs.error ?? act.error} ok={act.ok} />

      {!mayManage && (
        <p className="setting-managed-note">
          You can see the numbering rules but not change them. That needs organisation.documents.manage.
        </p>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Numbering rules</h3>
          <div className="head-actions">
            <button type="button" className="btn btn-sm btn-ghost" disabled={!mayManage || act.busy} onClick={seed}>
              Seed missing rules
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!mayManage || act.busy}
              onClick={() => begin(null)}
            >
              New rule
            </button>
          </div>
        </div>
        <div className="card-pad">
          <RecordTable columns={columns} rows={ruleRows} empty="No numbering rules configured yet." />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Counters</h3>
          <span className="muted" style={{ fontSize: 11 }}>
            The next number each counter will hand out.
          </span>
        </div>
        <div className="card-pad">
          <RecordTable
            columns={[
              { key: 'seqKey', label: 'Document', render: (r: Row) => seqDocType(r.seqKey) },
              { key: 'docYear', label: 'Year', render: (r: Row) => (Number(r.docYear) === 1 ? 'All' : fmt(r.docYear)) },
              { key: 'lastSeq', label: 'Last issued' },
              { key: 'nextSeq', label: 'Next', render: (r: Row) => <strong>{fmt(r.nextSeq)}</strong> },
              { key: 'scope', label: 'Scope', render: (r: Row) => <span className="muted">{str(r.seqKey)}</span> },
            ]}
            rows={seqRows}
            empty="No numbers have been issued yet."
          />
        </div>
      </div>

      {open && (
        <Modal
          title={(editing ? 'Edit rule - ' : 'New rule - ') + str(form.docType)}
          onClose={() => setOpen(false)}
          wide
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={commit}>
                {act.busy ? 'Saving...' : 'Save'}
              </button>
            </>
          }
        >
          {problem && <ErrorBanner error={new Error(problem)} />}
          <div className="form-grid">
            <Field label="Document type" required hint="Existing documents keep their numbers if this changes.">
              <select
                value={str(form.docType)}
                disabled={editing !== null}
                onChange={(e) => set('docType', e.target.value)}
              >
                {NUMBERING_DOC_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Prefix" required>
              <input type="text" value={str(form.prefix)} onChange={(e) => set('prefix', e.target.value)} />
            </Field>
            <Field
              label="Format"
              required
              hint="Tokens: {PREFIX} {YYYY} {YY} {YEAR} {MM} {DD} {BRANCH} {DEPARTMENT} {COMPANY} {SEQ}"
            >
              <input type="text" value={str(form.format)} onChange={(e) => set('format', e.target.value)} />
            </Field>
            <Field label="Sequence width" hint="1 to 12 digits, for example 6 gives 000001.">
              <input type="number" value={str(form.pad)} onChange={(e) => set('pad', e.target.value)} />
            </Field>
            <Field label="Reset frequency">
              <select value={str(form.resetFrequency)} onChange={(e) => set('resetFrequency', e.target.value)}>
                {RESET_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Suffix">
              <input type="text" value={str(form.suffix)} onChange={(e) => set('suffix', e.target.value)} />
            </Field>
            <Field label="Include year">
              <FieldInput type="boolean" value={form.includeYear === true} onChange={(v) => set('includeYear', v)} />
            </Field>
            <Field label="Include branch">
              <FieldInput type="boolean" value={form.includeBranch === true} onChange={(v) => set('includeBranch', v)} />
            </Field>
            <Field label="Include department">
              <FieldInput
                type="boolean"
                value={form.includeDepartment === true}
                onChange={(v) => set('includeDepartment', v)}
              />
            </Field>
            <Field label="Shared across branches" hint="One counter for the whole company rather than one per branch.">
              <FieldInput type="boolean" value={form.tenantWide === true} onChange={(v) => set('tenantWide', v)} />
            </Field>
          </div>
          <Field label="Description">
            <textarea rows={2} value={str(form.description)} onChange={(e) => set('description', e.target.value)} />
          </Field>
        </Modal>
      )}

      {preview && (
        <Modal title={'Preview - ' + preview} onClose={() => setPreview(null)}>
          <Loader<{ preview: Row; sample: Row }> path={BASE + '/numbering/preview/' + preview}>
            {(data) => (
              <div className="stack">
                <p className="muted">Nothing is consumed by a preview - the counter is only read.</p>
                <div className="def-list">
                  <div>
                    <span>Next number</span>
                    <strong>{str((data.preview ?? {}).number) || str((data.sample ?? {}).sample)}</strong>
                  </div>
                  <div>
                    <span>Sequence</span>
                    <strong>{fmt((data.preview ?? {}).seq)}</strong>
                  </div>
                </div>
              </div>
            )}
          </Loader>
        </Modal>
      )}

      {resetting && (
        <Modal
          title={'Reset ' + str(resetting.docType) + ' counter'}
          onClose={() => setResetting(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setResetting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={act.busy || reason.trim().length === 0}
                onClick={confirmReset}
              >
                Reset counter
              </button>
            </>
          }
        >
          <p className="muted">
            This is the one destructive action in this module: resetting can hand out a number that a
            document already holds. It applies to the active company and branch for the current period.
          </p>
          <Field label="Next number" hint="Leave empty to return to the rule's own starting number.">
            <input
              type="number"
              value={nextSeq}
              disabled={force}
              onChange={(e) => setNextSeq(e.target.value)}
            />
          </Field>
          <Field label="Confirm a rewind" hint="Required if the new next number is below the last issued number.">
            <FieldInput type="boolean" value={force} onChange={(v) => setForce(v === true)} />
          </Field>
          <Reason value={reason} onChange={setReason} label="Reason (required)" />
        </Modal>
      )}

      <p className="setting-managed-note">
        Allocation is a single atomic upsert, so a hundred concurrent invoice creations cannot collide
        (AC-ORG-009, TC-ORG-005).
      </p>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Fiscal years and accounting periods (kind: 'settings', hybrid)
// ---------------------------------------------------------------------------

const FISCAL_YEAR_STATUSES = ['ACTIVE', 'CLOSED', 'LOCKED'];

/** The ladder, and where each rung is allowed to be entered from. */
const PERIOD_MOVES: Array<{ action: string; label: string }> = [
  { action: 'open', label: 'Reopen' },
  { action: 'soft_close', label: 'Soft close' },
  { action: 'close', label: 'Close' },
  { action: 'reopen', label: 'Reopen a closed period' },
  { action: 'lock', label: 'Lock' },
  { action: 'unlock', label: 'Unlock' },
];

const PERIOD_ALLOWED_FROM: Record<string, string[]> = {
  open: ['SOFT_CLOSE'],
  soft_close: ['OPEN'],
  close: ['OPEN', 'SOFT_CLOSE'],
  reopen: ['CLOSED', 'LOCKED'],
  lock: ['OPEN', 'SOFT_CLOSE', 'CLOSED'],
  unlock: ['LOCKED'],
};

/** Lifting a control is reason-gated on the server; the screen mirrors that. */
const PERIOD_REASON_REQUIRED = ['reopen', 'unlock'];

const MOVE_LABEL: Record<string, string> = {
  open: 'Reopen',
  soft_close: 'Soft close',
  close: 'Close',
  reopen: 'Reopen',
  lock: 'Lock',
  unlock: 'Unlock',
};

/**
 * Fiscal years and the accounting periods beneath them.
 *
 * Periods move along a one-way ladder and two administrators pressing Close at
 * the same moment cannot both win - the server re-checks the status under a row
 * lock. The panel only offers the moves that are legal from the row's current
 * status, so the common mistake is unclickable rather than answered with an
 * error.
 */
function FiscalPanel({ mayManage, onChanged }: { mayManage: boolean; onChanged: () => void }) {
  const overview = useLoad<Row>(BASE + '/fiscal/overview');
  const act = useAction(() => {
    overview.reload();
    onChanged();
  });

  const [yearForm, setYearForm] = useState<Row | null>(null);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [move, setMove] = useState<{ row: Row; action: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [year, setYear] = useState<Record<string, Draft>>({});
  const [period, setPeriod] = useState<Record<string, Draft>>({});

  const startYear = () => {
    setYear({
      code: 'FY' + String(new Date().getFullYear()),
      name: 'Financial Year ' + String(new Date().getFullYear()),
      fiscalYearStart: '',
      fiscalYearEnd: '',
      isCurrent: false,
    });
    setProblem(null);
    setYearForm({});
  };

  const editYear = (row: Row) => {
    setYear({
      code: str(row.code),
      name: str(row.name),
      fiscalYearStart: str(row.fiscalYearStart).slice(0, 10),
      fiscalYearEnd: str(row.fiscalYearEnd).slice(0, 10),
      status: str(row.status),
      isCurrent: row.isCurrent === true,
    });
    setProblem(null);
    setYearForm(row);
  };

  const saveYear = () => {
    const id = yearForm && yearForm.id ? Number(yearForm.id) : null;
    const start = str(year.fiscalYearStart).trim();
    const end = str(year.fiscalYearEnd).trim();
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
      setProblem('Give both dates as YYYY-MM-DD.');
      return;
    }
    if (start >= end) {
      setProblem('The financial year must start before it ends.');
      return;
    }
    const body: Record<string, unknown> = {
      code: str(year.code).trim(),
      name: str(year.name).trim() || str(year.code).trim(),
      fiscalYearStart: start,
      fiscalYearEnd: end,
      isCurrent: year.isCurrent === true,
    };
    if (id) body.status = str(year.status) || 'ACTIVE';
    if (!id && !str(year.code).trim()) {
      setProblem('A fiscal year code is required.');
      return;
    }
    setProblem(null);
    setYearForm(null);
    void act.run(
      () =>
        api(BASE + '/fiscal/years' + (id ? '/' + String(id) : ''), {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
        }),
      'Fiscal year ' + String(body.code) + ' saved.'
    );
  };

  const startPeriod = () => {
    setPeriod({ code: '', name: '', startDate: '', endDate: '', status: 'OPEN' });
    setProblem(null);
    setPeriodOpen(true);
  };

  const savePeriod = () => {
    const code = str(period.code).trim();
    const name = str(period.name).trim();
    const start = str(period.startDate).trim();
    const end = str(period.endDate).trim();
    if (!code || !name) {
      setProblem('A period code and name are both required.');
      return;
    }
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
      setProblem('Give both dates as YYYY-MM-DD.');
      return;
    }
    setProblem(null);
    setPeriodOpen(false);
    void act.run(
      () =>
        api(BASE + '/fiscal/periods', {
          method: 'POST',
          body: JSON.stringify({
            code,
            name,
            startDate: start,
            endDate: end,
            status: str(period.status) || 'OPEN',
          }),
        }),
      'Period ' + code + ' opened.'
    );
  };

  const confirmMove = () => {
    if (!move) return;
    const needsReason = PERIOD_REASON_REQUIRED.indexOf(move.action) >= 0;
    const trimmed = reason.trim();
    if (needsReason && trimmed.length === 0) return;
    const row = move.row;
    const action = move.action;
    setMove(null);
    void act.run(
      () =>
        api(BASE + '/fiscal/periods/' + String(row.id) + '/move', {
          method: 'POST',
          body: JSON.stringify({ action, reason: trimmed || null }),
        }),
      str(row.code) + ' ' + MOVE_LABEL[action].toLowerCase() + 'd.'
    );
    setReason('');
  };

  if (overview.data === null) {
    if (overview.error) return <ErrorBanner error={overview.error} />;
    return <PageLoader />;
  }

  const years = arr(overview.data.years);
  const periods = arr(overview.data.periods);
  const currentYear = (overview.data.currentYear ?? null) as Row | null;
  const openPeriod = (overview.data.openPeriod ?? null) as Row | null;

  return (
    <div className="stack">
      <PanelNote error={overview.error ?? act.error} ok={act.ok} />

      <div className="summary-chips">
        <span className="summary-chip">
          Current year: <strong>{currentYear ? str(currentYear.code) : 'None set'}</strong>
        </span>
        <span className="summary-chip">
          Open period: <strong>{openPeriod ? str(openPeriod.code) : 'None covering today'}</strong>
        </span>
        <span className="summary-chip">
          Closed: <strong>{fmt(overview.data.closedCount)}</strong>
        </span>
        <span className="summary-chip">
          Reopened: <strong>{fmt(overview.data.reopenedCount)}</strong>
        </span>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Financial years</h3>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!mayManage || act.busy}
            onClick={startYear}
          >
            New financial year
          </button>
        </div>
        <div className="card-pad">
          <RecordTable
            columns={[
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Name' },
              { key: 'fiscalYearStart', label: 'Start', render: (r: Row) => str(r.fiscalYearStart).slice(0, 10) },
              { key: 'fiscalYearEnd', label: 'End', render: (r: Row) => str(r.fiscalYearEnd).slice(0, 10) },
              { key: 'status', label: 'Status', render: (r: Row) => <Chip value={r.status} /> },
              {
                key: 'isCurrent',
                label: 'Current',
                render: (r: Row) => (r.isCurrent === true ? <Chip value="ACTIVE" label="Current" /> : '-'),
              },
              {
                key: 'actions',
                label: '',
                render: (r: Row) => (
                  <div className="head-actions">
                    {mayManage && (
                      <button type="button" className="btn btn-sm btn-ghost" disabled={act.busy} onClick={() => editYear(r)}>
                        Edit
                      </button>
                    )}
                  </div>
                ),
              },
            ]}
            rows={years}
            empty="No financial year is configured for this company."
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Accounting periods</h3>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!mayManage || act.busy}
            onClick={startPeriod}
          >
            New period
          </button>
        </div>
        <div className="card-pad">
          <RecordTable
            columns={[
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Name' },
              { key: 'startDate', label: 'Start', render: (r: Row) => str(r.startDate).slice(0, 10) },
              { key: 'endDate', label: 'End', render: (r: Row) => str(r.endDate).slice(0, 10) },
              { key: 'status', label: 'Status', render: (r: Row) => <Chip value={r.status} /> },
              {
                key: 'reopenedCount',
                label: 'Reopened',
                render: (r: Row) => (Number(r.reopenedCount ?? 0) > 0 ? fmt(r.reopenedCount) : '-'),
              },
              {
                key: 'actions',
                label: '',
                render: (r: Row) => (
                  <div className="head-actions">
                    {mayManage &&
                      PERIOD_MOVES.filter((m) =>
                        (PERIOD_ALLOWED_FROM[m.action] ?? []).indexOf(str(r.status)) >= 0
                      ).map((m) => (
                        <button
                          key={m.action}
                          type="button"
                          className={'btn btn-sm ' + (PERIOD_REASON_REQUIRED.indexOf(m.action) >= 0 ? 'btn-ghost-danger' : 'btn-ghost')}
                          disabled={act.busy}
                          onClick={() => {
                            setReason('');
                            setMove({ row: r, action: m.action });
                          }}
                        >
                          {m.label}
                        </button>
                      ))}
                  </div>
                ),
              },
            ]}
            rows={periods}
            empty="No accounting periods have been created yet."
          />
        </div>
      </div>

      {yearForm !== null && (
        <Modal
          title={yearForm.id ? 'Edit financial year ' + str(yearForm.code) : 'New financial year'}
          onClose={() => setYearForm(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setYearForm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={saveYear}>
                {act.busy ? 'Saving...' : 'Save'}
              </button>
            </>
          }
        >
          {problem && <ErrorBanner error={new Error(problem)} />}
          <div className="form-grid">
            <Field label="Code" required hint="For example FY2026.">
              <input
                type="text"
                value={str(year.code)}
                disabled={Boolean(yearForm.id)}
                onChange={(e) => setYear((f) => ({ ...f, code: e.target.value }))}
              />
            </Field>
            <Field label="Name">
              <input
                type="text"
                value={str(year.name)}
                onChange={(e) => setYear((f) => ({ ...f, name: e.target.value }))}
              />
            </Field>
            <Field label="Start" required>
              <input
                type="date"
                value={str(year.fiscalYearStart)}
                onChange={(e) => setYear((f) => ({ ...f, fiscalYearStart: e.target.value }))}
              />
            </Field>
            <Field label="End" required>
              <input
                type="date"
                value={str(year.fiscalYearEnd)}
                onChange={(e) => setYear((f) => ({ ...f, fiscalYearEnd: e.target.value }))}
              />
            </Field>
            {Boolean(yearForm.id) && (
              <Field label="Status">
                <select
                  value={str(year.status)}
                  onChange={(e) => setYear((f) => ({ ...f, status: e.target.value }))}
                >
                  {FISCAL_YEAR_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Make current" hint="Only one year is current at a time; setting this moves the marker.">
              <FieldInput
                type="boolean"
                value={year.isCurrent === true}
                onChange={(v) => setYear((f) => ({ ...f, isCurrent: v }))}
              />
            </Field>
          </div>
          {Boolean(yearForm.id) && yearForm.isCurrent === true && (
            <p className="setting-managed-note">
              The dates of the current year are load-bearing for every posted journal, so the server
              refuses to move them until the year is closed.
            </p>
          )}
        </Modal>
      )}

      {periodOpen && (
        <Modal
          title="New accounting period"
          onClose={() => setPeriodOpen(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setPeriodOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={savePeriod}>
                {act.busy ? 'Saving...' : 'Open period'}
              </button>
            </>
          }
        >
          {problem && <ErrorBanner error={new Error(problem)} />}
          <div className="form-grid">
            <Field label="Code" required hint="For example FY2026-P01.">
              <input
                type="text"
                value={str(period.code)}
                onChange={(e) => setPeriod((f) => ({ ...f, code: e.target.value }))}
              />
            </Field>
            <Field label="Name" required>
              <input
                type="text"
                value={str(period.name)}
                onChange={(e) => setPeriod((f) => ({ ...f, name: e.target.value }))}
              />
            </Field>
            <Field label="Start" required>
              <input
                type="date"
                value={str(period.startDate)}
                onChange={(e) => setPeriod((f) => ({ ...f, startDate: e.target.value }))}
              />
            </Field>
            <Field label="End" required>
              <input
                type="date"
                value={str(period.endDate)}
                onChange={(e) => setPeriod((f) => ({ ...f, endDate: e.target.value }))}
              />
            </Field>
          </div>
        </Modal>
      )}

      {move && (
        <Modal
          title={MOVE_LABEL[move.action] + ' ' + str(move.row.code)}
          onClose={() => setMove(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setMove(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={'btn ' + (PERIOD_REASON_REQUIRED.indexOf(move.action) >= 0 ? 'btn-danger' : 'btn-primary')}
                disabled={act.busy || (PERIOD_REASON_REQUIRED.indexOf(move.action) >= 0 && reason.trim().length === 0)}
                onClick={confirmMove}
              >
                {MOVE_LABEL[move.action]}
              </button>
            </>
          }
        >
          <p className="muted">
            {str(move.row.code)} is {titleCase(move.row.status)} and will move to{' '}
            {titleCase(move.action === 'open' || move.action === 'reopen' || move.action === 'unlock' ? 'OPEN' : move.action)}
            . Every period change is audited.
          </p>
          <Reason
            value={reason}
            onChange={setReason}
            label={PERIOD_REASON_REQUIRED.indexOf(move.action) >= 0 ? 'Reason (required)' : 'Reason'}
            hint={
              PERIOD_REASON_REQUIRED.indexOf(move.action) >= 0
                ? 'This lifts a control, so a stated reason is mandatory.'
                : 'Recorded against the change on the audit trail.'
            }
          />
        </Modal>
      )}
    </div>
  );
}
// ---------------------------------------------------------------------------
// Approvals (kind: 'approvals')
// ---------------------------------------------------------------------------

const DOCUMENT_TYPES = [
  'PURCHASE_ORDER', 'PURCHASE_REQUISITION', 'PAYMENT', 'JOURNAL', 'INVOICE',
  'CREDIT_NOTE', 'EXPENSE', 'PAYROLL', 'LEAVE_REQUEST', 'CONTRACT',
  'STOCK_ADJUSTMENT', 'PRODUCTION_ORDER', 'PURCHASE_RETURN', 'SALES_ORDER', 'OTHER',
];

/** Permission families a fallback approver can never be handed by this screen. */
const ADMIN_PREFIXES = ['system.', 'organisation.security', 'organisation.settings.delete'];

const blankWorkflow = (): Record<string, Draft> => ({
  code: '',
  name: '',
  document_type: 'PURCHASE_ORDER',
  description: '',
  priority: '100',
  min_amount: '',
  max_amount: '',
  effective_from: todayISO(),
  effective_to: '',
  is_active: true,
});

const blankLevel = (): Record<string, Draft> => ({
  level_no: '1',
  name: '',
  approver_role_id: '',
  approver_user_id: '',
  required_approvals: '1',
  is_optional: false,
  allow_delegation: true,
  sla_hours: '',
  escalate_to_level_no: '',
});

const blankFallback = (): Record<string, Draft> => ({
  primary_role_id: '',
  primary_user_id: '',
  fallback_role_id: '',
  fallback_user_id: '',
  reason: '',
  effective_from: todayISO(),
  effective_to: '',
  is_active: true,
});

/**
 * Approval workflows, their levels and the fallback rules beneath them.
 *
 * Two states that look like one are kept apart here. A workflow is the shape of
 * an approval - which rungs, in what order, above what amount. A fallback rule
 * is who stands in when a named approver is unavailable, and it always carries
 * an end date: a fallback without one becomes a permanent shadow authority
 * nobody remembers granting (AC-ORG-007, TC-ORG-003, TC-ORG-004).
 *
 * A fallback rule grants cover for an operational approval. It cannot be used
 * to hand anyone administrative rights - the server refuses the permission
 * families listed below outright, so the screen says so rather than offering
 * the option and failing.
 */
function ApprovalsPanel({ mayManage, onChanged }: { mayManage: boolean; onChanged: () => void }) {
  const workflows = useLoad<Row[]>(BASE + '/approvals/workflows');
  const fallbacks = useLoad<Row[]>(BASE + '/approvals/fallbacks');
  const act = useAction(() => {
    workflows.reload();
    fallbacks.reload();
    detail.reload();
    onChanged();
  });

  const [openId, setOpenId] = useState<number | null>(null);
  const detail = useLoad<{ workflow: Row; levels: Row[]; fallbacks: Row[] }>(
    openId === null ? null : BASE + '/approvals/workflows/' + String(openId)
  );

  const [wfForm, setWfForm] = useState<Record<string, Draft> | null>(null);
  const [lvForm, setLvForm] = useState<Record<string, Draft> | null>(null);
  const [fbForm, setFbForm] = useState<Record<string, Draft> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const [resolving, setResolving] = useState(false);
  const [resolveType, setResolveType] = useState('PURCHASE_ORDER');
  const [resolveAmount, setResolveAmount] = useState('');
  const [resolveAt, setResolveAt] = useState<string | null>(null);

  const numOrNull = (v: Draft): number | null => (isBlank(v) ? null : Number(v));
  const txtOrNull = (v: Draft): string | null => (isBlank(v) ? null : String(v).trim());

  const saveWorkflow = () => {
    if (!wfForm) return;
    const code = str(wfForm.code).trim();
    const name = str(wfForm.name).trim();
    if (!code || !name) {
      setProblem('A workflow code and name are both required.');
      return;
    }
    setProblem(null);
    setWfForm(null);
    void act.run(
      () =>
        api(BASE + '/approvals/workflows', {
          method: 'POST',
          body: JSON.stringify({
            code,
            name,
            document_type: str(wfForm.document_type),
            description: txtOrNull(wfForm.description),
            priority: isBlank(wfForm.priority) ? 100 : Number(wfForm.priority),
            min_amount: numOrNull(wfForm.min_amount),
            max_amount: numOrNull(wfForm.max_amount),
            effective_from: txtOrNull(wfForm.effective_from),
            effective_to: txtOrNull(wfForm.effective_to),
            is_active: wfForm.is_active === true,
          }),
        }),
      'Workflow ' + code + ' created.'
    );
  };

  const saveLevel = () => {
    if (!lvForm || openId === null) return;
    const roleId = numOrNull(lvForm.approver_role_id);
    const userId = numOrNull(lvForm.approver_user_id);
    if (roleId === null && userId === null) {
      setProblem('A level needs an approver role or an approver user.');
      return;
    }
    if (roleId !== null && userId !== null) {
      setProblem('A level takes an approver role or an approver user, not both.');
      return;
    }
    if (!str(lvForm.name).trim()) {
      setProblem('Give the level a name.');
      return;
    }
    setProblem(null);
    setLvForm(null);
    void act.run(
      () =>
        api(BASE + '/approvals/levels', {
          method: 'POST',
          body: JSON.stringify({
            workflow_id: openId,
            level_no: Number(lvForm.level_no || 1),
            name: str(lvForm.name).trim(),
            approver_role_id: roleId,
            approver_user_id: userId,
            required_approvals: isBlank(lvForm.required_approvals) ? 1 : Number(lvForm.required_approvals),
            is_optional: lvForm.is_optional === true,
            allow_delegation: lvForm.allow_delegation === true,
            sla_hours: numOrNull(lvForm.sla_hours),
            escalate_to_level_no: numOrNull(lvForm.escalate_to_level_no),
          }),
        }),
      'Approval level added.'
    );
  };

  const saveFallback = () => {
    if (!fbForm) return;
    const primaryRole = numOrNull(fbForm.primary_role_id);
    const primaryUser = numOrNull(fbForm.primary_user_id);
    const fallbackRole = numOrNull(fbForm.fallback_role_id);
    const fallbackUser = numOrNull(fbForm.fallback_user_id);
    if ((primaryRole === null) === (primaryUser === null)) {
      setProblem('Name either a primary role or a primary user, not both.');
      return;
    }
    if ((fallbackRole === null) === (fallbackUser === null)) {
      setProblem('Name either a fallback role or a fallback user, not both.');
      return;
    }
    if (!str(fbForm.reason).trim()) {
      setProblem('A fallback rule needs a stated reason.');
      return;
    }
    if (!DATE_RE.test(str(fbForm.effective_to).trim())) {
      setProblem('A fallback rule must end on a date, given as YYYY-MM-DD.');
      return;
    }
    setProblem(null);
    setFbForm(null);
    void act.run(
      () =>
        api(BASE + '/approvals/fallbacks', {
          method: 'POST',
          body: JSON.stringify({
            workflow_id: openId,
            primary_role_id: primaryRole,
            primary_user_id: primaryUser,
            fallback_role_id: fallbackRole,
            fallback_user_id: fallbackUser,
            reason: str(fbForm.reason).trim(),
            effective_from: txtOrNull(fbForm.effective_from),
            effective_to: str(fbForm.effective_to).trim(),
            is_active: fbForm.is_active === true,
          }),
        }),
      'Fallback rule created.'
    );
  };

  const deactivate = (row: Row) => {
    void act.run(
      () => api(BASE + '/approvals/workflows/' + String(row.id) + '/deactivate', { method: 'POST', body: '{}' }),
      str(row.code) + ' deactivated.'
    );
  };

  const removeLevel = (row: Row) => {
    void act.run(
      () => api(BASE + '/approvals/levels/' + String(row.id), { method: 'DELETE' }),
      'Level removed.'
    );
  };

  const removeFallback = (row: Row) => {
    void act.run(
      () => api(BASE + '/approvals/fallbacks/' + String(row.id), { method: 'DELETE' }),
      'Fallback rule removed.'
    );
  };

  if (workflows.data === null) {
    if (workflows.error) return <ErrorBanner error={workflows.error} />;
    return <PageLoader />;
  }

  const wfRows = Array.isArray(workflows.data) ? (workflows.data as Row[]) : [];
  const fbRows = Array.isArray(fallbacks.data) ? (fallbacks.data as Row[]) : [];
  const detailData = detail.data;

  return (
    <div className="stack">
      <PanelNote error={workflows.error ?? fallbacks.error ?? detail.error ?? act.error} ok={act.ok} />

      {!mayManage && (
        <p className="setting-managed-note">
          You can see the approval configuration but not change it. That needs organisation.security.manage.
        </p>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Workflows</h3>
          <div className="head-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={!mayManage || act.busy}
              onClick={() => {
                setResolveAt(null);
                setResolving(true);
              }}
            >
              Test resolution
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!mayManage || act.busy}
              onClick={() => {
                setProblem(null);
                setWfForm(blankWorkflow());
              }}
            >
              New workflow
            </button>
          </div>
        </div>
        <div className="card-pad">
          <RecordTable
            columns={[
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Name' },
              { key: 'documentType', label: 'Document' },
              { key: 'priority', label: 'Priority' },
              {
                key: 'minAmount',
                label: 'Band',
                render: (r: Row) => (
                  <span className="muted">
                    {isBlank(r.minAmount) && isBlank(r.maxAmount)
                      ? 'All amounts'
                      : fmt(r.minAmount) + ' - ' + (isBlank(r.maxAmount) ? 'no limit' : fmt(r.maxAmount))}
                  </span>
                ),
              },
              { key: 'levelCount', label: 'Levels' },
              {
                key: 'isActive',
                label: 'Status',
                render: (r: Row) => <Chip value={r.isActive === true ? 'ACTIVE' : 'INACTIVE'} />,
              },
              {
                key: 'actions',
                label: '',
                render: (r: Row) => (
                  <div className="head-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setOpenId(openId === Number(r.id) ? null : Number(r.id))}
                    >
                      {openId === Number(r.id) ? 'Hide levels' : 'Levels'}
                    </button>
                    {mayManage && r.isActive === true && (
                      <button type="button" className="btn btn-sm btn-ghost-danger" disabled={act.busy} onClick={() => deactivate(r)}>
                        Deactivate
                      </button>
                    )}
                  </div>
                ),
              },
            ]}
            rows={wfRows}
            empty="No approval workflow is configured for this company."
          />
        </div>
      </div>

      {openId !== null && (
        <div className="card">
          <div className="card-head">
            <h3>
              {detailData ? str(detailData.workflow.code) : 'Workflow'} levels
            </h3>
            <div className="head-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={!mayManage || act.busy}
                onClick={() => {
                  setProblem(null);
                  setLvForm(blankLevel());
                }}
              >
                Add level
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!mayManage || act.busy}
                onClick={() => {
                  setProblem(null);
                  setFbForm(blankFallback());
                }}
              >
                Add fallback
              </button>
            </div>
          </div>
          <div className="card-pad">
            {detailData ? (
              <RecordTable
                columns={[
                  { key: 'levelNo', label: 'Level' },
                  { key: 'name', label: 'Name' },
                  {
                    key: 'approver',
                    label: 'Approver',
                    render: (r: Row) =>
                      r.approverUserId ? 'User #' + str(r.approverUserId) : 'Role #' + str(r.approverRoleId),
                  },
                  { key: 'requiredApprovals', label: 'Required' },
                  {
                    key: 'slaHours',
                    label: 'SLA',
                    render: (r: Row) => (isBlank(r.slaHours) ? '-' : str(r.slaHours) + 'h'),
                  },
                  {
                    key: 'escalatesTo',
                    label: 'Escalates to',
                    render: (r: Row) => fmt(r.escalateToLevelNo),
                  },
                  {
                    key: 'actions',
                    label: '',
                    render: (r: Row) =>
                      mayManage ? (
                        <button type="button" className="btn btn-sm btn-ghost-danger" disabled={act.busy} onClick={() => removeLevel(r)}>
                          Remove
                        </button>
                      ) : null,
                  },
                ]}
                rows={arr(detailData.levels)}
                empty="This workflow has no levels yet."
              />
            ) : (
              <PageLoader />
            )}
          </div>
          {detailData && arr(detailData.fallbacks).length > 0 && (
            <div className="card-pad">
              <h4>Fallbacks on this workflow</h4>
              <RecordTable
                columns={[
                  {
                    key: 'primary',
                    label: 'Primary',
                    render: (r: Row) => (r.primaryUserId ? 'User #' + str(r.primaryUserId) : 'Role #' + str(r.primaryRoleId)),
                  },
                  {
                    key: 'fallback',
                    label: 'Covered by',
                    render: (r: Row) =>
                      r.fallbackUserId ? 'User #' + str(r.fallbackUserId) : 'Role #' + str(r.fallbackRoleId),
                  },
                  { key: 'effectiveTo', label: 'Expires', render: (r: Row) => str(r.effectiveTo).slice(0, 10) },
                  { key: 'reason', label: 'Reason' },
                ]}
                rows={arr(detailData.fallbacks)}
                empty="No fallbacks on this workflow."
              />
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Fallback rules</h3>
          <span className="muted" style={{ fontSize: 11 }}>
            Acting authority that expires.
          </span>
        </div>
        <div className="card-pad">
          <RecordTable
            columns={[
              {
                key: 'primary',
                label: 'Primary',
                render: (r: Row) => (r.primaryUserId ? 'User #' + str(r.primaryUserId) : 'Role #' + str(r.primaryRoleId)),
              },
              {
                key: 'fallback',
                label: 'Covered by',
                render: (r: Row) =>
                  r.fallbackUserId ? 'User #' + str(r.fallbackUserId) : 'Role #' + str(r.fallbackRoleId),
              },
              { key: 'effectiveFrom', label: 'From', render: (r: Row) => str(r.effectiveFrom).slice(0, 10) },
              { key: 'effectiveTo', label: 'To', render: (r: Row) => str(r.effectiveTo).slice(0, 10) },
              { key: 'reason', label: 'Reason' },
              {
                key: 'isActive',
                label: 'Status',
                render: (r: Row) => <Chip value={r.isActive === true ? 'ACTIVE' : 'INACTIVE'} />,
              },
              {
                key: 'actions',
                label: '',
                render: (r: Row) =>
                  mayManage ? (
                    <button type="button" className="btn btn-sm btn-ghost-danger" disabled={act.busy} onClick={() => removeFallback(r)}>
                      Remove
                    </button>
                  ) : null,
              },
            ]}
            rows={fbRows}
            empty="No fallback rules are configured."
          />
        </div>
      </div>

      <p className="setting-managed-note">
        A fallback rule delegates operational approval only. These permission families are refused by the
        server and cannot be granted this way: {ADMIN_PREFIXES.join(', ')}. Administrative access and
        business approval authority stay separate.
      </p>

      {wfForm && (
        <Modal
          title="New approval workflow"
          onClose={() => setWfForm(null)}
          wide
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setWfForm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={saveWorkflow}>
                {act.busy ? 'Saving...' : 'Create'}
              </button>
            </>
          }
        >
          {problem && <ErrorBanner error={new Error(problem)} />}
          <div className="form-grid">
            <Field label="Code" required hint="For example PO-ABOVE-5M.">
              <input type="text" value={str(wfForm.code)} onChange={(e) => setWfForm((f) => ({ ...f!, code: e.target.value }))} />
            </Field>
            <Field label="Name" required>
              <input type="text" value={str(wfForm.name)} onChange={(e) => setWfForm((f) => ({ ...f!, name: e.target.value }))} />
            </Field>
            <Field label="Document type" required>
              <select
                value={str(wfForm.document_type)}
                onChange={(e) => setWfForm((f) => ({ ...f!, document_type: e.target.value }))}
              >
                {DOCUMENT_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority" hint="Lower runs first when more than one workflow matches.">
              <input type="number" value={str(wfForm.priority)} onChange={(e) => setWfForm((f) => ({ ...f!, priority: e.target.value }))} />
            </Field>
            <Field label="Minimum amount" hint="Leave empty for no floor.">
              <input type="number" value={str(wfForm.min_amount)} onChange={(e) => setWfForm((f) => ({ ...f!, min_amount: e.target.value }))} />
            </Field>
            <Field label="Maximum amount" hint="Leave empty for no ceiling.">
              <input type="number" value={str(wfForm.max_amount)} onChange={(e) => setWfForm((f) => ({ ...f!, max_amount: e.target.value }))} />
            </Field>
            <Field label="Effective from">
              <input type="date" value={str(wfForm.effective_from)} onChange={(e) => setWfForm((f) => ({ ...f!, effective_from: e.target.value }))} />
            </Field>
            <Field label="Effective to" hint="Leave empty to keep the workflow open-ended.">
              <input type="date" value={str(wfForm.effective_to)} onChange={(e) => setWfForm((f) => ({ ...f!, effective_to: e.target.value }))} />
            </Field>
            <Field label="Active">
              <FieldInput type="boolean" value={wfForm.is_active === true} onChange={(v) => setWfForm((f) => ({ ...f!, is_active: v }))} />
            </Field>
          </div>
          <Field label="Description">
            <textarea rows={2} value={str(wfForm.description)} onChange={(e) => setWfForm((f) => ({ ...f!, description: e.target.value }))} />
          </Field>
        </Modal>
      )}

      {lvForm && (
        <Modal
          title="Add approval level"
          onClose={() => setLvForm(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setLvForm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={saveLevel}>
                {act.busy ? 'Saving...' : 'Add level'}
              </button>
            </>
          }
        >
          {problem && <ErrorBanner error={new Error(problem)} />}
          <p className="muted">A level names an approver role or an approver user, never both.</p>
          <div className="form-grid">
            <Field label="Level" required>
              <input type="number" value={str(lvForm.level_no)} onChange={(e) => setLvForm((f) => ({ ...f!, level_no: e.target.value }))} />
            </Field>
            <Field label="Name" required hint="For example Finance Manager sign-off.">
              <input type="text" value={str(lvForm.name)} onChange={(e) => setLvForm((f) => ({ ...f!, name: e.target.value }))} />
            </Field>
            <Field label="Approver role id" hint="Numeric role id from the roles catalogue.">
              <input type="number" value={str(lvForm.approver_role_id)} onChange={(e) => setLvForm((f) => ({ ...f!, approver_role_id: e.target.value }))} />
            </Field>
            <Field label="Approver user id">
              <input type="number" value={str(lvForm.approver_user_id)} onChange={(e) => setLvForm((f) => ({ ...f!, approver_user_id: e.target.value }))} />
            </Field>
            <Field label="Required approvals">
              <input type="number" value={str(lvForm.required_approvals)} onChange={(e) => setLvForm((f) => ({ ...f!, required_approvals: e.target.value }))} />
            </Field>
            <Field label="Escalate to level">
              <input type="number" value={str(lvForm.escalate_to_level_no)} onChange={(e) => setLvForm((f) => ({ ...f!, escalate_to_level_no: e.target.value }))} />
            </Field>
            <Field label="SLA hours" hint="How long this level may sit before escalation.">
              <input type="number" value={str(lvForm.sla_hours)} onChange={(e) => setLvForm((f) => ({ ...f!, sla_hours: e.target.value }))} />
            </Field>
            <Field label="Optional level">
              <FieldInput type="boolean" value={lvForm.is_optional === true} onChange={(v) => setLvForm((f) => ({ ...f!, is_optional: v }))} />
            </Field>
            <Field label="Allow delegation" hint="Whether this level may be covered by a fallback rule.">
              <FieldInput type="boolean" value={lvForm.allow_delegation === true} onChange={(v) => setLvForm((f) => ({ ...f!, allow_delegation: v }))} />
            </Field>
          </div>
        </Modal>
      )}

      {fbForm && (
        <Modal
          title="Add fallback rule"
          onClose={() => setFbForm(null)}
          wide
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setFbForm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={saveFallback}>
                {act.busy ? 'Saving...' : 'Create'}
              </button>
            </>
          }
        >
          {problem && <ErrorBanner error={new Error(problem)} />}
          <p className="muted">
            A fallback rule needs an end date. Without one it becomes a permanent shadow authority, so the
            server requires the date and the reason (AC-ORG-007).
          </p>
          <div className="form-grid">
            <Field label="Primary role id" hint="Who normally approves.">
              <input type="number" value={str(fbForm.primary_role_id)} onChange={(e) => setFbForm((f) => ({ ...f!, primary_role_id: e.target.value }))} />
            </Field>
            <Field label="Primary user id">
              <input type="number" value={str(fbForm.primary_user_id)} onChange={(e) => setFbForm((f) => ({ ...f!, primary_user_id: e.target.value }))} />
            </Field>
            <Field label="Fallback role id" hint="Who covers. Administrative roles are refused.">
              <input type="number" value={str(fbForm.fallback_role_id)} onChange={(e) => setFbForm((f) => ({ ...f!, fallback_role_id: e.target.value }))} />
            </Field>
            <Field label="Fallback user id">
              <input type="number" value={str(fbForm.fallback_user_id)} onChange={(e) => setFbForm((f) => ({ ...f!, fallback_user_id: e.target.value }))} />
            </Field>
            <Field label="Effective from">
              <input type="date" value={str(fbForm.effective_from)} onChange={(e) => setFbForm((f) => ({ ...f!, effective_from: e.target.value }))} />
            </Field>
            <Field label="Effective to" required>
              <input type="date" value={str(fbForm.effective_to)} onChange={(e) => setFbForm((f) => ({ ...f!, effective_to: e.target.value }))} />
            </Field>
            <Field label="Active">
              <FieldInput type="boolean" value={fbForm.is_active === true} onChange={(v) => setFbForm((f) => ({ ...f!, is_active: v }))} />
            </Field>
          </div>
          <Field label="Reason" required hint="Why this cover is needed. Recorded on the audit trail.">
            <textarea rows={2} value={str(fbForm.reason)} onChange={(e) => setFbForm((f) => ({ ...f!, reason: e.target.value }))} />
          </Field>
        </Modal>
      )}

      {resolving && (
        <Modal title="Test an approval resolution" onClose={() => setResolving(false)} wide>
          <div className="form-grid">
            <Field label="Document type" required>
              <select value={resolveType} onChange={(e) => setResolveType(e.target.value)}>
                {DOCUMENT_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Amount" hint="Leave empty to resolve without an amount.">
              <input type="number" value={resolveAmount} onChange={(e) => setResolveAmount(e.target.value)} />
            </Field>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() =>
              setResolveAt(
                BASE + '/approvals/resolve?documentType=' + resolveType + (resolveAmount.trim() ? '&amount=' + resolveAmount.trim() : '')
              )
            }
          >
            Resolve
          </button>
          {resolveAt && (
            <Loader<{ workflow: Row | null; levels: Row[]; fallbacks: Row[] }> path={resolveAt}>
              {(data) =>
                data.workflow ? (
                  <div className="stack">
                    <p>
                      Matched <strong>{str(data.workflow.code)}</strong> - {str(data.workflow.name)}
                    </p>
                    <RecordTable
                      columns={[
                        { key: 'levelNo', label: 'Level' },
                        { key: 'name', label: 'Name' },
                        {
                          key: 'approver',
                          label: 'Approver',
                          render: (r: Row) =>
                            r.approverUserId ? 'User #' + str(r.approverUserId) : 'Role #' + str(r.approverRoleId),
                        },
                      ]}
                      rows={arr(data.levels)}
                      empty="This workflow has no levels."
                    />
                    {arr(data.fallbacks).length > 0 && (
                      <p className="muted">
                        {arr(data.fallbacks).length} fallback rule(s) are in force for this chain.
                      </p>
                    )}
                  </div>
                ) : (
                  <Empty>No workflow matches that document type and amount.</Empty>
                )
              }
            </Loader>
          )}
        </Modal>
      )}
    </div>
  );
}
// ---------------------------------------------------------------------------
// Signatures (kind: 'signatures')
// ---------------------------------------------------------------------------

const SIGNATURE_AUTHORITY_LEVELS = [
  'EXECUTIVE', 'MANAGEMENT', 'FINANCE', 'HR', 'OPERATIONS', 'TECHNICAL', 'SECURITY', 'OTHER',
];

const blankProfile = (): Record<string, Draft> => ({
  userId: '',
  fullName: '',
  positionTitle: '',
  authorityLevel: 'MANAGEMENT',
  effectiveFrom: new Date().toISOString().slice(0, 10),
  expiresAt: '',
});

/**
 * Signature profiles.
 *
 * The screen manages who a signature belongs to and which authorities it
 * carries. It deliberately does not manage the signing chain: submit, approve,
 * activate, suspend and revoke are transitions in the governance module, and
 * duplicating them here would create a second place where "is this person
 * allowed to sign" is answered differently. That boundary is stated on the
 * panel rather than left for an administrator to discover (AC-ORG-006).
 *
 * A profile starts in DRAFT with no authority. Signing a document needs an
 * ACTIVE profile, inside its effective window, with an APPROVED scope that
 * covers the document type and amount - so the detail view offers a
 * check-authority probe that asks the server for a verdict and a reason before
 * anyone relies on a signature that would be refused.
 */
function SignaturesPanel({
  view,
  mayManage,
  onChanged,
}: {
  view: CategoryView;
  mayManage: boolean;
  onChanged: () => void;
}) {
  const rows = arr(view.list);
  const act = useAction(onChanged);
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(blankProfile);
  const [problem, setProblem] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);

  const count = (status: string) => rows.filter((r) => str(r.status) === status).length;
  const expiringSoon = rows.filter((r) => {
    if (!r.expiresAt) return false;
    const t = new Date(String(r.expiresAt)).getTime();
    return Number.isFinite(t) && t > Date.now() && t - Date.now() < 30 * 24 * 60 * 60 * 1000;
  }).length;

  const save = () => {
    const body: Record<string, unknown> = {
      userId: Number(drafts.userId),
      fullName: str(drafts.fullName).trim() || null,
      positionTitle: str(drafts.positionTitle).trim() || null,
      authorityLevel: str(drafts.authorityLevel) || 'OTHER',
      effectiveFrom: str(drafts.effectiveFrom).trim() || null,
      expiresAt: str(drafts.expiresAt).trim() || null,
    };
    if (!Number.isFinite(Number(body.userId)) || Number(body.userId) <= 0) {
      setProblem('The signature must belong to a user. Enter that user id.');
      return;
    }
    setProblem(null);
    setCreating(false);
    void act.run(
      () => api(BASE + '/category/signatures', { method: 'PATCH', body: JSON.stringify(body) }),
      'Signature profile created in DRAFT.'
    );
  };

  return (
    <div className="stack">
      <div className="summary-chips">
        <span className="summary-chip">Profiles <strong>{rows.length}</strong></span>
        <span className="summary-chip">Active <strong>{count('ACTIVE')}</strong></span>
        <span className="summary-chip">Pending <strong>{count('PENDING')}</strong></span>
        <span className="summary-chip">Expiring in 30 days <strong>{expiringSoon}</strong></span>
      </div>

      <div className="setting-managed-note">
        The signing chain - submit, approve, activate, suspend and revoke - is owned by the
        Governance module, because applying a signature is a controlled workflow rather than a
        setting. This screen decides who holds a profile and what authority it carries; the
        governance workflow decides whether that profile may be used today. A new profile is
        created in DRAFT and cannot sign anything until an approved scope is attached to it.
      </div>

      <PanelNote error={act.error} ok={act.ok} />

      <div className="head-actions">
        {mayManage && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              setDrafts(blankProfile());
              setProblem(null);
              setCreating(true);
            }}
          >
            New profile
          </button>
        )}
      </div>

      <RecordTable
        columns={[
          {
            key: 'fullName',
            label: 'Signatory',
            render: (r: Row) =>
              str(r.fullName) || (str(r.firstName) + ' ' + str(r.lastName)).trim() || '-',
          },
          { key: 'positionTitle', label: 'Position' },
          { key: 'authorityLevel', label: 'Authority', render: (r: Row) => titleCase(r.authorityLevel) },
          { key: 'effectiveFrom', label: 'Effective from', render: (r: Row) => fmt(r.effectiveFrom) },
          { key: 'expiresAt', label: 'Expires', render: (r: Row) => fmt(r.expiresAt) },
          { key: 'approvedScopes', label: 'Approved scopes' },
          { key: 'status', label: 'Status', render: (r: Row) => <Chip value={r.status} /> },
          {
            key: 'actions',
            label: '',
            render: (r: Row) => (
              <div className="head-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setDetailId(Number(r.id))}
                >
                  Detail
                </button>
              </div>
            ),
          },
        ]}
        rows={rows}
        empty="No signature profiles yet. A profile must be created and given an approved authority scope before anyone can sign a document with it."
      />

      {creating && (
        <Modal
          title="New signature profile"
          onClose={() => setCreating(false)}
          footer={
            <div className="head-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={save}>
                {act.busy ? 'Saving...' : 'Create profile'}
              </button>
            </div>
          }
        >
          <div className="form-grid">
            <Field label="User id" required hint="Only this user may apply the signature.">
              <input
                type="number"
                value={str(drafts.userId)}
                onChange={(e) => setDrafts({ ...drafts, userId: e.target.value })}
              />
            </Field>
            <Field label="Signatory name" hint="Defaults to the user own name when left blank.">
              <input
                type="text"
                value={str(drafts.fullName)}
                onChange={(e) => setDrafts({ ...drafts, fullName: e.target.value })}
              />
            </Field>
            <Field label="Position title">
              <input
                type="text"
                value={str(drafts.positionTitle)}
                onChange={(e) => setDrafts({ ...drafts, positionTitle: e.target.value })}
              />
            </Field>
            <Field label="Authority level">
              <FieldInput
                type="select"
                options={SIGNATURE_AUTHORITY_LEVELS}
                value={drafts.authorityLevel}
                onChange={(v) => setDrafts({ ...drafts, authorityLevel: v })}
              />
            </Field>
            <Field label="Effective from">
              <input
                type="date"
                value={str(drafts.effectiveFrom)}
                onChange={(e) => setDrafts({ ...drafts, effectiveFrom: e.target.value })}
              />
            </Field>
            <Field label="Expires on" hint="Leave blank for an open-ended authority.">
              <input
                type="date"
                value={str(drafts.expiresAt)}
                onChange={(e) => setDrafts({ ...drafts, expiresAt: e.target.value })}
              />
            </Field>
          </div>
          {problem && <p className="setting-err">{problem}</p>}
        </Modal>
      )}

      {detailId != null && (
        <SignatureDetail id={detailId} mayManage={mayManage} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}

/** One profile: the identity plus the authority scopes that back it. */
function SignatureDetail({
  id,
  mayManage,
  onClose,
}: {
  id: number;
  mayManage: boolean;
  onClose: () => void;
}) {
  const probe = useAction();
  const [documentType, setDocumentType] = useState('INVOICE');
  const [amount, setAmount] = useState('');
  const [verdict, setVerdict] = useState<{ allowed: boolean; reason: string | null } | null>(null);

  const check = () => {
    setVerdict(null);
    void probe.run(async () => {
      const r = await api<{ data: { allowed: boolean; reason: string | null } }>(
        BASE + '/signatures/can-sign',
        {
          method: 'POST',
          body: JSON.stringify({
            profileId: id,
            documentType: documentType.trim(),
            amount: amount.trim() === '' ? null : Number(amount),
          }),
        }
      );
      setVerdict(r.data);
    }, 'Authority checked.');
  };

  return (
    <Modal title="Signature profile" onClose={onClose} wide>
      <Loader<{ profile: Row; scopes: Row[] }> path={BASE + '/signatures/profiles/' + String(id)}>
        {(data, reload) => (
          <div className="stack">
            <dl className="def-list">
              <div>
                <dt>Signatory</dt>
                <dd>{fmt(data.profile.fullName)}</dd>
              </div>
              <div>
                <dt>Position</dt>
                <dd>{fmt(data.profile.positionTitle)}</dd>
              </div>
              <div>
                <dt>Authority level</dt>
                <dd>{titleCase(data.profile.authorityLevel)}</dd>
              </div>
              <div>
                <dt>Effective window</dt>
                <dd>
                  {fmt(data.profile.effectiveFrom)} to {fmt(data.profile.expiresAt)}
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <Chip value={data.profile.status} />
                </dd>
              </div>
            </dl>

            <h4>Authority scopes</h4>
            <RecordTable
              columns={[
                { key: 'documentType', label: 'Document type' },
                {
                  key: 'transactionType',
                  label: 'Transaction type',
                  render: (r: Row) => fmt(r.transactionType),
                },
                { key: 'maxAmount', label: 'Ceiling', render: (r: Row) => fmt(r.maxAmount) },
                { key: 'status', label: 'Status', render: (r: Row) => <Chip value={r.status} /> },
                { key: 'approvedBy', label: 'Approved by', render: (r: Row) => fmt(r.approvedBy) },
              ]}
              rows={arr(data.scopes)}
              empty="No authority scopes are attached. A profile with no approved scope cannot sign anything."
            />

            {mayManage && (
              <div className="card card-pad">
                <h4>Check authority</h4>
                <p className="muted">
                  Asks the server whether this profile may sign the given document right now. It is
                  the same check the signing workflow performs, run before anybody depends on it.
                </p>
                <div className="form-grid">
                  <Field label="Document type">
                    <input
                      type="text"
                      value={documentType}
                      onChange={(e) => setDocumentType(e.target.value)}
                    />
                  </Field>
                  <Field label="Amount" hint="Leave blank to test the type without a ceiling.">
                    <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  </Field>
                </div>
                <div className="head-actions">
                  <button type="button" className="btn btn-sm" disabled={probe.busy} onClick={check}>
                    {probe.busy ? 'Checking...' : 'Check authority'}
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={reload}>
                    Reload
                  </button>
                </div>
                <PanelNote error={probe.error} ok={probe.ok} />
                {verdict && (
                  <p className={verdict.allowed ? 'notice-banner' : 'setting-err'}>
                    {verdict.allowed
                      ? 'This profile may sign ' + documentType + ' within its approved scope.'
                      : 'Refused: ' + str(verdict.reason)}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </Loader>
    </Modal>
  );
}
// ---------------------------------------------------------------------------
// Integrations (kind: 'integrations')
// ---------------------------------------------------------------------------

type IntegrationFieldType = 'text' | 'number' | 'boolean' | 'url' | 'select' | 'env';

interface IntegrationField {
  label: string;
  type: IntegrationFieldType;
  required?: boolean;
  options?: string[];
  help?: string;
}

interface IntegrationDetail {
  code: string;
  name: string;
  category: string;
  blurb: string;
  testable: boolean;
  fields: Record<string, IntegrationField>;
  values: Record<string, unknown>;
  secrets: Record<string, boolean>;
  secretFields: string[];
  configured: boolean;
  status: string;
  isActive: boolean;
  lastTestedAt: string | null;
  health: { lastSuccessAt: string | null; lastFailureAt: string | null; lastError: string | null };
}

const toSettingType = (t: IntegrationFieldType): SettingType =>
  t === 'number' ? 'number'
  : t === 'boolean' ? 'boolean'
  : t === 'url' ? 'url'
  : t === 'select' ? 'select'
  : 'text';

/**
 * The integration registry.
 *
 * Every provider the ERP talks to is described by the server - the code, the
 * fields, which of those fields are credentials and which statuses are legal.
 * This screen renders that description rather than keeping its own copy, so a
 * provider added on the server appears here without a code change (AC-ORG-012).
 *
 * Credentials are write-only. The server returns presence, never a value, so an
 * empty credential box means "leave the stored one alone" and clearing it is a
 * separate, explicit action. The screen cannot leak a secret it was never given
 * (AC-ORG-010).
 *
 * URA / EFRIS is called out at the top because it is the integration with a
 * statutory clock attached to it: the environment stays SANDBOX until the
 * connection has been proven, and the sandbox-proven flag is part of the
 * evidence trail for that claim.
 */
function IntegrationsPanel({
  view,
  mayManage,
  onChanged,
}: {
  view: CategoryView;
  mayManage: boolean;
  onChanged: () => void;
}) {
  const rows = arr(view.list);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const needle = filter.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      needle === '' ||
      str(r.name).toLowerCase().includes(needle) ||
      str(r.code).toLowerCase().includes(needle) ||
      str(r.category).toLowerCase().includes(needle)
  );
  const efris = rows.find((r) => str(r.code) === 'ura_efris') ?? null;
  const configuredCount = rows.filter((r) => r.configured === true).length;

  return (
    <div className="stack">
      <div className="summary-chips">
        <span className="summary-chip">Providers <strong>{rows.length}</strong></span>
        <span className="summary-chip">Configured <strong>{configuredCount}</strong></span>
        <span className="summary-chip">Outstanding <strong>{rows.length - configuredCount}</strong></span>
      </div>

      {efris && (
        <div className="card card-pad">
          <div className="card-head">
            <h4>URA / EFRIS</h4>
            <Chip value={efris.configured === true ? 'CONNECTED' : 'DISCONNECTED'} />
          </div>
          <p className="muted">
            Fiscal e-invoicing. Until the URA sandbox connection has been proven end to end, keep
            the environment on SANDBOX and leave the sandbox-verified flag clear - a production
            endpoint that has never answered would put fiscal documents at risk. The integration
            request letter and the technical onboarding checklist are held with the ERP
            documentation.
          </p>
          <div className="head-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => setOpen('ura_efris')}
            >
              {mayManage ? 'Configure URA / EFRIS' : 'View URA / EFRIS'}
            </button>
          </div>
        </div>
      )}

      <Field label="Search providers">
        <input
          type="text"
          value={filter}
          placeholder="Name, code or category"
          onChange={(e) => setFilter(e.target.value)}
        />
      </Field>

      <RecordTable
        columns={[
          { key: 'name', label: 'Provider' },
          { key: 'code', label: 'Code' },
          { key: 'category', label: 'Category', render: (r: Row) => titleCase(r.category) },
          {
            key: 'configured',
            label: 'Configured',
            render: (r: Row) => (
              <Chip
                value={r.configured === true ? 'ACTIVE' : 'DRAFT'}
                label={r.configured === true ? 'Yes' : 'No'}
              />
            ),
          },
          {
            key: 'blurb',
            label: 'Purpose',
            render: (r: Row) => <span className="muted">{str(r.blurb)}</span>,
          },
          {
            key: 'actions',
            label: '',
            render: (r: Row) => (
              <div className="head-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setOpen(str(r.code))}
                >
                  {mayManage ? 'Configure' : 'View'}
                </button>
              </div>
            ),
          },
        ]}
        rows={shown}
        empty="No provider matches that search."
      />

      {open != null && (
        <IntegrationEditor
          code={open}
          mayManage={mayManage}
          onClose={() => setOpen(null)}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}

/** One provider: config fields, credential placeholders and the health record. */
function IntegrationEditor({
  code,
  mayManage,
  onClose,
  onSaved,
}: {
  code: string;
  mayManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Modal title={'Integration - ' + code} onClose={onClose} wide>
      <Loader<IntegrationDetail> path={BASE + '/integrations/' + code}>
        {(data, reload) => (
          <IntegrationForm
            key={code}
            data={data}
            mayManage={mayManage}
            reload={reload}
            onSaved={onSaved}
          />
        )}
      </Loader>
    </Modal>
  );
}

function IntegrationForm({
  data,
  mayManage,
  reload,
  onSaved,
}: {
  data: IntegrationDetail;
  mayManage: boolean;
  reload: () => void;
  onSaved: () => void;
}) {
  const act = useAction(() => {
    reload();
    onSaved();
  });
  const probe = useAction(reload);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const next: Record<string, Draft> = { status: toDraft(data.status) };
    for (const [key, value] of Object.entries(data.values)) next[key] = toDraft(value);
    return next;
  });
  const [clear, setClear] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [detail, setDetail] = useState('');

  const fields = Object.entries(data.fields);

  const submit = () => {
    const body: Record<string, unknown> = { code: data.code, status: str(drafts.status) || data.status };
    for (const [key, def] of fields) {
      const v = drafts[key];
      if (def.type === 'boolean') body[key] = v === true;
      else if (def.type === 'number') body[key] = isBlank(v) ? null : Number(v);
      else {
        const raw = str(v).trim();
        body[key] = raw === '' ? null : raw;
      }
    }
    for (const [key, def] of fields) {
      if (def.required === true && isBlank(body[key])) {
        setProblem(def.label + ' is required.');
        return;
      }
    }
    for (const key of data.secretFields) {
      const raw = str(drafts[key]).trim();
      if (raw !== '') body[key] = raw;
    }
    if (clear.length > 0) body.clearSecrets = clear;
    setProblem(null);
    setClear([]);
    void act.run(
      () => api(BASE + '/integrations/' + data.code, { method: 'PATCH', body: JSON.stringify(body) }),
      data.name + ' saved.'
    );
  };

  return (
    <div className="stack">
      <p className="muted">{data.blurb}</p>
      <div className="summary-chips">
        <span className="summary-chip">Category <strong>{titleCase(data.category)}</strong></span>
        <span className="summary-chip">Status <strong>{str(data.status)}</strong></span>
        <span className="summary-chip">Last tested <strong>{fmtWhen(data.lastTestedAt)}</strong></span>
        <span className="summary-chip">Last success <strong>{fmtWhen(data.health.lastSuccessAt)}</strong></span>
      </div>
      {data.health.lastFailureAt != null && (
        <div className="setting-row-error">
          Last failure {fmtWhen(data.health.lastFailureAt)}: {fmt(data.health.lastError)}
        </div>
      )}

      <div className="form-grid">
        <Field
          label="Status"
          hint="CONNECTED only after the provider has answered at least once."
        >
          <FieldInput
            type="select"
            options={['CONNECTED', 'DISCONNECTED', 'ERROR', 'TESTING']}
            value={drafts.status}
            disabled={!mayManage}
            onChange={(v) => setDrafts({ ...drafts, status: v })}
          />
        </Field>
        {fields.map(([key, def]) => (
          <Field key={key} label={def.label} hint={def.help} required={def.required === true}>
            <FieldInput
              type={toSettingType(def.type)}
              options={def.options}
              value={drafts[key]}
              disabled={!mayManage}
              placeholder={def.type === 'env' ? 'Environment variable name' : undefined}
              onChange={(v) => setDrafts({ ...drafts, [key]: v })}
            />
          </Field>
        ))}
      </div>

      <h4>Credentials</h4>
      <p className="muted">
        Stored encrypted and never returned. Leave a box empty to keep the credential already
        stored; tick Clear to remove it.
      </p>
      <div className="form-grid">
        {data.secretFields.map((key) => (
          <Field
            key={key}
            label={titleCase(key)}
            hint={data.secrets[key] === true ? 'A credential is stored.' : 'No credential stored yet.'}
          >
            <input
              type="password"
              value={str(drafts[key])}
              disabled={!mayManage || clear.includes(key)}
              placeholder={
                data.secrets[key] === true ? 'Leave blank to keep the stored value' : 'Not set'
              }
              onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={clear.includes(key)}
                disabled={!mayManage || data.secrets[key] !== true}
                onChange={(e) =>
                  setClear(e.target.checked ? [...clear, key] : clear.filter((k) => k !== key))
                }
              />
              <span>Clear the stored credential</span>
            </label>
          </Field>
        ))}
      </div>

      {problem && <p className="setting-err">{problem}</p>}
      <PanelNote error={act.error} ok={act.ok} />

      {data.testable && mayManage && (
        <div className="card card-pad">
          <h4>Connectivity test</h4>
          <p className="muted">
            Record the outcome of a probe made against the provider. The server stamps the time and
            keeps the result on the integration health record; it does not call the provider itself.
          </p>
          <Field label="Detail" hint="What the probe returned, or why it failed.">
            <input type="text" value={detail} onChange={(e) => setDetail(e.target.value)} />
          </Field>
          <div className="head-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={probe.busy}
              onClick={() =>
                void probe.run(
                  () =>
                    api(BASE + '/integrations/' + data.code + '/test-result', {
                      method: 'POST',
                      body: JSON.stringify({ ok: true, detail: detail.trim() || null }),
                    }),
                  'Successful probe recorded.'
                )
              }
            >
              Record success
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={probe.busy}
              onClick={() =>
                void probe.run(
                  () =>
                    api(BASE + '/integrations/' + data.code + '/test-result', {
                      method: 'POST',
                      body: JSON.stringify({ ok: false, detail: detail.trim() || null }),
                    }),
                  'Failed probe recorded.'
                )
              }
            >
              Record failure
            </button>
          </div>
          <PanelNote error={probe.error} ok={probe.ok} />
        </div>
      )}

      <div className="head-actions">
        <button type="button" className="btn btn-ghost" onClick={reload}>
          Reload
        </button>
        {mayManage && (
          <button type="button" className="btn btn-primary" disabled={act.busy} onClick={submit}>
            {act.busy ? 'Saving...' : 'Save integration'}
          </button>
        )}
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Retention, legal hold and backup
// ---------------------------------------------------------------------------

const RETENTION_CATEGORIES = [
  'AUDIT',
  'DOCUMENTS',
  'PAYROLL',
  'FINANCIAL',
  'TICKETS',
  'QR_HISTORY',
  'ATTENDANCE',
  'MANUFACTURING',
  'INVENTORY',
  'HR',
  'SALES',
  'PROCUREMENT',
  'COMMUNICATION',
  'INTEGRATION_LOGS',
  'OTHER',
];

const PURGE_ACTIONS = ['RETAIN', 'ARCHIVE', 'ANONYMISE', 'DELETE'];

/**
 * Record sets the URA, the Companies Act and the Employment Act expect to still
 * exist years later. DELETE is withheld from these categories in the UI as well
 * as on the server: a statutory record is archived or anonymised, never
 * dropped, and no single administrator gets to decide otherwise from a dropdown.
 */
const STATUTORY_CATEGORIES = ['AUDIT', 'PAYROLL', 'FINANCIAL', 'DOCUMENTS', 'QR_HISTORY'];

const BACKUP_SCOPES = ['DATABASE', 'DOCUMENTS', 'FILES', 'CONFIGURATION', 'FULL'];
const BACKUP_FREQUENCIES = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'];

const isStatutoryCategory = (category: string) => STATUTORY_CATEGORIES.indexOf(category) >= 0;

interface RetentionDraft {
  id: number | null;
  category: string;
  appliesTo: string;
  retentionDays: string;
  archiveAfterDays: string;
  purgeAction: string;
  legalHold: boolean;
  legalBasis: string;
  code: string;
  name: string;
  notes: string;
  isActive: boolean;
}

const blankRetention = (): RetentionDraft => ({
  id: null,
  category: 'AUDIT',
  appliesTo: 'ALL_RECORDS',
  retentionDays: '365',
  archiveAfterDays: '',
  purgeAction: 'RETAIN',
  legalHold: false,
  legalBasis: '',
  code: '',
  name: '',
  notes: '',
  isActive: true,
});

const retentionDraftOf = (row: Row): RetentionDraft => ({
  id: Number(row.id),
  category: str(row.category) || 'OTHER',
  appliesTo: str(row.appliesTo) || 'ALL_RECORDS',
  retentionDays: str(row.retentionDays),
  archiveAfterDays: str(row.archiveAfterDays),
  purgeAction: str(row.purgeAction) || 'RETAIN',
  legalHold: row.legalHold === true,
  legalBasis: str(row.legalBasis),
  code: str(row.code),
  name: str(row.name),
  notes: str(row.notes),
  isActive: row.isActive !== false,
});

interface BackupDraft {
  id: number | null;
  code: string;
  name: string;
  scope: string;
  frequency: string;
  runAt: string;
  retentionCount: string;
  retentionDays: string;
  rpoMinutes: string;
  rtoMinutes: string;
  destination: string;
  notes: string;
  encryptionRequired: boolean;
  offsiteRequired: boolean;
  verifyRestore: boolean;
  isActive: boolean;
}

const blankBackup = (): BackupDraft => ({
  id: null,
  code: '',
  name: '',
  scope: 'DATABASE',
  frequency: 'DAILY',
  runAt: '02:00:00',
  retentionCount: '',
  retentionDays: '30',
  rpoMinutes: '1440',
  rtoMinutes: '240',
  destination: '',
  notes: '',
  encryptionRequired: true,
  offsiteRequired: true,
  verifyRestore: true,
  isActive: true,
});

const backupDraftOf = (row: Row): BackupDraft => ({
  id: Number(row.id),
  code: str(row.code),
  name: str(row.name),
  scope: str(row.scope) || 'DATABASE',
  frequency: str(row.frequency) || 'DAILY',
  runAt: str(row.runAt) || '02:00:00',
  retentionCount: str(row.retentionCount),
  retentionDays: str(row.retentionDays),
  rpoMinutes: str(row.rpoMinutes),
  rtoMinutes: str(row.rtoMinutes),
  destination: str(row.destination),
  notes: str(row.notes),
  encryptionRequired: row.encryptionRequired !== false,
  offsiteRequired: row.offsiteRequired !== false,
  verifyRestore: row.verifyRestore !== false,
  isActive: row.isActive !== false,
});

const numOrNull = (v: string): number | null => {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const RUN_AT_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * Retention and backup configuration.
 *
 * Two rules drive the shape of this screen. A statutory record set can never be
 * configured for DELETE, and a record under legal hold can never be configured
 * for anything but RETAIN - so the purge control for a held or statutory set is
 * disabled and the reason is stated next to it rather than left to a failed
 * save to explain. The other is that the last active backup cannot be switched
 * off: the server refuses it, and the UI turns the refusal into a confirmation
 * so an administrator cannot quietly leave the factory with no backup at all.
 */
function RetentionPanel({ mayManage, onChanged }: { mayManage: boolean; onChanged: () => void }) {
  const { data, error, reload } = useLoad<Row>(BASE + '/retention/overview');
  const done = useCallback(() => {
    reload();
    onChanged();
  }, [reload, onChanged]);
  const act = useAction(done);
  const [retention, setRetention] = useState<RetentionDraft | null>(null);
  const [backup, setBackup] = useState<BackupDraft | null>(null);
  const [hold, setHold] = useState<{ row: Row; next: boolean } | null>(null);
  const [disable, setDisable] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  if (error && data === null) return <ErrorBanner error={error} />;
  if (data === null) return <PageLoader />;

  const policies = arr(data.policies);
  const backups = arr(data.backups);
  const statutoryCount = Number(data.statutory == null ? 0 : arr(data.statutory).length);
  const holdCount = Number(data.underHold == null ? 0 : arr(data.underHold).length);
  const destructiveCount = Number(data.destructive == null ? 0 : arr(data.destructive).length);
  const activeBackups = Number(data.activeBackups ?? 0);
  const bestRpo = data.bestRpoMinutes == null ? null : Number(data.bestRpoMinutes);

  const openRetention = (row: Row | null) => {
    setProblem(null);
    setReason('');
    setRetention(row ? retentionDraftOf(row) : blankRetention());
  };

  const openBackup = (row: Row | null) => {
    setProblem(null);
    setReason('');
    setBackup(row ? backupDraftOf(row) : blankBackup());
  };

  const saveRetention = () => {
    if (!retention) return;
    const days = Number(retention.retentionDays);
    if (!Number.isFinite(days) || days <= 0) {
      setProblem('Retention days must be a positive number.');
      return;
    }
    const archiveDays = numOrNull(retention.archiveAfterDays);
    if (retention.archiveAfterDays.trim() !== '' && archiveDays === null) {
      setProblem('Archive after must be a number of days, or left blank.');
      return;
    }
    if (archiveDays !== null && archiveDays >= days) {
      setProblem('Archive after must be shorter than the retention period, otherwise the record archives after it is purged.');
      return;
    }
    if (retention.purgeAction === 'DELETE' && isStatutoryCategory(retention.category)) {
      setProblem(retention.category + ' is a statutory record set. Use ARCHIVE or ANONYMISE.');
      return;
    }
    if (retention.legalHold && retention.purgeAction !== 'RETAIN') {
      setProblem('A policy under legal hold can only RETAIN. Release the hold first.');
      return;
    }
    setProblem(null);
    const body = {
      id: retention.id,
      category: retention.category,
      appliesTo: retention.appliesTo.trim() || 'ALL_RECORDS',
      retentionDays: days,
      archiveAfterDays: archiveDays,
      purgeAction: retention.purgeAction,
      legalHold: retention.legalHold,
      legalBasis: retention.legalBasis.trim() || null,
      code: retention.code.trim() || null,
      name: retention.name.trim() || null,
      notes: retention.notes.trim() || null,
      isActive: retention.isActive,
      reason: reason.trim() || null,
    };
    setRetention(null);
    setReason('');
    void act.run(
      () => api(BASE + '/retention/policies', { method: 'PUT', body: JSON.stringify(body) }),
      'Retention policy saved for ' + retention.category + '.'
    );
  };

  const saveBackup = () => {
    if (!backup) return;
    const code = backup.code.trim().toUpperCase();
    if (code === '') {
      setProblem('A backup policy needs a code: it is the key a restore run is recorded against.');
      return;
    }
    if (!RUN_AT_RE.test(backup.runAt.trim())) {
      setProblem('Run at must be a 24-hour time such as 02:00 or 02:00:00.');
      return;
    }
    const count = numOrNull(backup.retentionCount);
    const bdays = numOrNull(backup.retentionDays);
    if (count === null && bdays === null) {
      setProblem('Set at least one of retention count or retention days, otherwise old copies accumulate forever.');
      return;
    }
    setProblem(null);
    const body = {
      id: backup.id,
      code,
      name: backup.name.trim() || null,
      scope: backup.scope,
      frequency: backup.frequency,
      runAt: backup.runAt.trim(),
      retentionCount: count,
      retentionDays: bdays,
      rpoMinutes: numOrNull(backup.rpoMinutes),
      rtoMinutes: numOrNull(backup.rtoMinutes),
      destination: backup.destination.trim() || null,
      notes: backup.notes.trim() || null,
      encryptionRequired: backup.encryptionRequired,
      offsiteRequired: backup.offsiteRequired,
      verifyRestore: backup.verifyRestore,
      isActive: backup.isActive,
      reason: reason.trim() || null,
    };
    setBackup(null);
    setReason('');
    void act.run(
      () => api(BASE + '/backup/policies', { method: 'POST', body: JSON.stringify(body) }),
      'Backup policy ' + code + ' saved.'
    );
  };

  const applyHold = () => {
    if (!hold) return;
    const id = Number(hold.row.id);
    if (!hold.next && reason.trim() === '') {
      setProblem('Releasing a legal hold needs a reason: it is the record of who decided these records may be destroyed.');
      return;
    }
    setProblem(null);
    setHold(null);
    const body = { hold: hold.next, reason: reason.trim() || null };
    setReason('');
    void act.run(
      () =>
        api(BASE + '/retention/policies/' + String(id) + '/legal-hold', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      hold.next ? 'Legal hold applied.' : 'Legal hold released.'
    );
  };

  const setActive = (row: Row, next: boolean) => {
    const id = Number(row.id);
    if (!next) {
      setProblem(null);
      setReason('');
      setDisable(row);
      return;
    }
    void act.run(
      () =>
        api(BASE + '/backup/policies/' + String(id) + '/active', {
          method: 'POST',
          body: JSON.stringify({ active: true, reason: reason.trim() || null }),
        }),
      'Backup policy re-enabled.'
    );
  };

  const confirmDisable = () => {
    if (!disable) return;
    const id = Number(disable.id);
    setDisable(null);
    const body = { active: false, reason: reason.trim() || null };
    setReason('');
    void act.run(
      () =>
        api(BASE + '/backup/policies/' + String(id) + '/active', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      'Backup policy disabled.'
    );
  };

  return (
    <div className="stack">
      <div className="summary-chips">
        <span className="summary-chip">Retention policies: {policies.length}</span>
        <span className="summary-chip">Backup policies: {backups.length}</span>
        <span className="summary-chip">Active backups: {activeBackups}</span>
        <span className="summary-chip">Statutory sets: {statutoryCount}</span>
        <span className="summary-chip">Under legal hold: {holdCount}</span>
        <span className="summary-chip">Set to DELETE: {destructiveCount}</span>
        <span className="summary-chip">Best RPO: {bestRpo === null ? 'not stated' : String(bestRpo) + ' min'}</span>
      </div>

      <PanelNote error={act.error} ok={act.ok} />
      {problem && <div className="field-error">{problem}</div>}

      <div className="card">
        <div className="card-head">
          <strong>Retention policies</strong>
          <div className="head-actions">
            <button type="button" className="btn btn-ghost" onClick={reload}>
              Reload
            </button>
            {mayManage && (
              <button type="button" className="btn btn-primary" onClick={() => openRetention(null)}>
                New policy
              </button>
            )}
          </div>
        </div>
        <div className="card-pad">
          <p className="muted">
            How long each record set is kept, when it is archived, and what finally happens to it. Every policy is
            keyed on the record category, so a change applies to future records of that category and is audited
            against the policy it replaced.
          </p>
          <RecordTable
            empty="No retention policies configured yet."
            rows={policies}
            columns={[
              {
                key: 'category',
                label: 'Category',
                render: (row) => (
                  <span>
                    <Chip value={row.category} />
                    {isStatutoryCategory(str(row.category)) && <span className="muted"> statutory</span>}
                  </span>
                ),
              },
              { key: 'appliesTo', label: 'Applies to' },
              { key: 'retentionDays', label: 'Retain (days)' },
              { key: 'archiveAfterDays', label: 'Archive after (days)' },
              { key: 'purgeAction', label: 'Then', render: (row) => <Chip value={row.purgeAction} /> },
              { key: 'legalHold', label: 'Legal hold', render: (row) => <Chip value={row.legalHold === true} label={row.legalHold === true ? 'HELD' : 'No'} /> },
              { key: 'isActive', label: 'Active', render: (row) => <Chip value={row.isActive === true} /> },
              {
                key: 'actions',
                label: '',
                render: (row) => (
                  <div className="head-actions">
                    {mayManage && (
                      <>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => openRetention(row)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => {
                            setProblem(null);
                            setReason('');
                            setHold({ row, next: row.legalHold !== true });
                          }}
                        >
                          {row.legalHold === true ? 'Release hold' : 'Apply hold'}
                        </button>
                      </>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <strong>Backup policies</strong>
          <div className="head-actions">
            {mayManage && (
              <button type="button" className="btn btn-primary" onClick={() => openBackup(null)}>
                New backup policy
              </button>
            )}
          </div>
        </div>
        <div className="card-pad">
          <p className="muted">
            Schedule, scope and copy retention. The shortest RPO in this table is what the disaster-recovery plan
            can honestly claim, so it is worth stating deliberately rather than leaving blank.
          </p>
          <RecordTable
            empty="No backup policies configured yet."
            rows={backups}
            columns={[
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Name' },
              { key: 'scope', label: 'Scope' },
              { key: 'frequency', label: 'Frequency' },
              { key: 'runAt', label: 'Run at' },
              { key: 'retentionCount', label: 'Keep copies' },
              { key: 'retentionDays', label: 'Keep (days)' },
              { key: 'rpoMinutes', label: 'RPO (min)' },
              { key: 'encryptionRequired', label: 'Encrypted', render: (row) => <Chip value={row.encryptionRequired === true} /> },
              { key: 'verifyRestore', label: 'Restore verified', render: (row) => <Chip value={row.verifyRestore === true} /> },
              { key: 'isActive', label: 'Active', render: (row) => <Chip value={row.isActive === true} /> },
              {
                key: 'actions',
                label: '',
                render: (row) => (
                  <div className="head-actions">
                    {mayManage && (
                      <>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => openBackup(row)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setActive(row, row.isActive !== true)}
                        >
                          {row.isActive === true ? 'Disable' : 'Enable'}
                        </button>
                      </>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </div>
      </div>

      {retention && (
        <Modal title={retention.id === null ? 'New retention policy' : 'Retention policy'} onClose={() => setRetention(null)} wide>
          <div className="form-grid">
            <Field label="Record category" required>
              <FieldInput
                type="select"
                options={RETENTION_CATEGORIES}
                value={retention.category}
                disabled={retention.id !== null}
                onChange={(v) => {
                  const next = str(v);
                  setRetention((d) =>
                    d === null
                      ? d
                      : {
                          ...d,
                          category: next,
                          purgeAction: isStatutoryCategory(next) && d.purgeAction === 'DELETE' ? 'RETAIN' : d.purgeAction,
                        }
                  );
                }}
              />
            </Field>
            <Field label="Applies to" hint="Free-form scope label, such as ALL_RECORDS or a specific tenant or company.">
              <FieldInput
                type="text"
                value={retention.appliesTo}
                onChange={(v) => setRetention((d) => (d === null ? d : { ...d, appliesTo: str(v) }))}
              />
            </Field>
            <Field label="Retain for (days)" required>
              <FieldInput
                type="number"
                value={retention.retentionDays}
                onChange={(v) => setRetention((d) => (d === null ? d : { ...d, retentionDays: str(v) }))}
              />
            </Field>
            <Field label="Archive after (days)" hint="Leave blank to archive only at the end of the retention period.">
              <FieldInput
                type="number"
                value={retention.archiveAfterDays}
                onChange={(v) => setRetention((d) => (d === null ? d : { ...d, archiveAfterDays: str(v) }))}
              />
            </Field>
            <Field
              label="Then"
              hint={
                isStatutoryCategory(retention.category)
                  ? retention.category + ' is a statutory record set, so DELETE is not offered.'
                  : 'What finally happens to the records once the retention period ends.'
              }
            >
              <FieldInput
                type="select"
                options={
                  isStatutoryCategory(retention.category)
                    ? PURGE_ACTIONS.filter((a) => a !== 'DELETE')
                    : PURGE_ACTIONS
                }
                value={retention.purgeAction}
                disabled={retention.legalHold}
                onChange={(v) => setRetention((d) => (d === null ? d : { ...d, purgeAction: str(v) }))}
              />
            </Field>
            <Field label="Legal hold" hint="While a policy is held, nothing may be purged from its record set.">
              <FieldInput
                type="boolean"
                value={retention.legalHold}
                onChange={(v) =>
                  setRetention((d) =>
                    d === null
                      ? d
                      : { ...d, legalHold: v === true, purgeAction: v === true ? 'RETAIN' : d.purgeAction }
                  )
                }
              />
            </Field>
            <Field label="Legal basis" hint="The statute, order or instruction the retention period comes from.">
              <FieldInput
                type="text"
                value={retention.legalBasis}
                onChange={(v) => setRetention((d) => (d === null ? d : { ...d, legalBasis: str(v) }))}
              />
            </Field>
            <Field label="Code">
              <FieldInput
                type="text"
                value={retention.code}
                onChange={(v) => setRetention((d) => (d === null ? d : { ...d, code: str(v) }))}
              />
            </Field>
            <Field label="Name">
              <FieldInput
                type="text"
                value={retention.name}
                onChange={(v) => setRetention((d) => (d === null ? d : { ...d, name: str(v) }))}
              />
            </Field>
            <Field label="Notes">
              <FieldInput
                type="textarea"
                value={retention.notes}
                onChange={(v) => setRetention((d) => (d === null ? d : { ...d, notes: str(v) }))}
              />
            </Field>
            <Field label="Active">
              <FieldInput
                type="boolean"
                value={retention.isActive}
                onChange={(v) => setRetention((d) => (d === null ? d : { ...d, isActive: v === true }))}
              />
            </Field>
          </div>
          <Reason value={reason} onChange={setReason} />
          <div className="head-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setRetention(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!mayManage || act.busy} onClick={saveRetention}>
              {act.busy ? 'Saving...' : 'Save policy'}
            </button>
          </div>
        </Modal>
      )}

      {backup && (
        <Modal title={backup.id === null ? 'New backup policy' : 'Backup policy'} onClose={() => setBackup(null)} wide>
          <div className="form-grid">
            <Field label="Code" required hint="The key a restore run is recorded against. Examples: HDG-NIGHTLY, HDG-OFFSITE.">
              <FieldInput
                type="text"
                value={backup.code}
                disabled={backup.id !== null}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, code: str(v) }))}
              />
            </Field>
            <Field label="Name">
              <FieldInput
                type="text"
                value={backup.name}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, name: str(v) }))}
              />
            </Field>
            <Field label="Scope">
              <FieldInput
                type="select"
                options={BACKUP_SCOPES}
                value={backup.scope}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, scope: str(v) }))}
              />
            </Field>
            <Field label="Frequency">
              <FieldInput
                type="select"
                options={BACKUP_FREQUENCIES}
                value={backup.frequency}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, frequency: str(v) }))}
              />
            </Field>
            <Field label="Run at" required hint="24-hour time, such as 02:00 or 02:00:00.">
              <FieldInput
                type="text"
                value={backup.runAt}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, runAt: str(v) }))}
              />
            </Field>
            <Field label="Keep copies" hint="Set copies or days, or both. At least one is required.">
              <FieldInput
                type="number"
                value={backup.retentionCount}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, retentionCount: str(v) }))}
              />
            </Field>
            <Field label="Keep (days)">
              <FieldInput
                type="number"
                value={backup.retentionDays}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, retentionDays: str(v) }))}
              />
            </Field>
            <Field label="RPO (minutes)" hint="How much data loss the business accepts. Drives the DR claim.">
              <FieldInput
                type="number"
                value={backup.rpoMinutes}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, rpoMinutes: str(v) }))}
              />
            </Field>
            <Field label="RTO (minutes)" hint="How long a restore may take before the plant is considered down.">
              <FieldInput
                type="number"
                value={backup.rtoMinutes}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, rtoMinutes: str(v) }))}
              />
            </Field>
            <Field label="Destination">
              <FieldInput
                type="text"
                value={backup.destination}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, destination: str(v) }))}
              />
            </Field>
            <Field label="Encryption required">
              <FieldInput
                type="boolean"
                value={backup.encryptionRequired}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, encryptionRequired: v === true }))}
              />
            </Field>
            <Field label="Offsite copy required">
              <FieldInput
                type="boolean"
                value={backup.offsiteRequired}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, offsiteRequired: v === true }))}
              />
            </Field>
            <Field label="Restore verified" hint="A backup nobody has restored from is a hope, not a backup.">
              <FieldInput
                type="boolean"
                value={backup.verifyRestore}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, verifyRestore: v === true }))}
              />
            </Field>
            <Field label="Active">
              <FieldInput
                type="boolean"
                value={backup.isActive}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, isActive: v === true }))}
              />
            </Field>
            <Field label="Notes">
              <FieldInput
                type="textarea"
                value={backup.notes}
                onChange={(v) => setBackup((d) => (d === null ? d : { ...d, notes: str(v) }))}
              />
            </Field>
          </div>
          <Reason value={reason} onChange={setReason} />
          <div className="head-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setBackup(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!mayManage || act.busy} onClick={saveBackup}>
              {act.busy ? 'Saving...' : 'Save backup policy'}
            </button>
          </div>
        </Modal>
      )}

      {hold && (
        <Modal
          title={hold.next ? 'Apply legal hold' : 'Release legal hold'}
          onClose={() => setHold(null)}
        >
          <p className="muted">
            {hold.next
              ? 'Holding ' +
                str(hold.row.category) +
                ' stops every purge against that record set until the hold is released.'
              : 'Releasing the hold on ' +
                str(hold.row.category) +
                ' allows the configured purge action to run again. State why the records may now be destroyed.'}
          </p>
          <Reason
            value={reason}
            onChange={setReason}
            label={hold.next ? 'Reason (optional)' : 'Reason (required)'}
            hint="Recorded on the audit trail against the policy."
          />
          <div className="head-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setHold(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={act.busy} onClick={applyHold}>
              {hold.next ? 'Apply hold' : 'Release hold'}
            </button>
          </div>
        </Modal>
      )}

      {disable && (
        <Modal title="Disable backup policy" onClose={() => setDisable(null)}>
          <p className="muted">
            Disabling {str(disable.code)} means this scope stops being backed up. The server refuses to disable the
            last active policy, so if this is the only one left the save will be rejected.
          </p>
          <Reason value={reason} onChange={setReason} label="Reason (optional)" />
          <div className="head-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setDisable(null)}>
              Keep active
            </button>
            <button type="button" className="btn btn-primary" disabled={act.busy} onClick={confirmDisable}>
              Disable backup
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
// ---------------------------------------------------------------------------
// Segregation of duties and network rules
// ---------------------------------------------------------------------------

const SOD_ENFORCEMENT = ['hard', 'warn'];
const IP_POLICIES = ['ALLOW_ALL', 'ALLOWLIST_ONLY', 'DENYLIST', 'RESTRICTED_NETWORK'];

const listText = (v: unknown): string => (Array.isArray(v) ? v.map((x) => String(x)).join('\n') : str(v));

interface SodDraft {
  id: number | null;
  code: string;
  name: string;
  description: string;
  primaryPermission: string;
  conflictingPermission: string;
  enforcement: string;
  isActive: boolean;
}

const blankSod = (): SodDraft => ({
  id: null,
  code: '',
  name: '',
  description: '',
  primaryPermission: '',
  conflictingPermission: '',
  enforcement: 'hard',
  isActive: true,
});

const sodDraftOf = (row: Row): SodDraft => ({
  id: Number(row.id),
  code: str(row.code),
  name: str(row.name),
  description: str(row.description),
  primaryPermission: str(row.primaryPermission),
  conflictingPermission: str(row.conflictingPermission),
  enforcement: str(row.enforcement) || 'hard',
  isActive: row.isActive !== false,
});

interface IpDraft {
  id: number | null;
  code: string;
  name: string;
  policy: string;
  target: string;
  entries: string;
  isActive: boolean;
}

const blankIp = (): IpDraft => ({
  id: null,
  code: '',
  name: '',
  policy: 'ALLOWLIST_ONLY',
  target: 'API',
  entries: '',
  isActive: true,
});

const ipDraftOf = (row: Row): IpDraft => ({
  id: Number(row.id),
  code: str(row.code),
  name: str(row.name),
  policy: str(row.policy) || 'ALLOWLIST_ONLY',
  target: str(row.target) || 'API',
  entries: listText(row.entries),
  isActive: row.isActive !== false,
});

/**
 * The two rule sets that sit beside the security policy.
 *
 * Segregation of duties is what stops one person both raising and approving the
 * same payment. Network rules are what stops a stolen session being replayed
 * from outside Uganda. Both are rows, not toggles, because a real control has a
 * name, a scope and someone who can explain why it exists.
 */
function SecurityPanel({ mayManage, onChanged }: { mayManage: boolean; onChanged: () => void }) {
  const overview = useLoad<Row>(BASE + '/security/overview');
  const sodList = useLoad<Row[]>(BASE + '/security/sod');
  const ipList = useLoad<Row[]>(BASE + '/security/ip-rules');
  const sodReload = sodList.reload;
  const ipReload = ipList.reload;
  const done = useCallback(() => {
    sodReload();
    ipReload();
    onChanged();
  }, [sodReload, ipReload, onChanged]);
  const act = useAction(done);
  const [sod, setSod] = useState<SodDraft | null>(null);
  const [ip, setIp] = useState<IpDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const enforced = (overview.data?.enforced ?? null) as Row | null;

  const openSod = (row: Row | null) => {
    setProblem(null);
    setSod(row ? sodDraftOf(row) : blankSod());
  };

  const openIp = (row: Row | null) => {
    setProblem(null);
    setIp(row ? ipDraftOf(row) : blankIp());
  };

  const saveSod = () => {
    if (!sod) return;
    const code = sod.code.trim().toUpperCase();
    const name = sod.name.trim();
    if (code === '' || name === '') {
      setProblem('A segregation rule needs a code and a name.');
      return;
    }
    if (sod.primaryPermission.trim() === '' || sod.conflictingPermission.trim() === '') {
      setProblem('Both the permission and the permission it conflicts with are required.');
      return;
    }
    if (sod.primaryPermission.trim() === sod.conflictingPermission.trim()) {
      setProblem('A permission cannot conflict with itself.');
      return;
    }
    setProblem(null);
    const body = {
      code,
      name,
      description: sod.description.trim() || null,
      primaryPermission: sod.primaryPermission.trim(),
      conflictingPermission: sod.conflictingPermission.trim(),
      enforcement: sod.enforcement,
      isActive: sod.isActive,
    };
    const id = sod.id;
    setSod(null);
    void act.run(
      () =>
        id === null
          ? api(BASE + '/security/sod', { method: 'POST', body: JSON.stringify(body) })
          : api(BASE + '/security/sod/' + String(id), { method: 'PATCH', body: JSON.stringify(body) }),
      id === null ? 'Segregation rule ' + code + ' created.' : 'Segregation rule ' + code + ' updated.'
    );
  };

  const saveIp = () => {
    if (!ip) return;
    const code = ip.code.trim().toUpperCase();
    const name = ip.name.trim();
    if (code === '' || name === '') {
      setProblem('A network rule needs a code and a name.');
      return;
    }
    if (ip.policy !== 'ALLOW_ALL' && ip.entries.trim() === '') {
      setProblem(
        ip.policy === 'DENYLIST'
          ? 'A deny list needs at least one address or CIDR range.'
          : 'This policy needs at least one address or CIDR range.'
      );
      return;
    }
    setProblem(null);
    const body = {
      code,
      name,
      policy: ip.policy,
      target: ip.target.trim() || 'API',
      entries: ip.entries,
      isActive: ip.isActive,
    };
    const id = ip.id;
    setIp(null);
    void act.run(
      () =>
        id === null
          ? api(BASE + '/security/ip-rules', { method: 'POST', body: JSON.stringify(body) })
          : api(BASE + '/security/ip-rules/' + String(id), { method: 'PATCH', body: JSON.stringify(body) }),
      id === null ? 'Network rule ' + code + ' created.' : 'Network rule ' + code + ' updated.'
    );
  };

  return (
    <div className="stack">
      <div className="summary-chips">
        <span className="summary-chip">
          Enforced policy: {enforced ? str(enforced.code) + ' (' + str(enforced.source) + ')' : 'platform defaults'}
        </span>
        <span className="summary-chip">
          Rules: {arr(sodList.data).length} segregation, {arr(ipList.data).length} network
        </span>
      </div>

      {enforced && (
        <p className="setting-managed-note">
          The values above are enforced through policy {str(enforced.code)}
          {enforced.isActive === true || enforced.is_active === true ? ', which is active.' : ', which is not yet active.'}{' '}
          A save writes both the individual settings and the policy row the enforcement path reads, so the two can
          never drift apart.
        </p>
      )}

      <PanelNote error={act.error} ok={act.ok} />
      {problem && <div className="field-error">{problem}</div>}

      <div className="card">
        <div className="card-head">
          <strong>Segregation of duties</strong>
          <div className="head-actions">
            {mayManage && (
              <button type="button" className="btn btn-primary" onClick={() => openSod(null)}>
                New rule
              </button>
            )}
          </div>
        </div>
        <div className="card-pad">
          <p className="muted">
            A hard rule blocks the second permission outright. A warn rule records the conflict and lets the action
            through, which is the honest setting while a control is still being embedded.
          </p>
          <RecordTable
            empty="No segregation rules configured."
            rows={arr(sodList.data)}
            columns={[
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Name' },
              { key: 'primaryPermission', label: 'Permission' },
              { key: 'conflictingPermission', label: 'Conflicts with' },
              { key: 'enforcement', label: 'Enforcement', render: (row) => <Chip value={str(row.enforcement).toUpperCase()} /> },
              { key: 'isActive', label: 'Active', render: (row) => <Chip value={row.isActive === true} /> },
              {
                key: 'actions',
                label: '',
                render: (row) => (
                  <div className="head-actions">
                    {mayManage && (
                      <>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => openSod(row)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() =>
                            void act.run(
                              () => api(BASE + '/security/sod/' + String(row.id), { method: 'DELETE' }),
                              'Segregation rule removed.'
                            )
                          }
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <strong>Network rules</strong>
          <div className="head-actions">
            {mayManage && (
              <button type="button" className="btn btn-primary" onClick={() => openIp(null)}>
                New rule
              </button>
            )}
          </div>
        </div>
        <div className="card-pad">
          <p className="muted">
            Addresses and CIDR ranges, one per line or comma separated. DENYLIST blocks everything listed and allows
            the rest; ALLOWLIST_ONLY is the safe default because it fails closed.
          </p>
          <RecordTable
            empty="No network rules configured."
            rows={arr(ipList.data)}
            columns={[
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Name' },
              { key: 'policy', label: 'Policy', render: (row) => <Chip value={str(row.policy).toUpperCase()} /> },
              { key: 'target', label: 'Target' },
              { key: 'entries', label: 'Entries', render: (row) => <span className="audit-key">{listText(row.entries) || 'any'}</span> },
              { key: 'isActive', label: 'Active', render: (row) => <Chip value={row.isActive === true} /> },
              {
                key: 'actions',
                label: '',
                render: (row) => (
                  <div className="head-actions">
                    {mayManage && (
                      <>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => openIp(row)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() =>
                            void act.run(
                              () => api(BASE + '/security/ip-rules/' + String(row.id), { method: 'DELETE' }),
                              'Network rule removed.'
                            )
                          }
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </div>
      </div>

      {sod && (
        <Modal title={sod.id === null ? 'New segregation rule' : 'Segregation rule'} onClose={() => setSod(null)}>
          <div className="form-grid">
            <Field label="Code" required>
              <FieldInput
                type="text"
                value={sod.code}
                disabled={sod.id !== null}
                onChange={(v) => setSod((d) => (d === null ? d : { ...d, code: str(v) }))}
              />
            </Field>
            <Field label="Name" required>
              <FieldInput
                type="text"
                value={sod.name}
                onChange={(v) => setSod((d) => (d === null ? d : { ...d, name: str(v) }))}
              />
            </Field>
            <Field label="Permission" required hint="Permission code, such as finance.payment.create.">
              <FieldInput
                type="text"
                value={sod.primaryPermission}
                onChange={(v) => setSod((d) => (d === null ? d : { ...d, primaryPermission: str(v) }))}
              />
            </Field>
            <Field label="Conflicts with" required>
              <FieldInput
                type="text"
                value={sod.conflictingPermission}
                onChange={(v) => setSod((d) => (d === null ? d : { ...d, conflictingPermission: str(v) }))}
              />
            </Field>
            <Field label="Enforcement">
              <FieldInput
                type="select"
                options={SOD_ENFORCEMENT}
                value={sod.enforcement}
                onChange={(v) => setSod((d) => (d === null ? d : { ...d, enforcement: str(v) }))}
              />
            </Field>
            <Field label="Active">
              <FieldInput
                type="boolean"
                value={sod.isActive}
                onChange={(v) => setSod((d) => (d === null ? d : { ...d, isActive: v === true }))}
              />
            </Field>
            <Field label="Description">
              <FieldInput
                type="textarea"
                value={sod.description}
                onChange={(v) => setSod((d) => (d === null ? d : { ...d, description: str(v) }))}
              />
            </Field>
          </div>
          <div className="head-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setSod(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!mayManage || act.busy} onClick={saveSod}>
              {act.busy ? 'Saving...' : 'Save rule'}
            </button>
          </div>
        </Modal>
      )}

      {ip && (
        <Modal title={ip.id === null ? 'New network rule' : 'Network rule'} onClose={() => setIp(null)}>
          <div className="form-grid">
            <Field label="Code" required>
              <FieldInput
                type="text"
                value={ip.code}
                disabled={ip.id !== null}
                onChange={(v) => setIp((d) => (d === null ? d : { ...d, code: str(v) }))}
              />
            </Field>
            <Field label="Name" required>
              <FieldInput
                type="text"
                value={ip.name}
                onChange={(v) => setIp((d) => (d === null ? d : { ...d, name: str(v) }))}
              />
            </Field>
            <Field label="Policy">
              <FieldInput
                type="select"
                options={IP_POLICIES}
                value={ip.policy}
                onChange={(v) => setIp((d) => (d === null ? d : { ...d, policy: str(v) }))}
              />
            </Field>
            <Field label="Target" hint="What the rule guards, such as API, ADMIN or INTEGRATIONS.">
              <FieldInput
                type="text"
                value={ip.target}
                onChange={(v) => setIp((d) => (d === null ? d : { ...d, target: str(v) }))}
              />
            </Field>
            <Field label="Entries" hint="One address or CIDR range per line. Ignored when the policy allows all.">
              <FieldInput
                type="textarea"
                value={ip.entries}
                disabled={ip.policy === 'ALLOW_ALL'}
                onChange={(v) => setIp((d) => (d === null ? d : { ...d, entries: str(v) }))}
              />
            </Field>
            <Field label="Active">
              <FieldInput
                type="boolean"
                value={ip.isActive}
                onChange={(v) => setIp((d) => (d === null ? d : { ...d, isActive: v === true }))}
              />
            </Field>
          </div>
          <div className="head-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setIp(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!mayManage || act.busy} onClick={saveIp}>
              {act.busy ? 'Saving...' : 'Save rule'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/** Read-only rendering of one audit_logs row, shared by the panel and the modal. */
function AuditTable({ rows, empty }: { rows: Row[]; empty: string }) {
  return (
    <RecordTable
      empty={empty}
      rows={rows}
      columns={[
        { key: 'createdAt', label: 'When', render: (row) => <span>{fmtWhen(row.createdAt)}</span> },
        { key: 'actor', label: 'Actor', render: (row) => <span>{str(row.actor) || 'system'}</span> },
        { key: 'action', label: 'Action', render: (row) => <Chip value={str(row.action).toUpperCase()} /> },
        { key: 'resource', label: 'Resource', render: (row) => <span className="audit-key">{str(row.resource)}</span> },
        { key: 'recordCode', label: 'Record', render: (row) => <span>{str(row.recordCode) || str(row.recordId)}</span> },
        {
          key: 'change',
          label: 'Before / after',
          render: (row) => <BeforeAfter before={row.oldValues} after={row.newValues} />,
        },
        { key: 'ip', label: 'IP', render: (row) => <span className="muted">{str(row.ip)}</span> },
      ]}
    />
  );
}

/** Everything the audit row holds, including the parts the table has no room for. */
function AuditDetailModal({ row, onClose }: { row: Row; onClose: () => void }) {
  return (
    <Modal title="Audit record" onClose={onClose} wide>
      <dl className="def-list">
        <div>
          <dt>When</dt>
          <dd>{fmtWhen(row.createdAt)}</dd>
        </div>
        <div>
          <dt>Actor</dt>
          <dd>{str(row.actor) || 'system'}</dd>
        </div>
        <div>
          <dt>Action</dt>
          <dd>{str(row.action)}</dd>
        </div>
        <div>
          <dt>Resource</dt>
          <dd>{str(row.resource)}</dd>
        </div>
        <div>
          <dt>Record</dt>
          <dd>
            {str(row.recordCode) || 'n/a'} {str(row.recordId) ? '(' + str(row.recordId) + ')' : ''}
          </dd>
        </div>
        <div>
          <dt>IP address</dt>
          <dd>{str(row.ip) || 'not captured'}</dd>
        </div>
        <div>
          <dt>Device</dt>
          <dd>{str(row.userAgent) || 'not captured'}</dd>
        </div>
        <div>
          <dt>Request ID</dt>
          <dd>{str(row.correlationId) || 'not captured'}</dd>
        </div>
        <div>
          <dt>Before</dt>
          <dd>{fmt(row.oldValues)}</dd>
        </div>
        <div>
          <dt>After</dt>
          <dd>{fmt(row.newValues)}</dd>
        </div>
        <div>
          <dt>Context</dt>
          <dd>{fmt(row.metadata)}</dd>
        </div>
      </dl>
      <p className="setting-managed-note">
        Audit records are append-only. They are never edited or deleted from this screen, and the retention policy
        for the AUDIT category governs how long they survive.
      </p>
    </Modal>
  );
}

/**
 * The audit category.
 *
 * There is nothing to save here. That is the point: it is the screen an
 * administrator opens to answer "who changed this, when, from where, and what
 * did it say before", and every other category on this screen writes into it.
 */
function AuditPanel() {
  const [resource, setResource] = useState('');
  const [limit, setLimit] = useState('200');
  const [inspect, setInspect] = useState<Row | null>(null);
  const query =
    '?limit=' + encodeURIComponent(limit) + (resource.trim() === '' ? '' : '&resource=' + encodeURIComponent(resource.trim()));
  const { data, error, loading, reload } = useLoad<Row[]>(BASE + '/audit' + query);

  const rows = arr(data);

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <strong>Configuration audit trail</strong>
          <div className="head-actions">
            <button type="button" className="btn btn-ghost" onClick={reload}>
              {loading ? 'Loading...' : 'Reload'}
            </button>
          </div>
        </div>
        <div className="card-pad">
          <div className="form-grid">
            <Field label="Resource" hint="Exact resource name. Blank shows every organisation settings change.">
              <FieldInput
                type="text"
                value={resource}
                placeholder="organisation.settings.tax"
                onChange={(v) => setResource(str(v))}
              />
            </Field>
            <Field label="Limit">
              <FieldInput type="select" options={['50', '100', '200', '500', '1000']} value={limit} onChange={(v) => setLimit(str(v))} />
            </Field>
          </div>
          {error ? <ErrorBanner error={error} /> : null}
          <AuditTable rows={rows} empty="No configuration changes recorded yet." />
          <p className="muted">
            {rows.length} record{rows.length === 1 ? '' : 's'} shown, newest first.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <strong>Open a record</strong>
        </div>
        <div className="card-pad">
          <p className="muted">
            Every configuration change carries its actor, action, resource, before and after values, timestamp, IP,
            device, request ID, reason and approval state. Choose a row above to read the full record.
          </p>
          <RecordTable
            empty="Nothing selected yet."
            rows={rows.slice(0, 25)}
            columns={[
              { key: 'createdAt', label: 'When', render: (row) => <span>{fmtWhen(row.createdAt)}</span> },
              { key: 'action', label: 'Action' },
              { key: 'resource', label: 'Resource' },
              {
                key: 'open',
                label: '',
                render: (row) => (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setInspect(row)}>
                    Details
                  </button>
                ),
              },
            ]}
          />
        </div>
      </div>

      {inspect && <AuditDetailModal row={inspect} onClose={() => setInspect(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field change history
// ---------------------------------------------------------------------------

/**
 * The history of one field.
 *
 * Two sources are merged server-side: audit_logs says who touched the category
 * and why, configuration_history says what each field used to hold. A settings
 * screen needs both, because "the VAT rate moved from 18 to 19.5" is only
 * useful next to "and here is who did it and on whose instruction".
 */
function HistoryModal({
  categoryId,
  settingKey,
  title,
  onClose,
}: {
  categoryId: string;
  settingKey: string | null;
  title: string;
  onClose: () => void;
}) {
  const query = settingKey === null ? '' : '?key=' + encodeURIComponent(settingKey);
  const { data, error, loading } = useLoad<HistoryEntry[]>(BASE + '/category/' + categoryId + '/history' + query);
  const rows: HistoryEntry[] = data ?? [];

  return (
    <Modal title={'History - ' + title} onClose={onClose} wide>
      {error ? <ErrorBanner error={error} /> : null}
      {data === null && loading ? <PageLoader /> : null}
      {data !== null && rows.length === 0 && (
        <Empty>No recorded changes yet. The first save against this field will appear here.</Empty>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Field</th>
                <th>Before / after</th>
                <th>Reason</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.id}>
                  <td>{fmtWhen(entry.at)}</td>
                  <td>{entry.actor ?? 'system'}</td>
                  <td>
                    <span className="audit-key">{entry.key ?? entry.action}</span>
                  </td>
                  <td>
                    <BeforeAfter before={entry.oldValue} after={entry.newValue} />
                  </td>
                  <td>{entry.reason ?? ''}</td>
                  <td className="muted">{entry.ip ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="setting-managed-note">
        History is read from the configuration change log and the audit trail. It is append-only and cannot be
        amended from this screen.
      </p>
    </Modal>
  );
}
// ---------------------------------------------------------------------------
// Screen shell
// ---------------------------------------------------------------------------

const SETTINGS_ROUTE = '/admin/organisation-settings';

/** One row of GET /search. */
interface SearchHit {
  categoryId: string;
  categoryLabel: string;
  group: string;
  key: string | null;
  label: string;
  kind: Kind;
}

/** The active category id from the route, or '' for the catalogue landing. */
function categoryFromPath(path: string, categories: Category[]): string {
  const rest = path.slice(SETTINGS_ROUTE.length).replace(/^\/+/, '');
  const id = rest.split('/')[0];
  return id !== '' && categories.some((c) => c.id === id) ? id : '';
}

/** The categories, grouped in the order the API declares them. */
function groupCategories(groups: string[], categories: Category[]) {
  return groups
    .map((group) => ({ group, members: categories.filter((c) => c.group === group) }))
    .filter((entry) => entry.members.length > 0);
}

/**
 * Organisation Settings - the control plane.
 *
 * The catalogue is fetched once and everything else is derived from it: the
 * navigation, the grouping, which panel a category gets, and which of its keys
 * are secret, immutable or dangerous. A category that gains a field on the
 * server shows up here without a change to this file, which is the difference
 * between a configurable module and a hand-written form per screen.
 *
 * The per-category view is cached in a ref and refetched after every save, so
 * the form shows what was actually stored rather than what was typed. The
 * server coerces what it accepts (an empty string becomes null, a number
 * arrives as a number) and the hybrid categories re-derive their overview on
 * write, so trusting the optimistic draft would drift from the database within
 * one save.
 */
function OrganisationSettings({ path }: { path: string }) {
  const { user } = useAuth();
  const catalogue = useLoad<Catalogue>(BASE + '/catalogue');
  const categories = catalogue.data?.categories ?? [];
  const activeId = categoryFromPath(path, categories);

  const cache = useRef<Map<string, CategoryView>>(new Map());
  const [view, setView] = useState<CategoryView | null>(null);
  const [viewError, setViewError] = useState<unknown>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [cleared, setCleared] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<string[] | null>(null);
  const [pendingText, setPendingText] = useState('');
  const [history, setHistory] = useState<{ categoryId: string; key: string | null; title: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Paint the cached copy first, then still ask the server: another
  // administrator may have changed the same category a minute ago, and showing
  // a stale value is worse than a moment of loading.
  useEffect(() => {
    if (activeId === '') {
      setView(null);
      setViewError(null);
      return;
    }
    const cached = cache.current.get(activeId);
    if (cached) setView(cached);
    let alive = true;
    setViewLoading(true);
    api<{ data: CategoryView }>(BASE + '/category/' + activeId)
      .then((r) => {
        if (!alive) return;
        cache.current.set(activeId, r.data);
        setView(r.data);
        setViewError(null);
      })
      .catch((e) => {
        if (alive) setViewError(e);
      })
      .finally(() => {
        if (alive) setViewLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activeId, nonce]);

  // A draft belongs to the category it was typed into. Clearing on navigation
  // is what stops a half-finished payroll edit being posted against tax when
  // the user switches screens without pressing save.
  useEffect(() => {
    setDrafts({});
    setCleared([]);
    setErrors({});
    setReason('');
    setSaved(null);
    setSaveError(null);
    setPending(null);
    setPendingText('');
  }, [activeId]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      api<{ data: SearchHit[] }>(BASE + '/search?q=' + encodeURIComponent(q))
        .then((r) => {
          if (alive) setHits(arr(r.data) as unknown as SearchHit[]);
        })
        .catch(() => {
          if (alive) setHits([]);
        });
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const category = view?.category ?? categories.find((c) => c.id === activeId) ?? null;
  const kind: Kind = view?.kind ?? category?.kind ?? 'settings';
  const fields = category?.settings ?? {};
  const overview = view?.overview ?? null;

  // security_policy nests its values inside the overview: the category is one
  // policy object rather than a bag of independent settings.
  const formValues = (kind === 'security_policy' ? overview?.values : view?.values) as
    | Record<string, unknown>
    | undefined;
  const formSecrets = (kind === 'security_policy' ? overview?.secrets : view?.secrets) as
    | Record<string, boolean>
    | undefined;
  const values = formValues ?? {};
  const secrets = formSecrets ?? {};

  // Only the two form-shaped kinds have a save bar of their own; every other
  // kind writes through its own panel and its own narrower endpoint.
  const showsForm = kind === 'settings' || kind === 'security_policy';

  const dirty: string[] = [];
  if (showsForm) {
    for (const [key, def] of Object.entries(fields)) {
      if (def.secret === true || secrets[key] !== undefined) {
        if (String(drafts[key] ?? '').length > 0 || cleared.includes(key)) dirty.push(key);
        continue;
      }
      if (drafts[key] === undefined) continue;
      if (!sameDraft(drafts[key], values[key])) dirty.push(key);
    }
  }

  const mayManage = category ? can(user, category.manage) : false;
  const mayView = can(user, catalogue.data?.viewPermission ?? 'organisation.settings.view');
  const dangerousKeys = catalogue.data?.dangerousKeys ?? [];
  const touchedDangerous = dirty.filter((k) => dangerousKeys.includes(k));

  // An unsaved change is the one thing on this screen that a stray click can
  // destroy, so the browser is asked to confirm before the tab goes away.
  useEffect(() => {
    if (dirty.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty.length]);

  const onDraft = useCallback((key: string, v: Draft) => {
    setDrafts((d) => ({ ...d, [key]: v }));
    setSaved(null);
  }, []);

  const onResetKey = useCallback((key: string) => {
    setDrafts((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
  }, []);

  const onToggleClear = useCallback((key: string, on: boolean) => {
    setCleared((c) => (on ? (c.includes(key) ? c : c.concat(key)) : c.filter((k) => k !== key)));
    setSaved(null);
  }, []);

  const discard = () => {
    setDrafts({});
    setCleared([]);
    setErrors({});
    setSaved(null);
    setSaveError(null);
  };

  /** Put every changed row back to the catalogue default for its key. */
  const resetToDefaults = () => {
    const next: Record<string, Draft> = { ...drafts };
    for (const key of dirty) {
      const def = fields[key];
      if (!def) continue;
      if (def.secret === true || secrets[key] !== undefined) {
        delete next[key];
        continue;
      }
      const dflt = def.default;
      next[key] = typeof dflt === 'boolean' ? dflt : dflt === undefined ? '' : String(dflt);
    }
    setDrafts(next);
    setCleared([]);
    setErrors({});
    setSaveError(null);
  };

  /** Field-level refusals, mirroring what the server would accept. */
  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {};
    for (const key of dirty) {
      const def = fields[key];
      if (!def) continue;
      if (def.secret === true || secrets[key] !== undefined) continue;
      const problem = valueProblem(def, drafts[key]);
      if (problem) {
        next[key] = problem;
        continue;
      }
      const raw = String(drafts[key] ?? '').trim();
      // An empty number reaches Number('') on the server and would be stored
      // as a real zero, which changes the meaning instead of clearing it.
      if (def.type === 'number' && raw === '') {
        next[key] = 'Enter a number, or use Reset to default to restore the stored value.';
      }
      // A select that carries a default refuses an empty choice server-side.
      if (def.type === 'select' && raw === '' && def.default !== undefined) {
        next[key] = 'Choose one of: ' + (def.options ?? []).join(', ') + '.';
      }
    }
    return next;
  };

  /**
   * The patch the settings writer accepts.
   *
   * A secret is only sent when it was actually typed, so an untouched password
   * stays stored rather than being blanked by omission. Erasing one is a
   * separate, explicit clearSecrets entry, which is what the two controls on
   * the row mean.
   */
  const buildPatch = (): Record<string, unknown> => {
    const patch: Record<string, unknown> = {};
    for (const key of dirty) {
      const def = fields[key];
      if (!def) continue;
      if (def.secret === true || secrets[key] !== undefined) {
        if (String(drafts[key] ?? '').length > 0) patch[key] = String(drafts[key]);
        continue;
      }
      const raw = drafts[key];
      patch[key] = def.type === 'boolean' ? raw === true : String(raw ?? '');
    }
    return patch;
  };

  /**
   * Write the changed rows.
   *
   * The response is only adopted when it is a whole category view. The security
   * writer answers with its own policy overview, whose `category` is a code
   * rather than the category object, and taking that as the new view would
   * replace the screen's category with a string.
   */
  const save = async () => {
    if (!category || !showsForm) return;
    const problems = validate();
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      setSaveError(null);
      return;
    }
    const changed = dirty.length;
    setErrors({});
    setSaveError(null);
    setSaved(null);
    setSaving(true);
    try {
      const payload = buildPatch();
      if (reason.trim() !== '') payload.reason = reason.trim();
      const clears = cleared.filter((k) => secrets[k] !== undefined || fields[k]?.secret === true);
      if (clears.length > 0) payload.clearSecrets = clears;

      const res = await api<{ data: CategoryView }>(BASE + '/category/' + category.id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      const next = res.data;
      if (kind === 'settings' && next && typeof next.category === 'object' && next.category !== null) {
        cache.current.set(category.id, next);
        setView(next);
      }
      setDrafts({});
      setCleared([]);
      setReason('');
      setSaved(
        'Saved ' +
          String(changed) +
          ' change' +
          (changed === 1 ? '' : 's') +
          '. Every one of them is in the audit trail.'
      );
      reload();
    } catch (e) {
      setSaveError(e);
      // A refusal the server names precisely belongs on the row it names, so
      // the message is not just a banner to be mapped back by hand.
      const text = messageOf(e);
      const hit = dirty.find(
        (k) => text.indexOf(fields[k]?.label ?? '\u0000') >= 0 || text.indexOf(k) >= 0
      );
      setErrors(hit ? { [hit]: text } : {});
    } finally {
      setSaving(false);
    }
  };

  /** Mandatory typed confirmation for the keys the server treats as dangerous. */
  const confirmWord = 'CONFIRM';

  const requestSave = () => {
    if (dirty.length === 0 || saving || !mayManage) return;
    if (touchedDangerous.length > 0) {
      setPending(touchedDangerous);
      setPendingText('');
      return;
    }
    void save();
  };
  // The catalogue publishes the permission this screen is read under, so the
  // refusal is stated once here rather than discovered one call at a time.
  const catalogueView = catalogue.data;

  if (catalogueView !== null && !mayView) {
    return (
      <div className="page">
        <div className="card">
          <div className="empty-state">
            <h3>Organisation settings</h3>
            <p>You do not have permission to view organisation settings.</p>
          </div>
        </div>
      </div>
    );
  }

  // Tile colour by catalogue group, so a category reads the same colour here as
  // it does in the module it configures.
  const TILE: Record<string, string> = {
    Organisation: 'tile-mill',
    Finance: 'tile-brass',
    People: 'tile-moss',
    Operations: 'tile-amber',
    Documents: 'tile-purple',
    Governance: 'tile-clay',
    Communication: 'tile-neutral',
    Integrations: 'tile-mill',
    System: 'tile-neutral',
  };

  const groupOf = (group: string) => TILE[group] ?? 'tile-neutral';

  const initialsOf = (label: string) => {
    const words = label
      .replace(/[^A-Za-z& ]/g, ' ')
      .split(' ')
      .filter((w) => w !== '' && w !== '&');
    return words
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join('');
  };

  const openCategory = (id: string) => navigate(SETTINGS_ROUTE + '/' + id);
  const canEdit = (c: Category) => can(user, c.manage);
  const grouped = catalogueView === null ? [] : groupCategories(catalogueView.groups, categories);
  const immutableKeys = catalogueView?.immutableKeys ?? [];

  // .result-row is a static information row elsewhere in the application; as a
  // search result it is a button, so it has to shed the user-agent chrome.
  const RESULT_BUTTON = {
    width: '100%',
    background: 'none',
    border: '0',
    borderBottom: '1px solid var(--line)',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
  } as const;

  // The generic form is the same object for every form-shaped kind, so it is
  // built once: the security policy nests its values one level deeper and the
  // hybrid categories bolt a records panel alongside, but the editor itself
  // does not change.
  const formCard =
    category === null ? null : (
      <div className="card card-pad">
        <SettingsForm
          category={category}
          values={values}
          secrets={secrets}
          drafts={drafts}
          dirty={dirty}
          errors={errors}
          disabled={!mayManage}
          immutableKeys={immutableKeys}
          clearedSecrets={cleared}
          onDraft={onDraft}
          onResetKey={onResetKey}
          onToggleClear={onToggleClear}
        />
      </div>
    );

  // One panel per kind. The two hybrids are a settings category with a records
  // panel bolted on, which is why they are keyed by id and not by kind alone.
  let panel: ReactNode = null;
  if (category !== null) {
    if (kind === 'structure') {
      panel = (
        <StructurePanel
          category={category}
          rows={arr(view?.list)}
          mayManage={mayManage}
          onChanged={reload}
        />
      );
    } else if (kind === 'tax') {
      panel = <TaxPanel mayManage={mayManage} onChanged={reload} />;
    } else if (kind === 'approvals') {
      panel = <ApprovalsPanel mayManage={mayManage} onChanged={reload} />;
    } else if (kind === 'signatures' && view !== null) {
      panel = <SignaturesPanel view={view} mayManage={mayManage} onChanged={reload} />;
    } else if (kind === 'integrations' && view !== null) {
      panel = <IntegrationsPanel view={view} mayManage={mayManage} onChanged={reload} />;
    } else if (kind === 'retention') {
      // The retention and backup writers own their own policy rows, and the
      // read for this kind returns those rows rather than per-key values, so
      // the panel is the whole screen.
      panel = <RetentionPanel mayManage={mayManage} onChanged={reload} />;
    } else if (kind === 'audit') {
      panel = <AuditPanel />;
    } else if (kind === 'security_policy') {
      panel = (
        <>
          {formCard}
          <SecurityPanel mayManage={mayManage} onChanged={reload} />
        </>
      );
    } else {
      panel = (
        <>
          {formCard}
          {activeId === 'fiscal' && overview !== null && (
            <FiscalPanel mayManage={mayManage} onChanged={reload} />
          )}
          {activeId === 'numbering' && overview !== null && (
            <NumberingPanel mayManage={mayManage} onChanged={reload} />
          )}
        </>
      );
    }
  }

  const landing = (
    <div className="stack">
      <div className="card card-pad">
        <div className="section-title">The control plane</div>
        <p className="muted" style={{ margin: 0, maxWidth: 760 }}>
          Configure the organisation once and let HR, payroll, finance, manufacturing, inventory,
          procurement, sales, the service desk, EQR traceability, EFRIS and security all read the
          same answer. Nothing is stored in the browser: a change is written to the database and
          takes effect in the module that consumes it without a deployment. Writes are gated per
          category, and every one of them lands on the audit trail with its before and after values.
        </p>
      </div>
      {grouped.map((entry) => (
        <div className="card card-pad" key={entry.group}>
          <div className="section-title">{entry.group}</div>
          <div className="grid-3">
            {entry.members.map((c) => (
              <button
                key={c.id}
                type="button"
                className="settings-nav-item"
                title={c.blurb}
                onClick={() => openCategory(c.id)}
              >
                <span className={'settings-nav-tile ' + groupOf(c.group)}>
                  {initialsOf(c.label)}
                </span>
                <span className="settings-nav-body">
                  <span className="settings-nav-label">{c.label}</span>
                  <span className="settings-nav-meta">
                    {canEdit(c) ? 'Manage' : 'View only'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
  return (
    <div className="page">
      <div className="crumbs">
        <button type="button" className="crumb-link" onClick={() => navigate('/admin')}>
          Administration
        </button>
        <span className="crumb-sep">/</span>
        <button type="button" className="crumb-link" onClick={() => navigate(SETTINGS_ROUTE)}>
          Organisation Settings
        </button>
        {activeId !== '' && category !== null && (
          <>
            <span className="crumb-sep">/</span>
            <span>{category.label}</span>
          </>
        )}
      </div>

      <header className="page-head">
        <div>
          <div className="mod-kicker" data-mod="adm">
            Administration
          </div>
          <h1>Organisation Settings</h1>
          <p className="muted" style={{ margin: '6px 0 0', maxWidth: 720 }}>
            {category === null
              ? 'Every category below drives a module. A change here is a change to how the ERP behaves.'
              : category.blurb}
          </p>
        </div>
        <div className="head-actions">
          {activeId !== '' && category !== null && (
            <button
              type="button"
              className="btn"
              onClick={() =>
                setHistory({ categoryId: activeId, key: null, title: category.label })
              }
            >
              History
            </button>
          )}
          {dirty.length > 0 && (
            <button type="button" className="btn" onClick={resetToDefaults}>
              Reset to default
            </button>
          )}
          {dirty.length > 0 && (
            <button type="button" className="btn" onClick={discard}>
              Discard
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || dirty.length === 0 || !mayManage}
            onClick={requestSave}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </header>

      <PanelError error={catalogue.error} />

      {catalogueView === null ? (
        <PageLoader />
      ) : (
        <>
          <div className="toolbar">
            <input
              className="search-input"
              value={query}
              aria-label="Search settings"
              placeholder="Search settings by category, key or label..."
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim().length > 0 && (
              <span className="muted">
                {hits.length} match{hits.length === 1 ? '' : 'es'}
              </span>
            )}
          </div>

          {hits.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              {hits.map((hit) => (
                <button
                  key={hit.categoryId + ':' + String(hit.key) + ':' + hit.label}
                  type="button"
                  className="result-row"
                  style={RESULT_BUTTON}
                  onClick={() => openCategory(hit.categoryId)}
                >
                  <span>
                    <strong>{hit.label}</strong>
                    {hit.key !== null && <span className="muted">{' ' + hit.key}</span>}
                  </span>
                  <span className="muted">
                    {hit.categoryLabel + ' - ' + titleCase(hit.kind)}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="settings-layout">
            <nav className="settings-nav" aria-label="Settings categories">
              <button
                type="button"
                className={'settings-nav-item' + (activeId === '' ? ' active' : '')}
                onClick={() => navigate(SETTINGS_ROUTE)}
              >
                <span className={'settings-nav-tile ' + groupOf('Organisation')}>OS</span>
                <span className="settings-nav-body">
                  <span className="settings-nav-label">Overview</span>
                  <span className="settings-nav-meta">All categories</span>
                </span>
              </button>

              {grouped.map((entry) => (
                <div key={entry.group}>
                  <div className="section-title">{entry.group}</div>
                  {entry.members.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={'settings-nav-item' + (c.id === activeId ? ' active' : '')}
                      title={c.blurb}
                      onClick={() => openCategory(c.id)}
                    >
                      <span className={'settings-nav-tile ' + groupOf(c.group)}>
                        {initialsOf(c.label)}
                      </span>
                      <span className="settings-nav-body">
                        <span className="settings-nav-label">{c.label}</span>
                        <span className="settings-nav-meta">
                          {canEdit(c) ? 'Manage' : 'View only'}
                        </span>
                      </span>
                      {c.id === activeId && dirty.length > 0 && (
                        <span className="settings-dot" title="Unsaved changes" />
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </nav>

            <div className="settings-main">
              <PanelError error={viewError} />
              {activeId === ''
                ? landing
                : viewLoading && view === null
                  ? <PageLoader />
                  : (
                    <div className="stack">{panel}</div>
                  )}
            </div>
          </div>

          <PanelNote error={saveError} ok={saved} />

          {showsForm && dirty.length > 0 && (
            <div className="settings-bar">
              <div className="muted">
                {'Unsaved changes: ' + String(dirty.length)}
              </div>
              <div style={{ flex: '1 1 320px', minWidth: 260 }}>
                <Reason
                  value={reason}
                  onChange={setReason}
                  label="Reason"
                  hint="Stored on every audit row this save writes."
                  disabled={!mayManage}
                />
              </div>
              <div className="head-actions">
                <button type="button" className="btn" onClick={discard}>
                  Discard
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving || !mayManage}
                  onClick={requestSave}
                >
                  {saving ? 'Saving...' : 'Save Changes (' + String(dirty.length) + ')'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {history !== null && (
        <HistoryModal
          categoryId={history.categoryId}
          settingKey={history.key}
          title={history.title}
          onClose={() => setHistory(null)}
        />
      )}

      {pending !== null && (
        <Modal
          title="Confirm a sensitive change"
          onClose={() => setPending(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={pendingText !== confirmWord || saving}
                onClick={() => {
                  setPending(null);
                  void save();
                }}
              >
                Apply and save
              </button>
            </>
          }
        >
          <div className="stack">
            <p style={{ margin: 0 }}>
              These settings change behaviour that the audit trail, the fiscal controls or the
              document lifecycle depend on. The change is written with its before and after values
              and cannot be revised quietly afterwards. Type the word below to apply it.
            </p>
            <dl className="def-list">
              {pending.map((k) => (
                <div key={k}>
                  <dt>{fields[k]?.label ?? k}</dt>
                  <dd>{k}</dd>
                </div>
              ))}
            </dl>
            <div style={{ maxWidth: 320 }}>
              <Field label={'Type ' + confirmWord + ' to confirm'}>
                <FieldInput
                  type="text"
                  value={pendingText}
                  placeholder={confirmWord}
                  disabled={saving}
                  onChange={(v) => setPendingText(String(v))}
                />
              </Field>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
export default OrganisationSettings;
