import { useCallback, useEffect, useState } from 'react';
import { navigate, useHashQuery } from '../../router';
import { can, useAuth } from '../../auth';
import { ErrorBanner, Spinner } from '../../components/ui';
import {
  KpiRow,
  KpiTile,
  PriorityChip,
  SdHead,
  SdTabs,
  SecCard,
  SlaChip,
  StatusChip,
  fmtAgo,
  modStyle,
  num,
  s,
  sdApi,
  sdErr,
  subjectOf,
  ticketRef,
  type Rec,
} from '../serviceDeskShared';
import TicketDetail from './ticket';

/* ------------------------------------------------------------------ *
 * Smart views - each is a server-side filter over the ticket list.
 * ------------------------------------------------------------------ */

interface Rail {
  key: string;
  label: string;
  hint: string;
  query: string;
  count?: (c: Rec) => number;
}

const SMART_VIEWS: Rail[] = [
  { key: 'all', label: 'All open', hint: 'Everything in your scope', query: 'activeOnly=true', count: (c) => num(c.open_total) },
  { key: 'mine', label: 'My tickets', hint: 'Assigned to me', query: 'myTickets=true', count: (c) => num(c.my_tickets) },
  { key: 'unassigned', label: 'Unassigned', hint: 'No owner yet', query: 'unassigned=true', count: (c) => num(c.unassigned) },
  { key: 'critical', label: 'Critical', hint: 'P1 and P2', query: 'priority=P1,P2', count: (c) => num(c.critical) },
  { key: 'warning', label: 'SLA warning', hint: 'Approaching the target', query: 'slaWarning=true', count: (c) => num(c.due_soon) },
  { key: 'overdue', label: 'Overdue', hint: 'Past the resolution target', query: 'overdue=true', count: (c) => num(c.overdue) },
  { key: 'breached', label: 'Breached', hint: 'SLA already missed', query: 'breached=true', count: (c) => num(c.overdue) },
  { key: 'pending', label: 'Waiting on requester', hint: 'Paused clock', query: 'status=PENDING_REQUESTER,PENDING_VENDOR', count: (c) => num(c.pending_requester) + num(c.pending_vendor) },
  { key: 'escalated', label: 'Escalated', hint: 'Sent up the chain', query: 'status=ESCALATED', count: (c) => num(c.escalated) },
];

