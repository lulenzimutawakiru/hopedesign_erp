import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDate, fmtMoney, fmtNum, getToken } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader, Pager } from '../components/ui';

type Rec = Record<string, unknown>;

function num(v: unknown, fallback = 0): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function s(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

const DAY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isoDay(v: unknown): string {
  if (!v) return '';
  const str = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    const d = new Date(str);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function fmtDay(v: unknown): string {
  const d = isoDay(v);
  if (!d) return fmtDate(v);
  const [y, mo, day] = d.split('-').map(Number);
  return `${String(day).padStart(2, '0')} ${DAY_MONTHS[mo - 1]} ${y}`;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function personName(row: Rec): string {
  const name = `${s(row.firstName)} ${s(row.lastName)}`.trim();
  return name || s(row.requesterName) || s(row.createdByName) || 'Unknown';
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      title="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function RiskBadge({ row }: { row: Rec }) {
  const level = s(row.riskLevel);
  if (!level) return null;
  const tone = level === 'CRITICAL' ? 'badge-danger' : level === 'HIGH' ? 'badge-danger' : level === 'MEDIUM' ? 'badge-amber' : '';
  return (
    <span className={`badge ${tone}`}>
      {level === 'CRITICAL' || level === 'HIGH' ? '⚠ ' : ''}
      {level.replace(/_/g, ' ')}
    </span>
  );
}

const SPEND_TABS: [string, string][] = [
  ['board', 'Command Center'],
  ['requisitions', 'Requisitions'],
  ['expenses', 'Daily Expenditure'],
  ['petty-cash', 'Petty Cash'],
  ['claims', 'Expense Claims'],
  ['close', 'Daily Close'],
];

function SpendTabs({ active }: { active: string }) {
  return (
    <div className="otc-tabs">
      {SPEND_TABS.map(([key, label]) => (
        <button key={key} className={`tab ${active === key ? 'active' : ''}`} onClick={() => navigate(key === 'board' ? '/spend' : `/spend/${key}`)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function StatusFilter({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select className="search-input" style={{ width: 'auto', maxWidth: 220 }} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All statuses</option>
      {options.map((st) => <option key={st} value={st}>{st.replace(/_/g, ' ')}</option>)}
    </select>
  );
}

function MetaCard({ title, rows }: { title?: string; rows: [string, unknown][] }) {
  const filled = rows.filter(([, v]) => v !== undefined && v !== null && String(v) !== '');
  if (!filled.length) return null;
  return (
    <section className="card">
      {title && <div className="card-head"><h3>{title}</h3></div>}
      <dl className="detail-list">
        {filled.map(([k, v]) => (
          <div className="detail-row" key={k}>
            <dt>{k}</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Pipeline({ steps, status }: { steps: string[]; status: string }) {
  const idx = Math.max(0, steps.indexOf(status));
  const known = steps.includes(status);
  return (
    <ol className="pipeline">
      {steps.map((step, i) => (
        <li key={step} className={`pipeline-step ${known && i <= idx ? 'done' : ''} ${known && i === idx ? 'current' : ''}`}>
          <span className="pipeline-dot">{i + 1}</span>
          <span>{step.replace(/_/g, ' ')}</span>
        </li>
      ))}
    </ol>
  );
}

function parseSpend(path: string): { view: string; id: string | null; action: string | null } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'spend') return { view: 'board', id: null, action: null };
  return { view: parts[1] ?? 'board', id: parts[2] ?? null, action: parts[3] ?? null };
}

export default function SpendFlow({ path }: { path: string }) {
  const { view, id, action } = parseSpend(path);
  if (view === 'requisitions' && id === 'new') return <RequisitionComposer />;
  if (view === 'requisitions' && id && action === 'edit') return <RequisitionComposer editId={Number(id)} />;
  if (view === 'requisitions' && id) return <RequisitionDesk id={Number(id)} />;
  if (view === 'requisitions') return <RequisitionList />;
  if (view === 'expenses' && id === 'new') return <ExpenseForm />;
  if (view === 'expenses' && id) return <ExpenseDesk id={Number(id)} />;
  if (view === 'expenses') return <ExpenseList />;
  if (view === 'petty-cash' && id) return <PettyCashFund id={Number(id)} />;
  if (view === 'petty-cash') return <PettyCashDesk />;
  if (view === 'claims' && id === 'new') return <ClaimForm />;
  if (view === 'claims' && id) return <ClaimDesk id={Number(id)} />;
  if (view === 'claims') return <ClaimsList />;
  if (view === 'close') return <DailyCloseDesk />;
  return <SpendBoard />;
}function SpendBoard() {
  const { user } = useAuth();
  const [dash, setDash] = useState<Rec | null>(null);
  const [reqBoard, setReqBoard] = useState<Rec | null>(null);
  const [expBoard, setExpBoard] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ data: Rec }>('/api/ops/expenditure/dashboard'),
      api<{ data: Rec }>('/api/ops/requisitions/board'),
      api<{ data: Rec }>('/api/ops/expenditure/board'),
    ])
      .then(([d, r, e]) => {
        if (!alive) return;
        setDash(d.data);
        setReqBoard(r.data);
        setExpBoard(e.data);
      })
      .catch((err) => alive && setError(err.message));
    return () => { alive = false; };
  }, []);

  const today = num(dash?.today ? (dash.today as Rec).total : 0);
  const mtd = num(dash?.mtd ? (dash.mtd as Rec).total : 0);
  const budget = dash?.budget as Rec | undefined;
  const pendingReqs = num(reqBoard?.pending ? (reqBoard.pending as Rec).total : 0);
  const pendingExp = (expBoard?.pendingApproval as Rec[] | undefined) ?? [];
  const missingReceipts = (expBoard?.missingReceipts as Rec[] | undefined) ?? [];
  const deptRows = (dash?.spendingByDepartment as Rec[] | undefined) ?? [];
  const maxDept = Math.max(1, ...deptRows.map((d) => num(d.total)));
  const alerts = dash?.alerts as Rec | undefined;

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0, flex: 1 }}>Daily Expenditure Command Center</h1>
        {can(user, 'expenditure.requisitions.create') && (
          <button className="btn btn-primary" onClick={() => navigate('/spend/requisitions/new')}>+ Request</button>
        )}
        {can(user, 'expenditure.expenses.create') && (
          <button className="btn btn-ghost" onClick={() => navigate('/spend/expenses/new')}>+ Record Expense</button>
        )}
      </div>
      {error && <ErrorBanner error={error} />}
      {!dash ? <PageLoader /> : (
        <>
          <div className="kpi-grid">
            <button className="kpi-card" onClick={() => navigate('/spend/expenses')}>
              <span className="kpi-label">Today</span>
              <span className="kpi-value">{fmtMoney(today)}</span>
              <span className="kpi-sub">{num(dash.today ? (dash.today as Rec).count : 0)} transactions</span>
            </button>
            <button className="kpi-card" onClick={() => navigate('/spend/expenses')}>
              <span className="kpi-label">Month to date</span>
              <span className="kpi-value">{fmtMoney(mtd)}</span>
              <span className="kpi-sub">{num(dash.mtd ? (dash.mtd as Rec).count : 0)} transactions</span>
            </button>
            <button className="kpi-card" onClick={() => navigate('/spend/requisitions')}>
              <span className="kpi-label">Budget consumed</span>
              <span className="kpi-value">{budget ? `${num(budget.consumedPct)}%` : '—'}</span>
              <span className="kpi-sub">of {fmtMoney(num(budget?.approved))} approved</span>
            </button>
            <button className="kpi-card" onClick={() => navigate('/spend/requisitions')}>
              <span className="kpi-label">Pending requisitions</span>
              <span className="kpi-value">{pendingReqs}</span>
              <span className="kpi-sub">awaiting approval</span>
            </button>
          </div>

          <div className="kpi-grid">
            <button className="kpi-card" onClick={() => navigate('/spend/petty-cash')}>
              <span className="kpi-label">Petty cash</span>
              <span className="kpi-value">{fmtMoney(num((expBoard?.today as Rec)?.total ?? 0))}</span>
              <span className="kpi-sub">spent today</span>
            </button>
            <button className="kpi-card" onClick={() => navigate('/spend/close')}>
              <span className="kpi-label">Awaiting approval</span>
              <span className="kpi-value">{num(alerts?.pendingApprovals ?? 0) + pendingExp.length}</span>
              <span className="kpi-sub">expenses + requisitions</span>
            </button>
            <button className="kpi-card" onClick={() => navigate('/spend/expenses')}>
              <span className="kpi-label">Missing receipts</span>
              <span className="kpi-value">{num(alerts?.missingReceipts ?? 0)}</span>
              <span className="kpi-sub">expenses without evidence</span>
            </button>
            <button className="kpi-card" onClick={() => navigate('/spend/requisitions')}>
              <span className="kpi-label">Over budget</span>
              <span className="kpi-value">{(alerts?.overBudgetAccounts as Rec[] | undefined)?.length ?? 0}</span>
              <span className="kpi-sub">accounts over position</span>
            </button>
          </div>

          <div className="kpi-grid--tiles" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
            <section className="card">
              <div className="card-head"><h3>Spending by Department (MTD)</h3></div>
              <div style={{ padding: '10px 16px' }}>
                {deptRows.length === 0 && <p className="empty-state">No spending recorded this month.</p>}
                {deptRows.map((d) => (
                  <div key={s(d.id)} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>{s(d.name)}</span>
                      <span>{fmtMoney(num(d.total))} · {num(d.pct)}%</span>
                    </div>
                    <div style={{ height: 8, background: 'var(--line)', borderRadius: 5, marginTop: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${Math.round((num(d.total) / maxDept) * 100)}%`, height: '100%', background: 'var(--mill)', borderRadius: 5 }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="card">
              <div className="card-head"><h3>⚠ Attention Needed</h3></div>
              <div style={{ padding: '6px 16px' }}>
                {pendingExp.length === 0 && missingReceipts.length === 0 && (
                  <p className="empty-state">All clear — nothing needs attention.</p>
                )}
                {pendingExp.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--clay)' }}>
                      {pendingExp.length} expenses awaiting approval
                    </div>
                    {pendingExp.slice(0, 4).map((e) => (
                      <button key={s(e.id)} className="related-item" style={{ width: '100%' }} onClick={() => navigate(`/spend/expenses/${s(e.id)}`)}>
                        <span className="cell-mono">{s(e.expNo)}</span>
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s(e.description)}</span>
                        <Badge value={e.status} />
                      </button>
                    ))}
                  </div>
                )}
                {missingReceipts.length > 0 && (
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--clay)' }}>
                      {missingReceipts.length} expenses missing receipts
                    </div>
                    {missingReceipts.slice(0, 4).map((e) => (
                      <button key={s(e.id)} className="related-item" style={{ width: '100%' }} onClick={() => navigate(`/spend/expenses/${s(e.id)}`)}>
                        <span className="cell-mono">{s(e.expNo)}</span>
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s(e.description)}</span>
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{fmtMoney(num(e.amount))}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>

          <section className="card">
            <div className="card-head"><h3>Requisition Pipeline</h3></div>
            <div style={{ padding: '8px 16px 14px' }}>
              {(reqBoard?.recent as Rec[] | undefined)?.slice(0, 6).map((r) => (
                <button key={s(r.id)} className="related-item" style={{ width: '100%' }} onClick={() => navigate(`/spend/requisitions/${s(r.id)}`)}>
                  <span className="cell-mono">{s(r.reqNo)}</span>
                  <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>{s(r.departmentName)} · {s(r.requestType).replace(/_/g, ' ')}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{fmtMoney(num(r.estimatedTotal))}</span>
                  <Badge value={r.status} />
                  <RiskBadge row={r} />
                </button>
              ))}
              {!(reqBoard?.recent as Rec[] | undefined)?.length && <p className="empty-state">No requisitions yet.</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}const REQ_TYPES = ['MATERIAL', 'PURCHASE', 'ASSET', 'SERVICE', 'EXPENSE', 'PETTY_CASH', 'PRODUCTION_MATERIAL', 'MAINTENANCE', 'EMERGENCY', 'PROJECT'];
const REQ_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT', 'CRITICAL'];
const ITEM_TYPES = ['INVENTORY_ITEM', 'ASSET', 'SERVICE', 'EXPENSE'];
let lineKeyCounter = 0;
function nextLineKey(): number { lineKeyCounter += 1; return lineKeyCounter; }
interface LineDraft { key: number; itemType: string; productId?: number; assetCategory: string; description: string; quantity: string; unitId?: number; unitCode: string; unitCost: string; }

const REQ_EXPORT_FORMATS = [
  { id: 'print', label: 'Print' },
  { id: 'pdf', label: 'PDF' },
  { id: 'xlsx', label: 'Excel (XLSX)' },
  { id: 'csv', label: 'CSV' },
  { id: 'json', label: 'JSON' },
];

function RequisitionExportMenu({ status, type, q }: { status: string; type: string; q: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');

  const download = async (fmt: string) => {
    setBusy(fmt);
    try {
      const params = new URLSearchParams();
      params.set('format', fmt);
      if (status) params.set('status', status);
      if (type) params.set('type', type);
      if (q) params.set('q', q);
      const res = await fetch(`/api/ops/requisitions/export?${params.toString()}`, {
        headers: { Authorization: 'Bearer ' + (getToken() ?? '') },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body && body.error && body.error.message ? body.error.message : 'Export failed (' + res.status + ')'
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (fmt === 'print') {
        const win = window.open(url, '_blank');
        if (!win) {
          URL.revokeObjectURL(url);
          throw new Error('Popup blocked - allow popups for print.');
        }
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setOpen(false);
        return;
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = 'requisitions_' + fmt + '_' + Date.now() + '.' + fmt;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-sm" aria-expanded={open} disabled={Boolean(busy)} onClick={() => setOpen((v) => !v)}>
        {busy ? 'Exporting...' : 'Export'}
      </button>
      {open && (
        <div className="topbar-dropdown" style={{ top: 36, minWidth: 200 }}>
          <div className="dropdown-head">Export as</div>
          {REQ_EXPORT_FORMATS.map((f) => (
            <button key={f.id} className="search-item" onClick={() => download(f.id)}>
              <span className="search-item-title">{f.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RequisitionList() {
  const { user } = useAuth();
  const [items, setItems] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (type) params.set('type', type);
    if (q) params.set('q', q);
    api<{ data: { items: Rec[]; total: number } }>(`/api/ops/requisitions?${params.toString()}`)
      .then((r) => { setItems(r.data.items); setTotal(r.data.total); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [status, type, q]);

  useEffect(load, [load]);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0, flex: 1 }}>Requisitions</h1>
        <input className="search-input" placeholder="Search req no / purpose…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
        <StatusFilter value={type} onChange={setType} options={REQ_TYPES} />
        <StatusFilter value={status} onChange={setStatus} options={REQ_STATUSES} />
        <RequisitionExportMenu status={status} type={type} q={q} />
        {can(user, 'expenditure.requisitions.create') && (
          <button className="btn btn-primary" onClick={() => navigate('/spend/requisitions/new')}>+ New Requisition</button>
        )}
      </div>
      {error && <ErrorBanner error={error} />}
      {loading ? <PageLoader /> : (
        <section className="card">
          <div className="card-head"><h3>{total} requisitions</h3></div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Request No</th><th>Type</th><th>Department</th><th>Purpose</th>
                  <th>Required</th><th>Est. Total</th><th>Method</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={s(r.id)} className="row-click" onClick={() => navigate(`/spend/requisitions/${s(r.id)}`)}>
                    <td className="cell-mono">{s(r.reqNo)}</td>
                    <td>{s(r.requestType).replace(/_/g, ' ')}</td>
                    <td>{s(r.departmentName)}</td>
                    <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s(r.purpose)}</td>
                    <td>{fmtDay(r.requiredDate)}</td>
                    <td>{fmtMoney(num(r.estimatedTotal))}</td>
                    <td>{s(r.fulfillmentMethod).replace(/_/g, ' ') || '—'}</td>
                    <td><Badge value={r.status} /></td>
                    <td><RiskBadge row={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!items.length && <p className="empty-state">No requisitions match.</p>}
          </div>
        </section>
      )}
    </div>
  );
}

function RequisitionDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [row, setRow] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/requisitions/${id}`)
      .then((r) => setRow(r.data))
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  const act = (action: string, label: string, body?: Rec) => {
    setBusy(action);
    setMsg('');
    api<{ data: Rec }>(`/api/ops/requisitions/${id}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}) })
      .then(() => { setMsg(`${label} — saved.`); load(); })
      .catch((e) => setMsg(e.message))
      .finally(() => setBusy(''));
  };

  if (!row && !error) return <PageLoader />;
  if (error) return <ErrorBanner error={error} />;
  const r = row as Rec;
  const lines = (r.lines as Rec[] | undefined) ?? [];
  const approvals = (r.approvals as Rec[] | undefined) ?? [];
  const fulfillments = (r.fulfillments as Rec[] | undefined) ?? [];
  const isDraft = r.status === 'DRAFT';
  const isApproved = r.status === 'APPROVED';

  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-ghost" onClick={() => navigate('/spend/requisitions')}>← Requisitions</button>
        <h1 style={{ margin: 0, flex: 1 }}>{s(r.reqNo)} <Badge value={r.status} /> <RiskBadge row={r} /></h1>
        <CopyButton value={s(r.reqNo)} />
        {isDraft && can(user, 'expenditure.requisitions.update') && (
          <button className="btn btn-ghost" disabled={!!busy} onClick={() => navigate(`/spend/requisitions/${id}/edit`)}>Edit</button>
        )}
        {isDraft && can(user, 'expenditure.requisitions.submit') && (
          <button className="btn btn-primary" disabled={!!busy} onClick={() => act('submit', 'Submitted')}>{busy === 'submit' ? 'Submitting…' : 'Submit'}</button>
        )}
        {isApproved && can(user, 'expenditure.requisitions.fulfill') && (
          <button className="btn btn-primary" disabled={!!busy} onClick={() => act('fulfill', 'Fulfilled')}>{busy === 'fulfill' ? 'Working…' : 'Fulfill / Issue'}</button>
        )}
        {isDraft && can(user, 'expenditure.requisitions.update') && (
          <button className="btn btn-ghost btn-ghost-danger" disabled={!!busy} onClick={() => act('cancel', 'Cancelled', { reason: 'Cancelled by requester' })}>Cancel</button>
        )}
      </div>
      {msg && <div className="notice-banner">{msg}</div>}
      {!isDraft && <Pipeline steps={['SUBMITTED', 'APPROVED', 'FULFILLED']} status={s(r.status)} />}

      <div className="form-grid">
        <MetaCard title="Request" rows={[
          ['Request Type', s(r.requestType).replace(/_/g, ' ')],
          ['Department', s(r.departmentName)],
          ['Requested By', personName(r)],
          ['Required Date', fmtDay(r.requiredDate)],
          ['Priority', s(r.priority)],
          ['Purpose', s(r.purpose)],
        ]} />
        <MetaCard title="Control" rows={[
          ['Cost Centre', s(r.costCentreName)],
          ['Project', s(r.projectName)],
          ['Warehouse', s(r.warehouseName)],
          ['Account', s(r.accountId) ? `#${s(r.accountId)}` : '—'],
          ['Estimated Total', fmtMoney(num(r.estimatedTotal))],
          ['Fulfillment', s(r.fulfillmentMethod).replace(/_/g, ' ') || '—'],
          ['Currency', s(r.currency)],
          ['Risk', s(r.riskLevel)],
        ]} />
      </div>

      <section className="card">
        <div className="card-head"><h3>Items</h3></div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>#</th><th>Item</th><th>Type</th><th>Qty</th><th>Unit</th><th>Unit Cost</th><th>Amount</th><th>Recommendation</th><th>Status</th></tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={s(l.id)}>
                  <td>{s(l.lineNo)}</td>
                  <td>{s(l.productName) || s(l.description)}</td>
                  <td>{s(l.itemType).replace(/_/g, ' ')}</td>
                  <td>{fmtNum(l.quantity)}</td>
                  <td>{s(l.unitCode) || '—'}</td>
                  <td>{fmtMoney(num(l.unitCost))}</td>
                  <td>{fmtMoney(num(l.amount))}</td>
                  <td>{s(l.recommendation).replace(/_/g, ' ') || '—'}</td>
                  <td><Badge value={l.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {approvals.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Approval Trail</h3></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Step</th><th>Role</th><th>Decider</th><th>Decision</th><th>Comment</th><th>At</th></tr></thead>
              <tbody>
                {approvals.map((a) => (
                  <tr key={s(a.id)}>
                    <td>{s(a.stepSeq)}</td>
                    <td>{s(a.stepName)}</td>
                    <td>{s(a.deciderName) || '—'}</td>
                    <td><Badge value={a.decision} /></td>
                    <td>{s(a.comment) || '—'}</td>
                    <td>{fmtDay(a.decidedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {fulfillments.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Fulfillment</h3></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Method</th><th>Reference</th><th>Notes</th><th>By</th><th>At</th></tr></thead>
              <tbody>
                {fulfillments.map((f) => (
                  <tr key={s(f.id)}>
                    <td>{s(f.fulfillmentType).replace(/_/g, ' ')}</td>
                    <td className="cell-mono">{s(f.reference)}</td>
                    <td>{s(f.notes) || '—'}</td>
                    <td>{s(f.fulfilledByName) || '—'}</td>
                    <td>{fmtDay(f.fulfilledAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}function RequisitionComposer({ editId }: { editId?: number }) {
  const { user } = useAuth();
  const [meta, setMeta] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [saved, setSaved] = useState<Rec | null>(null);
  const [requestType, setRequestType] = useState('MATERIAL');
  const [priority, setPriority] = useState('NORMAL');
  const [departmentId, setDepartmentId] = useState('');
  const [requiredDate, setRequiredDate] = useState(todayIso());
  const [purpose, setPurpose] = useState('');
  const [costCentreId, setCostCentreId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [currency, setCurrency] = useState('UGX');
  const [lines, setLines] = useState<LineDraft[]>([{ key: nextLineKey(), itemType: 'INVENTORY_ITEM', description: '', assetCategory: '', quantity: '1', unitCode: '', unitCost: '' }]);
  const [hits, setHits] = useState<Record<number, Rec[]>>({});
  const [openLine, setOpenLine] = useState<number | null>(null);
  const searchTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    api<{ data: Rec }>('/api/ops/requisitions/meta')
      .then((r) => alive && setMeta(r.data))
      .catch((err) => alive && setError(err.message));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!editId) return;
    let alive = true;
    api<{ data: Rec }>(`/api/ops/requisitions/${editId}`)
      .then((r) => {
        if (!alive) return;
        const h = r.data;
        setRequestType(s(h.requestType) || 'MATERIAL');
        setPriority(s(h.priority) || 'NORMAL');
        setDepartmentId(h.departmentId != null ? String(h.departmentId) : '');
        setRequiredDate(isoDay(h.requiredDate) || todayIso());
        setPurpose(s(h.purpose));
        setCostCentreId(h.costCentreId != null ? String(h.costCentreId) : '');
        setProjectId(h.projectId != null ? String(h.projectId) : '');
        setAccountId(h.accountId != null ? String(h.accountId) : '');
        setWarehouseId(h.warehouseId != null ? String(h.warehouseId) : '');
        setCurrency(s(h.currency) || 'UGX');
        const ls = (h.lines as Rec[] | undefined) ?? [];
        if (ls.length) {
          setLines(ls.map((l) => ({
            key: nextLineKey(), itemType: s(l.itemType) || 'INVENTORY_ITEM',
            productId: l.productId != null ? Number(l.productId) : undefined,
            assetCategory: s(l.assetCategory), description: s(l.description),
            quantity: String(l.quantity ?? 1), unitId: l.unitId != null ? Number(l.unitId) : undefined,
            unitCode: s(l.unitCode), unitCost: String(l.unitCost ?? 0),
          })));
        }
      })
      .catch((err) => alive && setError(err.message));
    return () => { alive = false; };
  }, [editId]);

  const estimatedTotal = useMemo(() => lines.reduce((sum, l) => sum + num(l.quantity) * num(l.unitCost), 0), [lines]);

  const patchLine = (key: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const searchItems = (key: number, q: string) => {
    setOpenLine(key);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      api<{ data: Rec[] }>(`/api/ops/requisitions/items?q=${encodeURIComponent(q)}`)
        .then((r) => setHits((h) => ({ ...h, [key]: r.data })))
        .catch(() => setHits((h) => ({ ...h, [key]: [] })));
    }, 220);
  };

  const pickItem = (key: number, item: Rec) => {
    patchLine(key, { productId: Number(item.id), description: `${s(item.code)} — ${s(item.name)}`, unitCode: '' });
    setHits((h) => ({ ...h, [key]: [item] }));
  };

  const units = (meta?.units as Rec[] | undefined) ?? [];
  const departments = (meta?.departments as Rec[] | undefined) ?? [];
  const costCentres = (meta?.costCentres as Rec[] | undefined) ?? [];
  const warehouses = (meta?.warehouses as Rec[] | undefined) ?? [];
  const projects = (meta?.projects as Rec[] | undefined) ?? [];
  const accounts = (meta?.expenseAccounts as Rec[] | undefined) ?? [];

  const save = async (submitNow: boolean) => {
    setError('');
    setMsg('');
    if (!departmentId) { setError('Requesting department is required'); return; }
    if (!lines.length || !lines.some((l) => (l.description || l.productId) && num(l.quantity) > 0)) {
      setError('Add at least one line with a description and quantity'); return;
    }
    const items = lines.map((l) => ({
      itemType: l.itemType,
      productId: l.productId,
      assetCategory: l.assetCategory || undefined,
      description: l.description,
      quantity: num(l.quantity),
      unitId: l.unitId,
      unitCode: l.unitCode || undefined,
      unitCost: num(l.unitCost),
    }));
    const body = {
      requestType, priority, departmentId: Number(departmentId), requiredDate, purpose,
      costCentreId: costCentreId ? Number(costCentreId) : undefined,
      projectId: projectId ? Number(projectId) : undefined,
      accountId: accountId ? Number(accountId) : undefined,
      warehouseId: warehouseId ? Number(warehouseId) : undefined,
      currency, items,
    };
    setBusy('save');
    try {
      const path = editId ? `/api/ops/requisitions/${editId}/update` : '/api/ops/requisitions';
      const r = await api<{ data: Rec }>(path, { method: 'POST', body: JSON.stringify(body) });
      const h = r.data;
      if (!submitNow) {
        setSaved(r.data);
        setMsg(editId ? `Updated ${s(h.reqNo)} — still a draft` : `Saved ${s(h.reqNo)} as a draft`);
      } else {
        await api<{ data: Rec }>(`/api/ops/requisitions/${s(h.id)}/submit`, { method: 'POST' });
        navigate(`/spend/requisitions/${s(h.id)}`);
      }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(''); }
  };

  const riskFlags = (saved?.risk as string[] | undefined) ?? [];
  const budget = saved?.budget as Rec | undefined;

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0, flex: 1 }}>{editId ? 'Edit Requisition' : 'New Requisition'}</h1>
        <button className="btn btn-ghost" onClick={() => navigate('/spend/requisitions')}>Back</button>
      </div>
      <SpendTabs active="requisitions" />
      {error && <ErrorBanner error={error} />}
      {msg && <div className="notice-banner">{msg}</div>}
      {saved && (
        <section className="card card-accent" style={{ marginBottom: 14 }}>
          <div className="card-head">
            <h3>{s(saved.reqNo)} <Badge value={saved.status} /></h3>
            <button className="btn btn-sm btn-ghost" onClick={() => navigate(`/spend/requisitions/${s(saved.id)}`)}>View</button>
          </div>
          <div style={{ padding: '6px 16px 14px', fontSize: 13 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: riskFlags.length || budget ? 8 : 0 }}>
              <span><strong>Estimated total:</strong> {fmtMoney(estimatedTotal)} {currency}</span>
              <span><strong>Fulfillment:</strong> {s(saved.fulfillmentMethod).replace(/_/g, ' ') || '—'}</span>
            </div>
            {riskFlags.length > 0 && (
              <div style={{ color: 'var(--clay)', marginBottom: 6 }}>
                <strong>Risk:</strong> {riskFlags.join(' · ')}
              </div>
            )}
            {budget && (
              <div>
                <strong>Budget:</strong> {fmtMoney(num(budget.used))} used of {fmtMoney(num(budget.approved))} · {fmtMoney(num(budget.available))} available
                <span className={num(budget.remaining) < 0 ? 'badge badge-danger' : 'badge badge-green'} style={{ marginLeft: 8 }}>
                  {num(budget.remaining) < 0 ? 'Over budget' : 'Within budget'}
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      <div className="form-grid" style={{ marginBottom: 14 }}>
        <div className="field field-required">
          <label>Requesting department</label>
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Select department…</option>
            {departments.map((d) => <option key={s(d.id)} value={s(d.id)}>{s(d.name)}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Request type</label>
          <select value={requestType} onChange={(e) => setRequestType(e.target.value)}>
            {REQ_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Priority</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Required date</label>
          <input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Purpose</label>
          <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Why is this request needed?" />
        </div>
        <div className="field">
          <label>Cost centre</label>
          <select value={costCentreId} onChange={(e) => setCostCentreId(e.target.value)}>
            <option value="">None</option>
            {costCentres.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Project</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">None</option>
            {projects.map((p) => <option key={s(p.id)} value={s(p.id)}>{s(p.name)}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Expense account (budget control)</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">None</option>
            {accounts.map((a) => <option key={s(a.id)} value={s(a.id)}>{s(a.code)} — {s(a.name)}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Warehouse</label>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">None</option>
            {warehouses.map((w) => <option key={s(w.id)} value={s(w.id)}>{s(w.name)}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Currency</label>
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </div>
      </div>

      <section className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <h3>Items</h3>
          <button className="btn btn-sm" onClick={() => setLines((ls) => [...ls, { key: nextLineKey(), itemType: requestType === 'ASSET' ? 'ASSET' : requestType === 'SERVICE' ? 'SERVICE' : requestType === 'EXPENSE' || requestType === 'PETTY_CASH' ? 'EXPENSE' : 'INVENTORY_ITEM', description: '', assetCategory: '', quantity: '1', unitCode: '', unitCost: '' }])}>+ Add line</button>
        </div>
        <div style={{ padding: '8px 16px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {lines.map((l) => {
            const lineHits = hits[l.key] ?? [];
            const picked = lineHits.find((h) => num(h.id) === l.productId);
            return (
              <div key={l.key} className="card" style={{ padding: 12 }}>
                <div className="form-grid">
                  <div className="field">
                    <label>Item type</label>
                    <select value={l.itemType} onChange={(e) => patchLine(l.key, { itemType: e.target.value, description: '', productId: undefined })}>
                      {ITEM_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                    </select>
                  </div>
                  {l.itemType === 'INVENTORY_ITEM' ? (
                    <div className="field" style={{ position: 'relative', gridColumn: 'span 2' }}>
                      <label>Search inventory item</label>
                      <input
                        value={l.description}
                        onChange={(e) => { patchLine(l.key, { description: e.target.value, productId: undefined }); searchItems(l.key, e.target.value); }}
                        onBlur={() => window.setTimeout(() => setOpenLine(null), 150)}
                        placeholder="Type a code or name — e.g. A4 Paper, Glue…"
                      />
                      {openLine === l.key && lineHits.length > 0 && (
                        <div className="lookup-menu">
                          {lineHits.map((it) => (
                            <button key={s(it.id)} type="button" className="lookup-item" onMouseDown={() => pickItem(l.key, it)}>
                              <div style={{ fontWeight: 600 }}>{s(it.code)} — {s(it.name)}</div>
                              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                                On hand {fmtNum(it.onHandQty)} · Reserved {fmtNum(it.reservedQty)} · Available {fmtNum(it.availableToIssue)} · {s(it.reorderStatus)}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                      {picked && (
                        <div style={{ marginTop: 8, fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 14, background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }}>
                          <span>On hand: <strong>{fmtNum(picked.onHandQty)}</strong></span>
                          <span>Reserved: <strong>{fmtNum(picked.reservedQty)}</strong></span>
                          <span>Available to issue: <strong>{fmtNum(picked.availableToIssue)}</strong></span>
                          <span>Reorder: <strong>{s(picked.reorderStatus)}</strong></span>
                          <span className="badge badge-blue">{s(picked.recommendation).replace(/_/g, ' ')}</span>
                        </div>
                      )}
                    </div>
                  ) : l.itemType === 'ASSET' ? (
                    <div className="field" style={{ gridColumn: 'span 2' }}>
                      <label>Asset category / description</label>
                      <input value={l.assetCategory} onChange={(e) => patchLine(l.key, { assetCategory: e.target.value })} placeholder="e.g. Laptop, Printer, Furniture…" />
                    </div>
                  ) : (
                    <div className="field" style={{ gridColumn: 'span 2' }}>
                      <label>Description</label>
                      <input value={l.description} onChange={(e) => patchLine(l.key, { description: e.target.value })} placeholder={l.itemType === 'SERVICE' ? 'e.g. Machine repair, transport…' : 'e.g. Fuel, airtime, meals…'} />
                    </div>
                  )}
                  <div className="field">
                    <label>Qty</label>
                    <input type="number" min="0" step="any" value={l.quantity} onChange={(e) => patchLine(l.key, { quantity: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Unit</label>
                    <select value={l.unitCode || ''} onChange={(e) => {
                      const u = units.find((x) => s(x.code) === e.target.value);
                      patchLine(l.key, { unitCode: e.target.value, unitId: u ? Number(u.id) : undefined });
                    }}>
                      <option value="">—</option>
                      {units.map((u) => <option key={s(u.id)} value={s(u.code)}>{s(u.code)}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Unit cost ({currency})</label>
                    <input type="number" min="0" step="any" value={l.unitCost} onChange={(e) => patchLine(l.key, { unitCost: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Amount</label>
                    <div style={{ padding: '8px 0', fontWeight: 700 }}>{fmtMoney(num(l.quantity) * num(l.unitCost))}</div>
                  </div>
                  <div className="field" style={{ justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-ghost btn-ghost-danger" disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Remove</button>
                  </div>
                </div>
              </div>
            );
          })}
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 18, fontSize: 14 }}>
            <span>Line {lines.length} · Estimated total: <strong style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{fmtMoney(estimatedTotal)}</strong> {currency}</span>
          </div>
        </div>
      </section>

      <div className="toolbar">
        <button className="btn btn-ghost" disabled={!!busy} onClick={() => save(false)}>{busy === 'save' ? 'Saving…' : 'Save Draft'}</button>
        <button className="btn btn-primary" disabled={!!busy} onClick={() => save(true)}>{busy === 'save' ? 'Saving…' : 'Submit Request'}</button>
        {can(user, 'expenditure.requisitions.view') && <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>Smart engine will recommend Store Issue vs Purchase per line.</span>}
      </div>
    </div>
  );
}

// ---------- Daily Expenditure ----------

async function uploadReceiptInput(file: File | undefined, refType: string, refId: number): Promise<Rec> {
  if (!file) throw new Error('Choose a file first');
  const fd = new FormData();
  fd.append('file', file);
  fd.append('refType', refType);
  fd.append('refId', String(refId));
  const r = await api<{ data: Rec }>('/api/ops/expenditure/receipts', { method: 'POST', body: fd });
  return r.data;
}

function ReceiptChips({ receipts }: { receipts: Rec[] }) {
  if (!receipts.length) return <p className="empty-state">No receipts attached yet.</p>;
  return (
    <div className="related-list">
      {receipts.map((r) => (
        <div key={s(r.id)} className="related-item" style={{ alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>{s(r.fileName)}</span>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {s(r.supplier) || 'Unknown supplier'}{r.invoiceNo ? ` · INV ${s(r.invoiceNo)}` : ''}
          </span>
          {num(r.total) > 0 && <span style={{ color: 'var(--muted)', fontSize: 12 }}>{fmtMoney(num(r.total))}</span>}
          {r.verified === true || r.verified === 'true' ? <Badge value="VERIFIED" /> : <Badge value="UNVERIFIED" />}
        </div>
      ))}
    </div>
  );
}

const EXP_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'POSTED', 'VOID', 'REJECTED'];

function ExpenseList() {
  const { user } = useAuth();
  const [items, setItems] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (page > 1) params.set('page', String(page));
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/expenditure/expenses?${params.toString()}`)
      .then((r) => { setItems(r.data.rows); setTotal(r.data.total); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [q, status, page]);
  useEffect(load, [load]);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0, flex: 1 }}>Daily Expenditure</h1>
        <input className="search-input" placeholder="Search exp no / payee…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ maxWidth: 240 }} />
        <StatusFilter value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={EXP_STATUSES} />
        {can(user, 'expenditure.expenses.create') && (
          <button className="btn btn-primary" onClick={() => navigate('/spend/expenses/new')}>+ Record Expense</button>
        )}
      </div>
      {error && <ErrorBanner error={error} />}
      {loading ? <PageLoader /> : (
        <section className="card">
          <div className="card-head"><h3>{total} expenses</h3></div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Exp No</th><th>Date</th><th>Description</th><th>Category</th><th>Department</th>
                  <th>Payee</th><th>Amount</th><th>Status</th><th>Payment</th><th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={s(e.id)} className="row-click" onClick={() => navigate(`/spend/expenses/${s(e.id)}`)}>
                    <td className="cell-mono">{s(e.expNo)}</td>
                    <td>{fmtDay(e.expDate)}</td>
                    <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s(e.description)}</td>
                    <td>{s(e.categoryName) || '—'}</td>
                    <td>{s(e.departmentName) || '—'}</td>
                    <td>{s(e.payee) || s(e.supplierName) || '—'}</td>
                    <td>{fmtMoney(num(e.amount))}</td>
                    <td><Badge value={e.status} /></td>
                    <td><Badge value={e.paymentStatus} /></td>
                    <td><RiskBadge row={e} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!items.length && <p className="empty-state">No expenses match.</p>}
          </div>
          {total > 30 && <Pager page={page} pageSize={30} total={total} onPage={setPage} />}
        </section>
      )}
    </div>
  );
}

interface ExpLineDraft { key: number; description: string; quantity: string; unitCost: string; }

function ExpenseForm() {
  const { user } = useAuth();
  const [meta, setMeta] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [expDate, setExpDate] = useState(todayIso());
  const [departmentId, setDepartmentId] = useState(s(user?.department_id));
  const [costCentreId, setCostCentreId] = useState('');
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [payee, setPayee] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [budgetId, setBudgetId] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [reference, setReference] = useState('');
  const [isPlanned, setIsPlanned] = useState(true);
  const [showLines, setShowLines] = useState(false);
  const [lines, setLines] = useState<ExpLineDraft[]>([{ key: nextLineKey(), description: '', quantity: '1', unitCost: '' }]);

  useEffect(() => {
    api<{ data: Rec }>('/api/ops/expenditure/meta')
      .then((r) => setMeta(r.data))
      .catch((e) => setError(e.message));
  }, []);

  const cats = (meta?.categories as Rec[] | undefined) ?? [];
  const methods = (meta?.paymentMethods as Rec[] | undefined) ?? [];
  const depts = (meta?.departments as Rec[] | undefined) ?? [];
  const centres = (meta?.costCentres as Rec[] | undefined) ?? [];
  const projs = (meta?.projects as Rec[] | undefined) ?? [];
  const emps = (meta?.employees as Rec[] | undefined) ?? [];
  const sups = (meta?.suppliers as Rec[] | undefined) ?? [];
  const bdgs = (meta?.budgets as Rec[] | undefined) ?? [];

  const patchLine = (key: number, patch: Partial<ExpLineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = (submitNow: boolean) => {
    setBusy('save');
    setError('');
    const body: Rec = {
      description,
      amount: num(amount),
      categoryId: num(categoryId) || undefined,
      expDate,
      departmentId: num(departmentId) || undefined,
      costCentreId: num(costCentreId) || undefined,
      paymentMethodId: num(paymentMethodId) || undefined,
      payee: payee || undefined,
      supplierId: num(supplierId) || undefined,
      employeeId: num(employeeId) || undefined,
      projectId: num(projectId) || undefined,
      budgetId: num(budgetId) || undefined,
      taxAmount: taxAmount ? num(taxAmount) : undefined,
      vehicle: vehicle || undefined,
      reference: reference || undefined,
      isPlanned,
      lines: showLines ? lines.map((l) => ({
        description: l.description,
        quantity: l.quantity ? num(l.quantity) : undefined,
        unitCost: l.unitCost ? num(l.unitCost) : undefined,
        amount: l.quantity && l.unitCost ? num(l.quantity) * num(l.unitCost) : undefined,
      })) : undefined,
    };
    api<{ data: Rec }>('/api/ops/expenditure/expenses', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => {
        const next = () => navigate(`/spend/expenses/${s(r.data.id)}`);
        if (submitNow) {
          return api<{ data: Rec }>(`/api/ops/expenditure/expenses/${s(r.data.id)}/submit`, { method: 'POST', body: '{}' })
            .then(next)
            .catch((e) => { setError(e.message); setBusy(''); });
        }
        next();
        return undefined;
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(''));
  };

  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-ghost" onClick={() => navigate('/spend/expenses')}>← Daily Expenditure</button>
        <h1 style={{ margin: 0, flex: 1 }}>Record Expense</h1>
        <button className="btn btn-ghost" disabled={busy !== ''} onClick={() => save(false)}>{busy === 'save' ? 'Saving…' : 'Save Draft'}</button>
        <button className="btn btn-primary" disabled={busy !== ''} onClick={() => save(true)}>{busy === 'save' ? 'Saving…' : 'Save & Submit'}</button>
      </div>
      {error && <ErrorBanner error={error} />}
      <div className="form-grid">
        <section className="card card-accent">
          <div className="card-head"><h3>Expense details</h3></div>
          <div className="form-grid">
            <label className="field field-required">Date
              <input type="date" value={expDate} onChange={(e) => setExpDate(e.target.value)} />
            </label>
            <label className="field field-required">Category
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Select category…</option>
                {cats.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.categoryGroup)} · {s(c.name)}</option>)}
              </select>
            </label>
            <label className="field field-required" style={{ gridColumn: '1 / -1' }}>Description
              <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was this spent on?" />
            </label>
            <label className="field field-required">Amount (UGX)
              <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </label>
            <label className="field">Tax amount
              <input type="number" min="0" step="0.01" value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} placeholder="0.00" />
            </label>
            <label className="field">Department
              <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">Select department…</option>
                {depts.map((d) => <option key={s(d.id)} value={s(d.id)}>{s(d.name)}</option>)}
              </select>
            </label>
            <label className="field">Cost centre
              <select value={costCentreId} onChange={(e) => setCostCentreId(e.target.value)}>
                <option value="">Select cost centre…</option>
                {centres.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
              </select>
            </label>
            <label className="field">Project
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">No project</option>
                {projs.map((p) => <option key={s(p.id)} value={s(p.id)}>{s(p.name)}</option>)}
              </select>
            </label>
            <label className="field">Budget
              <select value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>
                <option value="">No budget</option>
                {bdgs.map((b) => <option key={s(b.id)} value={s(b.id)}>{s(b.budgetNo)} · {s(b.name)}</option>)}
              </select>
            </label>
          </div>
        </section>

        <section className="card card-accent">
          <div className="card-head"><h3>Payment</h3></div>
          <div className="form-grid">
            <label className="field field-required">Payment method
              <select value={paymentMethodId} onChange={(e) => setPaymentMethodId(e.target.value)}>
                <option value="">Select method…</option>
                {methods.map((m) => <option key={s(m.id)} value={s(m.id)}>{s(m.name)} ({s(m.methodType).replace(/_/g, ' ')})</option>)}
              </select>
            </label>
            <label className="field">Payee
              <input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="Who received the money?" />
            </label>
            <label className="field">Supplier
              <select value={supplierId} onChange={(e) => {
                setSupplierId(e.target.value);
                const sup = sups.find((x) => s(x.id) === e.target.value);
                if (sup) setPayee(s(sup.name));
              }}>
                <option value="">Not supplier-related</option>
                {sups.map((x) => <option key={s(x.id)} value={s(x.id)}>{s(x.name)}</option>)}
              </select>
            </label>
            <label className="field">Employee (reimbursement)
              <select value={employeeId} onChange={(e) => {
                setEmployeeId(e.target.value);
                const emp = emps.find((x) => s(x.id) === e.target.value);
                if (emp) setPayee(s(emp.name));
              }}>
                <option value="">Not employee-related</option>
                {emps.map((x) => <option key={s(x.id)} value={s(x.id)}>{s(x.name)}</option>)}
              </select>
            </label>
            <label className="field">Vehicle
              <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="e.g. UAX 123A" />
            </label>
            <label className="field">Reference / invoice no
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="INV-…" />
            </label>
            <label className="field checkbox-field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={isPlanned} onChange={(e) => setIsPlanned(e.target.checked)} />
              Planned expenditure (not emergency)
            </label>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>Line breakdown</h3>
          <button className="btn btn-sm btn-ghost" onClick={() => setShowLines(!showLines)}>{showLines ? 'Hide lines' : 'Add line breakdown'}</button>
        </div>
        {showLines && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Description</th><th>Qty</th><th>Unit cost</th><th>Line total</th><th></th></tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td><input value={l.description} onChange={(e) => patchLine(l.key, { description: e.target.value })} placeholder="Line description" style={{ width: '100%' }} /></td>
                    <td><input type="number" min="0" step="0.01" value={l.quantity} onChange={(e) => patchLine(l.key, { quantity: e.target.value })} style={{ width: 90 }} /></td>
                    <td><input type="number" min="0" step="0.01" value={l.unitCost} onChange={(e) => patchLine(l.key, { unitCost: e.target.value })} style={{ width: 130 }} /></td>
                    <td className="cell-mono">{fmtMoney(num(l.quantity) * num(l.unitCost))}</td>
                    <td><button className="btn btn-sm btn-ghost-danger" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ padding: 10 }}>
              <button className="btn btn-sm" onClick={() => setLines((ls) => [...ls, { key: nextLineKey(), description: '', quantity: '1', unitCost: '' }])}>+ Add line</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function ExpenseDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [row, setRow] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [payMethod, setPayMethod] = useState('');
  const [showPay, setShowPay] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [showVoid, setShowVoid] = useState(false);
  const [methods, setMethods] = useState<Rec[]>([]);

  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/expenditure/expenses/${id}`)
      .then((r) => setRow(r.data))
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    let alive = true;
    api<{ data: Rec }>('/api/ops/expenditure/meta')
      .then((r) => alive && setMethods((r.data.paymentMethods as Rec[] | undefined) ?? []))
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const act = (action: string, label: string, body?: Rec) => {
    setBusy(action);
    setMsg('');
    api<{ data: Rec }>(`/api/ops/expenditure/expenses/${id}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}) })
      .then(() => { setMsg(`${label} — saved.`); setShowPay(false); setShowVoid(false); setVoidReason(''); load(); })
      .catch((e) => setMsg(e.message))
      .finally(() => setBusy(''));
  };

  const attach = async (file: File | undefined) => {
    if (!file) return;
    setBusy('receipt');
    setMsg('');
    try {
      await uploadReceiptInput(file, 'EXPENSE', id);
      setMsg('Receipt uploaded.');
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  if (!row && !error) return <PageLoader />;
  if (error) return <ErrorBanner error={error} />;
  const e = row as Rec;
  const lines = (e.lines as Rec[] | undefined) ?? [];
  const receipts = (e.receipts as Rec[] | undefined) ?? [];
  const timeline = (e.timeline as Rec[] | undefined) ?? [];
  const dup = e.duplicateOf as Rec | null | undefined;
  const isDraft = e.status === 'DRAFT';
  const isPaid = e.status === 'PAID' || s(e.paymentStatus) === 'PAID';
  const isPosted = s(e.accountingStatus) === 'POSTED';
  const canSubmit = isDraft && can(user, 'expenditure.expenses.submit');
  const canPay = (e.status === 'APPROVED' || e.status === 'POSTED') && !isPaid && can(user, 'expenditure.expenses.approve');
  const canPost = (e.status === 'APPROVED' || e.status === 'PAID') && !isPosted && can(user, 'expenditure.expenses.post');
  const canVoid = !['VOID', 'REJECTED', 'CANCELLED'].includes(s(e.status)) && can(user, 'expenditure.expenses.void');

  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-ghost" onClick={() => navigate('/spend/expenses')}>← Daily Expenditure</button>
        <h1 style={{ margin: 0, flex: 1 }}><span className="cell-mono">{s(e.expNo)}</span> <Badge value={e.status} /> <RiskBadge row={e} /></h1>
        {canSubmit && <button className="btn btn-primary" disabled={busy !== ''} onClick={() => act('submit', 'Expense submitted')}>{busy === 'submit' ? 'Working…' : 'Submit for Approval'}</button>}
        {canPay && <button className="btn btn-primary" disabled={busy !== ''} onClick={() => setShowPay(true)}>Record Payment</button>}
        {canPost && <button className="btn btn-ghost" disabled={busy !== ''} onClick={() => act('post', 'Posted to ledger')}>{busy === 'post' ? 'Working…' : 'Post to Ledger'}</button>}
        {canVoid && <button className="btn btn-ghost-danger" disabled={busy !== ''} onClick={() => setShowVoid(true)}>Void</button>}
      </div>
      {error && <ErrorBanner error={error} />}
      {msg && <div className="notice-banner">{msg}</div>}
      {dup && (
        <div className="notice-banner" style={{ color: 'var(--clay)' }}>
          ⚠ Possible duplicate: <span className="cell-mono">{s(dup.expNo)}</span> ({fmtMoney(num(dup.amount))}, {s(dup.status)}).
        </div>
      )}
      <Pipeline steps={['DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'POSTED']} status={s(e.status)} />

      <div className="form-grid">
        <section className="card">
          <div className="card-head"><h3>Expense</h3></div>
          <dl className="detail-list">
            <div className="detail-row"><dt>Description</dt><dd>{s(e.description)}</dd></div>
            <div className="detail-row"><dt>Amount</dt><dd>{fmtMoney(num(e.amount))} {s(e.currency) || 'UGX'}</dd></div>
            <div className="detail-row"><dt>Tax</dt><dd>{fmtMoney(num(e.taxAmount))}</dd></div>
            <div className="detail-row"><dt>Date</dt><dd>{fmtDay(e.expDate)}</dd></div>
            <div className="detail-row"><dt>Category</dt><dd>{s(e.categoryName) || '—'}</dd></div>
            <div className="detail-row"><dt>Department</dt><dd>{s(e.departmentName) || '—'}</dd></div>
            <div className="detail-row"><dt>Cost centre</dt><dd>{s(e.costCentreName) || '—'}</dd></div>
            <div className="detail-row"><dt>Payee</dt><dd>{s(e.payee) || s(e.supplierName) || s(e.employeeName) || '—'}</dd></div>
            <div className="detail-row"><dt>Supplier</dt><dd>{s(e.supplierName) || '—'}</dd></div>
            <div className="detail-row"><dt>Employee</dt><dd>{s(e.employeeName) || '—'}</dd></div>
            <div className="detail-row"><dt>Project</dt><dd>{s(e.projectName) || '—'}</dd></div>
            <div className="detail-row"><dt>Payment method</dt><dd>{s(e.paymentMethodName) || '—'}</dd></div>
            <div className="detail-row"><dt>Payment status</dt><dd><Badge value={e.paymentStatus} /></dd></div>
            <div className="detail-row"><dt>Accounting</dt><dd><Badge value={e.accountingStatus} /></dd></div>
            <div className="detail-row"><dt>Reference</dt><dd><span className="cell-mono">{s(e.reference) || '—'}</span></dd></div>
            <div className="detail-row"><dt>Vehicle</dt><dd>{s(e.vehicle) || '—'}</dd></div>
            <div className="detail-row"><dt>Requisition</dt><dd><span className="cell-mono">{s(e.reqNo) || '—'}</span></dd></div>
            <div className="detail-row"><dt>Planned</dt><dd>{e.isPlanned === true || e.isPlanned === 'true' ? 'Yes' : 'No'}</dd></div>
            <div className="detail-row"><dt>Created by</dt><dd>{s(e.createdByName) || '—'}</dd></div>
          </dl>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Receipts</h3>
            <label className="btn btn-sm">
              {busy === 'receipt' ? 'Uploading…' : 'Upload receipt'}
              <input type="file" hidden disabled={busy !== ''} onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; void attach(f); }} />
            </label>
          </div>
          <ReceiptChips receipts={receipts} />
        </section>
      </div>

      {lines.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Line breakdown</h3></div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Line</th><th>Description</th><th>Qty</th><th>Unit cost</th><th>Amount</th></tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={s(l.id)}>
                    <td>{s(l.lineNo)}</td>
                    <td>{s(l.description)}</td>
                    <td>{fmtNum(l.quantity)}</td>
                    <td>{fmtMoney(num(l.unitCost))}</td>
                    <td>{fmtMoney(num(l.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head"><h3>Approval timeline</h3></div>
        {timeline.length === 0 && <p className="empty-state">No approval actions yet.</p>}
        {timeline.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Action</th><th>By</th><th>Comment</th><th>At</th></tr>
              </thead>
              <tbody>
                {timeline.map((a) => (
                  <tr key={s(a.id)}>
                    <td><Badge value={a.action} /></td>
                    <td>{s(a.actorName) || '—'}</td>
                    <td>{s(a.comment) || '—'}</td>
                    <td>{fmtDate(a.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showPay && (
        <Modal title={`Record payment for ${s(e.expNo)}`} onClose={() => setShowPay(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setShowPay(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== ''} onClick={() => act('pay', 'Payment recorded', { paymentMethodId: num(payMethod) || undefined })}>
              {busy === 'pay' ? 'Working…' : 'Confirm Payment'}
            </button>
          </>}>
          <div className="form-grid">
            <label className="field">Payment method
              <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                <option value="">Use default ({s(e.paymentMethodName) || 'not set'})</option>
                {methods.map((m) => <option key={s(m.id)} value={s(m.id)}>{s(m.name)}</option>)}
              </select>
            </label>
            <p className="empty-state">Payment creates a PAY voucher and marks the expense as paid.</p>
          </div>
        </Modal>
      )}
      {showVoid && (
        <Modal title={`Void ${s(e.expNo)}?`} onClose={() => setShowVoid(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setShowVoid(false)}>Cancel</button>
            <button className="btn btn-ghost-danger" disabled={busy !== '' || !voidReason.trim()} onClick={() => act('void', 'Expense voided', { reason: voidReason })}>
              {busy === 'void' ? 'Working…' : 'Void Expense'}
            </button>
          </>}>
          <label className="field field-required">Reason for voiding
            <textarea rows={3} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Explain why this expense is being voided" />
          </label>
        </Modal>
      )}
    </div>
  );
}
// ---------- Petty Cash ----------

const PC_TX_TYPES = ['RECEIPT', 'EXPENSE', 'TOP_UP', 'RETURN', 'ADJUSTMENT', 'REPLENISHMENT'];

function PettyCashDesk() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [showReq, setShowReq] = useState(false);
  const [showTx, setShowTx] = useState(false);
  const [showRec, setShowRec] = useState(false);
  const [repFund, setRepFund] = useState('');
  const [repAmount, setRepAmount] = useState('');
  const [repDate, setRepDate] = useState(todayIso());
  const [repReason, setRepReason] = useState('');
  const [txFund, setTxFund] = useState('');
  const [txType, setTxType] = useState('EXPENSE');
  const [txAmount, setTxAmount] = useState('');
  const [txRef, setTxRef] = useState('');
  const [txDesc, setTxDesc] = useState('');
  const [recFund, setRecFund] = useState('');
  const [recCounted, setRecCounted] = useState('');
  const [recDate, setRecDate] = useState(todayIso());
  const [recExplain, setRecExplain] = useState('');

  const load = useCallback(() => {
    api<{ data: Rec }>('/api/ops/expenditure/petty-cash')
      .then((r) => setData(r.data))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const funds = (data?.funds as Rec[] | undefined) ?? [];
  const replenishments = (data?.replenishments as Rec[] | undefined) ?? [];
  const totals = (data?.totals as Rec | undefined) ?? {};
  const totalClosing = funds.reduce((a, f) => a + num(f.closingBalance), 0);

  const defaultFund = funds.length ? String(funds[0].id) : '';
  const pickFund = (v: string) => (funds.find((f) => s(f.id) === v) as Rec | undefined);

  const submitReplenishment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repFund) return;
    setBusy('rep');
    setMsg('');
    try {
      const body: Rec = { fundId: Number(repFund), repDate, reason: repReason || undefined };
      if (repAmount) body.amount = Number(repAmount);
      await api('/api/ops/expenditure/replenishments', { method: 'POST', body: JSON.stringify(body) });
      setMsg('Replenishment request created.');
      setShowReq(false);
      setRepAmount('');
      setRepReason('');
      load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const recordTx = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!txFund || !txAmount) return;
    setBusy('tx');
    setMsg('');
    try {
      await api('/api/ops/expenditure/petty-cash/transactions', {
        method: 'POST',
        body: JSON.stringify({
          fundId: Number(txFund), txType, amount: Number(txAmount),
          reference: txRef || undefined,
          description: txDesc || undefined,
        }),
      });
      setMsg('Transaction recorded.');
      setShowTx(false);
      setTxAmount('');
      setTxRef('');
      setTxDesc('');
      load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const reconcile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recFund || !recCounted) return;
    setBusy('rec');
    setMsg('');
    try {
      await api('/api/ops/expenditure/petty-cash/reconcile', {
        method: 'POST',
        body: JSON.stringify({
          fundId: Number(recFund), countedAmount: Number(recCounted),
          cashDate: recDate, varianceExplanation: recExplain || undefined,
        }),
      });
      setMsg('Reconciliation saved.');
      setShowRec(false);
      setRecCounted('');
      setRecExplain('');
      load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const act = (action: string, label: string, id: number, body?: Rec) => {
    setBusy(`${action}:${id}`);
    setMsg('');
    api(`/api/ops/expenditure/replenishments/${id}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}) })
      .then(() => { setMsg(`${label} — saved.`); load(); })
      .catch((e) => setMsg(e.message))
      .finally(() => setBusy(''));
  };

  if (!data && !error) return <PageLoader />;
  if (error) return <ErrorBanner error={error} />;

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0, flex: 1 }}>Petty Cash</h1>
        {can(user, 'expenditure.petty_cash.replenish') && (
          <button className="btn btn-primary" onClick={() => { setRepFund(defaultFund); setShowReq(true); }}>Request Replenishment</button>
        )}
        {can(user, 'expenditure.petty_cash.create') && (
          <button className="btn btn-ghost" onClick={() => { setTxFund(defaultFund); setShowTx(true); }}>Record Transaction</button>
        )}
        {can(user, 'expenditure.petty_cash.reconcile') && (
          <button className="btn btn-ghost" onClick={() => { setRecFund(defaultFund); setShowRec(true); }}>Reconcile Cash</button>
        )}
      </div>
      {msg && <div className="notice-banner">{msg}</div>}

      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Opening balance</span><span className="kpi-value">{fmtMoney(num(totals.opening))}</span><span className="kpi-sub">across all funds</span></div>
        <div className="kpi-card"><span className="kpi-label">Cash received</span><span className="kpi-value">{fmtMoney(num(totals.received))}</span><span className="kpi-sub">receipts + top-ups</span></div>
        <div className="kpi-card"><span className="kpi-label">Cash spent</span><span className="kpi-value">{fmtMoney(num(totals.spent))}</span><span className="kpi-sub">recorded expenses</span></div>
        <div className="kpi-card"><span className="kpi-label">Total closing</span><span className="kpi-value">{fmtMoney(totalClosing)}</span><span className="kpi-sub">{funds.length} funds</span></div>
      </div>

      <div className="kpi-grid--tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {funds.map((f) => {
          const float = num(f.floatAmount);
          const closing = num(f.closingBalance);
          const replenish = Math.max(0, float - closing);
          return (
            <section className="card" key={s(f.id)} style={{ cursor: 'pointer' }} onClick={() => navigate(`/spend/petty-cash/${s(f.id)}`)}>
              <div className="card-head">
                <h3><span className="cell-mono">{s(f.code)}</span> {s(f.name)}</h3>
                <Badge value={f.status} />
              </div>
              <dl className="detail-list">
                <div className="detail-row"><dt>Custodian</dt><dd>{s(f.custodianName) || '—'}</dd></div>
                <div className="detail-row"><dt>Float</dt><dd>{fmtMoney(float)}</dd></div>
                <div className="detail-row"><dt>Received</dt><dd>{fmtMoney(num(f.cashIn))}</dd></div>
                <div className="detail-row"><dt>Spent</dt><dd>{fmtMoney(num(f.cashOut))}</dd></div>
                <div className="detail-row"><dt>Closing</dt><dd>{fmtMoney(closing)}</dd></div>
                <div className="detail-row"><dt>Replenishment</dt><dd>{replenish > 0 ? <strong style={{ color: 'var(--clay)' }}>{fmtMoney(replenish)} required</strong> : 'None'}</dd></div>
              </dl>
            </section>
          );
        })}
        {funds.length === 0 && <p className="empty-state">No petty cash funds configured.</p>}
      </div>

      <section className="card" style={{ marginTop: 18 }}>
        <div className="card-head"><h3>Replenishment Requests</h3></div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>No.</th><th>Fund</th><th>Amount</th><th>Date</th><th>Reason</th><th>Requested by</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {replenishments.map((r) => (
                <tr key={s(r.id)}>
                  <td className="cell-mono">{s(r.repNo)}</td>
                  <td>{s(r.fundName) || s(r.fundCode)}</td>
                  <td>{fmtMoney(num(r.amount))}</td>
                  <td>{fmtDay(r.repDate)}</td>
                  <td style={{ maxWidth: 220 }}>{s(r.reason) || '—'}</td>
                  <td>{s(r.requestedByName) || '—'}</td>
                  <td><Badge value={r.status} /></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {r.status === 'DRAFT' && can(user, 'expenditure.petty_cash.replenish') && (
                      <button className="btn btn-sm" disabled={busy !== ''} onClick={() => act('submit', 'Replenishment submitted', Number(r.id))}>Submit</button>
                    )}
                    {r.status === 'APPROVED' && can(user, 'expenditure.petty_cash.replenish') && (
                      <button className="btn btn-sm btn-primary" disabled={busy !== ''} onClick={() => act('pay', 'Replenishment paid', Number(r.id))}>Pay</button>
                    )}
                  </td>
                </tr>
              ))}
              {replenishments.length === 0 && (
                <tr><td colSpan={8}><p className="empty-state">No replenishment requests.</p></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {showReq && (
        <Modal title="Request Petty Cash Replenishment" onClose={() => setShowReq(false)}
          footer={<> 
            <button className="btn btn-ghost" onClick={() => setShowReq(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== '' || !repFund} onClick={submitReplenishment}>
              {busy === 'rep' ? 'Working…' : 'Create Request'}
            </button>
          </>}>
          <div className="form-grid">
            <label className="field field-required">Fund
              <select value={repFund} onChange={(e) => {
                setRepFund(e.target.value);
                const f = pickFund(e.target.value);
                if (f) setRepAmount(String(Math.max(0, num(f.floatAmount) - num(f.closingBalance))));
              }}>
                {funds.map((f) => <option key={s(f.id)} value={s(f.id)}>{s(f.name)} ({s(f.code)})</option>)}
              </select>
            </label>
            <label className="field field-required">Amount
              <input type="number" min="0" step="0.01" value={repAmount} onChange={(e) => setRepAmount(e.target.value)} />
            </label>
            <label className="field">Date
              <input type="date" value={repDate} onChange={(e) => setRepDate(e.target.value)} />
            </label>
            <label className="field">Reason
              <textarea rows={3} value={repReason} onChange={(e) => setRepReason(e.target.value)} placeholder="Why is the float being replenished?" />
            </label>
          </div>
        </Modal>
      )}

      {showTx && (
        <Modal title="Record Petty Cash Transaction" onClose={() => setShowTx(false)}
          footer={<> 
            <button className="btn btn-ghost" onClick={() => setShowTx(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== '' || !txFund || !txAmount} onClick={recordTx}>
              {busy === 'tx' ? 'Working…' : 'Record Transaction'}
            </button>
          </>}>
          <div className="form-grid">
            <label className="field field-required">Fund
              <select value={txFund} onChange={(e) => setTxFund(e.target.value)}>
                {funds.map((f) => <option key={s(f.id)} value={s(f.id)}>{s(f.name)} ({s(f.code)})</option>)}
              </select>
            </label>
            <label className="field field-required">Type
              <select value={txType} onChange={(e) => setTxType(e.target.value)}>
                {PC_TX_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
            </label>
            <label className="field field-required">Amount
              <input type="number" min="0" step="0.01" value={txAmount} onChange={(e) => setTxAmount(e.target.value)} />
            </label>
            <label className="field">Reference
              <input value={txRef} onChange={(e) => setTxRef(e.target.value)} placeholder="Receipt / voucher no." />
            </label>
            <label className="field">Description
              <input value={txDesc} onChange={(e) => setTxDesc(e.target.value)} placeholder="What is this for?" />
            </label>
          </div>
        </Modal>
      )}

      {showRec && (
        <Modal title="Reconcile Petty Cash" onClose={() => setShowRec(false)}
          footer={<> 
            <button className="btn btn-ghost" onClick={() => setShowRec(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== '' || !recFund || !recCounted} onClick={reconcile}>
              {busy === 'rec' ? 'Working…' : 'Save Reconciliation'}
            </button>
          </>}>
          <div className="form-grid">
            <label className="field field-required">Fund
              <select value={recFund} onChange={(e) => setRecFund(e.target.value)}>
                {funds.map((f) => <option key={s(f.id)} value={s(f.id)}>{s(f.name)} ({s(f.code)})</option>)}
              </select>
            </label>
            <label className="field field-required">Counted cash
              <input type="number" min="0" step="0.01" value={recCounted} onChange={(e) => setRecCounted(e.target.value)} />
            </label>
            <label className="field">Date
              <input type="date" value={recDate} onChange={(e) => setRecDate(e.target.value)} />
            </label>
            <label className="field">Variance explanation
              <textarea rows={3} value={recExplain} onChange={(e) => setRecExplain(e.target.value)} placeholder="Required if counted cash differs from the expected balance" />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

function PettyCashFund({ id }: { id: number }) {
  const { user } = useAuth();
  const [row, setRow] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [showTx, setShowTx] = useState(false);
  const [showRec, setShowRec] = useState(false);
  const [txType, setTxType] = useState('EXPENSE');
  const [txAmount, setTxAmount] = useState('');
  const [txRef, setTxRef] = useState('');
  const [txDesc, setTxDesc] = useState('');
  const [recCounted, setRecCounted] = useState('');
  const [recExplain, setRecExplain] = useState('');

  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/expenditure/petty-cash/${id}`)
      .then((r) => setRow(r.data))
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (!row && !error) return <PageLoader />;
  if (error) return <ErrorBanner error={error} />;
  const f = row as Rec;
  const txs = (f.transactions as Rec[] | undefined) ?? [];
  const float = num(f.floatAmount);
  const closing = num(f.closingBalance);
  const replenish = Math.max(0, float - closing);

  const recordTx = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!txAmount) return;
    setBusy('tx');
    setMsg('');
    try {
      await api('/api/ops/expenditure/petty-cash/transactions', {
        method: 'POST',
        body: JSON.stringify({ fundId: id, txType, amount: Number(txAmount), reference: txRef || undefined, description: txDesc || undefined }),
      });
      setMsg('Transaction recorded.');
      setShowTx(false);
      setTxAmount('');
      setTxRef('');
      setTxDesc('');
      load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const reconcile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recCounted) return;
    setBusy('rec');
    setMsg('');
    try {
      await api('/api/ops/expenditure/petty-cash/reconcile', {
        method: 'POST',
        body: JSON.stringify({ fundId: id, countedAmount: Number(recCounted), varianceExplanation: recExplain || undefined }),
      });
      setMsg('Reconciliation saved.');
      setShowRec(false);
      setRecCounted('');
      setRecExplain('');
      load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-ghost" onClick={() => navigate('/spend/petty-cash')}>← Petty Cash</button>
        <h1 style={{ margin: 0, flex: 1 }}><span className="cell-mono">{s(f.code)}</span> {s(f.name)} <Badge value={f.status} /></h1>
        {can(user, 'expenditure.petty_cash.create') && <button className="btn btn-ghost" onClick={() => setShowTx(true)}>Record Transaction</button>}
        {can(user, 'expenditure.petty_cash.reconcile') && <button className="btn btn-ghost" onClick={() => setShowRec(true)}>Reconcile</button>}
      </div>
      {msg && <div className="notice-banner">{msg}</div>}

      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Float</span><span className="kpi-value">{fmtMoney(float)}</span><span className="kpi-sub">imprest limit</span></div>
        <div className="kpi-card"><span className="kpi-label">Opening</span><span className="kpi-value">{fmtMoney(num(f.openingBalance))}</span><span className="kpi-sub">fund opening</span></div>
        <div className="kpi-card"><span className="kpi-label">Cash in</span><span className="kpi-value">{fmtMoney(num(f.cashIn))}</span><span className="kpi-sub">receipts + top-ups</span></div>
        <div className="kpi-card"><span className="kpi-label">Cash out</span><span className="kpi-value">{fmtMoney(num(f.cashOut))}</span><span className="kpi-sub">recorded expenses</span></div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Closing balance</span><span className="kpi-value">{fmtMoney(closing)}</span><span className="kpi-sub">expected cash on hand</span></div>
        <div className="kpi-card"><span className="kpi-label">Replenishment</span><span className="kpi-value" style={{ color: replenish > 0 ? 'var(--clay)' : undefined }}>{fmtMoney(replenish)}</span><span className="kpi-sub">{replenish > 0 ? 'required to restore float' : 'float intact'}</span></div>
        <div className="kpi-card"><span className="kpi-label">Custodian</span><span className="kpi-value" style={{ fontSize: 15 }}>{s(f.custodianName) || '—'}</span><span className="kpi-sub">fund custodian</span></div>
        <div className="kpi-card"><span className="kpi-label">Currency</span><span className="kpi-value">{s(f.currency) || 'UGX'}</span><span className="kpi-sub">{txs.length} transactions</span></div>
      </div>

      <section className="card" style={{ marginTop: 18 }}>
        <div className="card-head"><h3>Transactions</h3></div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Type</th><th>Amount</th><th>Balance after</th><th>Reference</th><th>Description</th><th>Linked expense</th><th>By</th></tr>
            </thead>
            <tbody>
              {txs.map((t) => (
                <tr key={s(t.id)}>
                  <td>{fmtDay(t.txDate)}</td>
                  <td><Badge value={t.txType} /></td>
                  <td className="cell-mono" style={{ color: t.txType === 'EXPENSE' ? 'var(--clay)' : undefined }}>
                    {t.txType === 'EXPENSE' ? '-' : '+'}{fmtMoney(num(t.amount))}
                  </td>
                  <td className="cell-mono">{fmtMoney(num(t.balanceAfter))}</td>
                  <td className="cell-mono">{s(t.reference) || '—'}</td>
                  <td style={{ maxWidth: 260 }}>{s(t.description) || '—'}</td>
                  <td className="cell-mono">{s(t.expNo) || '—'}</td>
                  <td>{s(t.createdByName) || '—'}</td>
                </tr>
              ))}
              {txs.length === 0 && <tr><td colSpan={8}><p className="empty-state">No transactions recorded.</p></td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {showTx && (
        <Modal title="Record Petty Cash Transaction" onClose={() => setShowTx(false)}
          footer={<> 
            <button className="btn btn-ghost" onClick={() => setShowTx(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== '' || !txAmount} onClick={recordTx}>
              {busy === 'tx' ? 'Working…' : 'Record Transaction'}
            </button>
          </>}>
          <div className="form-grid">
            <label className="field field-required">Type
              <select value={txType} onChange={(e) => setTxType(e.target.value)}>
                {PC_TX_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
            </label>
            <label className="field field-required">Amount
              <input type="number" min="0" step="0.01" value={txAmount} onChange={(e) => setTxAmount(e.target.value)} />
            </label>
            <label className="field">Reference
              <input value={txRef} onChange={(e) => setTxRef(e.target.value)} placeholder="Receipt / voucher no." />
            </label>
            <label className="field">Description
              <input value={txDesc} onChange={(e) => setTxDesc(e.target.value)} placeholder="What is this for?" />
            </label>
          </div>
        </Modal>
      )}

      {showRec && (
        <Modal title={`Reconcile ${s(f.code)}`} onClose={() => setShowRec(false)}
          footer={<> 
            <button className="btn btn-ghost" onClick={() => setShowRec(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== '' || !recCounted} onClick={reconcile}>
              {busy === 'rec' ? 'Working…' : 'Save Reconciliation'}
            </button>
          </>}>
          <p className="empty-state">Expected closing balance: {fmtMoney(closing)}.</p>
          <div className="form-grid">
            <label className="field field-required">Counted cash
              <input type="number" min="0" step="0.01" value={recCounted} onChange={(e) => setRecCounted(e.target.value)} />
            </label>
            <label className="field">Variance explanation
              <textarea rows={3} value={recExplain} onChange={(e) => setRecExplain(e.target.value)} placeholder="Required if counted cash differs from expected" />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
// ---------- Employee Expense Claims ----------

function ClaimsList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    let alive = true;
    api<{ data: Rec[] }>('/api/ops/expenditure/claims')
      .then((r) => alive && setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);
  const filtered = status ? rows.filter((r) => s(r.status) === status) : rows;
  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0, flex: 1 }}>Employee Expense Claims</h1>
        {can(user, 'expenditure.claims.create') && <button className="btn btn-primary" onClick={() => navigate('/spend/claims/new')}>+ New Claim</button>}
      </div>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <StatusFilter value={status} onChange={setStatus} options={['DRAFT', 'SUBMITTED', 'APPROVED', 'REIMBURSED', 'REJECTED']} />
        <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>{filtered.length} claim(s)</span>
      </div>
      <section className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Claim no.</th><th>Employee</th><th>Trip</th><th>Description</th><th>Date</th><th>Amount</th><th>Method</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={s(r.id)}>
                  <td className="cell-mono">{s(r.claimNo)}</td>
                  <td>{personName(r)}</td>
                  <td style={{ maxWidth: 180 }}>{s(r.trip) || '—'}</td>
                  <td style={{ maxWidth: 240 }}>{s(r.description) || '—'}</td>
                  <td>{fmtDay(r.expenseDate)}</td>
                  <td className="cell-mono">{fmtMoney(num(r.amount))}</td>
                  <td>{s(r.paymentMethodName) || '—'}</td>
                  <td><Badge value={r.status} /></td>
                  <td style={{ textAlign: 'right' }}><button className="btn btn-sm" onClick={() => navigate(`/spend/claims/${s(r.id)}`)}>Open</button></td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={9}><p className="empty-state">No claims found.</p></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ClaimForm() {
  const [meta, setMeta] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [trip, setTrip] = useState('');
  const [description, setDescription] = useState('');
  const [expenseDate, setExpenseDate] = useState(todayIso());
  const [amount, setAmount] = useState('');
  const [paymentMethodId, setPaymentMethodId] = useState('');
  useEffect(() => {
    let alive = true;
    api<{ data: Rec }>('/api/ops/expenditure/meta')
      .then((r) => alive && setMeta(r.data))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);
  const employees = (meta?.employees as Rec[] | undefined) ?? [];
  const paymentMethods = (meta?.paymentMethods as Rec[] | undefined) ?? [];
  if (!meta && !error) return <PageLoader />;
  if (error) return <ErrorBanner error={error} />;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const r = await api<{ data: Rec }>('/api/ops/expenditure/claims', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: Number(employeeId) || undefined,
          trip: trip || undefined,
          description: description || undefined,
          expenseDate,
          amount: Number(amount),
          paymentMethodId: Number(paymentMethodId) || undefined,
        }),
      });
      navigate(`/spend/claims/${s(r.data.id)}`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-ghost" onClick={() => navigate('/spend/claims')}>← Claims</button>
        <h1 style={{ margin: 0, flex: 1 }}>New Expense Claim</h1>
      </div>
      {msg && <div className="notice-banner">{msg}</div>}
      <section className="card">
        <div className="card-head"><h3>Claim details</h3></div>
        <div className="form-grid">
          <label className="field field-required">Employee
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Select employee</option>
              {employees.map((em) => <option key={s(em.id)} value={s(em.id)}>{s(em.name) || personName(em)}</option>)}
            </select>
          </label>
          <label className="field">Trip
            <input value={trip} onChange={(e) => setTrip(e.target.value)} placeholder="e.g. Kampala → Jinja" />
          </label>
          <label className="field">Description
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is being claimed?" />
          </label>
          <label className="field field-required">Expense date
            <input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
          </label>
          <label className="field field-required">Amount (UGX)
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </label>
          <label className="field">Payment method
            <select value={paymentMethodId} onChange={(e) => setPaymentMethodId(e.target.value)}>
              <option value="">Default</option>
              {paymentMethods.map((m) => <option key={s(m.id)} value={s(m.id)}>{s(m.name)}</option>)}
            </select>
          </label>
        </div>
        <div style={{ padding: '0 16px 16px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-ghost" onClick={() => navigate('/spend/claims')}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !amount} onClick={submit}>{busy ? 'Working…' : 'Create Draft'}</button>
        </div>
      </section>
    </div>
  );
}

function ClaimDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [row, setRow] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [file, setFile] = useState<File | undefined>(undefined);
  const [reimburseMethod, setReimburseMethod] = useState('');
  const [showReimburse, setShowReimburse] = useState(false);
  const [methods, setMethods] = useState<Rec[]>([]);

  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/expenditure/claims/${id}`)
      .then((r) => setRow(r.data))
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    let alive = true;
    api<{ data: Rec }>('/api/ops/expenditure/meta')
      .then((r) => alive && setMethods((r.data.paymentMethods as Rec[] | undefined) ?? []))
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const act = (action: string, label: string, body?: Rec) => {
    setBusy(action);
    setMsg('');
    api<{ data: Rec }>(`/api/ops/expenditure/claims/${id}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}) })
      .then(() => { setMsg(`${label} — saved.`); setShowReimburse(false); load(); })
      .catch((e) => setMsg(e.message))
      .finally(() => setBusy(''));
  };

  const attach = async () => {
    if (!file) return;
    setBusy('receipt');
    setMsg('');
    try {
      await uploadReceiptInput(file, 'CLAIM', id);
      setMsg('Receipt uploaded.');
      setFile(undefined);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  if (!row && !error) return <PageLoader />;
  if (error) return <ErrorBanner error={error} />;
  const c = row as Rec;
  const receipts = (c.receipts as Rec[] | undefined) ?? [];
  const isDraft = c.status === 'DRAFT';
  const isApproved = c.status === 'APPROVED';
  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-ghost" onClick={() => navigate('/spend/claims')}>← Claims</button>
        <h1 style={{ margin: 0, flex: 1 }}><span className="cell-mono">{s(c.claimNo)}</span> <Badge value={c.status} /></h1>
        {isDraft && can(user, 'expenditure.claims.create') && (
          <button className="btn btn-primary" disabled={busy !== ''} onClick={() => act('submit', 'Claim submitted')}>{busy === 'submit' ? 'Working…' : 'Submit for Approval'}</button>
        )}
        {isApproved && can(user, 'expenditure.claims.reimburse') && (
          <button className="btn btn-primary" disabled={busy !== ''} onClick={() => setShowReimburse(true)}>Reimburse</button>
        )}
      </div>
      {msg && <div className="notice-banner">{msg}</div>}
      <Pipeline steps={['DRAFT', 'SUBMITTED', 'APPROVED', 'REIMBURSED']} status={s(c.status)} />

      <div className="form-grid">
        <section className="card">
          <div className="card-head"><h3>Claim</h3></div>
          <dl className="detail-list">
            <div className="detail-row"><dt>Employee</dt><dd>{personName(c)}</dd></div>
            <div className="detail-row"><dt>Employee no.</dt><dd>{s(c.employeeNo) || '—'}</dd></div>
            <div className="detail-row"><dt>Trip</dt><dd>{s(c.trip) || '—'}</dd></div>
            <div className="detail-row"><dt>Description</dt><dd>{s(c.description) || '—'}</dd></div>
            <div className="detail-row"><dt>Date</dt><dd>{fmtDay(c.expenseDate)}</dd></div>
            <div className="detail-row"><dt>Amount</dt><dd>{fmtMoney(num(c.amount))} {s(c.currency) || 'UGX'}</dd></div>
            <div className="detail-row"><dt>Payment method</dt><dd>{s(c.paymentMethodName) || '—'}</dd></div>
            <div className="detail-row"><dt>GL posted</dt><dd>{c.glPosted === true || c.glPosted === 'true' ? 'Yes' : 'No'}</dd></div>
            <div className="detail-row"><dt>Created by</dt><dd>{s(c.createdByName) || '—'}</dd></div>
          </dl>
        </section>
        <section className="card">
          <div className="card-head"><h3>Receipts</h3></div>
          <ReceiptChips receipts={receipts} />
          <div style={{ padding: '12px 16px', display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? undefined)} />
            <button className="btn btn-sm" disabled={busy !== '' || !file} onClick={attach}>{busy === 'receipt' ? 'Uploading…' : 'Upload Receipt'}</button>
          </div>
        </section>
      </div>

      {showReimburse && (
        <Modal title={`Reimburse ${s(c.claimNo)}?`} onClose={() => setShowReimburse(false)}
          footer={<> 
            <button className="btn btn-ghost" onClick={() => setShowReimburse(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== ''} onClick={() => act('reimburse', 'Claim reimbursed', { paymentMethodId: Number(reimburseMethod) || undefined })}>
              {busy === 'reimburse' ? 'Working…' : 'Confirm Reimbursement'}
            </button>
          </>}>
          <p className="empty-state">Reimbursement posts the employee expense to the ledger and marks the claim as reimbursed.</p>
          <div className="form-grid">
            <label className="field">Payment method
              <select value={reimburseMethod} onChange={(e) => setReimburseMethod(e.target.value)}>
                <option value="">Use default ({s(c.paymentMethodName) || 'not set'})</option>
                {methods.map((m) => <option key={s(m.id)} value={s(m.id)}>{s(m.name)}</option>)}
              </select>
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
// ---------- Daily Close ----------

function DailyCloseDesk() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [date, setDate] = useState(todayIso());
  const [showCreate, setShowCreate] = useState(false);
  const [physicalCash, setPhysicalCash] = useState('');
  const [cashTransfers, setCashTransfers] = useState('');
  const [varianceExplanation, setVarianceExplanation] = useState('');
  const [reviewNotes, setReviewNotes] = useState('');

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    api<{ data: Rec }>(`/api/ops/expenditure/daily-close/status?${params.toString()}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e.message));
  }, [date]);
  useEffect(load, [load]);

  const createClose = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('create');
    setMsg('');
    try {
      const body: Rec = { closeDate: date };
      if (cashTransfers.trim()) body.cashTransfers = Number(cashTransfers);
      if (physicalCash.trim()) body.physicalCash = Number(physicalCash);
      if (varianceExplanation.trim()) body.varianceExplanation = varianceExplanation.trim();
      if (reviewNotes.trim()) body.reviewNotes = { notes: reviewNotes.trim() };
      await api<{ data: Rec }>('/api/ops/expenditure/daily-close', { method: 'POST', body: JSON.stringify(body) });
      setMsg('Daily close created — review then submit for finance approval.');
      setShowCreate(false);
      setPhysicalCash('');
      setCashTransfers('');
      setVarianceExplanation('');
      setReviewNotes('');
      load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const submitClose = () => {
    const cur = (data?.existingClose as Rec | null | undefined) ?? null;
    if (!cur) return;
    setBusy('submit');
    setMsg('');
    api(`/api/ops/expenditure/daily-close/${s(cur.id)}/submit`, { method: 'POST' })
      .then(() => { setMsg('Daily close submitted for finance approval.'); load(); })
      .catch((err) => setMsg(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(''));
  };

  if (!data && !error) return <PageLoader />;
  if (error) return <ErrorBanner error={error} />;

  const st = data as Rec;
  const close = (st.existingClose as Rec | null | undefined) ?? null;
  const petty = (st.pettyCash as Rec | undefined) ?? {};
  const byStatus = (st.byStatus as Rec[] | undefined) ?? [];
  const unreceipted = (st.unreceipted as Rec | undefined) ?? {};
  const expectedClosing = close
    ? num(close.expectedClosing)
    : num(petty.opening) + num(petty.received) - num(petty.spent);
  const physical = close ? num(close.physicalCash) : expectedClosing;
  const variance = close ? num(close.variance) : 0;
  const closed = st.closed === true || st.closed === 'true';
  const canCreate = !closed && !close && can(user, 'expenditure.daily_close.create');
  const canSubmit = !closed && !!close && s(close.status) === 'DRAFT' && can(user, 'expenditure.daily_close.create');

  const checklist = [
    'Review all expenditures for the day',
    'Verify receipts are attached',
    'Reconcile petty cash funds',
    'Reconcile mobile money / bank transactions',
    'Review outstanding employee claims',
    'Review pending approvals',
    'Review budget consumption',
    'Capture physical cash and transfers',
    'Submit daily close',
    'Finance approval locks the day',
  ];

  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-ghost" onClick={() => navigate('/spend')}>← Command Center</button>
        <h1 style={{ margin: 0, flex: 1 }}>Daily Close</h1>
        <input type="date" className="search-input" style={{ width: 'auto' }} value={date} onChange={(e) => setDate(e.target.value)} />
        {canCreate && (
          <button className="btn btn-primary" onClick={() => setShowCreate(true)} disabled={busy !== ''}>Create Daily Close</button>
        )}
        {canSubmit && (
          <button className="btn btn-primary" disabled={busy !== ''} onClick={submitClose}>
            {busy === 'submit' ? 'Working…' : 'Submit for Approval'}
          </button>
        )}
      </div>
      {msg && <div className="notice-banner">{msg}</div>}
      {closed && <div className="notice-banner">✓ This day is closed and locked. Corrections require adjustment entries.</div>}

      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Total spent</span><span className="kpi-value">{fmtMoney(num(st.totalExpenditure))}</span><span className="kpi-sub">{num(st.expensesCount)} expense(s) on {fmtDay(st.closeDate)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Receipts attached</span><span className="kpi-value">{num(st.receiptsCount)}</span><span className="kpi-sub">of {num(st.expensesCount)} expense(s)</span></div>
        <div className="kpi-card"><span className="kpi-label">Unreceipted</span><span className="kpi-value" style={num(unreceipted.count) > 0 ? { color: 'var(--clay)' } : undefined}>{fmtMoney(num(unreceipted.total))}</span><span className="kpi-sub">{num(unreceipted.count)} missing receipt(s)</span></div>
        <div className="kpi-card"><span className="kpi-label">Expected closing</span><span className="kpi-value">{fmtMoney(expectedClosing)}</span><span className="kpi-sub">opening + received − spent</span></div>
      </div>

      <div className="form-grid">
        <section className="card">
          <div className="card-head"><h3>Cash position</h3></div>
          <dl className="detail-list">
            <div className="detail-row"><dt>Opening cash</dt><dd>{fmtMoney(num(petty.opening))}</dd></div>
            <div className="detail-row"><dt>Cash received</dt><dd>{fmtMoney(num(petty.received))}</dd></div>
            <div className="detail-row"><dt>Cash spent</dt><dd>{fmtMoney(num(petty.spent))}</dd></div>
            <div className="detail-row"><dt>Cash transfers</dt><dd>{fmtMoney(close ? num(close.cashTransfers) : 0)}</dd></div>
            <div className="detail-row"><dt>Expected closing</dt><dd>{fmtMoney(expectedClosing)}</dd></div>
            <div className="detail-row"><dt>Physical cash</dt><dd>{fmtMoney(physical)}</dd></div>
            <div className="detail-row"><dt>Variance</dt><dd><strong style={{ color: Math.abs(variance) > 0.005 ? 'var(--clay)' : undefined }}>{variance < 0 ? '−' : ''}{fmtMoney(Math.abs(variance))}</strong></dd></div>
            {close && s(close.varianceExplanation) && (
              <div className="detail-row"><dt>Variance explanation</dt><dd>{s(close.varianceExplanation)}</dd></div>
            )}
          </dl>
        </section>

        <section className="card">
          <div className="card-head"><h3>Close checklist</h3></div>
          <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.9 }}>
            {checklist.map((step, i) => (
              <li key={step}>{i + 1}. {step}</li>
            ))}
          </ol>
        </section>
      </div>

      {close && (
        <section className="card" style={{ marginTop: 18 }}>
          <div className="card-head"><h3><span className="cell-mono">{s(close.closeNo)}</span> <Badge value={close.status} /></h3></div>
          <Pipeline steps={['DRAFT', 'SUBMITTED', 'APPROVED']} status={s(close.status)} />
          <dl className="detail-list">
            <div className="detail-row"><dt>Close date</dt><dd>{fmtDay(close.closeDate)}</dd></div>
            <div className="detail-row"><dt>Submitted by</dt><dd>{s(close.submittedByName) || '—'}</dd></div>
            <div className="detail-row"><dt>Approved by</dt><dd>{s(close.approvedByName) || '—'}</dd></div>
            <div className="detail-row"><dt>Review notes</dt><dd>{s((close.reviewNotes as Rec | null | undefined)?.notes) || s(close.reviewNotes) || '—'}</dd></div>
          </dl>
        </section>
      )}

      {byStatus.length > 0 && (
        <section className="card" style={{ marginTop: 18 }}>
          <div className="card-head"><h3>Expenditure by status</h3></div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Status</th><th>Count</th><th>Amount</th></tr>
              </thead>
              <tbody>
                {byStatus.map((r) => (
                  <tr key={s(r.status)}>
                    <td><Badge value={r.status} /></td>
                    <td>{num(r.count)}</td>
                    <td>{fmtMoney(num(r.total))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {showCreate && (
        <Modal title={`Create daily close for ${fmtDay(date)}`} onClose={() => setShowCreate(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== ''} onClick={createClose}>
              {busy === 'create' ? 'Creating…' : 'Create Close'}
            </button>
          </>}>
          <form onSubmit={createClose}>
            <div className="form-grid">
              <label className="field">Physical cash
                <input type="number" min="0" step="0.01" value={physicalCash} onChange={(e) => setPhysicalCash(e.target.value)} placeholder="Leave empty to use expected closing" />
              </label>
              <label className="field">Cash transfers
                <input type="number" step="0.01" value={cashTransfers} onChange={(e) => setCashTransfers(e.target.value)} placeholder="0" />
              </label>
              <label className="field">Variance explanation
                <textarea rows={3} value={varianceExplanation} onChange={(e) => setVarianceExplanation(e.target.value)} placeholder="Required when physical cash differs from expected closing" />
              </label>
              <label className="field">Review notes
                <textarea rows={3} value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} placeholder="Optional notes for finance" />
              </label>
            </div>
            <p className="empty-state">Creating a close locks the day's register. Once submitted, edits are restricted and corrections become adjustment entries.</p>
          </form>
        </Modal>
      )}
    </div>
  );
}
