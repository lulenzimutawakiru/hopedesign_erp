import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, fmtDate, fmtMoney, fmtNum, ListResult, openDocument } from '../api';
import { useAuth, can } from '../auth';
import { navigate, useHashQuery } from '../router';
import { pick } from '../helpers';
import DownloadMenu from '../components/DownloadMenu';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';

const RESOURCES: { resource: string; label: string; perm: string }[] = [
  { resource: 'quotations', label: 'Quotations', perm: 'sales.quotations.view' },
  { resource: 'customers', label: 'Customers', perm: 'sales.quotations.view' },
  { resource: 'orders', label: 'Sales Orders', perm: 'sales.orders.view' },
  { resource: 'delivery_notes', label: 'Delivery Notes', perm: 'sales.delivery_notes.view' },
  { resource: 'invoices', label: 'Invoices', perm: 'sales.invoices.view' },
  { resource: 'receipts', label: 'Receipts', perm: 'sales.receipts.view' },
  { resource: 'credit_notes', label: 'Credit Notes', perm: 'sales.credit_notes.view' },
  { resource: 'debit_notes', label: 'Debit Notes', perm: 'sales.debit_notes.view' },
  { resource: 'returns', label: 'Returns', perm: 'sales.returns.view' },
];

const QUOTE_STEPS = ['DRAFT', 'SUBMITTED', 'APPROVED', 'CONVERTED'];
const ORDER_STEPS = ['DRAFT', 'SUBMITTED', 'APPROVED', 'ALLOCATED', 'DISPATCHED', 'INVOICED'];

type Rec = Record<string, unknown>;

