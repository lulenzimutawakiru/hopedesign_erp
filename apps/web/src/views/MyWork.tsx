import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api, fmtDate, fmtMoney, fmtNum } from '../api';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { EmptyState } from '../components/os';
import { pick } from '../helpers';
import { navigate } from '../router';
import { greetingFor, pathForEntity, personaLabel, personaOf } from '../work';
import { useAuth, can } from '../auth';

type Rec = Record<string, unknown>;

interface WorkBundle {
  tasks: Rec[];
  approvals: Rec[];
  workOrders: Rec[];
  leads?: Rec[];
  opportunities?: Rec[];
  activities?: Rec[];
  complaints?: Rec[];
  counts: {
    tasks: number;
    approvals: number;
    workOrders: number;
    leads?: number;
    opportunities?: number;
    activities?: number;
    complaints?: number;
    overdue?: number;
    unread?: number;
  };
}

interface WorkFeed {
  exceptions: { code: string; label: string; count: number; href: string; severity: string }[];
}

function hrefForRow(entityType: unknown, entityId: unknown): string {
  const type = String(entityType ?? '');
  const id = Number(entityId);
  if (!type || !id) return '/work';
  return pathForEntity(type, id);
}

function tile(key: string, label: string, value: string, sub: string, icon: string, accent: string, action: () => void) {
  return { key, label, value, sub, icon, accent, action };
}

const NOW_ICONS: Record<string, string> = {
  inbox: '🗂️',
  'crm-mine': '🎯',
  sales: '🧭',
  plant: '🏭',
  stock: '📦',
  reports: '📊',
};

