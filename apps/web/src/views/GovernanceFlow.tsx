import { useEffect, useState, type ReactNode } from 'react';
import { api, fmtDate, fmtMoney } from '../api';
import { useAuth, can, type MeUser } from '../auth';
import { useCompanyProfile } from '../company';
import { navigate, useHashQuery } from '../router';
import { Badge, ErrorBanner, Modal } from '../components/ui';
import { ConfirmDialog, EmptyState, Skeleton } from '../components/os';
import { DefRow, DefSec, Rec, labelize, s, tileStyle } from './assetsShared';

type Row = Rec;
type GovProps = { path: string };

const DEL_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED', 'REJECTED', 'CANCELLED'];
const SIG_STATUSES = ['DRAFT', 'PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED', 'REJECTED'];
const SIG_LEVELS = ['EXECUTIVE', 'MANAGEMENT', 'FINANCE', 'HR', 'OPERATIONS', 'TECHNICAL', 'SECURITY', 'OTHER'];

// Mirror of the backend governance-admin role gate used for owner/admin actions
// that the API additionally enforces (suspend/revoke/expire/reactivate).
const GOV_ADMIN_CODES = [
  'super_administrator', 'managing_director', 'ceo', 'executive_director',
  'general_manager', 'hr_director', 'hr_manager', 'security_administrator',
];

const TX_TYPES = [
  'PURCHASE', 'SALES', 'PAYMENT', 'RECEIPT', 'EXPENSE', 'JOURNAL',
  'PAYROLL', 'STOCK_ADJUSTMENT', 'PRODUCTION', 'CONTRACT', 'OTHER',
];

const DOC_TYPES = [
  'SALES_QUOTATION', 'SALES_ORDER', 'CUSTOMER_INVOICE', 'CREDIT_NOTE',
  'PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'SUPPLIER_INVOICE',
  'PAYMENT_VOUCHER', 'JOURNAL_VOUCHER', 'OFFICIAL_RECEIPT', 'EMPLOYMENT_CONTRACT',
  'LEAVE_APPROVAL', 'PAYROLL_APPROVAL', 'PRODUCTION_ORDER', 'INSPECTION_REPORT',
  'DELIVERY_NOTE', 'OFFICIAL_LETTER', 'INTERNAL_MEMO', 'MANAGEMENT_REPORT',
];

function isGovAdmin(user: MeUser | null): boolean {
  if (!user) return false;
  return user.roles.some((r) => GOV_ADMIN_CODES.includes(r.role_code));
}

function govAdminLabel(user: MeUser | null): string {
  if (!user) return 'No';
  return user.roles.some((r) => GOV_ADMIN_CODES.includes(r.role_code)) ? 'Yes' : 'No';
}