export function parseSalesPath(path: string): { resource: string; id: string | null } {
  const parts = path.split('/').filter(Boolean);
  const start = parts[0] === 'records' ? 1 : 0;
  return {
    resource: parts[start + 1] ?? 'board',
    id: parts[start + 2] ?? null,
  };
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function lineTotal(qty: number, price: number, disc: number, tax: number): number {
  const base = qty * price;
  const afterDisc = base - base * (disc / 100);
  return Math.round((afterDisc + afterDisc * (tax / 100)) * 100) / 100;
}

export default function SalesFlow({ path }: { path: string }) {
  const { resource, id } = parseSalesPath(path);
  if (resource === 'board' || resource === '') return <SalesBoard />;
  if (id === 'new') return <Composer resource={resource} />;
  if (resource === 'customers' && id && Number(id) > 0) return <CustomerDesk id={Number(id)} />;
  if (resource === 'customers') return <CustomerDirectory />;
  if (id && Number(id) > 0) return <DocumentDetail resource={resource} id={Number(id)} />;
  return <DocumentList resource={resource} />;
}

function SalesBoard() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/sales/command-center')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Sales command center failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening command center…" />;

  const k = (data.kpis ?? {}) as Rec;
  const alerts = (data.alerts as Rec[]) ?? [];
  const funnelOrders = ((data.funnel as Rec)?.orders as Rec[]) ?? [];
  const topProducts = (data.topProducts as Rec[]) ?? [];
  const quotes = (data.quotes as Rec[]) ?? [];
  const orders = (data.orders as Rec[]) ?? [];
  const invoices = (data.invoices as Rec[]) ?? [];
  const n = (v: unknown) => Number(v ?? 0);
  const todaySales = n(k.todaySales);
  const monthSales = n(k.monthSales);
  const prevMonth = n(k.prevMonthSales);
  const target = n(k.target);
  const targetPct = k.targetAchievementPct != null ? n(k.targetAchievementPct) : null;
  const grossProfit = n(k.grossProfit);
  const grossMargin = k.grossMargin != null ? n(k.grossMargin) : null;
  const conversion = k.conversionRate != null ? n(k.conversionRate) : null;
  const monthDelta = prevMonth > 0 ? Math.round(((monthSales - prevMonth) / prevMonth) * 100) : null;

  const tiles: { key: string; icon: string; label: string; value: string; sub: string; accent: string; href: string }[] = [
    { key: 'today', icon: '💵', label: "Today's sales", value: fmtMoney(todaySales), sub: `${fmtMoney(n(k.todayReceipts))} collected today`, accent: '#00A6A6', href: '/sales/invoices' },
    { key: 'month', icon: '📈', label: 'Monthly sales', value: fmtMoney(monthSales), sub: `${fmtNum(n(k.monthInvoices))} invoices${monthDelta != null ? ` · ${monthDelta > 0 ? '+' : ''}${monthDelta}% vs last month` : ''}`, accent: '#168A5B', href: '/sales/invoices' },
    { key: 'target', icon: '🎯', label: 'Target', value: targetPct != null ? `${fmtNum(targetPct)}%` : '—', sub: `of ${fmtMoney(target)} monthly`, accent: '#D99A00', href: '/sales/orders' },
    { key: 'orders', icon: '🧾', label: 'Open orders', value: fmtNum(n(k.openOrders)), sub: `${fmtNum(n(k.awaitingStock))} await stock`, accent: '#1261A0', href: '/sales/orders' },
    { key: 'quotes', icon: '📝', label: 'Open quotes', value: fmtNum(n(k.openQuotes)), sub: conversion != null ? `${fmtNum(conversion)}% converted` : 'no conversions yet', accent: '#8B5CF6', href: '/sales/quotations' },
    { key: 'ar', icon: '⏳', label: 'Outstanding AR', value: fmtMoney(n(k.openAr)), sub: `${fmtNum(n(k.overdueInvoices))} overdue`, accent: '#C93636', href: '/sales/invoices' },
    { key: 'mfg', icon: '🏭', label: 'In production', value: fmtNum(n(k.awaitingProduction)), sub: `${fmtNum(n(k.awaitingDispatch))} ready to dispatch`, accent: '#D97706', href: '/records/production/work_orders' },
    { key: 'aov', icon: '🧮', label: 'Average order', value: fmtMoney(n(k.averageOrderValue)), sub: 'per invoice this month', accent: '#0E7490', href: '/sales/invoices' },
    { key: 'margin', icon: '💹', label: 'Gross margin', value: grossMargin != null ? `${fmtNum(grossMargin)}%` : '—', sub: `GP ${fmtMoney(grossProfit)} this month`, accent: '#166534', href: '/sales/invoices' },
  ];

  const stageDefs: { status: string; label: string }[] = [
    { status: 'DRAFT', label: 'Draft' },
    { status: 'SUBMITTED', label: 'Submitted' },
    { status: 'APPROVED', label: 'Stock ready' },
    { status: 'ALLOCATED', label: 'Allocated' },
    { status: 'PARTIALLY_DISPATCHED', label: 'Partial ship' },
    { status: 'DISPATCHED', label: 'Dispatched' },
    { status: 'INVOICED', label: 'Invoiced' },
  ];
  const stageCount = (status: string) => n(funnelOrders.find((r) => String(r.status) === status)?.c);
  const activeTotal = stageDefs.reduce((acc, s) => acc + stageCount(s.status), 0);
  const closed = funnelOrders.reduce((acc, r) => acc + (['CANCELLED', 'VOID', 'CLOSED'].includes(String(r.status)) ? n(r.c) : 0), 0);
  const funnelMax = Math.max(activeTotal, 1);

  const severityCls = (sev: unknown) => (sev === 'crit' ? 'severity-critical' : sev === 'warn' ? 'severity-high' : 'severity-medium');
  const alertIcon: Record<string, string> = { stock: '📦', production: '🏭', quote: '📝', ar: '⏳', delivery: '🚚' };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>Sales Command Center</h1>
          <p className="muted">Customer to cash: quote, convert, allocate, produce, ship, invoice, collect — live.</p>
        </div>
        <div className="head-actions">
          {can(user, 'sales.quotations.create') && <button className="btn" onClick={() => navigate('/sales/quotations/new')}>New quotation</button>}
          {can(user, 'sales.orders.create') && <button className="btn" onClick={() => navigate('/sales/orders/new')}>New order</button>}
          {can(user, 'sales.receipts.create') && <button className="btn btn-primary" onClick={() => navigate('/sales/receipts/new')}>Record payment</button>}
        </div>
      </header>

      <div className="kpi-grid--tiles">
        {tiles.map((t) => (
          <button
            key={t.key}
            className="kpi-tile"
            style={{ '--tile-accent': t.accent, '--tile-tint': `${t.accent}1A` } as CSSProperties}
            onClick={() => navigate(t.href)}
          >
            <span className="kpi-tile-icon">{t.icon}</span>
            <span className="kpi-tile-body">
              <span className="kpi-tile-label">{t.label}</span>
              <span className="kpi-tile-value">{t.value}</span>
              <span className="kpi-tile-sub">{t.sub}</span>
            </span>
          </button>
        ))}
      </div>

      {alerts.length > 0 && (
        <section className="card card-pad" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Alerts</h3>
          <div className="exception-list">
            {alerts.map((a, i) => (
              <button key={`${String(a.kind)}-${i}`} className={`exception-item ${severityCls(a.severity)}`} onClick={() => navigate(String(a.href))}>
                <div>
                  <strong>{alertIcon[String(a.kind)] ?? '⚠'} {String(a.title)}</strong>
                  <div className="muted">{String(a.meta)}</div>
                </div>
                <span className="ex-count">{fmtNum(n(a.count))}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h3>Order fulfilment pipeline</h3>
          <span className="muted">{fmtNum(activeTotal)} active{closed > 0 ? ` · ${fmtNum(closed)} closed` : ''}</span>
        </div>
        <div className="funnel-strip">
          {stageDefs.map((s) => {
            const count = stageCount(s.status);
            const pct = Math.round((count / funnelMax) * 100);
            return (
              <button key={s.status} className="funnel-step" onClick={() => navigate('/sales/orders')}>
                <span className="funnel-count">{fmtNum(count)}</span>
                <span className="funnel-label">{s.label}</span>
                <span className="mini-progress-track"><span className="mini-progress-fill" style={{ width: `${pct}%` }} /></span>
              </button>
            );
          })}
        </div>
      </section>

      <h3 className="section-title">Do now</h3>
      <div className="do-now">
        <button onClick={() => navigate('/sales/quotations')}><span className="now-ic">📝</span><span><strong>Quotations</strong><span>Submit and convert</span></span></button>
        <button onClick={() => navigate('/sales/orders')}><span className="now-ic">🧾</span><span><strong>Orders</strong><span>Allocate and ship</span></span></button>
        <button onClick={() => navigate('/inventory/pick')}><span className="now-ic">🧺</span><span><strong>Warehouse pick</strong><span>Fulfilment</span></span></button>
        <button onClick={() => navigate('/records/production/work_orders')}><span className="now-ic">🏭</span><span><strong>Production</strong><span>Sales-linked work orders</span></span></button>
        <button onClick={() => navigate('/sales/delivery_notes')}><span className="now-ic">🚚</span><span><strong>Deliveries</strong><span>Dispatch and POD</span></span></button>
        <button onClick={() => navigate('/crm')}><span className="now-ic">👥</span><span><strong>Accounts</strong><span>Pipeline and credit</span></span></button>
      </div>

      {topProducts.length > 0 && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head"><h3>Top products this month</h3><button className="btn btn-sm" onClick={() => navigate('/inventory/items')}>All items</button></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Product</th><th className="cell-num">Qty</th><th className="cell-num">Revenue</th></tr></thead>
              <tbody>
                {topProducts.map((r) => (
                  <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/inventory/items/${r.id}`)}>
                    <td><span className="cell-mono">{String(r.code)}</span> {String(r.name)}</td>
                    <td className="cell-num">{fmtNum(n(r.qty))}</td>
                    <td className="cell-num">{fmtMoney(r.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="grid-2" style={{ marginTop: 16 }}>
        <section className="card">
          <div className="card-head"><h3>Live orders</h3><button className="btn btn-sm" onClick={() => navigate('/sales/orders')}>All orders</button></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>SO</th><th>Customer</th><th>Status</th><th className="cell-num">Total</th></tr></thead>
              <tbody>
                {orders.map((r) => (
                  <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/sales/orders/${r.id}`)}>
                    <td className="cell-mono">{String(r.orderNo)}</td>
                    <td>{String(r.customerName)}</td>
                    <td><Badge value={r.status} /></td>
                    <td className="cell-num">{fmtMoney(r.total)}</td>
                  </tr>
                ))}
                {orders.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24 }}>No open orders.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h3>Quotes in play</h3><button className="btn btn-sm" onClick={() => navigate('/sales/quotations')}>All quotes</button></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Quote</th><th>Customer</th><th>Status</th><th className="cell-num">Total</th></tr></thead>
              <tbody>
                {quotes.map((r) => (
                  <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/sales/quotations/${r.id}`)}>
                    <td className="cell-mono">{String(r.quotationNo)}</td>
                    <td>{String(r.customerName)}</td>
                    <td><Badge value={r.status} /></td>
                    <td className="cell-num">{fmtMoney(r.total)}</td>
                  </tr>
                ))}
                {quotes.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No open quotes.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h3>Open invoices</h3><button className="btn btn-sm" onClick={() => navigate('/sales/invoices')}>All invoices</button></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Status</th><th className="cell-num">Open</th></tr></thead>
            <tbody>
              {invoices.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/sales/invoices/${r.id}`)}>
                  <td className="cell-mono">{String(r.invoiceNo)}</td>
                  <td>{String(r.customerName)}</td>
                  <td><Badge value={r.status} /></td>
                  <td className="cell-num">{fmtMoney(Number(r.total) - Number(r.amountPaid ?? 0))}</td>
                </tr>
              ))}
              {invoices.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No open invoices.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ResourceTabs({ resource }: { resource: string }) {
  void resource;
  return null;
}

function CustomerDirectory() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    api<{ data: Rec[] }>(`/api/ops/sales/customers/directory?${p.toString()}`)
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Customers failed'));
  }, [q]);
  useEffect(() => { load(); }, [load]);
  const totalOutstanding = rows.reduce((s, r) => s + num(r.outstanding), 0);
  const openAccts = rows.filter((r) => num(r.openOrders) > 0).length;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>Customers</h1>
          <p className="muted">Directory with credit position and sales activity for every account.</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={() => navigate('/sales/quotations/new')}>New quotation</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="summary-chips">
        <span className="summary-chip"><b>{fmtNum(rows.length)}</b> accounts</span>
        <span className="summary-chip"><b>{fmtNum(openAccts)}</b> with open orders</span>
        <span className="summary-chip"><b>{fmtMoney(totalOutstanding)}</b> outstanding</span>
      </div>
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, name, email, phone" />
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th className="cell-num">Credit limit</th>
              <th className="cell-num">Outstanding</th>
              <th className="cell-num">Open orders</th>
              <th className="cell-num">Month sales</th>
              <th>Last order</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/sales/customers/${r.id}`)}>
                <td className="cell-mono">{String(r.code)}</td>
                <td>{String(r.name)}</td>
                <td>{String(r.customerType ?? '-')}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{Number(r.creditLimit) > 0 ? fmtMoney(r.creditLimit) : '-'}</td>
                <td className="cell-num">{fmtMoney(r.outstanding)}</td>
                <td className="cell-num">{fmtNum(r.openOrders)}</td>
                <td className="cell-num">{fmtMoney(r.monthSales)}</td>
                <td>{r.lastOrderDate ? fmtDate(r.lastOrderDate) : '-'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>No customers found.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CustomerDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('overview');
  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/sales/customers/${id}/360`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Customer failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening customer..." />;
  const c = (doc.customer ?? {}) as Rec;
  const credit = (doc.credit ?? {}) as Rec;
  const aging = (doc.aging ?? {}) as Rec;
  const summary = (doc.summary ?? {}) as Rec;
  const favourites = (doc.favouriteProducts as Rec[]) ?? [];
  const orders = (doc.orders as Rec[]) ?? [];
  const quotes = (doc.quotes as Rec[]) ?? [];
  const invoices = (doc.invoices as Rec[]) ?? [];
  const deliveries = (doc.deliveries as Rec[]) ?? [];
  const payments = (doc.payments as Rec[]) ?? [];
  const contacts = (doc.contacts as Rec[]) ?? [];
  const timeline = (doc.timeline as Rec[]) ?? [];

  const creditOk = Boolean(credit.ok);
  const kindRes: Record<string, string> = {
    order: 'orders',
    quotation: 'quotations',
    invoice: 'invoices',
    delivery: 'delivery_notes',
    payment: 'receipts',
  };
  const go = (resource: string) =>
    navigate(`/sales/${resource}/new`, { query: { customer: id, customerLabel: `${String(c.code)} - ${String(c.name)}` } });
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'contacts', label: 'Contacts' },
    { key: 'orders', label: 'Quotations & Orders' },
    { key: 'invoices', label: 'Invoices' },
    { key: 'payments', label: 'Payments' },
    { key: 'deliveries', label: 'Deliveries' },
  ];
  const agingRows: [string, unknown][] = [
    ['Current', aging.current],
    ['1-30', aging.days130],
    ['31-60', aging.days3160],
    ['61-90', aging.days6190],
    ['90+', aging.days90Plus],
  ];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/sales/customers')}>Back</button>
          <h1>{String(c.name)} <span className="cell-mono">{String(c.code)}</span></h1>
          <p className="muted">
            <Badge value={c.status} />
            <span className={`badge ${creditOk ? 'badge-green' : 'badge-warn'}`}>
              <span className="badge-icon" aria-hidden>{creditOk ? 'OK' : '!'}</span>
              {creditOk ? 'Credit approved' : 'Credit hold'}
            </span>
            <span>{fmtNum(c.paymentTermsDays)}d terms</span>
          </p>
        </div>
        <div className="head-actions">
          {can(user, 'sales.quotations.create') && <button className="btn" onClick={() => go('quotations')}>New quotation</button>}
          {can(user, 'sales.orders.create') && <button className="btn btn-primary" onClick={() => go('orders')}>New order</button>}
          <button className="btn" onClick={() => navigate('/finance/ar')}>View AR</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="card-head"><h3>Credit check</h3></div>
        <div className="kpi-grid">
          <div className="kpi-card">
            <span className="kpi-label">Credit limit</span>
            <span className="kpi-value">{Number(credit.creditLimit) > 0 ? fmtMoney(credit.creditLimit) : 'Open'}</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Outstanding AR</span>
            <span className="kpi-value">{fmtMoney(credit.openAr)}</span>
            <span className="kpi-sub">{fmtNum(credit.overdueInvoices)} overdue</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Available credit</span>
            <span className="kpi-value">{credit.available != null ? fmtMoney(credit.available) : 'Unlimited'}</span>
          </div>
          <div className={`kpi-card ${creditOk ? '' : 'card-warn'}`}>
            <span className="kpi-label">Status</span>
            <span className="kpi-value">{creditOk ? 'OK' : 'Hold'}</span>
            <span className="kpi-sub">{creditOk ? 'Within credit limit' : String(credit.reason ?? 'Overdue / over limit')}</span>
          </div>
        </div>
        <div className="aging-row" style={{ marginTop: 12 }}>
          {agingRows.map(([label, val]) => (
            <div key={label} className="aging-cell">
              <span className="muted">{label}</span>
              <strong>{fmtMoney(val)}</strong>
            </div>
          ))}
        </div>
        {!creditOk && (
          <div className="alert alert-error" style={{ marginTop: 12 }}>
            <strong>Credit hold:</strong> {String(credit.reason ?? 'Check the account')}. New orders will require approval.
            <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => navigate('/inbox')}>View approvals</button>
          </div>
        )}
      </section>
      <div className="summary-chips">
        <span className="summary-chip"><b>{fmtMoney(summary.monthSales)}</b> month</span>
        <span className="summary-chip"><b>{fmtMoney(summary.yearSales)}</b> YTD</span>
        <span className="summary-chip"><b>{fmtNum(summary.openOrderCount)}</b> open orders</span>
        <span className="summary-chip"><b>{fmtNum(summary.orderCount)}</b> total orders</span>
        <span className="summary-chip"><b>{fmtMoney(summary.avgOrderValue)}</b> AOV</span>
      </div>
      <div className="sales-tabs">
        {tabs.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'overview' && (
        <div className="grid-2">
          <section className="card">
            <div className="card-head"><h3>Favourite products</h3></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Product</th><th className="cell-num">Qty</th><th className="cell-num">Revenue</th></tr></thead>
                <tbody>
                  {favourites.map((p) => (
                    <tr key={String(p.id)}>
                      <td>{String(p.name)} <span className="cell-mono">{String(p.code)}</span></td>
                      <td className="cell-num">{fmtNum(p.qty)}</td>
                      <td className="cell-num">{fmtMoney(p.revenue)}</td>
                    </tr>
                  ))}
                  {favourites.length === 0 && <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>No orders yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>Activity</h3></div>
            <div className="related-list">
              {timeline.map((e, i) => {
                const res = kindRes[String(e.kind)] ?? 'orders';
                return (
                  <button key={`${String(e.kind)}-${String(e.ref)}-${i}`} className="related-item" onClick={() => navigate(`/sales/${res}/${String(e.ref)}`)}>
                    <span><span className="muted">{fmtDate(e.at)}</span> <span className="cell-mono">{String(e.label)}</span></span>
                    <Badge value={e.status} />
                  </button>
                );
              })}
              {timeline.length === 0 && <p className="muted" style={{ padding: 12 }}>No activity yet.</p>}
            </div>
          </section>
        </div>
      )}
      {tab === 'contacts' && (
        <section className="card">
          <div className="card-head"><h3>Contacts</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>Title</th><th>Email</th><th>Phone</th><th>Department</th></tr></thead>
              <tbody>
                {contacts.map((p) => (
                  <tr key={String(p.id)}>
                    <td>{String(p.firstName)} {String(p.lastName)} {p.isPrimary ? <span className="badge badge-green">primary</span> : null}</td>
                    <td>{String(p.title ?? '-')}</td>
                    <td>{String(p.email ?? '-')}</td>
                    <td>{String(p.phone ?? p.mobile ?? '-')}</td>
                    <td>{String(p.department ?? '-')}</td>
                  </tr>
                ))}
                {contacts.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No contacts on file.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tab === 'orders' && (
        <>
          <section className="card">
            <div className="card-head"><h3>Quotations</h3></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Number</th><th>Status</th><th className="cell-num">Total</th><th>Date</th><th>Valid until</th></tr></thead>
                <tbody>
                  {quotes.map((qt) => (
                    <tr key={String(qt.id)} className="row-click" onClick={() => navigate(`/sales/quotations/${qt.id}`)}>
                      <td className="cell-mono">{String(qt.quotationNo)}</td>
                      <td><Badge value={qt.status} /></td>
                      <td className="cell-num">{fmtMoney(qt.total)}</td>
                      <td>{fmtDate(qt.quotationDate)}</td>
                      <td>{qt.validUntil ? fmtDate(qt.validUntil) : '-'}</td>
                    </tr>
                  ))}
                  {quotes.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No quotations yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>Sales orders</h3></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Number</th><th>Status</th><th className="cell-num">Total</th><th>Order date</th><th>Requested</th></tr></thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={String(o.id)} className="row-click" onClick={() => navigate(`/sales/orders/${o.id}`)}>
                      <td className="cell-mono">{String(o.orderNo)}</td>
                      <td><Badge value={o.status} /></td>
                      <td className="cell-num">{fmtMoney(o.total)}</td>
                      <td>{fmtDate(o.orderDate)}</td>
                      <td>{o.requestedDate ? fmtDate(o.requestedDate) : '-'}</td>
                    </tr>
                  ))}
                  {orders.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No sales orders yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {tab === 'invoices' && (
        <section className="card">
          <div className="card-head"><h3>Invoices</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Number</th><th>Status</th><th className="cell-num">Total</th><th className="cell-num">Balance</th><th>Date</th></tr></thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={String(inv.id)} className="row-click" onClick={() => navigate(`/sales/invoices/${inv.id}`)}>
                    <td className="cell-mono">{String(inv.invoiceNo)}</td>
                    <td><Badge value={inv.status} /></td>
                    <td className="cell-num">{fmtMoney(inv.total)}</td>
                    <td className="cell-num">{fmtMoney(inv.balance)}</td>
                    <td>{fmtDate(inv.invoiceDate)}</td>
                  </tr>
                ))}
                {invoices.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No invoices yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tab === 'payments' && (
        <section className="card">
          <div className="card-head"><h3>Payments</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Receipt</th><th>Method</th><th className="cell-num">Amount</th><th>Date</th><th>Reference</th><th>Status</th></tr></thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={String(p.id)} className="row-click" onClick={() => navigate(`/sales/receipts/${p.id}`)}>
                    <td className="cell-mono">{String(p.receiptNo)}</td>
                    <td>{String(p.method ?? '-')}</td>
                    <td className="cell-num">{fmtMoney(p.amount)}</td>
                    <td>{fmtDate(p.receiptDate)}</td>
                    <td>{String(p.reference ?? '-')}</td>
                    <td><Badge value={p.status} /></td>
                  </tr>
                ))}
                {payments.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No payments yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tab === 'deliveries' && (
        <section className="card">
          <div className="card-head"><h3>Deliveries</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Delivery note</th><th>Status</th><th>Dispatched</th><th>Delivered</th></tr></thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={String(d.id)} className="row-click" onClick={() => navigate(`/sales/delivery_notes/${d.id}`)}>
                    <td className="cell-mono">{String(d.deliveryNo)}</td>
                    <td><Badge value={d.status} /></td>
                    <td>{d.dispatchDate ? fmtDate(d.dispatchDate) : '-'}</td>
                    <td>{d.deliveredAt ? fmtDate(d.deliveredAt) : '-'}</td>
                  </tr>
                ))}
                {deliveries.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No deliveries yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function DocumentList({ resource }: { resource: string }) {
  const { user } = useAuth();
  const meta = RESOURCES.find((r) => r.resource === resource) ?? RESOURCES[1];
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (q.trim()) params.set('q', q.trim());
    const ops = ['quotations', 'orders', 'invoices', 'receipts'].includes(resource);
    const r = await api<ListResult & { data: Rec[] | { rows: Rec[] } }>(
      ops ? `/api/ops/sales/${resource}?${params.toString()}` : `/api/sales/${resource}?${params.toString()}`
    );
    const rows = Array.isArray(r.data) ? r.data : (r.data as { rows: Rec[] }).rows ?? [];
    setRows(rows);
    setTotal(r.pagination?.total ?? rows.length);
  }, [page, q, resource]);

  useEffect(() => {
    setBusy(true);
    load()
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setBusy(false));
  }, [load]);

  const canCreateQuote = can(user, 'sales.quotations.create');
  const canCreateOrder = can(user, 'sales.orders.create');
  const canCreateInvoice = can(user, 'sales.invoices.create');
  const showNew =
    (resource === 'quotations' && canCreateQuote) ||
    (resource === 'orders' && canCreateOrder) ||
    (resource === 'invoices' && canCreateInvoice);

  const cols = listColumns(resource);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>{meta.label}</h1>
          <p className="muted">Quote, commit, allocate, ship, invoice, collect.</p>
        </div>
        <div className="head-actions">
          {canCreateQuote && resource !== 'quotations' && (
            <button className="btn" onClick={() => navigate('/sales/quotations/new')}>New quotation</button>
          )}
          {showNew && (
            <button className="btn btn-primary" onClick={() => navigate(`/sales/${resource}/new`)}>
              + New {meta.label.replace(/s$/, '')}
            </button>
          )}
        </div>
      </header>
      <ResourceTabs resource={resource} />
      <div className="toolbar">
        <input className="search-input" placeholder="Search document number…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      </div>
      {error && <ErrorBanner error={error} />}
      {busy ? <PageLoader label="Loading documents…" /> : (
        <>
        <div className="record-cards mobile-only">
          {rows.map((row) => {
            const id = num(pick(row, 'id'));
            const code = String(pick(row, ...cols[0].keys) ?? id);
            return (
              <button key={id} className="record-card" onClick={() => navigate(`/sales/${resource}/${id}`)}>
                <div className="record-card-top">
                  <strong className="cell-mono">{code}</strong>
                  <Badge value={pick(row, 'status')} />
                </div>
                <div className="muted">{fmtDate(pick(row, 'orderDate', 'order_date', 'quotationDate', 'quotation_date', 'invoiceDate', 'invoice_date', 'createdAt', 'created_at'))}</div>
                <span className="btn btn-sm">View</span>
              </button>
            );
          })}
        </div>
        <div className="table-wrap card desktop-only">
          <table className="data">
            <thead>
              <tr>
                {cols.map((c) => <th key={c.key}>{c.label}</th>)}
                <th style={{ textAlign: 'right' }}>Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = num(pick(row, 'id'));
                return (
                  <tr key={id} className="row-click" onClick={() => navigate(`/sales/${resource}/${id}`)}>
                    {cols.map((c) => (
                      <td key={c.key} className={c.num ? 'cell-num' : undefined}>
                        {c.badge ? <Badge value={pick(row, ...c.keys)} /> : c.money ? fmtMoney(pick(row, ...c.keys)) : c.date ? fmtDate(pick(row, ...c.keys)) : String(pick(row, ...c.keys) ?? '-')}
                      </td>
                    ))}
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/sales/${resource}/${id}`); }}>View</button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={cols.length + 1} style={{ textAlign: 'center', color: 'var(--muted)', padding: 28 }}>No documents yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
        </>
      )}
      <div className="pager">
        <span>{fmtNum(total)} records</span>
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
        <button className="btn btn-sm" disabled={page * 25 >= total} onClick={() => setPage((p) => p + 1)}>Next ›</button>
      </div>
    </div>
  );
}

function listColumns(resource: string): { key: string; label: string; keys: string[]; badge?: boolean; money?: boolean; date?: boolean; num?: boolean }[] {
  const code = {
    quotations: ['quotationNo', 'quotation_no'],
    orders: ['orderNo', 'order_no'],
    delivery_notes: ['deliveryNo', 'delivery_no'],
    invoices: ['invoiceNo', 'invoice_no'],
    receipts: ['receiptNo', 'receipt_no'],
    credit_notes: ['creditNo', 'credit_no'],
    debit_notes: ['debitNo', 'debit_no'],
    returns: ['returnNo', 'return_no'],
  }[resource] ?? ['id'];
  const dateKey = {
    quotations: ['quotationDate', 'quotation_date'],
    orders: ['orderDate', 'order_date'],
    delivery_notes: ['dispatchDate', 'dispatch_date'],
    invoices: ['invoiceDate', 'invoice_date'],
    receipts: ['receiptDate', 'receipt_date'],
    credit_notes: ['creditDate', 'credit_date'],
    debit_notes: ['debitDate', 'debit_date'],
    returns: ['returnDate', 'return_date'],
  }[resource] ?? ['createdAt', 'created_at'];
  const cols: { key: string; label: string; keys: string[]; badge?: boolean; money?: boolean; date?: boolean; num?: boolean }[] = [
    { key: 'code', label: 'Number', keys: code },
    { key: 'status', label: 'Status', keys: ['status'], badge: true },
    { key: 'date', label: 'Date', keys: dateKey, date: true },
  ];
  if (['quotations', 'orders', 'invoices', 'receipts', 'credit_notes', 'debit_notes'].includes(resource)) {
    cols.push({ key: 'total', label: 'Amount', keys: resource === 'receipts' || resource === 'credit_notes' || resource === 'debit_notes' ? ['amount'] : ['total'], money: true, num: true });
  }
  cols.push({ key: 'customer', label: 'Customer', keys: ['customerName', 'customer_name', 'customerId', 'customer_id'] });
  return cols;
}

interface DraftLine {
  key: string;
  productId: number | '';
  productLabel: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  taxPercent: number;
}

function emptyLine(): DraftLine {
  return { key: `${Date.now()}-${Math.random()}`, productId: '', productLabel: '', quantity: 1, unitPrice: 0, discountPercent: 0, taxPercent: 18 };
}

function Composer({ resource }: { resource: string }) {
  const isQuote = resource === 'quotations';
  const isInvoice = resource === 'invoices';
  const title = isQuote ? 'New quotation' : isInvoice ? 'New invoice' : 'New sales order';
  const [customerId, setCustomerId] = useState<number | ''>('');
  const [customerLabel, setCustomerLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [customerPoNo, setCustomerPoNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [discountType, setDiscountType] = useState<'PERCENT' | 'AMOUNT'>('PERCENT');
  const [discountValue, setDiscountValue] = useState(0);
  const [bankName, setBankName] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const q = useHashQuery();
  useEffect(() => {
    const cid = Number(q.get('customer'));
    const label = q.get('customerLabel');
    if (cid > 0) {
      setCustomerId(cid);
      if (label) setCustomerLabel(label);
      else
        api<{ data: Rec[] }>('/api/ops/sales/customers/directory')
          .then((r) => {
            const found = (r.data ?? []).find((row) => num(row.id) === cid);
            if (found) setCustomerLabel(`${String(found.code)} - ${String(found.name)}`);
          })
          .catch(() => undefined);
    }
  }, [q]);

  const subtotal = useMemo(
    () => lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0),
    [lines]
  );
  const discountAmount = useMemo(() => {
    if (discountType === 'AMOUNT') return Math.min(discountValue, subtotal);
    return (subtotal * discountValue) / 100;
  }, [discountType, discountValue, subtotal]);
  const total = useMemo(() => {
    const gross = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const lineDiscount = lines.reduce((s, l) => s + l.quantity * l.unitPrice * (l.discountPercent / 100), 0);
    const vat = lines.reduce((s, l) => {
      const base = l.quantity * l.unitPrice;
      const headerShare = gross > 0 ? discountAmount * (base / gross) : 0;
      const netBase = Math.max(0, base - base * (l.discountPercent / 100) - headerShare);
      return s + netBase * (l.taxPercent / 100);
    }, 0);
    return Math.round((Math.max(0, gross - lineDiscount - discountAmount) + vat) * 100) / 100;
  }, [lines, discountAmount]);

  const setLine = (key: string, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const submit = async () => {
    setError('');
    if (!customerId) { setError('Select a customer'); return; }
    const items = lines
      .filter((l) => l.productId && l.quantity > 0)
      .map((l) => ({
        productId: Number(l.productId),
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountPercent: l.discountPercent,
        taxPercent: l.taxPercent,
      }));
    if (!items.length) { setError('Add at least one product line'); return; }
    setBusy(true);
    try {
      if (isQuote) {
        const r = await api<{ data: { quotationId: number } }>('/api/ops/sales/quotations', {
          method: 'POST',
          body: JSON.stringify({ customerId, notes: notes || null, items }),
        });
        navigate(`/sales/quotations/${r.data.quotationId}`);
      } else if (isInvoice) {
        const r = await api<{ data: { invoiceId: number } }>('/api/ops/sales/invoices', {
          method: 'POST',
          body: JSON.stringify({
            customerId,
            notes: notes || null,
            items,
            invoiceDate: invoiceDate || null,
            dueDate: dueDate || null,
            bankName: bankName || null,
            bankAccountName: bankAccountName || null,
            bankAccountNumber: bankAccountNumber || null,
            discountType,
            discountValue,
          }),
        });
        navigate(`/sales/invoices/${r.data.invoiceId}`);
      } else {
        const r = await api<{ data: { orderId: number } }>('/api/ops/sales/orders', {
          method: 'POST',
          body: JSON.stringify({
            customerId,
            notes: notes || null,
            customerPoNo: customerPoNo || null,
            items,
            bankName: bankName || null,
            bankAccountName: bankAccountName || null,
            bankAccountNumber: bankAccountNumber || null,
            discountType,
            discountValue,
          }),
        });
        navigate(`/sales/orders/${r.data.orderId}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (resource !== 'quotations' && resource !== 'orders' && resource !== 'invoices') {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <button className="btn btn-sm" onClick={() => navigate(`/sales/${resource}`)}>Back</button>
            <h1>Create from an order</h1>
            <p className="muted">Delivery notes and receipts are created from a sales order — they are not typed in as standalone records.</p>
          </div>
        </header>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate(`/sales/${resource}`)}>Back</button>
          <h1>{title}</h1>
          <p className="muted">{isInvoice ? 'Lines are priced and numbered by the sales service. Invoices go through the approval workflow.' : 'Lines are priced and numbered by the sales service. Status stays DRAFT until you submit.'}</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate(`/sales/${resource}`)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Save draft'}</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <LookupField
            label="Customer"
            required
            endpoint="/api/ops/sales/customers"
            display={(r) => `${pick(r, 'code') ?? ''} · ${pick(r, 'name') ?? ''}`}
            valueLabel={customerLabel}
            onPick={(r) => { setCustomerId(num(r.id)); setCustomerLabel(`${pick(r, 'code') ?? ''} · ${pick(r, 'name') ?? ''}`); }}
          />
          {!isQuote && !isInvoice && (
            <div className="field">
              <label>Customer PO</label>
              <input value={customerPoNo} onChange={(e) => setCustomerPoNo(e.target.value)} />
            </div>
          )}
          {isInvoice && (
            <>
              <div className="field">
                <label>Invoice date</label>
                <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
              </div>
              <div className="field">
                <label>Due date</label>
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
            </>
          )}
          {!isQuote && (
            <>
              <div className="field">
                <label>Bank name</label>
                <input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Company default if blank" />
              </div>
              <div className="field">
                <label>Bank account name</label>
                <input value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} placeholder="Company default if blank" />
              </div>
              <div className="field">
                <label>Bank account number</label>
                <input value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} placeholder="Company default if blank" />
              </div>
            </>
          )}
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Lines</h3>
          <button className="btn btn-sm" onClick={() => setLines((p) => [...p, emptyLine()])}>+ Line</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th className="cell-num">Qty</th>
                <th className="cell-num">Unit price</th>
                {!isInvoice && <th className="cell-num">Disc %</th>}
                <th className="cell-num">Tax %</th>
                <th className="cell-num">Line</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <LookupField
                      compact
                      endpoint="/api/ops/sales/products"
                      display={(r) => `${pick(r, 'code') ?? ''} · ${pick(r, 'name') ?? ''}`}
                      valueLabel={l.productLabel}
                      onPick={(r) => setLine(l.key, {
                        productId: num(r.id),
                        productLabel: `${pick(r, 'code') ?? ''} · ${pick(r, 'name') ?? ''}`,
                        unitPrice: num(pick(r, 'standardPrice', 'standard_price'), l.unitPrice),
                      })}
                    />
                  </td>
                  <td><input className="cell-input" type="number" min={0} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: num(e.target.value) })} /></td>
                  <td><input className="cell-input" type="number" min={0} value={l.unitPrice} onChange={(e) => setLine(l.key, { unitPrice: num(e.target.value) })} /></td>
                  {!isInvoice && (
                    <td><input className="cell-input" type="number" min={0} value={l.discountPercent} onChange={(e) => setLine(l.key, { discountPercent: num(e.target.value) })} /></td>
                  )}
                  <td><input className="cell-input" type="number" min={0} value={l.taxPercent} onChange={(e) => setLine(l.key, { taxPercent: num(e.target.value) })} /></td>
                  <td className="cell-num">{fmtMoney(lineTotal(l.quantity, l.unitPrice, isInvoice ? 0 : l.discountPercent, l.taxPercent))}</td>
                  <td><button className="btn btn-sm" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key) )}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!isQuote && (
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', gap: 12, padding: '12px 16px 0', flexWrap: 'wrap' }}>
            <div className="field" style={{ width: 150, marginBottom: 0 }}>
              <label>Discount type</label>
              <select value={discountType} onChange={(e) => setDiscountType(e.target.value as 'PERCENT' | 'AMOUNT')}>
                <option value="PERCENT">Percentage (%)</option>
                <option value="AMOUNT">Amount</option>
              </select>
            </div>
            <div className="field" style={{ width: 160, marginBottom: 0 }}>
              <label>{discountType === 'PERCENT' ? 'Discount %' : 'Discount amount'}</label>
              <input type="number" min={0} value={discountValue} onChange={(e) => setDiscountValue(num(e.target.value))} />
            </div>
          </div>
        )}
        <div className="otc-total">
          Total {fmtMoney(total)}
          {discountAmount > 0 && <span className="muted" style={{ display: 'block', fontSize: 12, fontWeight: 400 }}>incl. {fmtMoney(discountAmount)} discount</span>}
        </div>
      </section>
    </div>
  );
}