export default function MyWork() {
  const { user } = useAuth();
  const [bundle, setBundle] = useState<WorkBundle | null>(null);
  const [ex, setEx] = useState<WorkFeed['exceptions']>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return Promise.all([
      api<{ data: WorkBundle }>('/api/dashboard/my-work'),
      api<{ data: WorkFeed }>('/api/dashboard/work'),
    ]).then(([a, b]) => {
      setBundle(a.data);
      setEx(b.data.exceptions ?? []);
    });
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load your work'));
  }, [load]);

  const completeActivity = async (id: number) => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/crm/activities/${id}/complete`, { method: 'POST', body: '{}' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !bundle) return <ErrorBanner error={error} />;
  if (!bundle) return <PageLoader label="Opening your work…" />;

  const leads = bundle.leads ?? [];
  const opps = bundle.opportunities ?? [];
  const acts = bundle.activities ?? [];
  const complaints = bundle.complaints ?? [];
  const exceptionTotal = ex.reduce((s, e) => s + e.count, 0);
  const empty =
    !bundle.approvals.length &&
    !bundle.workOrders.length &&
    !bundle.tasks.length &&
    !leads.length &&
    !opps.length &&
    !acts.length &&
    !complaints.length &&
    !ex.length;

  const name = user ? `${user.first_name}` : 'there';
  const persona = personaLabel(personaOf(user));

  const tiles = [
    tile('approvals', 'Approvals', fmtNum(bundle.counts.approvals), 'on your desk', '🗂️', '#8B5CF6', () => navigate('/inbox')),
    tile('followups', 'Follow-ups', fmtNum((bundle.counts.activities ?? 0) + bundle.counts.tasks), `${fmtNum(bundle.counts.overdue)} overdue`, '📅', '#00A6A6', () => navigate('/crm/activities')),
    tile('pipeline', 'My pipeline', fmtNum(bundle.counts.opportunities), `${fmtNum(bundle.counts.leads)} leads · ${fmtNum(bundle.counts.complaints)} complaints`, '📈', '#1261A0', () => navigate('/crm/mine')),
    tile('jobs', 'My jobs', fmtNum(bundle.counts.workOrders), 'live work orders', '⚙️', '#D97706', () => navigate('/operator')),
    tile('exceptions', 'Exceptions', fmtNum(exceptionTotal), 'need a person', '⚠️', '#C93636', () => navigate('/inbox')),
  ];

  const nowActions = [
    { id: 'inbox', label: 'Inbox', hint: 'Decide approvals', href: '/inbox' },
    { id: 'crm-mine', label: 'CRM desk', hint: 'Leads and pipeline', href: '/crm/mine' },
    { id: 'sales', label: 'Sales', hint: 'Quote to cash', href: '/sales' },
    { id: 'plant', label: 'Plant', hint: 'Live work orders', href: '/plant' },
  ];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="exec">My Work</p>
          <h1>{greetingFor()} {name}</h1>
          <p className="muted">Your approvals, CRM follow-ups, pipeline, and plant jobs. {persona} queue — not the whole mill.</p>
        </div>
        <div className="head-actions">
          {can(user, 'crm.leads.create') && <button className="btn" onClick={() => navigate('/crm/leads/new')}>New lead</button>}
          {can(user, 'sales.quotations.create') && <button className="btn btn-primary" onClick={() => navigate('/sales/quotations/new')}>New quotation</button>}
        </div>
      </header>

      {error && <ErrorBanner error={error} />}

      <div className="kpi-grid--tiles">
        {tiles.map((c) => (
          <button
            key={c.key}
            className="kpi-tile"
            style={{ '--tile-accent': c.accent, '--tile-tint': `${c.accent}1F` } as CSSProperties}
            onClick={c.action}
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

      {empty && (
        <EmptyState
          title="Your queue is clear"
          body="Nothing is assigned to you right now. Start a document from Create, or open a workspace."
          action={can(user, 'sales.quotations.create') ? 'New quotation' : can(user, 'crm.leads.create') ? 'New lead' : undefined}
          onAction={() => navigate(can(user, 'sales.quotations.create') ? '/sales/quotations/new' : '/crm/leads/new')}
        />
      )}

      {bundle.approvals.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h3>Decisions</h3>
            <span className="queue-count"><b>{bundle.approvals.length}</b> waiting</span>
            <button className="btn btn-sm" onClick={() => navigate('/inbox')}>Open inbox</button>
          </div>
          <div className="queue">
            {bundle.approvals.map((row) => {
              const entityType = String(pick(row, 'entity_type', 'entityType') ?? 'Document');
              const href = hrefForRow(row.entity_type ?? row.entityType, row.entity_id ?? row.entityId);
              const dueAt = pick(row, 'due_at', 'dueAt');
              return (
                <div key={String(row.task_id ?? row.taskId)} className="queue-row">
                  <div className="queue-row-main">
                    <span className="queue-row-title">
                      <span className="cell-mono">{String(pick(row, 'entity_code', 'entityCode') ?? 'Document')}</span>
                      <Badge value={pick(row, 'step_label', 'stepLabel') ?? 'Approval'} />
                    </span>
                    <span className="queue-row-meta">
                      {entityType.replace(/\./g, ' · ')}
                      {dueAt ? <><span className="sep">·</span>Due {fmtDate(dueAt)}</> : null}
                      <span className="sep">·</span>Awaiting your decision
                    </span>
                  </div>
                  <div className="queue-row-side">
                    <Badge value={pick(row, 'status')} />
                    {href !== '/work' && <button className="btn btn-sm" onClick={() => navigate(href)}>Open</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {acts.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Follow-ups</h3><button className="btn btn-sm" onClick={() => navigate('/crm/activities')}>All activities</button></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Type</th><th>Subject</th><th>On</th><th>Due</th><th /></tr></thead>
              <tbody>
                {acts.map((t) => (
                  <tr key={String(t.id)} className={`row-click ${t.overdue ? 'row-overdue' : ''}`}>
                    <td>{String(pick(t, 'activity_type', 'activityType'))}</td>
                    <td>
                      <button className="linkish" onClick={() => navigate(hrefForRow(t.entity_type ?? t.entityType, t.entity_id ?? t.entityId))}>
                        {String(pick(t, 'subject'))}
                      </button>
                    </td>
                    <td className="cell-mono">{String(pick(t, 'entity_type', 'entityType'))} #{String(pick(t, 'entity_id', 'entityId'))}</td>
                    <td className={t.overdue ? 'cell-due' : ''}>
                      {t.due_at || t.dueAt ? fmtDate(pick(t, 'due_at', 'dueAt')) : '—'}
                      {t.overdue ? ' · overdue' : ''}
                    </td>
                    <td>
                      {can(user, 'crm.activities.complete') && (
                        <button className="btn btn-sm" disabled={busy} onClick={() => completeActivity(Number(t.id))}>Done</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {bundle.tasks.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Tasks</h3></div>
          <div className="queue">
            {bundle.tasks.map((t) => {
              const href = hrefForRow(t.entity_type ?? t.entityType, t.entity_id ?? t.entityId);
              return (
                <button
                  key={String(t.id)}
                  className="queue-row queue-row-click"
                  onClick={() => { if (href !== '/work') navigate(href); }}
                >
                  <span className="queue-row-main">
                    <span className="queue-row-title">{String(pick(t, 'title'))}</span>
                    <span className="queue-row-meta">Due {fmtDate(pick(t, 'due_at', 'dueAt'))}</span>
                  </span>
                  <span className="queue-row-side"><Badge value={pick(t, 'status')} /></span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {leads.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>My leads</h3><button className="btn btn-sm" onClick={() => navigate('/crm/leads')}>All leads</button></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Lead</th><th>Name</th><th>Status</th><th className="cell-num">Score</th></tr></thead>
              <tbody>
                {leads.map((r) => (
                  <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/leads/${r.id}`)}>
                    <td className="cell-mono">{String(pick(r, 'lead_no', 'leadNo'))}</td>
                    <td>{String(pick(r, 'company_name', 'companyName') || `${pick(r, 'first_name', 'firstName') ?? ''} ${pick(r, 'last_name', 'lastName') ?? ''}`.trim() || '—')}</td>
                    <td><Badge value={pick(r, 'status')} /></td>
                    <td className="cell-num">{fmtNum(pick(r, 'score'))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {opps.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>My pipeline</h3><button className="btn btn-sm" onClick={() => navigate('/crm/pipeline')}>Pipeline</button></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Opportunity</th><th>Account</th><th>Stage</th><th className="cell-num">Amount</th></tr></thead>
              <tbody>
                {opps.map((r) => (
                  <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/opportunities/${r.id}`)}>
                    <td>{String(pick(r, 'name'))}</td>
                    <td>{String(pick(r, 'customer_name', 'customerName') ?? '—')}</td>
                    <td><Badge value={pick(r, 'stage')} /></td>
                    <td className="cell-num">{fmtMoney(pick(r, 'amount'))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {complaints.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Complaints</h3><button className="btn btn-sm" onClick={() => navigate('/crm/complaints')}>Service</button></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>No</th><th>Account</th><th>Priority</th><th>Status</th></tr></thead>
              <tbody>
                {complaints.map((r) => (
                  <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/crm/complaints/${r.id}`)}>
                    <td className="cell-mono">{String(pick(r, 'complaint_no', 'complaintNo'))}</td>
                    <td>{String(pick(r, 'customer_name', 'customerName'))}</td>
                    <td><Badge value={pick(r, 'priority')} /></td>
                    <td><Badge value={pick(r, 'status')} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {bundle.workOrders.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Production jobs</h3><button className="btn btn-sm" onClick={() => navigate('/operator')}>Operator floor</button></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>WO</th><th>Product</th><th>Machine</th><th>Status</th><th>Progress</th></tr></thead>
              <tbody>
                {bundle.workOrders.map((wo) => {
                  const quantity = Number(pick(wo, 'quantity') ?? 0);
                  const produced = Number(pick(wo, 'produced_qty', 'producedQty') ?? 0);
                  const pct = quantity > 0 ? Math.max(0, Math.min(100, (produced / quantity) * 100)) : 0;
                  return (
                    <tr key={String(wo.id)} className="row-click" onClick={() => navigate(`/operator/${wo.id}`)}>
                      <td className="cell-mono">{String(pick(wo, 'wo_no', 'woNo'))}</td>
                      <td>{String(pick(wo, 'product_name', 'productName') ?? '—')}</td>
                      <td className="cell-mono">{String(pick(wo, 'machine_code', 'machineCode') ?? '—')}</td>
                      <td><Badge value={pick(wo, 'status')} /></td>
                      <td>
                        <span className={`mini-progress ${pct >= 100 ? 'done' : ''}`}>
                          <span className="mini-progress-track"><span className="mini-progress-fill" style={{ width: `${pct}%` }} /></span>
                          <span>{fmtNum(produced)}/{fmtNum(quantity)}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {ex.length > 0 && (
        <section className="card card-pad">
          <h3 style={{ marginTop: 0 }}>Exceptions</h3>
          <div className="exception-list">
            {ex.map((e) => (
              <button key={e.code} className={`exception-item severity-${e.severity}`} onClick={() => navigate(e.href)}>
                <div><strong>{e.label}</strong><div className="muted">{e.severity}</div></div>
                <span className="ex-count">{e.count}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
