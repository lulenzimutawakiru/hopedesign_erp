import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { navigate, useHashQuery } from '../../router';
import { ErrorBanner, Modal, Pager, Spinner } from '../../components/ui';
import { useAuth } from '../../auth';
import { Field, FormErr, Inp, Sel, Txa } from '../hikvision/fields';
import { qs } from '../hikvision/hkutil';
import {
  EmptyRow,
  KpiRow,
  KpiTile,
  Nothing,
  PriorityChip,
  SdHead,
  SdTabs,
  SecCard,
  dash,
  fmtAgo,
  fmtDT,
  label,
  modStyle,
  num,
  s,
  sdApi,
  sdErr,
  sdPatch,
  sdPost,
  type Rec,
} from '../serviceDeskShared';

/* ------------------------------------------------------------------ *
 * Access requests (spec 15)
 *
 * EMPLOYEE -> REQUEST ACCESS -> MANAGER APPROVAL -> SYSTEM / DATA OWNER
 * APPROVAL -> RBAC ROLE ASSIGNMENT -> ABAC SCOPE CONFIGURATION ->
 * ACCESS GRANTED -> AUDIT
 *
 * The Service Desk never hands out access on its own. The approval chain the
 * policy demands must be satisfied before the grant step becomes available, and
 * the grant itself is a separate act from approving.
 * ------------------------------------------------------------------ */

const ACCESS_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'MANAGER_APPROVED',
  'OWNER_APPROVED',
  'APPROVED',
  'REJECTED',
  'PROVISIONING',
  'GRANTED',
  'PROVISION_FAILED',
  'EXPIRED',
  'REVOKED',
  'CANCELLED',
];

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  MANAGER_APPROVED: 'approved',
  OWNER_APPROVED: 'approved',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PROVISIONING: 'progress',
  GRANTED: 'granted',
  PROVISION_FAILED: 'failed',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  CANCELLED: 'cancelled',
};

const ACCESS_TYPES = [
  'ROLE',
  'PERMISSION',
  'MODULE',
  'DATA_SCOPE',
  'SHARED_MAILBOX',
  'VPN',
  'FOLDER',
  'DATABASE',
  'OTHER',
];

const TYPE_TONE: Record<string, string> = {
  ROLE: 'role',
  PERMISSION: 'permission',
  MODULE: 'module',
  DATA_SCOPE: 'data',
  SHARED_MAILBOX: 'mailbox',
  VPN: 'vpn',
  FOLDER: 'folder',
  DATABASE: 'database',
  OTHER: 'other',
};

const TYPE_LABEL: Record<string, string> = {
  ROLE: 'RBAC role',
  PERMISSION: 'Granular permission',
  MODULE: 'Module access',
  DATA_SCOPE: 'Data scope',
  SHARED_MAILBOX: 'Shared mailbox',
  VPN: 'VPN / remote access',
  FOLDER: 'File share folder',
  DATABASE: 'Database',
  OTHER: 'Other',
};

const DURATIONS = ['PERMANENT', 'TEMPORARY', 'DATE_BOUNDED'];
const DURATION_LABEL: Record<string, string> = {
  PERMANENT: 'Permanent',
  TEMPORARY: 'Temporary',
  DATE_BOUNDED: 'Date-bounded',
};

const ACCESS_STEPS = ['MANAGER', 'SYSTEM_OWNER', 'DATA_OWNER', 'SECURITY', 'ADMIN'];
const STEP_LABEL: Record<string, string> = {
  MANAGER: 'Manager approval',
  SYSTEM_OWNER: 'System owner approval',
  DATA_OWNER: 'Data owner approval',
  SECURITY: 'Security review',
  ADMIN: 'Administrator sign-off',
};

const APPROVAL_STATUS_TONE: Record<string, string> = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  DELEGATED: 'delegated',
  SKIPPED: 'skipped',
};

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const RISK_TONE: Record<string, string> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
const CLASSIFICATION_TONE: Record<string, string> = {
  PUBLIC: 'public',
  INTERNAL: 'internal',
  CONFIDENTIAL: 'confidential',
  RESTRICTED: 'restricted',
};

const ACCESS_SORTS: Array<[string, string]> = [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['expiry', 'Expiry date'],
  ['risk', 'Highest risk'],
  ['number', 'Request number'],
];

/** RBAC types carry a role or permission, so the desk adds an admin sign-off. */
const RBAC_TYPES = ['ROLE', 'PERMISSION', 'MODULE'];
/** These reach data, so the data owner has to be in the chain. */
const DATA_TYPES = ['DATA_SCOPE', 'DATABASE', 'FOLDER'];

const TERMINAL_STATUSES = [
  'REJECTED',
  'GRANTED',
  'PROVISION_FAILED',
  'EXPIRED',
  'REVOKED',
  'CANCELLED',
];

const ACCESS_FLOW: Array<[string, string]> = [
  ['EMPLOYEE', 'Employee'],
  ['REQUEST', 'Request raised'],
  ['MANAGER', 'Manager approval'],
  ['OWNER', 'System / data owner'],
  ['RBAC', 'RBAC role assignment'],
  ['ABAC', 'ABAC scope configuration'],
  ['GRANTED', 'Access granted'],
  ['AUDIT', 'Audit record'],
];

function flowDone(status: string): number {
  switch (status) {
    case 'DRAFT':
      return 1;
    case 'SUBMITTED':
      return 2;
    case 'MANAGER_APPROVED':
      return 3;
    case 'OWNER_APPROVED':
      return 4;
    case 'APPROVED':
    case 'PROVISIONING':
    case 'PROVISION_FAILED':
      return 5;
    case 'GRANTED':
    case 'EXPIRED':
    case 'REVOKED':
      return 8;
    case 'REJECTED':
      return 2;
    case 'CANCELLED':
      return 1;
    default:
      return 1;
  }
}

export function AccessChip({ tone, children, title }: { tone: string; children: string; title?: string }) {
  return (
    <span className={'sd-chip sd-chip-' + tone} title={title}>
      {children}
    </span>
  );
}

export function AccessStatusChip({ value }: { value: unknown }) {
  const code = s(value).toUpperCase();
  return <AccessChip tone={STATUS_TONE[code] ?? 'unknown'}>{code ? label(code) : 'Unknown'}</AccessChip>;
}

export function AccessTypeChip({ value }: { value: unknown }) {
  const code = s(value).toUpperCase();
  const text = TYPE_LABEL[code] ?? (code ? label(code) : 'Unknown');
  return (
    <AccessChip tone={TYPE_TONE[code] ?? 'unknown'} title={code}>
      {text}
    </AccessChip>
  );
}

export function AccessRiskChip({ value }: { value: unknown }) {
  const code = s(value).toUpperCase();
  if (!code) return <span className="muted">Not set</span>;
  return <AccessChip tone={RISK_TONE[code] ?? 'unknown'}>{code}</AccessChip>;
}

export function AccessClassChip({ value }: { value: unknown }) {
  const code = s(value).toUpperCase();
  return <AccessChip tone={CLASSIFICATION_TONE[code] ?? 'unknown'}>{code}</AccessChip>;
}

export function AccessApprovalChip({ value }: { value: unknown }) {
  const code = s(value).toUpperCase();
  return <AccessChip tone={APPROVAL_STATUS_TONE[code] ?? 'unknown'}>{code ? label(code) : 'Unknown'}</AccessChip>;
}

export function AccessRefCell({ row }: { row: Rec }) {
  const ref = s(row.request_number) || s(row.id);
  const open = !TERMINAL_STATUSES.includes(s(row.status).toUpperCase());
  return (
    <div className="sd-ref-cell">
      <b className="td-cell-mono">{dash(ref)}</b>
      <span className="sub muted">{open ? 'In workflow' : 'Settled'}</span>
    </div>
  );
}

