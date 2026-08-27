import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDate, fmtMoney, fmtNum, getToken, openDocument } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';
import DownloadMenu from '../components/DownloadMenu';
import { SupplierPicker } from '../components/SupplierPicker';
import { pick } from '../helpers';

type Rec = Record<string, unknown>;

const PAGE_SIZE = 25;

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function lineTotal(qty: number, price: number, tax: number, discount = 0): number {
  const base = qty * price;
  const discountAmt = base * (discount / 100);
  const taxable = base - discountAmt;
  return Math.round((base - discountAmt + taxable * (tax / 100)) * 100) / 100;
}

const DAY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isoDay(v: unknown): string {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Format a calendar date (or timestamp) as `21 Aug 2026` without timezone drift. */
function fmtDay(v: unknown): string {
  const s = isoDay(v);
  if (!s) return fmtDate(v);
  const [y, mo, d] = s.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${DAY_MONTHS[mo - 1]} ${y}`;
}

function addDays(iso: string, days: number): string {
  const s = isoDay(iso);
  if (!s) return iso;
  const [y, mo, d] = s.split('-').map(Number);
  const dt = new Date(y, mo - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function dueMeta(required: unknown, status: unknown): { label: string; tone: string } | null {
  const st = String(status ?? '');
  if (!['SUBMITTED', 'APPROVED', 'PARTIALLY_ORDERED'].includes(st)) return null;
  const s = isoDay(required);
  if (!s) return null;
  const [y, mo, d] = s.split('-').map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(y, mo - 1, d);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (days < 0) return { label: `Overdue ${-days}d`, tone: 'badge-danger' };
  if (days === 0) return { label: 'Due today', tone: 'badge-amber' };
  if (days <= 3) return { label: `Due in ${days}d`, tone: 'badge-amber' };
  return null;
}

function DueBadge({ required, status }: { required: unknown; status: unknown }) {
  const meta = dueMeta(required, status);
  if (!meta) return null;
  return (
    <span className={`badge ${meta.tone}`}>
      <span className="badge-icon" aria-hidden>!</span>
      {meta.label}
    </span>
  );
}

const copyText = async (value: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
};

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      title="Copy to clipboard"
      onClick={() => {
        void copyText(value).then((ok) => {
          if (ok) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }
        });
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function personName(row: Rec): string {
  const name = `${String(row.firstName ?? '')} ${String(row.lastName ?? '')}`.trim();
  return name || String(row.username ?? 'Unknown');
}

function fmtBytes(v: unknown): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const PR_STEPS = ['DRAFT', 'SUBMITTED', 'APPROVED', 'CONVERTED'];
const RFQ_STEPS = ['DRAFT', 'ISSUED', 'AWARDED'];
const PO_STEPS = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RECEIVED'];
const GRN_STEPS = ['RECEIVED', 'APPROVED'];
const INV_STEPS = ['DRAFT', 'SUBMITTED', 'APPROVED', 'MATCHED', 'PAID'];

function Pipeline({ steps, status, map }: { steps: string[]; status: string; map?: Record<string, string> }) {
  const norm = map && map[status] ? map[status] : status;
  const idx = Math.max(0, steps.indexOf(norm));
  const known = steps.includes(norm);
  return (
    <ol className="pipeline">
      {steps.map((s, i) => (
        <li key={s} className={`pipeline-step ${known && i <= idx ? 'done' : ''} ${known && i === idx ? 'current' : ''}`}>
          <span className="pipeline-dot">{i + 1}</span>
          <span>{s.replace(/_/g, ' ')}</span>
        </li>
      ))}
    </ol>
  );
}

const BUY_TABS: [string, string][] = [
  ['board', 'Board'],
  ['demand', 'Demand'],
  ['requisitions', 'Requisitions'],
  ['rfqs', 'RFQs'],
  ['orders', 'Orders'],
  ['receipts', 'Receipts'],
  ['invoices', 'Invoices'],
  ['match', 'Match'],
  ['prices', 'Prices'],
  ['payments', 'Payments'],
];

function BuyTabs({ active }: { active: string }) {
  return (
    <div className="otc-tabs">
      {BUY_TABS.map(([key, label]) => (
        <button key={key} className={`tab ${active === key ? 'active' : ''}`} onClick={() => navigate(key === 'board' ? '/buy' : `/buy/${key}`)}>
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
      {options.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
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

function RelatedDocs({
  title,
  rows,
  href,
  codeKeys,
}: {
  title: string;
  rows: Rec[];
  href: (row: Rec) => string;
  codeKeys: string[];
}) {
  if (!rows.length) return null;
  return (
    <section className="card">
      <div className="card-head"><h3>{title}</h3></div>
      <div className="related-list">
        {rows.map((r) => (
          <button key={String(r.id)} className="related-item" onClick={() => navigate(href(r))}>
            <span className="cell-mono">{String(pick(r, ...codeKeys) ?? r.id)}</span>
            {r.status != null && <Badge value={r.status} />}
          </button>
        ))}
      </div>
    </section>
  );
}

function parseBuy(path: string): { view: string; id: string | null; action: string | null } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'buy') return { view: 'board', id: null, action: null };
  return { view: parts[1] ?? 'board', id: parts[2] ?? null, action: parts[3] ?? null };
}

export default function ProcurementFlow({ path }: { path: string }) {
  const { view, id, action } = parseBuy(path);
  if (view === 'requisitions' && id && action === 'edit') return <PrComposer editId={Number(id)} />;
  if (view === 'requisitions' && id === 'new') return <PrComposer />;
  if (view === 'requisitions' && id) return <PrDesk id={Number(id)} />;
  if (view === 'requisitions') return <PrList />;
  if (view === 'rfqs' && id) return <RfqDesk id={Number(id)} />;
  if (view === 'rfqs') return <RfqList />;
  if (view === 'orders' && id === 'new') return <PoComposer />;
  if (view === 'orders' && id) return <PoDesk id={Number(id)} />;
  if (view === 'orders') return <PoList />;
  if (view === 'receipts' && id) return <GrnDesk id={Number(id)} />;
  if (view === 'receipts') return <GrnList />;
  if (view === 'invoices' && id) return <InvoiceDesk id={Number(id)} />;
  if (view === 'invoices') return <InvoiceList />;
  if (view === 'match' && id) return <MatchDetail poId={Number(id)} />;
  if (view === 'match') return <MatchDesk />;
  if (view === 'prices') return <PricesDesk />;
  if (view === 'payments' && id) return <PaymentDesk id={Number(id)} />;
  if (view === 'payments') return <PaymentList />;
  if (view === 'demand') return <DemandDesk />;
  if (view === 'office-needs') return <OfficeNeedsForm />;
  return <BuyBoard />;
}

function BuyBoard() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/procurement/board')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Buy board failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening procurement…" />;
  const kpis = (data.kpis ?? {}) as Rec;
  const inbound = (data.inbound as Rec[]) ?? [];
  const awaiting = (data.awaiting as Rec[]) ?? [];
  const invoices = (data.invoices as Rec[]) ?? [];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="proc">Procurement</p>
          <h1>Buy board</h1>
          <p className="muted">Requisition &gt; RFQ &gt; PO &gt; GRN &gt; three-way match &gt; AP. Stock and the ledger move with the receipt.</p>
        </div>
        <div className="head-actions">
          {can(user, 'procurement.requisitions.create') && <button className="btn" onClick={() => navigate('/buy/office-needs')}>Office needs</button>}
          {can(user, 'procurement.requisitions.create') && <button className="btn" onClick={() => navigate('/buy/requisitions/new')}>New PR</button>}
          {can(user, 'procurement.orders.create') && <button className="btn btn-primary" onClick={() => navigate('/buy/orders/new')}>New PO</button>}
        </div>
      </header>
      <BuyTabs active="board" />
      <div className="kpi-grid">
        <button className="kpi-card" onClick={() => navigate('/buy/requisitions')}>
          <span className="kpi-label">Open PRs</span>
          <span className="kpi-value">{fmtNum(kpis.openPrs)}</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/buy/orders')}>
          <span className="kpi-label">Awaiting release</span>
          <span className="kpi-value">{fmtNum(kpis.awaiting)}</span>
          <span className="kpi-sub">Draft or submitted</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/buy/orders')}>
          <span className="kpi-label">Open POs</span>
          <span className="kpi-value">{fmtNum(kpis.openPos)}</span>
          <span className="kpi-sub">Committed {fmtMoney(kpis.committed)}</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/buy/invoices')}>
          <span className="kpi-label">Open AP</span>
          <span className="kpi-value">{fmtMoney(kpis.openAp)}</span>
          <span className="kpi-sub">{fmtNum(kpis.unmatched)} unmatched</span>
        </button>
      </div>
      <div className="do-now">
        <button onClick={() => navigate('/buy/demand')}><strong>Demand</strong><span>Plant shortages and MRP</span></button>
        <button onClick={() => navigate('/buy/requisitions')}><strong>Requisitions</strong><span>Convert to PO</span></button>
        <button onClick={() => navigate('/inventory/receive')}><strong>Receive</strong><span>Warehouse GRN</span></button>
        <button onClick={() => navigate('/finance/ap')}><strong>Payables</strong><span>Books of AP</span></button>
      </div>
      <section className="card">
        <div className="card-head"><h3>Inbound — approved, not fully received</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>PO</th><th>Supplier</th><th>Status</th><th>Expected</th><th className="cell-num">Remaining</th></tr></thead>
            <tbody>
              {inbound.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/buy/orders/${r.id}`)}>
                  <td className="cell-mono">{String(r.poNo)}</td>
                  <td>{String(r.supplierName)}</td>
                  <td><Badge value={r.status} /></td>
                  <td>{r.expectedDate ? String(r.expectedDate).slice(0, 10) : '—'}</td>
                  <td className="cell-num">{fmtNum(r.remainingQty)}</td>
                </tr>
              ))}
              {inbound.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>Nothing waiting at the dock.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>POs still in draft or workflow</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>PO</th><th>Supplier</th><th>Status</th><th className="cell-num">Total</th></tr></thead>
            <tbody>
              {awaiting.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/buy/orders/${r.id}`)}>
                  <td className="cell-mono">{String(r.poNo)}</td>
                  <td>{String(r.supplierName)}</td>
                  <td><Badge value={r.status} /></td>
                  <td className="cell-num">{fmtMoney(r.total)}</td>
                </tr>
              ))}
              {awaiting.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No drafts.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Open supplier invoices</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Invoice</th><th>Supplier</th><th>Status</th><th>Match</th><th className="cell-num">Total</th></tr></thead>
            <tbody>
              {invoices.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/buy/invoices/${r.id}`)}>
                  <td className="cell-mono">{String(r.supplierInvoiceNo)}</td>
                  <td>{String(r.supplierName)}</td>
                  <td><Badge value={r.status} /></td>
                  <td><Badge value={r.threeWayMatched ? 'OK' : 'OPEN'} /></td>
                  <td className="cell-num">{fmtMoney(r.total)}</td>
                </tr>
              ))}
              {invoices.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 16 }}>No open invoices.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function DemandDesk() {
  const [data, setData] = useState<{ shortages: Rec[]; mrp: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: { shortages: Rec[]; mrp: Rec[] } }>('/api/ops/procurement/demand')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Demand failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const raise = async (productId: number, quantity: number) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: { prNo: string } }>('/api/ops/procurement/demand/make', {
        method: 'POST', body: JSON.stringify({ productId, quantity }),
      });
      setNotice(`Raised ${r.data.prNo}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Loading demand…" />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="proc">Buy demand</p>
          <h1>What the mill still needs</h1>
          <p className="muted">Plant shortages and the latest MRP purchase suggestions. Raising a PR does not skip approval.</p>
        </div>
      </header>
      <BuyTabs active="demand" />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <section className="card">
        <div className="card-head"><h3>Plant shortages</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Material</th><th className="cell-num">Short</th><th className="cell-num">Available</th><th /></tr></thead>
            <tbody>
              {data.shortages.map((s) => (
                <tr key={String(s.productId)}>
                  <td><div className="cell-mono">{String(s.code)}</div>{String(s.name)}</td>
                  <td className="cell-num">{fmtNum(s.shortQty)}</td>
                  <td className="cell-num">{fmtNum(s.available)}</td>
                  <td><button className="btn btn-sm btn-primary" disabled={busy} onClick={() => raise(Number(s.productId), Number(s.shortQty))}>Raise PR</button></td>
                </tr>
              ))}
              {data.shortages.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No live shortages.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>MRP purchase suggestions</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Material</th><th className="cell-num">Suggested</th><th /></tr></thead>
            <tbody>
              {data.mrp.map((s) => (
                <tr key={String(s.productId)}>
                  <td><div className="cell-mono">{String(s.code)}</div>{String(s.name)}</td>
                  <td className="cell-num">{fmtNum(s.suggestedQuantity)}</td>
                  <td><button className="btn btn-sm btn-primary" disabled={busy} onClick={() => raise(Number(s.productId), Number(s.suggestedQuantity))}>Raise PR</button></td>
                </tr>
              ))}
              {data.mrp.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 16 }}>Run MRP from production plans to populate suggestions.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function PrList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q.trim()) p.set('q', q.trim());
    if (status) p.set('status', status);
    api<{ data: { rows: Rec[] } }>(`/api/ops/procurement/requisitions?${p}`)
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Requisitions failed'));
  }, [q, status, page]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="proc">Requisitions</p>
          <h1>Purchase requisitions</h1>
          <p className="muted">Raise demand, route it for approval, then convert an approved PR into a PO or RFQ.</p>
        </div>
        <div className="head-actions">
          {can(user, 'procurement.requisitions.create') && <button className="btn" onClick={() => navigate('/buy/office-needs')}>Office needs</button>}
          {can(user, 'procurement.requisitions.create') && <button className="btn btn-primary" onClick={() => navigate('/buy/requisitions/new')}>New PR</button>}
        </div>
      </header>
      <BuyTabs active="requisitions" />
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search PR or requester..." />
        <StatusFilter value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_ORDERED', 'CONVERTED', 'REJECTED', 'CANCELLED']} />
      </div>
      <div className="record-cards mobile-only">
        {rows.map((r) => (
          <button key={String(r.id)} className="record-card" onClick={() => navigate(`/buy/requisitions/${r.id}`)}>
            <div className="record-card-top">
              <strong className="cell-mono">{String(r.prNo)}</strong>
              <Badge value={r.status} />
            </div>
            <div className="record-card-meta">
              <span>{fmtDay(r.requestedDate)}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{fmtDay(r.requiredDate)}<DueBadge required={r.requiredDate} status={r.status} /></span>
              <span>{String(r.category ?? '')}</span>
              <span>{fmtNum(r.itemCount)} lines</span>
              <span>{fmtMoney(r.totalEstimated ?? r.estimatedTotal)}{r.currencyCode && String(r.currencyCode) !== 'UGX' ? ` ${String(r.currencyCode)}` : ''}</span>
            </div>
            <span className="btn btn-sm">View</span>
          </button>
        ))}
        {rows.length === 0 && <p className="muted" style={{ padding: 16 }}>No requisitions.</p>}
      </div>
      <div className="table-wrap card desktop-only">
        <table className="data">
          <thead><tr><th>PR Number</th><th>Requester</th><th>Category</th><th>Requested</th><th>Required</th><th>Status</th><th className="cell-num">Lines</th><th className="cell-num">Estimate</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/buy/requisitions/${r.id}`)}>
                <td><div className="copy-row" style={{ gap: 6 }}><span className="cell-mono">{String(r.prNo)}</span><CopyButton value={String(r.prNo)} /></div></td>
                <td>{String(r.requestedByName ?? '-')}</td>
                <td><Badge value={r.category} /></td>
                <td>{fmtDay(r.requestedDate)}</td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {fmtDay(r.requiredDate)}
                    <DueBadge required={r.requiredDate} status={r.status} />
                  </span>
                </td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{fmtNum(r.itemCount)}</td>
                <td className="cell-num">{fmtMoney(r.totalEstimated ?? r.estimatedTotal)}{r.currencyCode && String(r.currencyCode) !== 'UGX' ? ` ${String(r.currencyCode)}` : ''}</td>
                <td style={{ textAlign: 'right' }}><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/buy/requisitions/${r.id}`); }}>View</button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>No requisitions.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span>{fmtNum(rows.length)} records</span>
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
        <button className="btn btn-sm" disabled={rows.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>Next ›</button>
      </div>
    </div>
  );
}
function PrDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{
    requisition: Rec;
    items: Rec[];
    orders: Rec[];
    rfqs: Rec[];
    workflow: Rec | null;
    comments: Rec[];
    history: Rec[];
    assignments: Rec[];
    attachments: Rec[];
    remainingBudget: number | null;
  } | null>(null);
  const [suppliers, setSuppliers] = useState<Rec[]>([]);
  const [assignees, setAssignees] = useState<Rec[]>([]);
  const [inventory, setInventory] = useState<Rec[] | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [assignNotes, setAssignNotes] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [commentInternal, setCommentInternal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: { requisition: Rec; items: Rec[]; orders: Rec[]; rfqs?: Rec[]; workflow: Rec | null; comments: Rec[]; history: Rec[]; assignments: Rec[]; attachments: Rec[]; remainingBudget: number | null } }>(`/api/ops/procurement/requisitions/${id}`)
      .then((r) => setDoc({ ...r.data, rfqs: r.data.rfqs ?? [] }))
      .catch((e) => setError(e instanceof Error ? e.message : 'PR failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const loadSuppliers = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/procurement/suppliers').then((r) => setSuppliers(r.data ?? [])).catch(() => undefined);
  }, []);
  useEffect(() => { loadSuppliers(); }, [loadSuppliers]);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/procurement/requisition-assignees').then((r) => setAssignees(r.data ?? [])).catch(() => undefined);
    api<{ data: { rows: Rec[] } }>(`/api/ops/procurement/requisitions/${id}/inventory-check`)
      .then((r) => setInventory(r.data?.rows ?? []))
      .catch(() => setInventory(null));
  }, [id]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening requisition..." />;
const pr = doc.requisition;
const status = String(pr.status);
const estTotal = num(pr.totalEstimated) || doc.items.reduce((s, i) => s + num(i.quantity) * num(i.estimatedCost), 0);
const wfInstance = doc.workflow ? (doc.workflow.instance as Rec) : null;
const wfTasks = doc.workflow ? ((doc.workflow.tasks as Rec[]) ?? []) : [];
const act = async (path: string, body: Rec = {}, ok = 'Done') => {
  setBusy(true); setError(''); setNotice('');
  try {
    const r = await api<{ data: Rec }>(path, { method: 'POST', body: JSON.stringify(body) });
    if (r.data.orderId) { navigate(`/buy/orders/${r.data.orderId}`); return; }
    setNotice(ok);
    load();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  } finally { setBusy(false); }
};
const assignOfficer = async () => {
  if (!assigneeId) { setError('Select a procurement officer'); return; }
  setBusy(true); setError(''); setNotice('');
  try {
    await api(`/api/ops/procurement/requisitions/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ officerUserId: Number(assigneeId), notes: assignNotes.trim() || null }),
    });
    setNotice('Officer assigned');
    load();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  } finally { setBusy(false); }
};
const postComment = async () => {
  const body = commentBody.trim();
  if (!body) { setError('Write a comment first'); return; }
  setBusy(true); setError(''); setNotice('');
  try {
    await api(`/api/ops/procurement/requisitions/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, isInternal: commentInternal }),
    });
    setCommentBody('');
    setNotice('Comment added');
    load();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  } finally { setBusy(false); }
};
const uploadFile = async (file: File) => {
  setUploading(true); setError(''); setNotice('');
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('title', file.name.replace(/\.[^.]+$/, ''));
    fd.append('classification', 'INTERNAL');
    const token = getToken();
    const res = await fetch(`/api/ops/procurement/requisitions/${id}/attachments`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: fd,
    });
    if (!res.ok) {
      let msg = `Upload failed (${res.status})`;
      try {
        const b = await res.json();
        if (b?.error?.message) msg = String(b.error.message);
      } catch { /* non-JSON error body */ }
      throw new Error(msg);
    }
    setNotice('Attachment uploaded');
    load();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  } finally { setUploading(false); }
};
const downloadAttachment = async (att: Rec) => {
  setError('');
  try {
    const token = getToken();
    const res = await fetch(`/api/ops/procurement/requisitions/${id}/attachments/${String(att.id)}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(att.fileName ?? `attachment-${String(att.id)}`);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
};
const budgetStatus = String(pr.budgetCheckStatus ?? '');
return (
  <div className="page">
    <header className="page-head">
      <div>
        <button className="btn btn-sm" onClick={() => navigate('/buy/requisitions')}>Back</button>
        <h1>Requisition</h1>
        {pr.prNo ? (
          <div className="copy-row" style={{ marginTop: 4 }}>
            <span className="cell-mono">{String(pr.prNo)}</span>
            <CopyButton value={String(pr.prNo)} />
          </div>
        ) : null}
        {pr.title ? <p className="muted" style={{ fontWeight: 600 }}>{String(pr.title)}</p> : null}
        <p className="muted">{String(pr.requestedByName ?? '')}{pr.budgetCode ? ` | ${String(pr.budgetCode)}` : ''}</p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          <Badge value={pr.category} />
          <Badge value={pr.urgency} />
          <DueBadge required={pr.requiredDate} status={status} />
          <Badge value={String(pr.currencyCode ?? 'UGX')} />
          {budgetStatus ? <Badge value={budgetStatus} /> : null}
          {pr.budgetVariance !== null && pr.budgetVariance !== undefined ? <Badge value={`Var ${fmtMoney(pr.budgetVariance)}`} /> : null}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {status === 'DRAFT' && can(user, 'procurement.requisitions.update') && (
          <button className="btn btn-sm" onClick={() => navigate(`/buy/requisitions/${id}/edit`)}>Edit</button>
        )}
        {status === 'REJECTED' && can(user, 'procurement.requisitions.update') && (
          <button className="btn btn-sm" disabled={busy} onClick={() => act(`/api/ops/procurement/requisitions/${id}/reopen`, {}, 'Reopened as draft')}>Reopen</button>
        )}
        <DownloadMenu type="requisition" id={id} code={String(pr.prNo)} />
        <Badge value={status} />
      </div>
    </header>
    <BuyTabs active="requisitions" />
    {notice && <div className="alert alert-success">{notice}</div>}
    {error && <ErrorBanner error={error} />}
    <Pipeline steps={PR_STEPS} status={status} map={{ PARTIALLY_ORDERED: 'CONVERTED' }} />
    {['REJECTED', 'CANCELLED'].includes(status) && (
      <div className="alert alert-warning">
        This requisition was {status.toLowerCase()}. {status === 'REJECTED' ? 'An approver returned it; amend and resubmit if still required.' : 'It can no longer be converted into a purchase order.'}
        {status === 'REJECTED' && pr.rejectionReason ? <span> Reason: {String(pr.rejectionReason)}</span> : ''}
      </div>
    )}
    <div className="detail-grid">
      <div>
        <section className="card">
          <div className="card-head"><h3>Lines</h3><span className="muted">{fmtNum(doc.items.length)} items</span></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Product</th><th>Description</th><th>Specification</th><th>Category</th><th>Subcategory</th><th>UoM</th><th className="cell-num">Qty</th><th className="cell-num">Ordered</th><th className="cell-num">Est. cost</th><th className="cell-num">Tax</th><th className="cell-num">Disc</th><th className="cell-num">Line total</th></tr></thead>
              <tbody>
                {doc.items.map((i) => (
                  <tr key={String(i.id)}>
                    <td><div className="cell-mono">{String(i.productCode)}</div>{String(i.productName)}</td>
                    <td className="muted">{i.description ? String(i.description) : ''}</td>
                    <td className="muted">{i.specification ? String(i.specification) : ''}</td>
                    <td className="muted">{i.category ? String(i.category) : ''}</td>
                    <td className="muted">{i.subcategory ? String(i.subcategory) : ''}</td>
                    <td className="muted">{i.unitName ? String(i.unitName) : ''}</td>
                    <td className="cell-num">{fmtNum(i.quantity)}</td>
                    <td className="cell-num">{fmtNum(i.orderedQty)}</td>
                    <td className="cell-num">{fmtMoney(i.estimatedCost)}</td>
                    <td className="cell-num">{fmtNum(i.taxRate)}%</td>
                    <td className="cell-num">{fmtNum(i.discountPercent)}%</td>
                    <td className="cell-num">{fmtMoney(num(i.lineTotal) || lineTotal(num(i.quantity), num(i.estimatedCost), num(i.taxRate), num(i.discountPercent)))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={11} className="cell-num" style={{ textAlign: 'right' }}>Estimate</td>
                  <td className="cell-num">{fmtMoney(estTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
        {inventory && inventory.length > 0 && (
          <section className="card">
            <div className="card-head"><h3>Stock advisory</h3><span className="muted">Inventory intelligence</span></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Item</th><th className="cell-num">Requested</th><th className="cell-num">On hand</th><th className="cell-num">Available</th><th className="cell-num">Safety</th><th>Recommendation</th></tr></thead>
                <tbody>
                  {inventory.map((s) => (
                    <tr key={String(s.lineItemId)}>
                      <td><div className="cell-mono">{String(s.productCode)}</div>{String(s.productName)}</td>
                      <td className="cell-num">{fmtNum(s.requested)}</td>
                      <td className="cell-num">{fmtNum(s.onHand)}</td>
                      <td className="cell-num">{fmtNum(s.available)}</td>
                      <td className="cell-num">{fmtNum(s.safetyStock)}</td>
                      <td>
                        <span className={`badge ${s.action === 'TRANSFER' ? 'badge-green' : s.action === 'PARTIAL' ? 'badge-amber' : 'badge-blue'}`}>{String(s.action)}</span>
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{String(s.recommendation)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {wfInstance && (
          <section className="card">
            <div className="card-head"><h3>Approval</h3><Badge value={String(wfInstance.instanceStatus ?? '')} /></div>
            <p className="muted">
              {String(wfInstance.workflowName ?? 'Workflow')}{wfInstance.submittedAt ? ` submitted ${fmtDate(wfInstance.submittedAt)}` : ' instance'}
            </p>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Step</th><th>Approver</th><th>Status</th><th>Decision</th></tr></thead>
                <tbody>
                  {wfTasks.map((t) => (
                    <tr key={String(t.id)}>
                      <td>{String(t.stepName)}</td>
                      <td>{String(t.approverRole ?? t.assigneeName ?? '')}</td>
                      <td><Badge value={String(t.status)} /></td>
                      <td>
                        {t.comment ? String(t.comment) : ''}
                        {t.decidedByName ? ` - ${String(t.decidedByName)}` : ''}
                        {t.decidedAt ? ` (${fmtDate(t.decidedAt)})` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {wfTasks.some((t) => String(t.status) === 'PENDING') && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {wfTasks.filter((t) => String(t.status) === 'PENDING').map((t) => (
                  <span key={String(t.id)} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="muted">{String(t.stepName)}:</span>
                    {can(user, 'workflows.instances.approve') && (
                      <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(`/api/ops/approvals/${String(t.id)}/decide`, { decision: 'APPROVED', comment: '' }, 'Approved')}>Approve</button>
                    )}
                    {can(user, 'workflows.instances.reject') && (
                      <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => { const c = window.prompt('Rejection comment (optional)'); if (c !== null) act(`/api/ops/approvals/${String(t.id)}/decide`, { decision: 'REJECTED', comment: c }, 'Rejected'); }}>Reject</button>
                    )}
                    {can(user, 'workflows.instances.return') && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => { const c = window.prompt('Reason for return (optional)'); if (c !== null) act(`/api/ops/approvals/${String(t.id)}/decide`, { decision: 'RETURNED', comment: c }, 'Returned'); }}>Return</button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {wfTasks.some((t) => String(t.status) === 'PENDING') && can(user, 'workflows.instances.view') && (
              <button className="btn btn-block" style={{ marginTop: 8 }} onClick={() => navigate('/inbox')}>Open approvals inbox</button>
            )}
          </section>
        )}
        {(doc.rfqs ?? []).length > 0 && (
          <RelatedDocs title="RFQs" rows={doc.rfqs ?? []} href={(r) => `/buy/rfqs/${r.id}`} codeKeys={['rfqNo', 'rfq_no']} />
        )}
        {doc.orders.length > 0 && (
          <section className="card">
            <div className="card-head"><h3>Purchase orders</h3></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>PO</th><th>Status</th><th className="cell-num">Total</th></tr></thead>
                <tbody>
                  {doc.orders.map((o) => (
                    <tr key={String(o.id)} className="row-click" onClick={() => navigate(`/buy/orders/${o.id}`)}>
                      <td className="cell-mono">{String(o.poNo)}</td>
                      <td><Badge value={o.status} /></td>
                      <td className="cell-num">{fmtMoney(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {(doc.assignments.length > 0 || can(user, 'procurement.requisitions.update')) && (
          <section className="card">
            <div className="card-head"><h3>Procurement officer</h3></div>
            {can(user, 'procurement.requisitions.update') && (
              <div className="flow-actions">
                <div className="field">
                  <label htmlFor="pr-officer">Officer</label>
                  <select id="pr-officer" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                    <option value="">Assign an officer...</option>
                    {assignees.map((a) => (
                      <option key={String(a.id)} value={String(a.id)}>
                        {personName(a)}{String(a.jobTitle) ? ` | ${String(a.jobTitle)}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pr-assign-notes">Notes (optional)</label>
                  <input id="pr-assign-notes" value={assignNotes} onChange={(e) => setAssignNotes(e.target.value)} placeholder="Assignment notes" />
                </div>
                <button className="btn btn-block btn-primary" disabled={busy || !assigneeId} onClick={assignOfficer}>Assign officer</button>
              </div>
            )}
            {doc.assignments.length > 0 && (
              <div className="timeline" style={{ padding: '4px 16px 12px' }}>
                {doc.assignments.map((a) => (
                  <div key={String(a.id)} className="timeline-item">
                    <div className="timeline-dot" />
                    <div className="timeline-body">
                      <div className="timeline-title"><strong>{personName(a)}</strong></div>
                      <div className="timeline-meta">{fmtDate(a.assignedAt)}{a.notes ? ` | ${String(a.notes)}` : ''}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        <section className="card">
          <div className="card-head"><h3>Comments</h3><span className="muted">{fmtNum(doc.comments.length)}</span></div>
          {can(user, 'procurement.requisitions.update') && (
            <div className="flow-actions">
              <div className="field">
                <label htmlFor="pr-comment">Add a comment</label>
                <textarea id="pr-comment" value={commentBody} onChange={(e) => setCommentBody(e.target.value)} placeholder="Add a comment... use @username to mention a colleague" />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
                <input type="checkbox" checked={commentInternal} onChange={(e) => setCommentInternal(e.target.checked)} />
                Internal note
              </label>
              <button className="btn btn-block btn-primary" disabled={busy || !commentBody.trim()} onClick={postComment}>Post comment</button>
            </div>
          )}
          {doc.comments.length === 0 && <p className="muted" style={{ padding: '4px 16px 12px' }}>No comments yet.</p>}
          <div className="timeline" style={{ padding: '4px 16px 12px' }}>
            {doc.comments.map((c) => (
              <div key={String(c.id)} className="timeline-item">
                <div className="timeline-dot" />
                <div className="timeline-body">
                  <div className="timeline-title">
                    <strong>{personName(c)}</strong>
                    {c.isInternal ? <span className="badge badge-hold">internal</span> : null}
                  </div>
                  <div className="timeline-meta">{fmtDate(c.createdAt)}</div>
                  <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{String(c.body)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h3>Attachments</h3><span className="muted">{fmtNum(doc.attachments.length)} documents</span></div>
          {can(user, 'procurement.requisitions.update') && (
            <div className="flow-actions">
              <div className="field">
                <label htmlFor="pr-upload">Upload supporting document</label>
                <input
                  id="pr-upload"
                  type="file"
                  accept=".pdf,.png,.jpeg,.jpg,.webp,.txt,.csv,.xlsx,.docx,application/pdf,image/png,image/jpeg,image/webp,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  disabled={uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadFile(f);
                    e.target.value = '';
                  }}
                />
              </div>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>PDF, PNG, JPEG, WebP, TXT, CSV, XLSX or DOCX up to 10 MB.</p>
            </div>
          )}
          {doc.attachments.length === 0 && <p className="muted" style={{ padding: '4px 16px 12px' }}>No documents attached.</p>}
          <div className="qr-list" style={{ paddingTop: 4 }}>
            {doc.attachments.map((a) => (
              <div key={String(a.id)} className="qr-chip" style={{ cursor: 'default', flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="cell-mono" style={{ display: 'block' }}>{String(a.fileName)}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {String(a.classification ?? 'INTERNAL')}{a.sizeBytes ? ` | ${fmtBytes(a.sizeBytes)}` : ''} | {personName(a)}{fmtDate(a.createdAt) !== '-' ? ` | ${fmtDate(a.createdAt)}` : ''}
                  </span>
                </span>
                <button className="btn btn-sm" disabled={uploading} onClick={() => void downloadAttachment(a)}>Download</button>
              </div>
            ))}
          </div>
        </section>
        {doc.history.length > 0 && (
          <section className="card">
            <div className="card-head"><h3>Activity</h3><span className="muted">Status trail</span></div>
            <div className="timeline" style={{ padding: '4px 16px 12px' }}>
              {doc.history.map((h) => (
                <div key={String(h.id)} className="timeline-item">
                  <div className="timeline-dot" />
                  <div className="timeline-body">
                    <div className="timeline-title">
                      <span className={`badge ${['REJECTED', 'CANCELLED', 'RETURNED'].includes(String(h.toStatus)) ? 'badge-red' : 'badge-blue'}`}>{String(h.toStatus).replace(/_/g, ' ')}</span>
                      <span className="muted">{personName(h)}</span>
                    </div>
                    <div className="timeline-meta">{fmtDate(h.createdAt)}{h.comment ? ` | ${String(h.comment)}` : ''}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <div className="detail-side">
        <section className="card">
          <div className="card-head"><h3>Next step</h3></div>
          <div className="flow-actions">
            {status === 'DRAFT' && can(user, 'procurement.requisitions.submit') && (
              <button className="btn btn-block btn-primary" disabled={busy} onClick={() => act(`/api/ops/procurement/requisitions/${id}/submit`, {}, 'Submitted')}>Submit for approval</button>
            )}
            {['APPROVED', 'PARTIALLY_ORDERED'].includes(status) && can(user, 'procurement.orders.create') && (
              <>
                <SupplierPicker suppliers={suppliers} value={supplierId} onChange={setSupplierId} onCreated={() => loadSuppliers()} placeholder="Supplier for PO..." />
                <button className="btn btn-block btn-primary" disabled={busy || !supplierId} onClick={() => act(`/api/ops/procurement/requisitions/${id}/convert`, { supplierId: Number(supplierId) }, 'Converted')}>Convert to PO</button>
                <button className="btn btn-block" disabled={busy} onClick={() => {
                  if (!supplierId) { setError('Pick suppliers for the RFQ'); return; }
                  act('/api/ops/procurement/rfqs', { requisitionId: id, supplierIds: [Number(supplierId)] }, 'RFQ issued');
                }}>Issue RFQ</button>
              </>
            )}
            {['DRAFT', 'SUBMITTED'].includes(status) && can(user, 'procurement.requisitions.update') && (
              <button className="btn btn-block btn-warning" disabled={busy} onClick={() => {
                if (window.confirm(`Cancel requisition ${String(pr.prNo)}?`)) act(`/api/ops/procurement/requisitions/${id}/cancel`, {}, 'Cancelled');
              }}>Cancel requisition</button>
            )}
            {['SUBMITTED', 'APPROVED', 'PARTIALLY_ORDERED'].includes(status) && can(user, 'procurement.requisitions.update') && (
              <button className="btn btn-block" disabled={busy} onClick={() => {
                const reason = window.prompt('Reason for holding this requisition (optional)');
                if (reason === null) return;
                act(`/api/ops/procurement/requisitions/${id}/hold`, reason.trim() ? { reason: reason.trim() } : {}, 'Held');
              }}>Hold</button>
            )}
            {status === 'ON_HOLD' && can(user, 'procurement.requisitions.update') && (
              <button className="btn btn-block btn-primary" disabled={busy} onClick={() => act(`/api/ops/procurement/requisitions/${id}/release`, {}, 'Released')}>Release</button>
            )}
            {!['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_ORDERED', 'ON_HOLD'].includes(status) && <p className="muted">No actions available in this status.</p>}
          </div>
        </section>
        <MetaCard
          title="Details"
          rows={[
            ['Requested', fmtDay(pr.requestedDate)],
            ['Required by', fmtDay(pr.requiredDate)],
            ['Requester', pr.requestedByName ? String(pr.requestedByName) : ''],
            ['Department', pr.departmentName ? String(pr.departmentName) : ''],
            ['Company', pr.companyName ? String(pr.companyName) : ''],
            ['Branch', pr.branchName ? String(pr.branchName) : ''],
            ['Fiscal year', pr.fiscalYearName ? String(pr.fiscalYearName) : ''],
            ['Category', pr.category ? String(pr.category) : ''],
            ['Priority', pr.urgency ? String(pr.urgency) : ''],
            ['Currency', pr.currencyName
              ? `${String(pr.currencyCode ?? '')} \u2013 ${String(pr.currencyName)}${pr.currencySymbol ? ` (${String(pr.currencySymbol)})` : ''}`
              : String(pr.currencyCode ?? 'UGX')],
            ['Tax', pr.taxName ? `${String(pr.taxCode ?? '')} \u2013 ${String(pr.taxName)}` : String(pr.taxCode ?? 'VAT18')],
            ['Tax rate', pr.taxRate !== null && pr.taxRate !== undefined ? `${fmtNum(pr.taxRate)}%` : ''],
            ['Tax included', pr.taxIncluded ? 'Yes' : 'No'],
            ['Discount rate', pr.discountRate ? `${fmtNum(pr.discountRate)}%` : ''],
            ['Discount amount', pr.discountAmount ? fmtMoney(pr.discountAmount) : ''],
            ['Delivery cost', pr.deliveryCost ? fmtMoney(pr.deliveryCost) : ''],
            ['Budget code', pr.budgetCode ? String(pr.budgetCode) : ''],
            ['Budget status', budgetStatus],
            ['Budget variance', pr.budgetVariance !== null && pr.budgetVariance !== undefined ? fmtMoney(pr.budgetVariance) : ''],
            ['Cost centre', pr.costCentreName ? String(pr.costCentreName) : ''],
            ['GL account', pr.accountName ? String(pr.accountName) : ''],
            ['Warehouse', pr.warehouseName ? String(pr.warehouseName) : ''],
            ['Delivery location', pr.deliveryLocation ? String(pr.deliveryLocation) : ''],
            ['Incoterm', pr.incoterm ? String(pr.incoterm) : ''],
            ['Ship to', pr.shipToAddress ? String(pr.shipToAddress) : ''],
            ['Delivery instructions', pr.deliveryInstruction ? String(pr.deliveryInstruction) : ''],
            ['Payment terms', pr.paymentTerms ? String(pr.paymentTerms) : ''],
            ['Description', pr.description ? String(pr.description) : ''],
            ['Business justification', pr.businessJustification ? String(pr.businessJustification) : ''],
            ['Confidentiality', pr.confidentialityLevel ? String(pr.confidentialityLevel) : 'INTERNAL'],
            ['Emergency purchase', pr.emergencyPurchase ? 'Yes' : 'No'],
            ['Recurring purchase', pr.recurringPurchase ? 'Yes' : 'No'],
            ['Lines', fmtNum(doc.items.length)],
            ['Estimate', fmtMoney(estTotal)],
          ]}
        />
      </div>
    </div>
  </div>
);
}
function dateInput(v: unknown): string {
  return isoDay(v);
}
interface PrLine {
  key: string;
  productId: number | '';
  quantity: number;
  estimatedCost: number;
  taxRate: number;
  discountRate: number;
  needBy: string;
  suggestedSupplierId: number | '';
  description: string;
  specification: string;
  category: string;
  subcategory: string;
  unitId: number | '';
  glAccountId: number | '';
}

function emptyPrLine(): PrLine {
  return { key: `${Date.now()}-${Math.random()}`, productId: '', quantity: 1, estimatedCost: 0, taxRate: 0, discountRate: 0, needBy: '', suggestedSupplierId: '', description: '', specification: '', category: '', subcategory: '', unitId: '', glAccountId: '' };
}
const OFFICE_PRODUCT_CODES = ['OFF-WATER', 'OFF-AIRTIME'];

function OfficeNeedsForm() {
  const { user } = useAuth();
  const [meta, setMeta] = useState<{ companies: Rec[]; branches: Rec[]; fiscalYears: Rec[]; departments: Rec[]; products: Rec[] } | null>(null);
  const [companyId, setCompanyId] = useState<number | ''>(user?.default_company_id ?? user?.company_id ?? '');
  const [branchId, setBranchId] = useState<number | ''>(user?.default_branch_id ?? user?.branch_id ?? '');
  const [fiscalYearId, setFiscalYearId] = useState<number | ''>(user?.default_fiscal_year_id ?? user?.fiscal_year_id ?? '');
  const [departmentId, setDepartmentId] = useState<number | ''>('');
  const [requestDate, setRequestDate] = useState(() => String(user?.request_date ?? new Date().toISOString().slice(0, 10)));
  const [requiredDate, setRequiredDate] = useState(() => addDays(String(user?.request_date ?? new Date().toISOString().slice(0, 10)), 14));
  const [deliveryLocation, setDeliveryLocation] = useState(user?.default_delivery_location ?? '');
  const [title, setTitle] = useState('Office needs');
  const [notes, setNotes] = useState('');
  const [waterOn, setWaterOn] = useState(true);
  const [waterQty, setWaterQty] = useState(4);
  const [waterCost, setWaterCost] = useState(15000);
  const [airtimeOn, setAirtimeOn] = useState(true);
  const [airtimeAmount, setAirtimeAmount] = useState(100000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: { companies: Rec[]; branches: Rec[]; fiscalYears: Rec[]; departments: Rec[]; products: Rec[] } }>(`/api/ops/procurement/requisition-meta${companyId ? `?company=${Number(companyId)}` : ''}${branchId ? `${companyId ? '&' : '?'}branch=${Number(branchId)}` : ''}`)
      .then((r) => setMeta(r.data))
      .catch(() => undefined);
  }, [companyId, branchId]);
  const officeProducts = useMemo(() => (meta?.products ?? []).filter((p) => OFFICE_PRODUCT_CODES.includes(String(p.code))), [meta]);
  const waterProduct = officeProducts.find((p) => String(p.code) === 'OFF-WATER');
  const airtimeProduct = officeProducts.find((p) => String(p.code) === 'OFF-AIRTIME');
  const waterTotal = waterOn ? Math.max(0, num(waterQty)) * Math.max(0, num(waterCost)) : 0;
  const airtimeTotal = airtimeOn ? Math.max(0, num(airtimeAmount)) : 0;
  const total = waterTotal + airtimeTotal;
  const requester = `${String(user?.first_name ?? '')} ${String(user?.last_name ?? '')}`.trim() || String(user?.username ?? 'You');
  const save = async () => {
    const items: Rec[] = [];
    if (waterOn && waterProduct && num(waterQty) > 0) {
      items.push({
        productId: Number(waterProduct.id), quantity: num(waterQty), estimatedCost: num(waterCost),
        needBy: requiredDate || null, description: 'Bottled water (20L)', taxRate: 0, discountRate: 0,
        unitId: waterProduct.unitId ? Number(waterProduct.unitId) : undefined,
        category: waterProduct.categoryName ?? null, subcategory: waterProduct.categoryParentName ?? null,
      });
    }
    if (airtimeOn && airtimeProduct && num(airtimeAmount) > 0) {
      items.push({
        productId: Number(airtimeProduct.id), quantity: 1, estimatedCost: num(airtimeAmount),
        needBy: requiredDate || null, description: 'Airtime / mobile data', taxRate: 0, discountRate: 0,
        unitId: airtimeProduct.unitId ? Number(airtimeProduct.unitId) : undefined,
        category: airtimeProduct.categoryName ?? null, subcategory: airtimeProduct.categoryParentName ?? null,
      });
    }
    if (!items.length) { setError('Add at least one item (water or airtime) with a quantity or amount'); return; }
    if (requestDate && requiredDate && requiredDate < requestDate) { setError('Required date cannot be before the request date'); return; }
    const body = {
      title: title || null,
      description: 'Simple office needs requisition (water, airtime).',
      businessJustification: 'Routine office consumables to keep the team running.',
      confidentialityLevel: 'INTERNAL',
      emergencyPurchase: false,
      recurringPurchase: false,
      companyId: companyId || null,
      branchId: branchId || null,
      fiscalYearId: fiscalYearId || null,
      category: 'SERVICES',
      urgency: 'NORMAL',
      currencyCode: 'UGX',
      taxCode: 'VAT18',
      taxIncluded: false,
      discountRate: 0,
      deliveryCost: 0,
      departmentId: departmentId || null,
      requestedDate: requestDate || null,
      requiredDate: requiredDate || null,
      deliveryLocation: deliveryLocation || null,
      notes: notes || null,
      items,
    };
    setBusy(true);
    setError('');
    try {
      const r = await api<{ data: { requisitionId: number } }>('/api/ops/procurement/requisitions', { method: 'POST', body: JSON.stringify(body) });
      navigate(`/buy/requisitions/${r.data.requisitionId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="proc">Procurement</p>
          <h1>Office needs requisition</h1>
          <p className="muted">Quick form for simple office consumables — water and airtime. Saves as a DRAFT you can submit for approval.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/buy/requisitions')}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Save draft'}</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Title</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary of the requirement" /></div>
          <div className="field"><label>Requested by</label><input value={requester} disabled /></div>
          <div className="field"><label>Request date</label><input type="date" value={requestDate} onChange={(e) => setRequestDate(e.target.value)} /></div>
          <div className="field"><label>Required by</label><input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} /></div>
          <div className="field"><label>Company</label>
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value ? Number(e.target.value) : '')}>
              {companyId !== '' && !(meta?.companies ?? []).some((c) => Number(c.id) === Number(companyId)) && <option value={String(companyId)}>{user?.company_name ?? `#${companyId}`}</option>}
              {(meta?.companies ?? []).map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.code)} - {String(c.name)}</option>)}
            </select>
          </div>
          <div className="field"><label>Branch</label>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')}>
              {branchId !== '' && !(meta?.branches ?? []).some((b) => Number(b.id) === Number(branchId)) && <option value={String(branchId)}>{user?.branch_name ?? `#${branchId}`}</option>}
              {(meta?.branches ?? []).map((b) => <option key={String(b.id)} value={String(b.id)}>{String(b.code)} - {String(b.name)}</option>)}
            </select>
          </div>
          <div className="field"><label>Fiscal year</label>
            <select value={fiscalYearId} onChange={(e) => setFiscalYearId(e.target.value ? Number(e.target.value) : '')}>
              {fiscalYearId !== '' && !(meta?.fiscalYears ?? []).some((f) => Number(f.id) === Number(fiscalYearId)) && <option value={String(fiscalYearId)}>{user?.fiscal_year_name ?? `#${fiscalYearId}`}</option>}
              {(meta?.fiscalYears ?? []).map((f) => <option key={String(f.id)} value={String(f.id)}>{String(f.code)} - {String(f.name)}</option>)}
            </select>
          </div>
          <div className="field"><label>Department</label>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">No department</option>
              {(meta?.departments ?? []).map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.name)}</option>)}
            </select>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Delivery location</label><input value={deliveryLocation} onChange={(e) => setDeliveryLocation(e.target.value)} placeholder="e.g. Head office, 3rd floor" /></div>
        </div>
      </section>
      <section className="card card-pad">
        <div className="card-head"><h3>Items</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Include</th><th>Item</th><th>Qty</th><th>Est. unit cost</th><th className="cell-num">Total</th></tr></thead>
            <tbody>
              <tr>
                <td><input type="checkbox" checked={waterOn} onChange={(e) => setWaterOn(e.target.checked)} /></td>
                <td>
                  <strong>Bottled water (20L)</strong>
                  {waterProduct && <div className="muted">{String(waterProduct.code)} · std cost {fmtMoney(waterProduct.standardCost)}</div>}
                </td>
                <td><input type="number" min={0} value={waterQty} onChange={(e) => setWaterQty(Number(e.target.value))} style={{ width: 90 }} /></td>
                <td><input type="number" min={0} value={waterCost} onChange={(e) => setWaterCost(Number(e.target.value))} style={{ width: 110 }} /></td>
                <td className="cell-num">{fmtMoney(waterTotal)}</td>
              </tr>
              <tr>
                <td><input type="checkbox" checked={airtimeOn} onChange={(e) => setAirtimeOn(e.target.checked)} /></td>
                <td>
                  <strong>Airtime / mobile data</strong>
                  {airtimeProduct && <div className="muted">{String(airtimeProduct.code)} · std cost {fmtMoney(airtimeProduct.standardCost)}</div>}
                </td>
                <td className="muted">1</td>
                <td><input type="number" min={0} value={airtimeAmount} onChange={(e) => setAirtimeAmount(Number(e.target.value))} style={{ width: 110 }} /></td>
                <td className="cell-num">{fmtMoney(airtimeTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="toolbar" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <strong>Estimated total: {fmtMoney(total)}</strong>
        </div>
      </section>
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Notes (optional)</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Anything procurement should know" /></div>
        </div>
      </section>
    </div>
  );
}
function PrComposer({ editId }: { editId?: number }) {
  const { user } = useAuth();
  const [products, setProducts] = useState<Rec[]>([]);
  const [suppliers, setSuppliers] = useState<Rec[]>([]);
  const [meta, setMeta] = useState<{ companies: Rec[]; branches: Rec[]; fiscalYears: Rec[]; departments: Rec[]; warehouses: Rec[]; costCentres: Rec[]; accounts: Rec[]; budgets: Rec[]; currencies: { code: string; name: string; symbol: string; rate: number; isBase: boolean }[]; products: Rec[]; units: Rec[]; taxes: Rec[] } | null>(null);
  const [lines, setLines] = useState<PrLine[]>([emptyPrLine()]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState(user?.default_purpose ?? '');
  const [businessJustification, setBusinessJustification] = useState(user?.default_business_justification ?? '');
  const [confidentialityLevel, setConfidentialityLevel] = useState(user?.default_confidentiality_level ?? 'INTERNAL');
  const [emergencyPurchase, setEmergencyPurchase] = useState(user?.default_emergency_purchase ?? false);
  const [recurringPurchase, setRecurringPurchase] = useState(user?.default_recurring_purchase ?? false);
  const [companyId, setCompanyId] = useState<number | ''>(user?.default_company_id ?? user?.company_id ?? '');
  const [branchId, setBranchId] = useState<number | ''>(user?.default_branch_id ?? user?.branch_id ?? '');
  const [fiscalYearId, setFiscalYearId] = useState<number | ''>(user?.default_fiscal_year_id ?? user?.fiscal_year_id ?? '');
  const [category, setCategory] = useState(user?.default_procurement_category ?? 'GOODS');
  const [urgency, setUrgency] = useState(user?.default_priority ?? 'NORMAL');
  const [currencyCode, setCurrencyCode] = useState(user?.default_currency_code ?? 'UGX');
  const [taxCode, setTaxCode] = useState(user?.default_tax_code ?? 'VAT18');
  const [taxIncluded, setTaxIncluded] = useState(false);
  const [discountRate, setDiscountRate] = useState(0);
  const [deliveryCost, setDeliveryCost] = useState(0);
  const [departmentId, setDepartmentId] = useState<number | ''>('');
  const [warehouseId, setWarehouseId] = useState<number | ''>('');
  const [costCentreId, setCostCentreId] = useState<number | ''>('');
  const [accountId, setAccountId] = useState<number | ''>('');
  const [budgetCode, setBudgetCode] = useState('');
  const leadDays = Math.max(0, num(user?.default_lead_days, 7));
  const requiredTouched = useRef(Boolean(editId));
  const [requiredDate, setRequiredDate] = useState(() => {
    if (editId) return '';
    const base = String(user?.request_date ?? new Date().toISOString().slice(0, 10));
    return addDays(base, leadDays);
  });
  const [requestDate, setRequestDate] = useState(() => (String(user?.request_date ?? new Date().toISOString().slice(0, 10))));
  const [deliveryLocation, setDeliveryLocation] = useState(user?.default_delivery_location ?? '');
  const [incoterm, setIncoterm] = useState('');
  const [shipToAddress, setShipToAddress] = useState('');
  const [deliveryInstruction, setDeliveryInstruction] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const loadSuppliers = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/procurement/suppliers').then((r) => setSuppliers(r.data ?? [])).catch(() => undefined);
  }, []);
  useEffect(() => { loadSuppliers(); }, [loadSuppliers]);
  useEffect(() => {
    api<{ data: { companies: Rec[]; branches: Rec[]; fiscalYears: Rec[]; departments: Rec[]; warehouses: Rec[]; costCentres: Rec[]; accounts: Rec[]; budgets: Rec[]; currencies: { code: string; name: string; symbol: string; rate: number; isBase: boolean }[]; products: Rec[]; units: Rec[]; taxes: Rec[] } }>(`/api/ops/procurement/requisition-meta${companyId ? `?company=${Number(companyId)}` : ''}${branchId ? `${companyId ? '&' : '?'}branch=${Number(branchId)}` : ''}`)
      .then((r) => { setMeta(r.data); setProducts(r.data.products ?? []); })
      .catch(() => undefined);
  }, [companyId, branchId]);
  useEffect(() => {
    if (!editId) return;
    api<{ data: { requisition: Rec; items: Rec[] } }>(`/api/ops/procurement/requisitions/${editId}`)
      .then((r) => {
        const pr = r.data.requisition;
        setTitle(String(pr.title ?? ''));
        setDescription(String(pr.description ?? ''));
        setBusinessJustification(String(pr.businessJustification ?? ''));
        setConfidentialityLevel(String(pr.confidentialityLevel ?? 'INTERNAL'));
        setEmergencyPurchase(Boolean(pr.emergencyPurchase));
        setRecurringPurchase(Boolean(pr.recurringPurchase));
        setCompanyId(pr.companyId ? Number(pr.companyId) : (user?.default_company_id ?? user?.company_id ?? ''));
        setBranchId(pr.branchId ? Number(pr.branchId) : (user?.default_branch_id ?? user?.branch_id ?? ''));
        setFiscalYearId(pr.fiscalYearId ? Number(pr.fiscalYearId) : (user?.default_fiscal_year_id ?? user?.fiscal_year_id ?? ''));
        setCategory(String(pr.category ?? 'GOODS'));
        setUrgency(String(pr.urgency ?? 'NORMAL'));
        setCurrencyCode(String(pr.currencyCode ?? 'UGX'));
        setTaxCode(String(pr.taxCode ?? 'VAT18'));
        setTaxIncluded(pr.taxIncluded === true);
        setDiscountRate(num(pr.discountRate));
        setDeliveryCost(num(pr.deliveryCost));
        setDepartmentId(pr.departmentId ? Number(pr.departmentId) : '');
        setWarehouseId(pr.warehouseId ? Number(pr.warehouseId) : '');
        setCostCentreId(pr.costCentreId ? Number(pr.costCentreId) : '');
        setAccountId(pr.accountId ? Number(pr.accountId) : '');
        setBudgetCode(String(pr.budgetCode ?? ''));
        requiredTouched.current = true;
        setRequiredDate(dateInput(pr.requiredDate));
        setRequestDate(dateInput(pr.requestedDate));
        setDeliveryLocation(String(pr.deliveryLocation ?? ''));
        setIncoterm(String(pr.incoterm ?? ''));
        setShipToAddress(String(pr.shipToAddress ?? ''));
        setDeliveryInstruction(String(pr.deliveryInstruction ?? ''));
        setPaymentTerms(String(pr.paymentTerms ?? ''));
        setNotes(String(pr.notes ?? ''));
        setLines((r.data.items ?? []).map((i: Rec) => ({
          key: `${Date.now()}-${Math.random()}`,
          productId: Number(i.productId),
          quantity: num(i.quantity),
          estimatedCost: num(i.estimatedCost),
          taxRate: num(i.taxRate),
          discountRate: num(i.discountPercent),
          needBy: dateInput(i.needBy),
          suggestedSupplierId: i.suggestedSupplierId ? Number(i.suggestedSupplierId) : '',
          description: String(i.description ?? ''),
          specification: String(i.specification ?? ''),
          category: String(i.category ?? ''),
          subcategory: String(i.subcategory ?? ''),
          unitId: i.unitId ? Number(i.unitId) : '',
          glAccountId: i.glAccountId ? Number(i.glAccountId) : '',
        })));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load requisition'));
  }, [editId]);
  const rate = useMemo(() => {
    if (!meta || currencyCode === 'UGX') return 1;
    const found = meta.currencies.find((c) => c.code === currencyCode);
    return found ? found.rate : 1;
  }, [meta, currencyCode]);
  const total = useMemo(() => lines.reduce((s, l) => s + lineTotal(l.quantity, l.estimatedCost, l.taxRate, l.discountRate), 0), [lines]);
  const baseTotal = useMemo(() => lines.reduce((s, l) => s + l.quantity * l.estimatedCost, 0), [lines]);
  const discountAmount = useMemo(() => lines.reduce((s, l) => s + (l.quantity * l.estimatedCost) * (Math.min(100, Math.max(0, l.discountRate)) / 100), 0), [lines]);
  const taxAmount = Math.max(0, total - baseTotal + discountAmount);
  const headerRate = useMemo(() => {
    if (!meta) return 0;
    const t = (meta.taxes ?? []).find((x) => String(x.code) === taxCode);
    return t ? num(t.rate) : 0;
  }, [meta, taxCode]);
  const primedLineTax = useRef(false);
  useEffect(() => {
    if (editId || primedLineTax.current || !meta) return;
    primedLineTax.current = true;
    setLines((prev) => prev.map((l) => ({ ...l, taxRate: headerRate })));
  }, [meta, headerRate, editId]);
  const setLine = (key: string, patch: Partial<PrLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const save = async () => {
    setError('');
    const items = lines
      .filter((l) => l.productId && l.quantity > 0)
      .map((l) => ({
        productId: Number(l.productId),
        quantity: l.quantity,
        needBy: l.needBy || null,
        estimatedCost: l.estimatedCost || undefined,
        suggestedSupplierId: l.suggestedSupplierId || undefined,
        description: l.description || null,
        specification: l.specification || null,
        category: l.category || null,
        subcategory: l.subcategory || null,
        unitId: l.unitId || undefined,
        taxRate: l.taxRate || 0,
        discountRate: l.discountRate || 0,
        glAccountId: l.glAccountId || undefined,
      }));
    if (!items.length) { setError('Add at least one product line'); return; }
    if (requestDate && requiredDate && requiredDate < requestDate) {
      setError('Required date cannot be before the request date');
      return;
    }
    const body = {
      title: title || null,
      description: description || null,
      businessJustification: businessJustification || null,
      confidentialityLevel: confidentialityLevel || null,
      emergencyPurchase: emergencyPurchase ? true : false,
      recurringPurchase: recurringPurchase ? true : false,
      companyId: companyId || null,
      branchId: branchId || null,
      fiscalYearId: fiscalYearId || null,
      category,
      urgency,
      currencyCode,
      taxCode: taxCode || null,
      taxIncluded: taxIncluded ? true : false,
      discountRate: discountRate || 0,
      deliveryCost: deliveryCost || 0,
      departmentId: departmentId || null,
      warehouseId: warehouseId || null,
      costCentreId: costCentreId || null,
      accountId: accountId || null,
      budgetCode: budgetCode || null,
      requestedDate: requestDate || null,
      requiredDate: requiredDate || null,
      deliveryLocation: deliveryLocation || null,
      incoterm: incoterm || null,
      shipToAddress: shipToAddress || null,
      deliveryInstruction: deliveryInstruction || null,
      paymentTerms: paymentTerms || null,
      notes: notes || null,
      items,
    };
    setBusy(true);
    try {
      const r = await api<{ data: { requisitionId: number } }>(editId ? `/api/ops/procurement/requisitions/${editId}/update` : '/api/ops/procurement/requisitions', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      navigate(`/buy/requisitions/${r.data.requisitionId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate(editId ? `/buy/requisitions/${editId}` : '/buy/requisitions')}>Back</button>
          <h1>{editId ? 'Edit purchase requisition' : 'New purchase requisition'}</h1>
          <p className="muted">Lines stay DRAFT until you submit for approval. Standard cost pre-fills as a starting estimate.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate(editId ? `/buy/requisitions/${editId}` : '/buy/requisitions')}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : editId ? 'Save changes' : 'Save draft'}</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Title</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary of the requirement" /></div>
<div className="field"><label>Company</label>
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value ? Number(e.target.value) : '')}>
              {companyId !== '' && !(meta?.companies ?? []).some((c) => Number(c.id) === Number(companyId)) && <option value={String(companyId)}>{user?.company_name ?? `#${companyId}`}</option>}
              {(meta?.companies ?? []).map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.code)} - {String(c.name)}</option>)}
            </select>
          </div>
<div className="field"><label>Branch</label>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')}>
              {branchId !== '' && !(meta?.branches ?? []).some((b) => Number(b.id) === Number(branchId)) && <option value={String(branchId)}>{user?.branch_name ?? `#${branchId}`}</option>}
              {(meta?.branches ?? []).map((b) => <option key={String(b.id)} value={String(b.id)}>{String(b.code)} - {String(b.name)}</option>)}
            </select>
          </div>
<div className="field"><label>Fiscal year</label>
            <select value={fiscalYearId} onChange={(e) => setFiscalYearId(e.target.value ? Number(e.target.value) : '')}>
              {fiscalYearId !== '' && !(meta?.fiscalYears ?? []).some((f) => Number(f.id) === Number(fiscalYearId)) && <option value={String(fiscalYearId)}>{user?.fiscal_year_name ?? `#${fiscalYearId}`}</option>}
              {(meta?.fiscalYears ?? []).map((f) => <option key={String(f.id)} value={String(f.id)}>{String(f.code)} - {String(f.name)}</option>)}
            </select>
          </div>
          <div className="field"><label>Category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {['GOODS', 'SERVICES', 'ASSETS', 'SUBSCRIPTION', 'OTHER'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field"><label>Priority</label>
            <select value={urgency} onChange={(e) => setUrgency(e.target.value)}>
              {['LOW', 'NORMAL', 'HIGH', 'CRITICAL'].map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div className="field"><label>Currency</label>
            <select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}>
              {(meta?.currencies ?? [{ code: 'UGX', name: 'Uganda Shilling', symbol: 'USh', rate: 1, isBase: true }]).map((c) => <option key={c.code} value={c.code}>{c.code}{c.name ? ` \u2013 ${c.name}` : ''}{c.symbol ? ` (${c.symbol})` : ''}{c.rate !== 1 ? ` \u00b7 1 = ${fmtNum(c.rate)} UGX` : ''}</option>)}
            </select>
          </div>
          <div className="field"><label>Tax</label>
            <select value={taxCode} onChange={(e) => {
              const v = e.target.value;
              setTaxCode(v);
              const t = (meta?.taxes ?? []).find((x) => String(x.code) === v);
              const r = t ? num(t.rate) : 0;
              setLines((prev) => prev.map((l) => ({ ...l, taxRate: r })));
            }}>
              {(meta?.taxes ?? []).length === 0 && <option value="VAT18">VAT18</option>}
              {(meta?.taxes ?? []).map((t) => <option key={String(t.code)} value={String(t.code)}>{String(t.code)}{t.name ? ` \u2013 ${String(t.name)}` : ''} ({fmtNum(t.rate)}%)</option>)}
            </select>
          </div>
          <div className="field"><label>Discount %</label><input type="number" min={0} max={100} value={discountRate} onChange={(e) => setDiscountRate(num(e.target.value))} placeholder="0" /></div>
          <div className="field"><label>Delivery cost</label><input type="number" min={0} step="0.01" value={deliveryCost} onChange={(e) => setDeliveryCost(num(e.target.value))} placeholder="0" /></div>
                    <div className="field"><label>Expected total value</label><div className="muted" style={{ paddingTop: 8 }}>{user?.default_expected_total ? fmtMoney(Number(user.default_expected_total)) : '—'} · default</div></div>
          <div className="field"><label>Department</label>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">None</option>
              {(meta?.departments ?? []).map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.name)}</option>)}
            </select>
          </div>
          <div className="field"><label>Warehouse</label>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">None</option>
              {(meta?.warehouses ?? []).map((w) => <option key={String(w.id)} value={String(w.id)}>{String(w.name)}</option>)}
            </select>
          </div>
          <div className="field"><label>Cost centre</label>
            <select value={costCentreId} onChange={(e) => setCostCentreId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">None</option>
              {(meta?.costCentres ?? []).map((cc) => <option key={String(cc.id)} value={String(cc.id)}>{String(cc.code)} - {String(cc.name)}</option>)}
            </select>
          </div>
          <div className="field"><label>GL account</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">None</option>
              {(meta?.accounts ?? []).map((a) => <option key={String(a.id)} value={String(a.id)}>{String(a.code)} - {String(a.name)}</option>)}
            </select>
          </div>
          <div className="field"><label>Budget code</label>
            <input value={budgetCode} onChange={(e) => setBudgetCode(e.target.value)} list="pr-budget-options" placeholder="e.g. MNT-2026" />
            <datalist id="pr-budget-options">
              {(meta?.budgets ?? []).map((b) => <option key={String(b.id)} value={String(b.budgetNo)}>{String(b.budgetNo)} - {fmtMoney(b.amount)}</option>)}
            </datalist>
          </div>
          <div className="field"><label>Request date</label><input type="date" value={requestDate} onChange={(e) => {
            const v = e.target.value;
            setRequestDate(v);
            if (!requiredTouched.current && v) setRequiredDate(addDays(v, leadDays));
          }} /></div>
          <div className="field"><label>Required by</label><input type="date" value={requiredDate} onChange={(e) => {
            requiredTouched.current = true;
            setRequiredDate(e.target.value);
          }} />
            <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{requiredTouched.current ? 'Set manually' : `Auto: +${leadDays} day${leadDays === 1 ? '' : 's'} lead time`}</span>
          </div>
          <div className="field"><label>Delivery location</label><input value={deliveryLocation} onChange={(e) => setDeliveryLocation(e.target.value)} placeholder="e.g. Main warehouse" /></div>
          <div className="field"><label>Incoterm</label>
            <select value={incoterm} onChange={(e) => setIncoterm(e.target.value)}>
              <option value="">None</option>
              {['EXW', 'FOB', 'CIF', 'CFR', 'DAP', 'DDP'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field"><label>Payment terms</label><input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="e.g. Net 30" /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Description</label><textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe what is needed and why" /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Business justification</label><textarea value={businessJustification} onChange={(e) => setBusinessJustification(e.target.value)} placeholder="Cost-benefit rationale to support approval" /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Confidentiality level</label><select value={confidentialityLevel} onChange={(e) => setConfidentialityLevel(e.target.value)}>{['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].map((lv) => <option key={lv} value={lv}>{lv}</option>)}</select></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label><input type="checkbox" checked={emergencyPurchase} onChange={(e) => setEmergencyPurchase(e.target.checked)} /> Emergency purchase (expedite approval & fulfilment)</label></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label><input type="checkbox" checked={recurringPurchase} onChange={(e) => setRecurringPurchase(e.target.checked)} /> Recurring purchase (standing requirement – auto-reorder eligible)</label></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Ship to address</label><textarea value={shipToAddress} onChange={(e) => setShipToAddress(e.target.value)} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Delivery instructions</label><textarea value={deliveryInstruction} onChange={(e) => setDeliveryInstruction(e.target.value)} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Notes</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label><input type="checkbox" checked={taxIncluded} onChange={(e) => setTaxIncluded(e.target.checked)} /> Prices include tax (line estimates are tax-inclusive)</label></div>
          {rate !== 1 ? <div className="field"><label>FX rate</label><div className="muted" style={{ paddingTop: 8 }}>1 {currencyCode} = {fmtNum(rate)} UGX</div></div> : null}
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Lines</h3><button className="btn btn-sm" onClick={() => setLines((p) => [...p, { ...emptyPrLine(), taxRate: headerRate }])}>+ Line</button></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Product</th><th>Description</th><th>Specification</th><th>Category</th><th>Subcategory</th><th>UoM</th><th className="cell-num">Qty</th><th className="cell-num">Est. cost</th><th className="cell-num">Tax %</th><th className="cell-num">Disc %</th><th>Need by</th><th>Suggested supplier</th><th>GL account</th><th className="cell-num">Line total</th><th /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <select className="cell-input" value={l.productId} onChange={(e) => {
                      const pid = e.target.value ? Number(e.target.value) : '';
                      const prod = products.find((p) => Number(p.id) === pid);
                      setLine(l.key, {
                        productId: pid,
                        estimatedCost: prod ? num(pick(prod, 'standard_cost', 'standardCost'), l.estimatedCost) : l.estimatedCost,
                        specification: prod ? String(pick(prod, 'description', 'description') ?? '') : l.specification,
                        category: prod ? String(pick(prod, 'category_name', 'categoryName') ?? '') : l.category,
                        subcategory: prod ? String(pick(prod, 'category_parent_name', 'categoryParentName') ?? '') : l.subcategory,
                        unitId: prod ? (Number(pick(prod, 'unit_id', 'unitId')) || '') : l.unitId,
                      });
                    }}>
                      <option value="">Select product...</option>
                      {products.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.code)} | {String(p.name)}</option>)}
                    </select>
                  </td>
                  <td><input className="cell-input" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder="Line detail" /></td>
                  <td><input className="cell-input" value={l.specification} onChange={(e) => setLine(l.key, { specification: e.target.value })} placeholder="e.g. 80gsm A4" /></td>
                  <td><input className="cell-input" value={l.category} onChange={(e) => setLine(l.key, { category: e.target.value })} placeholder="Auto from product" /></td>
                  <td><input className="cell-input" value={l.subcategory} onChange={(e) => setLine(l.key, { subcategory: e.target.value })} placeholder="Auto from product" /></td>
                  <td>
                    <select className="cell-input" value={l.unitId} onChange={(e) => setLine(l.key, { unitId: e.target.value ? Number(e.target.value) : '' })}>
                      <option value="">Default</option>
                      {(meta?.units ?? []).map((u) => <option key={String(u.id)} value={String(u.id)}>{String(u.code)} - {String(u.name)}</option>)}
                    </select>
                  </td>
                  <td><input className="cell-input" type="number" min={0} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: num(e.target.value) })} /></td>
                  <td><input className="cell-input" type="number" min={0} value={l.estimatedCost} onChange={(e) => setLine(l.key, { estimatedCost: num(e.target.value) })} /></td>
                  <td><input className="cell-input" type="number" min={0} max={100} value={l.taxRate} onChange={(e) => setLine(l.key, { taxRate: num(e.target.value) })} /></td>
                  <td><input className="cell-input" type="number" min={0} max={100} value={l.discountRate} onChange={(e) => setLine(l.key, { discountRate: num(e.target.value) })} /></td>
                  <td><input className="cell-input" type="date" value={l.needBy} onChange={(e) => setLine(l.key, { needBy: e.target.value })} /></td>
                  <td>
                    <SupplierPicker suppliers={suppliers} value={String(l.suggestedSupplierId)} onChange={(v) => setLine(l.key, { suggestedSupplierId: v ? Number(v) : '' })} onCreated={() => loadSuppliers()} placeholder="Any" className="cell-input" />
                  </td>
                  <td>
                    <select className="cell-input" value={l.glAccountId} onChange={(e) => setLine(l.key, { glAccountId: e.target.value ? Number(e.target.value) : '' })}>
                      <option value="">Default</option>
                      {(meta?.accounts ?? []).map((a) => <option key={String(a.id)} value={String(a.id)}>{String(a.code)}</option>)}
                    </select>
                  </td>
                  <td className="cell-num">{fmtMoney(lineTotal(l.quantity, l.estimatedCost, l.taxRate, l.discountRate))}</td>
                  <td><button className="btn btn-sm" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="otc-total">
          {taxIncluded
            ? `Estimate ${fmtMoney(total)} (incl. tax ${fmtMoney(taxAmount)})`
            : taxAmount > 0
              ? `Estimate ${fmtMoney(total - taxAmount)} + tax ${fmtMoney(taxAmount)}`
              : `Estimate ${fmtMoney(total)}`}
          {discountAmount > 0 ? ` \u00b7 discount ${fmtMoney(discountAmount)}` : ''}
          {deliveryCost > 0 ? ` \u00b7 delivery ${fmtMoney(deliveryCost)}` : ''}
          {rate !== 1 ? ` UGX (${fmtMoney(total / rate)} base)` : ''}
        </div>
      </section>
    </div>
  );
}
function RfqList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/procurement/rfqs').then((r) => setRows(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'RFQs failed'));
  }, []);
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (status && String(r.status) !== status) return false;
      if (!term) return true;
      return String(r.rfqNo).toLowerCase().includes(term);
    });
  }, [rows, q, status]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="proc">Sourcing</p>
          <h1>Requests for quotation</h1>
          <p className="muted">Issue an RFQ from an approved PR, collect quotes, then award the lowest one.</p>
        </div>
      </header>
      <BuyTabs active="rfqs" />
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search RFQ number..." />
        <StatusFilter value={status} onChange={setStatus} options={['DRAFT', 'ISSUED', 'AWARDED', 'CANCELLED']} />
      </div>
      <div className="record-cards mobile-only">
        {filtered.map((r) => (
          <button key={String(r.id)} className="record-card" onClick={() => navigate(`/buy/rfqs/${r.id}`)}>
            <div className="record-card-top">
              <strong className="cell-mono">{String(r.rfqNo)}</strong>
              <Badge value={r.status} />
            </div>
            <div className="record-card-meta">
              <span>Issued {fmtDate(r.issueDate)}</span>
              <span>{fmtNum(r.itemCount)} lines</span>
              <span>{fmtNum(r.quoteCount)} quotes</span>
              <span>{r.prNo ? `PR ${String(r.prNo)}` : 'No PR link'}</span>
            </div>
            <span className="btn btn-sm">View</span>
          </button>
        ))}
        {filtered.length === 0 && <p className="muted" style={{ padding: 16 }}>No RFQs. Issue one from an approved PR.</p>}
      </div>
      <div className="table-wrap card desktop-only">
        <table className="data">
          <thead><tr><th>RFQ</th><th>PR</th><th>Issued</th><th>Closes</th><th>Status</th><th className="cell-num">Lines</th><th className="cell-num">Quotes</th><th /></tr></thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/buy/rfqs/${r.id}`)}>
                <td className="cell-mono">{String(r.rfqNo)}</td>
                <td className="cell-mono">{r.prNo ? String(r.prNo) : '—'}</td>
                <td>{fmtDate(r.issueDate)}</td>
                <td>{fmtDate(r.closingDate)}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{fmtNum(r.itemCount)}</td>
                <td className="cell-num">{fmtNum(r.quoteCount)}</td>
                <td style={{ textAlign: 'right' }}><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/buy/rfqs/${r.id}`); }}>View</button></td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No RFQs. Issue one from an approved PR.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="pager"><span>{fmtNum(filtered.length)} records</span></div>
    </div>
  );
}
function RfqDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{
    rfq: Rec;
    requisition: Rec | null;
    items: Rec[];
    suppliers: Rec[];
    quotations: (Rec & { items: Rec[] })[];
    priceHistory: Rec[];
  } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [quoteDrafts, setQuoteDrafts] = useState<Record<string, { supplierId: string; price: string }>>({});
  const load = useCallback(() => {
    api<{
      data: {
        rfq: Rec;
        requisition: Rec | null;
        items: Rec[];
        suppliers: Rec[];
        quotations: (Rec & { items: Rec[] })[];
        priceHistory: Rec[];
      };
    }>(`/api/ops/procurement/rfqs/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'RFQ failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening RFQ..." />;
  const act = async (path: string, body: Rec = {}, ok = 'Done') => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(path, { method: 'POST', body: JSON.stringify(body) });
      if (r.data.orderId) { navigate(`/buy/orders/${r.data.orderId}`); return; }
      setNotice(ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const rfq = doc.rfq;
  const rfqStatus = String(rfq.status);
  const requisition = doc.requisition;
  const priceFor = (productId: unknown): Rec | undefined =>
    doc.priceHistory.find((h) => Number(h.productId) === Number(productId));
  const quoteItemsFor = (quote: Rec): Rec[] => (Array.isArray(quote.items) ? (quote.items as Rec[]) : []);
  const unitPriceFor = (quote: Rec, rfqItemId: unknown): string => {
    const it = quoteItemsFor(quote).find((i) => Number(i.rfqItemId) === Number(rfqItemId));
    return it ? fmtMoney(it.unitPrice) : '—';
  };
  const lowestFor = (rfqItemId: unknown): number | null => {
    let low: number | null = null;
    for (const q of doc.quotations) {
      const it = quoteItemsFor(q).find((i) => Number(i.rfqItemId) === Number(rfqItemId));
      if (!it) continue;
      const p = Number(it.unitPrice);
      if (Number.isFinite(p) && (low === null || p < low)) low = p;
    }
    return low;
  };
  const canRecordQuotes = can(user, 'procurement.quotations.create') && rfqStatus !== 'AWARDED';
  const detailRows: [string, unknown][] = [];
  if (requisition) {
    detailRows.push(['Source PR', `${String(requisition.prNo)}${requisition.requestedByName ? ` · ${String(requisition.requestedByName)}` : ''}`]);
    detailRows.push(['Department', String(requisition.departmentName ?? requisition.departmentCode ?? '—')]);
    detailRows.push(['Required', fmtDate(requisition.requiredDate)]);
  } else {
    detailRows.push(['Source PR', 'Direct sourcing']);
  }
  detailRows.push(['Issued', fmtDate(rfq.issueDate)]);
  detailRows.push(['Closes', fmtDate(rfq.closingDate)]);
  detailRows.push(['Lines', fmtNum(doc.items.length)]);
  detailRows.push(['Quotes', fmtNum(doc.quotations.length)]);
  if (rfq.notes) detailRows.push(['Notes', String(rfq.notes)]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/buy/rfqs')}>Back</button>
          <h1>RFQ <span className="cell-mono">{String(rfq.rfqNo)}</span></h1>
          <p className="muted">
            Issued {fmtDate(rfq.issueDate)}{rfq.closingDate ? ` · closes ${fmtDate(rfq.closingDate)}` : ''}
            {requisition ? ` · from ${String(requisition.prNo)}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <DownloadMenu type="rfq" id={id} code={String(rfq.rfqNo)} />
          <button className="btn btn-sm" onClick={() => openDocument('bid-analysis', id, 'print', String(rfq.rfqNo) + '.pdf').catch((e) => window.alert(e instanceof Error ? e.message : String(e)))}>Bid analysis</button>
          <Badge value={rfqStatus} />
        </div>
      </header>
      <BuyTabs active="rfqs" />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <Pipeline steps={RFQ_STEPS} status={rfqStatus} />
      <div className="detail-grid">
        <div>
          <section className="card">
            <div className="card-head"><h3>Lines</h3><span className="muted">{fmtNum(doc.items.length)} items</span></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Product</th><th className="cell-num">Qty</th><th className="cell-num">Target</th><th>Price history</th></tr></thead>
                <tbody>
                  {doc.items.map((i) => {
                    const ph = priceFor(i.productId);
                    const hint = ph
                      ? [
                          ph.avgPaid != null && Number(ph.avgPaid) > 0 ? `paid avg ${fmtMoney(ph.avgPaid)}` : '',
                          ph.lastPaid != null && Number(ph.lastPaid) > 0 ? `last ${fmtMoney(ph.lastPaid)}` : '',
                          Number(ph.priorQuoteCount ?? 0) > 0 ? `${fmtNum(ph.priorQuoteCount)} prior quotes` : '',
                        ].filter(Boolean).join(' · ')
                      : '';
                    return (
                      <tr key={String(i.id)}>
                        <td><div className="cell-mono">{String(i.productCode)}</div>{String(i.productName)}</td>
                        <td className="cell-num">{fmtNum(i.quantity)}</td>
                        <td className="cell-num">{fmtMoney(i.targetPrice)}</td>
                        <td><span className="muted">{hint || 'No prior spend'}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>Quotations</h3><span className="muted">{fmtNum(doc.quotations.length)} received</span></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Quote</th><th>Supplier</th><th>Status</th><th className="cell-num">Total</th></tr></thead>
                <tbody>
                  {doc.quotations.map((q) => (
                    <tr key={String(q.id)}>
                      <td className="cell-mono">{String(q.quoteNo)}</td>
                      <td>{String(q.supplierName)}</td>
                      <td><Badge value={q.status} /></td>
                      <td className="cell-num">{fmtMoney(q.total)}</td>
                    </tr>
                  ))}
                  {doc.quotations.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No quotes yet.</td></tr>}
                </tbody>
              </table>
            </div>
            {doc.quotations.length > 0 && (
              <div className="table-wrap" style={{ borderTop: '1px solid var(--border, rgba(0,0,0,.08))' }}>
                <div className="card-head"><h4>Comparison</h4><span className="muted">Per-line unit prices</span></div>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Product</th>
                      {doc.quotations.map((q) => (
                        <th key={String(q.id)} className="cell-num">
                          {String(q.supplierName)}
                          {String(q.status) === 'SELECTED' && <span className="badge badge-success" style={{ marginLeft: 6 }}>✓ Awarded</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {doc.items.map((i) => (
                      <tr key={String(i.id)}>
                        <td><div className="cell-mono">{String(i.productCode)}</div>{String(i.productName)}</td>
                        {doc.quotations.map((q) => {
                          const awarded = String(q.status) === 'SELECTED';
                          const it = quoteItemsFor(q).find((x) => Number(x.rfqItemId) === Number(i.id));
                          const isLow = it != null && Number(it.unitPrice) === lowestFor(i.id);
                          return (
                            <td key={String(q.id)} className="cell-num">
                              {awarded || isLow ? <strong>{unitPriceFor(q, i.id)}</strong> : unitPriceFor(q, i.id)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {canRecordQuotes && (
              <div className="card-pad" style={{ borderTop: '1px solid var(--border, rgba(0,0,0,.08))' }}>
                <h4 style={{ margin: '0 0 8px' }}>Record supplier quote</h4>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Product</th><th className="cell-num">Qty</th><th>Supplier</th><th className="cell-num">Unit price</th><th></th></tr></thead>
                    <tbody>
                      {doc.items.map((i) => {
                        const draft = quoteDrafts[String(i.id)] ?? { supplierId: '', price: '' };
                        return (
                          <tr key={String(i.id)}>
                            <td><div className="cell-mono">{String(i.productCode)}</div>{String(i.productName)}</td>
                            <td className="cell-num">{fmtNum(i.quantity)}</td>
                            <td>
                              <select
                                value={draft.supplierId}
                                onChange={(e) => setQuoteDrafts((d) => ({ ...d, [String(i.id)]: { ...draft, supplierId: e.target.value } }))}
                              >
                                <option value="">Supplier...</option>
                                {doc.suppliers.map((s) => (
                                  <option key={String(s.supplierId)} value={String(s.supplierId)}>{String(s.code)} · {String(s.name)}</option>
                                ))}
                              </select>
                            </td>
                            <td className="cell-num">
                              <input
                                className="cell-input"
                                inputMode="decimal"
                                placeholder="Unit price"
                                value={draft.price}
                                onChange={(e) => setQuoteDrafts((d) => ({ ...d, [String(i.id)]: { ...draft, price: e.target.value } }))}
                              />
                            </td>
                            <td>
                              <button
                                className="btn btn-sm"
                                disabled={busy || !draft.supplierId || !draft.price}
                                onClick={() => act('/api/ops/procurement/quotations', {
                                  rfqId: id,
                                  supplierId: Number(draft.supplierId),
                                  items: [{ rfqItemId: Number(i.id), productId: Number(i.productId), quantity: Number(i.quantity), unitPrice: Number(draft.price) }],
                                }, 'Quote recorded')}
                              >Record</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="muted" style={{ marginTop: 8 }}>Each line records a quote for that item. Record one line per supplier for a full quote.</p>
              </div>
            )}
          </section>
        </div>
        <div className="detail-side">
          <section className="card">
            <div className="card-head"><h3>Next step</h3></div>
            <div className="flow-actions">
              {requisition && (
                <button className="btn btn-block btn-ghost" disabled={busy} onClick={() => navigate(`/buy/requisitions/${Number(requisition.id)}`)}>
                  Open {String(requisition.prNo)}
                </button>
              )}
              {rfqStatus !== 'AWARDED' && can(user, 'procurement.rfqs.evaluate') && (
                <button className="btn btn-block btn-primary" disabled={busy || doc.quotations.length === 0} onClick={() => act(`/api/ops/procurement/rfqs/${id}/evaluate`, {}, 'Awarded lowest quote')}>Evaluate & award</button>
              )}
              {rfqStatus === 'AWARDED' && can(user, 'procurement.orders.create') && (
                <button className="btn btn-block btn-primary" disabled={busy} onClick={() => act(`/api/ops/procurement/rfqs/${id}/convert`, {}, 'PO created')}>Convert awarded quote to PO</button>
              )}
              {rfqStatus === 'AWARDED' && !can(user, 'procurement.orders.create') && <p className="muted">Awarded - waiting on a buyer to convert.</p>}
              {rfqStatus !== 'AWARDED' && doc.quotations.length === 0 && <p className="muted">Record at least one quote to evaluate.</p>}
            </div>
          </section>
          <MetaCard title="Details" rows={detailRows} />
          <RelatedDocs
            title="Supplier quotations"
            rows={doc.quotations}
            href={(_r) => `/buy/rfqs/${id}`}
            codeKeys={['quoteNo', 'quote_no']}
          />
        </div>
      </div>
    </div>
  );
}
function PoList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q.trim()) p.set('q', q.trim());
    if (status) p.set('status', status);
    api<{ data: { rows: Rec[] } }>(`/api/ops/procurement/orders?${p}`)
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Orders failed'));
  }, [q, status, page]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="proc">Procurement</p>
          <h1>Orders to suppliers</h1>
          <p className="muted">Commit, receive, and three-way match every purchase.</p>
        </div>
        <div className="head-actions">
          {can(user, 'procurement.orders.create') && <button className="btn btn-primary" onClick={() => navigate('/buy/orders/new')}>New PO</button>}
        </div>
      </header>
      <BuyTabs active="orders" />
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search PO or supplier..." />
        <StatusFilter value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']} />
      </div>
      <div className="record-cards mobile-only">
        {rows.map((r) => (
          <button key={String(r.id)} className="record-card" onClick={() => navigate(`/buy/orders/${r.id}`)}>
            <div className="record-card-top">
              <strong className="cell-mono">{String(r.poNo)}</strong>
              <Badge value={r.status} />
            </div>
            <div className="record-card-meta">
              <span>{String(r.supplierName)}</span>
              <span>Ordered {fmtDate(r.orderDate)}</span>
              <span>{fmtNum(r.receivedQty)} / {fmtNum(r.orderedQty)} received</span>
            </div>
            <span className="btn btn-sm">View</span>
          </button>
        ))}
        {rows.length === 0 && <p className="muted" style={{ padding: 16 }}>No purchase orders.</p>}
      </div>
      <div className="table-wrap card desktop-only">
        <table className="data">
          <thead><tr><th>PO</th><th>Supplier</th><th>Ordered</th><th>Status</th><th>Match</th><th className="cell-num">Received</th><th className="cell-num">Total</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/buy/orders/${r.id}`)}>
                <td className="cell-mono">{String(r.poNo)}</td>
                <td>{String(r.supplierName)}</td>
                <td>{fmtDate(r.orderDate)}</td>
                <td><Badge value={r.status} /></td>
                <td><Badge value={r.threeWayMatched ? 'OK' : 'OPEN'} /></td>
                <td className="cell-num">{fmtNum(r.receivedQty)} / {fmtNum(r.orderedQty)}</td>
                <td className="cell-num">{fmtMoney(r.total)}</td>
                <td style={{ textAlign: 'right' }}><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/buy/orders/${r.id}`); }}>View</button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No purchase orders.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span>{fmtNum(rows.length)} records</span>
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
        <button className="btn btn-sm" disabled={rows.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </div>
  );
}
function PoDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ order: Rec; items: Rec[]; receipts: Rec[]; invoices: Rec[]; match: Rec[]; amendments: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [recv, setRecv] = useState<Record<string, string>>({});
  const [showAmend, setShowAmend] = useState(false);
  const [amendReason, setAmendReason] = useState('');
  const [amendLines, setAmendLines] = useState<Record<string, { qty: string; price: string }>>({});
  const [amendNew, setAmendNew] = useState<{ productId: string; qty: string; price: string; tax: string } | null>(null);
  const [amendProducts, setAmendProducts] = useState<Rec[]>([]);
  const [supplierDocNo, setSupplierDocNo] = useState('');
  const load = useCallback(() => {
    api<{ data: { order: Rec; items: Rec[]; receipts: Rec[]; invoices: Rec[]; match: Rec[] } }>(`/api/ops/procurement/orders/${id}`)
      .then((r) => {
        setDoc((d) => ({ ...r.data, amendments: d?.amendments ?? [] }));
        const next: Record<string, string> = {};
        for (const it of r.data.items) {
          const open = Number(it.quantity) - Number(it.receivedQty);
          next[String(it.id)] = open > 0 ? String(open) : '0';
        }
        setRecv(next);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'PO failed'));
    api<{ data: { amendments: Rec[] } }>(`/api/ops/procurement/orders/${id}/amendments`)
      .then((a) => setDoc((d) => (d ? { ...d, amendments: a.data.amendments ?? [] } : d)))
      .catch(() => undefined);
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening purchase order..." />;
  const po = doc.order;
  const status = String(po.status);
  const act = async (path: string, body: Rec = {}, ok = 'Done') => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(path, { method: 'POST', body: JSON.stringify(body) });
      if (r.data.grnId) { setNotice(`Received ${r.data.grnNo}`); load(); return; }
      if (r.data.invoiceId) { navigate(`/buy/invoices/${r.data.invoiceId}`); return; }
      setNotice(ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const receive = () => {
    const items = doc.items
      .map((it) => ({
        poItemId: Number(it.id),
        productId: Number(it.productId),
        quantityReceived: Number(recv[String(it.id)] ?? 0),
        unitCost: Number(it.unitPrice),
      }))
      .filter((i) => i.quantityReceived > 0);
    if (!items.length) { setError('Enter a received quantity'); return; }
    act('/api/ops/procurement/goods-receipts', { poId: id, items }, 'Received');
  };
  const invoice = () => {
    const items = doc.items
      .map((it) => {
        const open = Math.min(Number(it.receivedQty) - Number(it.invoicedQty), Number(it.quantity) - Number(it.invoicedQty));
        return {
          poItemId: Number(it.id),
          productId: Number(it.productId),
          quantity: open,
          unitPrice: Number(it.unitPrice),
          taxPercent: Number(it.taxPercent ?? 0),
        };
      })
      .filter((i) => i.quantity > 0);
    if (!items.length) { setError('Nothing received is left to invoice'); return; }
    const lastGrn = doc.receipts[doc.receipts.length - 1];
    act('/api/ops/procurement/supplier-invoices', {
      poId: id,
      grnId: lastGrn ? Number(lastGrn.id) : null,
      supplierId: Number(po.supplierId),
      supplierDocumentNo: supplierDocNo.trim() || null,
      items,
    });
  };
  const fillRemaining = () => {
    const next: Record<string, string> = {};
    for (const it of doc.items) {
      const open = Number(it.quantity) - Number(it.receivedQty);
      next[String(it.id)] = open > 0 ? String(open) : '0';
    }
    setRecv(next);
  };
  const openAmend = () => {
    const next: Record<string, { qty: string; price: string }> = {};
    for (const it of doc.items) next[String(it.id)] = { qty: String(it.quantity), price: String(it.unitPrice) };
    setAmendLines(next);
    setAmendReason('');
    setAmendNew(null);
    setShowAmend(true);
    api<{ data: { products: Rec[] } }>('/api/ops/procurement/requisition-meta')
      .then((r) => setAmendProducts(r.data.products ?? []))
      .catch(() => undefined);
  };
  const submitAmend = async () => {
    setError('');
    const items: Rec[] = [];
    for (const it of doc.items) {
      const cur = amendLines[String(it.id)];
      if (!cur) continue;
      const qty = Number(cur.qty);
      const price = Number(cur.price);
      if (!Number.isFinite(qty) || qty <= 0) { setError('Quantities must be positive'); return; }
      if (qty !== Number(it.quantity) || price !== Number(it.unitPrice)) {
        items.push({ poItemId: Number(it.id), newQty: qty, newUnitPrice: price });
      }
    }
    if (amendNew?.productId) {
      const qty = Number(amendNew.qty);
      const price = Number(amendNew.price);
      if (!Number.isFinite(qty) || qty <= 0) { setError('New line quantity must be positive'); return; }
      items.push({ productId: Number(amendNew.productId), newLineQty: qty, newLineUnitPrice: price, taxPercent: Number(amendNew.tax ?? 0) });
    }
    if (!items.length) { setError('No changes entered — adjust a quantity or price, or add a line'); return; }
    setBusy(true); setNotice('');
    try {
      const r = await api<{ data: Rec }>(`/api/ops/procurement/orders/${id}/amend`, {
        method: 'POST',
        body: JSON.stringify({ reason: amendReason || null, items }),
      });
      setNotice(`Amendment ${String(r.data.amendmentNo)} drafted for approval`);
      setShowAmend(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const orderedQty = doc.items.reduce((a, i) => a + num(i.quantity), 0);
  const receivedQty = doc.items.reduce((a, i) => a + num(i.receivedQty), 0);
  const invoicedQty = doc.items.reduce((a, i) => a + num(i.invoicedQty), 0);
  const matchedCount = doc.match.filter((m) => Boolean(m.matched)).length;
  const showLastPrice = (user?.roles ?? []).some((r) => /PROC|BUY|SUPPLIER|FINANCE|ADMIN/i.test(r.role_code));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/buy/orders')}>Back</button>
          <h1>Purchase order <span className="cell-mono">{String(po.poNo)}</span></h1>
          <p className="muted">{String(po.supplierCode)} · {String(po.supplierName)} · {fmtMoney(po.total)}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DownloadMenu type="purchase-order" id={id} code={String(po.poNo)} />
          <Badge value={status} />
        </div>
      </header>
      <BuyTabs active="orders" />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <Pipeline steps={PO_STEPS} status={status} map={{ PARTIALLY_RECEIVED: 'RECEIVED' }} />
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Ordered</span><span className="kpi-value">{fmtNum(orderedQty)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Received</span><span className="kpi-value">{fmtNum(receivedQty)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Invoiced</span><span className="kpi-value">{fmtNum(invoicedQty)}</span></div>
        <div className="kpi-card"><span className="kpi-label">3-way match</span><span className="kpi-value">{fmtNum(matchedCount)} / {fmtNum(doc.items.length)}</span><span className="kpi-sub">{po.threeWayMatched ? 'Matched' : 'Open'}</span></div>
      </div>
      <div className="detail-grid">
        <div>
          <section className="card">
            <div className="card-head"><h3>Lines & three-way match</h3><span className="muted">{fmtNum(doc.items.length)} lines</span></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Product</th><th className="cell-num">Ordered</th><th className="cell-num">Received</th><th className="cell-num">Invoiced</th><th className="cell-num">Price</th>{showLastPrice && <th className="cell-num">Last price</th>}<th className="cell-num">Receive now</th><th>Match</th></tr></thead>
                <tbody>
                  {doc.items.map((it) => {
                    const m = doc.match.find((x) => Number(x.poItemId) === Number(it.id));
                    return (
                      <tr key={String(it.id)}>
                        <td><div className="cell-mono">{String(it.productCode)}</div>{String(it.productName)}</td>
                        <td className="cell-num">{fmtNum(it.quantity)}</td>
                        <td className="cell-num">{fmtNum(it.receivedQty)}</td>
                        <td className="cell-num">{fmtNum(it.invoicedQty)}</td>
                        <td className="cell-num">{fmtMoney(it.unitPrice)}</td>
                        {showLastPrice && (
                          <td className="cell-num">
                            {it.lastUnitPrice != null ? (
                              <>
                                {fmtMoney(it.lastUnitPrice)}
                                <div className="muted" style={{ fontSize: 11 }}>{String(it.lastPriceSourceNo ?? '')}</div>
                              </>
                            ) : <span className="muted">—</span>}
                          </td>
                        )}
                        <td className="cell-num">
                          <input className="cell-input" style={{ width: 80 }} inputMode="decimal" value={recv[String(it.id)] ?? ''} onChange={(e) => setRecv((s) => ({ ...s, [String(it.id)]: e.target.value }))} />
                        </td>
                        <td><Badge value={m?.matched ? 'OK' : 'OPEN'} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          {doc.receipts.length > 0 && (
            <section className="card">
              <div className="card-head"><h3>Goods receipts</h3></div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>GRN</th><th>Status</th><th>Ref</th></tr></thead>
                  <tbody>
                    {doc.receipts.map((g) => (
                      <tr key={String(g.id)} className="row-click" onClick={() => navigate(`/buy/receipts/${g.id}`)}>
                        <td className="cell-mono">{String(g.grnNo)}</td>
                        <td><Badge value={g.status} /></td>
                        <td>{String(g.deliveryRef ?? '-')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {doc.invoices.length > 0 && (
            <section className="card">
              <div className="card-head"><h3>Supplier invoices</h3></div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Invoice</th><th>Status</th><th>Match</th><th className="cell-num">Total</th></tr></thead>
                  <tbody>
                    {doc.invoices.map((i) => (
                      <tr key={String(i.id)} className="row-click" onClick={() => navigate(`/buy/invoices/${i.id}`)}>
                        <td className="cell-mono">{String(i.supplierInvoiceNo)}</td>
                        <td><Badge value={i.status} /></td>
                        <td><Badge value={i.threeWayMatched ? 'OK' : 'OPEN'} /></td>
                        <td className="cell-num">{fmtMoney(i.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <section className="card">
            <div className="card-head"><h3>Amendments</h3><span className="muted">{fmtNum(doc.amendments.length)}</span></div>
            {doc.amendments.length === 0 ? (
              <p className="muted card-pad">No amendments on this order. Approved orders are frozen — use an amendment for controlled quantity or price changes.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Amendment</th><th>Reason</th><th>Changes</th><th className="cell-num">Delta</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>
                    {doc.amendments.map((am) => (
                      <tr key={String(am.id)}>
                        <td className="cell-mono">{String(am.amendmentNo)}</td>
                        <td>{String(am.reason ?? '-')}</td>
                        <td>
                          {(am.items as Rec[]).map((li) => (
                            <div key={String(li.id)} className="muted" style={{ fontSize: 12 }}>
                              {String(li.productCode)} · {li.changeType === 'NEW_LINE'
                                ? `+${fmtNum(li.newLineQty)} @ ${fmtMoney(li.newLineUnitPrice)}`
                                : `${fmtNum(li.prevQty)} → ${fmtNum(li.newQty)} @ ${fmtMoney(li.newUnitPrice)}`}
                            </div>
                          ))}
                        </td>
                        <td className="cell-num">{fmtMoney(am.total)}</td>
                        <td><Badge value={am.status} /></td>
                        <td>
                          {am.status === 'DRAFT' && can(user, 'procurement.orders.update') && (
                            <button className="btn btn-sm" disabled={busy} onClick={() => act(`/api/ops/procurement/amendments/${am.id}/submit`, {}, 'Submitted for approval')}>Submit</button>
                          )}
                          {am.status === 'APPROVED' && can(user, 'procurement.orders.update') && (
                            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(`/api/ops/procurement/amendments/${am.id}/apply`, {}, 'Applied to order')}>Apply</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
        <div className="detail-side">
          <section className="card">
            <div className="card-head"><h3>Next step</h3></div>
            <div className="flow-actions">
              {status === 'DRAFT' && can(user, 'procurement.orders.submit') && (
                <button className="btn btn-block btn-primary" disabled={busy} onClick={() => act(`/api/ops/procurement/orders/${id}/submit`, {}, 'Submitted for approval')}>Submit</button>
              )}
              {['DRAFT', 'SUBMITTED'].includes(status) && can(user, 'procurement.orders.approve') && (
                <button className="btn btn-block" disabled={busy} onClick={() => act(`/api/ops/procurement/orders/${id}/approve`, {}, 'Approved')}>Approve</button>
              )}
              {['APPROVED', 'PARTIALLY_RECEIVED'].includes(status) && can(user, 'procurement.orders.update') && doc.items.every((i) => Number(i.receivedQty) === 0) && (
                <button className="btn btn-block" disabled={busy} onClick={openAmend}>Amend order</button>
              )}
              {['APPROVED', 'PARTIALLY_RECEIVED'].includes(status) && can(user, 'procurement.goods_receipts.create') && (
                <button className="btn btn-block btn-primary" disabled={busy} onClick={receive}>Receive entered qty</button>
              )}
              {['APPROVED', 'PARTIALLY_RECEIVED'].includes(status) && can(user, 'procurement.goods_receipts.create') && (
                <button className="btn btn-block" disabled={busy} onClick={fillRemaining}>Fill remaining qty</button>
              )}
              {['PARTIALLY_RECEIVED', 'RECEIVED'].includes(status) && can(user, 'procurement.supplier_invoices.create') && (
                <>
                  <input className="search-input" value={supplierDocNo} onChange={(e) => setSupplierDocNo(e.target.value)} placeholder="Supplier invoice no" />
                  <button className="btn btn-block" disabled={busy} onClick={invoice}>Invoice received</button>
                </>
              )}
              {['DRAFT', 'SUBMITTED', 'APPROVED'].includes(status) && (
                <button className="btn btn-block btn-warning" disabled={busy} onClick={() => act(`/api/ops/procurement/orders/${id}/cancel`, {}, 'Cancelled')}>Cancel</button>
              )}
              <button className="btn btn-block" onClick={() => navigate('/inventory/receive')}>Warehouse receive</button>
              <button className="btn btn-block" onClick={() => navigate('/inbox')}>Approvals inbox</button>
            </div>
          </section>
          <MetaCard
            title="Details"
            rows={[
              ['Supplier', `${String(po.supplierCode)} · ${String(po.supplierName)}`],
              ['Ordered', fmtDate(po.orderDate)],
              ['Expected', fmtDate(po.expectedDate)],
              ['Payment terms', po.paymentTermsDays != null ? `${fmtNum(po.paymentTermsDays)} days` : ''],
              ['PR', po.prNo ? String(po.prNo) : ''],
              ['Quote', po.quoteNo ? String(po.quoteNo) : ''],
              ['Subtotal', fmtMoney(po.subtotal)],
              ['Tax', fmtMoney(po.taxAmount)],
              ['Total', fmtMoney(po.total)],
            ]}
          />
          <RelatedDocs title="Goods receipts" rows={doc.receipts} href={(r) => `/buy/receipts/${r.id}`} codeKeys={['grnNo', 'grn_no']} />
          <RelatedDocs title="Supplier invoices" rows={doc.invoices} href={(r) => `/buy/invoices/${r.id}`} codeKeys={['supplierInvoiceNo', 'supplier_invoice_no']} />
        </div>
      </div>
      {showAmend && (
        <Modal
          title={`Amend ${String(po.poNo)}`}
          onClose={() => setShowAmend(false)}
          wide
          footer={
            <>
              <button className="btn" onClick={() => setShowAmend(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={submitAmend}>{busy ? 'Saving...' : 'Draft amendment'}</button>
            </>
          }
        >
          <div className="card-pad">
            <div className="field">
              <label>Reason / justification</label>
              <textarea value={amendReason} onChange={(e) => setAmendReason(e.target.value)} placeholder="e.g. Revised pricing agreed with supplier" />
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Product</th><th className="cell-num">Qty</th><th className="cell-num">Unit price</th></tr></thead>
                <tbody>
                  {doc.items.map((it) => {
                    const cur = amendLines[String(it.id)] ?? { qty: String(it.quantity), price: String(it.unitPrice) };
                    return (
                      <tr key={String(it.id)}>
                        <td><div className="cell-mono">{String(it.productCode)}</div>{String(it.productName)}</td>
                        <td className="cell-num">
                          <input className="cell-input" style={{ width: 90 }} inputMode="decimal" value={cur.qty}
                            onChange={(e) => setAmendLines((s) => ({ ...s, [String(it.id)]: { ...cur, qty: e.target.value } }))} />
                        </td>
                        <td className="cell-num">
                          <input className="cell-input" style={{ width: 110 }} inputMode="decimal" value={cur.price}
                            onChange={(e) => setAmendLines((s) => ({ ...s, [String(it.id)]: { ...cur, price: e.target.value } }))} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="card-head" style={{ marginTop: 14 }}><h4>Add a line</h4></div>
            <div className="form-grid" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
              <div className="field">
                <label>Product</label>
                <select value={amendNew?.productId ?? ''} onChange={(e) => setAmendNew({ productId: e.target.value, qty: amendNew?.qty ?? '1', price: amendNew?.price ?? '0', tax: amendNew?.tax ?? '0' })}>
                  <option value="">None</option>
                  {amendProducts.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.code)} · {String(p.name)}</option>)}
                </select>
              </div>
              <div className="field"><label>Qty</label><input inputMode="decimal" value={amendNew?.qty ?? '1'} onChange={(e) => setAmendNew({ productId: amendNew?.productId ?? '', qty: e.target.value, price: amendNew?.price ?? '0', tax: amendNew?.tax ?? '0' })} /></div>
              <div className="field"><label>Unit price</label><input inputMode="decimal" value={amendNew?.price ?? '0'} onChange={(e) => setAmendNew({ productId: amendNew?.productId ?? '', qty: amendNew?.qty ?? '1', price: e.target.value, tax: amendNew?.tax ?? '0' })} /></div>
              <div className="field"><label>Tax %</label><input inputMode="decimal" value={amendNew?.tax ?? '0'} onChange={(e) => setAmendNew({ productId: amendNew?.productId ?? '', qty: amendNew?.qty ?? '1', price: amendNew?.price ?? '0', tax: e.target.value })} /></div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
interface PoLine {
  key: string;
  productId: number | '';
  quantity: number;
  unitPrice: number;
  taxPercent: number;
}

function emptyPoLine(): PoLine {
  return { key: `${Date.now()}-${Math.random()}`, productId: '', quantity: 1, unitPrice: 0, taxPercent: 0 };
}
function PoComposer() {
  const [suppliers, setSuppliers] = useState<Rec[]>([]);
  const [products, setProducts] = useState<Rec[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<PoLine[]>([emptyPoLine()]);
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const loadSuppliers = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/procurement/suppliers').then((r) => setSuppliers(r.data ?? [])).catch(() => undefined);
  }, []);
  useEffect(() => { loadSuppliers(); }, [loadSuppliers]);
  useEffect(() => {
    api<{ data: { products: Rec[]; units: Rec[] } }>('/api/ops/procurement/requisition-meta').then((r) => setProducts(r.data.products ?? [])).catch(() => undefined);
  }, []);
  const total = useMemo(() => lines.reduce((s, l) => s + lineTotal(l.quantity, l.unitPrice, l.taxPercent), 0), [lines]);
  const setLine = (key: string, patch: Partial<PoLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const save = async () => {
    setError('');
    if (!supplierId) { setError('Supplier is required'); return; }
    const items = lines
      .filter((l) => l.productId && l.quantity > 0)
      .map((l) => ({ productId: Number(l.productId), quantity: l.quantity, unitPrice: l.unitPrice, taxPercent: l.taxPercent }));
    if (!items.length) { setError('Add at least one product line'); return; }
    setBusy(true);
    try {
      const r = await api<{ data: { orderId: number } }>('/api/ops/procurement/orders', {
        method: 'POST',
        body: JSON.stringify({ supplierId: Number(supplierId), expectedDate: expected || null, notes, items }),
      });
      navigate(`/buy/orders/${r.data.orderId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/buy/orders')}>Back</button>
          <h1>New purchase order</h1>
          <p className="muted">Draft lines against a supplier, then submit for approval.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/buy/orders')}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save draft'}</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required">
            <label>Supplier</label>
            <SupplierPicker suppliers={suppliers} value={supplierId} onChange={setSupplierId} onCreated={() => loadSuppliers()} placeholder="Select..." />
          </div>
          <div className="field"><label>Expected</label><input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Notes</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Lines</h3><button className="btn btn-sm" onClick={() => setLines((p) => [...p, emptyPoLine()])}>+ Line</button></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Product</th><th className="cell-num">Qty</th><th className="cell-num">Unit price</th><th className="cell-num">Tax %</th><th className="cell-num">Line</th><th /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <select className="cell-input" value={l.productId} onChange={(e) => {
                      const pid = e.target.value ? Number(e.target.value) : '';
                      const prod = products.find((p) => Number(p.id) === pid);
                      setLine(l.key, {
                        productId: pid,
                        unitPrice: prod ? num(pick(prod, 'standard_cost', 'standardCost'), l.unitPrice) : l.unitPrice,
                      });
                    }}>
                      <option value="">Select product...</option>
                      {products.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.code)} · {String(p.name)}</option>)}
                    </select>
                  </td>
                  <td><input className="cell-input" type="number" min={0} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: num(e.target.value) })} /></td>
                  <td><input className="cell-input" type="number" min={0} step="0.01" value={l.unitPrice} onChange={(e) => setLine(l.key, { unitPrice: num(e.target.value) })} /></td>
                  <td><input className="cell-input" type="number" min={0} max={100} value={l.taxPercent} onChange={(e) => setLine(l.key, { taxPercent: num(e.target.value) })} /></td>
                  <td className="cell-num">{fmtMoney(lineTotal(l.quantity, l.unitPrice, l.taxPercent))}</td>
                  <td><button className="btn btn-sm" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="otc-total">Total {fmtMoney(total)}</div>
      </section>
    </div>
  );
}
function GrnList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/procurement/goods-receipts').then((r) => setRows(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'GRNs failed'));
  }, []);
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (status && String(r.status) !== status) return false;
      if (!term) return true;
      return String(r.grnNo).toLowerCase().includes(term) || String(r.poNo).toLowerCase().includes(term) || String(r.supplierName).toLowerCase().includes(term);
    });
  }, [rows, q, status]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="proc">Goods receipts</p>
          <h1>Inbound receipts</h1>
          <p className="muted">Received stock lands here, then passes inspection before it hits the bins.</p>
        </div>
        <button className="btn" onClick={() => navigate('/inventory/receive')}>Warehouse receive</button>
      </header>
      <BuyTabs active="receipts" />
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search GRN, PO or supplier..." />
        <StatusFilter value={status} onChange={setStatus} options={['RECEIVED', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED']} />
      </div>
      <div className="record-cards mobile-only">
        {filtered.map((r) => (
          <button key={String(r.id)} className="record-card" onClick={() => navigate(`/buy/receipts/${r.id}`)}>
            <div className="record-card-top">
              <strong className="cell-mono">{String(r.grnNo)}</strong>
              <Badge value={r.status} />
            </div>
            <div className="record-card-meta">
              <span>{String(r.supplierName)}</span>
              <span>PO {String(r.poNo)}</span>
              <span>Received {fmtDate(r.receivedAt)}</span>
            </div>
            <span className="btn btn-sm">View</span>
          </button>
        ))}
        {filtered.length === 0 && <p className="muted" style={{ padding: 16 }}>No receipts yet.</p>}
      </div>
      <div className="table-wrap card desktop-only">
        <table className="data">
          <thead><tr><th>GRN</th><th>PO</th><th>Supplier</th><th>Received</th><th>Status</th><th className="cell-num">Lines</th><th /></tr></thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/buy/receipts/${r.id}`)}>
                <td className="cell-mono">{String(r.grnNo)}</td>
                <td className="cell-mono">{String(r.poNo)}</td>
                <td>{String(r.supplierName)}</td>
                <td>{fmtDate(r.receivedAt)}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{fmtNum(r.itemCount)}</td>
                <td style={{ textAlign: 'right' }}><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/buy/receipts/${r.id}`); }}>View</button></td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No receipts yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="pager"><span>{fmtNum(filtered.length)} records</span></div>
    </div>
  );
}
function GrnDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ receipt: Rec; items: Rec[]; inspections?: Rec[]; invoices?: Rec[]; returns?: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: { receipt: Rec; items: Rec[] } }>(`/api/ops/procurement/goods-receipts/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'GRN failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening GRN..." />;
  const receipt = doc.receipt;
  const grnStatus = String(receipt.status);
  const qc = async (result: 'PASSED' | 'FAILED' | 'QUARANTINED') => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/ops/procurement/goods-receipts/${id}/qc`, {
        method: 'POST',
        body: JSON.stringify({ results: doc.items.map((i) => ({ grnItemId: Number(i.id), result })) }),
      });
      setNotice(`QC ${result}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const receivedQty = doc.items.reduce((a, i) => a + num(i.quantityReceived), 0);
  const acceptedQty = doc.items.reduce((a, i) => a + num(i.quantityAccepted), 0);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/buy/receipts')}>Back</button>
          <h1>GRN <span className="cell-mono">{String(receipt.grnNo)}</span></h1>
          <p className="muted">PO {String(receipt.poNo)} · {String(receipt.supplierName)}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DownloadMenu type="goods-receipt" id={id} code={String(receipt.grnNo)} />
          <Badge value={grnStatus} />
        </div>
      </header>
      <BuyTabs active="receipts" />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <Pipeline steps={GRN_STEPS} status={grnStatus} />
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Received</span><span className="kpi-value">{fmtNum(receivedQty)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Accepted</span><span className="kpi-value">{fmtNum(acceptedQty)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Lines</span><span className="kpi-value">{fmtNum(doc.items.length)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Delivery ref</span><span className="kpi-value">{String(receipt.deliveryRef ?? '-')}</span></div>
      </div>
      <div className="detail-grid">
        <div>
          <section className="card">
            <div className="card-head"><h3>Lines</h3><span className="muted">{fmtNum(doc.items.length)} items</span></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Product</th><th className="cell-num">Received</th><th className="cell-num">Accepted</th><th>QC</th></tr></thead>
                <tbody>
                  {doc.items.map((i) => (
                    <tr key={String(i.id)}>
                      <td><div className="cell-mono">{String(i.productCode)}</div>{String(i.productName)}</td>
                      <td className="cell-num">{fmtNum(i.quantityReceived)}</td>
                      <td className="cell-num">{fmtNum(i.quantityAccepted)}</td>
                      <td><Badge value={i.qcStatus} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <div className="detail-side">
          <section className="card">
            <div className="card-head"><h3>Next step</h3></div>
            <div className="flow-actions">
              {grnStatus === 'RECEIVED' && can(user, 'procurement.goods_receipts.inspect') && (
                <>
                  <button className="btn btn-block btn-success" disabled={busy} onClick={() => qc('PASSED')}>Pass all</button>
                  <button className="btn btn-block btn-warning" disabled={busy} onClick={() => qc('QUARANTINED')}>Quarantine</button>
                  <button className="btn btn-block btn-danger" disabled={busy} onClick={() => qc('FAILED')}>Fail</button>
                </>
              )}
              {grnStatus === 'RECEIVED' && !can(user, 'procurement.goods_receipts.inspect') && <p className="muted">Waiting for an inspector to pass or quarantine this receipt.</p>}
              {grnStatus !== 'RECEIVED' && <p className="muted">Inspection complete - stock is committed to the bins.</p>}
            </div>
          </section>
          <MetaCard
            title="Details"
            rows={[
              ['PO', receipt.poNo ? String(receipt.poNo) : ''],
              ['Supplier', receipt.supplierName ? String(receipt.supplierName) : ''],
              ['Received', fmtDate(receipt.receivedAt)],
              ['Approved', fmtDate(receipt.approvedAt)],
              ['Delivery ref', receipt.deliveryRef ? String(receipt.deliveryRef) : ''],
              ['Notes', receipt.notes ? String(receipt.notes) : ''],
            ]}
          />
          {receipt.poId != null && (
            <RelatedDocs title="Purchase order" rows={[{ id: receipt.poId, poNo: receipt.poNo, status: '' }]} href={() => `/buy/orders/${receipt.poId}`} codeKeys={['poNo']} />
          )}
          {(doc.inspections ?? []).length > 0 && (
            <section className="card">
              <div className="card-head"><h3>Inspections</h3></div>
              <div className="related-list">
                {(doc.inspections ?? []).map((r) => (
                  <div key={String(r.id)} className="related-item">
                    <span className="cell-mono">{String(r.inspectionNo ?? r.id)}</span>
                    <Badge value={r.result ?? r.status} />
                    <button className="btn btn-sm" onClick={() => openDocument('inspection', r.id, 'print', String(r.inspectionNo ?? 'inspection') + '.pdf').catch((e) => window.alert(e instanceof Error ? e.message : String(e)))}>Print</button>
                  </div>
                ))}
              </div>
            </section>
          )}
          <RelatedDocs title="Supplier invoices" rows={doc.invoices ?? []} href={(r) => `/buy/invoices/${r.id}`} codeKeys={['supplierInvoiceNo', 'supplier_invoice_no']} />
          {(doc.returns ?? []).length > 0 && (
            <section className="card">
              <div className="card-head"><h3>Returns</h3></div>
              <div className="related-list">
                {(doc.returns ?? []).map((r) => (
                  <div key={String(r.id)} className="related-item">
                    <span className="cell-mono">{String(r.returnNo ?? r.id)}</span>
                    <Badge value={r.status} />
                    <button className="btn btn-sm" onClick={() => openDocument('purchase-return', r.id, 'print', String(r.returnNo ?? 'return') + '.pdf').catch((e) => window.alert(e instanceof Error ? e.message : String(e)))}>Print</button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
function InvoiceList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (status) p.set('status', status);
    api<{ data: Rec[] }>(`/api/ops/procurement/supplier-invoices?${p}`)
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Invoices failed'));
  }, [q, status]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="proc">Supplier invoices</p>
          <h1>Accounts payable</h1>
          <p className="muted">Invoice against received stock, three-way match, then release payment.</p>
        </div>
        <button className="btn" onClick={() => navigate('/finance/ap')}>AP ledger</button>
      </header>
      <BuyTabs active="invoices" />
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search invoice, PO or supplier..." />
        <StatusFilter value={status} onChange={setStatus} options={['DRAFT', 'SUBMITTED', 'APPROVED', 'MATCHED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED']} />
      </div>
      <div className="record-cards mobile-only">
        {rows.map((r) => (
          <button key={String(r.id)} className="record-card" onClick={() => navigate(`/buy/invoices/${r.id}`)}>
            <div className="record-card-top">
              <strong className="cell-mono">{String(r.supplierInvoiceNo)}</strong>
              <Badge value={r.status} />
            </div>
            <div className="record-card-meta">
              <span>{String(r.supplierName)}</span>
              <span>PO {String(r.poNo ?? '-')}</span>
              <span>Open {fmtMoney(num(r.total) - num(r.amountPaid))}</span>
            </div>
            <span className="btn btn-sm">View</span>
          </button>
        ))}
        {rows.length === 0 && <p className="muted" style={{ padding: 16 }}>No supplier invoices.</p>}
      </div>
      <div className="table-wrap card desktop-only">
        <table className="data">
          <thead><tr><th>Invoice</th><th>PO</th><th>Supplier</th><th>Status</th><th>Match</th><th className="cell-num">Total</th><th className="cell-num">Open</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/buy/invoices/${r.id}`)}>
                <td className="cell-mono">{String(r.supplierInvoiceNo)}</td>
                <td className="cell-mono">{String(r.poNo ?? '-')}</td>
                <td>{String(r.supplierName)}</td>
                <td><Badge value={r.status} /></td>
                <td><Badge value={r.threeWayMatched ? 'OK' : 'OPEN'} /></td>
                <td className="cell-num">{fmtMoney(r.total)}</td>
                <td className="cell-num">{fmtMoney(num(r.total) - num(r.amountPaid))}</td>
                <td style={{ textAlign: 'right' }}><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/buy/invoices/${r.id}`); }}>View</button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No supplier invoices.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="pager"><span>{fmtNum(rows.length)} records</span></div>
    </div>
  );
}
function InvoiceDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ invoice: Rec; items: Rec[]; payments: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: { invoice: Rec; items: Rec[]; payments: Rec[] } }>(`/api/ops/procurement/supplier-invoices/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Invoice failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening invoice..." />;
  const inv = doc.invoice;
  const invStatus = String(inv.status);
  const act = async (path: string, body: Rec = {}, ok = 'Done') => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const outstanding = num(inv.total) - num(inv.amountPaid);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/buy/invoices')}>Back</button>
          <h1>Invoice <span className="cell-mono">{String(inv.supplierInvoiceNo)}</span></h1>
          <p className="muted">
            {String(inv.supplierName)} · PO {String(inv.poNo ?? '-')} · GRN {String(inv.grnNo ?? '-')}
            {inv.supplierDocumentNo ? ` · supplier doc ${String(inv.supplierDocumentNo)}` : ''}
            {inv.threeWayMatched ? ' · three-way matched' : ' · match exception'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DownloadMenu type="purchase-invoice" id={id} code={String(inv.supplierInvoiceNo)} />
          <Badge value={invStatus} />
        </div>
      </header>
      <BuyTabs active="invoices" />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <Pipeline steps={INV_STEPS} status={invStatus} map={{ PARTIALLY_PAID: 'PAID' }} />
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Total</span><span className="kpi-value">{fmtMoney(inv.total)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Paid</span><span className="kpi-value">{fmtMoney(inv.amountPaid)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Open</span><span className="kpi-value">{fmtMoney(outstanding)}</span></div>
        <div className="kpi-card"><span className="kpi-label">GL</span><span className="kpi-value">{inv.glPosted ? 'Posted' : 'Open'}</span></div>
      </div>
      <div className="detail-grid">
        <div>
          <section className="card">
            <div className="card-head"><h3>Lines</h3><span className="muted">{fmtNum(doc.items.length)} items</span></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Product</th><th className="cell-num">Qty</th><th className="cell-num">Price</th><th className="cell-num">Line</th></tr></thead>
                <tbody>
                  {doc.items.map((i) => (
                    <tr key={String(i.id)}>
                      <td><div className="cell-mono">{String(i.productCode)}</div>{String(i.productName)}</td>
                      <td className="cell-num">{fmtNum(i.quantity)}</td>
                      <td className="cell-num">{fmtMoney(i.unitPrice)}</td>
                      <td className="cell-num">{fmtMoney(i.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          {doc.payments.length > 0 && (
            <section className="card">
              <div className="card-head"><h3>Payments</h3><span className="muted">{fmtNum(doc.payments.length)} on account</span></div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Payment</th><th>Status</th><th>Date</th><th className="cell-num">Amount</th></tr></thead>
                  <tbody>
                    {doc.payments.map((p) => (
                      <tr key={String(p.id)} className="row-click" onClick={() => navigate(`/buy/payments/${p.id}`)}>
                        <td className="cell-mono">{String(p.paymentNo)}</td>
                        <td><Badge value={p.status} /></td>
                        <td>{fmtDate(p.paymentDate)}</td>
                        <td className="cell-num">{fmtMoney(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
        <div className="detail-side">
          <section className="card">
            <div className="card-head"><h3>Next step</h3></div>
            <div className="flow-actions">
              {invStatus === 'DRAFT' && can(user, 'procurement.supplier_invoices.submit') && (
                <button className="btn btn-block btn-primary" disabled={busy} onClick={() => act(`/api/ops/procurement/supplier-invoices/${id}/submit`, {}, 'Submitted - posts AP when approved')}>Submit</button>
              )}
              {outstanding > 0 && can(user, 'procurement.payments.create') && ['APPROVED', 'MATCHED', 'PARTIALLY_PAID'].includes(invStatus) && (
                <button className="btn btn-block" disabled={busy} onClick={() => act('/api/ops/procurement/payments', {
                  supplierInvoiceId: id,
                  supplierId: Number(inv.supplierId),
                  amount: outstanding,
                }, 'Payment drafted - submit for release')}>Draft payment</button>
              )}
              {outstanding <= 0 && <p className="muted">Invoice fully paid.</p>}
              {inv.poId != null && <button className="btn btn-block" onClick={() => navigate(`/buy/orders/${inv.poId}`)}>Open PO</button>}
              {inv.grnId != null && <button className="btn btn-block" onClick={() => navigate(`/buy/receipts/${inv.grnId}`)}>Open GRN</button>}
            </div>
          </section>
          <MetaCard
            title="Details"
            rows={[
              ['Supplier', `${String(inv.supplierCode)} · ${String(inv.supplierName)}`],
              ['PO', inv.poNo ? String(inv.poNo) : ''],
              ['GRN', inv.grnNo ? String(inv.grnNo) : ''],
              ['Invoiced', fmtDate(inv.invoiceDate)],
              ['Due', fmtDate(inv.dueDate)],
              ['Subtotal', fmtMoney(inv.subtotal)],
              ['Tax', fmtMoney(inv.taxAmount)],
              ['Total', fmtMoney(inv.total)],
            ]}
          />
        </div>
      </div>
    </div>
  );
}
const PRICE_DAY_RANGES: [string, string][] = [
  ['30', '30 days'],
  ['90', '90 days'],
  ['180', '180 days'],
  ['365', '1 year'],
  ['1095', '3 years'],
];

const PRICE_FLAGS: [string, string][] = [
  ['', 'All flags'],
  ['LOW', 'Below −5%'],
  ['NEGATIVE', '−5% to 0%'],
  ['POSITIVE', '0% to +15%'],
  ['ABOVE', 'Above +15%'],
  ['NEW', 'First price'],
  ['FLAT', 'No change'],
];

function PriceFlag({ row }: { row: Rec }) {
  const p = String(row.profile ?? '');
  const pct = num(row.changePct);
  const pctTxt = pct > 0 ? `+${fmtNum(pct)}%` : `${fmtNum(pct)}%`;
  if (p === 'LOW') return <span className="badge badge-amber"><span className="badge-icon" aria-hidden>↓</span>{pctTxt}</span>;
  if (p === 'NEGATIVE') return <span className="badge badge-blue"><span className="badge-icon" aria-hidden>↘</span>{pctTxt}</span>;
  if (p === 'POSITIVE') return <span className="badge badge-green"><span className="badge-icon" aria-hidden>↗</span>{pctTxt}</span>;
  if (p === 'ABOVE') return <span className="badge badge-red"><span className="badge-icon" aria-hidden>↑</span>{pctTxt}</span>;
  if (p === 'NEW') return <span className="badge badge-blue"><span className="badge-icon" aria-hidden>●</span>NEW</span>;
  return <span className="badge badge-neutral"><span className="badge-icon" aria-hidden>→</span>{pctTxt}</span>;
}

function PricesDesk() {
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [summary, setSummary] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [flag, setFlag] = useState('');
  const [days, setDays] = useState('365');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 40;
  const load = useCallback((query: string) => {
    setError('');
    api<{ data: { rows: Rec[]; summary: Rec; page: number; pageSize: number; total: number } }>(`/api/ops/procurement/prices?${query}`)
      .then((r) => {
        setRows(r.data.rows);
        setSummary(r.data.summary);
        setTotal(r.data.total);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Price history failed'));
  }, []);
  useEffect(() => { load(`days=365&page=1&pageSize=${pageSize}`); }, [load]);
  const apply = (over: Partial<{ q: string; flag: string; days: string; page: number }> = {}) => {
    const p = new URLSearchParams();
    const fq = over.q ?? q;
    const ff = over.flag ?? flag;
    const fd = over.days ?? days;
    const fp = over.page ?? page;
    setPage(fp);
    if (fq.trim()) p.set('q', fq.trim());
    if (ff) p.set('flag', ff);
    p.set('days', fd);
    p.set('page', String(fp));
    p.set('pageSize', String(pageSize));
    load(p.toString());
  };
  if (error && !rows) return <ErrorBanner error={error} />;
  if (!rows) return <PageLoader label="Opening price intelligence..." />;
  const counts = ((summary?.counts as Rec | undefined) ?? {}) as Rec;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="proc">Procurement</p>
          <h1>Price intelligence</h1>
          <p className="muted">Supplier price history per product. Δ% is measured against the previous price from the same supplier in the window; LOW/ABOVE flags feed three-way match review.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/buy/match')}>Match desk</button>
        </div>
      </header>
      <BuyTabs active="prices" />
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Records</span>
          <span className="kpi-value">{fmtNum(total)}</span>
          <span className="kpi-sub">In selected window</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Cheapest</span>
          <span className="kpi-value">{fmtMoney(summary?.cheapest)}</span>
          <span className="kpi-sub">Lowest unit price</span>
        </div>
        <button className="kpi-card" onClick={() => { setFlag('LOW'); apply({ flag: 'LOW', page: 1 }); }}>
          <span className="kpi-label">Below trend</span>
          <span className="kpi-value">{fmtNum(counts.LOW)}</span>
          <span className="kpi-sub">&lt; −5% vs previous</span>
        </button>
        <button className="kpi-card" onClick={() => { setFlag('ABOVE'); apply({ flag: 'ABOVE', page: 1 }); }}>
          <span className="kpi-label">Above trend</span>
          <span className="kpi-value">{fmtNum(counts.ABOVE)}</span>
          <span className="kpi-sub">&gt; +15% vs previous</span>
        </button>
      </div>
      <div className="toolbar">
        <input
          className="search-input"
          placeholder="Search product or supplier..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') apply({ page: 1 }); }}
        />
        <select className="search-input" style={{ width: 'auto', maxWidth: 200 }} value={flag} onChange={(e) => { setFlag(e.target.value); apply({ flag: e.target.value, page: 1 }); }}>
          {PRICE_FLAGS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <select className="search-input" style={{ width: 'auto', maxWidth: 140 }} value={days} onChange={(e) => { setDays(e.target.value); apply({ days: e.target.value, page: 1 }); }}>
          {PRICE_DAY_RANGES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <button className="btn" onClick={() => apply({ page: 1 })}>Filter</button>
      </div>
      {error && <ErrorBanner error={error} />}
      <section className="card">
        <div className="card-head"><h3>Price records</h3><span className="muted">{fmtNum(total)} records</span></div>
        <div className="record-cards mobile-only">
          {rows.map((r) => (
            <div className="record-card" key={String(r.id)}>
              <div className="record-card-top">
                <strong className="cell-mono">{String(r.productCode)}</strong>
                <PriceFlag row={r} />
              </div>
              <div className="record-card-meta">
                <span>{String(r.supplierName)}</span>
                <span>{fmtMoney(r.unitPrice)}</span>
                <span>{fmtDay(r.effectiveDate)}</span>
                <span>{String(r.source)} {String(r.sourceNo ?? '')}</span>
              </div>
            </div>
          ))}
          {rows.length === 0 && <p className="muted" style={{ padding: 16 }}>No price records match this view.</p>}
        </div>
        <div className="table-wrap desktop-only">
          <table className="data">
            <thead><tr>
              <th>Product</th><th>Supplier</th>
              <th className="cell-num">Price</th><th className="cell-num">Prev</th><th>Δ%</th>
              <th>Period</th><th>Source</th><th>No</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)}>
                  <td><div className="cell-mono">{String(r.productCode)}</div>{String(r.productName)}</td>
                  <td>{String(r.supplierCode)} · {String(r.supplierName)}</td>
                  <td className="cell-num">{fmtMoney(r.unitPrice)}</td>
                  <td className="cell-num">{r.prevUnitPrice != null ? fmtMoney(r.prevUnitPrice) : <span className="muted">—</span>}</td>
                  <td><PriceFlag row={r} /></td>
                  <td>{fmtDay(r.effectiveDate)}</td>
                  <td><Badge value={r.source} /></td>
                  <td className="cell-mono">{String(r.sourceNo ?? '')}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No price records match this view.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => apply({ page: page - 1 })}>Prev</button>
          <span className="muted">Page {page} of {pages}</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => apply({ page: page + 1 })}>Next</button>
        </div>
      </section>
    </div>
  );
}

function MatchDesk() {
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [match, setMatch] = useState('');
  const load = useCallback((query = '') => {
    setError('');
    api<{ data: { rows: Rec[] } }>(`/api/ops/procurement/match?${query}`)
      .then((r) => setRows(r.data.rows))
      .catch((e) => setError(e instanceof Error ? e.message : 'Match desk failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const go = (m: string) => {
    setMatch(m);
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (m) p.set('match', m);
    load(p.toString());
  };
  const apply = () => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (match) p.set('match', match);
    load(p.toString());
  };
  if (error && !rows) return <ErrorBanner error={error} />;
  if (!rows) return <PageLoader label="Opening match desk..." />;
  const counts: Record<string, number> = { MATCHED: 0, PARTIAL: 0, DIFFERENCE: 0, PENDING: 0 };
  for (const r of rows) {
    const m = String(r.matchStatus ?? 'PENDING');
    counts[m] = (counts[m] ?? 0) + 1;
  }
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="proc">Procurement</p>
          <h1>Three-way match</h1>
          <p className="muted">PO vs GRN vs supplier invoice. Quantities must tie exactly; price tolerance 1% flags variances.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/buy/orders')}>Open POs</button>
        </div>
      </header>
      <BuyTabs active="match" />
      <div className="kpi-grid">
        <button className="kpi-card" onClick={() => go('')}>
          <span className="kpi-label">Released POs</span>
          <span className="kpi-value">{fmtNum(rows.length)}</span>
          <span className="kpi-sub">Approved, received or closed</span>
        </button>
        <button className="kpi-card" onClick={() => go('MATCHED')}>
          <span className="kpi-label">Matched</span>
          <span className="kpi-value">{fmtNum(counts.MATCHED)}</span>
          <span className="kpi-sub">Ready to pay</span>
        </button>
        <button className="kpi-card" onClick={() => go('PARTIAL')}>
          <span className="kpi-label">Partial</span>
          <span className="kpi-value">{fmtNum(counts.PARTIAL)}</span>
          <span className="kpi-sub">Still in progress</span>
        </button>
        <button className="kpi-card" onClick={() => go('DIFFERENCE')}>
          <span className="kpi-label">Difference</span>
          <span className="kpi-value">{fmtNum(counts.DIFFERENCE)}</span>
          <span className="kpi-sub">Qty or price breaks</span>
        </button>
      </div>
      <div className="toolbar">
        <input
          className="search-input"
          placeholder="Search PO or supplier..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
        />
        <select className="search-input" style={{ width: 'auto', maxWidth: 200 }} value={match} onChange={(e) => go(e.target.value)}>
          <option value="">All match states</option>
          <option value="MATCHED">Matched</option>
          <option value="PARTIAL">Partial</option>
          <option value="DIFFERENCE">Difference</option>
          <option value="PENDING">Pending</option>
        </select>
        <button className="btn" onClick={apply}>Filter</button>
      </div>
      {error && <ErrorBanner error={error} />}
      <section className="card">
        <div className="card-head"><h3>Released purchase orders</h3><span className="muted">{fmtNum(rows.length)} shown</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>PO</th><th>Supplier</th><th>Status</th><th>Match</th>
              <th className="cell-num">Ordered</th><th className="cell-num">Received</th><th className="cell-num">Invoiced</th><th className="cell-num">Total</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/buy/match/${r.id}`)}>
                  <td className="cell-mono">{String(r.poNo)}</td>
                  <td>{String(r.supplierCode)} · {String(r.supplierName)}</td>
                  <td><Badge value={r.status} /></td>
                  <td><Badge value={r.matchStatus} /></td>
                  <td className="cell-num">{fmtNum(r.orderedQty)}</td>
                  <td className="cell-num">{fmtNum(r.receivedQty)}</td>
                  <td className="cell-num">{fmtNum(r.invoicedQty)}</td>
                  <td className="cell-num">{fmtMoney(r.total)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No released POs match this view.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function MatchDetail({ poId }: { poId: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError('');
    api<{ data: Rec }>(`/api/ops/procurement/match/${poId}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Match check failed'));
  }, [poId]);
  useEffect(() => { load(); }, [load]);
  const run = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(`/api/ops/procurement/match/${poId}/run`, { method: 'POST', body: '{}' });
      setDoc(r.data);
      setNotice(`Match check complete — ${String(((r.data.summary ?? {}) as Rec).matchStatus)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Computing three-way match..." />;
  const po = (doc.po ?? {}) as Rec;
  const summary = (doc.summary ?? {}) as Rec;
  const lines = (doc.lines ?? []) as Rec[];
  const grns = (doc.grns ?? []) as Rec[];
  const invoices = (doc.invoices ?? []) as Rec[];
  const counts = (summary.lineCounts ?? {}) as Rec;
  const variance = num(summary.varianceTotal);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/buy/match')}>Back</button>
          <h1>Three-way match <span className="cell-mono">{String(po.poNo)}</span></h1>
          <p className="muted">{String(po.supplierCode ?? '')} · {String(po.supplierName ?? '')} · {fmtMoney(po.total)}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {can(user, 'procurement.orders.update') && (
            <button className="btn btn-primary" disabled={busy} onClick={run}>{busy ? 'Checking…' : 'Run match check'}</button>
          )}
          <Badge value={summary.matchStatus} />
        </div>
      </header>
      <BuyTabs active="match" />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Ordered</span><span className="kpi-value">{fmtMoney(summary.orderedTotal)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Received</span><span className="kpi-value">{fmtMoney(summary.receivedTotal)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Invoiced</span><span className="kpi-value">{fmtMoney(summary.invoicedTotal)}</span></div>
        <div className="kpi-card">
          <span className="kpi-label">Variance</span>
          <span className="kpi-value" style={variance > 0 ? { color: 'var(--danger)' } : undefined}>{fmtMoney(variance)}</span>
          <span className="kpi-sub">{fmtNum(counts.matched)} / {fmtNum(counts.total)} lines matched</span>
        </div>
      </div>
      <section className="card">
        <div className="card-head"><h3>Lines</h3><span className="muted">Qty tolerance 0 · price tolerance {String(summary.priceTolerancePct)}%</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>Item</th>
              <th className="cell-num">Ordered</th>
              <th className="cell-num">Received</th>
              <th className="cell-num">Accepted</th>
              <th className="cell-num">Rejected</th>
              <th className="cell-num">Invoiced</th>
              <th className="cell-num">PO price</th>
              <th className="cell-num">Invoice price</th>
              <th className="cell-num">Δ%</th>
              <th>Line match</th>
            </tr></thead>
            <tbody>
              {lines.map((l) => {
                const pct = num(l.priceVariancePct);
                const flagged = String(l.priceFlag) === 'ABOVE_TOLERANCE' || String(l.priceFlag) === 'BELOW_TOLERANCE';
                return (
                  <tr key={String(l.poItemId)}>
                    <td><div>{String(l.productName)}</div><span className="muted">{String(l.productCode)}</span></td>
                    <td className="cell-num">{fmtNum(l.orderedQty)}</td>
                    <td className="cell-num">{fmtNum(l.receivedQty)}</td>
                    <td className="cell-num">{fmtNum(l.acceptedQty)}</td>
                    <td className="cell-num">{fmtNum(l.rejectedQty)}</td>
                    <td className="cell-num">{fmtNum(l.invoicedQty)}</td>
                    <td className="cell-num">{fmtMoney(l.unitPrice)}</td>
                    <td className="cell-num">{fmtMoney(l.invoiceUnitPrice)}</td>
                    <td className="cell-num" style={flagged ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{pct !== 0 ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}</td>
                    <td><Badge value={l.status} /></td>
                  </tr>
                );
              })}
              {lines.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>No lines on this purchase order.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, alignItems: 'start' }}>
        <section className="card">
          <div className="card-head"><h3>Goods receipts</h3><span className="muted">{fmtNum(grns.length)}</span></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>GRN</th><th>Status</th><th>Received</th><th className="cell-num">Qty</th><th className="cell-num">Amount</th></tr></thead>
              <tbody>
                {grns.map((g) => (
                  <tr key={String(g.id)} className="row-click" onClick={() => navigate(`/buy/receipts/${g.id}`)}>
                    <td className="cell-mono">{String(g.grnNo)}</td>
                    <td><Badge value={g.status} /></td>
                    <td>{g.receivedAt ? fmtDay(g.receivedAt) : '—'}</td>
                    <td className="cell-num">{fmtNum(g.totalQty)}</td>
                    <td className="cell-num">{fmtMoney(g.totalAmount)}</td>
                  </tr>
                ))}
                {grns.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 16 }}>Nothing received yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h3>Supplier invoices</h3><span className="muted">{fmtNum(invoices.length)}</span></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Invoice</th><th>Status</th><th>Date</th><th className="cell-num">Qty</th><th className="cell-num">Total</th></tr></thead>
              <tbody>
                {invoices.map((iv) => (
                  <tr key={String(iv.id)} className="row-click" onClick={() => navigate(`/buy/invoices/${iv.id}`)}>
                    <td className="cell-mono">{String(iv.supplierInvoiceNo)}</td>
                    <td><Badge value={iv.status} /></td>
                    <td>{iv.invoiceDate ? fmtDay(iv.invoiceDate) : '—'}</td>
                    <td className="cell-num">{fmtNum(iv.totalQty)}</td>
                    <td className="cell-num">{fmtMoney(iv.total)}</td>
                  </tr>
                ))}
                {invoices.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 16 }}>No invoices yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function PaymentDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ payment: Rec } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: { payment: Rec } }>(`/api/ops/procurement/payments/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Payment failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening payment…" />;
  const p = doc.payment;
  const status = String(p.status);
  const act = async (path: string, ok: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: '{}' });
      setNotice(ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/buy/payments')}>Back</button>
          <h1>Payment <span className="cell-mono">{String(p.paymentNo)}</span></h1>
          <p className="muted">{String(p.supplierName)} · {fmtMoney(p.amount)}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DownloadMenu type="supplier-payment" id={id} code={String(p.paymentNo)} />
          <Badge value={status} />
        </div>
      </header>
      <BuyTabs active="payments" />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="detail-grid">
        <div>
          <MetaCard
            title="Voucher"
            rows={[
              ['Supplier', `${String(p.supplierCode ?? '')} · ${String(p.supplierName ?? '')}`],
              ['Invoice', p.supplierInvoiceNo ? String(p.supplierInvoiceNo) : ''],
              ['PO', p.poNo ? String(p.poNo) : ''],
              ['Date', fmtDate(p.paymentDate)],
              ['Method', String(p.method ?? '')],
              ['Reference', p.reference ? String(p.reference) : ''],
              ['Bank', [p.bankName, p.bankAccountName].filter(Boolean).join(' · ')],
              ['Amount', fmtMoney(p.amount)],
              ['GL', p.glPosted ? 'Posted' : 'Open'],
            ]}
          />
        </div>
        <div className="detail-side">
          <section className="card">
            <div className="card-head"><h3>Next step</h3></div>
            <div className="flow-actions">
              {status === 'PENDING' && can(user, 'procurement.payments.submit') && (
                <button className="btn btn-block btn-primary" disabled={busy} onClick={() => act(`/api/ops/procurement/payments/${id}/submit`, 'Submitted for release')}>Submit</button>
              )}
              {p.supplierInvoiceId != null && <button className="btn btn-block" onClick={() => navigate(`/buy/invoices/${p.supplierInvoiceId}`)}>Open invoice</button>}
              <button className="btn btn-block" onClick={() => navigate('/inbox')}>Approvals inbox</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function PaymentList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/procurement/payments').then((r) => setRows(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'Payments failed'));
  }, []);
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (status && String(r.status) !== status) return false;
      if (!term) return true;
      return String(r.paymentNo).toLowerCase().includes(term) || String(r.supplierName).toLowerCase().includes(term) || String(r.supplierInvoiceNo ?? '').toLowerCase().includes(term);
    });
  }, [rows, q, status]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="proc">Supplier payments</p>
          <h1>Outgoing payments</h1>
          <p className="muted">Submit sends the payment into the release workflow. The bank/AP journal posts on release.</p>
        </div>
        <button className="btn" onClick={() => navigate('/finance/ap')}>AP ledger</button>
      </header>
      <BuyTabs active="payments" />
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search payment, supplier or invoice..." />
        <StatusFilter value={status} onChange={setStatus} options={['PENDING', 'SUBMITTED', 'APPROVED', 'RELEASED', 'CANCELLED']} />
      </div>
      <div className="record-cards mobile-only">
        {filtered.map((r) => (
          <button key={String(r.id)} className="record-card" onClick={() => navigate(`/buy/payments/${r.id}`)}>
            <div className="record-card-top">
              <strong className="cell-mono">{String(r.paymentNo)}</strong>
              <Badge value={r.status} />
            </div>
            <div className="record-card-meta">
              <span>{String(r.supplierName)}</span>
              <span>{fmtDate(r.paymentDate)}</span>
              <span>{fmtMoney(r.amount)}</span>
            </div>
          </button>
        ))}
        {filtered.length === 0 && <p className="muted" style={{ padding: 16 }}>No payments.</p>}
      </div>
      <div className="table-wrap card desktop-only">
        <table className="data">
          <thead><tr><th>Payment</th><th>Supplier</th><th>Invoice</th><th>Date</th><th>Status</th><th className="cell-num">Amount</th></tr></thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/buy/payments/${r.id}`)}>
                <td className="cell-mono">{String(r.paymentNo)}</td>
                <td>{String(r.supplierName)}</td>
                <td className="cell-mono">{String(r.supplierInvoiceNo ?? '-')}</td>
                <td>{fmtDate(r.paymentDate)}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{fmtMoney(r.amount)}</td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No payments.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="pager"><span>{fmtNum(filtered.length)} records</span></div>
    </div>
  );
}
