import { useCallback, useEffect, useState } from 'react';
import { navigate, useHashQuery } from '../../router';
import { can, useAuth } from '../../auth';
import { ErrorBanner, Pager, Spinner } from '../../components/ui';
import {
  KpiRow,
  KpiTile,
  SdHead,
  SdTabs,
  SecCard,
  TicketTable,
  modStyle,
  num,
  s,
  sdApi,
  sdErr,
  useSdMeta,
  type Rec,
} from '../serviceDeskShared';

interface ListResponse {
  items: Rec[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  scope?: Rec;
}

/**
 * Drill-down links from the reports view (spec 25) arrive as query parameters
 * and are folded into the same scoped ticket query as the buttons above, so a
 * drill can never widen the caller's scope.
 */
const DRILL_KEYS: Array<[string, string]> = [
  ['departmentId', 'Department'],
  ['subcategoryId', 'Subcategory'],
  ['requesterEmployeeId', 'Requester'],
  ['assignedToUserId', 'Assignee'],
  ['assetId', 'Asset'],
];

const FILTERS: Array<[string, string, string]> = [
  ['all', 'All tickets', ''],
  ['mine', 'Assigned to me', 'myTickets=true'],
  ['unassigned', 'Unassigned', 'unassigned=true'],
  ['critical', 'Critical (P1 / P2)', 'priority=P1,P2'],
  ['warning', 'SLA warning', 'slaWarning=true'],
  ['overdue', 'Overdue', 'overdue=true'],
  ['breached', 'SLA breached', 'breached=true'],
  ['active', 'Active only', 'activeOnly=true'],
];

export default function ServiceDeskTickets() {
  const q = useHashQuery();
  const { user } = useAuth();
  const meta = useSdMeta();

  const [filter, setFilter] = useState(s(q.get('filter')) || 'all');
  const [search, setSearch] = useState(s(q.get('search')));
  const [priority, setPriority] = useState(s(q.get('priority')));
  const [categoryId, setCategoryId] = useState(s(q.get('categoryId')));
  const [drill, setDrill] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k] of DRILL_KEYS) {
      const v = s(q.get(k));
      if (v) out[k] = v;
    }
    return out;
  });
  const drillLabel = s(q.get('drillLabel'));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [categories, setCategories] = useState<Rec[]>([]);

  useEffect(() => {
    sdApi<Rec[]>('/api/service-desk/categories')
      .then((r) => setCategories(Array.isArray(r) ? r : []))
      .catch(() => setCategories([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const entry = FILTERS.filter(([k]) => k === filter)[0];
      const params = new URLSearchParams(entry ? entry[2] : '');
      params.set('page', s(page));
      params.set('pageSize', s(pageSize));
      if (search.trim()) params.set('search', search.trim());
      if (priority && priority !== 'P1,P2') params.set('priority', priority);
      if (categoryId) params.set('categoryId', categoryId);
      for (const [k] of DRILL_KEYS) if (drill[k]) params.set(k, drill[k]);
      const res = await sdApi<ListResponse>('/api/service-desk/tickets?' + params.toString());
      setData(res);
      setError('');
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setLoading(false);
    }
  }, [filter, page, pageSize, search, priority, categoryId, drill, tick]);

  useEffect(() => void load(), [load]);

  const applyFilter = (k: string) => {
    setFilter(k);
    setPage(1);
  };

  const clearDrill = (key: string) => {
    const next = { ...drill };
    delete next[key];
    setDrill(next);
    setPage(1);
    if (!Object.keys(next).length) navigate('/service-desk/tickets', { replace: true });
  };

  const rows = data?.items ?? [];
  const overdue = rows.filter((t) => t.sla_resolution_state === 'BREACHED').length;

  return (
    <div className="page" style={modStyle()}>
      <SdHead
        title="Tickets"
        kicker="Service desk"
        sub="Every ticket you are allowed to see, scoped by your role, department and organizational scope. Filters and exports respect the same scope."
        actions={
          <>
            <button className="btn" onClick={() => setTick((v) => v + 1)} disabled={loading}>
              {loading ? <Spinner /> : 'Refresh'}
            </button>
            <button className="btn" onClick={() => navigate('/service-desk/workspace')}>
              Agent workspace
            </button>
            {can(user, 'service_desk.reports.view') && (
              <button className="btn" onClick={() => navigate('/service-desk/reports')}>
                Reports
              </button>
            )}
            <button className="btn btn-primary sd-primary" onClick={() => navigate('/service-desk/new')}>
              + New request
            </button>
          </>
        }
      />
      <SdTabs active="tickets" />

      <KpiRow>
        <KpiTile label="Matching tickets" value={num(data?.total)} sub={'page ' + num(data?.page) + ' of ' + num(data?.totalPages || 1)} />
        <KpiTile label="On this page" value={rows.length} sub="Rows returned by the current filter" />
        <KpiTile label="SLA breached here" value={overdue} sub="Resolution SLA already missed" />
        <KpiTile
          label="Scope"
          value={data?.scope?.isAdmin ? 'Administrator' : data?.scope?.isAgent ? 'Agent' : 'Requester'}
          sub={data?.scope?.canViewInternalNotes ? 'Internal notes visible' : 'Internal notes hidden'}
        />
      </KpiRow>

      <div className="filter-bar">
        <div className="chips">
          {FILTERS.map(([k, text]) => (
            <button key={k} className={k === filter ? 'chip active' : 'chip'} onClick={() => applyFilter(k)}>
              {text}
            </button>
          ))}
        </div>
        {Object.keys(drill).length ? (
          <div className="chips">
            {DRILL_KEYS.filter(([k]) => drill[k]).map(([k, lbl]) => (
              <button
                key={k}
                className="chip active"
                title="Drill-down filter from a report - click to clear it"
                onClick={() => clearDrill(k)}
              >
                {drillLabel ? drillLabel + '  ' : ''}
                {lbl}: {drill[k]}
                {' \u2715'}
              </button>
            ))}
          </div>
        ) : null}
        <input
          className="hk-input"
          placeholder="Search ticket number, subject or requester"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          style={{ maxWidth: 320 }}
        />
        <select
          className="hk-select"
          value={priority}
          onChange={(e) => {
            setPriority(e.target.value);
            setPage(1);
          }}
          style={{ maxWidth: 160 }}
        >
          <option value="">Any priority</option>
          {(meta.meta?.priorities ?? ['P1', 'P2', 'P3', 'P4']).map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          className="hk-select"
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            setPage(1);
          }}
          style={{ maxWidth: 220 }}
        >
          <option value="">Any category</option>
          {categories.map((c) => (
            <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>
          ))}
        </select>
      </div>

      {error ? <ErrorBanner error={error} /> : null}

      <SecCard
        title="Ticket queue"
        sub="Click a row to open the ticket. The list is server paged - filters are applied before paging."
      >
        <TicketTable rows={rows} onOpen={(t) => navigate('/service-desk/tickets/' + s(t.id))} />
      </SecCard>

      <Pager
        page={data?.page ?? page}
        pageSize={data?.pageSize ?? pageSize}
        total={data?.total ?? 0}
        onPage={setPage}
        onPageSize={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />
    </div>
  );
}