function LookupField({
  label,
  required,
  endpoint,
  display,
  valueLabel,
  onPick,
  compact,
}: {
  label?: string;
  required?: boolean;
  endpoint: string;
  display: (row: Rec) => string;
  valueLabel: string;
  onPick: (row: Rec) => void;
  compact?: boolean;
}) {
  const [q, setQ] = useState(valueLabel);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Rec[]>([]);

  useEffect(() => { setQ(valueLabel); }, [valueLabel]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const params = new URLSearchParams({ pageSize: '12' });
      if (q.trim() && q !== valueLabel) params.set('q', q.trim());
      api<ListResult>(`${endpoint}?${params.toString()}`)
        .then((r) => setRows(r.data))
        .catch(() => setRows([]));
    }, 180);
    return () => clearTimeout(t);
  }, [endpoint, open, q, valueLabel]);

  const body = (
    <div className="lookup">
      <input
        value={q}
        placeholder="Search…"
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 180)}
      />
      {open && (
        <div className="lookup-menu">
          {rows.map((r) => (
            <button
              key={String(r.id)}
              type="button"
              className="lookup-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(r); setOpen(false); }}
            >
              {display(r)}
            </button>
          ))}
          {rows.length === 0 && <div className="search-hint">No matches</div>}
        </div>
      )}
    </div>
  );
  if (compact) return body;
  return (
    <div className={`field ${required ? 'field-required' : ''}`}>
      {label && <label>{label}</label>}
      {body}
    </div>
  );
}

