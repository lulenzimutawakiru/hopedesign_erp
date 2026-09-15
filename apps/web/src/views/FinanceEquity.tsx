import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtMoney } from '../api';
import { useAuth, can } from '../auth';
import { navigate, useHashQuery } from '../router';
import { Badge, ErrorBanner, Modal, Pager } from '../components/ui';
import { EmptyState, Skeleton } from '../components/os';

/**
 * Equity bank integration desk.
 *
 * Two halves of one integration meet on this screen. The inbound half is the
 * bank pushing payment notifications at /api/integrations/equity, which the API
 * verifies with a stored Equity public key and posts into the bank ledger. This
 * screen is the operator's half: whether that pipeline is actually ready, what
 * has arrived, and which customer invoices the money settled.
 *
 * Outbound funds transfer is deliberately absent. It needs Equity onboarding
 * credentials and a transaction reference that agrees with our own numbering
 * before it can move money, so it is not offered until it can be done safely.
 */

type Rec = Record<string, unknown>;

/** Mirrors services/equity/config.ts. Never carries secret material. */
type EquityConfigView = {
  configured: boolean;
  integrationId: number | null;
  name: string | null;
  status: string;
  isActive: boolean;
  environment: string;
  country: string;
  currency: string;
  bankAccountId: number | null;
  organizationShortCode: string | null;
  tillNumber: string | null;
  gatewayBaseUrl: string | null;
  publicKeyPresent: boolean;
  publicKeyFingerprint: string | null;
  envKeyPresent: boolean;
  privateKeyPresent: boolean;
  consumerKeyPresent: boolean;
  consumerSecretPresent: boolean;
  lastTestedAt: string | null;
  readyForNotifications: boolean;
};

type EquityStatusTotals = {
  total: number;
  received: number;
  posted: number;
  matched: number;
  rejected: number;
  validationChecks: number;
  unreconciledCount: number;
  unreconciledAmount: number;
  unattributedCount: number;
};

type EquityStatusView = {
  config: EquityConfigView;
  totals: EquityStatusTotals;
  warnings: string[];
  lastNotifiedAt: string | null;
};

/** One notification as a person reads it, not as the table stores it. */
type EquityNotification = {
  id: number;
  notificationType: string;
  equityTransactionId: string | null;
  requestId: string | null;
  transactionReference: string | null;
  customerName: string | null;
  customerReference: string | null;
  customerMsisdn: string | null;
  amount: number | null;
  currency: string | null;
  narration: string | null;
  tillNumber: string | null;
  organizationShortCode: string | null;
  creditAccountIdentifier: string | null;
  transactionAt: string | null;
  status: string;
  rejectReason: string | null;
  bankTransactionId: number | null;
  bankAccountId: number | null;
  bankAccountCode: string | null;
  bankAccountName: string | null;
  matchedInvoiceId: number | null;
  matchedInvoiceNo: string | null;
  matchedAt: string | null;
  matchedBy: number | null;
  createdAt: string | null;
};

type EquityNotificationPage = { rows: EquityNotification[]; total: number; limit: number; offset: number };

type EquityConnectionCheck = { key: string; label: string; ok: boolean; detail: string; critical: boolean };

type EquityConnectionTestResult = {
  ok: boolean;
  status: string;
  testedAt: string;
  checks: EquityConnectionCheck[];
  config: EquityConfigView;
};

type EquityInvoiceCandidate = {
  id: number;
  invoiceNo: string;
  customerName: string | null;
  currency: string | null;
  status: string;
  total: number | null;
  amountPaid: number | null;
  outstanding: number;
  invoiceDate: string | null;
};

type EquityMatchResult = {
  notification: EquityNotification;
  invoiceOutstanding: number | null;
  difference: number | null;
};

type EquityBankAccount = {
  id: number;
  code: string;
  name: string;
  currency: string;
  isActive: boolean;
};
const EQUITY_TABS: [string, string][] = [
  ['overview', 'Overview'],
  ['notifications', 'Notifications'],
  ['setup', 'Setup'],
];

const EQUITY_STATUSES = ['RECEIVED', 'POSTED', 'MATCHED', 'REJECTED'];
const EQUITY_TYPES = ['ACCOUNT', 'TILL', 'VALIDATION'];
const EQUITY_PAGE_SIZES = [25, 50, 100];

/** What each stored status means for the money, in plain words. */
const EQUITY_STATUS_MEANING: Record<string, string> = {
  RECEIVED: 'Held. No settlement account could be resolved, so nothing was posted.',
  POSTED: 'In the bank ledger and unreconciled. The money is real but no invoice owns it yet.',
  MATCHED: 'Reconciled to a customer invoice.',
  REJECTED: 'Refused before anything was written. The reason is recorded below.',
};

/** Why a notification was refused, keyed by the stored reason code. */
const EQUITY_REJECT_MEANING: Record<string, string> = {
  UNMAPPED_ACCOUNT: 'Nothing matched the account or till it was paid into, so it was not posted.',
  SIGNATURE_INVALID: 'The Signature header did not verify against a stored Equity public key.',
  DUPLICATE: 'This transaction id or request id had already been received.',
};

/** Where the bank posts to. Shown so the URL can be handed to Equity exactly. */
const EQUITY_INBOUND_PATHS: [string, string][] = [
  ['/api/integrations/equity/account-notification', 'Account notification'],
  ['/api/integrations/equity/till-notification', 'Till notification'],
  ['/api/integrations/equity/validation', 'Bill validation (authorisation only, never posted)'],
];

/** Currency-prefixed money. A null amount is an em dash, never a zero. */
const equityMoney = (amount: number | null | undefined, currency: string | null | undefined): string =>
  amount === null || amount === undefined
    ? '\u2014'
    : `${currency ? `${currency} ` : ''}${fmtMoney(amount)}`;