export default function ServiceDeskWorkspace() {
  const q = useHashQuery();
  const { user } = useAuth();
  const selectedId = num(q.get('id'));

  const [view, setView] = useState<string>(s(q.get('view')) || 'mine');
  const [queueId, setQueueId] = useState<string>(s(q.get('queueId')));
  const [search, setSearch] = useState('');
  const [summary, setSummary] = useState<Rec | null>(null);
  const [workload, setWorkload] = useState<Rec[]>([]);
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [railOpen, setRailOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      sdApi<Rec>('/api/service-desk/queues/summary'),
      sdApi<Rec[]>('/api/service-desk/workload'),
    ])
      .then(([sum, wl]) => {
        if (!alive) return;
        setSummary(sum);
        setWorkload(Array.isArray(wl) ? wl : []);
        setError('');
      })
      .catch((e) => {
        if (alive) setError(sdErr(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const entry = SMART_VIEWS.filter((v) => v.key === view)[0];
      const params = new URLSearchParams(entry ? entry.query : 'activeOnly=true');
      params.set('pageSize', '50');
      if (queueId) params.set('queueId', queueId);
      const res = await sdApi<{ items: Rec[] }>('/api/service-desk/tickets?' + params.toString());
      setRows(res?.items ?? []);
      setError('');
    } catch (e) {
      setError(sdErr(e));
      setRows([]);
    } finally {
      setListLoading(false);
    }
  }, [view, queueId, tick]);

  useEffect(() => void loadList(), [loadList]);

  const open = useCallback(
    (id: unknown, next?: { view?: string; queueId?: string }) => {
      const query: Record<string, string> = { id: s(id) };
      const v = next?.view ?? view;
      const qid = next?.queueId ?? queueId;
      if (v) query.view = v;
      if (qid) query.queueId = qid;
      navigate('/service-desk/workspace', { query, replace: true });
      setRailOpen(false);
    },
    [view, queueId],
  );

  const pickView = (key: string) => {
    setView(key);
    setQueueId('');
    navigate('/service-desk/workspace', { query: { view: key }, replace: true });
    setRailOpen(false);
  };

  const pickQueue = (id: string) => {
    setQueueId(id);
    setView('queue');
    navigate('/service-desk/workspace', {
      query: { view: 'queue', queueId: id },
      replace: true,
    });
    setRailOpen(false);
  };

  const counts = (summary?.counts ?? {}) as Rec;
  const queues = (summary?.queues ?? []) as Rec[];
  const searchHit = rows.filter((t) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return false;
    return (ticketRef(t) + ' ' + subjectOf(t)).toLowerCase().includes(needle);
  });
  const listRows = search.trim() ? searchHit : rows;

  return (
    <div className="page" style={modStyle()}>
      <SdHead
        title="Agent workspace"
        kicker="Service desk"
        sub="Work a queue without losing the thread. Pick a queue or smart view on the left, open a ticket on the right, and every action stays inside your RBAC and ABAC scope."
        actions={
          <>
            <button className="btn" onClick={() => setTick((v) => v + 1)} disabled={loading}>
              {loading ? <Spinner /> : 'Refresh'}
            </button>
            <button className="btn btn-primary sd-primary" onClick={() => navigate('/service-desk/new')}>
              + New request
            </button>
          </>
        }
      />
      <SdTabs active="workspace" />

      <KpiRow>
        <KpiTile
          label="Open tickets"
          value={num(counts.open_total)}
          sub={num(counts.opened_today) + ' opened today'}
          onClick={() => pickView('all')}
        />
        <KpiTile
          label="Mine"
          value={num(counts.my_tickets)}
          sub={num(counts.resolved_today) + ' resolved today'}
          onClick={() => pickView('mine')}
        />
        <KpiTile
          label="Unassigned"
          value={num(counts.unassigned)}
          sub="Waiting for an owner"
          onClick={() => pickView('unassigned')}
        />
        <KpiTile
          label="Critical"
          value={num(counts.critical)}
          sub="P1 and P2 open"
          onClick={() => pickView('critical')}
        />
        <KpiTile
          label="SLA due soon"
          value={num(counts.due_soon)}
          sub={num(counts.overdue) + ' already overdue'}
          onClick={() => pickView('warning')}
        />
        <KpiTile
          label="Escalated"
          value={num(counts.escalated)}
          sub={num(counts.response_overdue) + ' without first response'}
          onClick={() => pickView('escalated')}
        />
      </KpiRow>

      {error ? <ErrorBanner error={error} /> : null}

      <div className={'sd-workspace' + (railOpen ? ' sd-workspace-rail-open' : '')}>
        <aside className="sd-rail" aria-label="Queues and views">
          <div className="sd-rail-search">
            <input
              className="hk-input"
              placeholder="Filter this list"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              className="btn btn-sm sd-rail-toggle"
              onClick={() => setRailOpen((v) => !v)}
              aria-expanded={railOpen}
            >
              {railOpen ? 'Hide' : 'Queues'}
            </button>
          </div>

          <section className="sd-rail-sec">
            <h4 className="sd-rail-title">My work</h4>
            <ul className="sd-rail-items">
              {SMART_VIEWS.map((v) => (
                <li key={v.key}>
                  <button
                    className={view === v.key && !queueId ? 'sd-rail-item active' : 'sd-rail-item'}
                    onClick={() => pickView(v.key)}
                    title={v.hint}
                  >
                    <span className="sd-rail-label">{v.label}</span>
                    <span className="sd-rail-count">{v.count ? v.count(counts) : 0}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="sd-rail-sec">
            <h4 className="sd-rail-title">Queues</h4>
            <ul className="sd-rail-items">
              {queues.length === 0 && <li className="sd-rail-empty muted">No queues configured.</li>}
              {queues.map((qq) => {
                const id = s(qq.id);
                return (
                  <li key={id}>
                    <button
                      className={queueId === id ? 'sd-rail-item active' : 'sd-rail-item'}
                      onClick={() => pickQueue(id)}
                      title={s(qq.name) + ' \u2013 ' + s(qq.assignment_strategy)}
                    >
                      <span className="sd-rail-label">
                        {s(qq.name)}
                        {qq.is_default ? <span className="sd-rail-flag">default</span> : null}
                      </span>
                      <span className="sd-rail-count">{num(qq.open_tickets)}</span>
                    </button>
                    <span className="sd-rail-sub muted">
                      {num(qq.unassigned)} unassigned &middot; {num(qq.critical)} critical
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="sd-rail-sec">
            <h4 className="sd-rail-title">Technician workload</h4>
            {workload.length === 0 && <p className="muted sd-rail-empty">No assigned work in scope.</p>}
            <ul className="sd-wl">
              {workload.map((w) => (
                <li key={s(w.user_id)} className="sd-wl-row">
                  <div className="sd-wl-top">
                    <span className="sd-wl-name">{s(w.name) || 'Unnamed agent'}</span>
                    <span className="sd-wl-num">{num(w.open_tickets)} open</span>
                  </div>
                  <div className="sd-wl-bars" aria-hidden>
                    <i className="on" />
                    <i className={num(w.overdue_tickets) > 0 ? 'on alt' : undefined} />
                    <i className={num(w.critical_tickets) > 0 ? 'on crit' : undefined} />
                  </div>
                  <span className="sd-wl-foot muted">
                    {num(w.critical_tickets)} critical &middot; {num(w.overdue_tickets)} overdue &middot;{' '}
                    {num(w.resolved_tickets)} resolved
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <div className="sd-rail-list">
          <SecCard
            title={search.trim() ? 'Search results' : view === 'queue' ? 'Queue contents' : 'Ticket list'}
            sub={listLoading ? 'Loading\u2026' : listRows.length + ' ticket(s) in this view'}
            actions={
              <button className="btn btn-sm" onClick={() => void loadList()} disabled={listLoading}>
                {listLoading ? <Spinner /> : 'Reload'}
              </button>
            }
          >
            {listRows.length === 0 && !listLoading ? (
              <p className="sd-nothing-inline muted">
                {search.trim() ? 'Nothing matches that filter on this page.' : 'No tickets in this view.'}
              </p>
            ) : (
              <ul className="sd-list">
                {listRows.map((t) => {
                  const id = num(t.id);
                  const active = id === selectedId;
                  return (
                    <li key={s(t.id)}>
                      <button
                        className={active ? 'sd-list-item active' : 'sd-list-item'}
                        onClick={() => open(t.id)}
                      >
                        <span className="sd-list-line">
                          <b className="td-cell-mono">{ticketRef(t)}</b>
                          <PriorityChip value={t.priority} compact />
                          <SlaChip state={t.sla_resolution_state ?? t.sla_state} />
                        </span>
                        <span className="sd-list-subj">{subjectOf(t)}</span>
                        <span className="sd-list-foot muted">
                          <StatusChip value={t.status} />
                          <span>{s(t.assignee_name) || s(t.queue_name) || 'Unassigned'}</span>
                          <span>{fmtAgo(t.opened_at ?? t.created_at)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </SecCard>
        </div>

        <div className="sd-rail-detail">
          {selectedId ? (
            <TicketDetail id={selectedId} agent embedded />
          ) : (
            <div className="card sd-detail-empty">
              <h3>Pick a ticket</h3>
              <p className="muted">
                Select a ticket from the list to open the full conversation, activity timeline, SLA state and
                lifecycle actions. Deep links work: this view reads <code>?id=</code> from the URL.
              </p>
              <div className="sd-detail-empty-actions">
                <button className="btn" onClick={() => pickView('unassigned')}>
                  Show unassigned
                </button>
                <button className="btn" onClick={() => pickView('critical')}>
                  Show critical
                </button>
                {can(user, 'service_desk.reports.view') && (
                  <button className="btn" onClick={() => navigate('/service-desk/reports')}>
                    Open reporting
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
