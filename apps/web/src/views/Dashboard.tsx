import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, fmtDate, fmtMoney, fmtNum } from '../api';
import { PageLoader, ErrorBanner } from '../components/ui';
import { navigate } from '../router';
import { useAuth, can } from '../auth';
import { COMMANDS, greetingFor, personaLabel, personaOf, WORKSPACES } from '../work';
import { Meter } from '../components/os';

interface Exec {
  stockValue: number;
  stockLines: number;
  stockProducts: number;
  lowStockCount: number;
  accountsReceivable: number;
  arOverdue: number;
  accountsPayable: number;
  apOverdue: number;
  monthRevenue: number;
  monthInvoices: number;
  monthProduced: number;
  monthScrapped: number;
  monthWaste: number;
  monthYieldPct: number | null;
  workOrdersInProgress: number;
  workOrdersCompleted: number;
  workOrdersTotal: number;
  pendingApprovals: number;
  customers: number;
  products: number;
  openOrders: number;
  openQuotes: number;
  suppliers: number;
}

interface Exception {
  code: string;
  label: string;
  count: number;
  href: string;
  severity: string;
  persona: string;
}

interface WorkFeed {
  asOf?: string;
  stockValue: number;
  overdueArAmount: number;
  exceptionCount: number;
  exceptions: Exception[];
}

const NOW_ICONS: Record<string, string> = {
  inbox: '🗂️',
  quote: '🧾',
  order: '📦',
  'sales-board': '🧭',
  stock: '📦',
  xfer: '🔁',
  adj: '⚖️',
  scan: '📷',
  secure: '🔐',
  wo: '⚙️',
  customers: '🤝',
  'crm-board': '🧭',
  'crm-mine': '🎯',
  pipeline: '📈',
  reports: '📊',
  work: '✅',
  plant: '🏭',
  receive: '📥',
  pick: '🚚',
  fin: '💰',
  je: '🧮',
  op: '🎛️',
  'people-board': '🧑‍🤝‍🧑',
  payroll: '💸',
};

function tile(key: string, label: string, value: string, sub: string, icon: string, accent: string, action?: () => void) {
  return { key, label, value, sub, icon, accent, action };
}

