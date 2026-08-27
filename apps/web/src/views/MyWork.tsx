import { useCallback, useEffect, useState } from 'react';
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
  return pathForEntity(type.includes('.') ? type : type, id);
}

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

      <div className="kpi-grid">
        <button className="kpi-card" onClick={() => navigate('/inbox')}>
          <span className="kpi-label">Approvals</span>
          <span className="kpi-value">{fmtNum(bundle.counts.approvals)}</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/crm/activities')}>
          <span className="kpi-label">Follow-ups</span>
          <span className="kpi-value">{fmtNum((bundle.counts.activities ?? 0) + bundle.counts.tasks)}</span>
          <span className="kpi-sub">{fmtNum(bundle.counts.overdue)} overdue</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/crm/mine')}>
          <span className="kpi-label">My pipeline</span>
          <span className="kpi-value">{fmtNum(bundle.counts.opportunities)}</span>
          <span className="kpi-sub">{fmtNum(bundle.counts.leads)} leads · {fmtNum(bundle.counts.complaints)} complaints</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/plant')}>
          <span className="kpi-label">My jobs</span>
          <span className="kpi-value">{fmtNum(bundle.counts.workOrders)}</span>
        </button>
        <button className={`kpi-card ${ex.length ? 'card-warn' : ''}`} onClick={() => navigate('/inbox')}>
          <span className="kpi-label">Exceptions</span>
          <span className="kpi-value">{fmtNum(ex.reduce((s, e) => s + e.count, 0))}</span>
        </button>
      </div>

      <div className="do-now">
        <button onClick={() => navigate('/inbox')}><strong>Inbox</strong><span>Decide approvals</span></button>
        <button onClick={() => navigate('/crm/mine')}><strong>CRM desk</strong><span>Leads and pipeline</span></button>
        <button onClick={() => navigate('/sales')}><strong>Sales</strong><span>Quote to cash</span></button>
        <button onClick={() => navigate('/plant')}><strong>Plant</strong><span>Live work orders</span></button>
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
          <div className="card-head"><h3>Decisions</h3><button className="btn btn-sm" onClick={() => navigate('/inbox')}>Open inbox</button></div>
          {bundle.approvals.map((row) => (
            <button
              key={String(row.task_id ?? row.taskId)}
              className="exception-item"
              onClick={() => navigate(hrefForRow(row.entity_type ?? row.entityType, row.entity_id ?? row.entityId))}
            >
              <div>
                <strong>{String(pick(row, 'entity_code', 'entityCode') ?? 'Document')}</strong>
                <div className="muted">{String(pick(row, 'entity_type', 'entityType'))} · {String(pick(row, 'step_label', 'stepLabel') ?? 'Approval')}</div>
              </div>
              <Badge value={pick(row, 'status')} />
            </button>
          ))}
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
                  <tr key={String(t.id)} className={t.overdue ? 'row-click' : 'row-click'}>
                    <td>{String(pick(t, 'activity_type', 'activityType'))}</td>
                    <td>
                      <button className="linkish" onClick={() => navigate(hrefForRow(t.entity_type ?? t.entityType, t.entity_id ?? t.entityId))}>
                        {String(pick(t, 'subject'))}
                      </button>
                    </td>
                    <td className="cell-mono">{String(pick(t, 'entity_type', 'entityType'))} #{String(pick(t, 'entity_id', 'entityId'))}</td>
                    <td>{t.due_at || t.dueAt ? fmtDate(pick(t, 'due_at', 'dueAt')) : '—'}{t.overdue ? ' · overdue' : ''}</td>
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
          {bundle.tasks.map((t) => (
            <button
              key={String(t.id)}
              className="exception-item"
              onClick={() => {
                const href = hrefForRow(t.entity_type ?? t.entityType, t.entity_id ?? t.entityId);
                if (href !== '/work') navigate(href);
              }}
            >
              <div>
                <strong>{String(pick(t, 'title'))}</strong>
                <div className="muted">Due {fmtDate(pick(t, 'due_at', 'dueAt'))}</div>
              </div>
              <Badge value={pick(t, 'status')} />
            </button>
          ))}
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
              <thead><tr><th>WO</th><th>Product</th><th>Machine</th><th>Status</th><th className="cell-num">Done</th></tr></thead>
              <tbody>
                {bundle.workOrders.map((wo) => (
                  <tr key={String(wo.id)} className="row-click" onClick={() => navigate(`/operator/${wo.id}`)}>
                    <td className="cell-mono">{String(pick(wo, 'wo_no', 'woNo'))}</td>
                    <td>{String(pick(wo, 'product_name', 'productName') ?? '—')}</td>
                    <td className="cell-mono">{String(pick(wo, 'machine_code', 'machineCode') ?? '—')}</td>
                    <td><Badge value={pick(wo, 'status')} /></td>
                    <td className="cell-num">{fmtNum(pick(wo, 'produced_qty', 'producedQty'))} / {fmtNum(pick(wo, 'quantity'))}</td>
                  </tr>
                ))}
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