function equityDay(v: unknown): string {
  if (!v) return '\u2014';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function equityWhen(v: unknown): string {
  if (!v) return '\u2014';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** How long ago, so an operator can tell a live queue from a stale one. */
function equityAgo(v: unknown): string {
  if (!v) return '\u2014';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** The identifier a person would quote when asking about this payment. */
const equityRef = (n: EquityNotification): string =>
  n.transactionReference ?? n.equityTransactionId ?? n.requestId ?? String(n.id);

/**
 * Status is never carried by colour alone: every chip pairs a glyph and the
 * status word with its tone, so it still reads in greyscale or with a colour
 * vision deficiency. MATCHED is the only state that means "done".
 */
function EquityStatusChip({ status }: { status: string }) {
  const s = String(status ?? '').toUpperCase();
  const meta =
    s === 'MATCHED'
      ? { tone: 'badge-green', icon: '\u2713' }
      : s === 'POSTED'
        ? { tone: 'badge-progress', icon: '\u25CF' }
        : s === 'RECEIVED'
          ? { tone: 'badge-amber', icon: '\u26A0' }
          : s === 'REJECTED'
            ? { tone: 'badge-red', icon: '\u2715' }
            : { tone: 'badge-neutral', icon: '\u25CF' };
  return (
    <span className={`badge ${meta.tone}`} title={EQUITY_STATUS_MEANING[s] ?? undefined}>
      <span className="badge-icon" aria-hidden>{meta.icon}</span>
      {(s || '\u2014').replace(/_/g, ' ')}
    </span>
  );
}

/** A pass or fail that says which it is in words, not just in colour. */
function EquityCheckChip({ ok }: { ok: boolean }) {
  return (
    <span className={`badge ${ok ? 'badge-green' : 'badge-red'}`}>
      <span className="badge-icon" aria-hidden>{ok ? '\u2713' : '\u2715'}</span>
      {ok ? 'Pass' : 'Fail'}
    </span>
  );
}

/** A stored-or-not flag for a credential that is never sent to the browser. */
function EquitySecretState({ label, present, note }: { label: string; present: boolean; note?: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div>
        <span className={`badge ${present ? 'badge-green' : 'badge-neutral'}`}>
          <span className="badge-icon" aria-hidden>{present ? '\u2713' : '\u2013'}</span>
          {present ? 'Stored' : 'Not set'}
        </span>
        {note && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{note}</span>}
      </div>
    </div>
  );
}
/** A labelled dropdown. Same shape as the ledger's status picker. */
function EquitySelect({ value, onChange, options, label, placeholder, labels }: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  label: string;
  placeholder: string;
  labels?: Record<string, string>;
}) {
  return (
    <select className="search-input" style={{ maxWidth: 190 }} value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o} value={o}>{labels?.[o] ?? o.replace(/_/g, ' ')}</option>
      ))}
    </select>
  );
}
/**
 * The integration desk. Everything it shows comes from the API's own view of
 * the integration, so the screen cannot drift from what the ingest path will
 * actually accept.
 */