export default function Dashboard() {
  const { user } = useAuth();
  const persona = personaOf(user);
  const [exec, setExec] = useState<Exec | null>(null);
  const [work, setWork] = useState<WorkFeed | null>(null);
  const [activity, setActivity] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ data: WorkFeed }>('/api/dashboard/work')
      .then((r) => setWork(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load work'));
    if (can(user, 'reports.executive.view')) {
      api<{ data: Exec }>('/api/dashboard/executive')
        .then((r) => setExec(r.data))
        .catch(() => undefined);
    }
    api<{ data: Record<string, unknown>[] }>('/api/dashboard/activity')
      .then((r) => setActivity(r.data ?? []))
      .catch(() => undefined);
  }, [user]);

  const nowActions = useMemo(
    () => COMMANDS.filter((c) => c.id !== 'home' && (!c.perm || can(user, c.perm))).slice(0, 6),
    [user]
  );

  const spaces = WORKSPACES.filter((w) => !w.perm || can(user, w.perm));

  if (error && !work) return <ErrorBanner error={error} />;
  if (!work) return <PageLoader label="Assembling your day…" />;

  const first = user?.first_name ?? 'there';
  const focused = work.exceptions.filter((e) => e.persona === persona || e.persona === 'all' || persona === 'executive');
  const approvalsWaiting = work.exceptions.find((e) => e.code === 'approvals')?.count ?? 0;

  const heroStats = [
    { label: 'Live exceptions', value: fmtNum(work.exceptionCount), cls: work.exceptionCount > 0 ? 'crit' : 'ok', href: '/inbox' },
    { label: 'Decisions', value: fmtNum(approvalsWaiting), cls: approvalsWaiting > 0 ? 'warn' : 'ok', href: '/inbox' },
    { label: 'Overdue AR', value: fmtMoney(work.overdueArAmount), cls: work.overdueArAmount > 0 ? 'warn' : 'ok', href: '/sales/invoices' },
  ];

  const cards = exec
    ? [
        tile('stock', 'Stock on books', fmtMoney(exec.stockValue), `${fmtNum(exec.stockProducts)} SKUs on hand`, '📦', '#00A6A6', () => navigate('/inventory/stock')),
        tile('orders', 'Open fulfilment', fmtNum(exec.openOrders), `${fmtNum(exec.openQuotes)} live quotations`, '🧾', '#1261A0', () => navigate('/sales/orders')),
        tile('revenue', 'Cash in', fmtMoney(exec.monthRevenue), `${fmtNum(exec.monthInvoices)} invoices this month`, '💵', '#168A5B', () => navigate('/sales/invoices')),
        tile('ar', 'Receivable risk', fmtMoney(exec.accountsReceivable), `${fmtNum(exec.arOverdue)} overdue`, '⏳', '#D99A00', () => navigate('/sales/invoices')),
        tile('plant', 'Plant load', fmtNum(exec.workOrdersInProgress), `${fmtNum(exec.workOrdersCompleted)} closed of ${fmtNum(exec.workOrdersTotal)}`, '⚙️', '#D97706', () => navigate('/records/production/work_orders')),
        tile('inbox', 'Decisions on your desk', fmtNum(exec.pendingApprovals), 'need a person', '🗂️', '#8B5CF6', () => navigate('/inbox')),
      ]
    : [
        tile('exceptions', 'Exceptions', fmtNum(work.exceptionCount), 'need a person', '⚠️', '#C93636', () => navigate('/inbox')),
        tile('inbox', 'Decisions on your desk', fmtNum(approvalsWaiting), 'approvals and returns', '🗂️', '#8B5CF6', () => navigate('/inbox')),
        tile('stock', 'Stock on books', fmtMoney(work.stockValue), 'current valuation', '📦', '#00A6A6', () => navigate('/inventory/stock')),
        tile('ar', 'Overdue AR', fmtMoney(work.overdueArAmount), 'collections risk', '⏳', '#D99A00', () => navigate('/sales/invoices')),
      ];

  return (
    <div className="page">
      <div className="work-hero">
        <div className="work-hero-main">
          <div className="eyebrow">{personaLabel(persona)}</div>
          <h1>{greetingFor()}, {first}.</h1>
          <p>
            {work.exceptionCount > 0
              ? `${work.exceptionCount} live exceptions. Start with the inbox — not the module tree.`
              : 'No operational exceptions. Use a workspace or the command bar to start work.'}
          </p>
          <div className="hero-stats">
            {heroStats.map((s) => (
              <button key={s.label} className={`hero-stat ${s.cls}`} onClick={() => navigate(s.href)}>
                <b>{s.value}</b>
                <span>{s.label}</span>
              </button>
            ))}
          </div>
          <div className="quick-actions" style={{ padding: '14px 0 0' }}>
            <button className="btn btn-primary" onClick={() => navigate('/inbox')}>Open inbox</button>
            {can(user, 'sales.quotations.create') && <button className="btn btn-ghost-on-navy" onClick={() => navigate('/sales/quotations/new')}>New quotation</button>}
            {can(user, 'inventory.stock.view') && <button className="btn btn-ghost-on-navy" onClick={() => navigate('/inventory/stock')}>Stock board</button>}
          </div>
          {work.asOf && <div className="muted" style={{ marginTop: 14, fontSize: 11 }}>Refreshed {fmtDate(work.asOf)}</div>}
        </div>
        <div className="exception-list">
          {focused.length === 0 && (
            <div className="card card-pad" style={{ margin: 0 }}>
              <strong>Clear floor</strong>
              <p className="muted">Nothing in your lane is on fire.</p>
            </div>
          )}
          {focused.slice(0, 5).map((ex) => (
            <button key={ex.code} className={`exception-item severity-${ex.severity}`} onClick={() => navigate(ex.href)}>
              <div>
                <strong>{ex.label}</strong>
                <div className="muted">{ex.severity}</div>
              </div>
              <span className="ex-count">{ex.count}</span>
            </button>
          ))}
        </div>
      </div>

      <h3 className="section-title">Do now</h3>
      <div className="do-now">
        {nowActions.map((a) => (
          <button key={a.id} onClick={() => navigate(a.href)}>
            <span className="now-ic">{NOW_ICONS[a.id] ?? '→'}</span>
            <span>
              <strong>{a.label}</strong>
              <span>{a.hint}</span>
            </span>
          </button>
        ))}
      </div>

      <h3 className="section-title">At a glance</h3>
      <div className="kpi-grid--tiles">
        {cards.map((c) => (
          <button
            key={c.key}
            className="kpi-tile"
            style={{ '--tile-accent': c.accent, '--tile-tint': `${c.accent}1F` } as CSSProperties}
            onClick={c.action}
            disabled={!c.action}
          >
            <span className="kpi-tile-icon">{c.icon}</span>
            <span className="kpi-tile-body">
              <span className="kpi-tile-label">{c.label}</span>
              <span className="kpi-tile-value">{c.value}</span>
              <span className="kpi-tile-sub">{c.sub}</span>
            </span>
          </button>
        ))}
      </div>

      {exec && (
        <section className="card card-pad">
          <h3 style={{ marginTop: 0 }}>Today's operations</h3>
          <Meter label="Production" value={exec.workOrdersTotal ? (exec.workOrdersCompleted / exec.workOrdersTotal) * 100 : 0} />
          <Meter label="Warehouse cover" value={exec.lowStockCount ? Math.max(20, 100 - exec.lowStockCount * 8) : 91} />
          <Meter label="Sales fulfilment" value={exec.openOrders ? Math.min(95, 40 + exec.openOrders * 4) : 73} />
          <p className="muted" style={{ margin: '10px 0 0', fontSize: 12 }}>
            {fmtNum(exec.monthProduced)} units produced · {fmtNum(exec.monthWaste)} waste · {fmtNum(exec.monthScrapped)} scrapped
            {exec.monthYieldPct != null ? ` · ${exec.monthYieldPct}% yield this month` : ''}
          </p>
        </section>
      )}

      {activity.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>What happened</h3></div>
          <div className="timeline" style={{ padding: 16 }}>
            {activity.slice(0, 8).map((ev) => (
              <div key={String(ev.id)} className="timeline-item">
                <div className="timeline-title">{String(ev.event_type ?? ev.eventType).replace(/_/g, ' ')}</div>
                <div className="timeline-meta">
                  {String(ev.entity_code ?? ev.entityCode ?? '')}
                  {ev.entity_code || ev.entityCode ? ' · ' : ''}
                  {String(ev.first_name ?? ev.firstName ?? 'System')}
                  {ev.created_at ? ` · ${fmtDate(ev.created_at)}` : ''}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head"><h3>Your workspaces</h3></div>
        <div className="quick-actions">
          {spaces.map((s) => (
            <button key={s.id} className="btn" onClick={() => navigate(s.href)}>{s.label}</button>
          ))}
          <button className="btn" onClick={() => navigate('/reports')}>Analytics</button>
        </div>
      </section>
    </div>
  );
}
