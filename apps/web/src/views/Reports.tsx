import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, EntityMeta, fmtDate, fmtMoney, fmtNum, getToken } from '../api';
import { DataTable } from '../components/DataTable';
import { AccessDenied } from '../components/nav';
import { EmptyState } from '../components/os';
import { Badge, ErrorBanner, Modal, PageLoader, Pager } from '../components/ui';
import { useAuth, can } from '../auth';
import { navigate, useHashQuery } from '../router';
import { titleCase } from '../helpers';

interface ReportDef {
  name: string;
  label: string;
  permission: string;
  columns: string[];
}

interface Kpi {
  key: string;
  label: string;
  value: number | null;
  format: 'money' | 'number' | 'percent';
  report: string;
  sub?: string;
}

interface AnalyticsKpi {
  id: number;
  key: string;
  name: string;
  description: string;
  department: string | null;
  ownerId: number | null;
  dataSource: string;
  valueColumn: string | null;
  aggregation: string;
  periodColumn: string | null;
  unit: string;
  frequency: string;
  direction: string;
  targetValue: number | null;
  warningThreshold: number | null;
  criticalThreshold: number | null;
  companyId: number | null;
  createdAt: string;
  updatedAt: string;
  latestValue: number | null;
  latestStatus: string | null;
  latestMeasuredAt: string | null;
}

interface AnalyticsWidget {
  id?: number;
  widgetType: string;
  title: string;
  kpiId: number | null;
  reportName: string | null;
  config: Record<string, unknown>;
  position: Record<string, unknown>;
  size: Record<string, unknown>;
}

interface AnalyticsDashboard {
  id: number;
  name: string;
  description: string;
  isPersonal: boolean;
  isDefault: boolean;
  layout: Record<string, unknown> | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  widgetCount: number;
  widgets?: AnalyticsWidget[];
}