export function FinanceEquity() {
  const { user } = useAuth();
  const qs = useHashQuery();

  const tabParam = qs.get('tab') ?? '';
  const tab = EQUITY_TABS.some(([k]) => k === tabParam) ? tabParam : 'overview';
  const statusFilter = qs.get('status') ?? '';
  const typeFilter = qs.get('type') ?? '';
  const matchedFilter = qs.get('matched') ?? '';
  const search = qs.get('q') ?? '';
  const page = Math.max(1, Number(qs.get('page') ?? '1') || 1);
  const sizeParam = Number(qs.get('size'));
  const pageSize = EQUITY_PAGE_SIZES.includes(sizeParam) ? sizeParam : 50;

  const canManage = can(user, 'finance.equity.manage');
  const canTest = can(user, 'finance.equity.test');
  // Requesting bank accounts without the permission would surface a permission
  // error where a working panel belongs, so it is only asked for when allowed.
  const canSeeBanks = can(user, 'finance.banks.view');

  const [status, setStatus] = useState<EquityStatusView | null>(null);
  const [notifications, setNotifications] = useState<EquityNotificationPage | null>(null);
  const [accounts, setAccounts] = useState<EquityBankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadFailures, setLoadFailures] = useState<Array<{ panel: string; message: string }>>([]);
  const [testResult, setTestResult] = useState<EquityConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [matchTarget, setMatchTarget] = useState<EquityNotification | null>(null);
  const [unmatchTarget, setUnmatchTarget] = useState<EquityNotification | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState(search);
  const [detailId, setDetailId] = useState<number | null>(null);

  const writeQuery = useCallback(
    (patch: Record<string, string | number | undefined>) => {
      const next: Record<string, string> = {};
      qs.forEach((v, k) => { next[k] = v; });
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === '') delete next[k];
        else next[k] = String(v);
      }
      navigate('/finance/equity', { query: next });
    },
    [qs]
  );

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (opts.silent) setRefreshing(true);
      else setLoading(true);
      setError('');
      const failures: Array<{ panel: string; message: string }> = [];
      const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (typeFilter) params.set('notificationType', typeFilter);
      if (matchedFilter) params.set('matched', matchedFilter);
      if (search) params.set('search', search);
      params.set('limit', String(pageSize));
      params.set('offset', String((page - 1) * pageSize));

      const jobs: Array<[string, Promise<unknown>]> = [
        [
          'integration status',
          api<{ data: EquityStatusView }>('/api/ops/finance/equity/status')
            .then((r) => setStatus(r.data ?? null))
            .catch((e) => { failures.push({ panel: 'integration status', message: reason(e) }); }),
        ],
        [
          'payment notifications',
          api<{ data: EquityNotificationPage }>(`/api/ops/finance/equity/notifications?${params.toString()}`)
            .then((r) => setNotifications(r.data ?? null))
            .catch((e) => { failures.push({ panel: 'payment notifications', message: reason(e) }); }),
        ],
      ];
      if (canSeeBanks) {
        jobs.push([
          'bank accounts',
          api<{ data: { rows: EquityBankAccount[] } }>('/api/ops/finance/banks')
            .then((r) => setAccounts(r.data?.rows ?? []))
            .catch((e) => { failures.push({ panel: 'bank accounts', message: reason(e) }); }),
        ]);
      }

      await Promise.allSettled(jobs.map(([, job]) => job));
      setLoadFailures(failures);
      setLoading(false);
      setRefreshing(false);
    },
    [statusFilter, typeFilter, matchedFilter, search, page, pageSize, canSeeBanks]
  );

  useEffect(() => { void load(); }, [load]);

  const totals = status?.totals ?? null;
  const config = status?.config ?? null;
  const warnings = status?.warnings ?? [];
  const rows = notifications?.rows ?? [];
  const total = notifications?.total ?? 0;

  const ready = config !== null && config.readyForNotifications && config.bankAccountId !== null;
  const accountName = (id: number | null): string => {
    if (id === null) return '\u2014';
    const hit = accounts.find((a) => a.id === id);
    return hit ? `${hit.code} \u00B7 ${hit.name}` : `#${id}`;
  };

  /** Runs one write, then refreshes. Returns whether it actually landed. */
  const commit = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setNotice(label);
      await load({ silent: true });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setError('');
    try {
      const r = await api<{ data: EquityConnectionTestResult }>('/api/ops/finance/equity/test-connection', { method: 'POST' });
      setTestResult(r.data ?? null);
      setNotice(r.data?.ok ? 'Connection test passed.' : 'Connection test found problems. See the checks below.');
      await load({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const saveConfig = (payload: Rec) =>
    commit('Integration settings saved.', () =>
      api('/api/ops/finance/equity/config', { method: 'PATCH', body: JSON.stringify(payload) })
    );

  const matchInvoice = async (invoiceId: number) => {
    const target = matchTarget;
    let gap: number | null = null;
    let gapCurrency: string | null = null;
    const ok = await commit('Payment reconciled to the invoice.', async () => {
      const r = await api<{ data: EquityMatchResult }>(
        `/api/ops/finance/equity/notifications/${target?.id}/match`,
        { method: 'POST', body: JSON.stringify({ invoiceId }) }
      );
      gap = r.data?.difference ?? null;
      gapCurrency = r.data?.notification?.currency ?? null;
      setMatchTarget(null);
    });
    // Report how the payment sat against the balance, so a short or excess
    // payment is stated at the moment it is made rather than found later.
    if (ok && gap !== null && gap !== 0) {
      setNotice(
        gap > 0
          ? `Payment reconciled. It paid more than the invoice owed by ${equityMoney(gap, gapCurrency)}.`
          : `Payment reconciled. It was short of the invoice by ${equityMoney(Math.abs(gap), gapCurrency)}.`
      );
    }
    return ok;
  };

  const unmatch = (n: EquityNotification) =>
    commit('Reconciliation removed. The payment line itself is untouched.', () =>
      api(`/api/ops/finance/equity/notifications/${n.id}/unmatch`, { method: 'POST' })
    );
  /** Open settings from a clean slate, so a stale banner cannot reappear inside it. */
  const openConfig = () => {
    setError('');
    setConfigOpen(true);
  };

  const hasFilters = Boolean(statusFilter || typeFilter || matchedFilter || search);
  const clearFilters = () => writeQuery({ status: undefined, type: undefined, matched: undefined, q: undefined, page: undefined });

  /** The filters as chips, so what is narrowing the list is always visible. */
  const activeFilters = useMemo(() => {
    const out: Array<{ key: string; label: string; value: string }> = [];
    if (statusFilter) out.push({ key: 'status', label: 'Status', value: statusFilter.replace(/_/g, ' ') });
    if (typeFilter) out.push({ key: 'type', label: 'Type', value: typeFilter });
    if (matchedFilter === 'true') out.push({ key: 'matched', label: 'Reconciled', value: 'Yes' });
    if (matchedFilter === 'false') out.push({ key: 'matched', label: 'Reconciled', value: 'Not yet' });
    if (search) out.push({ key: 'q', label: 'Search', value: search });
    return out;
  }, [statusFilter, typeFilter, matchedFilter, search]);

  const removeFilter = (key: string) => writeQuery({ [key]: undefined, page: undefined });
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Cash &amp; bank</p>
          <h1>Equity bank integration</h1>
          <p className="muted">
            Payment notifications pushed by Equity, and the customer invoices the money settled.
          </p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          {canTest && (
            <button className="btn" disabled={testing || busy} onClick={() => void runTest()}>
              {testing ? 'Testing\u2026' : 'Test connection'}
            </button>
          )}
          {canManage && <button className="btn btn-primary" onClick={openConfig}>Configure</button>}
        </div>
      </header>

      <nav className="toolbar" aria-label="Equity sections" style={{ gap: 6 }}>
        {EQUITY_TABS.map(([key, label]) => (
          <button
            key={key}
            className={`btn btn-sm${tab === key ? ' btn-primary' : ' btn-ghost'}`}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => writeQuery({ tab: key === 'overview' ? undefined : key })}
          >
            {label}
          </button>
        ))}
      </nav>

      {error && <ErrorBanner error={error} />}
      {notice && <div className="notice-banner" role="status">{notice}</div>}
      {loadFailures.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 14 }}>
          <div className="card-head"><h3>Some panels could not load</h3></div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {loadFailures.map((f) => (
              <li key={f.panel}><b>{f.panel}</b>: {f.message}</li>
            ))}
          </ul>
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            The rest of the page is unaffected. Reload to try the failed panels again.
          </p>
        </div>
      )}

      {tab === 'overview' && (
        loading ? <Skeleton rows={6} /> : (
          <>
            <section className="card card-pad" style={{ marginBottom: 14 }}>
              <div className="card-head">
                <h3>Readiness</h3>
                <span className={`badge ${ready ? 'badge-green' : 'badge-amber'}`}>
                  <span className="badge-icon" aria-hidden>{ready ? '\u2713' : '\u26A0'}</span>
                  {ready ? 'Ready for notifications' : 'Not ready'}
                </span>
              </div>
              <p className="muted" style={{ marginTop: 4 }}>
                {ready
                  ? 'A notification signed by Equity will verify and be posted into the settlement account below.'
                  : 'Equity notifications will be refused or held until every item below is resolved.'}
              </p>
              {warnings.length > 0 ? (
                <ul style={{ margin: '10px 0 0', paddingLeft: 20 }}>
                  {warnings.map((w) => (
                    <li key={w}><span aria-hidden>{'\u26A0'}</span> {w}</li>
                  ))}
                </ul>
              ) : (
                <p style={{ marginTop: 10, color: 'var(--success)' }}>
                  <span aria-hidden>{'\u2713'}</span> No outstanding configuration problems.
                </p>
              )}
            </section>            <div className="kpi-grid">
              <div className="kpi-card">
                <span className="kpi-label">Received</span>
                <span className="kpi-value">{(totals?.received ?? 0).toLocaleString()}</span>
                <span className="kpi-sub">
                  {(totals?.received ?? 0) === 0
                    ? 'Nothing held waiting on an account'
                    : `${(totals?.unattributedCount ?? 0).toLocaleString()} held: no settlement account resolved`}
                </span>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Awaiting reconciliation</span>
                <span className={`kpi-value${(totals?.posted ?? 0) > 0 ? ' kpi-warn' : ''}`}>
                  {(totals?.posted ?? 0).toLocaleString()}
                </span>
                <span className="kpi-sub">
                  {equityMoney(totals?.unreconciledAmount, config?.currency)} in the bank ledger with no invoice
                </span>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Reconciled</span>
                <span className="kpi-value">{(totals?.matched ?? 0).toLocaleString()}</span>
                <span className="kpi-sub">Linked to a customer invoice</span>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Refused</span>
                <span className="kpi-value">{(totals?.rejected ?? 0).toLocaleString()}</span>
                <span className="kpi-sub">Signature, duplicate or unmapped account</span>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Validation checks</span>
                <span className="kpi-value">{(totals?.validationChecks ?? 0).toLocaleString()}</span>
                <span className="kpi-sub">Authorisation only. Never posted as money.</span>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Last notification</span>
                <span className="kpi-value">{equityAgo(status?.lastNotifiedAt)}</span>
                <span className="kpi-sub">{equityWhen(status?.lastNotifiedAt)}</span>
              </div>
            </div>

            <section className="card card-pad" style={{ marginBottom: 14 }}>
              <div className="card-head">
                <h3>Integration</h3>
                <span className={`badge ${config?.configured ? 'badge-neutral' : 'badge-amber'}`}>
                  <span className="badge-icon" aria-hidden>{config?.configured ? '\u25CF' : '\u26A0'}</span>
                  {config?.configured ? (config.isActive ? 'Active' : 'Inactive') : 'Not created'}
                </span>
              </div>
              {config === null ? (
                <EmptyState
                  title="No Equity integration yet"
                  body="Creating one stores the Equity public key this server verifies notifications with. Use Configure to set it up."
                />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <tbody>
                      <tr>
                        <th scope="row">Environment</th>
                        <td>{config.environment}</td>
                      </tr>
                      <tr>
                        <th scope="row">Status</th>
                        <td>
                          {config.status}
                          {!config.isActive && <span className="muted">{' \u00B7 '}switched off, so notifications are refused</span>}
                        </td>
                      </tr>
                      <tr>
                        <th scope="row">Settlement account</th>
                        <td>
                          {config.bankAccountId === null ? (
                            <span>Not linked. Payments would be held rather than posted.</span>
                          ) : (
                            <>
                              {accountName(config.bankAccountId)}
                              {!canSeeBanks && (
                                <span className="muted">{' \u00B7 '}name needs the bank accounts permission</span>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                      <tr>
                        <th scope="row">Country</th>
                        <td>{config.country}</td>
                      </tr>
                      <tr>
                        <th scope="row">Currency</th>
                        <td>{config.currency}</td>
                      </tr>
                      <tr>
                        <th scope="row">Organisation short code</th>
                        <td className="cell-mono">{config.organizationShortCode ?? '\u2014'}</td>
                      </tr>
                      <tr>
                        <th scope="row">Till number</th>
                        <td className="cell-mono">{config.tillNumber ?? '\u2014'}</td>
                      </tr>
                      <tr>
                        <th scope="row">Gateway base URL</th>
                        <td className="cell-mono">{config.gatewayBaseUrl ?? '\u2014'}</td>
                      </tr>
                      <tr>
                        <th scope="row">Signing key</th>
                        <td>
                          {config.publicKeyFingerprint ? (
                            <span className="cell-mono">{config.publicKeyFingerprint}</span>
                          ) : config.envKeyPresent ? (
                            <span>From the EQUITY_PUBLIC_KEY environment variable</span>
                          ) : (
                            <span>None stored. Every notification would be refused.</span>
                          )}
                        </td>
                      </tr>
                      <tr>
                        <th scope="row">Last tested</th>
                        <td>{config.lastTestedAt ? equityWhen(config.lastTestedAt) : 'Never'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            {testResult && (
              <section className="card card-pad" style={{ marginBottom: 14 }}>
                <div className="card-head">
                  <h3>Connection test</h3>
                  <span className="muted" style={{ fontSize: 12 }}>Tested {equityWhen(testResult.testedAt)}</span>
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
                      {testResult.checks.map((check) => (
                        <tr key={check.key} className={!check.ok && check.critical ? 'row-warn' : undefined}>
                          <td>
                            {check.label}
                            {!check.ok && check.critical && (
                              <span className="muted" style={{ marginLeft: 8 }}>
                                <span aria-hidden>{'\u26A0'}</span> Critical
                              </span>
                            )}
                          </td>
                          <td><EquityCheckChip ok={check.ok} /></td>
                          <td>{check.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  A critical failure means a notification could not be trusted or resolved. Everything else still works.
                </p>
              </section>
            )}
          </>
        )
      )}
      {tab === 'notifications' && (
        <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <input
              className="search-input"
              type="search"
              value={searchDraft}
              aria-label="Search Equity payment notifications"
              placeholder="Search transaction id, reference, customer..."
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchDraft !== search) writeQuery({ q: searchDraft, page: undefined });
              }}
            />
            <EquitySelect value={statusFilter} onChange={(v) => writeQuery({ status: v, page: undefined })}
              options={EQUITY_STATUSES} label="Filter by status" placeholder="Any status" />
            <EquitySelect value={typeFilter} onChange={(v) => writeQuery({ type: v, page: undefined })}
              options={EQUITY_TYPES} label="Filter by notification type" placeholder="Any type"
              labels={{
                ACCOUNT: 'Account notification',
                TILL: 'Till notification',
                VALIDATION: 'Validation (authorisation only)',
              }} />
            <EquitySelect value={matchedFilter} onChange={(v) => writeQuery({ matched: v, page: undefined })}
              options={['false', 'true']} label="Filter by reconciliation" placeholder="Any reconciliation"
              labels={{ false: 'Not reconciled', true: 'Reconciled' }} />
            {(hasFilters || searchDraft !== search) && (
              <button className="btn btn-sm btn-ghost" onClick={() => { setSearchDraft(''); clearFilters(); }}>
                Clear filters
              </button>
            )}
          </div>

          {activeFilters.length > 0 && (
            <div className="filter-chips" style={{ padding: '0 0 12px' }}>
              {activeFilters.map((f) => (
                <span key={f.key} className="filter-chip">
                  <b>{f.label}</b>{f.value ? `: ${f.value}` : ''}
                  <button type="button" title="Remove filter" aria-label={`Remove ${f.label} filter`}
                    onClick={() => removeFilter(f.key)}>{'\u00D7'}</button>
                </span>
              ))}
              <button className="btn btn-sm btn-ghost" onClick={() => { setSearchDraft(''); clearFilters(); }}>Clear all</button>
            </div>
          )}

          <div className="card-head">
            <h3>Payment notifications ({total.toLocaleString()})</h3>
            {!loading && total > 0 && (
              <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
                Showing {((page - 1) * pageSize + 1).toLocaleString()}-{Math.min(page * pageSize, total).toLocaleString()} of {total.toLocaleString()}
              </span>
            )}
          </div>

          {(totals?.unattributedCount ?? 0) > 0 && (
            <p style={{ margin: '0 0 10px' }}>
              <span className="badge badge-amber">
                <span className="badge-icon" aria-hidden>{'\u26A0'}</span>
                {(totals?.unattributedCount ?? 0).toLocaleString()} held
              </span>
              <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                Nothing matched the account or till these were paid into, so no money was posted. Link a settlement
                account on the integration, or record the payment by hand.
              </span>
            </p>
          )}

          {loading ? <Skeleton rows={6} /> : rows.length === 0 ? (
            hasFilters ? (
              <EmptyState title="No notifications match these filters"
                body="Nothing matches the current filters. Clear them to see everything Equity has sent."
                action="Clear filters" onAction={() => { setSearchDraft(''); clearFilters(); }} />
            ) : (
              <EmptyState title="No Equity notifications yet"
                body="Point Equity at the inbound URLs on the Setup tab. Payments it sends will appear here, and money is only posted once a settlement account resolves." />
            )
          ) : (
            <>              <div className="record-cards mobile-only">
                {rows.map((n) => {
                  const isValidation = n.notificationType === 'VALIDATION';
                  const canMatch = canManage && n.status !== 'REJECTED' && !isValidation && n.matchedInvoiceId === null;
                  const canUnmatch = canManage && n.matchedInvoiceId !== null;
                  return (
                    <div key={`card-${n.id}`} className="record-card">
                      <div className="record-card-top">
                        <strong className="cell-mono">{equityRef(n)}</strong>
                        <EquityStatusChip status={n.status} />
                      </div>
                      <div className="record-card-meta">
                        <span>{equityWhen(n.transactionAt ?? n.createdAt)}</span>
                        <span>{isValidation ? 'Authorisation only' : n.notificationType}</span>
                        <span>{equityMoney(n.amount, n.currency ?? config?.currency)}</span>
                      </div>
                      <div>{n.customerName ?? 'Customer not named'}</div>
                      {n.status === 'REJECTED' && n.rejectReason && (
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {EQUITY_REJECT_MEANING[n.rejectReason] ?? n.rejectReason}
                        </div>
                      )}
                      <div className="record-card-foot">
                        <span className="chip">
                          <span className="chip-k">Account</span>
                          {n.bankAccountCode ?? 'Not resolved'}
                        </span>
                        <span className="chip">
                          <span className="chip-k">Invoice</span>
                          {n.matchedInvoiceNo ?? 'Not reconciled'}
                        </span>
                      </div>
                      {canManage && (canMatch || canUnmatch) && (
                        <div className="row-actions" style={{ marginTop: 8 }}>
                          {canMatch && (
                            <button className="btn btn-sm" disabled={busy} onClick={() => setMatchTarget(n)}>Reconcile</button>
                          )}
                          {canUnmatch && (
                            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setUnmatchTarget(n)}>Unmatch</button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>              <div className="table-wrap desktop-only">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Received</th>
                      <th>Type</th>
                      <th>Customer</th>
                      <th className="cell-num">Amount</th>
                      <th>Account</th>
                      <th>Status</th>
                      <th>Invoice</th>
                      <th className="cell-num">Actions</th>
                    </tr>
                  </thead>
                  {rows.map((n) => {
                    const isValidation = n.notificationType === 'VALIDATION';
                    const canMatch = canManage && n.status !== 'REJECTED' && !isValidation && n.matchedInvoiceId === null;
                    const canUnmatch = canManage && n.matchedInvoiceId !== null;
                    const expanded = detailId === n.id;
                    return (
                      <tbody key={n.id}>
                        <tr className={n.status === 'RECEIVED' ? 'row-warn' : undefined}>
                          <td className="cell-mono">{equityRef(n)}</td>
                          <td>{equityWhen(n.transactionAt ?? n.createdAt)}</td>
                          <td>
                            {isValidation ? (
                              <>
                                <span className="badge badge-neutral">
                                  <span className="badge-icon" aria-hidden>{'\u25CF'}</span>
                                  Authorisation
                                </span>
                                <span className="muted" style={{ display: 'block', fontSize: 11.5, marginTop: 3 }}>
                                  Never posted as money
                                </span>
                              </>
                            ) : (
                              n.notificationType
                            )}
                          </td>
                          <td>
                            {n.customerName ?? '\u2014'}
                            {(n.customerMsisdn || n.customerReference) && (
                              <span className="muted" style={{ display: 'block', fontSize: 11.5 }}>
                                {[n.customerMsisdn, n.customerReference].filter(Boolean).join(' \u00B7 ')}
                              </span>
                            )}
                          </td>
                          <td className="cell-num">{equityMoney(n.amount, n.currency ?? config?.currency)}</td>
                          <td>
                            {n.bankAccountCode
                              ? `${n.bankAccountCode}${n.bankAccountName ? ` \u00B7 ${n.bankAccountName}` : ''}`
                              : n.creditAccountIdentifier ?? '\u2014'}
                          </td>
                          <td>
                            <EquityStatusChip status={n.status} />
                            {n.status === 'REJECTED' && n.rejectReason && (
                              <span className="muted" style={{ display: 'block', fontSize: 11.5, marginTop: 3 }}>
                                {EQUITY_REJECT_MEANING[n.rejectReason] ?? n.rejectReason}
                              </span>
                            )}
                          </td>
                          <td className="cell-mono">{n.matchedInvoiceNo ?? '\u2014'}</td>
                          <td>
                            <div className="row-actions">
                              {canMatch && (
                                <button className="btn btn-sm" disabled={busy} onClick={() => setMatchTarget(n)}>Reconcile</button>
                              )}
                              {canUnmatch && (
                                <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setUnmatchTarget(n)}>Unmatch</button>
                              )}
                              <button className="btn btn-sm btn-ghost" aria-expanded={expanded}
                                onClick={() => setDetailId(expanded ? null : n.id)}>
                                {expanded ? 'Hide' : 'Details'}
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={9} style={{ background: 'var(--paper-2)' }}>
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
                                <EquityDetail label="Equity transaction id" value={n.equityTransactionId} mono />
                                <EquityDetail label="Request id" value={n.requestId} mono />
                                <EquityDetail label="Customer reference" value={n.customerReference} mono />
                                <EquityDetail label="Till number" value={n.tillNumber} mono />
                                <EquityDetail label="Organisation short code" value={n.organizationShortCode} mono />
                                <EquityDetail label="Paid into" value={n.creditAccountIdentifier} mono />
                                <EquityDetail label="Transaction time" value={n.transactionAt ? equityWhen(n.transactionAt) : null} />
                                <EquityDetail label="Bank ledger line" value={n.bankTransactionId === null ? null : `#${n.bankTransactionId}`} />
                                <EquityDetail label="Reconciled" value={n.matchedAt ? `${equityWhen(n.matchedAt)}${n.matchedBy ? ` by user #${n.matchedBy}` : ''}` : 'Not reconciled'} />
                                <EquityDetail label="Narration" value={n.narration} />
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    );
                  })}
                </table>
              </div>
            </>
          )}
          {!loading && (
            <Pager page={page} pageSize={pageSize} total={total} pageSizes={EQUITY_PAGE_SIZES}
              onPage={(n) => writeQuery({ page: n })}
              onPageSize={(n) => writeQuery({ size: n, page: 1 })} />
          )}
        </section>
      )}
      {tab === 'setup' && (
        <>
          <section className="card card-pad" style={{ marginBottom: 14 }}>
            <div className="card-head"><h3>Inbound URLs for Equity</h3></div>
            <p className="muted">
              Hand these to Equity exactly as they appear. Equity posts payment notifications to them and this server
              answers with an acknowledgement.
            </p>
            <div className="code-scroll">
              <pre>{EQUITY_INBOUND_PATHS.map(([path, label]) => `${label}\n${window.location.origin}${path}`).join('\n\n')}</pre>
            </div>
          </section>

          <section className="card card-pad" style={{ marginBottom: 14 }}>
            <div className="card-head"><h3>How a notification is trusted</h3></div>
            <p>
              Every request carries a <span className="code-chip">Signature</span> header: SHA256withRSA over the
              raw request body, signed with Equity's private key and checked here against the public key stored on
              this integration.
            </p>
            <p className="muted">
              This is not OAuth. No token is exchanged and nothing is sent back to Equity, so that key is the only
              thing between a forged notification and the bank ledger. With no usable key stored, every
              notification is refused.
            </p>
          </section>

          <section className="card card-pad" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <h3>Credentials</h3>
              {canManage && <button className="btn btn-sm" onClick={openConfig}>Configure</button>}
            </div>
            {config === null ? (
              <p className="muted">Nothing is stored yet.</p>
            ) : (
              <>
                <EquitySecretState label="Equity public key (verifies inbound notifications)" present={config.publicKeyPresent}
                  note={config.publicKeyFingerprint ? `Fingerprint ${config.publicKeyFingerprint}` : 'Stored, but it does not parse as a public key'} />
                <EquitySecretState label="Environment key" present={config.envKeyPresent}
                  note="EQUITY_PUBLIC_KEY on the server. Used when no key is stored here." />
                <EquitySecretState label="Our private key (outbound, unused until transfers are enabled)" present={config.privateKeyPresent} />
                <EquitySecretState label="Consumer key" present={config.consumerKeyPresent} />
                <EquitySecretState label="Consumer secret" present={config.consumerSecretPresent} />
              </>
            )}
            <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              Secrets are write-only. They are never sent back to this screen, so a stored value can only be
              replaced, not read.
            </p>
          </section>
        </>
      )}

      {matchTarget && (
        <EquityMatchDialog
          notification={matchTarget}
          currency={matchTarget.currency ?? config?.currency ?? null}
          busy={busy}
          onClose={() => setMatchTarget(null)}
          onSave={matchInvoice}
        />
      )}

      {unmatchTarget && (
        <Modal
          title="Remove this reconciliation?"
          onClose={() => { if (!busy) setUnmatchTarget(null); }}
          footer={
            <>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setUnmatchTarget(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}
                onClick={() => { const target = unmatchTarget; setUnmatchTarget(null); void unmatch(target); }}>
                Unmatch
              </button>
            </>
          }
        >
          <p>
            <b>{equityRef(unmatchTarget)}</b> will be unlinked from invoice{' '}
            <b>{unmatchTarget.matchedInvoiceNo ?? `#${unmatchTarget.matchedInvoiceId}`}</b>.
          </p>
          <p className="muted">
            The money stays in the bank ledger. Only the statement that this payment settled that invoice is
            withdrawn, and the reversal is audited.
          </p>
        </Modal>
      )}

      {configOpen && (
        <EquityConfigDialog
          config={config}
          accounts={accounts}
          busy={busy}
          error={error}
          onClose={() => setConfigOpen(false)}
          onSave={async (payload) => {
            const ok = await saveConfig(payload);
            if (ok) setConfigOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** One labelled fact in a notification's expanded detail. */
function EquityDetail({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <span className="kpi-label">{label}</span>
      <span className={mono ? 'cell-mono' : undefined} style={{ display: 'block', marginTop: 2 }}>
        {value ?? '\u2014'}
      </span>
    </div>
  );
}

/**
 * Reconcile one received payment against one open invoice.
 *
 * The lookup is debounced: without it every keystroke is a query against the
 * invoice table. The gap between the payment and the outstanding balance is
 * shown rather than enforced, because part-payments and over-payments are real
 * and the API records them exactly as they are.
 */
function EquityMatchDialog({ notification, currency, busy, onClose, onSave }: {
  notification: EquityNotification;
  currency: string | null;
  busy: boolean;
  onClose: () => void;
  onSave: (invoiceId: number) => void;
}) {
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<EquityInvoiceCandidate[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    timer.current = window.setTimeout(
      () => {
        void (async () => {
          setLoading(true);
          setError('');
          try {
            const params = new URLSearchParams();
            if (search) params.set('search', search);
            params.set('limit', '20');
            const r = await api<{ data: EquityInvoiceCandidate[] }>(`/api/ops/finance/equity/invoices?${params.toString()}`);
            if (live) setCandidates(r.data ?? []);
          } catch (e) {
            if (live) {
              setCandidates([]);
              setError(e instanceof Error ? e.message : String(e));
            }
          } finally {
            if (live) setLoading(false);
          }
        })();
      },
      search ? 250 : 0
    );
    return () => {
      live = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [search]);

  const chosen = candidates.find((c) => c.id === selected) ?? null;
  const difference = chosen && notification.amount !== null ? notification.amount - chosen.outstanding : null;
  const mismatch = Boolean(chosen?.currency && currency && chosen.currency !== currency);

  return (
    <Modal
      title="Reconcile this payment"
      wide
      onClose={() => { if (!busy) onClose(); }}
      footer={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || selected === null || mismatch}
            onClick={() => { if (selected !== null) onSave(selected); }}
          >
            Reconcile
          </button>
        </>
      }
    >
      <div className="record-card" style={{ marginBottom: 12 }}>
        <div className="record-card-top">
          <b className="cell-mono">{equityRef(notification)}</b>
          <b>{equityMoney(notification.amount, currency)}</b>
        </div>
        <div className="record-card-meta">
          {notification.customerName || 'Payer not named'}
          {' \u00B7 '}
          {equityWhen(notification.transactionAt)}
        </div>
      </div>

      <div className="field">
        <label htmlFor="equity-invoice-search">Find the invoice this payment settles</label>
        <input
          id="equity-invoice-search"
          className="search-input"
          type="search"
          aria-label="Search open invoices by invoice number or customer name"
          placeholder="Invoice number or customer name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <Skeleton rows={4} />
      ) : error ? (
        <ErrorBanner error={error} />
      ) : candidates.length === 0 ? (
        <EmptyState
          title="No open invoices match"
          body="Only invoices still awaiting payment are offered. Search by invoice number or customer name."
        />
      ) : (
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th aria-label="Select" />
                <th>Invoice</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Invoice date</th>
                <th className="cell-num">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.id} className={selected === c.id ? 'row-click is-selected' : 'row-click'} onClick={() => setSelected(c.id)}>
                  <td>
                    <input
                      type="radio"
                      name="equity-invoice"
                      aria-label={`Reconcile against invoice ${c.invoiceNo}`}
                      checked={selected === c.id}
                      onChange={() => setSelected(c.id)}
                    />
                  </td>
                  <td className="cell-mono">{c.invoiceNo}</td>
                  <td>{c.customerName || '\u2014'}</td>
                  <td><Badge value={c.status} /></td>
                  <td>{equityDay(c.invoiceDate)}</td>
                  <td className="cell-num">{equityMoney(c.outstanding, c.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {chosen && (
        <p className="muted" style={{ marginTop: 12 }}>
          {difference === null
            ? `Invoice ${chosen.invoiceNo} is outstanding by ${equityMoney(chosen.outstanding, chosen.currency)}.`
            : difference === 0
              ? `This payment settles invoice ${chosen.invoiceNo} exactly.`
              : difference > 0
                ? `This payment exceeds the outstanding balance on ${chosen.invoiceNo} by ${equityMoney(difference, chosen.currency)}. An over-payment is allowed and recorded exactly as received.`
                : `This payment is short of the outstanding balance on ${chosen.invoiceNo} by ${equityMoney(Math.abs(difference), chosen.currency)}. The invoice stays open for the remainder.`}
        </p>
      )}

      {mismatch && chosen && (
        <ErrorBanner
          error={`Invoice ${chosen.invoiceNo} is denominated in ${chosen.currency} but this payment is in ${currency}. A payment cannot settle an invoice in another currency, so pick a ${currency} invoice instead.`}
        />
      )}
    </Modal>
  );
}

/**
 * Integration settings.
 *
 * Key material is write-only: the API returns whether a key is stored, never
 * the key. So every secret box starts empty and an untouched box is omitted
 * from the patch rather than sent as an empty string, which the API reads as
 * "clear this key". A box that has been typed into replaces the stored value;
 * the explicit Remove action is what clears it.
 */
function EquityConfigDialog({ config, accounts, busy, error, onClose, onSave }: {
  config: EquityConfigView | null;
  accounts: EquityBankAccount[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (payload: Rec) => void;
}) {
  const initialAccount = config?.bankAccountId === null || config?.bankAccountId === undefined ? '' : String(config.bankAccountId);
  const [environment, setEnvironment] = useState(config?.environment ?? 'SANDBOX');
  const [country, setCountry] = useState(config?.country ?? '');
  const [currency, setCurrency] = useState(config?.currency ?? '');
  const [bankAccountId, setBankAccountId] = useState(initialAccount);
  const [organizationShortCode, setOrganizationShortCode] = useState(config?.organizationShortCode ?? '');
  const [tillNumber, setTillNumber] = useState(config?.tillNumber ?? '');
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState(config?.gatewayBaseUrl ?? '');
  const [publicKey, setPublicKey] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [consumerKey, setConsumerKey] = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const [clearing, setClearing] = useState<Record<string, boolean>>({});

  /** What the server currently holds, so only real changes are sent. */
  const storedText: Record<string, string | null> = {
    country: config?.country ?? null,
    currency: config?.currency ?? null,
    organizationShortCode: config?.organizationShortCode ?? null,
    tillNumber: config?.tillNumber ?? null,
    gatewayBaseUrl: config?.gatewayBaseUrl ?? null,
  };

  const textFields: [string, string][] = [
    ['country', country],
    ['currency', currency],
    ['organizationShortCode', organizationShortCode],
    ['tillNumber', tillNumber],
    ['gatewayBaseUrl', gatewayBaseUrl],
  ];

  const submit = () => {
    const payload: Rec = { environment };
    for (const [key, draft] of textFields) {
      const next = draft.trim() === '' ? null : draft.trim();
      // Country and currency have server defaults, so an empty box must not blank them.
      if ((key === 'country' || key === 'currency') && next === null) continue;
      if (next !== storedText[key]) payload[key] = next;
    }
    if (bankAccountId !== initialAccount) payload.bankAccountId = bankAccountId === '' ? '' : Number(bankAccountId);
    const secrets: [string, string][] = [
      ['publicKey', publicKey],
      ['privateKey', privateKey],
      ['consumerKey', consumerKey],
      ['consumerSecret', consumerSecret],
    ];
    for (const [key, draft] of secrets) {
      if (clearing[key]) payload[key] = '';
      else if (draft.trim() !== '') payload[key] = draft.trim();
    }
    onSave(payload);
  };

  const secretField = (key: string, label: string, present: boolean, multiline: boolean, hint: string) => {
    const value = key === 'publicKey' ? publicKey
      : key === 'privateKey' ? privateKey
        : key === 'consumerKey' ? consumerKey
          : consumerSecret;
    const set = key === 'publicKey' ? setPublicKey
      : key === 'privateKey' ? setPrivateKey
        : key === 'consumerKey' ? setConsumerKey
          : setConsumerSecret;
    const isClearing = Boolean(clearing[key]);
    return (
      <div className="field" key={key}>
        <label htmlFor={`equity-secret-${key}`}>{label}</label>
        {multiline ? (
          <textarea
            id={`equity-secret-${key}`}
            className="search-input"
            rows={4}
            spellCheck={false}
            disabled={isClearing}
            placeholder={present ? 'Stored \u2014 paste a new value to replace it' : 'Paste the PEM block'}
            value={value}
            onChange={(e) => set(e.target.value)}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        ) : (
          <input
            id={`equity-secret-${key}`}
            className="search-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={isClearing}
            placeholder={present ? 'Stored \u2014 type a new value to replace it' : 'Not set'}
            value={value}
            onChange={(e) => set(e.target.value)}
          />
        )}
        <div style={{ marginTop: 6 }}>
          <EquitySecretState label={`${label} status`} present={isClearing ? false : present} note={isClearing ? 'Will be removed when you save.' : hint} />
          {present && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => setClearing((c) => ({ ...c, [key]: !c[key] }))}
            >
              {isClearing ? 'Keep the stored key' : 'Remove the stored key'}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <Modal
      title="Equity integration settings"
      wide
      onClose={() => { if (!busy) onClose(); }}
      footer={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>Save settings</button>
        </>
      }
    >
      <p className="muted">
        Equity signs each notification with its own private key. Paste Equity&apos;s <b>public</b> key here so the
        signature can be verified before any money is recorded. A notification that does not verify is refused.
      </p>

      {error && <ErrorBanner error={error} />}

      <div className="field">
        <label htmlFor="equity-account-currency">Settlement account</label>
        <select
          id="equity-account-currency"
          className="search-input"
          value={bankAccountId}
          onChange={(e) => setBankAccountId(e.target.value)}
        >
          <option value="">No account linked (notifications are held)</option>
          {accounts.map((a) => (
            <option key={a.id} value={String(a.id)}>
              {`${a.code} \u00B7 ${a.name} \u00B7 ${a.currency}`}
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>
          Every accepted payment is posted to this account as a bank transaction. With no account linked,
          notifications are held as RECEIVED and nothing reaches the ledger.
        </span>
      </div>

      <div className="field">
        <label htmlFor="equity-environment">Environment</label>
        <select
          id="equity-environment"
          className="search-input"
          value={environment}
          onChange={(e) => setEnvironment(e.target.value)}
        >
          <option value="SANDBOX">Sandbox (UAT)</option>
          <option value="PRODUCTION">Production</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="equity-country">Country</label>
        <input
          id="equity-country"
          className="search-input"
          placeholder="KE"
          maxLength={2}
          value={country}
          onChange={(e) => setCountry(e.target.value.toUpperCase())}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          Equity operates in Kenya, Uganda, Tanzania, Rwanda, Burundi and South Sudan. Set the country this
          company collects in, not the country the bank is headquartered in.
        </span>
      </div>

      <div className="field">
        <label htmlFor="equity-currency">Currency</label>
        <input
          id="equity-currency"
          className="search-input"
            placeholder="UGX"
          maxLength={3}
          value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          Must match the settlement account. A notification in another currency is refused rather than
          converted, so a wrong rate can never be invented here.
        </span>
      </div>

      <div className="field">
        <label htmlFor="equity-short-code">Organisation short code</label>
        <input
          id="equity-short-code"
          className="search-input"
          placeholder="As issued by Equity"
          value={organizationShortCode}
          onChange={(e) => setOrganizationShortCode(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="equity-till">Till number</label>
        <input
          id="equity-till"
          className="search-input"
          placeholder="As issued by Equity"
          value={tillNumber}
          onChange={(e) => setTillNumber(e.target.value)}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          At least one of the short code or the till number is needed before a till notification can be
          attributed to this company.
        </span>
      </div>

      <div className="field">
        <label htmlFor="equity-gateway">Gateway base URL</label>
        <input
          id="equity-gateway"
          className="search-input"
          placeholder="https://uat.buni.equitygroup.com"
          value={gatewayBaseUrl}
          onChange={(e) => setGatewayBaseUrl(e.target.value)}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          Used by Test connection. Change this only when Equity moves you between their UAT and production
          gateways.
        </span>
      </div>

      <h3 style={{ marginTop: 18 }}>Key material</h3>
      <p className="muted">
        Stored keys are never sent back to this screen. Leave a box empty to keep what is already stored.
      </p>

      {secretField('publicKey', 'Equity public key', Boolean(config?.publicKeyPresent), true, config?.publicKeyFingerprint ? `Fingerprint ${config.publicKeyFingerprint}` : 'Required before any notification can be verified.')}
      {secretField('privateKey', 'Our private key', Boolean(config?.privateKeyPresent), true, 'Only needed for outbound calls, which are not enabled yet.')}
      {secretField('consumerKey', 'Consumer key', Boolean(config?.consumerKeyPresent), false, 'Not used by notifications; kept for the APIs Equity issues alongside them.')}
      {secretField('consumerSecret', 'Consumer secret', Boolean(config?.consumerSecretPresent), false, 'Not used by notifications; kept for the APIs Equity issues alongside them.')}
    </Modal>
  );
}