function Pipeline({ steps, status }: { steps: string[]; status: string }) {
  const idx = Math.max(0, steps.indexOf(status === 'PARTIALLY_DISPATCHED' ? 'DISPATCHED' : status));
  const known = steps.includes(status) || status === 'PARTIALLY_DISPATCHED';
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

function Related({ label, rows, resource, codeKeys }: { label: string; rows: Rec[]; resource: string; codeKeys: string[] }) {
  if (!rows.length) return null;
  return (
    <section className="card">
      <div className="card-head"><h3>{label}</h3></div>
      <div className="related-list">
        {rows.map((r) => (
          <button key={String(r.id)} className="related-item" onClick={() => navigate(`/sales/${resource}/${r.id}`)}>
            <span className="cell-mono">{String(pick(r, ...codeKeys) ?? r.id)}</span>
            <Badge value={pick(r, 'status')} />
            {pick(r, 'total', 'amount') != null && <span className="muted">{fmtMoney(pick(r, 'total', 'amount'))}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

function DocumentDetail({ resource, id }: { resource: string; id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [items, setItems] = useState<Rec[]>([]);
  const [related, setRelated] = useState<{ orders?: Rec[]; deliveries?: Rec[]; invoices?: Rec[]; receipts?: Rec[] }>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [dispatchQty, setDispatchQty] = useState<Record<number, number>>({});
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('CASH');
  const [payRef, setPayRef] = useState('');

  const load = useCallback(async () => {
    if (resource === 'quotations') {
      const r = await api<{ data: { quotation: Rec; items: Rec[]; orders: Rec[] } }>(`/api/ops/sales/quotations/${id}`);
      setDoc(r.data.quotation);
      setItems(r.data.items);
      setRelated({ orders: r.data.orders });
    } else if (resource === 'orders') {
      const r = await api<{ data: { order: Rec; items: Rec[]; deliveries: Rec[]; invoices: Rec[] } }>(`/api/ops/sales/orders/${id}`);
      setDoc(r.data.order);
      setItems(r.data.items);
      setRelated({ deliveries: r.data.deliveries, invoices: r.data.invoices });
    } else if (resource === 'delivery_notes') {
      const r = await api<{ data: { deliveryNote: Rec; items: Rec[]; invoices?: Rec[] } }>(`/api/ops/sales/delivery-notes/${id}`);
      setDoc(r.data.deliveryNote);
      setItems(r.data.items);
      setRelated({ invoices: r.data.invoices ?? [] });
    } else if (resource === 'invoices') {
      const r = await api<{ data: { invoice: Rec; items: Rec[]; receipts: Rec[] } }>(`/api/ops/sales/invoices/${id}`);
      setDoc(r.data.invoice);
      setItems(r.data.items);
      setRelated({ receipts: r.data.receipts });
      const remaining = num(r.data.invoice.total) - num(r.data.invoice.amountPaid ?? r.data.invoice.amount_paid);
      setPayAmount(String(remaining));
    } else if (resource === 'receipts') {
      const r = await api<{ data: { receipt: Rec; allocations: Rec[] } }>(`/api/ops/sales/receipts/${id}`);
      setDoc(r.data.receipt);
      setItems(r.data.allocations ?? []);
      setRelated({ invoices: (r.data.allocations ?? []).map((a) => ({ id: a.invoiceId ?? a.invoice_id, invoiceNo: a.invoiceNo ?? a.invoice_no, status: a.invoiceStatus ?? a.invoice_status, total: a.amount })) });
    } else if (resource === 'credit_notes') {
      const r = await api<{ data: { creditNote: Rec } }>(`/api/ops/sales/credit-notes/${id}`);
      setDoc(r.data.creditNote);
      setItems([]);
    } else if (resource === 'debit_notes') {
      const r = await api<{ data: { debitNote: Rec } }>(`/api/ops/sales/debit-notes/${id}`);
      setDoc(r.data.debitNote);
      setItems([]);
    } else if (resource === 'returns') {
      const r = await api<{ data: { salesReturn: Rec; items: Rec[] } }>(`/api/ops/sales/returns/${id}`);
      setDoc(r.data.salesReturn);
      setItems(r.data.items ?? []);
    } else {
      const r = await api<{ data: Rec }>(`/api/sales/${resource}/${id}`);
      setDoc(r.data);
      setItems([]);
    }
  }, [id, resource]);

  useEffect(() => {
    setError('');
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load document'));
  }, [load]);

  const act = async (label: string, fn: () => Promise<void | string>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const custom = await fn();
      setNotice(custom || label);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Loading document…" />;

  const status = String(pick(doc, 'status') ?? '');
  const code = String((
    resource === 'quotations' ? pick(doc, 'quotationNo', 'quotation_no')
    : resource === 'orders' ? pick(doc, 'orderNo', 'order_no')
    : resource === 'delivery_notes' ? pick(doc, 'deliveryNo', 'delivery_no')
    : resource === 'invoices' ? pick(doc, 'invoiceNo', 'invoice_no')
    : resource === 'receipts' ? pick(doc, 'receiptNo', 'receipt_no')
    : resource === 'credit_notes' ? pick(doc, 'creditNo', 'credit_no')
    : resource === 'debit_notes' ? pick(doc, 'debitNo', 'debit_no')
    : pick(doc, 'returnNo', 'return_no')
  ) ?? id);
  const customerName = String(pick(doc, 'customerName', 'customer_name') ?? pick(doc, 'customerId', 'customer_id') ?? '');
  const customerEmail = String(pick(doc, 'customerEmail', 'customer_email') ?? '').trim();
  const customerPhone = String(pick(doc, 'customerPhone', 'customer_phone') ?? '').trim();
  const docType =
    resource === 'quotations' ? 'sales-quotation'
    : resource === 'orders' ? 'sales-order'
    : resource === 'delivery_notes' ? 'delivery-note'
    : resource === 'invoices' ? 'sales-invoice'
    : resource === 'receipts' ? 'receipt'
    : resource === 'credit_notes' ? 'credit-note'
    : resource === 'debit_notes' ? 'debit-note'
    : resource === 'returns' ? 'sales-return'
    : null;

  const quoteActions = resource === 'quotations' && (
    <>
      {status === 'DRAFT' && can(user, 'sales.quotations.submit') && (
        <button className="btn btn-primary btn-block" disabled={busy} onClick={() => act('Quotation submitted', async () => {
          await api(`/api/ops/sales/quotations/${id}/submit`, { method: 'POST', body: '{}' });
        })}>Submit for approval</button>
      )}
      {status === 'APPROVED' && can(user, 'sales.quotations.convert') && (
        <button className="btn btn-success btn-block" disabled={busy} onClick={() => act('Converted to sales order', async () => {
          const r = await api<{ data: { orderId: number } }>(`/api/ops/sales/quotations/${id}/convert`, { method: 'POST', body: '{}' });
          navigate(`/sales/orders/${r.data.orderId}`);
        })}>Convert to sales order</button>
      )}
      {['DRAFT', 'SUBMITTED', 'APPROVED'].includes(status) && can(user, 'sales.quotations.send') && (
        <button className="btn btn-block" disabled={busy} onClick={() => act('Quotation sent to customer', async () => {
          const r = await api<{ data: { sent: string[]; email?: { ok: boolean; error?: string }; sms?: { ok: boolean; error?: string } } }>(
            `/api/ops/sales/quotations/${id}/send`,
            { method: 'POST', body: '{}' }
          );
          const bits = [
            r.data.email?.ok ? 'email delivered' : r.data.email?.error ? `email: ${r.data.email.error}` : null,
            r.data.sms?.ok ? 'SMS delivered' : r.data.sms?.error ? `SMS: ${r.data.sms.error}` : null,
          ].filter(Boolean);
          return bits.length ? `Quotation sent to customer · ${bits.join(' · ')}` : undefined;
        })}>Send to customer</button>
      )}
    </>
  );

  const orderActions = resource === 'orders' && (
    <>
      {status === 'DRAFT' && can(user, 'sales.orders.submit') && (
        <button className="btn btn-primary btn-block" disabled={busy} onClick={() => act('Order submitted', async () => {
          await api(`/api/ops/sales/orders/${id}/submit`, { method: 'POST', body: '{}' });
        })}>Submit for approval</button>
      )}
      {['APPROVED', 'ALLOCATED'].includes(status) && can(user, 'sales.orders.allocate') && (
        <button className="btn btn-block" disabled={busy} onClick={() => act('Stock allocated', async () => {
          await api(`/api/ops/sales/orders/${id}/allocate`, { method: 'POST', body: '{}' });
        })}>Allocate stock</button>
      )}
      {['APPROVED', 'ALLOCATED', 'PARTIALLY_DISPATCHED'].includes(status) && can(user, 'sales.orders.dispatch') && (
        <button className="btn btn-primary btn-block" disabled={busy} onClick={() => {
          const next: Record<number, number> = {};
          for (const item of items) {
            const rem = num(item.quantity) - num(item.dispatchedQty ?? item.dispatched_qty);
            next[num(item.id)] = rem > 0 ? rem : 0;
          }
          setDispatchQty(next);
          setDispatchOpen(true);
        }}>Dispatch</button>
      )}
      {['DISPATCHED', 'PARTIALLY_DISPATCHED'].includes(status) && can(user, 'sales.invoices.create') && (
        <button className="btn btn-success btn-block" disabled={busy} onClick={() => act('Invoice created', async () => {
          const r = await api<{ data: { invoiceId: number } }>('/api/ops/sales/invoices', {
            method: 'POST',
            body: JSON.stringify({ orderId: id }),
          });
          navigate(`/sales/invoices/${r.data.invoiceId}`);
        })}>Create invoice</button>
      )}
    </>
  );

  const dnActions = resource === 'delivery_notes' && ['DISPATCHED', 'IN_TRANSIT'].includes(status) && can(user, 'sales.delivery_notes.deliver') && (
    <button className="btn btn-success btn-block" disabled={busy} onClick={() => setDeliverOpen(true)}>Mark delivered</button>
  );

  const invActions = resource === 'invoices' && can(user, 'sales.receipts.create') && !['VOID', 'PAID'].includes(status) && (
    <button className="btn btn-success btn-block" disabled={busy} onClick={() => setPayOpen(true)}>Record payment</button>
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate(`/sales/${resource}`)}>Back</button>
          <h1>
            {RESOURCES.find((r) => r.resource === resource)?.label ?? resource} <span className="cell-mono">{code}</span>
          </h1>
          <p className="muted">
            {customerName} · {fmtMoney(pick(doc, 'total', 'amount'))}
            {(customerEmail || customerPhone) ? ` · ${[customerEmail, customerPhone].filter(Boolean).join(' · ')}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {docType && <DownloadMenu type={docType} id={id} code={code} />}
          {resource === 'delivery_notes' && (
            <>
              <button className="btn btn-sm" onClick={() => openDocument('packing-list', id, 'print', code + '.pdf').catch((e) => window.alert(e instanceof Error ? e.message : String(e)))}>Packing list</button>
              <button className="btn btn-sm" onClick={() => openDocument('proof-of-delivery', id, 'print', code + '.pdf').catch((e) => window.alert(e instanceof Error ? e.message : String(e)))}>POD</button>
            </>
          )}
          <Badge value={status} />
        </div>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      {(resource === 'quotations' || resource === 'orders') && (
        <Pipeline steps={resource === 'quotations' ? QUOTE_STEPS : ORDER_STEPS} status={status} />
      )}

      <div className="detail-grid">
        <div>
          <section className="card">
            <div className="card-head"><h3>{resource === 'receipts' ? 'Allocations' : 'Lines'}</h3></div>
            {items.length === 0 ? (
              <p className="muted" style={{ padding: 16 }}>{resource === 'receipts' ? 'No invoices allocated — this is an unallocated customer credit.' : 'No line items on this document.'}</p>
            ) : resource === 'receipts' ? (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Status</th>
                      <th className="cell-num">Allocated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={String(item.id ?? item.invoiceId ?? item.invoice_id)}>
                        <td className="cell-mono">{String(pick(item, 'invoiceNo', 'invoice_no') ?? '')}</td>
                        <td><Badge value={pick(item, 'invoiceStatus', 'invoice_status')} /></td>
                        <td className="cell-num">{fmtMoney(pick(item, 'amount'))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="cell-num">Qty</th>
                      {resource === 'orders' && <th className="cell-num">Allocated</th>}
                      {resource === 'orders' && <th className="cell-num">Dispatched</th>}
                      {resource === 'orders' && <th className="cell-num">Invoiced</th>}
                      <th className="cell-num">Price</th>
                      <th className="cell-num">Line</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={String(item.id)}>
                        <td>
                          <div className="cell-mono">{String(pick(item, 'productCode', 'product_code') ?? '')}</div>
                          <div>{String(pick(item, 'productName', 'product_name', 'description') ?? '')}</div>
                        </td>
                        <td className="cell-num">{fmtNum(pick(item, 'quantity'))}</td>
                        {resource === 'orders' && <td className="cell-num">{fmtNum(pick(item, 'allocatedQty', 'allocated_qty'))}</td>}
                        {resource === 'orders' && <td className="cell-num">{fmtNum(pick(item, 'dispatchedQty', 'dispatched_qty'))}</td>}
                        {resource === 'orders' && <td className="cell-num">{fmtNum(pick(item, 'invoicedQty', 'invoiced_qty'))}</td>}
                        <td className="cell-num">{fmtMoney(pick(item, 'unitPrice', 'unit_price'))}</td>
                        <td className="cell-num">{fmtMoney(pick(item, 'lineTotal', 'line_total'))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
        {(resource === 'orders' || resource === 'invoices') && (() => {
          const bankName = String(pick(doc, 'bankName', 'bank_name') ?? '');
          const bankAccountName = String(pick(doc, 'bankAccountName', 'bank_account_name') ?? '');
          const bankAccountNumber = String(pick(doc, 'bankAccountNumber', 'bank_account_number') ?? '');
          const discountType = String(pick(doc, 'discountType', 'discount_type') ?? '');
          const discountValue = num(pick(doc, 'discountValue', 'discount_value'));
          const discountAmount = num(pick(doc, 'discountAmount', 'discount_amount'));
          const rows: [string, unknown][] = [];
          if (bankName) rows.push(['Bank', bankName]);
          if (bankAccountName) rows.push(['Account name', bankAccountName]);
          if (bankAccountNumber) rows.push(['Account no.', bankAccountNumber]);
          if (discountValue > 0 || discountAmount > 0) {
            rows.push([
              'Discount',
              discountType === 'PERCENT' && discountValue > 0
                ? `${discountValue}% (${fmtMoney(discountAmount)})`
                : fmtMoney(discountAmount),
            ]);
          }
          if (!rows.length) return null;
          return (
            <section className="card" style={{ marginTop: 14 }}>
              <div className="card-head"><h3>Payment details</h3></div>
              <dl className="detail-list">
                {rows.map(([k, v]) => (
                  <div className="detail-row" key={k}>
                    <dt>{k}</dt>
                    <dd>{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })()}
        <div className="detail-side">
          <section className="card">
            <div className="card-head"><h3>Next step</h3></div>
            <div className="flow-actions">
              {quoteActions}
              {orderActions}
              {dnActions}
              {invActions}
              {status === 'SUBMITTED' && (
                <button className="btn btn-block" onClick={() => navigate('/approvals')}>Open approvals queue</button>
              )}
              {!quoteActions && !orderActions && !dnActions && !invActions && status !== 'SUBMITTED' && (
                <p className="muted">No actions available in this status for your role.</p>
              )}
            </div>
          </section>
          <Related label="Sales orders" rows={related.orders ?? []} resource="orders" codeKeys={['orderNo', 'order_no']} />
          <Related label="Deliveries" rows={related.deliveries ?? []} resource="delivery_notes" codeKeys={['deliveryNo', 'delivery_no']} />
          <Related label="Invoices" rows={related.invoices ?? []} resource="invoices" codeKeys={['invoiceNo', 'invoice_no']} />
          <Related label="Receipts" rows={related.receipts ?? []} resource="receipts" codeKeys={['receiptNo', 'receipt_no']} />
          {Boolean(pick(doc, 'quotationId', 'quotation_id')) && resource === 'orders' && (
            <section className="card">
              <div className="card-head"><h3>Source quotation</h3></div>
              <div className="related-list">
                <button className="related-item" onClick={() => navigate(`/sales/quotations/${pick(doc, 'quotationId', 'quotation_id')}`)}>
                  <span className="cell-mono">{String(pick(doc, 'quotationNo', 'quotation_no') ?? pick(doc, 'quotationId'))}</span>
                </button>
              </div>
            </section>
          )}
          {Boolean(pick(doc, 'orderId', 'order_id')) && resource !== 'orders' && (
            <section className="card">
              <div className="card-head"><h3>Source order</h3></div>
              <div className="related-list">
                <button className="related-item" onClick={() => navigate(`/sales/orders/${pick(doc, 'orderId', 'order_id')}`)}>
                  <span className="cell-mono">{String(pick(doc, 'orderNo', 'order_no') ?? pick(doc, 'orderId'))}</span>
                </button>
              </div>
            </section>
          )}
          {Boolean(pick(doc, 'invoiceId', 'invoice_id')) && resource !== 'invoices' && (
            <section className="card">
              <div className="card-head"><h3>Source invoice</h3></div>
              <div className="related-list">
                <button className="related-item" onClick={() => navigate(`/sales/invoices/${pick(doc, 'invoiceId', 'invoice_id')}`)}>
                  <span className="cell-mono">{String(pick(doc, 'invoiceNo', 'invoice_no') ?? pick(doc, 'invoiceId'))}</span>
                </button>
              </div>
            </section>
          )}
        </div>
      </div>

      {dispatchOpen && (
        <Modal title="Dispatch sales order" onClose={() => setDispatchOpen(false)} wide>
          <p className="muted">Creates a delivery note and posts a warehouse issue for the quantities below.</p>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="cell-num">Remaining</th>
                  <th className="cell-num">This dispatch</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const rem = num(item.quantity) - num(item.dispatchedQty ?? item.dispatched_qty);
                  return (
                    <tr key={String(item.id)}>
                      <td>{String(pick(item, 'productName', 'product_name', 'description'))}</td>
                      <td className="cell-num">{fmtNum(rem)}</td>
                      <td>
                        <input
                          className="cell-input"
                          type="number"
                          min={0}
                          max={rem}
                          value={dispatchQty[num(item.id)] ?? 0}
                          onChange={(e) => setDispatchQty((p) => ({ ...p, [num(item.id)]: num(e.target.value) }))}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div className="field"><label>Recipient name</label><input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} /></div>
            <div className="field"><label>Recipient phone</label><input value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} /></div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button className="btn" onClick={() => setDispatchOpen(false)}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => act('Dispatched', async () => {
                const payloadItems = items
                  .map((item) => ({ orderItemId: num(item.id), quantity: dispatchQty[num(item.id)] ?? 0 }))
                  .filter((i) => i.quantity > 0);
                if (!payloadItems.length) throw new Error('Enter a dispatch quantity');
                const r = await api<{ data: { deliveryNoteId: number } }>(`/api/ops/sales/orders/${id}/dispatch`, {
                  method: 'POST',
                  body: JSON.stringify({
                    items: payloadItems,
                    recipientName: recipientName || null,
                    recipientPhone: recipientPhone || null,
                  }),
                });
                setDispatchOpen(false);
                navigate(`/sales/delivery_notes/${r.data.deliveryNoteId}`);
              })}
            >
              Dispatch
            </button>
          </div>
        </Modal>
      )}

      {deliverOpen && (
        <Modal title="Confirm delivery" onClose={() => setDeliverOpen(false)}>
          <div className="field">
            <label>Received by</label>
            <input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button className="btn" onClick={() => setDeliverOpen(false)}>Cancel</button>
            <button
              className="btn btn-success"
              disabled={busy}
              onClick={() => act('Marked delivered', async () => {
                await api(`/api/ops/sales/delivery-notes/${id}/deliver`, {
                  method: 'POST',
                  body: JSON.stringify({ receivedBy: receivedBy || null }),
                });
                setDeliverOpen(false);
              })}
            >
              Confirm
            </button>
          </div>
        </Modal>
      )}

      {payOpen && (
        <Modal title="Record payment" onClose={() => setPayOpen(false)}>
          <div className="form-grid">
            <div className="field field-required">
              <label>Amount</label>
              <input type="number" min={0} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
            </div>
            <div className="field">
              <label>Method</label>
              <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                <option value="CASH">Cash</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="MOBILE_MONEY">Mobile money</option>
                <option value="CHEQUE">Cheque</option>
                <option value="CARD">Card</option>
              </select>
            </div>
            <div className="field">
              <label>Reference</label>
              <input value={payRef} onChange={(e) => setPayRef(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button className="btn" onClick={() => setPayOpen(false)}>Cancel</button>
            <button
              className="btn btn-success"
              disabled={busy}
              onClick={() => act('Payment posted', async () => {
                const customerId = num(pick(doc, 'customerId', 'customer_id'));
                const r = await api<{ data: { receiptId: number } }>('/api/ops/sales/receipts', {
                  method: 'POST',
                  body: JSON.stringify({
                    invoiceId: id,
                    customerId,
                    amount: num(payAmount),
                    method: payMethod,
                    reference: payRef || null,
                    allocations: [{ invoiceId: id, amount: num(payAmount) }],
                  }),
                });
                setPayOpen(false);
                navigate(`/sales/receipts/${r.data.receiptId}`);
              })}
            >
              Post receipt
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
