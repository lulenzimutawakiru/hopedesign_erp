/**
 * HOPE DESIGN SERVICE DESK - reporting (spec 25).
 *
 * All eleven reports come from one server-side endpoint that returns `columns`
 * next to `rows`. This view therefore never hard-codes a shape: it formats each
 * cell from its declared column type, totals the numeric columns, sorts on the
 * client, drills a row through to the ticket list that produced it, and exports
 * the identical result set to CSV, Excel or PDF.
 *
 * FILTER, GROUP, DRILL DOWN and EXPORT are all served by the same scoped query,
 * so a manager sees exactly the rows their ABAC scope allows - never a wider set
 * hidden behind a client-side filter.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { navigate, useHashQuery } from '../../router';
import { can, useAuth } from '../../auth';
import { ErrorBanner, Spinner } from '../../components/ui';
import { Field, Inp, Sel } from '../hikvision/fields';
import { exportCsv, exportXls, printReport } from '../hikvision/shared';
import {
  EmptyRow,
  KpiRow,
  KpiTile,
  Nothing,
  PriorityChip,
  SecCard,
  SdHead,
  SdTabs,
  dash,
  fmtDT,
  fmtDay,
  fmtMinutesClock,
  modStyle,
  num,
  s,
  sdApi,
  sdErr,
  useSdMeta,
  type Rec,
} from '../serviceDeskShared';

type ColType = 'text' | 'number' | 'date' | 'minutes' | 'percent';

interface ReportColumn {
  key: string;
  label: string;
  type: ColType;
}

interface ReportDef {
  code: string;
  title: string;
  groupBy: string;
  columns: ReportColumn[];
}

interface ReportFilters {
  from?: string;
  to?: string | null;
  days?: number;
  departmentId?: unknown;
  categoryId?: unknown;
  priority?: string[];
}

interface ReportResult {
  report: string;
  title: string;
  groupBy: string;
  columns: ReportColumn[];
  rows: Rec[];
  rowCount: number;
  totals: Record<string, number>;
  filters?: ReportFilters;
  scope?: Rec;
  generatedAt?: string;
}

/**
 * Drill-down target per report: the row column that carries an id, and the
 * ticket-list filter it maps onto. Reports grouped on something the ticket list
 * cannot filter by (SLA policy) or on time itself (trends) stay read-only
 * rather than linking to a list that would silently ignore the filter.
 */
interface Drill {
  key: string;
  param: string;
  hint: string;
}

const DRILL: Record<string, Drill> = {
  tickets_by_category: { key: 'category_id', param: 'categoryId', hint: 'Open the tickets behind this category' },
  tickets_by_department: { key: 'department_id', param: 'departmentId', hint: 'Open the tickets behind this department' },
  tickets_by_employee: {
    key: 'requester_employee_id',
    param: 'requesterEmployeeId',
    hint: 'Open the tickets raised by this employee',
  },
  sla_breaches: { key: 'ticket_number', param: 'search', hint: 'Find this breached ticket' },
  resolution_time: { key: 'priority', param: 'priority', hint: 'Open the tickets at this priority' },
  first_response_time: { key: 'priority', param: 'priority', hint: 'Open the tickets at this priority' },
  technician_workload: {
    key: 'user_id',
    param: 'assignedToUserId',
    hint: 'Open the tickets assigned to this technician',
  },
  recurring_incidents: { key: 'subcategory_id', param: 'subcategoryId', hint: 'Open the incidents behind this pattern' },
  asset_incidents: { key: 'asset_id', param: 'assetId', hint: 'Open the tickets raised against this asset' },
};

const WINDOWS: Array<[number, string]> = [
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
  [180, '6 months'],
  [365, '1 year'],
];

const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** Human-readable cell, driven purely by the column type the API declared. */
function fmtCell(col: ReportColumn, v: unknown): string {
  if (v === null || v === undefined || v === '') return '\u2014';
  if (col.type === 'number') {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('en-US') : dash(v);
  }
  if (col.type === 'minutes') return fmtMinutesClock(v);
  if (col.type === 'percent') {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(1) + '%' : dash(v);
  }
  if (col.type === 'date') return col.key === 'day' ? fmtDay(v) : fmtDT(v);
  return dash(v);
}

/** Export value: numeric columns stay numeric so spreadsheets can compute. */
function rawCell(col: ReportColumn, v: unknown): string | number {
  if (v === null || v === undefined) return '';
  if (col.type === 'number' || col.type === 'minutes' || col.type === 'percent') {
    const n = Number(v);
    return Number.isFinite(n) ? n : '';
  }
  return s(v);
}