/** The eight-step authorisation path, rendered as a status strip. */
export function AccessFlowStrip({ status }: { status: unknown }) {
  const code = s(status).toUpperCase();
  const done = flowDone(code);
  const stopped = code === 'REJECTED' || code === 'CANCELLED';
  return (
    <div className="sd-wf-card">
      {ACCESS_FLOW.map(([key, text], i) => {
        const state = i < done ? 'done' : i === done ? 'on' : '';
        return (
          <span key={key} className={'sd-wf-cell ' + state + (stopped && i >= done ? ' sd-wf-off' : '')}>
            <b className="sd-wf-num">{i + 1}</b>
            <span>{text}</span>
          </span>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function refOf(row: Rec | null | undefined): string {
  if (!row) return '';
  return s(row.request_number) || s(row.id);
}

function openAccess(row: Rec): void {
  navigate('/service-desk/access?ref=' + encodeURIComponent(refOf(row)));
}

function accessHref(row: Rec): string {
  return '/service-desk/access?ref=' + encodeURIComponent(refOf(row));
}

function parseJson(v: unknown): Rec {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Rec;
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Rec;
    } catch {
      return {};
    }
  }
  return {};
}

function listOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => s(x)).filter(Boolean);
  const text = s(v);
  if (!text) return [];
  return text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function isoFromInput(v: string): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function toLocalInput(v: unknown): string {
  const text = s(v);
  if (!text) return '';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  );
}

function isTerminal(status: unknown): boolean {
  return TERMINAL_STATUSES.includes(s(status).toUpperCase());
}

function isPending(status: unknown): boolean {
  return !isTerminal(s(status));
}

function daysBetween(from: unknown, to: unknown): number | null {
  const a = s(from);
  const b = s(to);
  if (!a || !b) return null;
  const t1 = new Date(a).getTime();
  const t2 = new Date(b).getTime();
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  return Math.round((t2 - t1) / 86400000);
}

function expiryNote(row: Rec): { text: string; tone: string } | null {
  const at = s(row.access_expires_at);
  if (!at) return null;
  const left = daysBetween(new Date().toISOString(), at);
  if (left === null) return null;
  if (left < 0) return { text: 'Expired ' + Math.abs(left) + ' day(s) ago', tone: 'expired' };
  if (left <= 7) return { text: 'Expires in ' + left + ' day(s)', tone: 'due' };
  return { text: 'Expires ' + at.slice(0, 10), tone: 'ok' };
}

/* ------------------------------------------------------------------ *
 * Register table
 * ------------------------------------------------------------------ */

const ACCESS_COLS: Array<{ key: string; label: string; width?: number; render: (r: Rec) => ReactNode }> = [
  {
    key: 'request',
    label: 'Request',
    width: 170,
    render: (r) => <AccessRefCell row={r} />,
  },
  {
    key: 'system',
    label: 'System / service',
    render: (r) => (
      <div className="sd-subj-cell">
        <span className="sd-subj">{dash(r.system_name)}</span>
        <span className="sub muted">{dash(r.ticket_number)}</span>
      </div>
    ),
  },
  {
    key: 'type',
    label: 'Access asked for',
    width: 190,
    render: (r) => <AccessTypeChip value={r.access_type} />,
  },
  {
    key: 'risk',
    label: 'Risk',
    width: 100,
    render: (r) => <AccessRiskChip value={r.risk_level} />,
  },
  {
    key: 'approval',
    label: 'Authorisation',
    width: 190,
    render: (r) => {
      const pendingCount = num(r.pending_approvals);
      const step = s(r.next_step);
      if (pendingCount <= 0) return <span className="muted">No open step</span>;
      return (
        <div className="sd-subj-cell">
          <span className="sd-subj">{pendingCount + ' step(s) pending'}</span>
          <span className="sub muted">{STEP_LABEL[step] ?? step}</span>
        </div>
      );
    },
  },
  {
    key: 'requester',
    label: 'Requester',
    width: 170,
    render: (r) => (
      <div className="sd-subj-cell">
        <span>{dash(r.requester_name)}</span>
        <span className="sub muted">{dash(r.requester_employee_no)}</span>
      </div>
    ),
  },
  {
    key: 'status',
    label: 'Status',
    width: 140,
    render: (r) => <AccessStatusChip value={r.status} />,
  },
  {
    key: 'raised',
    label: 'Raised',
    width: 110,
    render: (r) => <span className="muted">{fmtAgo(r.created_at)}</span>,
  },
];

function AccessTable({ rows, empty }: { rows: Rec[]; empty?: ReactNode }) {
  return (
    <div className="table-wrap">
      <table className="table sd-access-table">
        <thead>
          <tr>
            {ACCESS_COLS.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width } : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={ACCESS_COLS.length}>{empty ?? 'No access requests match these filters.'}</EmptyRow>}
          {rows.map((r) => (
            <tr
              key={s(r.id)}
              className="sd-row"
              onClick={() => openAccess(r)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openAccess(r);
                }
              }}
            >
              {ACCESS_COLS.map((c) => (
                <td key={c.key}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
/* ------------------------------------------------------------------ *
 * Overview widgets
 * ------------------------------------------------------------------ */

/** A short list of requests that opens the request itself. */
function AccessLinkList({ rows, empty }: { rows: Rec[]; empty: string }) {
  if (rows.length === 0) return <Nothing text={empty} />;
  return (
    <ul className="sd-link-list">
      {rows.map((r) => (
        <li key={s(r.id)} className="sd-link-row">
          <a className="sd-link" href={'#' + accessHref(r)}>
            <b className="td-cell-mono">{dash(refOf(r))}</b>
            <span className="sub muted sd-link-sub">{dash(r.system_name)}</span>
          </a>
          <AccessStatusChip value={r.status} />
        </li>
      ))}
    </ul>
  );
}

/** Horizontal bar breakdown of a dashboard aggregate. */
function AccessBars({ rows, keyName, empty }: { rows: Rec[]; keyName: string; empty: string }) {
  const max = rows.reduce((m, r) => Math.max(m, num(r.count)), 0);
  if (rows.length === 0 || max <= 0) return <Nothing text={empty} />;
  return (
    <div className="mini-bars">
      {rows.map((r) => {
        const code = s(r[keyName]);
        const n = num(r.count);
        return (
          <div className="mini-bar" key={code || 'unset'}>
            <span className="mini-bar-label" title={code}>
              {code ? label(code) : 'Not set'}
            </span>
            <span className="mini-bar-track">
              <span className="mini-bar-fill" style={{ width: Math.round((n / max) * 100) + '%' }} />
            </span>
            <span className="mini-bar-value">{n}</span>
          </div>
        );
      })}
    </div>
  );
}

function asRows(v: unknown): Rec[] {
  return Array.isArray(v) ? (v as Rec[]) : [];
}

/**
 * Access overview. The Service Desk only ever shows the workflow; the grant
 * itself sits behind the authorisation chain shown on each request.
 */
export function AccessOverview({ dashboard }: { dashboard: Rec | null }) {
  if (!dashboard) return null;
  const scope: Rec = (dashboard.scope as Rec) ?? {};
  return (
    <div className="sd-two-col">
      <SecCard
        title="My access requests"
        sub="Requests I raised, requested for me, or that target my account."
        pad
      >
        <AccessLinkList rows={asRows(dashboard.myRequests)} empty="You have no access requests." />
      </SecCard>

      <SecCard title="Latest activity" sub="The ten most recent access requests in this company." pad>
        <AccessLinkList rows={asRows(dashboard.recent)} empty="No access requests have been raised yet." />
      </SecCard>

      <SecCard title="By status" sub="Where every access request currently sits in the workflow." pad>
        <AccessBars rows={asRows(dashboard.byStatus)} keyName="status" empty="No status data yet." />
      </SecCard>

      <SecCard title="By risk" sub="Risk is derived from access type, classification and duration." pad>
        <AccessBars rows={asRows(dashboard.byRisk)} keyName="risk_level" empty="No risk data yet." />
      </SecCard>

      <SecCard title="By access type" sub="What people are asking for across the organisation." pad>
        <AccessBars rows={asRows(dashboard.byType)} keyName="access_type" empty="No access type data yet." />
      </SecCard>

      <SecCard title="Authorisation policy" sub="How this workspace is allowed to act." pad>
        <ul className="sd-facts">
          <li className="sd-fact">
            <span className="sd-fact-k">Can review requests</span>
            <span className="sd-fact-v">{scope.canView ? 'Yes' : 'No'}</span>
          </li>
          <li className="sd-fact">
            <span className="sd-fact-k">Can raise requests</span>
            <span className="sd-fact-v">{scope.canCreate ? 'Yes' : 'No'}</span>
          </li>
          <li className="sd-fact">
            <span className="sd-fact-k">Can decide approvals</span>
            <span className="sd-fact-v">{scope.canApprove ? 'Yes' : 'No'}</span>
          </li>
          <li className="sd-fact">
            <span className="sd-fact-k">Can provision access</span>
            <span className="sd-fact-v">{scope.canGrant ? 'Yes' : 'No'}</span>
          </li>
          <li className="sd-fact">
            <span className="sd-fact-k">Can revoke access</span>
            <span className="sd-fact-v">{scope.canRevoke ? 'Yes' : 'No'}</span>
          </li>
          <li className="sd-fact">
            <span className="sd-fact-k">Expiring within 7 days</span>
            <span className="sd-fact-v">{num(dashboard.expiringWithinSevenDays)}</span>
          </li>
        </ul>
        <p className="muted sd-subnote">
          Approving a request is separate from provisioning it. Access is recorded only at the grant step, and only once
          every step the policy requires has been approved.
        </p>
      </SecCard>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Register
 * ------------------------------------------------------------------ */

const ACCESS_SCOPE_MODES: Array<[string, string]> = [
  ['', 'All requests in scope'],
  ['pending', 'Awaiting my approval'],
  ['provision', 'Approved, awaiting provisioning'],
  ['mine', 'Raised by me'],
];

/**
 * Access request register.
 *
 * The three workflow queues (my approval, awaiting provisioning, mine) are the
 * ones an approver actually works from, so they get their own browser state.
 */
export function AccessList({
  canCreate,
  dashboard,
  selfService,
}: {
  canCreate: boolean;
  dashboard: Rec | null;
  selfService?: boolean;
}) {
  const q = useHashQuery();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(num(q.get('pageSize')) || 25);
  const [status, setStatus] = useState(s(q.get('status')));
  const [accessType, setAccessType] = useState(s(q.get('accessType')));
  const [risk, setRisk] = useState(s(q.get('riskLevel')));
  const [scopeMode, setScopeMode] = useState(s(q.get('scope')));
  const [sortBy, setSortBy] = useState(s(q.get('sortBy')) || 'newest');
  const [search, setSearch] = useState(s(q.get('search')));
  const [term, setTerm] = useState(s(q.get('search')));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    sdApi<{ items: Rec[]; total: number }>(
      (selfService ? '/api/my/service-desk/access-requests' : '/api/service-desk/access-requests') +
        qs({
          page,
          pageSize,
          status,
          accessType,
          riskLevel: risk,
          pendingMyApproval: scopeMode === 'pending' ? 'true' : '',
          awaitingProvisioning: scopeMode === 'provision' ? 'true' : '',
          mine: scopeMode === 'mine' ? 'true' : '',
          sortBy,
          search,
        })
    )
      .then((r) => {
        setRows(Array.isArray(r.items) ? r.items : []);
        setTotal(num(r.total));
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [page, pageSize, status, accessType, risk, scopeMode, sortBy, search, selfService]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setPage(1);
      setSearch(term.trim());
    }, 350);
    return () => window.clearTimeout(t);
  }, [term]);

  const reset = (apply: () => void) => {
    setPage(1);
    apply();
  };

  return (
    <div className="sd-stack">
      <SecCard
        title="Access request register"
        sub="Role, permission and data access: requested, authorised, provisioned, then audited."
        pad
        actions={
          <>
            {num(dashboard?.awaitingMyApproval) > 0 ? (
              <button
                className="btn btn-sm"
                onClick={() =>
                  reset(() => {
                    setScopeMode('pending');
                    setStatus('');
                  })
                }
              >
                {num(dashboard?.awaitingMyApproval)} awaiting my approval
              </button>
            ) : null}
            {canCreate ? (
              <button className="btn btn-primary btn-sm" onClick={() => navigate('/service-desk/access?new=1')}>
                + New access request
              </button>
            ) : null}
          </>
        }
      >
        <div className="filter-bar sd-filter-bar">
          <Field label="Search">
            <Inp value={term} onChange={setTerm} placeholder="Request number, system or justification" />
          </Field>
          <Field label="Authorisation">
            <Sel
              value={status}
              onChange={(v) => reset(() => setStatus(v))}
              options={ACCESS_STATUSES.map((code) => ({ value: code, label: label(code) }))}
              placeholder="Any status"
            />
          </Field>
          <Field label="Access type">
            <Sel
              value={accessType}
              onChange={(v) => reset(() => setAccessType(v))}
              options={ACCESS_TYPES.map((code) => ({ value: code, label: TYPE_LABEL[code] ?? label(code) }))}
              placeholder="Any access type"
            />
          </Field>
          <Field label="Risk">
            <Sel
              value={risk}
              onChange={(v) => reset(() => setRisk(v))}
              options={RISK_LEVELS.map((code) => ({ value: code, label: code }))}
              placeholder="Any risk level"
            />
          </Field>
          {selfService ? null : (
            <Field label="Queue">
              <Sel
                value={scopeMode}
                onChange={(v) => reset(() => setScopeMode(v))}
                options={ACCESS_SCOPE_MODES.map(([value, lab]) => ({ value, label: lab }))}
              />
            </Field>
          )}
          <Field label="Order">
            <Sel value={sortBy} onChange={setSortBy} options={ACCESS_SORTS.map(([value, lab]) => ({ value, label: lab }))} />
          </Field>
        </div>
      </SecCard>

      <SecCard title="Access requests" sub={total + ' record(s) in scope'}>
        {error ? (
          <div className="card-pad">
            <ErrorBanner error={error} />
          </div>
        ) : null}
        {loading ? (
          <div className="card-pad">
            <Spinner />
          </div>
        ) : (
          <AccessTable rows={rows} />
        )}
        {total > pageSize ? (
          <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} />
        ) : null}
      </SecCard>
    </div>
  );
}
/* ------------------------------------------------------------------ *
 * Detail
 * ------------------------------------------------------------------ */

function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <ul className="sd-facts">
      {items.map(([k, v]) => (
        <li className="sd-fact" key={k}>
          <span className="sd-fact-k">{k}</span>
          <span className="sd-fact-v">{v}</span>
        </li>
      ))}
    </ul>
  );
}

function ChipList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span className="muted">{empty}</span>;
  return (
    <div className="chips">
      {items.map((x) => (
        <span className="chip" key={x}>
          {x}
        </span>
      ))}
    </div>
  );
}

/**
 * One access request, end to end.
 *
 * Read this top to bottom and the spec 15 path is visible: what was asked for,
 * who has signed it off, and whether the grant has actually been recorded.
 */
export function AccessDetail({ requestRef, selfService }: { requestRef: string; selfService?: boolean }) {
  const [detail, setDetail] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [dlg, setDlg] = useState('');
  const [approval, setApproval] = useState<Rec | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    sdApi<Rec>(
      (selfService ? '/api/my/service-desk/access-requests/' : '/api/service-desk/access-requests/') +
        encodeURIComponent(requestRef)
    )
      .then((r) => setDetail(r ?? null))
      .catch(setError)
      .finally(() => setLoading(false));
  }, [requestRef]);

  useEffect(() => void load(), [load]);

  const close = () => {
    setDlg('');
    setApproval(null);
  };
  const saved = () => {
    close();
    load();
  };

  if (loading && !detail) {
    return (
      <div className="card card-pad">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <div className="card card-pad">
        <ErrorBanner error={error} />
        <div className="sd-card-actions">
          <button className="btn btn-sm" onClick={() => navigate('/service-desk/access')}>
            Back to the register
          </button>
        </div>
      </div>
    );
  }
  if (!detail) return <Nothing text="That access request could not be found." />;

  const req: Rec = (detail.request as Rec) ?? {};
  const approvals = asRows(detail.approvals);
  const perms: Rec = (detail.permissions as Rec) ?? {};
  const code = s(req.status).toUpperCase();
  const permissions = listOf(req.requested_permissions);
  const scope = parseJson(req.requested_scope);
  const scopeKeys = Object.keys(scope);
  const expiry = expiryNote(req);
  const open = isPending(code);
  const pendingApprovals = approvals.filter((a) => s(a.status).toUpperCase() === 'PENDING');
  const mine = approvals.filter((a) => s(a.status).toUpperCase() === 'PENDING' && num(a.approver_user_id) > 0);

  return (
    <div className="sd-stack">
      <SecCard
        title={'Request ' + dash(refOf(req))}
        sub={dash(req.system_name) + ' - ' + (TYPE_LABEL[s(req.access_type).toUpperCase()] ?? dash(req.access_type))}
        actions={
          <>
            <button className="btn btn-sm" onClick={() => navigate('/service-desk/access')}>
              Back to register
            </button>
            {perms.canUpdate ? (
              <button className="btn btn-sm" onClick={() => setDlg('edit')}>
                Edit draft
              </button>
            ) : null}
            {req.status === 'DRAFT' ? (
              <button className="btn btn-primary btn-sm" onClick={() => setDlg('submit')}>
                Submit for authorisation
              </button>
            ) : null}
            {perms.canApprove ? (
              <button className="btn btn-primary btn-sm" onClick={() => setDlg('decide')}>
                Record decision
              </button>
            ) : null}
            {perms.canGrant ? (
              <button className="btn btn-primary btn-sm" onClick={() => setDlg('grant')}>
                Provision access
              </button>
            ) : null}
            {perms.canGrant && (req.status === 'PROVISIONING' || req.status === 'PROVISION_FAILED') ? (
              <button className="btn btn-sm sd-danger" onClick={() => setDlg('fail')}>
                Report provisioning failure
              </button>
            ) : null}
            {perms.canRevoke ? (
              <button className="btn btn-sm sd-danger" onClick={() => setDlg('revoke')}>
                Revoke access
              </button>
            ) : null}
            {perms.canCancel && open ? (
              <button className="btn btn-sm" onClick={() => setDlg('cancel')}>
                Cancel request
              </button>
            ) : null}
          </>
        }
      >
        <AccessFlowStrip status={req.status} />
      </SecCard>

      <KpiRow>
        <KpiTile label="Authorisation status" value={<AccessStatusChip value={req.status} />} sub={STEP_LABEL[s(req.current_step)] ?? 'Workflow complete'} />
        <KpiTile label="Risk" value={<AccessRiskChip value={req.risk_level} />} sub={DURATION_LABEL[s(req.duration).toUpperCase()] ?? dash(req.duration)} />
        <KpiTile label="Classification" value={<AccessClassChip value={req.data_classification} />} sub="Data sensitivity" />
        <KpiTile
          label="Open authorisations"
          value={pendingApprovals.length}
          sub={pendingApprovals.length === 0 ? 'Chain settled' : 'Steps still to decide'}
        />
        <KpiTile
          label="Access window"
          value={expiry ? expiry.text : 'No expiry'}
          sub={s(req.access_starts_at) ? 'Starts ' + fmtDT(req.access_starts_at) : 'Immediate'}
        />
      </KpiRow>

      <div className="sd-two-col">
        <SecCard title="Request" sub="Who asked, for what system, and where it came from." pad>
          <Facts
            items={[
              ['Request number', <b className="td-cell-mono">{dash(refOf(req))}</b>],
              [
                'Service ticket',
                num(req.ticket_id) > 0 ? (
                  <a className="link-btn" href={'#/service-desk/t/' + s(req.ticket_id)}>
                    {dash(req.ticket_number)}
                  </a>
                ) : (
                  <span className="muted">Not linked</span>
                ),
              ],
              ['Requester', dash(req.requester_name) + (s(req.requester_employee_no) ? ' (' + s(req.requester_employee_no) + ')' : '')],
              ['Department', dash(req.requester_department_name)],
              ['Access for', num(req.target_user_id) > 0 ? dash(req.target_name) : 'The requester'],
              ['Raised by', dash(req.created_by_name)],
              ['Raised at', fmtDT(req.created_at)],
              ['Last updated', fmtDT(req.updated_at)],
            ]}
          />
        </SecCard>

        <SecCard title="What is being requested" sub="The role, permission or scope that would be handed over." pad>
          <Facts
            items={[
              ['Access type', <AccessTypeChip value={req.access_type} />],
              ['System / service', dash(req.system_name)],
              ['Requested role code', req.requested_role_code ? <code className="td-cell-mono">{s(req.requested_role_code)}</code> : <span className="muted">Not a role request</span>],
              ['Duration', DURATION_LABEL[s(req.duration).toUpperCase()] ?? dash(req.duration)],
              ['Starts', s(req.access_starts_at) ? fmtDT(req.access_starts_at) : 'On grant'],
              ['Expires', s(req.access_expires_at) ? fmtDT(req.access_expires_at) : 'Never'],
              ['Manager sign-off required', req.manager_approval_required ? 'Yes' : 'No'],
              ['Owner sign-off required', req.owner_approval_required ? 'Yes' : 'No'],
            ]}
          />
          <div className="sd-sub-head">Requested permissions</div>
          <ChipList items={permissions} empty="No individual permissions were listed." />
          <div className="sd-sub-head">Requested ABAC scope</div>
          {scopeKeys.length === 0 ? (
            <span className="muted">No scope was requested; the workflow default applies.</span>
          ) : (
            <pre className="sd-pre">{JSON.stringify(scope, null, 2)}</pre>
          )}
        </SecCard>
      </div>

      <SecCard title="Justification" sub="The business reason recorded by the requester." pad>
        <p className="sd-body-text">{s(req.justification) || 'No justification was recorded.'}</p>
        {s(req.ticket_description) ? (
          <>
            <div className="sd-sub-head">Ticket description</div>
            <p className="sd-body-text">{s(req.ticket_description)}</p>
          </>
        ) : null}
      </SecCard>

      <SecCard
        title="Authorisation chain"
        sub="No access is provisioned until every step below reads APPROVED."
      >
        <div className="table-wrap">
          <table className="table sd-approvals">
            <thead>
              <tr>
                <th style={{ width: 56 }}>Seq</th>
                <th style={{ width: 190 }}>Step</th>
                <th>Approver</th>
                <th style={{ width: 150 }}>Status</th>
                <th style={{ width: 160 }}>Decided</th>
                <th>Comments</th>
                <th style={{ width: 130 }} />
              </tr>
            </thead>
            <tbody>
              {approvals.length === 0 && (
                <EmptyRow cols={7}>
                  <Nothing text="This request has no authorisation chain yet. Submit it to build the chain the policy requires." />
                </EmptyRow>
              )}
              {approvals.map((a) => {
                const st = s(a.status).toUpperCase();
                const step = s(a.step).toUpperCase();
                const approver = s(a.approver_name) || s(a.approver_employee_name);
                const canDecideThis = st === 'PENDING' && (num(a.approver_user_id) === 0 || !!perms.canApprove);
                return (
                  <tr key={s(a.id)} className={st === 'PENDING' ? 'sd-approval is-pending' : 'sd-approval'}>
                    <td>
                      <b className="sd-approval-seq">{num(a.seq)}</b>
                    </td>
                    <td>
                      <div className="sd-approval-head">
                        <span>{STEP_LABEL[step] ?? label(step)}</span>
                        {s(a.approver_role) ? <span className="sub muted">{s(a.approver_role)}</span> : null}
                      </div>
                    </td>
                    <td className="muted">{approver || 'Not yet assigned'}</td>
                    <td>
                      <AccessApprovalChip value={a.status} />
                    </td>
                    <td className="muted">{a.decided_at ? fmtDT(a.decided_at) : '-'}</td>
                    <td>
                      {s(a.comments) ? <span className="sd-approval-note">{s(a.comments)}</span> : <span className="muted">-</span>}
                    </td>
                    <td>
                      {canDecideThis ? (
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            setApproval(a);
                            setDlg('decide');
                          }}
                        >
                          Decide
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {mine.length > 0 ? (
          <div className="card-pad muted sd-subnote">
            {mine.length} step(s) are waiting on you. Decide them before the request can be provisioned.
          </div>
        ) : null}
      </SecCard>

      <div className="sd-two-col">
        <SecCard title="Provisioning" sub="Where the access actually gets recorded." pad>
          <Facts
            items={[
              ['Granted role', s(req.granted_role_name) ? dash(req.granted_role_name) + (s(req.granted_role_code) ? ' (' + s(req.granted_role_code) + ')' : '') : <span className="muted">Nothing granted yet</span>],
              ['Provisioned by', s(req.granted_by_name) ? dash(req.granted_by_name) : <span className="muted">-</span>],
              ['Provisioned at', req.granted_at ? fmtDT(req.granted_at) : <span className="muted">-</span>],
              ['Revoked by', s(req.revoked_by_name) ? dash(req.revoked_by_name) : <span className="muted">-</span>],
              ['Revoked at', req.revoked_at ? fmtDT(req.revoked_at) : <span className="muted">-</span>],
              ['Revocation reason', s(req.revocation_reason) || <span className="muted">-</span>],
            ]}
          />
          {req.status === 'PROVISION_FAILED' ? (
            <p className="sd-form-error" role="alert">
              Provisioning failed. The access was never recorded, so it must be re-attempted or the request cancelled.
            </p>
          ) : null}
        </SecCard>

        <SecCard title="Access granted to" sub="Confirmed against the identity record." pad>
          <Facts
            items={[
              ['Target account', num(req.target_user_id) > 0 ? dash(req.target_name) : dash(req.requester_name)],
              ['Target email', s(req.target_email) ? dash(req.target_email) : dash(req.requester_email)],
              ['Requester email', dash(req.requester_email)],
              ['Current ticket status', dash(req.ticket_status)],
              ['Ticket priority', num(req.priority) > 0 ? <PriorityChip value={req.priority} compact /> : <span className="muted">-</span>],
            ]}
          />
        </SecCard>
      </div>

      {dlg === 'edit' ? <AccessEditDlg request={req} onClose={close} onSaved={saved} /> : null}
      {dlg === 'submit' ? <AccessSubmitDlg request={req} onClose={close} onSaved={saved} /> : null}
      {dlg === 'decide' ? (
        <AccessDecideDlg
          request={req}
          approval={approval ?? mine[0] ?? pendingApprovals[0] ?? null}
          approvals={pendingApprovals}
          onClose={close}
          onSaved={saved}
        />
      ) : null}
      {dlg === 'grant' ? <AccessGrantDlg request={req} onClose={close} onSaved={saved} /> : null}
      {dlg === 'revoke' ? <AccessRevokeDlg request={req} onClose={close} onSaved={saved} /> : null}
      {dlg === 'fail' ? <AccessFailProvisionDlg request={req} onClose={close} onSaved={saved} /> : null}
      {dlg === 'cancel' ? (
        <AccessCancelDlg request={req} selfService={selfService} onClose={close} onSaved={saved} />
      ) : null}
    </div>
  );
}
/* ------------------------------------------------------------------ *
 * Action dialogs
 *
 * Each dialog performs exactly one act. None of them decides on its own
 * whether the act is permitted: the server re-checks the permission, the
 * workflow state and segregation of duties on every call and refuses when the
 * client is out of date.
 * ------------------------------------------------------------------ */

type AccDlgProps = { request: Rec; onClose: () => void; onSaved: () => void };

const YES_NO: Array<{ value: string; label: string }> = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

const STEP_RANK: Record<string, number> = {};
ACCESS_STEPS.forEach((step, i) => {
  STEP_RANK[step] = i;
});

/** The authorisation chain policy will build, so the requester can see it. */
function suggestedChain(row: Rec): string[] {
  const chain: string[] = [];
  const accessType = s(row.access_type).toUpperCase() || 'ROLE';
  if (row.manager_approval_required) chain.push('MANAGER');
  if (row.owner_approval_required) {
    chain.push(DATA_TYPES.includes(accessType) ? 'DATA_OWNER' : 'SYSTEM_OWNER');
  }
  if (RBAC_TYPES.includes(accessType)) chain.push('ADMIN');
  const risk = s(row.risk_level).toUpperCase();
  const cls = s(row.data_classification).toUpperCase();
  if (risk === 'HIGH' || risk === 'CRITICAL' || cls === 'CONFIDENTIAL' || cls === 'RESTRICTED') {
    chain.push('SECURITY');
  }
  return chain;
}

function ChainPreview({ steps }: { steps: string[] }) {
  const ordered = steps.slice().sort((a, b) => (STEP_RANK[a] ?? 99) - (STEP_RANK[b] ?? 99));
  if (ordered.length === 0) {
    return <span className="muted">This request clears on submission: no further sign-off is required by policy.</span>;
  }
  return (
    <div className="chips">
      {ordered.map((step) => (
        <span className="chip" key={step}>
          {STEP_LABEL[step] ?? label(step)}
        </span>
      ))}
    </div>
  );
}

function AccDlg({
  title,
  sub,
  busy,
  error,
  onClose,
  onSubmit,
  submitLabel,
  wide,
  danger,
  disabled,
  children,
}: {
  title: string;
  sub?: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  wide?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide={wide}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={danger ? 'btn sd-danger' : 'btn btn-primary'}
            onClick={onSubmit}
            disabled={busy || disabled === true}
          >
            {busy ? 'Working...' : submitLabel}
          </button>
        </>
      }
    >
      {sub ? (
        <p className="muted" style={{ marginTop: 0 }}>
          {sub}
        </p>
      ) : null}
      <div className="sd-form-grid">{children}</div>
      <FormErr msg={error} />
    </Modal>
  );
}

/** Shared save plumbing, so every dialog reports failure the same way. */
function useAccSave(onSaved: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(
    (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError('');
      fn()
        .then(() => onSaved())
        .catch((e) => setError(sdErr(e)))
        .finally(() => setBusy(false));
    },
    [onSaved]
  );
  return { busy, error, setError, run };
}

function accessBase(request: Rec, selfService?: boolean): string {
  const base = selfService ? '/api/my/service-desk/access-requests/' : '/api/service-desk/access-requests/';
  return base + encodeURIComponent(refOf(request));
}

/* ------------------------------------------------------------------ *
 * DRAFT: edit the request itself
 * ------------------------------------------------------------------ */

export function AccessEditDlg({ request, onClose, onSaved }: AccDlgProps) {
  const [systemName, setSystemName] = useState(s(request.system_name));
  const [accessType, setAccessType] = useState(s(request.access_type) || 'ROLE');
  const [roleCode, setRoleCode] = useState(s(request.requested_role_code));
  const [duration, setDuration] = useState(s(request.duration) || 'PERMANENT');
  const [startsAt, setStartsAt] = useState(toLocalInput(request.access_starts_at));
  const [expiresAt, setExpiresAt] = useState(toLocalInput(request.access_expires_at));
  const [classification, setClassification] = useState(s(request.data_classification) || 'INTERNAL');
  const [risk, setRisk] = useState(s(request.risk_level));
  const [targetUserId, setTargetUserId] = useState(num(request.target_user_id) > 0 ? s(request.target_user_id) : '');
  const [justification, setJustification] = useState(s(request.justification));
  const [permissions, setPermissions] = useState(listOf(request.requested_permissions).join(', '));
  const [scopeText, setScopeText] = useState(() => {
    const scope = parseJson(request.requested_scope);
    return Object.keys(scope).length > 0 ? JSON.stringify(scope, null, 2) : '';
  });
  const [managerReq, setManagerReq] = useState(request.manager_approval_required ? 'yes' : 'no');
  const [ownerReq, setOwnerReq] = useState(request.owner_approval_required ? 'yes' : 'no');
  const { busy, error, setError, run } = useAccSave(onSaved);

  const dateBounded = duration === 'DATE_BOUNDED';
  const chain = suggestedChain({
    access_type: accessType,
    manager_approval_required: managerReq === 'yes',
    owner_approval_required: ownerReq === 'yes',
    risk_level: risk || s(request.risk_level),
    data_classification: classification,
  });

  const submit = () => {
    const scopeTextTrimmed = scopeText.trim();
    const scope = parseJson(scopeText);
    const scopeKeys = Object.keys(scope);
    if (scopeTextTrimmed && scopeKeys.length === 0 && scopeTextTrimmed !== '{}') {
      setError('The ABAC scope must be a JSON object, for example {"branchId": 2}.');
      return;
    }
    const body: Rec = {
      systemName: systemName.trim(),
      accessType,
      requestedRoleCode: roleCode.trim(),
      duration,
      dataClassification: classification,
      justification: justification.trim(),
      managerApprovalRequired: managerReq === 'yes',
      ownerApprovalRequired: ownerReq === 'yes',
      requestedPermissions: listOf(permissions),
      accessStartsAt: startsAt ? isoFromInput(startsAt) : null,
      accessExpiresAt: expiresAt ? isoFromInput(expiresAt) : null,
    };
    if (risk) body.riskLevel = risk;
    if (num(targetUserId) > 0) body.targetUserId = num(targetUserId);
    if (scopeKeys.length > 0) body.requestedScope = scope;
    run(() => sdPatch(accessBase(request), body));
  };

  return (
    <AccDlg
      title="Edit draft access request"
      sub="Nothing has been authorised yet, so the request can still be corrected. Once it is submitted it is frozen until the chain settles."
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Save draft"
      wide
      disabled={systemName.trim().length === 0 || justification.trim().length === 0 || (dateBounded && !expiresAt)}
    >
      <Field label="System / service" req>
        <Inp value={systemName} onChange={setSystemName} placeholder="HOPE DESIGN ERP" />
      </Field>
      <Field label="Access type" req>
        <Sel
          value={accessType}
          onChange={setAccessType}
          options={ACCESS_TYPES.map((code) => ({ value: code, label: TYPE_LABEL[code] ?? label(code) }))}
        />
      </Field>
      <Field label="Role code" hint="Only for a role request.">
        <Inp value={roleCode} onChange={setRoleCode} placeholder="finance_officer" />
      </Field>
      <Field label="Duration" req>
        <Sel
          value={duration}
          onChange={setDuration}
          options={DURATIONS.map((code) => ({ value: code, label: DURATION_LABEL[code] ?? label(code) }))}
        />
      </Field>
      <Field label="Access starts" hint="Leave blank to start on grant.">
        <Inp type="datetime-local" value={startsAt} onChange={setStartsAt} />
      </Field>
      <Field label="Access expires" req={dateBounded} hint="Required for a date-bounded request.">
        <Inp type="datetime-local" value={expiresAt} onChange={setExpiresAt} />
      </Field>
      <Field label="Data classification" req>
        <Sel
          value={classification}
          onChange={setClassification}
          options={CLASSIFICATIONS.map((code) => ({ value: code, label: code }))}
        />
      </Field>
      <Field label="Risk" hint="Leave blank to let the desk derive it.">
        <Sel
          value={risk}
          onChange={setRisk}
          options={RISK_LEVELS.map((code) => ({ value: code, label: code }))}
          placeholder="Derived by policy"
        />
      </Field>
      <Field label="Access for user id" hint="Blank means the requester.">
        <Inp type="number" value={targetUserId} onChange={setTargetUserId} />
      </Field>
      <Field label="Requested permissions" hint="Comma separated.">
        <Txa value={permissions} onChange={setPermissions} />
      </Field>
      <Field label="Justification" req>
        <Txa value={justification} onChange={setJustification} />
      </Field>
      <Field label="Requested ABAC scope" hint="JSON object. Blank leaves the workflow default.">
        <Txa value={scopeText} onChange={setScopeText} />
      </Field>
      <Field label="Manager sign-off required">
        <Sel value={managerReq} onChange={setManagerReq} options={YES_NO} />
      </Field>
      <Field label="Owner sign-off required">
        <Sel value={ownerReq} onChange={setOwnerReq} options={YES_NO} />
      </Field>
      <Field label="Authorisation that will be required" hint="Derived from access type, risk and classification.">
        <ChainPreview steps={chain} />
      </Field>
    </AccDlg>
  );
}

/* ------------------------------------------------------------------ *
 * SUBMIT: hand the request to the authorisation chain
 * ------------------------------------------------------------------ */

export function AccessSubmitDlg({ request, onClose, onSaved }: AccDlgProps) {
  const [note, setNote] = useState('');
  const { busy, error, run } = useAccSave(onSaved);
  const chain = suggestedChain(request);

  const submit = () => {
    const body: Rec = {};
    if (note.trim()) body.note = note.trim();
    run(() => sdPost(accessBase(request) + '/submit', body));
  };

  return (
    <AccDlg
      title="Submit for authorisation"
      sub="The desk builds the chain the policy demands. No access is provisioned at this point: approval and provisioning are separate acts."
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Submit request"
      wide
    >
      <Field label="Authorisation chain" hint="Each step must read APPROVED before provisioning is allowed.">
        <ChainPreview steps={chain} />
      </Field>
      <Field label="Note" hint="Optional hand-over note for the approvers.">
        <Txa value={note} onChange={setNote} />
      </Field>
    </AccDlg>
  );
}

/* ------------------------------------------------------------------ *
 * DECIDE: record one authorisation decision
 * ------------------------------------------------------------------ */

export function AccessDecideDlg({
  request,
  approval,
  approvals,
  onClose,
  onSaved,
}: AccDlgProps & { approval: Rec | null; approvals: Rec[] }) {
  const pool = approvals.length > 0 ? approvals : approval ? [approval] : [];
  const [approvalId, setApprovalId] = useState(s((approval ?? pool[0] ?? {}).id));
  const [decision, setDecision] = useState('APPROVED');
  const [comments, setComments] = useState('');
  const { busy, error, setError, run } = useAccSave(onSaved);

  const chosen = pool.find((a) => s(a.id) === approvalId) ?? approval ?? pool[0] ?? null;
  const step = s(chosen?.step);

  const submit = () => {
    if (!chosen) {
      setError('There is no open authorisation step to decide.');
      return;
    }
    if (decision === 'REJECTED' && comments.trim().length === 0) {
      setError('A rejection must state why it was refused.');
      return;
    }
    run(() =>
      sdPost(accessBase(request) + '/approvals/' + encodeURIComponent(s(chosen.id)) + '/decide', {
        decision,
        comments: comments.trim(),
      })
    );
  };

  return (
    <AccDlg
      title="Record an authorisation decision"
      sub="Decisions are attributed and audited. Approving is not the same as provisioning: the grant is a separate step performed by someone else."
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={decision === 'REJECTED' ? 'Reject request' : 'Approve request'}
      danger={decision === 'REJECTED'}
      disabled={pool.length === 0}
      wide
    >
      <Field label="Authorisation step" req hint="Only steps that are still open can be decided.">
        <Sel
          value={approvalId}
          onChange={setApprovalId}
          options={pool.map((a) => ({
            value: s(a.id),
            label: (STEP_LABEL[s(a.step)] ?? label(a.step)) + (s(a.approver_name) ? ' - ' + s(a.approver_name) : ''),
          }))}
        />
      </Field>
      <Field label="Decision" req>
        <Sel
          value={decision}
          onChange={setDecision}
          options={[
            { value: 'APPROVED', label: 'Approve' },
            { value: 'REJECTED', label: 'Reject' },
          ]}
        />
      </Field>
      <Field label="Comments" req={decision === 'REJECTED'}>
        <Txa value={comments} onChange={setComments} />
      </Field>
      <Field label="Segregation of duties" hint="The requester and the person receiving the access can never decide this request.">
        <span className="muted">
          {step ? 'Deciding the ' + (STEP_LABEL[step] ?? label(step)) + ' step.' : 'No open step.'}
        </span>
      </Field>
    </AccDlg>
  );
}

/* ------------------------------------------------------------------ *
 * GRANT: provision the authorised access
 * ------------------------------------------------------------------ */

export function AccessGrantDlg({ request, onClose, onSaved }: AccDlgProps) {
  const [roleCode, setRoleCode] = useState(s(request.requested_role_code));
  const [targetUserId, setTargetUserId] = useState(num(request.target_user_id) > 0 ? s(request.target_user_id) : '');
  const [notBefore, setNotBefore] = useState(toLocalInput(request.access_starts_at));
  const [applyRole, setApplyRole] = useState('yes');
  const [scopeText, setScopeText] = useState('');
  const [note, setNote] = useState('');
  const { busy, error, setError, run } = useAccSave(onSaved);

  const submit = () => {
    const scopeTextTrimmed = scopeText.trim();
    const scope = parseJson(scopeText);
    const scopeKeys = Object.keys(scope);
    if (scopeTextTrimmed && scopeKeys.length === 0 && scopeTextTrimmed !== '{}') {
      setError('The scope configuration must be a JSON object, for example {"branchId": 2}.');
      return;
    }
    const body: Rec = { applyRole: applyRole === 'yes' };
    if (roleCode.trim()) body.roleCode = roleCode.trim();
    if (num(targetUserId) > 0) body.targetUserId = num(targetUserId);
    if (notBefore) body.notBefore = isoFromInput(notBefore);
    if (scopeKeys.length > 0) body.abacScope = scope;
    if (note.trim()) body.note = note.trim();
    run(() => sdPost(accessBase(request) + '/grant', body));
  };

  return (
    <AccDlg
      title="Provision the authorised access"
      sub="The server refuses this unless every step the policy requires is APPROVED. Provisioning is audited separately from approval."
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Provision access"
      wide
    >
      <Field label="Role code" hint="The RBAC role to assign. Blank grants scope only.">
        <Inp value={roleCode} onChange={setRoleCode} placeholder="finance_officer" />
      </Field>
      <Field label="Grant to user id" hint="Blank uses the request target.">
        <Inp type="number" value={targetUserId} onChange={setTargetUserId} />
      </Field>
      <Field label="Effective from" hint="Blank uses the requested start.">
        <Inp type="datetime-local" value={notBefore} onChange={setNotBefore} />
      </Field>
      <Field label="Apply the RBAC role now" hint="Turn this off to record scope only.">
        <Sel value={applyRole} onChange={setApplyRole} options={YES_NO} />
      </Field>
      <Field label="ABAC scope configuration" hint="JSON object, merged onto the authorised scope.">
        <Txa value={scopeText} onChange={setScopeText} />
      </Field>
      <Field label="Provisioning note">
        <Txa value={note} onChange={setNote} />
      </Field>
    </AccDlg>
  );
}

/* ------------------------------------------------------------------ *
 * FAIL: the grant could not be recorded
 * ------------------------------------------------------------------ */

export function AccessFailProvisionDlg({ request, onClose, onSaved }: AccDlgProps) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAccSave(onSaved);

  const submit = () => {
    run(() => sdPost(accessBase(request) + '/provisioning-failed', { reason: reason.trim() }));
  };

  return (
    <AccDlg
      title="Report a provisioning failure"
      sub="Use this when the grant could not actually be recorded. The request returns to an authorised state so provisioning can be attempted again."
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Record failure"
      danger
      wide
    >
      <Field label="What went wrong" hint="Recorded on the request and in the audit trail.">
        <Txa value={reason} onChange={setReason} />
      </Field>
    </AccDlg>
  );
}

/* ------------------------------------------------------------------ *
 * REVOKE: withdraw live access
 * ------------------------------------------------------------------ */

export function AccessRevokeDlg({ request, onClose, onSaved }: AccDlgProps) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAccSave(onSaved);

  const submit = () => {
    run(() => sdPost(accessBase(request) + '/revoke', { reason: reason.trim() }));
  };

  return (
    <AccDlg
      title="Revoke granted access"
      sub="Revocation withdraws the recorded access and closes the request. A reason is mandatory and is kept on the audit record."
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Revoke access"
      danger
      disabled={reason.trim().length === 0}
      wide
    >
      <Field label="Revocation reason" req>
        <Txa value={reason} onChange={setReason} />
      </Field>
    </AccDlg>
  );
}

/* ------------------------------------------------------------------ *
 * CANCEL: abandon a request that is still in flight
 * ------------------------------------------------------------------ */

export function AccessCancelDlg({
  request,
  selfService,
  onClose,
  onSaved,
}: AccDlgProps & { selfService?: boolean }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAccSave(onSaved);

  const submit = () => {
    const body: Rec = {};
    if (reason.trim()) body.reason = reason.trim();
    run(() => sdPost(accessBase(request, selfService) + '/cancel', body));
  };

  return (
    <AccDlg
      title="Cancel this access request"
      sub="Any step still waiting for a decision is withdrawn. The request is kept for the record rather than deleted."
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Cancel request"
      danger
      wide
    >
      <Field label="Reason" hint="Optional, but recorded.">
        <Txa value={reason} onChange={setReason} />
      </Field>
    </AccDlg>
  );
}
/* ------------------------------------------------------------------ *
 * RAISE: a new access request
 * ------------------------------------------------------------------ */

const ACCESS_TYPE_OPTS: Array<{ value: string; label: string }> = ACCESS_TYPES.map((code) => ({
  value: code,
  label: TYPE_LABEL[code] ?? label(code),
}));
const ACCESS_DURATION_OPTS: Array<{ value: string; label: string }> = DURATIONS.map((code) => ({
  value: code,
  label: DURATION_LABEL[code] ?? label(code),
}));
const ACCESS_CLASS_OPTS: Array<{ value: string; label: string }> = CLASSIFICATIONS.map((code) => ({
  value: code,
  label: code,
}));
const ACCESS_RISK_OPTS: Array<{ value: string; label: string }> = RISK_LEVELS.map((code) => ({
  value: code,
  label: code,
}));
const ACCESS_PRIORITY_OPTS: Array<{ value: string; label: string }> = ['P1', 'P2', 'P3', 'P4'].map((code) => ({
  value: code,
  label: code,
}));

/** Permission and scope entries are typed by hand, so accept commas or newlines. */
function splitEntries(v: string): string[] {
  return v
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** The risk the server will derive, shown before the request is sent. */
function derivedRisk(accessType: string, classification: string, duration: string): string {
  if (classification === 'RESTRICTED') return 'CRITICAL';
  if (classification === 'CONFIDENTIAL') return 'HIGH';
  if ((accessType === 'DATABASE' || accessType === 'DATA_SCOPE') && duration === 'PERMANENT') return 'HIGH';
  if (RBAC_TYPES.includes(accessType)) return 'MEDIUM';
  if (duration === 'PERMANENT') return 'MEDIUM';
  return 'LOW';
}

/**
 * Raise an access request.
 *
 * Nothing in this dialog decides who authorises the request. The server derives
 * the chain from the access type, the risk and the classification, and refuses
 * to provision anything until every step of that chain has been approved.
 */
function NewAccessDlg({
  categories,
  selfService,
  onClose,
  onCreated,
}: {
  categories: Rec[];
  selfService: boolean;
  onClose: () => void;
  onCreated: (request: string) => void;
}) {
  const [systemName, setSystemName] = useState('');
  const [accessType, setAccessType] = useState('ROLE');
  const [roleCode, setRoleCode] = useState('');
  const [permissions, setPermissions] = useState('');
  const [scopeText, setScopeText] = useState('');
  const [justification, setJustification] = useState('');
  const [duration, setDuration] = useState('PERMANENT');
  const [startsAt, setStartsAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [classification, setClassification] = useState('INTERNAL');
  const [risk, setRisk] = useState('');
  const [targetUserId, setTargetUserId] = useState('');
  const [managerReq, setManagerReq] = useState('yes');
  const [ownerReq, setOwnerReq] = useState('yes');
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [priority, setPriority] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosen = categories.find((c) => s(c.id) === categoryId);
  const subs: Rec[] = chosen && Array.isArray(chosen.subcategories) ? (chosen.subcategories as Rec[]) : [];
  const categoryOptions = categories.map((c) => ({ value: s(c.id), label: s(c.name) }));
  const subOptions = subs.map((c) => ({ value: s(c.id), label: s(c.name) }));
  const dateBounded = duration === 'DATE_BOUNDED';
  const resultingRisk = risk || derivedRisk(accessType, classification, duration);
  const chain = suggestedChain({
    access_type: accessType,
    manager_approval_required: managerReq === 'yes',
    owner_approval_required: ownerReq === 'yes',
    risk_level: resultingRisk,
    data_classification: classification,
  });

  const submit = () => {
    const typedScope = scopeText.trim();
    const scope = parseJson(scopeText);
    const scopeKeys = Object.keys(scope);
    if (typedScope && scopeKeys.length === 0 && typedScope !== '{}') {
      setError('The ABAC scope must be a JSON object, for example {"branchId": 2}.');
      return;
    }
    setBusy(true);
    setError('');
    const body: Rec = {
      systemName: systemName.trim(),
      accessType,
      justification: justification.trim(),
      duration,
      dataClassification: classification,
      requestedPermissions: splitEntries(permissions),
      managerApprovalRequired: managerReq === 'yes',
      ownerApprovalRequired: ownerReq === 'yes',
      draft,
    };
    if (roleCode.trim()) body.requestedRoleCode = roleCode.trim();
    if (scopeKeys.length > 0) body.requestedScope = scope;
    if (startsAt) body.accessStartsAt = isoFromInput(startsAt);
    if (expiresAt) body.accessExpiresAt = isoFromInput(expiresAt);
    if (risk) body.riskLevel = risk;
    if (!selfService && num(targetUserId) > 0) body.targetUserId = num(targetUserId);
    if (categoryId) body.categoryId = num(categoryId);
    if (subcategoryId) body.subcategoryId = num(subcategoryId);
    if (priority) body.priority = priority;
    if (subject.trim()) body.subject = subject.trim();
    if (description.trim()) body.description = description.trim();

    sdPost<Rec>(selfService ? '/api/my/service-desk/access-requests' : '/api/service-desk/access-requests', body)
      .then((r) => onCreated(refOf(r)))
      .catch((e) => setError(sdErr(e)))
      .finally(() => setBusy(false));
  };

  return (
    <AccDlg
      title="Raise an access request"
      sub="This asks for access. It does not grant it: the desk records the request, gathers the authorisations policy demands, and only then provisions the access."
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={draft ? 'Save as draft' : 'Submit for authorisation'}
      wide
      disabled={systemName.trim().length === 0 || justification.trim().length === 0 || (dateBounded && !expiresAt)}
    >
      <Field label="System or service" req hint="The ERP, mailbox, folder or database the access concerns.">
        <Inp value={systemName} onChange={setSystemName} placeholder="HOPE DESIGN ERP" />
      </Field>
      <Field label="Access type" req>
        <Sel value={accessType} onChange={setAccessType} options={ACCESS_TYPE_OPTS} />
      </Field>
      <Field label="Role code" hint="Only for a role request, for example finance_officer.">
        <Inp value={roleCode} onChange={setRoleCode} />
      </Field>
      <Field label="Classification" req hint="The sensitivity of the data that would be reachable.">
        <Sel value={classification} onChange={setClassification} options={ACCESS_CLASS_OPTS} />
      </Field>
      <Field label="Duration" req>
        <Sel value={duration} onChange={setDuration} options={ACCESS_DURATION_OPTS} />
      </Field>
      <Field label="Access starts" hint="Leave blank to start on grant.">
        <Inp type="datetime-local" value={startsAt} onChange={setStartsAt} />
      </Field>
      <Field label="Access expires" req={dateBounded} hint="Required for a date-bounded request.">
        <Inp type="datetime-local" value={expiresAt} onChange={setExpiresAt} />
      </Field>
      <Field label="Risk" hint="Leave blank and the desk derives it from the classification and duration.">
        <Sel value={risk} onChange={setRisk} options={ACCESS_RISK_OPTS} placeholder="Derived by policy" />
      </Field>
      {selfService ? null : (
        <Field label="Access for user id" hint="Blank raises the request for yourself.">
          <Inp type="number" value={targetUserId} onChange={setTargetUserId} />
        </Field>
      )}
      <Field label="Requested permissions" hint="Comma or line separated. Only for a permission request.">
        <Txa value={permissions} onChange={setPermissions} rows={3} />
      </Field>
      <Field label="Requested ABAC scope" hint='JSON object, for example {"branchId": 2}. Blank leaves the workflow default.'>
        <Txa value={scopeText} onChange={setScopeText} rows={3} />
      </Field>
      <Field label="Business justification" req>
        <Txa value={justification} onChange={setJustification} rows={3} />
      </Field>
      <Field label="Category">
        <Sel
          value={categoryId}
          onChange={(v) => {
            setCategoryId(v);
            setSubcategoryId('');
          }}
          options={categoryOptions}
          placeholder="Chosen by the desk"
        />
      </Field>
      <Field label="Subcategory">
        <Sel value={subcategoryId} onChange={setSubcategoryId} options={subOptions} placeholder="None" />
      </Field>
      <Field label="Priority" hint="Only honoured for a caller allowed to set it.">
        <Sel value={priority} onChange={setPriority} options={ACCESS_PRIORITY_OPTS} placeholder="Derived" />
      </Field>
      <Field label="Subject" hint="Defaults to the system name.">
        <Inp value={subject} onChange={setSubject} />
      </Field>
      <Field label="Description">
        <Txa value={description} onChange={setDescription} rows={2} />
      </Field>
      <Field label="Manager sign-off required">
        <Sel value={managerReq} onChange={setManagerReq} options={YES_NO} />
      </Field>
      <Field label="Owner sign-off required">
        <Sel value={ownerReq} onChange={setOwnerReq} options={YES_NO} />
      </Field>
      <Field
        label="Authorisation that will be required"
        hint={'Derived risk: ' + resultingRisk + '. The chain is built from that, the access type and the classification.'}
      >
        <ChainPreview steps={chain} />
      </Field>
      <label className="hk-field" style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
        <span className="hk-lbl" style={{ margin: 0 }}>
          Keep as a draft and submit later
        </span>
      </label>
    </AccDlg>
  );
}

/* ------------------------------------------------------------------ *
 * Surface
 * ------------------------------------------------------------------ */

/**
 * Access request workspace.
 *
 * Approvers and the desk see the whole register. An employee whose role only
 * carries view_own sees their own requests and nothing else, because the server
 * refuses the register outright: the fallback below is a scope reduction, never
 * a permission grant.
 */
export default function ServiceDeskAccess({ id }: { id?: number | null }) {
  void id;
  const q = useHashQuery();
  const { user } = useAuth();
  const requestRef = s(q.get('ref'));
  const wantNew = s(q.get('new')) === '1';
  const [dashboard, setDashboard] = useState<Rec | null>(null);
  const [categories, setCategories] = useState<Rec[]>([]);
  const [selfService, setSelfService] = useState(false);
  const [creating, setCreating] = useState(wantNew);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [createError, setCreateError] = useState<unknown>(null);

  useEffect(() => {
    setCreating(wantNew);
  }, [wantNew]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const permissions: string[] = user?.permissions ?? [];
    const canCreate =
      permissions.includes('service_desk.access_requests.create') || permissions.includes('service_desk.tickets.create');
    Promise.resolve()
      .then(() => sdApi<Rec>('/api/service-desk/access-requests/dashboard'))
      .catch(() =>
        sdApi<{ items: Rec[]; total: number }>('/api/my/service-desk/access-requests' + qs({ pageSize: 5 })).then(
          (mine) => {
            const items = Array.isArray(mine.items) ? mine.items : [];
            setSelfService(true);
            return {
              myRequests: items,
              recent: [],
              byStatus: [],
              byType: [],
              byRisk: [],
              awaitingMyApproval: 0,
              awaitingProvisioning: 0,
              expiringWithinSevenDays: 0,
              openRequests: num(mine.total),
              granted: 0,
              scope: {
                canView: false,
                canViewOwn: true,
                canCreate,
                canApprove: false,
                canGrant: false,
                canRevoke: false,
                canCancel: false,
              },
            } as Rec;
          }
        )
      )
      .then((r) => {
        if (live) setDashboard(r ?? null);
      })
      .catch((e) => {
        if (live) setError(e);
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    sdApi<Rec[]>('/api/service-desk/categories')
      .catch(() => sdApi<Rec[]>('/api/my/service-desk/categories'))
      .then((r) => {
        if (live) setCategories(Array.isArray(r) ? r : []);
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, [user]);

  const scope: Rec = (dashboard?.scope as Rec) ?? {};
  const canCreate = !!scope.canCreate;
  const awaiting = num(dashboard?.awaitingMyApproval);
  const provisioning = num(dashboard?.awaitingProvisioning);
  const expiring = num(dashboard?.expiringWithinSevenDays);

  const closeNew = () => {
    setCreating(false);
    setCreateError(null);
    if (wantNew) navigate('/service-desk/access');
  };

  const created = (request: string) => {
    setCreating(false);
    if (request) navigate('/service-desk/access?ref=' + encodeURIComponent(request));
    else navigate('/service-desk/access?scope=mine');
  };

  return (
    <div className="page sd-page" style={modStyle()}>
      <SdHead
        title="Access requests"
        kicker="Service desk - ITSM"
        sub="Role, permission and data access: requested, authorised step by step, provisioned only once the chain settles, then audited."
        actions={
          canCreate ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New access request
            </button>
          ) : null
        }
      />
      <SdTabs active="access" />

      {createError ? <ErrorBanner error={createError} /> : null}

      {dashboard && !selfService ? (
        <KpiRow>
          <KpiTile
            label="Awaiting my approval"
            value={awaiting}
            sub={awaiting > 0 ? 'Steps waiting on your decision' : 'Nothing is waiting on you'}
            onClick={() => navigate('/service-desk/access?scope=pending')}
          />
          <KpiTile
            label="Awaiting provisioning"
            value={provisioning}
            sub="Authorised, not yet granted"
            onClick={() => navigate('/service-desk/access?scope=provision')}
          />
          <KpiTile
            label="Expiring in 7 days"
            value={expiring}
            sub={expiring > 0 ? 'Access that falls away this week' : 'No access falls away this week'}
            accent={expiring > 0 ? '#FF0000' : undefined}
            tint={expiring > 0 ? 'rgba(255, 0, 0, 0.10)' : undefined}
            onClick={() => navigate('/service-desk/access?sortBy=expiry')}
          />
          <KpiTile
            label="Granted"
            value={num(dashboard.granted)}
            sub="Live access recorded from this register"
            onClick={() => navigate('/service-desk/access?status=GRANTED')}
          />
          <KpiTile
            label="Open requests"
            value={num(dashboard.openRequests)}
            sub="In flight across the organisation"
            onClick={() => navigate('/service-desk/access')}
          />
        </KpiRow>
      ) : null}

      {error ? <ErrorBanner error={error} /> : null}

      {loading && !dashboard ? (
        <div className="card card-pad">
          <Spinner />
        </div>
      ) : null}

      {!loading && !dashboard ? (
        <Nothing text="The access request register is not available to your role." />
      ) : null}

      {dashboard ? <AccessOverview dashboard={dashboard} /> : null}

      {dashboard ? (
        requestRef ? (
          <AccessDetail requestRef={requestRef} selfService={selfService} />
        ) : (
          <AccessList canCreate={canCreate} dashboard={dashboard} selfService={selfService} />
        )
      ) : null}

      {creating ? (
        <NewAccessDlg
          categories={categories}
          selfService={selfService}
          onClose={closeNew}
          onCreated={created}
        />
      ) : null}
    </div>
  );
}