function toLocalInput(iso: unknown): string {
  if (!iso) return '';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
    pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function fmtAmount(v: unknown): string {
  if (v === null || v === undefined || v === '') return '-';
  const n = Number(v);
  return Number.isFinite(n) ? fmtMoney(n) : '-';
}

function fullName(r: Row | null | undefined): string {
  if (!r) return '-';
  return (s(r.firstName || r.first_name) + ' ' + s(r.lastName || r.last_name)).trim() || '-';
}

function GovHeader({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <p className="mod-kicker" data-mod="adm">Administration - Governance</p>
        <h1>{title}</h1>
        {sub && <p className="muted" style={{ maxWidth: 880 }}>{sub}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </header>
  );
}

function GovKpi({ label, value, sub, icon, accent, tint, onClick }: {
  label: string; value: unknown; sub: string; icon: string; accent: string; tint: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span className="kpi-tile-icon" aria-hidden>{icon}</span>
      <span className="kpi-tile-body">
        <span className="kpi-tile-label">{label}</span>
        <span className="kpi-tile-value">{value === null || value === undefined || value === '' ? '-' : String(value)}</span>
        <span className="kpi-tile-sub">{sub}</span>
      </span>
    </>
  );
  if (onClick) {
    return <button className="kpi-tile" style={tileStyle(accent, tint)} onClick={onClick}>{inner}</button>;
  }
  return <div className="kpi-tile" style={tileStyle(accent, tint)}>{inner}</div>;
}

function NoAccess({ what }: { what: string }) {
  return (
    <div className="page">
      <GovHeader title="No access" sub={'Your account does not have permission to view ' + what + '.'} />
      <div className="notice-banner">Access to this area is controlled by RBAC + ABAC and has been denied.</div>
    </div>
  );
}
function personName(r: Row | null | undefined, prefix?: string): string {
  if (!r) return '-';
  if (prefix) {
    const f = s(r[prefix + 'FirstName'] ?? r[prefix + '_first_name']);
    const l = s(r[prefix + 'LastName'] ?? r[prefix + '_last_name']);
    const n = (f + ' ' + l).trim();
    if (n) return n;
  }
  return fullName(r);
}

function roleOf(r: Row, which: 'original' | 'temporary'): string {
  const name = s(r[which + 'RoleName']);
  const code = s(r[which + 'RoleCode']);
  return name || code || '-';
}

function GovSubNav({ active }: { active: 'delegations' | 'signatures' }) {
  const { user } = useAuth();
  const items: Array<{ id: 'delegations' | 'signatures'; label: string; perm: string }> = [
    { id: 'delegations', label: 'Delegations', perm: 'governance.delegations.view' },
    { id: 'signatures', label: 'Signature authority', perm: 'governance.signature_profiles.view' },
  ];
  const visible = items.filter((it) => can(user, it.perm));
  if (visible.length <= 1) return null;
  return (
    <div className="chips" style={{ marginBottom: 14 }}>
      {visible.map((it) => (
        <button key={it.id} className={active === it.id ? 'chip chip-on' : 'chip'} onClick={() => navigate('/admin/' + it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

function GovFilterBar({ statuses, current, mine, mineLabel, onStatus, onMine }: {
  statuses: readonly string[];
  current: string;
  mine: boolean;
  mineLabel: string;
  onStatus: (st: string) => void;
  onMine: (v: boolean) => void;
}) {
  return (
    <div className="toolbar" style={{ marginTop: 16, flexWrap: 'wrap' }}>
      <div className="chips">
        <button className={!current ? 'chip chip-on' : 'chip'} onClick={() => onStatus('')}>All</button>
        {statuses.map((st) => (
          <button key={st} className={current === st ? 'chip chip-on' : 'chip'} onClick={() => onStatus(st === current ? '' : st)}>
            {labelize(st)}
          </button>
        ))}
      </div>
      <label className="filter-check" style={{ marginLeft: 'auto', marginBottom: 0 }}>
        <input type="checkbox" checked={mine} onChange={(e) => onMine(e.target.checked)} />
        {mineLabel}
      </label>
    </div>
  );
}

function ActingStrip() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    let on = true;
    if (!can(user, 'governance.acting_roles.view')) { setRows([]); return; }
    api<{ data: Row[] }>('/api/ops/governance/acting/roles')
      .then((r) => { if (on) setRows(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (on) setRows([]); });
    return () => { on = false; };
  }, [user]);
  if (!rows.length) return null;
  return (
    <div className="notice-banner" style={{ marginBottom: 14, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <strong>You are currently acting: </strong>
      {rows.map((r) => (
        <button key={s(r.id)} className="btn btn-sm" onClick={() => navigate('/admin/delegations/' + s(r.id))}>
          {s(r.roleName)} on behalf of {personName(r, 'delegator')} until {fmtDate(r.expiresAt)}
        </button>
      ))}
    </div>
  );
}
function DelegationsCenter() {
  const { user } = useAuth();
  const q = useHashQuery();
  const status = q.get('status') ?? '';
  const mine = q.get('mine') === '1';
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const canCreate = can(user, 'governance.delegations.create');

  const setQuery = (next: { status?: string; mine?: boolean }) => {
    const st = next.status !== undefined ? next.status : status;
    const mn = next.mine !== undefined ? next.mine : mine;
    navigate('/admin/delegations', {
      replace: true,
      query: { status: st || undefined, mine: mn ? 1 : undefined },
    });
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (mine) params.set('mine', '1');
    api<{ data: Row[] }>('/api/ops/governance/delegations?' + params.toString())
      .then((r) => { if (alive) setRows(Array.isArray(r.data) ? r.data : []); })
      .catch((e) => { if (alive) { setError(e instanceof Error ? e.message : 'Delegations failed to load'); setRows([]); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [status, mine, tick]);

  useEffect(() => {
    let alive = true;
    api<{ data: { delegations: Row } }>('/api/ops/governance/dashboard')
      .then((r) => { if (alive && r.data?.delegations) setSummary(r.data.delegations); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [tick]);

  return (
    <div className="page">
      <GovHeader
        title="Delegations and acting authority"
        sub="Grant a colleague temporary authority to act in a role while key personnel are away. Delegations are scoped, approval-gated, time-limited and fully audited; authority is removed automatically when the delegation window ends."
        actions={canCreate ? <button className="btn btn-primary" onClick={() => setShowNew(true)}>New delegation</button> : undefined}
      />
      <ActingStrip />
      <GovSubNav active="delegations" />
      <div className="kpi-grid--tiles">
        <GovKpi label="Active" value={summary ? Number(s(summary.active)) : '-'} sub="Currently granting acting authority" icon="live" accent="#0b8f5f" tint="rgba(11,143,95,0.10)" onClick={() => setQuery({ status: 'ACTIVE' })} />
        <GovKpi label="Awaiting approval" value={summary ? Number(s(summary.pendingApproval)) : '-'} sub="Delegations submitted but not yet approved" icon="clock" accent="#d97706" tint="rgba(217,119,6,0.10)" onClick={() => setQuery({ status: 'PENDING_APPROVAL' })} />
        <GovKpi label="Total" value={summary ? Number(s(summary.total)) : '-'} sub="All delegations on record" icon="list" accent="#2563eb" tint="rgba(37,99,235,0.10)" onClick={() => setQuery({ status: '' })} />
        <GovKpi label="Involving me" value={summary ? Number(s(summary.mine)) : '-'} sub="Created by me or held by me" icon="person" accent="#7c3aed" tint="rgba(124,58,237,0.10)" onClick={() => setQuery({ mine: !mine })} />
      </div>
      <GovFilterBar
        statuses={DEL_STATUSES}
        current={status}
        mine={mine}
        mineLabel="Delegations I created or hold"
        onStatus={(st) => setQuery({ status: st })}
        onMine={(v) => setQuery({ mine: v })}
      />
      {error && <ErrorBanner error={error} />}
      {loading ? <Skeleton rows={8} /> : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Code</th><th>Acting authority</th><th>On behalf of</th><th>Window</th><th>Limit</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={s(r.id)} className="row-link" onClick={() => navigate('/admin/delegations/' + s(r.id))}>
                  <td>
                    <span className="cell-mono">{s(r.code)}</span>
                    <div className="muted" style={{ fontSize: 12 }}>{Number(r.delegatorUserId) === user?.id ? 'Created by me' : ''}{Number(r.delegateUserId) === user?.id ? 'Held by me' : ''}</div>
                  </td>
                  <td>
                    <strong>{personName(r, 'delegate')}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>as {roleOf(r, 'temporary')}</div>
                  </td>
                  <td>
                    {personName(r, 'delegator')}
                    <div className="muted" style={{ fontSize: 12 }}>from {roleOf(r, 'original')}</div>
                  </td>
                  <td>
                    <div className="td-cell-mono">{r.startsAt ? fmtDate(r.startsAt) : '-'}</div>
                    <div className="muted" style={{ fontSize: 12 }}>to {r.expiresAt ? fmtDate(r.expiresAt) : '-'}</div>
                  </td>
                  <td className="td-cell-mono">{fmtAmount(r.approvalLimit)}</td>
                  <td><Badge value={r.status} /></td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6}>
                  <EmptyState
                    title={status ? 'No delegations in this state' : 'No delegations yet'}
                    body={status
                      ? 'No delegation records match the selected status. Clear the filter to see every delegation.'
                      : 'Create a delegation when a key person is away so the business can keep operating under delegated, auditable authority.'}
                    action={canCreate ? 'New delegation' : undefined}
                    onAction={canCreate ? () => setShowNew(true) : undefined}
                  />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {showNew && (
        <NewDelegationModal
          onClose={() => setShowNew(false)}
          onCreated={(id) => navigate('/admin/delegations/' + id)}
        />
      )}
    </div>
  );
}

function NewDelegationModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<Row[]>([]);
  const [roles, setRoles] = useState<Row[]>([]);
  const [loadError, setLoadError] = useState('');
  const [delegateId, setDelegateId] = useState('');
  const [originalId, setOriginalId] = useState('');
  const [temporaryId, setTemporaryId] = useState('');
  const [reason, setReason] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [limit, setLimit] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ data: { data: Row[] } }>('/api/admin/users?page=1&pageSize=200'),
      api<{ data: { data: Row[] } }>('/api/admin/roles?page=1&pageSize=200'),
    ])
      .then(([u, r]) => {
        if (!alive) return;
        setUsers(Array.isArray(u.data?.data) ? u.data.data : []);
        setRoles(Array.isArray(r.data?.data) ? r.data.data : []);
      })
      .catch((e) => { if (alive) setLoadError(e instanceof Error ? e.message : 'Could not load users and roles'); });
    return () => { alive = false; };
  }, []);

  const userLabel = (r: Row) => {
    const n = fullName(r);
    const em = s(r.email);
    const jt = s(r.jobTitle) || s(r.positionTitle);
    return (n === '-' ? em : n + (jt ? ' - ' + jt : '')) + (em ? ' (' + em + ')' : '');
  };

  const submit = async () => {
    const issues: string[] = [];
    if (!delegateId) issues.push('Select the employee who will act in your place.');
    if (!originalId || !temporaryId) issues.push('Choose both the original role and the temporary role.');
    else if (originalId === temporaryId) issues.push('The temporary role must differ from the original role.');
    if (!reason.trim()) issues.push('A reason is required and is written to the audit trail.');
    const from = fromLocalInput(startsAt);
    const to = fromLocalInput(expiresAt);
    if (!from || !to) issues.push('Choose a valid start and end date and time.');
    else if (new Date(to).getTime() <= new Date(from).getTime()) issues.push('The delegation must end after it starts.');
    const lim = limit === '' ? undefined : Number(limit);
    if (lim !== undefined && (!Number.isFinite(lim) || lim < 0)) issues.push('The approval limit must be zero or a positive amount.');
    if (issues.length) { setError(issues.join(' ')); return; }
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        delegateUserId: Number(delegateId),
        originalRoleId: Number(originalId),
        temporaryRoleId: Number(temporaryId),
        reason: reason.trim(),
        startsAt: from,
        expiresAt: to,
      };
      if (lim !== undefined) body.approvalLimit = lim;
      const res = await api<{ data: Row }>('/api/ops/governance/delegations', { method: 'POST', body: JSON.stringify(body) });
      onCreated(Number(res.data.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the delegation.');
    } finally {
      setSaving(false);
    }
  };

  const today = toLocalInput(new Date().toISOString());
  return (
    <Modal title="New delegation" onClose={onClose} wide
      footer={(
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Creating...' : 'Create draft'}</button>
        </div>
      )}
    >
      {loadError && <ErrorBanner error={loadError} />}
      {error && <ErrorBanner error={error} />}
      <div className="field">
        <label htmlFor="del-delegate">Delegate (the person who will act)</label>
        <select id="del-delegate" value={delegateId} onChange={(e) => setDelegateId(e.target.value)}>
          <option value="">Select user...</option>
          {users.filter((r) => Number(r.id) !== me?.id).map((r) => (
            <option key={s(r.id)} value={s(r.id)}>{userLabel(r)}</option>
          ))}
        </select>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>A user cannot be delegated authority over themselves.</p>
      </div>
      <div className="two-col">
        <div className="field">
          <label htmlFor="del-orig">Original role</label>
          <select id="del-orig" value={originalId} onChange={(e) => setOriginalId(e.target.value)}>
            <option value="">Select role...</option>
            {roles.map((r) => <option key={s(r.id)} value={s(r.id)}>{s(r.name) || s(r.code)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="del-temp">Temporary role</label>
          <select id="del-temp" value={temporaryId} onChange={(e) => setTemporaryId(e.target.value)}>
            <option value="">Select role...</option>
            {roles.filter((r) => s(r.id) !== originalId).map((r) => <option key={s(r.id)} value={s(r.id)}>{s(r.name) || s(r.code)}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="del-reason">Reason</label>
        <textarea id="del-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Who is away, why, and what authority is being delegated..." />
      </div>
      <div className="two-col">
        <div className="field">
          <label htmlFor="del-from">Valid from</label>
          <input id="del-from" type="datetime-local" value={startsAt} min={today} onChange={(e) => setStartsAt(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="del-to">Expires</label>
          <input id="del-to" type="datetime-local" value={expiresAt} min={startsAt || today} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="del-limit">Approval limit (UGX, optional)</label>
        <input id="del-limit" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="e.g. 50000000" />
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        The draft can be edited and given transaction-type approval authorities before it is submitted for approval. It never becomes active until approved.
      </p>
    </Modal>
  );
}
// ---------------------------------------------------------------------------
// Delegation desk - acting authority detail
// ---------------------------------------------------------------------------
function userLabelOf(r: Row): string {
  const n = fullName(r);
  const em = s(r.email);
  const jt = s(r.jobTitle) || s(r.positionTitle);
  return (n === '-' ? em : n + (jt ? ' - ' + jt : '')) + (em ? ' (' + em + ')' : '');
}

async function govLifecycle(base: string, action: string, reason: string): Promise<Row> {
  const res = await api<{ data: Row }>(base + '/' + action, {
    method: 'POST',
    body: JSON.stringify(reason && reason.trim() ? { reason: reason.trim() } : {}),
  });
  return res.data;
}

type LifecycleAction = { action: string; label: string; danger?: boolean; primary?: boolean; prompt: string };

function AuthorityModal({ delegationId, edit, onClose, onSaved }: {
  delegationId: number;
  edit: Row | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tx, setTx] = useState(edit ? s(edit.transactionType) : '');
  const [canApprove, setCanApprove] = useState(edit ? !(edit.canApprove === false || edit.canApprove === 'false') : true);
  const [canCreate, setCanCreate] = useState(edit ? edit.canCreate === true || edit.canCreate === 'true' : false);
  const [limit, setLimit] = useState(edit && edit.maxAmount !== null && edit.maxAmount !== undefined ? String(edit.maxAmount) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const issues: string[] = [];
    if (!tx.trim()) issues.push('Choose a transaction type.');
    const lim = limit === '' ? undefined : Number(limit);
    if (lim !== undefined && (!Number.isFinite(lim) || lim < 0)) issues.push('The approval limit must be zero or a positive amount.');
    if (issues.length) { setError(issues.join(' ')); return; }
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = { transactionType: tx.trim().toUpperCase(), canApprove, canCreate };
      if (lim !== undefined) body.maxAmount = lim;
      const base = '/api/ops/governance/delegations/' + delegationId + '/authorities';
      if (edit) {
        const upd: Record<string, unknown> = { canApprove, canCreate };
        if (lim !== undefined) upd.maxAmount = lim;
        await api(base + '/' + s(edit.id), { method: 'PATCH', body: JSON.stringify(upd) });
      } else {
        await api(base, { method: 'POST', body: JSON.stringify(body) });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the authority.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={edit ? 'Edit authority limit' : 'Add authority limit'} onClose={onClose} footer={(
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    )}>
      {error && <ErrorBanner error={error} />}
      <div className="field">
        <label htmlFor="auth-tx">Transaction type</label>
        <select id="auth-tx" value={tx} onChange={(e) => setTx(e.target.value)} disabled={!!edit}>
          <option value="">Select transaction type...</option>
          {TX_TYPES.map((t) => <option key={t} value={t}>{labelize(t)}</option>)}
        </select>
        {edit && <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>The transaction type cannot be changed; edit its flags and limit instead.</p>}
      </div>
      <div className="two-col">
        <label className="filter-check">
          <input type="checkbox" checked={canApprove} onChange={(e) => setCanApprove(e.target.checked)} />
          Can approve transactions
        </label>
        <label className="filter-check">
          <input type="checkbox" checked={canCreate} onChange={(e) => setCanCreate(e.target.checked)} />
          Can create transactions
        </label>
      </div>
      <div className="field">
        <label htmlFor="auth-limit">Maximum amount (UGX, optional)</label>
        <input id="auth-limit" type="number" min="0" step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No amount ceiling" />
      </div>
    </Modal>
  );
}

function DelegationDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [del, setDel] = useState<Row | null>(null);
  const [auths, setAuths] = useState<Row[]>([]);
  const [hist, setHist] = useState<Row[]>([]);
  const [users, setUsers] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<LifecycleAction | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [authEdit, setAuthEdit] = useState<Row | null>(null);
  const [authDel, setAuthDel] = useState<Row | null>(null);

  const status = s(del?.status);
  const canView = can(user, 'governance.delegations.view');
  const admin = isGovAdmin(user);
  const owner = !!del && Number(del.delegatorUserId) === user?.id;
  const ownerAdmin = owner || admin;
  const delegatorIsMe = !!del && Number(del.delegatorUserId) === user?.id;
  const delegateIsMe = !!del && Number(del.delegateUserId) === user?.id;
  const editable = status === 'DRAFT' || status === 'PENDING_APPROVAL';
  const canEditAuth = editable && ownerAdmin && can(user, 'governance.delegation_authorities.create');
  const canDelAuth = editable && ownerAdmin && can(user, 'governance.delegation_authorities.delete');

  const actorName = (v: unknown): string => {
    const uid = Number(v);
    if (!uid) return '-';
    const u = users.find((x) => Number(x.id) === uid);
    return u ? userLabelOf(u) : 'User #' + uid;
  };

  const loadDetail = () => {
    setLoading(true);
    setError('');
    Promise.all([
      api<{ data: { delegation: Row | null; authorities: Row[]; history: Row[] } }>('/api/ops/governance/delegations/' + id + '/detail'),
      api<{ data: { data: Row[] } }>('/api/admin/users?page=1&pageSize=200'),
    ])
      .then(([d, u]) => {
        setDel(d.data?.delegation ?? null);
        setAuths(Array.isArray(d.data?.authorities) ? d.data.authorities : []);
        setHist(Array.isArray(d.data?.history) ? d.data.history : []);
        setUsers(Array.isArray(u.data?.data) ? u.data.data : []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Delegation failed to load'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { loadDetail(); /* eslint-disable-line */ }, [id]);

  const runAction = async (act: LifecycleAction, reason: string) => {
    if (!del) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const fresh = await govLifecycle('/api/ops/governance/delegations/' + id, act.action, reason);
      setDel(fresh);
      setNotice(act.label + ' complete - ' + s(fresh.status) + '.');
      setPending(null);
      const detail = await api<{ data: { delegation: Row | null; authorities: Row[]; history: Row[] } }>('/api/ops/governance/delegations/' + id + '/detail');
      setDel(detail.data?.delegation ?? fresh);
      setAuths(Array.isArray(detail.data?.authorities) ? detail.data.authorities : []);
      setHist(Array.isArray(detail.data?.history) ? detail.data.history : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
      setPending(null);
    } finally {
      setSaving(false);
    }
  };

  const deleteAuthority = async (reason: string) => {
    if (!authDel || !del) return;
    setSaving(true);
    setError('');
    try {
      await api('/api/ops/governance/delegations/' + id + '/authorities/' + s(authDel.id), {
        method: 'DELETE',
        body: JSON.stringify({ reason: reason && reason.trim() ? reason.trim() : undefined }),
      });
      setNotice('Authority limit removed from ' + s(del.code) + '.');
      setAuthDel(null);
      loadDetail();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the authority.');
      setAuthDel(null);
    } finally {
      setSaving(false);
    }
  };

  const actions: LifecycleAction[] = [];
  const addAct = (action: string, label: string, perm: string, opts: { danger?: boolean; primary?: boolean; prompt?: string } = {}) => {
    if (!can(user, perm) || !ownerAdmin) return;
    actions.push({
      action, label, danger: opts.danger, primary: opts.primary,
      prompt: opts.prompt ?? 'This changes the state of ' + s(del?.code) + ' and is written to the audit trail with your name and reason.',
    });
  };
  if (status === 'DRAFT') addAct('submit', 'Submit for approval', 'governance.delegations.submit', { primary: true });
  if (status === 'DRAFT' || status === 'PENDING_APPROVAL' || status === 'APPROVED') addAct('cancel', 'Cancel delegation', 'governance.delegations.cancel');
  if (status === 'PENDING_APPROVAL') {
    if (!delegatorIsMe && !delegateIsMe && can(user, 'governance.delegations.approve')) {
      actions.push({ action: 'approve', label: 'Approve', primary: true, prompt: 'Approving activates the acting authority inside its window and notifies the delegate.' });
    }
    if (!delegatorIsMe && can(user, 'governance.delegations.reject')) {
      actions.push({ action: 'reject', label: 'Reject', danger: true, prompt: 'The delegator is notified and the delegation cannot be used.' });
    }
  }
  if (status === 'ACTIVE') {
    addAct('suspend', 'Suspend', 'governance.delegations.suspend');
    addAct('revoke', 'Revoke', 'governance.delegations.revoke', { danger: true });
    addAct('expire', 'Mark expired', 'governance.delegations.expire', { danger: true });
  }
  if (status === 'APPROVED') {
    addAct('revoke', 'Revoke', 'governance.delegations.revoke', { danger: true });
    addAct('expire', 'Mark expired', 'governance.delegations.expire', { danger: true });
  }
  if (status === 'SUSPENDED') {
    addAct('resume', 'Resume', 'governance.delegations.resume', { primary: true });
    addAct('revoke', 'Revoke', 'governance.delegations.revoke', { danger: true });
  }

  if (!canView) return <NoAccess what="delegations" />;
  if (loading) {
    return (
      <div className="page">
        <GovHeader title="Delegation" sub="Loading the acting authority record..." />
        <Skeleton rows={10} />
      </div>
    );
  }
  if (!del) {
    return (
      <div className="page">
        <GovHeader title="Delegation not found" sub="The delegation may have been removed or is outside your company scope." />
        {error && <ErrorBanner error={error} />}
        <button className="btn" onClick={() => navigate('/admin/delegations')}>Back to delegations</button>
      </div>
    );
  }

  return (
    <div className="page">
      <GovHeader
        title={'Delegation ' + s(del.code)}
        sub={personName(del, 'delegate') + ' is authorised to act as ' + roleOf(del, 'temporary') + ' on behalf of ' + personName(del, 'delegator') + ' (' + roleOf(del, 'original') + ').'}
        actions={(
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => navigate('/admin/delegations')} disabled={saving}>Back</button>
            {actions.map((a) => (
              <button key={a.action} className={'btn ' + (a.danger ? 'btn-danger' : a.primary ? 'btn-primary' : '')} disabled={saving} onClick={() => setPending(a)}>{a.label}</button>
            ))}
          </div>
        )}
      />
      {error && <ErrorBanner error={error} />}
      {notice && <div className="notice-banner" style={{ margin: '0 0 14px' }}>{notice}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Badge value={s(del.status)} />
        <span className="muted" style={{ fontSize: 13 }}>Started {fmtDate(del.startsAt)}</span>
        <span className="muted" style={{ fontSize: 13 }}>Expires {fmtDate(del.expiresAt)}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 14 }}>
        <DefSec icon="D" title="Acting arrangement" sub="Who acts, in which role, and on whose behalf">
          <DefRow k="Delegate" v={personName(del, 'delegate')} />
          <DefRow k="Temporary role" v={s(del.temporaryRoleName) || s(del.temporaryRoleCode)} />
          <DefRow k="Delegator" v={personName(del, 'delegator')} />
          <DefRow k="Original role" v={s(del.originalRoleName) || s(del.originalRoleCode)} />
          <DefRow k="Code" v={s(del.code)} mono />
        </DefSec>
        <DefSec icon="W" title="Window and governance" sub="Time-boxed authority and approval controls">
          <DefRow k="Valid from" v={fmtDate(del.startsAt)} />
          <DefRow k="Expires" v={fmtDate(del.expiresAt)} />
          <DefRow k="Approval limit" v={fmtAmount(del.approvalLimit)} mono />
          <DefRow k="Approved by" v={del.approvedAt ? actorName(del.approverUserId) + ' on ' + fmtDate(del.approvedAt) : 'Not yet approved'} />
          <DefRow k="Updated" v={fmtDate(del.updatedAt)} />
        </DefSec>
      </div>
      <div className="card card-pad" style={{ marginTop: 14 }}>
        <div className="card-head">
          <div>
            <h3>Reason</h3>
          </div>
        </div>
        <p className="muted" style={{ margin: 0 }}>{s(del.reason) || 'No reason recorded.'}</p>
      </div>
      <section className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <div>
            <h3>Authority limits</h3>
            <span className="muted" style={{ fontSize: 12 }}>Per-transaction-type approval ceilings. Editable while the delegation is DRAFT or PENDING_APPROVAL.</span>
          </div>
          {canEditAuth && <div className="head-actions"><button className="btn btn-sm btn-primary" onClick={() => { setAuthEdit(null); setShowAuth(true); }}>Add authority</button></div>}
        </div>
        {auths.length === 0 ? <div className="card-pad"><p className="muted" style={{ margin: 0 }}>No per-transaction authority limits yet. The temporary role permissions apply without an amount ceiling.</p></div> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Transaction type</th><th>Approve</th><th>Create</th><th>Maximum amount</th><th></th></tr></thead>
              <tbody>
                {auths.map((a) => (
                  <tr key={s(a.id)}>
                    <td><strong>{labelize(a.transactionType)}</strong></td>
                    <td><Badge value={(a.canApprove === true || a.canApprove === 'true') ? 'Yes' : 'No'} /></td>
                    <td><Badge value={(a.canCreate === true || a.canCreate === 'true') ? 'Yes' : 'No'} /></td>
                    <td className="td-cell-mono">{fmtAmount(a.maxAmount)}</td>
                    <td>
                      <div className="btn-row" style={{ justifyContent: 'flex-end', margin: 0 }}>
                        {canEditAuth && <button className="btn btn-sm" disabled={saving} onClick={() => { setAuthEdit(a); setShowAuth(true); }}>Edit</button>}
                        {canDelAuth && <button className="btn btn-sm btn-danger" disabled={saving} onClick={() => setAuthDel(a)}>Remove</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card" style={{ marginTop: 14 }}>
        <div className="card-head"><h3>Status history</h3><span className="badge badge-neutral">{hist.length}</span></div>
        {hist.length === 0 ? <div className="card-pad"><p className="muted" style={{ margin: 0 }}>No status changes yet.</p></div> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Change</th><th>Reason</th><th>By</th></tr></thead>
              <tbody>
                {hist.map((h) => (
                  <tr key={s(h.id)}>
                    <td className="td-cell-mono">{fmtDate(h.createdAt)}</td>
                    <td>{labelize(h.fromStatus)} {'\u2192'} {labelize(h.toStatus)}</td>
                    <td>{s(h.reason) || '-'}</td>
                    <td>{actorName(h.changedBy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {showAuth && (
        <AuthorityModal
          delegationId={id}
          edit={authEdit}
          onClose={() => setShowAuth(false)}
          onSaved={() => { setShowAuth(false); setNotice(authEdit ? 'Authority limit updated.' : 'Authority limit added.'); loadDetail(); }}
        />
      )}
      {pending && (
        <ConfirmDialog
          title={pending.label}
          body={pending.prompt}
          confirmLabel={pending.label}
          danger={pending.danger}
          onCancel={() => setPending(null)}
          onConfirm={(reason) => runAction(pending, reason)}
        />
      )}
      {authDel && (
        <ConfirmDialog
          title="Remove authority limit"
          body={'Remove ' + labelize(authDel.transactionType) + ' from ' + s(del.code) + '? This is written to the audit trail.'}
          confirmLabel="Remove"
          danger
          onCancel={() => setAuthDel(null)}
          onConfirm={(reason) => deleteAuthority(reason)}
        />
      )}
    </div>
  );
}
// ---------------------------------------------------------------------------
// Signature authority center - digital signature profiles
// ---------------------------------------------------------------------------
function SignaturesCenter() {
  const { user } = useAuth();
  const company = useCompanyProfile();
  const q = useHashQuery();
  const status = q.get('status') ?? '';
  const mine = q.get('mine') === '1';
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const canCreate = can(user, 'governance.signature_profiles.create');

  const setQuery = (next: { status?: string; mine?: boolean }) => {
    const st = next.status !== undefined ? next.status : status;
    const mn = next.mine !== undefined ? next.mine : mine;
    navigate('/admin/signatures', {
      replace: true,
      query: { status: st || undefined, mine: mn ? 1 : undefined },
    });
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (mine && user) params.set('userId', String(user.id));
    api<{ data: Row[] }>('/api/ops/governance/signature-profiles?' + params.toString())
      .then((r) => { if (alive) setRows(Array.isArray(r.data) ? r.data : []); })
      .catch((e) => { if (alive) { setError(e instanceof Error ? e.message : 'Signature profiles failed to load'); setRows([]); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [status, mine, user, tick]);

  useEffect(() => {
    let alive = true;
    api<{ data: { signatures: Row } }>('/api/ops/governance/dashboard')
      .then((r) => { if (alive && r.data?.signatures) setSummary(r.data.signatures); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [tick]);

  return (
    <div className="page">
      <GovHeader
        title="Signature authority"
        sub={'Official-document signing authority for ' + company.name + '. Signature profiles carry approval-limited authority scopes; only ACTIVE profiles inside their effective window can sign, and every applied signature is snapshotted, audited and QR-verifiable. Historical signatures are never changed when a profile is later suspended or revoked.'}
        actions={canCreate ? <button className="btn btn-primary" onClick={() => setShowNew(true)}>New signature profile</button> : undefined}
      />
      <GovSubNav active="signatures" />
      <div className="kpi-grid--tiles">
        <GovKpi label="Active signatures" value={summary ? Number(s(summary.active)) : '-'} sub="Authorized to sign inside their window" icon="pen" accent="#0b8f5f" tint="rgba(11,143,95,0.10)" onClick={() => setQuery({ status: 'ACTIVE' })} />
        <GovKpi label="Awaiting approval" value={summary ? Number(s(summary.pending)) : '-'} sub="Profiles submitted but not yet approved" icon="clock" accent="#d97706" tint="rgba(217,119,6,0.10)" onClick={() => setQuery({ status: 'PENDING' })} />
        <GovKpi label="Scope approvals" value={summary ? Number(s(summary.pendingScopes)) : '-'} sub="Document-type authorities awaiting approval" icon="shield" accent="#2563eb" tint="rgba(37,99,235,0.10)" />
        <GovKpi label="Expiring soon" value={summary ? Number(s(summary.expiringSoon)) : '-'} sub="Active or pending profiles expiring within 14 days" icon="alert" accent="#dc2626" tint="rgba(220,38,38,0.10)" />
      </div>
      <GovFilterBar
        statuses={SIG_STATUSES}
        current={status}
        mine={mine}
        mineLabel="Profiles I own"
        onStatus={(st) => setQuery({ status: st })}
        onMine={(v) => setQuery({ mine: v })}
      />
      {error && <ErrorBanner error={error} />}
      {loading ? <Skeleton rows={8} /> : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Signatory</th><th>Authority level</th><th>Window</th><th>Approved scopes</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={s(r.id)} className="row-link" onClick={() => navigate('/admin/signatures/' + s(r.id))}>
                  <td>
                    <strong>{fullName(r) !== '-' ? fullName(r) : s(r.fullName)}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>{s(r.positionTitle) || s(r.email)}{Number(r.userId) === user?.id ? ' - my profile' : ''}</div>
                  </td>
                  <td><Badge value={labelize(s(r.authorityLevel))} /></td>
                  <td>
                    <div className="td-cell-mono">{r.effectiveFrom ? fmtDate(r.effectiveFrom) : '-'}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{r.expiresAt ? 'to ' + fmtDate(r.expiresAt) : 'no expiry'}</div>
                  </td>
                  <td className="td-cell-mono">{Number(r.approvedScopes ?? 0)}</td>
                  <td><Badge value={r.status} /></td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5}>
                  <EmptyState
                    title={status || mine ? 'No signature profiles match' : 'No signature profiles yet'}
                    body={status || mine
                      ? 'No signature profiles match the selected filter. Clear the filters to see every profile.'
                      : 'Create a signature profile for an authorized employee so their signature can be applied to approved official documents with a full audit snapshot.'}
                    action={canCreate ? 'New signature profile' : undefined}
                    onAction={canCreate ? () => setShowNew(true) : undefined}
                  />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {showNew && (
        <NewSignatureModal
          onClose={() => setShowNew(false)}
          onSaved={(id) => navigate('/admin/signatures/' + id)}
        />
      )}
    </div>
  );
}

function NewSignatureModal({ edit, onClose, onSaved }: {
  edit?: Row | null;
  onClose: () => void;
  onSaved: (id: number) => void;
}) {
  const { user: me } = useAuth();
  const editing = !!edit;
  const admin = isGovAdmin(me);
  const myName = (s(me?.first_name) + ' ' + s(me?.last_name)).trim();
  const [users, setUsers] = useState<Row[]>([]);
  const [loadError, setLoadError] = useState('');
  const [userId, setUserId] = useState(editing ? s(edit?.userId) : String(me?.id ?? ''));
  const [fullName, setFullName] = useState(editing ? s(edit?.fullName) : myName);
  const [positionTitle, setPositionTitle] = useState(editing ? s(edit?.positionTitle) : s(me?.job_title) || '');
  const [level, setLevel] = useState(editing ? s(edit?.authorityLevel) || 'OTHER' : 'OTHER');
  const [effectiveFrom, setEffectiveFrom] = useState(editing ? toLocalInput(edit?.effectiveFrom) : toLocalInput(new Date().toISOString()));
  const [expiresAt, setExpiresAt] = useState(editing ? toLocalInput(edit?.expiresAt) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    if (editing) return;
    api<{ data: { data: Row[] } }>('/api/admin/users?page=1&pageSize=200')
      .then((r) => {
        if (!alive) return;
        const list = Array.isArray(r.data?.data) ? r.data.data : [];
        setUsers(list);
        const mineRow = list.find((u) => Number(u.id) === me?.id);
        if (mineRow) {
          setFullName((s(mineRow.firstName) + ' ' + s(mineRow.lastName)).trim() || myName);
          setPositionTitle(s(mineRow.jobTitle) || s(mineRow.positionTitle) || '');
        }
      })
      .catch((e) => { if (alive) setLoadError(e instanceof Error ? e.message : 'Could not load users'); });
    return () => { alive = false; };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [editing]);

  const applyUser = (u: Row) => {
    const n = (s(u.firstName) + ' ' + s(u.lastName)).trim();
    if (n) setFullName(n);
    const jt = s(u.jobTitle) || s(u.positionTitle);
    if (jt) setPositionTitle(jt);
  };

  const submit = async () => {
    const issues: string[] = [];
    if (!fullName.trim()) issues.push('The signatory full name is required.');
    if (!positionTitle.trim()) issues.push('A position title is required so the signature block is accurate.');
    const from = fromLocalInput(effectiveFrom);
    const to = expiresAt ? fromLocalInput(expiresAt) : undefined;
    if (!from) issues.push('Choose a valid effective date and time.');
    else if (to && new Date(to).getTime() <= new Date(from).getTime()) issues.push('Expiry must be after the effective date.');
    if (issues.length) { setError(issues.join(' ')); return; }
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        fullName: fullName.trim(),
        positionTitle: positionTitle.trim(),
        authorityLevel: level,
        effectiveFrom: from,
      };
      if (to) body.expiresAt = to;
      if (!editing && admin && userId && Number(userId) !== me?.id) body.userId = Number(userId);
      let id = Number(edit?.id);
      if (editing) {
        await api('/api/ops/governance/signature-profiles/' + id, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        const res = await api<{ data: Row }>('/api/ops/governance/signature-profiles', { method: 'POST', body: JSON.stringify(body) });
        id = Number(res.data.id);
      }
      onSaved(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the signature profile.');
    } finally {
      setSaving(false);
    }
  };

  const today = toLocalInput(new Date().toISOString());
  return (
    <Modal title={editing ? 'Edit signature profile' : 'New signature profile'} onClose={onClose} wide
      footer={(
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Save profile'}</button>
        </div>
      )}
    >
      {loadError && <ErrorBanner error={loadError} />}
      {error && <ErrorBanner error={error} />}
      {editing ? (
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Editing refreshes the profile identity and window. Changes are written to the audit trail; already-signed documents keep their original signature snapshot.</p>
      ) : (
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>A signature profile authorizes one person to sign approved documents. Governance administrator for this account: {govAdminLabel(me)}. Only a governance administrator can create a profile on behalf of another user.</p>
      )}
      {!editing && admin && (
        <div className="field">
          <label htmlFor="sig-user">User</label>
          <select id="sig-user" value={userId} onChange={(e) => {
            const v = e.target.value;
            setUserId(v);
            const picked = users.find((u) => s(u.id) === v);
            if (picked) applyUser(picked);
          }}>
            <option value="">Select user...</option>
            {users.filter((u) => s(u.status) === 'ACTIVE' || Number(u.id) === me?.id).map((u) => (
              <option key={s(u.id)} value={s(u.id)}>{userLabelOf(u)}</option>
            ))}
          </select>
        </div>
      )}
      {!editing && !admin && (
        <div className="def-sec">
          <div className="def-row"><span className="def-k">Profile owner</span><span className="def-v">{myName} ({s(me?.email)})</span></div>
        </div>
      )}
      <div className="two-col">
        <div className="field">
          <label htmlFor="sig-name">Full name on signature</label>
          <input id="sig-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sig-title">Position title</label>
          <input id="sig-title" value={positionTitle} onChange={(e) => setPositionTitle(e.target.value)} placeholder="e.g. Managing Director" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="sig-level">Authority level</label>
        <select id="sig-level" value={level} onChange={(e) => setLevel(e.target.value)}>
          {SIG_LEVELS.map((lv) => <option key={lv} value={lv}>{labelize(lv)}</option>)}
        </select>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>The level describes the class of documents the person may be authorized to sign. Actual signing rights come from APPROVED document-type authority scopes.</p>
      </div>
      <div className="two-col">
        <div className="field">
          <label htmlFor="sig-from">Effective from</label>
          <input id="sig-from" type="datetime-local" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sig-to">Expires (optional)</label>
          <input id="sig-to" type="datetime-local" value={expiresAt} min={effectiveFrom || today} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}
// ---------------------------------------------------------------------------
// Signature profile desk - document signing authority detail
// ---------------------------------------------------------------------------
function SignatureScopeModal({ profileId, edit, onClose, onSaved }: {
  profileId: number;
  edit: Row | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [docType, setDocType] = useState(edit ? s(edit.documentType) : '');
  const [txType, setTxType] = useState(edit ? s(edit.transactionType) : '');
  const [limit, setLimit] = useState(edit && edit.maxAmount !== null && edit.maxAmount !== undefined ? String(edit.maxAmount) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const issues: string[] = [];
    if (!docType.trim()) issues.push('Choose a document type.');
    const lim = limit === '' ? undefined : Number(limit);
    if (lim !== undefined && (!Number.isFinite(lim) || lim < 0)) issues.push('The maximum amount must be zero or a positive amount.');
    if (issues.length) { setError(issues.join(' ')); return; }
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = { documentType: docType.trim() };
      if (txType.trim()) body.transactionType = txType.trim().toUpperCase();
      if (lim !== undefined) body.maxAmount = lim;
      const base = '/api/ops/governance/signature-profiles/' + profileId + '/scopes';
      if (edit) {
        await api(base + '/' + s(edit.id), { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        await api(base, { method: 'POST', body: JSON.stringify(body) });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the authority scope.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={edit ? 'Edit document authority' : 'Add document authority'} onClose={onClose}
      footer={(
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Save authority'}</button>
        </div>
      )}
    >
      {error && <ErrorBanner error={error} />}
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        {edit
          ? 'Editing a scope resets it to PENDING when the document type or limits change; a governance approver must approve it again before it grants signing rights.'
          : 'A signature authority scope defines which classes of official documents this signatory may sign. The new scope is PENDING and only grants signing rights once approved by a governance approver.'}
      </p>
      <div className="field">
        <label htmlFor="sc-doc">Document type</label>
        <select id="sc-doc" value={docType} onChange={(e) => setDocType(e.target.value)} disabled={!!edit}>
          <option value="">Select document type...</option>
          {DOC_TYPES.map((t) => <option key={t} value={t}>{labelize(t)}</option>)}
        </select>
        {edit && <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>The document type cannot be changed here; remove this scope and add a new one instead.</p>}
      </div>
      <div className="field">
        <label htmlFor="sc-tx">Transaction type (optional)</label>
        <select id="sc-tx" value={txType} onChange={(e) => setTxType(e.target.value)}>
          <option value="">Any transaction type</option>
          {TX_TYPES.map((t) => <option key={t} value={t}>{labelize(t)}</option>)}
        </select>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Leave as "Any transaction type" when the authority applies across the document class.</p>
      </div>
      <div className="field">
        <label htmlFor="sc-limit">Maximum amount (UGX, optional)</label>
        <input id="sc-limit" type="number" min="0" step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No amount ceiling" />
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        The scope inherits the signature profile's company, branch and department scope. The person who creates a scope cannot approve or reject it (segregation of duties).
      </p>
    </Modal>
  );
}

function SignatureDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [profile, setProfile] = useState<Row | null>(null);
  const [scopes, setScopes] = useState<Row[]>([]);
  const [users, setUsers] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<LifecycleAction | null>(null);
  const [scopeDecision, setScopeDecision] = useState<{ scope: Row; action: 'approve' | 'reject' } | null>(null);
  const [scopeDel, setScopeDel] = useState<Row | null>(null);
  const [showScope, setShowScope] = useState(false);
  const [scopeEdit, setScopeEdit] = useState<Row | null>(null);
  const [showEditProfile, setShowEditProfile] = useState(false);

  const status = s(profile?.status);
  const canView = can(user, 'governance.signature_profiles.view');
  const admin = isGovAdmin(user);
  const owner = !!profile && Number(profile.userId) === user?.id;
  const ownerAdmin = owner || admin;
  const canEditProfile = ownerAdmin && can(user, 'governance.signature_profiles.update') &&
    (status === 'DRAFT' || status === 'PENDING' || status === 'SUSPENDED' || status === 'REJECTED');
  const canAddScope = ownerAdmin && can(user, 'governance.signature_authority_scopes.create') &&
    status !== 'REVOKED' && status !== 'EXPIRED';
  const canEditScope = ownerAdmin && can(user, 'governance.signature_authority_scopes.update') &&
    status !== 'REVOKED' && status !== 'EXPIRED';
  const canDelScope = ownerAdmin && can(user, 'governance.signature_authority_scopes.delete') &&
    status !== 'REVOKED' && status !== 'EXPIRED';

  const actorName = (v: unknown): string => {
    const uid = Number(v);
    if (!uid) return '-';
    const u = users.find((x) => Number(x.id) === uid);
    return u ? userLabelOf(u) : 'User #' + uid;
  };

  const loadDetail = () => {
    setLoading(true);
    setError('');
    Promise.all([
      api<{ data: { profile: Row; scopes: Row[] } }>('/api/ops/governance/signature-profiles/' + id + '/detail'),
      api<{ data: { data: Row[] } }>('/api/admin/users?page=1&pageSize=200'),
    ])
      .then(([d, u]) => {
        setProfile(d.data?.profile ?? null);
        setScopes(Array.isArray(d.data?.scopes) ? d.data.scopes : []);
        setUsers(Array.isArray(u.data?.data) ? u.data.data : []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Signature profile failed to load'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { loadDetail(); /* eslint-disable-line */ }, [id]);

  const runAction = async (act: LifecycleAction, reason: string) => {
    if (!profile) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const fresh = await govLifecycle('/api/ops/governance/signature-profiles/' + id, act.action, reason);
      setNotice(act.label + ' complete - ' + s(fresh.status) + '.');
      setPending(null);
      loadDetail();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
      setPending(null);
    } finally {
      setSaving(false);
    }
  };

  const decideScope = async (reason: string) => {
    if (!scopeDecision) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const scope = scopeDecision.scope;
      const fresh = await govLifecycle('/api/ops/governance/signature-profiles/' + id + '/scopes/' + s(scope.id), scopeDecision.action, reason);
      setNotice('Document authority ' + labelize(scope.documentType) + ' is now ' + s(fresh.status) + '.');
      setScopeDecision(null);
      loadDetail();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The decision could not be saved.');
      setScopeDecision(null);
    } finally {
      setSaving(false);
    }
  };

  const deleteScope = async () => {
    if (!scopeDel || !profile) return;
    setSaving(true);
    setError('');
    try {
      await api('/api/ops/governance/signature-profiles/' + id + '/scopes/' + s(scopeDel.id), { method: 'DELETE' });
      setNotice('Document authority ' + labelize(scopeDel.documentType) + ' removed from ' + s(profile.fullName) + '.');
      setScopeDel(null);
      loadDetail();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the authority.');
      setScopeDel(null);
    } finally {
      setSaving(false);
    }
  };

  const actions: LifecycleAction[] = [];
  const addAdminAct = (action: string, label: string, perm: string, opts: { danger?: boolean; primary?: boolean; prompt?: string } = {}) => {
    if (!admin || !can(user, perm)) return;
    actions.push({
      action, label, danger: opts.danger, primary: opts.primary,
      prompt: opts.prompt ?? 'This changes the state of signature profile #' + id + ' and is written to the audit trail with your name and reason.',
    });
  };
  if (status === 'DRAFT' && ownerAdmin && can(user, 'governance.signature_profiles.submit')) {
    actions.push({ action: 'submit', label: 'Submit for approval', primary: true, prompt: 'Submitting requests a governance approver to activate this signature profile. The profile can still be edited while pending.' });
  }
  if (status === 'PENDING') {
    if (!owner && can(user, 'governance.signature_profiles.approve')) {
      actions.push({ action: 'approve', label: 'Approve', primary: true, prompt: 'Approving activates the signature profile when it is inside its effective window and notifies the signatory.' });
    }
    if (!owner && can(user, 'governance.signature_profiles.reject')) {
      actions.push({ action: 'reject', label: 'Reject', danger: true, prompt: 'The signatory is notified and the profile cannot sign documents until it is activated again.' });
    }
    if (profile && profile.approvedAt) {
      addAdminAct('activate', 'Activate', 'governance.signature_profiles.activate', { primary: true });
    }
    addAdminAct('revoke', 'Revoke', 'governance.signature_profiles.revoke', { danger: true });
    addAdminAct('expire', 'Mark expired', 'governance.signature_profiles.expire', { danger: true });
  }
  if (status === 'ACTIVE') {
    addAdminAct('suspend', 'Suspend', 'governance.signature_profiles.suspend');
    addAdminAct('expire', 'Mark expired', 'governance.signature_profiles.expire', { danger: true });
    addAdminAct('revoke', 'Revoke', 'governance.signature_profiles.revoke', { danger: true });
  }
  if (status === 'SUSPENDED' || status === 'REJECTED') {
    addAdminAct('activate', 'Activate', 'governance.signature_profiles.activate', { primary: true });
    addAdminAct('revoke', 'Revoke', 'governance.signature_profiles.revoke', { danger: true });
  }

  if (!canView) return <NoAccess what="signature profiles" />;
  if (loading) {
    return (
      <div className="page">
        <GovHeader title="Signature profile" sub="Loading the signature authority record..." />
        <Skeleton rows={10} />
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="page">
        <GovHeader title="Signature profile not found" sub="The profile may have been removed or is outside your company scope." />
        {error && <ErrorBanner error={error} />}
        <button className="btn" onClick={() => navigate('/admin/signatures')}>Back to signatures</button>
      </div>
    );
  }

  const name = s(profile.fullName) || fullName(profile);
  return (
    <div className="page">
      <GovHeader
        title={'Signature profile #' + id}
        sub={name + ' (' + (s(profile.positionTitle) || s(profile.email)) + ') is authorised to sign approved official documents inside the window below. Only ACTIVE profiles with APPROVED document-type scopes can sign, and every applied signature is snapshotted, audited and QR-verifiable.'}
        actions={(
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => navigate('/admin/signatures')} disabled={saving}>Back</button>
            {canEditProfile && <button className="btn" disabled={saving} onClick={() => setShowEditProfile(true)}>Edit profile</button>}
            {actions.map((a) => (
              <button key={a.action} className={'btn ' + (a.danger ? 'btn-danger' : a.primary ? 'btn-primary' : '')} disabled={saving} onClick={() => setPending(a)}>{a.label}</button>
            ))}
          </div>
        )}
      />
      {error && <ErrorBanner error={error} />}
      {notice && <div className="notice-banner" style={{ margin: '0 0 14px' }}>{notice}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Badge value={status} />
        <span className="muted" style={{ fontSize: 13 }}>Effective {fmtDate(profile.effectiveFrom)}</span>
        <span className="muted" style={{ fontSize: 13 }}>{profile.expiresAt ? 'Expires ' + fmtDate(profile.expiresAt) : 'No expiry'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 14 }}>
        <DefSec icon="S" title="Signatory" sub="Who is authorised to sign official documents">
          <DefRow k="Name" v={name} />
          <DefRow k="Position title" v={s(profile.positionTitle) || '-'} />
          <DefRow k="Email" v={s(profile.email) || '-'} />
          <DefRow k="Employee ID" v={s(profile.employeeId) || '-'} mono />
          <DefRow k="Authority level" v={s(profile.authorityLevel) ? labelize(s(profile.authorityLevel)) : '-'} />
        </DefSec>
        <DefSec icon="G" title="Governance record" sub="Who controls the profile and what changed it">
          <DefRow k="Profile owner" v={actorName(profile.userId)} />
          <DefRow k="Approved by" v={profile.approvedAt ? actorName(profile.approvedBy) + ' on ' + fmtDate(profile.approvedAt) : 'Not yet approved'} />
          <DefRow k="Suspended by" v={profile.suspendedAt ? actorName(profile.suspendedBy) + ' on ' + fmtDate(profile.suspendedAt) : '-'} />
          <DefRow k="Revoked by" v={profile.revokedAt ? actorName(profile.revokedBy) + ' on ' + fmtDate(profile.revokedAt) : '-'} />
          <DefRow k="Rejected by" v={profile.rejectedAt ? actorName(profile.rejectedBy) + ' on ' + fmtDate(profile.rejectedAt) : '-'} />
        </DefSec>
      </div>
      <div className="card card-pad" style={{ marginTop: 14 }}>
        <div className="card-head">
          <div>
            <h3>Latest status note</h3>
          </div>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {s(profile.suspendedReason) || s(profile.revokedReason) || s(profile.rejectedReason) || 'No status notes recorded. The profile is ' + labelize(status) + '.'}
        </p>
      </div>
      <section className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <div>
            <h3>Document-type authority scopes</h3>
            <span className="muted" style={{ fontSize: 12 }}>The classes of official documents this signatory may sign. Only APPROVED scopes grant signing rights, capped by the maximum amount.</span>
          </div>
          {canAddScope && <div className="head-actions"><button className="btn btn-sm btn-primary" onClick={() => { setScopeEdit(null); setShowScope(true); }}>Add authority</button></div>}
        </div>
        {scopes.length === 0 ? <div className="card-pad"><p className="muted" style={{ margin: 0 }}>No document-type authority scopes yet. Add one to define which approved documents this signatory may sign.</p></div> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Document type</th><th>Transaction type</th><th>Maximum amount</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {scopes.map((sc) => {
                  const mine = Number(sc.createdBy) === user?.id;
                  const canDecide = s(sc.status) === 'PENDING' && can(user, 'governance.signature_authority_scopes.approve') && !mine;
                  return (
                    <tr key={s(sc.id)}>
                      <td><strong>{labelize(sc.documentType)}</strong></td>
                      <td>{s(sc.transactionType) ? labelize(s(sc.transactionType)) : '-'}</td>
                      <td className="td-cell-mono">{fmtAmount(sc.maxAmount)}</td>
                      <td><Badge value={sc.status} /></td>
                      <td>
                        <div className="btn-row" style={{ justifyContent: 'flex-end', margin: 0 }}>
                          {canDecide && <button className="btn btn-sm" disabled={saving} onClick={() => setScopeDecision({ scope: sc, action: 'approve' })}>Approve</button>}
                          {canDecide && <button className="btn btn-sm btn-danger" disabled={saving} onClick={() => setScopeDecision({ scope: sc, action: 'reject' })}>Reject</button>}
                          {canEditScope && <button className="btn btn-sm" disabled={saving} onClick={() => { setScopeEdit(sc); setShowScope(true); }}>Edit</button>}
                          {canDelScope && <button className="btn btn-sm btn-danger" disabled={saving} onClick={() => setScopeDel(sc)}>Remove</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {showScope && (
        <SignatureScopeModal
          profileId={id}
          edit={scopeEdit}
          onClose={() => setShowScope(false)}
          onSaved={() => {
            setShowScope(false);
            setNotice(scopeEdit ? 'Document authority updated.' : 'Document authority added and submitted for approval.');
            loadDetail();
          }}
        />
      )}
      {showEditProfile && (
        <NewSignatureModal
          edit={profile}
          onClose={() => setShowEditProfile(false)}
          onSaved={() => {
            setShowEditProfile(false);
            setNotice('Signature profile updated.');
            loadDetail();
          }}
        />
      )}
      {pending && (
        <ConfirmDialog
          title={pending.label}
          body={pending.prompt}
          confirmLabel={pending.label}
          danger={pending.danger}
          onCancel={() => setPending(null)}
          onConfirm={(reason) => runAction(pending, reason)}
        />
      )}
      {scopeDecision && (
        <ConfirmDialog
          title={scopeDecision.action === 'approve' ? 'Approve document authority' : 'Reject document authority'}
          body={scopeDecision.action === 'approve'
            ? 'Approve ' + labelize(scopeDecision.scope.documentType) + ' signing authority for ' + name + '? The signatory is notified and the approved scope grants signing rights up to its maximum amount.'
            : 'Reject ' + labelize(scopeDecision.scope.documentType) + ' signing authority for ' + name + '? The signatory is notified and the scope cannot be used until approved.'}
          confirmLabel={scopeDecision.action === 'approve' ? 'Approve' : 'Reject'}
          danger={scopeDecision.action === 'reject'}
          onCancel={() => setScopeDecision(null)}
          onConfirm={(reason) => decideScope(reason)}
        />
      )}
      {scopeDel && (
        <ConfirmDialog
          title="Remove document authority"
          body={'Remove ' + labelize(scopeDel.documentType) + ' from ' + name + '? This removes the signing right for that document class and is written to the audit trail.'}
          confirmLabel="Remove"
          danger
          onCancel={() => setScopeDel(null)}
          onConfirm={() => deleteScope()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Governance routing - delegated acting authority + digital signature authority
// ---------------------------------------------------------------------------
export default function GovernanceFlow({ path }: GovProps) {
  const parts = path.split('/').filter(Boolean);
  const depth = parts.length > 2 ? parts[2] : '';
  if (parts[1] === 'delegations') {
    return /^\d+$/.test(depth) ? <DelegationDesk id={Number(depth)} /> : <DelegationsCenter />;
  }
  if (parts[1] === 'signatures') {
    return /^\d+$/.test(depth) ? <SignatureDesk id={Number(depth)} /> : <SignaturesCenter />;
  }
  return <NoAccess what="governance" />;
}