interface CustomReport {
  id: number;
  name: string;
  description: string;
  dataSource: string;
  config: {
    columns: string[];
    groupBy: string[];
    sort: { column: string; direction: string } | null;
    limit: number;
  };
  visualization: string;
  companyId: number | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

interface AnalyticsSource {
  name: string;
  columns: string[];
}

interface ExecData {
  financial: {
    trialBalance: number;
    receivables: number;
    payables: number;
    monthGrossPayroll: number;
  };
  commercial: {
    monthRevenue: number;
    monthInvoices: number;
    revenueGrowthPct: number | null;
  };
  manufacturing: {
    monthYieldPct: number | null;
    monthProduced: number;
    workOrdersInProgress: number;
    workOrdersCompleted: number;
  };
  inventory: { stockValue: number; stockLines: number; lowStock: number };
  traceability: { qrScans: number };
  logistics: {
    deliveriesDelivered: number;
    deliveriesOutstanding: number;
    deliveryRatePct: number | null;
  };
}

interface ReportMeta {
  name: string;
  label: string;
  issuedBy: string;
  issuedAt: string;
}

interface SummaryResult {
  total: number;
  sums: { column: string; value: number }[];
  dateRange: { column: string; min: string; max: string } | null;
}

interface SavedView {
  id: number;
  name: string;
  reportName: string;
  filters: Record<string, unknown>;
  sort: unknown;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Schedule {
  id: number;
  tenant_id: number;
  company_id: number | null;
  created_by: number;
  name: string;
  report_name: string;
  filters: Record<string, unknown>;
  frequency: string;
  run_time: string;
  day_of_week: number | null;
  day_of_month: number | null;
  recipients: string[];
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
}

interface Delivery {
  id: number;
  scheduleId: number;
  reportName: string;
  status: string;
  rowCount: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  scheduleName: string;
  createdByEmail: string;
}

interface Filter {
  column: string;
  value: string;
}

const PAGE_SIZE = 100;

const GROUPS: { prefix: string; label: string }[] = [
  { prefix: 'finance-', label: 'Finance' },
  { prefix: 'sales-', label: 'Sales' },
  { prefix: 'inventory-', label: 'Inventory' },
  { prefix: 'production-', label: 'Manufacturing' },
  { prefix: 'qr-', label: 'QR & Traceability' },
  { prefix: 'hr-', label: 'HR & Payroll' },
];

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function columnsOfSource(sources: AnalyticsSource[], name: string): string[] {
  return sources.find((s) => s.name === name)?.columns ?? [];
}

function toggleIn<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function groupOf(name: string): string {
  for (const g of GROUPS) {
    if (name.startsWith(g.prefix)) return g.label;
  }
  return 'Other';
}

function filterableColumns(columns: string[]): string[] {
  return columns.filter(
    (c) => !/^(id|tenant_id|company_id|branch_id)$/.test(c) && !/_at$/.test(c) && !/_by$/.test(c)
  );
}

function filtersToQuery(filters: Filter[]): string {
  return filters
    .map((f) => encodeURIComponent(f.column) + '=' + encodeURIComponent(f.value))
    .join('&');
}

function filtersToRecord(filters: Filter[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of filters) out[f.column] = f.value;
  return out;
}

function keyedRow(row: Record<string, unknown>, i: number): Record<string, unknown> {
  const id = row.id;
  const n = typeof id === 'number' ? id : Number(id);
  if (id === '' || id == null || !Number.isFinite(n)) return { ...row, id: i + 1 };
  return { ...row, id: n };
}

function buildMeta(def: ReportDef, rows: Record<string, unknown>[]): EntityMeta {
  const columns = Object.keys(rows[0] ?? {}).map((camel) => ({
    camel,
    name: camel.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()),
    dataType: 'text',
    nullable: true,
    hasDefault: false,
    writable: false,
  }));
  return {
    table: def.name,
    module: 'reports',
    resource: def.name,
    label: def.label,
    entityType: null,
    codeColumn: null,
    statusColumn: null,
    searchable: [],
    qrEntityType: null,
    columns,
    writable: [],
  };
}

export default function Reports() {
  const { user } = useAuth();
  const query = useHashQuery();
  const reportName = query.get('report');

  const [reports, setReports] = useState<ReportDef[]>([]);
  const [def, setDef] = useState<ReportDef | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [meta, setMeta] = useState<EntityMeta | null>(null);
  const [reportMeta, setReportMeta] = useState<ReportMeta | null>(null);
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [filterColumn, setFilterColumn] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [views, setViews] = useState<SavedView[]>([]);
  const [showSave, setShowSave] = useState(false);
  const [viewName, setViewName] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [showSchedule, setShowSchedule] = useState(false);
  const [schedName, setSchedName] = useState('');
  const [frequency, setFrequency] = useState('DAILY');
  const [runTime, setRunTime] = useState('08:00');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [recipients, setRecipients] = useState('');
  const [schedBusy, setSchedBusy] = useState(false);

  const canExec = can(user, 'reports.executive.view');
  const canViews = can(user, 'reports.saved.view');
  const canCreateView = can(user, 'reports.saved.create');
  const canSchedule = can(user, 'reports.saved.schedule');
  const canDeleteView = can(user, 'reports.saved.delete');

  const canKpis = can(user, 'reports.kpis.view');
  const canCreateKpi = can(user, 'reports.kpis.create');
  const canMeasureKpi = can(user, 'reports.kpis.measure');
  const canDashboards = can(user, 'reports.dashboards.view');
  const canCreateDashboard = can(user, 'reports.dashboards.create');
  const canUpdateDashboard = can(user, 'reports.dashboards.update');
  const canBuilder = can(user, 'reports.builder.view');
  const canCreateCustom = can(user, 'reports.builder.create');
  const canRunCustom = can(user, 'reports.builder.run');

  const [tab, setTab] = useState<'center' | 'kpis' | 'dashboards' | 'builder'>(
    () => {
      const t = query.get('tab');
      return t === 'kpis' || t === 'dashboards' || t === 'builder' ? t : 'center';
    }
  );

  const [kpiList, setKpiList] = useState<AnalyticsKpi[]>([]);
  const [sources, setSources] = useState<AnalyticsSource[]>([]);
  const [dashboards, setDashboards] = useState<AnalyticsDashboard[]>([]);
  const [customs, setCustoms] = useState<CustomReport[]>([]);
  const [openDash, setOpenDash] = useState<AnalyticsDashboard | null>(null);
  const [customRows, setCustomRows] = useState<Record<string, unknown>[]>([]);
  const [customMeta, setCustomMeta] = useState<EntityMeta | null>(null);
  const [customBusy, setCustomBusy] = useState(false);

  const [kpiForm, setKpiForm] = useState({
    key: '',
    name: '',
    description: '',
    dataSource: '',
    valueColumn: '',
    aggregation: 'SUM',
    periodColumn: '',
    unit: 'number',
    frequency: 'MONTHLY',
    direction: 'HIGHER_BETTER',
    targetValue: '',
    warningThreshold: '',
    criticalThreshold: '',
  });

  const [dashName, setDashName] = useState('');
  const [dashDesc, setDashDesc] = useState('');
  const [widgetType, setWidgetType] = useState('KPI');
  const [widgetKpi, setWidgetKpi] = useState('');
  const [widgetReport, setWidgetReport] = useState('');
  const [widgetTitle, setWidgetTitle] = useState('');

  const [customName, setCustomName] = useState('');
  const [customDesc, setCustomDesc] = useState('');
  const [customSource, setCustomSource] = useState('');
  const [customViz, setCustomViz] = useState('table');
  const [customCols, setCustomCols] = useState<string[]>([]);
  const [customGroup, setCustomGroup] = useState<string[]>([]);
  const [customSortCol, setCustomSortCol] = useState('');
  const [customSortDir, setCustomSortDir] = useState('asc');
  const [customLimit, setCustomLimit] = useState(100);
  const [customError, setCustomError] = useState('');

  const loadKpis = useCallback(async () => {
    if (!canKpis) return;
    try {
      const r = await api<{ data: AnalyticsKpi[] }>('/api/reports/kpis');
      setKpiList(r.data);
    } catch {
      /* non-fatal */
    }
  }, [canKpis]);

  const loadSources = useCallback(async () => {
    if (!canBuilder) return;
    try {
      const r = await api<{ data: AnalyticsSource[] }>('/api/reports/sources');
      setSources(r.data);
    } catch {
      /* non-fatal */
    }
  }, [canBuilder]);

  const loadDashboards = useCallback(async () => {
    if (!canDashboards) return;
    try {
      const r = await api<{ data: AnalyticsDashboard[] }>('/api/reports/dashboards');
      setDashboards(r.data);
    } catch {
      /* non-fatal */
    }
  }, [canDashboards]);

  const loadCustoms = useCallback(async () => {
    if (!canBuilder) return;
    try {
      const r = await api<{ data: CustomReport[] }>('/api/reports/custom');
      setCustoms(r.data);
    } catch {
      /* non-fatal */
    }
  }, [canBuilder]);

  useEffect(() => {
    if (tab === 'kpis') {
      loadKpis();
      loadSources();
    }
    if (tab === 'dashboards') {
      loadDashboards();
      setOpenDash(null);
    }
    if (tab === 'builder') {
      loadSources();
      loadCustoms();
      setCustomRows([]);
      setCustomMeta(null);
    }
  }, [tab, loadKpis, loadDashboards, loadSources, loadCustoms]);

  const createKpi = async () => {
    if (!kpiForm.key.trim() || !kpiForm.name.trim() || !kpiForm.dataSource) return;
    setError('');
    try {
      await api('/api/reports/kpis', {
        method: 'POST',
        body: JSON.stringify({
          key: kpiForm.key.trim().toLowerCase(),
          name: kpiForm.name.trim(),
          description: kpiForm.description.trim(),
          dataSource: kpiForm.dataSource,
          valueColumn: kpiForm.valueColumn || undefined,
          aggregation: kpiForm.aggregation,
          periodColumn: kpiForm.periodColumn || undefined,
          unit: kpiForm.unit,
          frequency: kpiForm.frequency,
          direction: kpiForm.direction,
          targetValue: kpiForm.targetValue === '' ? undefined : Number(kpiForm.targetValue),
          warningThreshold: kpiForm.warningThreshold === '' ? undefined : Number(kpiForm.warningThreshold),
          criticalThreshold: kpiForm.criticalThreshold === '' ? undefined : Number(kpiForm.criticalThreshold),
        }),
      });
      setKpiForm((f) => ({ ...f, key: '', name: '', description: '', targetValue: '', warningThreshold: '', criticalThreshold: '' }));
      await loadKpis();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create KPI');
    }
  };

  const measureKpi = async (id: number) => {
    setError('');
    try {
      await api('/api/reports/kpis/' + id + '/measure', { method: 'POST', body: JSON.stringify({}) });
      await loadKpis();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to measure KPI');
    }
  };

  const archiveKpi = async (id: number) => {
    setError('');
    try {
      await api('/api/reports/kpis/' + id, { method: 'DELETE' });
      await loadKpis();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to archive KPI');
    }
  };

  const createDashboard = async () => {
    if (!dashName.trim()) return;
    setError('');
    try {
      await api('/api/reports/dashboards', {
        method: 'POST',
        body: JSON.stringify({
          name: dashName.trim(),
          description: dashDesc.trim(),
          isPersonal: false,
          widgets: [],
        }),
      });
      setDashName('');
      setDashDesc('');
      await loadDashboards();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create dashboard');
    }
  };

  const archiveDashboard = async (id: number) => {
    setError('');
    try {
      await api('/api/reports/dashboards/' + id, { method: 'DELETE' });
      await loadDashboards();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to archive dashboard');
    }
  };

  const openDashboard = async (id: number) => {
    setError('');
    try {
      const r = await api<{ data: AnalyticsDashboard }>('/api/reports/dashboards/' + id);
      setOpenDash(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open dashboard');
    }
  };

  const addWidget = () => {
    if (!openDash) return;
    const title =
      widgetTitle.trim() ||
      (widgetType === 'KPI'
        ? kpiList.find((k) => k.id === Number(widgetKpi))?.name ?? 'KPI'
        : widgetType === 'REPORT'
          ? labelOf(widgetReport)
          : 'Widget');
    const w: AnalyticsWidget = {
      widgetType,
      title,
      kpiId: widgetType === 'KPI' && widgetKpi ? Number(widgetKpi) : null,
      reportName: widgetType === 'REPORT' && widgetReport ? widgetReport : null,
      config: {},
      position: { x: 0, y: (openDash.widgets?.length ?? 0) * 3 },
      size: { w: 6, h: 3 },
    };
    setOpenDash({ ...openDash, widgets: [...(openDash.widgets ?? []), w] });
    setWidgetTitle('');
    setWidgetKpi('');
    setWidgetReport('');
  };

  const removeWidget = (i: number) => {
    if (!openDash) return;
    setOpenDash({ ...openDash, widgets: (openDash.widgets ?? []).filter((_, idx) => idx !== i) });
  };

  const saveWidgets = async () => {
    if (!openDash) return;
    setError('');
    try {
      const widgets = (openDash.widgets ?? []).map((w) => ({
        widgetType: w.widgetType,
        title: w.title,
        kpiId: w.kpiId,
        reportName: w.reportName,
        config: w.config,
        position: w.position,
        size: w.size,
      }));
      const r = await api<{ data: AnalyticsDashboard }>(
        '/api/reports/dashboards/' + openDash.id,
        { method: 'PATCH', body: JSON.stringify({ widgets }) }
      );
      setOpenDash(r.data);
      await loadDashboards();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save widgets');
    }
  };

  const createCustom = async () => {
    if (!customName.trim() || !customSource || customCols.length === 0) {
      setCustomError('Report name, data source and at least one column are required.');
      return;
    }
    setError('');
    try {
      await api('/api/reports/custom', {
        method: 'POST',
        body: JSON.stringify({
          name: customName.trim(),
          description: customDesc.trim(),
          dataSource: customSource,
          visualization: customViz,
          config: {
            columns: customCols,
            groupBy: customGroup,
            sort: customSortCol ? { column: customSortCol, direction: customSortDir } : null,
            limit: customLimit,
          },
        }),
      });
      setCustomName('');
      setCustomDesc('');
      setCustomError('');
      await loadCustoms();
    } catch (e) {
      setCustomError(e instanceof Error ? e.message : 'Failed to create custom report');
    }
  };

  const runCustom = async (id: number) => {
    setCustomBusy(true);
    setError('');
    try {
      const r = await api<{
        data: { rows: Record<string, unknown>[]; count: number; columns: string[] };
      }>('/api/reports/custom/' + id + '/run', { method: 'POST', body: JSON.stringify({}) });
      setCustomRows(r.data.rows.map(keyedRow));
      setCustomMeta({
        table: 'custom',
        module: 'reports',
        resource: 'custom',
        label: 'Custom Report',
        entityType: null,
        codeColumn: null,
        statusColumn: null,
        searchable: [],
        qrEntityType: null,
        columns: r.data.columns.map((c) => ({
          camel: c,
          name: c.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()),
          dataType: 'text',
          nullable: true,
          hasDefault: false,
          writable: false,
        })),
        writable: [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run custom report');
    } finally {
      setCustomBusy(false);
    }
  };

  const archiveCustom = async (id: number) => {
    setError('');
    try {
      await api('/api/reports/custom/' + id, { method: 'DELETE' });
      await loadCustoms();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to archive custom report');
    }
  };

  const onDataSourceChange = (ds: string) => {
    setCustomSource(ds);
    setCustomCols([]);
    setCustomGroup([]);
    setCustomSortCol('');
  };

  const onKpiSourceChange = (ds: string) => {
    setKpiForm((f) => ({ ...f, dataSource: ds, valueColumn: '', periodColumn: '' }));
  };

  useEffect(() => {
    api<{ data: ReportDef[] }>('/api/reports')
      .then((r) => setReports(r.data.map((d) => ({ ...d, columns: d.columns ?? [] }))))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load reports'));
  }, []);

  useEffect(() => {
    if (!canExec) return;
    let alive = true;
    api<{ data: ExecData }>('/api/analytics/executive')
      .then((r) => {
        if (!alive) return;
        const d = r.data;
        setKpis([
          {
            key: 'trial-balance',
            label: 'Trial Balance',
            value: d.financial.trialBalance,
            format: 'money',
            report: 'trial-balance',
            sub: 'Total net balance',
          },
          {
            key: 'ar-aging',
            label: 'Receivables',
            value: d.financial.receivables,
            format: 'money',
            report: 'ar-aging',
            sub: 'Customer balances',
          },
          {
            key: 'ap-aging',
            label: 'Payables',
            value: d.financial.payables,
            format: 'money',
            report: 'ap-aging',
            sub: 'Supplier balances',
          },
          {
            key: 'payroll-summary',
            label: 'Payroll (Month)',
            value: d.financial.monthGrossPayroll,
            format: 'money',
            report: 'payroll-summary',
            sub: 'Gross payroll',
          },
          {
            key: 'sales-by-month',
            label: 'Revenue (Month)',
            value: d.commercial.monthRevenue,
            format: 'money',
            report: 'sales-by-month',
            sub:
              d.commercial.revenueGrowthPct === null
                ? 'This month'
                : (d.commercial.revenueGrowthPct >= 0 ? '+' : '') +
                  d.commercial.revenueGrowthPct +
                  '% MoM',
          },
          {
            key: 'production-yield',
            label: 'Production Yield',
            value: d.manufacturing.monthYieldPct,
            format: 'percent',
            report: 'production-yield',
            sub: d.manufacturing.monthProduced + ' produced',
          },
          {
            key: 'work-order-summary',
            label: 'Work Orders',
            value: d.manufacturing.workOrdersInProgress,
            format: 'number',
            report: 'work-order-summary',
            sub: d.manufacturing.workOrdersCompleted + ' completed',
          },
          {
            key: 'stock-value',
            label: 'Stock Value',
            value: d.inventory.stockValue,
            format: 'money',
            report: 'stock-value',
            sub: d.inventory.stockLines + ' lines',
          },
          {
            key: 'qr-lineage',
            label: 'QR Scans',
            value: d.traceability.qrScans,
            format: 'number',
            report: 'qr-lineage',
            sub: 'Traceability events',
          },
          {
            key: 'delivery-rate',
            label: 'Delivery Rate',
            value: d.logistics.deliveryRatePct,
            format: 'percent',
            report: '',
            sub:
              d.logistics.deliveriesDelivered +
              ' delivered / ' +
              d.logistics.deliveriesOutstanding +
              ' outstanding',
          },
        ]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [canExec]);

  useEffect(() => {
    if (!reportName) {
      setDef(null);
      return;
    }
    if (reports.length === 0) return;
    const found = reports.find((r) => r.name === reportName);
    if (found) {
      setDef(found);
      setPage(1);
      setFilters([]);
      setFilterColumn(filterableColumns(found.columns ?? [])[0] ?? '');
      setError('');
    } else {
      setError('Report not found: ' + reportName);
    }
  }, [reportName, reports]);

  const queryString = useMemo(() => {
    const fq = filtersToQuery(filters);
    return '?page=' + page + '&pageSize=' + PAGE_SIZE + (fq ? '&' + fq : '');
  }, [page, filters]);

  useEffect(() => {
    if (!def) {
      setRows([]);
      setMeta(null);
      setReportMeta(null);
      return;
    }
    let alive = true;
    setBusy(true);
    api<{ data: Record<string, unknown>[]; meta: ReportMeta }>(
      '/api/reports/' + def.name + queryString
    )
      .then((r) => {
        if (!alive) return;
        setRows(r.data.map(keyedRow));
        setMeta(buildMeta(def, r.data));
        setReportMeta(r.meta);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load report data');
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [def, queryString]);

  const filterQuery = useMemo(() => filtersToQuery(filters), [filters]);

  useEffect(() => {
    if (!def) {
      setSummary(null);
      return;
    }
    let alive = true;
    api<{ data: SummaryResult }>(
      '/api/reports/' + def.name + '/summary' + (filterQuery ? '?' + filterQuery : '')
    )
      .then((r) => {
        if (alive) setSummary(r.data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [def, filterQuery]);

  const loadViews = useCallback(async () => {
    if (!def || !canViews) {
      setViews([]);
      return;
    }
    try {
      const r = await api<{ data: SavedView[] }>(
        '/api/reports/saved-views?report=' + encodeURIComponent(def.name)
      );
      setViews(r.data);
    } catch {
      /* non-fatal */
    }
  }, [def, canViews]);

  useEffect(() => {
    loadViews();
  }, [loadViews]);

  const loadSched = useCallback(async () => {
    if (!canSchedule) {
      setSchedules([]);
      setDeliveries([]);
      return;
    }
    try {
      const [s, d] = await Promise.all([
        api<{ data: Schedule[] }>('/api/reports/schedules'),
        api<{ data: Delivery[] }>('/api/reports/deliveries'),
      ]);
      setSchedules(s.data);
      setDeliveries(d.data);
    } catch {
      /* non-fatal */
    }
  }, [canSchedule]);

  useEffect(() => {
    loadSched();
  }, [loadSched]);

  const addFilter = () => {
    const value = filterValue.trim();
    if (!filterColumn || value === '') return;
    setFilters((prev) => [
      ...prev.filter((f) => f.column !== filterColumn),
      { column: filterColumn, value },
    ]);
    setFilterValue('');
    setPage(1);
  };

  const removeFilter = (column: string) => {
    setFilters((prev) => prev.filter((f) => f.column !== column));
    setPage(1);
  };

  const clearFilters = () => {
    setFilters([]);
    setPage(1);
  };

  const applyView = (v: SavedView) => {
    const cols = new Set(def?.columns ?? []);
    const next: Filter[] = Object.entries(v.filters ?? {})
      .filter(([c]) => cols.has(c))
      .map(([column, value]) => ({ column, value: String(value) }));
    setFilters(next);
    setPage(1);
  };

  const saveView = async () => {
    if (!def || viewName.trim() === '') return;
    setSaveBusy(true);
    try {
      await api('/api/reports/saved-views', {
        method: 'POST',
        body: JSON.stringify({
          name: viewName.trim(),
          report_name: def.name,
          filters: filtersToRecord(filters),
          is_default: views.length === 0,
        }),
      });
      setShowSave(false);
      setViewName('');
      await loadViews();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save view');
    } finally {
      setSaveBusy(false);
    }
  };

  const setDefaultView = async (v: SavedView) => {
    try {
      await api('/api/reports/saved-views/' + v.id, {
        method: 'PATCH',
        body: JSON.stringify({ is_default: true }),
      });
      await loadViews();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update view');
    }
  };

  const deleteView = async (v: SavedView) => {
    try {
      await api('/api/reports/saved-views/' + v.id, { method: 'DELETE' });
      await loadViews();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete view');
    }
  };

  const saveSchedule = async () => {
    if (!def) return;
    setSchedBusy(true);
    try {
      await api('/api/reports/schedules', {
        method: 'POST',
        body: JSON.stringify({
          name: schedName.trim() || def.label + ' schedule',
          report_name: def.name,
          filters: filtersToRecord(filters),
          frequency,
          run_time: runTime,
          day_of_week: frequency === 'WEEKLY' ? dayOfWeek : null,
          day_of_month: frequency === 'MONTHLY' ? dayOfMonth : null,
          recipients: recipients
            .split(/[\s,;]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      setShowSchedule(false);
      setSchedName('');
      setRecipients('');
      await loadSched();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create schedule');
    } finally {
      setSchedBusy(false);
    }
  };

  const schedAction = async (id: number, action: 'pause' | 'resume' | 'run-now') => {
    try {
      await api('/api/reports/schedules/' + id + '/' + action, { method: 'POST' });
      await loadSched();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update schedule');
    }
  };

  const deleteSchedule = async (id: number) => {
    try {
      await api('/api/reports/schedules/' + id, { method: 'DELETE' });
      await loadSched();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete schedule');
    }
  };

  const retryDelivery = async (id: number) => {
    try {
      await api('/api/reports/deliveries/' + id + '/retry', { method: 'POST' });
      await loadSched();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to retry delivery');
    }
  };

  const exportFmt = async (fmt: string) => {
    if (!def) return;
    setError('');
    try {
      const fq = filtersToQuery(filters);
      const path = '/api/reports/' + def.name + '?pageSize=500&format=' + fmt + (fq ? '&' + fq : '');
      const res = await fetch(path, {
        headers: { Authorization: 'Bearer ' + (getToken() ?? '') },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body && body.error && body.error.message
            ? body.error.message
            : 'Export failed (' + res.status + ')'
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (fmt === 'print') {
        const win = window.open(url, '_blank');
        if (!win) throw new Error('Popup blocked - allow popups for print.');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return;
      }
      const ext = fmt === 'xlsx' ? 'xlsx' : fmt;
      const a = document.createElement('a');
      a.href = url;
      a.download = def.name + '.' + ext;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!user) return <PageLoader />;
  if (!can(user, 'reports.dashboards.view')) return <AccessDenied path="/reports" />;

  const visible = reports.filter((r) => can(user, r.permission));
  const groupLabels = Array.from(new Set(visible.map((r) => groupOf(r.name))));
  const canExport = def ? can(user, def.permission.replace('.view', '.export')) : false;
  const labelOf = (name: string) => reports.find((r) => r.name === name)?.label ?? titleCase(name);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Reports &amp; Analytics</h1>
        <p className="muted">Live queries against the ERP views - filter, drill in, schedule and export.</p>
      </header>

      {error && <ErrorBanner error={error} />}

      <div className="analytics-tabs">
        <button
          className={`analytics-tab ${tab === 'center' ? 'active' : ''}`}
          onClick={() => setTab('center')}
        >
          Report Center
        </button>
        {canKpis && (
          <button
            className={`analytics-tab ${tab === 'kpis' ? 'active' : ''}`}
            onClick={() => setTab('kpis')}
          >
            KPI Engine
          </button>
        )}
        {canDashboards && (
          <button
            className={`analytics-tab ${tab === 'dashboards' ? 'active' : ''}`}
            onClick={() => setTab('dashboards')}
          >
            Dashboards
          </button>
        )}
        {canBuilder && (
          <button
            className={`analytics-tab ${tab === 'builder' ? 'active' : ''}`}
            onClick={() => setTab('builder')}
          >
            Report Builder
          </button>
        )}
      </div>

      {canExec && kpis.length > 0 && (
        <div className="kpi-grid">
          {kpis.map((k) => (
            <button
              key={k.key}
              className="kpi-card"
              onClick={() => {
                setTab('center');
                if (k.report) navigate('/reports', { query: { report: k.report } });
              }}
            >
              <span className="kpi-label">{k.label}</span>
              <span className="kpi-value">
                {k.value === null || k.value === undefined
                  ? '-'
                  : k.format === 'money'
                    ? fmtMoney(k.value)
                    : k.format === 'percent'
                      ? fmtNum(k.value) + '%'
                      : fmtNum(k.value)}
              </span>
              {k.sub ? <span className="kpi-sub">{k.sub}</span> : null}
            </button>
          ))}
        </div>
      )}

      {tab === 'center' && (
        <div className="reports-layout">
        <div className="reports-nav card">
          <div className="reports-nav-head">Report Center</div>
          {visible.length === 0 && (
            <div className="reports-empty">No reports available in your scope.</div>
          )}
          {groupLabels.map((label) => (
            <div key={label}>
              <div className="reports-group-label">{label}</div>
              {visible
                .filter((r) => groupOf(r.name) === label)
                .map((r) => (
                  <button
                    key={r.name}
                    className={`report-item ${def?.name === r.name ? 'active' : ''}`}
                    onClick={() => {
                      setTab('center');
                      navigate('/reports', { query: { report: r.name } });
                    }}
                  >
                    {r.label}
                  </button>
                ))}
            </div>
          ))}
        </div>

        <div className="reports-main">
          {!def && (
            <div className="card">
              <EmptyState
                title="Select a report"
                body="Choose a report from the Report Center, or click a KPI to open its report."
              />
            </div>
          )}

          {def && (
            <>
              <div className="card report-head">
                <div>
                  <h3 className="report-title">{def.label}</h3>
                  <div className="report-meta-line">
                    {reportMeta
                      ? 'Issued by ' + reportMeta.issuedBy + ' - ' + fmtDate(reportMeta.issuedAt)
                      : 'Loading report metadata...'}
                  </div>
                </div>
                <div className="head-actions">
                  {canCreateView && (
                    <button className="btn btn-sm" onClick={() => setShowSave(true)}>
                      Save View
                    </button>
                  )}
                  {canSchedule && (
                    <button className="btn btn-sm" onClick={() => setShowSchedule(true)}>
                      Schedule
                    </button>
                  )}
                  {canExport && (
                    <>
                      <button className="btn btn-sm" onClick={() => exportFmt('csv')}>CSV</button>
                      <button className="btn btn-sm" onClick={() => exportFmt('xlsx')}>XLSX</button>
                      <button className="btn btn-sm" onClick={() => exportFmt('pdf')}>PDF</button>
                      <button className="btn btn-sm" onClick={() => exportFmt('json')}>JSON</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => exportFmt('print')}>
                        Print
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="card filter-bar">
                <select value={filterColumn} onChange={(e) => setFilterColumn(e.target.value)}>
                  {filterableColumns(def.columns ?? []).map((c) => (
                    <option key={c} value={c}>
                      {titleCase(c)}
                    </option>
                  ))}
                </select>
                <input
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                  placeholder="Filter value..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addFilter();
                  }}
                />
                <button className="btn btn-sm" onClick={addFilter}>
                  Add Filter
                </button>
                {filters.length > 0 && (
                  <button className="btn btn-sm btn-ghost" onClick={clearFilters}>
                    Clear
                  </button>
                )}
              </div>

              {filters.length > 0 && (
                <div className="filter-chips">
                  {filters.map((f) => (
                    <span className="filter-chip" key={f.column}>
                      <b>{titleCase(f.column)}</b> {f.value}
                      <button onClick={() => removeFilter(f.column)} aria-label={'Remove ' + f.column}>
                        x
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {summary && (
                <div className="summary-chips">
                  <span className="summary-chip">
                    Rows <b>{fmtNum(summary.total)}</b>
                  </span>
                  {summary.sums.map((s) => (
                    <span className="summary-chip" key={s.column}>
                      {titleCase(s.column)} <b>{fmtMoney(s.value)}</b>
                    </span>
                  ))}
                  {summary.dateRange && (
                    <span className="summary-chip">
                      {titleCase(summary.dateRange.column)}{' '}
                      <b>
                        {fmtDate(summary.dateRange.min)} - {fmtDate(summary.dateRange.max)}
                      </b>
                    </span>
                  )}
                </div>
              )}

              {canViews && views.length > 0 && (
                <>
                  <div className="section-title">Saved Views</div>
                  <div className="views-row">
                    {views.map((v) => (
                      <span key={v.id} className={`view-chip ${v.isDefault ? 'active' : ''}`}>
                        <button className="name-btn" onClick={() => applyView(v)}>
                          {v.name}
                        </button>
                        {v.isDefault && (
                          <span className="view-default" title="Default view">
                            *
                          </span>
                        )}
                        {!v.isDefault && canCreateView && (
                          <button className="btn btn-xs" onClick={() => setDefaultView(v)}>
                            Default
                          </button>
                        )}
                        {canDeleteView && (
                          <button className="btn btn-xs" onClick={() => deleteView(v)}>
                            x
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                </>
              )}

              <div className="card">
                {busy ? (
                  <PageLoader label="Running report..." />
                ) : meta ? (
                  <DataTable meta={meta} rows={rows} onOpen={() => undefined} />
                ) : null}
              </div>

              <Pager page={page} pageSize={PAGE_SIZE} total={summary?.total ?? 0} onPage={setPage} />

              {canSchedule && (
                <div className="card card-pad">
                  <div className="section-title">Schedules</div>
                  {schedules.length === 0 && (
                    <p className="muted">No schedules yet. Use Schedule to run reports on a recurring basis.</p>
                  )}
                  {schedules.map((s) => (
                    <div className="sched-card" key={s.id}>
                      <div>
                        <strong>{s.name}</strong>
                        <div className="sched-meta">
                          {labelOf(s.report_name)} - {s.frequency} - {s.run_time}
                          {s.next_run_at ? ' - next ' + fmtDate(s.next_run_at) : ''}
                          {s.last_run_at ? ' - last ' + fmtDate(s.last_run_at) : ''}
                        </div>
                      </div>
                      <div className="head-actions">
                        <Badge value={s.last_status} />
                        <button
                          className="btn btn-xs"
                          onClick={() => schedAction(s.id, s.enabled ? 'pause' : 'resume')}
                        >
                          {s.enabled ? 'Pause' : 'Resume'}
                        </button>
                        <button className="btn btn-xs" onClick={() => schedAction(s.id, 'run-now')}>
                          Run Now
                        </button>
                        <button className="btn btn-xs btn-danger" onClick={() => deleteSchedule(s.id)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}

                  <div className="section-title">Deliveries</div>
                  {deliveries.length === 0 && <p className="muted">No deliveries recorded yet.</p>}
                  {deliveries.map((d) => (
                    <div className="delivery-row" key={d.id}>
                      <Badge value={d.status} />
                      <span>
                        <strong>{d.reportName}</strong> - {d.scheduleName}
                      </span>
                      {d.rowCount != null && <span className="muted">{fmtNum(d.rowCount)} rows</span>}
                      {d.error && <span className="muted">{d.error}</span>}
                      <span className="muted">{fmtDate(d.createdAt)}</span>
                      {d.status === 'FAILED' && (
                        <button className="btn btn-xs" onClick={() => retryDelivery(d.id)}>
                          Retry
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      )}

      {tab === 'kpis' && (
        <div className="card card-pad">
          <div className="section-title">KPI Engine</div>
          {canCreateKpi && (
            <>
              <div className="form-grid">
                <div className="field">
                  <label>Key (lowercase, underscores)</label>
                  <input
                    value={kpiForm.key}
                    onChange={(e) => setKpiForm((f) => ({ ...f, key: e.target.value }))}
                    placeholder="e.g. on_time_delivery_rate"
                  />
                </div>
                <div className="field">
                  <label>Name</label>
                  <input
                    value={kpiForm.name}
                    onChange={(e) => setKpiForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="On-Time Delivery Rate"
                  />
                </div>
                <div className="field">
                  <label>Description</label>
                  <input
                    value={kpiForm.description}
                    onChange={(e) => setKpiForm((f) => ({ ...f, description: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label>Data Source</label>
                  <select
                    value={kpiForm.dataSource}
                    onChange={(e) => onKpiSourceChange(e.target.value)}
                  >
                    <option value="">Select source...</option>
                    {sources.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Value Column</label>
                  <select
                    value={kpiForm.valueColumn}
                    onChange={(e) => setKpiForm((f) => ({ ...f, valueColumn: e.target.value }))}
                  >
                    <option value="">Select column...</option>
                    {columnsOfSource(sources, kpiForm.dataSource).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Aggregation</label>
                  <select
                    value={kpiForm.aggregation}
                    onChange={(e) => setKpiForm((f) => ({ ...f, aggregation: e.target.value }))}
                  >
                    <option value="SUM">SUM</option>
                    <option value="COUNT">COUNT</option>
                    <option value="AVG">AVG</option>
                    <option value="MAX">MAX</option>
                    <option value="MIN">MIN</option>
                  </select>
                </div>
                <div className="field">
                  <label>Period Column</label>
                  <select
                    value={kpiForm.periodColumn}
                    onChange={(e) => setKpiForm((f) => ({ ...f, periodColumn: e.target.value }))}
                  >
                    <option value="">None</option>
                    {columnsOfSource(sources, kpiForm.dataSource)
                      .filter((c) => /date|month|period|_at$/.test(c))
                      .map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="field">
                  <label>Frequency</label>
                  <select
                    value={kpiForm.frequency}
                    onChange={(e) => setKpiForm((f) => ({ ...f, frequency: e.target.value }))}
                  >
                    <option value="DAILY">Daily</option>
                    <option value="WEEKLY">Weekly</option>
                    <option value="MONTHLY">Monthly</option>
                    <option value="QUARTERLY">Quarterly</option>
                    <option value="ANNUAL">Annual</option>
                  </select>
                </div>
                <div className="field">
                  <label>Direction</label>
                  <select
                    value={kpiForm.direction}
                    onChange={(e) => setKpiForm((f) => ({ ...f, direction: e.target.value }))}
                  >
                    <option value="HIGHER_BETTER">Higher is better</option>
                    <option value="LOWER_BETTER">Lower is better</option>
                  </select>
                </div>
                <div className="field">
                  <label>Target Value</label>
                  <input
                    type="number"
                    value={kpiForm.targetValue}
                    onChange={(e) => setKpiForm((f) => ({ ...f, targetValue: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label>Warning Threshold (%)</label>
                  <input
                    type="number"
                    value={kpiForm.warningThreshold}
                    onChange={(e) =>
                      setKpiForm((f) => ({ ...f, warningThreshold: e.target.value }))
                    }
                    placeholder="90"
                  />
                </div>
                <div className="field">
                  <label>Critical Threshold (%)</label>
                  <input
                    type="number"
                    value={kpiForm.criticalThreshold}
                    onChange={(e) =>
                      setKpiForm((f) => ({ ...f, criticalThreshold: e.target.value }))
                    }
                    placeholder="75"
                  />
                </div>
              </div>
              <div className="head-actions">
                <button
                  className="btn btn-primary"
                  disabled={!kpiForm.key.trim() || !kpiForm.name.trim() || !kpiForm.dataSource}
                  onClick={createKpi}
                >
                  Create KPI
                </button>
              </div>
            </>
          )}

          <div className="section-title">KPIs</div>
          {kpiList.length === 0 && <p className="muted">No KPIs defined yet.</p>}
          {kpiList.map((k) => (
            <div className="sched-card" key={k.id}>
              <div>
                <strong>{k.name}</strong> <Badge value={k.latestStatus ?? 'NO_DATA'} />
                <div className="sched-meta">
                  {k.key} - {k.dataSource}.{k.valueColumn ?? '*'}
                  {k.aggregation ? ' ' + k.aggregation : ''}
                  {k.targetValue != null ? ' target ' + fmtNum(k.targetValue) : ''}
                  {k.latestValue != null ? ' last ' + fmtNum(k.latestValue) : ''}
                  {k.latestMeasuredAt ? ' - ' + fmtDate(k.latestMeasuredAt) : ''}
                </div>
                {k.description && <div className="muted">{k.description}</div>}
              </div>
              <div className="head-actions">
                {canMeasureKpi && (
                  <button className="btn btn-xs" onClick={() => measureKpi(k.id)}>
                    Measure Now
                  </button>
                )}
                <button className="btn btn-xs btn-danger" onClick={() => archiveKpi(k.id)}>
                  Archive
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'dashboards' && (
        <div className="card card-pad">
          <div className="section-title">Dashboards</div>
          {canCreateDashboard && (
            <div className="form-grid">
              <div className="field">
                <label>Dashboard Name</label>
                <input
                  value={dashName}
                  onChange={(e) => setDashName(e.target.value)}
                  placeholder="Executive Overview"
                />
              </div>
              <div className="field">
                <label>Description</label>
                <input value={dashDesc} onChange={(e) => setDashDesc(e.target.value)} />
              </div>
              <div className="field head-actions">
                <button
                  className="btn btn-primary"
                  disabled={!dashName.trim()}
                  onClick={createDashboard}
                >
                  Create Dashboard
                </button>
              </div>
            </div>
          )}

          {dashboards.length === 0 && <p className="muted">No dashboards yet.</p>}
          {dashboards.map((d) => (
            <div className="sched-card" key={d.id}>
              <div>
                <strong>{d.name}</strong>{' '}
                {d.isDefault ? <Badge value="DEFAULT" /> : null}
                <div className="sched-meta">
                  {d.description || 'No description'} - {d.widgetCount} widgets
                </div>
              </div>
              <div className="head-actions">
                <button className="btn btn-xs" onClick={() => openDashboard(d.id)}>
                  Open
                </button>
                <button className="btn btn-xs btn-danger" onClick={() => archiveDashboard(d.id)}>
                  Archive
                </button>
              </div>
            </div>
          ))}

          {openDash && (
            <div className="card card-pad">
              <div className="section-title">
                {openDash.name} - Widgets ({openDash.widgets?.length ?? 0})
              </div>
              {canUpdateDashboard && (
                <div className="form-grid">
                  <div className="field">
                    <label>Widget Type</label>
                    <select value={widgetType} onChange={(e) => setWidgetType(e.target.value)}>
                      <option value="KPI">KPI</option>
                      <option value="CHART">Chart</option>
                      <option value="TABLE">Table</option>
                      <option value="REPORT">Report</option>
                      <option value="TREND">Trend</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>KPI (for KPI widgets)</label>
                    <select value={widgetKpi} onChange={(e) => setWidgetKpi(e.target.value)}>
                      <option value="">None</option>
                      {kpiList.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Report (for REPORT widgets)</label>
                    <select value={widgetReport} onChange={(e) => setWidgetReport(e.target.value)}>
                      <option value="">None</option>
                      {visible.map((r) => (
                        <option key={r.name} value={r.name}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Title</label>
                    <input
                      value={widgetTitle}
                      onChange={(e) => setWidgetTitle(e.target.value)}
                      placeholder="Widget title"
                    />
                  </div>
                  <div className="field head-actions">
                    <button className="btn btn-primary" onClick={addWidget}>
                      Add Widget
                    </button>
                    <button className="btn btn-primary" onClick={saveWidgets}>
                      Save Widgets
                    </button>
                  </div>
                </div>
              )}
              {!openDash.widgets || openDash.widgets.length === 0 ? (
                <p className="muted">No widgets on this dashboard yet.</p>
              ) : (
                openDash.widgets.map((w, i) => (
                  <div className="sched-card" key={i}>
                    <div>
                      <strong>{w.title}</strong> <Badge value={w.widgetType} />
                      <div className="sched-meta">
                        {w.kpiId
                          ? 'KPI #' + w.kpiId
                          : w.reportName
                            ? labelOf(w.reportName)
                            : ''}
                      </div>
                    </div>
                    <div className="head-actions">
                      <button className="btn btn-xs btn-danger" onClick={() => removeWidget(i)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'builder' && (
        <div className="card card-pad">
          <div className="section-title">Custom Report Builder</div>
          {canCreateCustom && (
            <>
              <div className="form-grid">
                <div className="field">
                  <label>Report Name</label>
                  <input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="Slow-moving stock"
                  />
                </div>
                <div className="field">
                  <label>Description</label>
                  <input value={customDesc} onChange={(e) => setCustomDesc(e.target.value)} />
                </div>
                <div className="field">
                  <label>Data Source</label>
                  <select
                    value={customSource}
                    onChange={(e) => onDataSourceChange(e.target.value)}
                  >
                    <option value="">Select source...</option>
                    {sources.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Visualization</label>
                  <select value={customViz} onChange={(e) => setCustomViz(e.target.value)}>
                    <option value="table">Table</option>
                    <option value="bar">Bar</option>
                    <option value="line">Line</option>
                    <option value="pie">Pie</option>
                    <option value="kpi">KPI</option>
                  </select>
                </div>
                <div className="field">
                  <label>Limit</label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={customLimit}
                    onChange={(e) => setCustomLimit(Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label>Sort Column</label>
                  <select value={customSortCol} onChange={(e) => setCustomSortCol(e.target.value)}>
                    <option value="">None</option>
                    {columnsOfSource(sources, customSource).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Sort Direction</label>
                  <select value={customSortDir} onChange={(e) => setCustomSortDir(e.target.value)}>
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                  </select>
                </div>
              </div>

              {customSource && <div className="section-title">Visible Columns</div>}
              {customSource && (
                <div className="chip-row">
                  {columnsOfSource(sources, customSource).map((c) => (
                    <label className="filter-chip" key={c}>
                      <input
                        type="checkbox"
                        checked={customCols.includes(c)}
                        onChange={() => setCustomCols((prev) => toggleIn(prev, c))}
                      />
                      {c}
                    </label>
                  ))}
                </div>
              )}
              {customSource && <div className="section-title">Group By</div>}
              {customSource && (
                <div className="chip-row">
                  {columnsOfSource(sources, customSource).map((c) => (
                    <label className="filter-chip" key={c}>
                      <input
                        type="checkbox"
                        checked={customGroup.includes(c)}
                        onChange={() => setCustomGroup((prev) => toggleIn(prev, c))}
                      />
                      {c}
                    </label>
                  ))}
                </div>
              )}
              {customError && <ErrorBanner error={customError} />}
              <div className="head-actions">
                <button
                  className="btn btn-primary"
                  disabled={!customName.trim() || !customSource || customCols.length === 0}
                  onClick={createCustom}
                >
                  Save Report
                </button>
              </div>
            </>
          )}

          <div className="section-title">Saved Custom Reports</div>
          {customs.length === 0 && <p className="muted">No custom reports yet.</p>}
          {customs.map((c) => (
            <div className="sched-card" key={c.id}>
              <div>
                <strong>{c.name}</strong> <Badge value={c.visualization} />
                <div className="sched-meta">
                  {c.dataSource} - {c.config?.columns?.length ?? 0} columns
                  {c.config?.groupBy?.length
                    ? ' - grouped by ' + c.config.groupBy.join(', ')
                    : ''}
                </div>
              </div>
              <div className="head-actions">
                {canRunCustom && (
                  <button className="btn btn-xs" onClick={() => runCustom(c.id)}>
                    Run
                  </button>
                )}
                <button className="btn btn-xs btn-danger" onClick={() => archiveCustom(c.id)}>
                  Archive
                </button>
              </div>
            </div>
          ))}

          {customBusy && <PageLoader label="Running custom report..." />}
          {customMeta && customRows.length > 0 && (
            <div className="card">
              <DataTable meta={customMeta} rows={customRows} onOpen={() => undefined} />
            </div>
          )}
        </div>
      )}

      {showSave && def && (
        <Modal
          title="Save Report View"
          onClose={() => setShowSave(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setShowSave(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={saveBusy || viewName.trim() === ''}
                onClick={saveView}
              >
                {saveBusy ? 'Saving...' : 'Save View'}
              </button>
            </>
          }
        >
          <div className="field">
            <label>View Name</label>
            <input
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              placeholder={def.label + ' - filtered'}
            />
          </div>
          <p className="muted">Current filters ({filters.length}) will be stored with this view.</p>
        </Modal>
      )}

      {showSchedule && def && (
        <Modal
          title="Schedule Report"
          onClose={() => setShowSchedule(false)}
          wide
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setShowSchedule(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={schedBusy} onClick={saveSchedule}>
                {schedBusy ? 'Saving...' : 'Create Schedule'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="field">
              <label>Schedule Name</label>
              <input
                value={schedName}
                onChange={(e) => setSchedName(e.target.value)}
                placeholder={def.label + ' schedule'}
              />
            </div>
            <div className="field">
              <label>Frequency</label>
              <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                <option value="ONCE">Once</option>
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </div>
            <div className="field">
              <label>Run Time</label>
              <input type="time" value={runTime} onChange={(e) => setRunTime(e.target.value)} />
            </div>
            {frequency === 'WEEKLY' && (
              <div className="field">
                <label>Day of Week</label>
                <select value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                  {DAYS.map((d, i) => (
                    <option key={d} value={i + 1}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {frequency === 'MONTHLY' && (
              <div className="field">
                <label>Day of Month</label>
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(Number(e.target.value))}
                />
              </div>
            )}
            <div className="field">
              <label>Recipients (emails)</label>
              <textarea
                rows={3}
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                placeholder="one per line or comma separated"
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
