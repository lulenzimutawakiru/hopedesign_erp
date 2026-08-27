import { useEffect, useMemo, useState } from 'react';
import { api, fmtMoney, fmtNum } from '../api';
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
  stockValue: number;
  overdueArAmount: number;
  exceptionCount: number;
  exceptions: Exception[];
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

  const cards = exec
    ? [
        { label: 'Stock on books', value: fmtMoney(exec.stockValue), sub: `${fmtNum(exec.stockProducts)} SKUs`, action: () => navigate('/inventory/stock') },
        { label: 'Open fulfilment', value: fmtNum(exec.openOrders), sub: `${fmtNum(exec.openQuotes)} live quotations`, action: () => navigate('/sales/orders') },
        { label: 'Cash in', value: fmtMoney(exec.monthRevenue), sub: `${fmtNum(exec.monthInvoices)} invoices this month` },
        { label: 'Receivable risk', value: fmtMoney(exec.accountsReceivable), sub: `${fmtNum(exec.arOverdue)} overdue`, cls: exec.arOverdue ? 'card-warn' : '', action: () => navigate('/sales/invoices') },
        { label: 'Plant load', value: fmtNum(exec.workOrdersInProgress), sub: `${fmtNum(exec.workOrdersCompleted)} closed of ${fmtNum(exec.workOrdersTotal)}`, action: () => navigate('/records/production/work_orders') },
        { label: 'Inbox', value: fmtNum(exec.pendingApprovals), sub: 'decisions on your desk', cls: exec.pendingApprovals ? 'card-accent' : '', action: () => navigate('/inbox') },
      ]
    : [
        { label: 'Exceptions', value: fmtNum(work.exceptionCount), sub: 'need a person', action: () => navigate('/inbox') },
        { label: 'Stock on books', value: fmtMoney(work.stockValue), sub: 'current valuation', action: () => navigate('/inventory/stock') },
        { label: 'Overdue AR', value: fmtMoney(work.overdueArAmount), sub: 'collections risk', action: () => navigate('/sales/invoices') },
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
          <div className="quick-actions" style={{ padding: 0 }}>
            <button className="btn btn-primary" onClick={() => navigate('/inbox')}>Open inbox</button>
            {can(user, 'sales.quotations.create') && <button className="btn btn-ghost-on-navy" onClick={() => navigate('/sales/quotations/new')}>New quotation</button>}
            {can(user, 'inventory.stock.view') && <button className="btn btn-ghost-on-navy" onClick={() => navigate('/inventory/stock')}>Stock board</button>}
          </div>
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

      <h3 style={{ margin: '8px 0 10px', fontSize: 13, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>Do now</h3>
      <div className="do-now">
        {nowActions.map((a) => (
          <button key={a.id} onClick={() => navigate(a.href)}>
            <strong>{a.label}</strong>
            <span>{a.hint}</span>
          </button>
        ))}
      </div>

      <div className="kpi-grid">
        {cards.map((c) => (
          <button key={c.label} className={`kpi-card ${c.cls ?? ''}`} onClick={c.action} disabled={!c.action}>
            <span className="kpi-label">{c.label}</span>
            <span className="kpi-value">{c.value}</span>
            <span className="kpi-sub">{c.sub}</span>
          </button>
        ))}
      </div>

      {exec && (
        <section className="card card-pad">
          <h3 style={{ marginTop: 0 }}>Today's operations</h3>
          <Meter label="Production" value={exec.workOrdersTotal ? (exec.workOrdersCompleted / exec.workOrdersTotal) * 100 : 0} />
          <Meter label="Warehouse cover" value={exec.lowStockCount ? Math.max(20, 100 - exec.lowStockCount * 8) : 91} />
          <Meter label="Sales fulfilment" value={exec.openOrders ? Math.min(95, 40 + exec.openOrders * 4) : 73} />
        </section>
      )}

      {activity.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>What happened</h3></div>
          <div className="timeline" style={{ padding: 16 }}>
            {activity.slice(0, 8).map((ev) => (
              <div key={String(ev.id)} className="timeline-item">
                <div className="timeline-dot" />
                <div className="timeline-title">{String(ev.event_type ?? ev.eventType)}</div>
                <div className="timeline-meta">{String(ev.entity_code ?? ev.entityCode ?? ev.entity_type ?? '')} · {String(ev.first_name ?? ev.firstName ?? 'System')}</div>
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