/**
 * The numeric totals worth surfacing as headline tiles, biggest first. Summed
 * percentages are intentionally excluded - an average of averages is not a
 * compliance figure, and the per-row percentage is already in the table.
 */
function headlineTotals(columns: ReportColumn[], totals: Record<string, number>): Array<{ label: string; value: number }> {
  return columns
    .filter((c) => c.type === 'number' && Object.prototype.hasOwnProperty.call(totals, c.key))
    .map((c) => ({ label: c.label, value: num(totals[c.key]) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);
}

export default function ServiceDeskReports() {
  const q = useHashQuery();
  const { user } = useAuth();
  const meta = useSdMeta();
  const allowed = can(user, 'service_desk.reports.view');

  const [catalogue, setCatalogue] = useState<ReportDef[]>([]);
  const [code, setCode] = useState(s(q.get('report')) || 'service_trends');
  const [days, setDays] = useState<number>(Number(q.get('days')) || 30);
  const [from, setFrom] = useState(s(q.get('from')));
  const [to, setTo] = useState(s(q.get('to')));
  const [departmentId, setDepartmentId] = useState(s(q.get('departmentId')));
  const [categoryId, setCategoryId] = useState(s(q.get('categoryId')));
  const [priority, setPriority] = useState(s(q.get('priority')));

  const [result, setResult] = useState<ReportResult | null>(null);
  const [categories, setCategories] = useState<Rec[]>([]);
  const [departments, setDepartments] = useState<Array<{ id: string; label: string }>>([]);
  const [sortKey, setSortKey] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  // The catalogue drives the report picker, and the category list drives the
  // filter. The department options are read back out of the department report
  // itself, so the picker can never offer a department that has no tickets in
  // scope - and it needs no extra HR permission to build.
  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    let live = true;
    sdApi<ReportDef[]>('/api/service-desk/reports')
      .then((r) => {
        if (!live) return;
        const list = Array.isArray(r) ? r : [];
        setCatalogue(list);
        setCode((cur) => (list.some((d) => d.code === cur) ? cur : (list[0]?.code ?? cur)));
      })
      .catch((e) => live && setError(sdErr(e)));
    sdApi<Rec[]>('/api/service-desk/categories')
      .then((r) => live && setCategories(Array.isArray(r) ? r : []))
      .catch(() => undefined);
    sdApi<ReportResult>('/api/service-desk/reports/tickets_by_department?days=365')
      .then((r) => {
        if (!live) return;
        const rows = Array.isArray(r?.rows) ? r.rows : [];
        const seen = new Set<string>();
        const opts: Array<{ id: string; label: string }> = [];
        for (const row of rows) {
          const id = s(row.department_id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          opts.push({ id, label: s(row.department) || 'Department ' + id });
        }
        setDepartments(opts);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [allowed]);

  const load = useCallback(async () => {
    if (!allowed || !code) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('days', String(days || 30));
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (departmentId) params.set('departmentId', departmentId);
      if (categoryId) params.set('categoryId', categoryId);
      if (priority) params.set('priority', priority);
      const res = await sdApi<ReportResult>('/api/service-desk/reports/' + encodeURIComponent(code) + '?' + params.toString());
      setResult(res);
      setError('');
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setLoading(false);
    }
  }, [allowed, code, days, from, to, departmentId, categoryId, priority, tick]);

  useEffect(() => void load(), [load]);

  const columns = useMemo(() => (Array.isArray(result?.columns) ? result.columns : []), [result]);

  // Sorting is a client concern: the server already applied FILTER and GROUP,
  // and the row counts per report are bounded (200-1000), so re-ordering here
  // keeps every click instant without a second round trip.
  const rows = useMemo(() => {
    const base = Array.isArray(result?.rows) ? [...result.rows] : [];
    if (!sortKey) return base;
    const col = columns.filter((c) => c.key === sortKey)[0];
    const dir = sortDir === 'asc' ? 1 : -1;
    return base.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (col && (col.type === 'number' || col.type === 'minutes' || col.type === 'percent')) {
        return (num(av) - num(bv)) * dir;
      }
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [result, columns, sortKey, sortDir]);

  const totals = result?.totals ?? {};
  const tiles = headlineTotals(columns, totals);
  const priorities = meta.meta?.priorities ?? PRIORITIES;

  const pickReport = (next: string) => {
    setCode(next);
    setSortKey('');
    navigate('/service-desk/reports', { replace: true, query: { report: next } });
  };

  const reset = () => {
    setDays(30);
    setFrom('');
    setTo('');
    setDepartmentId('');
    setCategoryId('');
    setPriority('');
    setSortKey('');
  };

  const subtitle =
    'HOPE DESIGN SERVICE DESK - ' +
    (result?.title ?? code) +
    ' - ' +
    (from ? 'from ' + from : 'last ' + days + ' days') +
    (to ? ' to ' + to : '') +
    ' - ' +
    rows.length +
    ' row(s)';

  const exportRows = (raw: boolean) =>
    rows.map((r) => columns.map((c) => (raw ? rawCell(c, r[c.key]) : fmtCell(c, r[c.key]))));

  const headers = columns.map((c) => c.label);
  const fileBase = 'service-desk-' + code + '-' + stamp();

  const onSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir('desc');
  };

  if (!allowed) {
    return (
      <div className="page" style={modStyle()}>
        <SdHead title="Reports" kicker="Service desk" sub="Service desk reporting requires the reports permission." />
        <SdTabs active="reports" />
        <Nothing
          text="You do not have permission to view service desk reports. Ask an administrator to grant service_desk.reports.view."
          action="Back to my tickets"
          onAction={() => navigate('/service-desk')}
        />
      </div>
    );
  }

  return (
    <div className="page" style={modStyle()}>
      <SdHead
        title="Service desk reports"
        kicker={'Service desk \u00b7 section 25'}
        sub="Filter, group, drill down and export. Every report runs against your authorized organizational scope, so the numbers you export are the numbers you are allowed to see."
        actions={
          <>
            <button className="btn" onClick={() => setTick((v) => v + 1)} disabled={loading}>
              {loading ? <Spinner /> : 'Refresh'}
            </button>
            <button className="btn" onClick={() => navigate('/service-desk/dashboard')}>
              Dashboards
            </button>
          </>
        }
      />
      <SdTabs active="reports" />

      <div className="chips" style={{ marginBottom: 12 }}>
        {catalogue.map((d) => (
          <button
            key={d.code}
            className={d.code === code ? 'chip active' : 'chip'}
            onClick={() => pickReport(d.code)}
            title={'Grouped by ' + d.groupBy}
          >
            {d.title}
          </button>
        ))}
      </div>

      <KpiRow>
        <KpiTile label="Rows" value={rows.length} sub={(result?.title ?? code) + ' \u00b7 grouped by ' + (result?.groupBy ?? '-')} />
        {tiles.map((t) => (
          <KpiTile key={t.label} label={'Total ' + t.label.toLowerCase()} value={t.value.toLocaleString('en-US')} sub="Summed across the visible rows" />
        ))}
      </KpiRow>

      <SecCard title="Filters" sub="Filters are applied in the database before grouping, so the group rows and the totals always agree.">
        <div className="sd-form-grid">
          <Field label="Report">
            <Sel
              value={code}
              onChange={(v) => pickReport(v)}
              options={catalogue.map((d) => ({ value: d.code, label: d.title }))}
            />
          </Field>
          <Field label="Window" hint="Used when no From date is set.">
            <Sel
              value={String(days)}
              onChange={(v) => setDays(Number(v) || 30)}
              options={WINDOWS.map(([n, lbl]) => ({ value: String(n), label: lbl }))}
            />
          </Field>
          <Field label="From" hint="Optional. Overrides the window.">
            <Inp type="date" value={from} onChange={setFrom} />
          </Field>
          <Field label="To" hint="Optional upper bound.">
            <Inp type="date" value={to} onChange={setTo} />
          </Field>
          <Field label="Department">
            <Sel
              value={departmentId}
              onChange={setDepartmentId}
              placeholder="All departments"
              options={departments.map((d) => ({ value: d.id, label: d.label }))}
            />
          </Field>
          <Field label="Category">
            <Sel
              value={categoryId}
              onChange={setCategoryId}
              placeholder="All categories"
              options={categories.map((c) => ({ value: s(c.id), label: s(c.name) }))}
            />
          </Field>
          <Field label="Priority">
            <Sel
              value={priority}
              onChange={setPriority}
              placeholder="All priorities"
              options={priorities.map((p) => ({ value: p, label: p }))}
            />
          </Field>
        </div>
        <div className="sd-card-actions">
          <button className="btn btn-primary sd-primary" onClick={() => setTick((v) => v + 1)} disabled={loading}>
            {loading ? <Spinner /> : 'Run report'}
          </button>
          <button className="btn" onClick={reset} disabled={loading}>
            Reset filters
          </button>
          <span className="sd-subnote">
            {result?.generatedAt ? 'Generated ' + fmtDT(result.generatedAt) : 'Filters apply as soon as they change.'}
          </span>
        </div>
      </SecCard>

      {error ? <ErrorBanner error={error} /> : null}

      <SecCard
        title={result?.title ?? 'Report'}
        sub={
          result
            ? 'Grouped by ' + result.groupBy + ' \u00b7 ' + rows.length + ' group row(s). ' +
              (sortKey ? 'Sorted by ' + sortKey + ' (' + sortDir + ').' : 'Click a column heading to sort.')
            : 'Choose a report to begin.'
        }
        actions={
          <>
            <button className="btn btn-sm" onClick={() => exportCsv(fileBase, headers, exportRows(true))} disabled={!rows.length}>
              Export CSV
            </button>
            <button className="btn btn-sm" onClick={() => exportXls(fileBase, result?.title ?? code, headers, exportRows(true))} disabled={!rows.length}>
              Export Excel
            </button>
            <button className="btn btn-sm" onClick={() => printReport(result?.title ?? 'Service desk report', subtitle, headers, exportRows(false))} disabled={!rows.length}>
              Export PDF
            </button>
          </>
        }
        pad={false}
      >
        <div className="table-wrap">
          <table className="table sd-report-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={c.type === 'number' || c.type === 'minutes' || c.type === 'percent' ? 'sd-num sd-sort' : 'sd-sort'}
                    onClick={() => onSort(c.key)}
                    title={'Sort by ' + c.label}
                  >
                    {c.label}
                    {sortKey === c.key ? <span className="sd-sort-mark">{sortDir === 'asc' ? ' \u25B2' : ' \u25BC'}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && !rows.length ? (
                <EmptyRow cols={Math.max(columns.length, 1)}>
                  <Spinner /> Loading report
                </EmptyRow>
              ) : null}
              {!loading && !rows.length ? (
                <EmptyRow cols={Math.max(columns.length, 1)}>
                  No tickets matched this report and filter combination.
                </EmptyRow>
              ) : null}
              {rows.map((row, i) => {
                const drill = DRILL[code];
                const drillValue = drill ? row[drill.key] : undefined;
                const canDrill = Boolean(drill) && s(drillValue) !== '';
                return (
                  <tr key={s(row[columns[0]?.key]) + ':' + i} className="sd-ticket-row">
                    {columns.map((c, ci) => {
                      const value = row[c.key];
                      const numeric = c.type === 'number' || c.type === 'minutes' || c.type === 'percent';
                      const raw = c.type === 'minutes' && value !== null && value !== undefined ? num(value) + ' min' : undefined;
                      return (
                        <td key={c.key} className={numeric ? 'sd-num' : ''} title={raw}>
                          {ci === 0 && canDrill ? (
                            <button
                              className="sd-drill"
                              title={drill?.hint}
                              onClick={() => {
                                if (!drill) return;
                                const head = columns[0];
                                const text = head ? fmtCell(head, row[head.key]) : '';
                                navigate(
                                  '/service-desk/tickets?' +
                                    drill.param + '=' + encodeURIComponent(s(drillValue)) +
                                    '&drillLabel=' + encodeURIComponent(text)
                                );
                              }}
                            >
                              {fmtCell(c, value)}
                            </button>
                          ) : c.key === 'priority' ? (
                            <PriorityChip value={value} compact />
                          ) : (
                            fmtCell(c, value)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 0 && columns.length > 0 ? (
              <tfoot>
                <tr className="sd-report-foot">
                  {columns.map((c, ci) => {
                    const summative = c.type === 'number' || c.type === 'minutes';
                    const shown = summative && Object.prototype.hasOwnProperty.call(totals, c.key);
                    return (
                      <td key={c.key} className={summative ? 'sd-num' : ''}>
                        {ci === 0
                          ? 'Totals'
                          : shown
                            ? fmtCell(c, totals[c.key])
                            : c.type === 'percent'
                              ? '\u2014'
                              : ''}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </SecCard>

      <p className="sd-report-note">
        Percentages are never summed - they are reported per row and must be read against that row's own ticket count. Exports
        keep the numeric columns as numbers so they stay usable in a spreadsheet; the PDF export renders the same values the
        table shows on screen.
      </p>
    </div>
  );
}
