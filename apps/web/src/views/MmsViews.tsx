import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';

type Rec = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const d10 = (v: unknown): string => String(v ?? '').slice(0, 10);
const pct = (v: unknown): string => num(v).toFixed(1) + '%';

const STATE_COLORS: Record<string, string> = {
  RUNNING: 'var(--success)',
  SETUP: 'var(--info)',
  CHANGEOVER: 'var(--info)',
  IDLE: 'var(--muted)',
  MAINTENANCE: 'var(--amber)',
  BREAKDOWN: 'var(--danger)',
  OFFLINE: 'var(--muted)',
};

function StateDot({ state }: { state: unknown }) {
  const s = String(state ?? 'IDLE');
  return <span className="machine-state-dot" style={{ background: STATE_COLORS[s] ?? 'var(--muted)' }} title={s} />;
}

function MmsSection({ title, sub, actions, children }: { title: string; sub?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          {sub && <p className="muted">{sub}</p>}
        </div>
        {actions && <div>{actions}</div>}
      </div>
      <div className="card-pad">{children}</div>
    </section>
  );
}

function Kpi({ label, value, sub, onClick }: { label: string; value: ReactNode; sub?: string; onClick?: () => void }) {
  return (
    <button className="kpi-card" disabled={!onClick} onClick={onClick}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </button>
  );
}

// ---- Product picker (shared) -------------------------------------------------
let productChoicesPromise: Promise<Rec[]> | null = null;
export function loadProductChoices(): Promise<Rec[]> {
  if (!productChoicesPromise) {
    productChoicesPromise = api<{ data: unknown }>('/api/inventory/items?pageSize=200')
      .then((r) => (Array.isArray(r.data) ? (r.data as Rec[]).map((x) => ({ id: x.id, code: x.code, name: x.name })) : []))
      .catch(() => []);
  }
  return productChoicesPromise;
}

function ProductSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [items, setItems] = useState<Rec[] | null>(null);
  useEffect(() => {
    let live = true;
    loadProductChoices().then((rows) => {
      if (live) setItems(rows);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">- select product -</option>
      {(items ?? []).map((p) => (
        <option key={String(p.id)} value={String(p.id)}>
          {String(p.code)} - {String(p.name)}
        </option>
      ))}
    </select>
  );
}

// ---- Generic desk scaffolding -------------------------------------------------
function useDesk(endpoint: string) {
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    setError('');
    api<{ data: unknown }>(endpoint)
      .then((r) => setRows(Array.isArray(r.data) ? (r.data as Rec[]) : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Request failed'));
  }, [endpoint]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { rows, error, reload };
}

type Col = {
  key: string;
  label: string;
  num?: boolean;
  mono?: boolean;
  render?: (r: Rec) => ReactNode;
};

function DeskTable({ rows, cols, onRow }: { rows: Rec[]; cols: Col[]; onRow?: (r: Rec) => void }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={c.num ? 'cell-num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={String(r.id ?? i)}
              className={onRow ? 'row-click' : undefined}
              onClick={onRow ? () => onRow(r) : undefined}
            >
              {cols.map((c) => (
                <td key={c.key} className={c.num ? 'cell-num' : c.mono ? 'cell-mono' : undefined}>
                  {c.render ? c.render(r) : String(r[c.key] ?? '-')}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                No records.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DeskPage({
  title,
  sub,
  endpoint,
  cols,
  onRow,
  actions,
}: {
  title: string;
  sub?: string;
  endpoint: string;
  cols: Col[];
  onRow?: (r: Rec) => void;
  actions?: ReactNode;
}) {
  const { rows, error } = useDesk(endpoint);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>{title}</h1>
          {sub && <p className="muted">{sub}</p>}
        </div>
        {actions && <div className="head-actions">{actions}</div>}
      </header>
      {error && !rows && <ErrorBanner error={error} />}
      {!rows && !error && <PageLoader label="Loading..." />}
      {rows && <DeskTable rows={rows} cols={cols} onRow={onRow} />}
    </div>
  );
}

export function MmsDashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ data: Rec }>('/api/ops/manufacturing/dashboard')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Dashboard failed'));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Loading manufacturing dashboard..." />;
  const p = (data.production ?? {}) as Rec;
  const m = (data.machine ?? {}) as Rec;
  const mat = (data.material ?? {}) as Rec;
  const q = (data.quality ?? {}) as Rec;
  const w = (data.waste ?? {}) as Rec;
  const trend = (data.trend as Rec[]) ?? [];
  const machines = (data.machines as Rec[]) ?? [];
  const alerts = (data.alerts as Rec[]) ?? [];
  const activity = (data.activity as Rec[]) ?? [];
  const maxTrend = Math.max(1, ...trend.map((t) => Math.max(num(t.planned), num(t.actual))));
  const act = (id: unknown) => {
    api('/api/ops/manufacturing/alerts/' + String(id) + '/ack', { method: 'POST' }).then(load).catch(() => undefined);
  };
  const res = (id: unknown) => {
    api('/api/ops/manufacturing/alerts/' + String(id) + '/resolve', { method: 'POST' }).then(load).catch(() => undefined);
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Manufacturing dashboard</h1>
          <p className="muted">Plant-wide visibility: planned vs actual, machine health, materials, quality, waste and alerts.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/plant/gantt')}>Schedule</button>
          <button className="btn" onClick={() => navigate('/plant/command')}>Command center</button>
          {can(user, 'production.work_orders.create') && (
            <button className="btn btn-primary" onClick={() => navigate('/plant/new')}>New work order</button>
          )}
        </div>
      </header>

      <h2 className="mms-group">Production</h2>
      <div className="kpi-grid">
        <Kpi label="Planned" value={fmtNum(p.planned)} sub={fmtNum(p.orders) + ' orders · ' + fmtNum(p.live) + ' live'} />
        <Kpi label="Actual produced" value={fmtNum(p.produced)} sub={fmtNum(p.completed) + ' completed'} />
        <Kpi label="Achievement" value={pct(p.achievementPct)} sub={'variance ' + fmtNum(p.variance)} />
        <Kpi label="Efficiency" value={pct(p.efficiencyPct)} />
        <Kpi label="Today" value={fmtNum(p.outputToday)} sub={'plan ' + fmtNum(p.plannedToday) + ' · ' + pct(p.achievementTodayPct)} />
        <Kpi label="Week" value={fmtNum(p.outputWeek)} />
        <Kpi label="Month" value={fmtNum(p.outputMonth)} />
      </div>

      <h2 className="mms-group">Machines</h2>
      <div className="kpi-grid">
        <Kpi label="Running" value={fmtNum(m.running) + ' / ' + fmtNum(m.total)} />
        <Kpi label="Idle" value={fmtNum(m.idle)} />
        <Kpi label="Setup" value={fmtNum(m.setup)} />
        <Kpi label="Maintenance" value={fmtNum(m.maintenance)} />
        <Kpi label="Breakdown" value={fmtNum(m.breakdown)} />
        <Kpi label="Offline" value={fmtNum(m.offline)} />
      </div>
      <MmsSection title="Machine hours & OEE" sub="Today's capacity, running and lost hours">
        <div className="mini-bars">
          <div className="mini-bar">
            <span className="mini-bar-label">OEE</span>
            <div className="mini-bar-track"><div className="mini-bar-fill" style={{ width: Math.min(num(m.oeePct), 100) + '%' }} /></div>
            <span className="mini-bar-value">{pct(m.oeePct)}</span>
          </div>
          <div className="mini-bar">
            <span className="mini-bar-label">Utilisation</span>
            <div className="mini-bar-track"><div className="mini-bar-fill" style={{ width: Math.min(num(m.utilizationPct), 100) + '%' }} /></div>
            <span className="mini-bar-value">{pct(m.utilizationPct)}</span>
          </div>
        </div>
        <div className="check-line">
          <span>Available {fmtNum(m.availableHours)}h</span>
          <span>Running {fmtNum(m.runningHours)}h</span>
          <span>Downtime {fmtNum(m.downtimeHours)}h</span>
          <span>Lost {fmtNum(m.lostHours)}h</span>
        </div>
      </MmsSection>

      <h2 className="mms-group">Materials</h2>
      <div className="kpi-grid">
        <Kpi label="Available" value={fmtNum(mat.available)} />
        <Kpi label="Reserved" value={fmtNum(mat.reserved)} />
        <Kpi label="Issued" value={fmtNum(mat.issued)} />
        <Kpi label="Consumed" value={fmtNum(mat.consumed)} />
        <Kpi label="Required" value={fmtNum(mat.required)} sub="open reservations" />
        <Kpi label="Work in progress" value={fmtNum(mat.wipQty)} />
        <Kpi label="Finished goods" value={fmtNum(mat.finishedGoods)} />
      </div>

      <h2 className="mms-group">Quality</h2>
      <div className="kpi-grid">
        <Kpi label="QC pass rate" value={pct(q.passRatePct)} sub={fmtNum(q.passed) + ' passed / ' + fmtNum(q.total) + ' tests'} />
        <Kpi label="Rejection rate" value={pct(q.rejectionRatePct)} sub={fmtNum(q.failed) + ' failed'} />
        <Kpi label="Rework quantity" value={fmtNum(q.reworkQty)} />
        <Kpi label="Defects" value={fmtNum(q.defectCount)} sub={fmtNum(q.defectQty) + ' qty'} />
      </div>

      <h2 className="mms-group">Waste & scrap</h2>
      <div className="kpi-grid">
        <Kpi label="Standard waste" value={fmtNum(w.standardQty)} />
        <Kpi label="Actual waste" value={fmtNum(w.actualQty)} sub={pct(w.wastePct) + ' of output'} />
        <Kpi label="Waste cost" value={fmtMoney(w.cost)} />
        <Kpi label="Abnormal events" value={fmtNum(w.abnormalCount)} />
        <Kpi label="Scrap" value={fmtNum(w.scrapQty)} />
        <Kpi label="Scrap value" value={fmtMoney(w.scrapValue)} />
      </div>

      <MmsSection title="Production trend" sub="Planned vs actual output, last 14 days">
        <div className="trend-chart">
          {trend.map((t) => {
            const plan = num(t.planned);
            const actV = num(t.actual);
            return (
              <div className="trend-col" key={String(t.day)} title={d10(t.day) + ' plan ' + plan + ' actual ' + actV}>
                <div className="trend-bars">
                  <div className="trend-bar plan" style={{ height: (plan / maxTrend) * 100 + '%' }} />
                  <div className="trend-bar actual" style={{ height: (actV / maxTrend) * 100 + '%' }} />
                </div>
                <div className="trend-day">{String(t.day ?? '').slice(8, 10)}</div>
              </div>
            );
          })}
          {trend.length === 0 && <p className="muted">No trend data yet.</p>}
        </div>
        <div className="trend-legend">
          <span><i className="trend-swatch plan" /> Planned</span>
          <span><i className="trend-swatch actual" /> Actual</span>
        </div>
      </MmsSection>

      <MmsSection title="Machine status" sub="Live state of every production machine">
        <div className="wh-grid">
          {machines.map((mc) => (
            <button key={String(mc.id)} className="wh-card" onClick={() => navigate('/plant/machines')}>
              <div className="wh-card-top">
                <span className="cell-mono">{String(mc.code)}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <StateDot state={mc.machineState ?? mc.status} />
                  <Badge value={mc.machineState ?? mc.status} />
                </span>
              </div>
              <strong>{String(mc.name)}</strong>
              <div className="muted">{mc.currentWo ? 'WO ' + String(mc.currentWo) : String(mc.type ?? '')}</div>
              <div className="wh-card-meta">
                <span>{fmtNum(mc.productionHours)}h run</span>
                <span>{fmtNum(mc.downtimeHours)}h down</span>
              </div>
            </button>
          ))}
        </div>
      </MmsSection>

      <MmsSection title="Alerts" sub="Open alerts requiring attention">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Type</th>
                <th>Severity</th>
                <th>Message</th>
                <th>Raised</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={String(a.id)} className="row-warn">
                  <td className="cell-mono">{String(a.alertType ?? '')}</td>
                  <td><Badge value={a.severity} /></td>
                  <td>
                    <strong>{String(a.title ?? '')}</strong>
                    <div className="muted">{String(a.message ?? '')}</div>
                  </td>
                  <td className="cell-mono">{d10(a.createdAt)}</td>
                  <td><Badge value={a.status} /></td>
                  <td>
                    {String(a.status ?? '') === 'OPEN' && (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <button className="btn btn-sm" onClick={() => act(a.id)}>Ack</button>
                        <button className="btn btn-sm btn-primary" onClick={() => res(a.id)}>Resolve</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {alerts.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    No open alerts.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </MmsSection>

      <MmsSection title="Activity" sub="Recent manufacturing events">
        <div className="activity-list">
          {activity.map((a, i) => (
            <div className="activity-item" key={String(a.id ?? i)}>
              <span className="activity-time cell-mono">{String(a.createdAt ?? '').slice(11, 19)}</span>
              <span className="activity-text">
                <Badge value={a.eventType} />
                <span>{String(a.entityCode ?? a.entityType ?? '')}</span>
              </span>
            </div>
          ))}
          {activity.length === 0 && <p className="muted">No recent activity.</p>}
        </div>
      </MmsSection>
    </div>
  );
}

export function MmsGantt() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (q.from) qs.set('from', q.from);
    if (q.to) qs.set('to', q.to);
    const qstr = qs.toString();
    api<{ data: Rec }>('/api/ops/manufacturing/gantt' + (qstr ? '?' + qstr : ''))
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Schedule failed'))
      .finally(() => setLoading(false));
  }, [q]);
  useEffect(() => {
    load();
  }, [load]);
  const bars = (data?.bars as Rec[]) ?? [];
  const machines = (data?.machines as Rec[]) ?? [];
  const dayMs = 86400000;
  const day = (v: unknown) => {
    const s = String(v ?? '').slice(0, 10);
    if (!s) return NaN;
    return Date.parse(s + 'T00:00:00Z') / dayMs;
  };
  const hasBars = bars.length > 0;
  const first = hasBars ? Math.min(...bars.map((b) => day(b.startDate))) : 0;
  const last = hasBars ? Math.max(...bars.map((b) => day(b.dueDate))) : 0;
  const startDay = hasBars ? Math.floor(first) - 1 : Math.floor(day(new Date().toISOString())) - 3;
  const endDay = hasBars ? Math.ceil(last) + 1 : startDay + 6;
  const total = Math.max(7, endDay - startDay + 1);
  const days = Array.from({ length: total }, (_, i) => startDay + i);
  const col = (v: unknown) => {
    const d = day(v);
    if (!Number.isFinite(d)) return 0;
    const idx = ((d - startDay) / total) * 100;
    return Math.max(0, Math.min(100, idx));
  };
  const barW = (v1: unknown, v2: unknown) => {
    const a = col(v1);
    const b = col(v2);
    return Math.max(2.5, b - a);
  };
  const WO_COLORS: Record<string, string> = {
    DRAFT: '#94a3b8',
    PLANNED: '#38bdf8',
    APPROVED: '#818cf8',
    MATERIAL_RESERVED: '#a78bfa',
    RELEASED: '#f59e0b',
    IN_PRODUCTION: '#10b981',
    QC_INSPECTION: '#f43f5e',
    COMPLETED: '#6366f1',
    CLOSED: '#475569',
  };
  const barColor = (b: Rec) => WO_COLORS[String(b.status ?? '').toUpperCase()] ?? '#38bdf8';
  const fmtDay = (d: number) => new Date(d * dayMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Production schedule</h1>
          <p className="muted">Machine-level Gantt across production orders</p>
        </div>
        <div className="toolbar">
          <input type="date" className="search-input" value={from} onChange={(e) => setFrom(e.target.value)} title="From" />
          <input type="date" className="search-input" value={to} onChange={(e) => setTo(e.target.value)} title="To" />
          <button className="btn btn-sm btn-primary" onClick={() => setQ({ from, to })}>Apply</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {loading && !data && <PageLoader label="Loading schedule..." />}
      {data && (
        <div className="card">
          <div className="card-pad gantt">
            <div className="gantt-head">
              <div className="gantt-machine">Machine</div>
              <div className="gantt-scale" style={{ gridTemplateColumns: 'repeat(' + total + ', minmax(48px, 1fr))' }}>
                {days.map((d) => (
                  <div key={d} className="gantt-day">{fmtDay(d)}</div>
                ))}
              </div>
            </div>
            <div className="gantt-scroll">
              {machines.map((m) => {
                const mbars = bars.filter((b) => String(b.machineId) === String(m.id));
                return (
                  <div key={String(m.id)} className="gantt-row">
                    <div className="gantt-machine">
                      <span className="gantt-mname">{String(m.name)}</span>
                      <span className="muted gantt-mcode">{String(m.code)}</span>
                    </div>
                    <div className="gantt-lane">
                      <div
                        className="gantt-line"
                        style={{ backgroundImage: `repeating-linear-gradient(to right, var(--line) 0 1px, transparent 1px ${100 / total}%)` }}
                      />
                      {mbars.map((b) => (
                        <button
                          key={String(b.woId)}
                          className="gantt-bar"
                          style={{ left: `${col(b.startDate)}%`, width: `${barW(b.startDate, b.dueDate)}%`, background: barColor(b) }}
                          onClick={() => navigate('/plant/orders/' + String(b.woId))}
                          title={`${String(b.woNo)} - ${String(b.productName ?? b.productCode)} (${fmtNum(b.quantity)})`}
                        >
                          <span className="gantt-barno">{String(b.woNo)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {machines.length === 0 && <p className="muted">No production orders in the selected range.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="field">
      <span className={required ? 'field-required' : undefined}>{label}</span>
      {children}
    </label>
  );
}

export function MmsStandards() {
  const { rows, error, reload } = useDesk('/api/ops/manufacturing/standards');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [f, setF] = useState<Rec>({
    productId: '',
    standardSetupMin: '45',
    standardRunMinPerUnit: '0.004',
    standardLabourHours: '2',
    expectedOutput: '12000',
    expectedWastePct: '4',
    wasteTolerancePct: '2',
    standardCost: '0',
    costRate: '0',
    notes: '',
    checkpointsJson: '',
    attributesJson: '',
    isActive: true,
  });
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const submit = () => {
    setErr('');
    if (!f.productId) {
      setErr('Select a product.');
      return;
    }
    let qualityCheckpoints: unknown[] = [];
    let attributes: unknown = {};
    try {
      if (String(f.checkpointsJson ?? '').trim()) qualityCheckpoints = JSON.parse(String(f.checkpointsJson));
      if (String(f.attributesJson ?? '').trim()) attributes = JSON.parse(String(f.attributesJson));
    } catch (e) {
      setErr('Checkpoints / attributes must be valid JSON.');
      return;
    }
    setSaving(true);
    api('/api/ops/manufacturing/standards', {
      method: 'POST',
      body: JSON.stringify({
        productId: f.productId,
        standardSetupMin: num(f.standardSetupMin),
        standardRunMinPerUnit: num(f.standardRunMinPerUnit),
        standardLabourHours: num(f.standardLabourHours),
        expectedOutput: num(f.expectedOutput),
        expectedWastePct: num(f.expectedWastePct),
        wasteTolerancePct: num(f.wasteTolerancePct),
        standardCost: num(f.standardCost),
        costRate: num(f.costRate),
        qualityCheckpoints,
        attributes,
        isActive: !!f.isActive,
        notes: String(f.notes ?? ''),
      }),
    })
      .then(() => {
        setOpen(false);
        reload();
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Save failed'))
      .finally(() => setSaving(false));
  };
  const cols: Col[] = [
    {
      key: 'product',
      label: 'Product',
      render: (r) => (
        <div>
          <div className="cell-mono">{String(r.productCode ?? '')}</div>
          <div>{String(r.productName ?? '')}</div>
        </div>
      ),
    },
    { key: 'productType', label: 'Type' },
    { key: 'unitCode', label: 'Unit', mono: true },
    { key: 'standardSetupMin', label: 'Setup min', num: true },
    { key: 'standardRunMinPerUnit', label: 'Run min/unit', num: true },
    { key: 'expectedOutput', label: 'Exp. output', num: true },
    { key: 'expectedWastePct', label: 'Exp. waste', num: true, render: (r) => pct(r.expectedWastePct) },
    { key: 'wasteTolerancePct', label: 'Tolerance', num: true, render: (r) => pct(r.wasteTolerancePct) },
    { key: 'standardCost', label: 'Std cost', num: true, render: (r) => fmtMoney(r.standardCost) },
    { key: 'costRate', label: 'Rate', num: true, render: (r) => fmtMoney(r.costRate) },
    { key: 'isActive', label: 'Active', render: (r) => (r.isActive ? <Badge value="ACTIVE" /> : <Badge value="INACTIVE" />) },
  ];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Production standards</h1>
          <p className="muted">Standard times, expected output, waste tolerance and quality checkpoints per product.</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={() => setOpen(true)}>New standard</button>
        </div>
      </header>
      {error && !rows && <ErrorBanner error={error} />}
      {!rows && !error && <PageLoader label="Loading standards..." />}
      {rows && <DeskTable rows={rows} cols={cols} />}
      {open && (
        <Modal
          title="New production standard"
          onClose={() => setOpen(false)}
          wide
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving} onClick={submit}>
                {saving ? 'Saving...' : 'Save standard'}
              </button>
            </>
          }
        >
          {err && <ErrorBanner error={err} />}
          <div className="form-grid">
            <Field label="Product" required>
              <ProductSelect value={String(f.productId)} onChange={(v) => set('productId', v)} />
            </Field>
            <Field label="Setup time (min)">
              <input type="number" value={String(f.standardSetupMin)} onChange={(e) => set('standardSetupMin', e.target.value)} />
            </Field>
            <Field label="Run time (min per unit)">
              <input type="number" step="0.0001" value={String(f.standardRunMinPerUnit)} onChange={(e) => set('standardRunMinPerUnit', e.target.value)} />
            </Field>
            <Field label="Labour (hours)">
              <input type="number" step="0.5" value={String(f.standardLabourHours)} onChange={(e) => set('standardLabourHours', e.target.value)} />
            </Field>
            <Field label="Expected output">
              <input type="number" value={String(f.expectedOutput)} onChange={(e) => set('expectedOutput', e.target.value)} />
            </Field>
            <Field label="Expected waste %">
              <input type="number" step="0.1" value={String(f.expectedWastePct)} onChange={(e) => set('expectedWastePct', e.target.value)} />
            </Field>
            <Field label="Waste tolerance %">
              <input type="number" step="0.1" value={String(f.wasteTolerancePct)} onChange={(e) => set('wasteTolerancePct', e.target.value)} />
            </Field>
            <Field label="Standard cost">
              <input type="number" step="0.01" value={String(f.standardCost)} onChange={(e) => set('standardCost', e.target.value)} />
            </Field>
            <Field label="Cost rate">
              <input type="number" step="0.01" value={String(f.costRate)} onChange={(e) => set('costRate', e.target.value)} />
            </Field>
            <Field label="Checkpoints (JSON array)">
              <textarea
                rows={4}
                placeholder='[{"parameter":"Sheet count","standard":"500","unit":"sheets"},{"parameter":"GSM","standard":"80","unit":"gsm"}]'
                value={String(f.checkpointsJson ?? '')}
                onChange={(e) => set('checkpointsJson', e.target.value)}
              />
            </Field>
            <Field label="Attributes (JSON object)">
              <textarea rows={3} placeholder='{"product_type":"REAM","line":"SCA4-1100"}' value={String(f.attributesJson ?? '')} onChange={(e) => set('attributesJson', e.target.value)} />
            </Field>
            <Field label="Notes">
              <input type="text" value={String(f.notes ?? '')} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function MmsPackaging() {
  const { rows, error, reload } = useDesk('/api/ops/manufacturing/packaging');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [f, setF] = useState<Rec>({
    productId: '',
    level: 'REAM',
    levelCode: 'REAM',
    name: 'Ream',
    qtyPerParent: '1',
    weightKg: '2.5',
    sortOrder: '10',
    isActive: true,
  });
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const submit = () => {
    setErr('');
    if (!f.productId) {
      setErr('Select a product.');
      return;
    }
    setSaving(true);
    api('/api/ops/manufacturing/packaging', {
      method: 'POST',
      body: JSON.stringify({
        productId: f.productId,
        level: f.level,
        levelCode: String(f.levelCode ?? f.level),
        name: String(f.name ?? f.level),
        qtyPerParent: num(f.qtyPerParent),
        weightKg: num(f.weightKg),
        sortOrder: num(f.sortOrder),
        isActive: !!f.isActive,
      }),
    })
      .then(() => {
        setOpen(false);
        reload();
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Save failed'))
      .finally(() => setSaving(false));
  };
  const cols: Col[] = [
    {
      key: 'product',
      label: 'Product',
      render: (r) => (
        <div>
          <div className="cell-mono">{String(r.productCode ?? '')}</div>
          <div>{String(r.productName ?? '')}</div>
        </div>
      ),
    },
    { key: 'level', label: 'Level', mono: true },
    { key: 'levelCode', label: 'Level code', mono: true },
    { key: 'name', label: 'Name' },
    { key: 'qtyPerParent', label: 'Qty / parent', num: true },
    { key: 'weightKg', label: 'Weight (kg)', num: true },
    { key: 'sortOrder', label: 'Order', num: true },
    { key: 'isActive', label: 'Active', render: (r) => (r.isActive ? <Badge value="ACTIVE" /> : <Badge value="INACTIVE" />) },
  ];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Packaging hierarchies</h1>
          <p className="muted">Sheet to ream to carton to pallet configurations per finished product.</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={() => setOpen(true)}>New level</button>
        </div>
      </header>
      {error && !rows && <ErrorBanner error={error} />}
      {!rows && !error && <PageLoader label="Loading packaging..." />}
      {rows && <DeskTable rows={rows} cols={cols} />}
      {open && (
        <Modal
          title="New packaging level"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving} onClick={submit}>
                {saving ? 'Saving...' : 'Save level'}
              </button>
            </>
          }
        >
          {err && <ErrorBanner error={err} />}
          <div className="form-grid">
            <Field label="Product" required>
              <ProductSelect value={String(f.productId)} onChange={(v) => set('productId', v)} />
            </Field>
            <Field label="Level">
              <select value={String(f.level)} onChange={(e) => set('level', e.target.value)}>
                <option value="SHEET">SHEET</option>
                <option value="REAM">REAM</option>
                <option value="CARTON">CARTON</option>
                <option value="PALLET">PALLET</option>
                <option value="BUNDLE">BUNDLE</option>
              </select>
            </Field>
            <Field label="Level code">
              <input type="text" value={String(f.levelCode)} onChange={(e) => set('levelCode', e.target.value)} />
            </Field>
            <Field label="Name">
              <input type="text" value={String(f.name)} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Qty per parent">
              <input type="number" step="0.01" value={String(f.qtyPerParent)} onChange={(e) => set('qtyPerParent', e.target.value)} />
            </Field>
            <Field label="Weight (kg)">
              <input type="number" step="0.001" value={String(f.weightKg)} onChange={(e) => set('weightKg', e.target.value)} />
            </Field>
            <Field label="Sort order">
              <input type="number" value={String(f.sortOrder)} onChange={(e) => set('sortOrder', e.target.value)} />
            </Field>
            <Field label="Active">
              <input type="checkbox" checked={!!f.isActive} onChange={(e) => set('isActive', e.target.checked)} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

const DEFAULT_TESTS: Record<string, Rec[]> = {
  INCOMING: [
    { parameter: 'GSM', method: 'Scale', standardValue: '80', actualValue: '', unit: 'gsm', passed: true, notes: '' },
    { parameter: 'Moisture', method: 'Moisture meter', standardValue: '5', actualValue: '', unit: '%', passed: true, notes: '' },
    { parameter: 'Width', method: 'Tape measure', standardValue: '880', actualValue: '', unit: 'mm', passed: true, notes: '' },
    { parameter: 'Roll diameter', method: 'Tape measure', standardValue: '1200', actualValue: '', unit: 'mm', passed: true, notes: '' },
  ],
  IN_PROCESS: [
    { parameter: 'Sheet count', method: 'Counter', standardValue: '500', actualValue: '', unit: 'sheets', passed: true, notes: '' },
    { parameter: 'GSM', method: 'Scale', standardValue: '80', actualValue: '', unit: 'gsm', passed: true, notes: '' },
    { parameter: 'Cutting accuracy', method: 'Ruler', standardValue: '210 x 297', actualValue: '', unit: 'mm', passed: true, notes: '' },
    { parameter: 'Squareness', method: 'Visual', standardValue: 'Within 2mm', actualValue: '', unit: 'mm', passed: true, notes: '' },
  ],
  FINAL: [
    { parameter: 'Sheet count', method: 'Counter', standardValue: '500', actualValue: '', unit: 'sheets', passed: true, notes: '' },
    { parameter: 'GSM', method: 'Scale', standardValue: '80', actualValue: '', unit: 'gsm', passed: true, notes: '' },
    { parameter: 'Dimensions', method: 'Ruler', standardValue: '210 x 297', actualValue: '', unit: 'mm', passed: true, notes: '' },
    { parameter: 'Appearance', method: 'Visual', standardValue: 'No defects', actualValue: '', unit: '', passed: true, notes: '' },
    { parameter: 'Packaging quality', method: 'Visual', standardValue: 'Sealed & labelled', actualValue: '', unit: '', passed: true, notes: '' },
  ],
};

export function MmsInspections() {
  const { rows, error, reload } = useDesk('/api/ops/manufacturing/inspections');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [f, setF] = useState<Rec>({ productId: '', kind: 'FINAL', quantity: '', sampledQty: '', notes: '' });
  const [sub, setSub] = useState<Rec | null>(null);
  const [result, setResult] = useState('PASSED');
  const [tests, setTests] = useState<Rec[]>([]);
  const [notes, setNotes] = useState('');
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const openSubmit = (r: Rec) => {
    const existing = (r.results as Rec[]) ?? [];
    setTests(existing.length ? existing.map((t) => ({ ...t })) : (DEFAULT_TESTS[String(r.kind ?? 'FINAL')] ?? DEFAULT_TESTS.FINAL).map((t) => ({ ...t })));
    setResult(String(r.result ?? 'PENDING'));
    setNotes(String(r.notes ?? ''));
    setErr('');
    setSub(r);
  };
  const create = () => {
    setErr('');
    if (!f.productId) {
      setErr('Select a product.');
      return;
    }
    setSaving(true);
    api('/api/ops/manufacturing/inspections', {
      method: 'POST',
      body: JSON.stringify({
        productId: f.productId,
        kind: f.kind,
        quantity: num(f.quantity),
        sampledQty: num(f.sampledQty),
        notes: String(f.notes ?? ''),
      }),
    })
      .then(() => {
        setOpen(false);
        reload();
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Create failed'))
      .finally(() => setSaving(false));
  };
  const submitResults = () => {
    if (!sub) return;
    setErr('');
    setSaving(true);
    api('/api/ops/manufacturing/inspections/' + String(sub.id) + '/submit', {
      method: 'POST',
      body: JSON.stringify({
        result,
        notes,
        results: tests.map((t) => ({
          parameter: String(t.parameter ?? ''),
          method: String(t.method ?? ''),
          standardValue: String(t.standardValue ?? ''),
          actualValue: String(t.actualValue ?? ''),
          unit: String(t.unit ?? ''),
          passed: !!t.passed,
          notes: String(t.notes ?? ''),
        })),
      }),
    })
      .then(() => {
        setSub(null);
        reload();
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Submit failed'))
      .finally(() => setSaving(false));
  };
  const setTest = (i: number, k: string, v: unknown) =>
    setTests((prev) => prev.map((t, idx) => (idx === i ? { ...t, [k]: v } : t)));
  const cols: Col[] = [
    { key: 'inspectionNo', label: 'Inspection', mono: true },
    { key: 'kind', label: 'Kind', render: (r) => <Badge value={r.kind} /> },
    {
      key: 'product',
      label: 'Product',
      render: (r) => (
        <div>
          <div className="cell-mono">{String(r.productCode ?? '')}</div>
          <div>{String(r.productName ?? '')}</div>
        </div>
      ),
    },
    { key: 'woNo', label: 'Work order', mono: true },
    { key: 'batchNo', label: 'Batch', mono: true },
    { key: 'quantity', label: 'Qty', num: true },
    { key: 'sampledQty', label: 'Sampled', num: true },
    { key: 'result', label: 'Result', render: (r) => <Badge value={r.result ?? 'PENDING'} /> },
    { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
    {
      key: 'act',
      label: '',
      render: (r) => (
        <button className="btn btn-sm btn-primary" onClick={() => openSubmit(r)}>Submit results</button>
      ),
    },
  ];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Quality inspections</h1>
          <p className="muted">Incoming, in-process and finished-goods inspection with configurable test points.</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={() => setOpen(true)}>New inspection</button>
        </div>
      </header>
      {error && !rows && <ErrorBanner error={error} />}
      {!rows && !error && <PageLoader label="Loading inspections..." />}
      {rows && <DeskTable rows={rows} cols={cols} />}
      {open && (
        <Modal
          title="New inspection"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving} onClick={create}>
                {saving ? 'Creating...' : 'Create inspection'}
              </button>
            </>
          }
        >
          {err && <ErrorBanner error={err} />}
          <div className="form-grid">
            <Field label="Product" required>
              <ProductSelect value={String(f.productId)} onChange={(v) => set('productId', v)} />
            </Field>
            <Field label="Kind">
              <select value={String(f.kind)} onChange={(e) => set('kind', e.target.value)}>
                <option value="INCOMING">Incoming</option>
                <option value="IN_PROCESS">In-process</option>
                <option value="FINAL">Finished goods</option>
              </select>
            </Field>
            <Field label="Quantity">
              <input type="number" value={String(f.quantity)} onChange={(e) => set('quantity', e.target.value)} />
            </Field>
            <Field label="Sample quantity">
              <input type="number" value={String(f.sampledQty)} onChange={(e) => set('sampledQty', e.target.value)} />
            </Field>
            <Field label="Notes">
              <input type="text" value={String(f.notes ?? '')} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </div>
        </Modal>
      )}
      {sub && (
        <Modal
          title={'Submit results - ' + String(sub.inspectionNo ?? '')}
          onClose={() => setSub(null)}
          wide
          footer={
            <>
              <button className="btn" onClick={() => setSub(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving} onClick={submitResults}>
                {saving ? 'Saving...' : 'Submit results'}
              </button>
            </>
          }
        >
          {err && <ErrorBanner error={err} />}
          <div className="form-grid">
            <Field label="Overall result">
              <select value={result} onChange={(e) => setResult(e.target.value)}>
                <option value="PASSED">Passed</option>
                <option value="FAILED">Failed</option>
                <option value="QUARANTINED">Quarantined</option>
                <option value="PENDING">Pending</option>
              </select>
            </Field>
            <Field label="Notes">
              <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          <h3 className="mms-group">Test results</h3>
          <div className="table-wrap">
            <table className="data spec-check">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Method</th>
                  <th>Standard</th>
                  <th>Actual</th>
                  <th>Unit</th>
                  <th>Pass</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {tests.map((t, i) => (
                  <tr key={i}>
                    <td><input className="spec-in" value={String(t.parameter ?? '')} onChange={(e) => setTest(i, 'parameter', e.target.value)} /></td>
                    <td><input className="spec-in" value={String(t.method ?? '')} onChange={(e) => setTest(i, 'method', e.target.value)} /></td>
                    <td><input className="spec-in" value={String(t.standardValue ?? '')} onChange={(e) => setTest(i, 'standardValue', e.target.value)} /></td>
                    <td><input className="spec-in" value={String(t.actualValue ?? '')} onChange={(e) => setTest(i, 'actualValue', e.target.value)} /></td>
                    <td><input className="spec-in" value={String(t.unit ?? '')} onChange={(e) => setTest(i, 'unit', e.target.value)} /></td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={!!t.passed} onChange={(e) => setTest(i, 'passed', e.target.checked)} />
                    </td>
                    <td><input className="spec-in" value={String(t.notes ?? '')} onChange={(e) => setTest(i, 'notes', e.target.value)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}

const productCell = (r: Rec) => (
  <div>
    <div className="cell-mono">{String(r.productCode ?? '')}</div>
    <div>{String(r.productName ?? '')}</div>
  </div>
);

export function MmsMachines() {
  const { rows, error, reload } = useDesk('/api/ops/manufacturing/machines/status');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Machine status</h1>
          <p className="muted">Live status, operator and production hours for every machine.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={reload}>Refresh</button>
        </div>
      </header>
      {error && !rows && <ErrorBanner error={error} />}
      {!rows && !error && <PageLoader label="Loading machines..." />}
      {rows && (
        <div className="wh-grid">
          {rows.map((m) => (
            <button
              key={String(m.id)}
              className="wh-card"
              onClick={m.currentWoId ? () => navigate('/plant/orders/' + String(m.currentWoId)) : undefined}
            >
              <div className="wh-card-top">
                <span className="cell-mono">{String(m.code)}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <StateDot state={m.machineState ?? m.status} />
                  <Badge value={m.machineState ?? m.status} />
                </span>
              </div>
              <strong>{String(m.name)}</strong>
              <div className="muted">
                {String(m.make ?? '')} {String(m.model ?? '')} - {String(m.type ?? '')}
              </div>
              <div className="muted">{String(m.workCentreName ?? m.workCentreCode ?? '')}</div>
              <div className="wh-card-meta">
                <span>{m.operatorName ? 'OP ' + String(m.operatorName) : 'No operator'}</span>
                <span>{m.currentWo ? 'WO ' + String(m.currentWo) : 'Standby'}</span>
              </div>
              <div className="wh-card-meta">
                <span>{fmtNum(m.productionHours)}h run</span>
                <span>{fmtNum(m.downtimeHours)}h down</span>
                <span>{fmtMoney(m.hourlyRate)}/h</span>
              </div>
              {!!m.maintenanceStatus && <div><Badge value={String(m.maintenanceStatus)} /></div>}
            </button>
          ))}
          {rows.length === 0 && <p className="muted">No machines configured.</p>}
        </div>
      )}
    </div>
  );
}

export function MmsWip() {
  const cols: Col[] = [
    { key: 'woNo', label: 'Work order', mono: true },
    { key: 'product', label: 'Product', render: productCell },
    { key: 'machineCode', label: 'Machine', mono: true, render: (r) => String(r.machineCode ?? '') + ' ' + String(r.machineName ?? '') },
    { key: 'workCentreName', label: 'Work centre' },
    { key: 'routingName', label: 'Routing' },
    { key: 'operationName', label: 'Operation' },
    { key: 'unitCode', label: 'Unit', mono: true },
    { key: 'quantity', label: 'Qty', num: true },
    { key: 'lastPostingAt', label: 'Last posting', mono: true, render: (r) => String(r.lastPostingAt ?? '').slice(0, 16) },
  ];
  return <DeskPage title="Work in progress" sub="Materials and semi-finished goods moving through production." endpoint="/api/ops/manufacturing/wip" cols={cols} />;
}

export function MmsOutputs() {
  const cols: Col[] = [
    { key: 'woNo', label: 'Work order', mono: true },
    { key: 'product', label: 'Product', render: productCell },
    { key: 'batchNo', label: 'Batch', mono: true },
    { key: 'outputType', label: 'Type', render: (r) => <Badge value={r.outputType} /> },
    { key: 'quantity', label: 'Qty', num: true },
    { key: 'unitCost', label: 'Unit cost', num: true, render: (r) => fmtMoney(r.unitCost) },
    { key: 'reason', label: 'Reason' },
    { key: 'recordedAt', label: 'Recorded', mono: true, render: (r) => String(r.recordedAt ?? '').slice(0, 16) },
  ];
  return <DeskPage title="Production output" sub="Good, rejected, rework and scrap output recorded against work orders." endpoint="/api/ops/manufacturing/outputs" cols={cols} />;
}

export function MmsReservations() {
  const cols: Col[] = [
    { key: 'woNo', label: 'Work order', mono: true },
    { key: 'product', label: 'Product', render: productCell },
    { key: 'warehouseCode', label: 'Warehouse', mono: true, render: (r) => String(r.warehouseCode ?? '') + ' ' + String(r.warehouseName ?? '') },
    { key: 'unitCode', label: 'Unit', mono: true },
    { key: 'requiredQty', label: 'Required', num: true },
    { key: 'reservedQty', label: 'Reserved', num: true },
    { key: 'issuedQty', label: 'Issued', num: true },
    { key: 'consumedQty', label: 'Consumed', num: true },
    { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
  ];
  return <DeskPage title="Material reservations" sub="Real-time reservation, issue and consumption per work order." endpoint="/api/ops/manufacturing/reservations" cols={cols} />;
}

export function MmsIssues() {
  const cols: Col[] = [
    { key: 'issueNo', label: 'Issue no', mono: true },
    { key: 'woNo', label: 'Work order', mono: true },
    { key: 'product', label: 'Product', render: productCell },
    { key: 'warehouseCode', label: 'Warehouse', mono: true, render: (r) => String(r.warehouseCode ?? '') + ' ' + String(r.warehouseName ?? '') },
    { key: 'batchNo', label: 'Batch', mono: true },
    { key: 'quantity', label: 'Qty', num: true },
    { key: 'unitCost', label: 'Unit cost', num: true, render: (r) => fmtMoney(r.unitCost) },
    { key: 'issueType', label: 'Type', render: (r) => <Badge value={r.issueType} /> },
    { key: 'qualityStatus', label: 'Quality', render: (r) => <Badge value={r.qualityStatus ?? 'OK'} /> },
    { key: 'createdAt', label: 'Issued', mono: true, render: (r) => String(r.createdAt ?? '').slice(0, 16) },
  ];
  return <DeskPage title="Material issues" sub="Material issued to production with barcode scan timestamps." endpoint="/api/ops/manufacturing/issues" cols={cols} />;
}

export function MmsWaste() {
  const cols: Col[] = [
    { key: 'woNo', label: 'Work order', mono: true },
    { key: 'machineCode', label: 'Machine', mono: true, render: (r) => String(r.machineCode ?? '') + ' ' + String(r.machineName ?? '') },
    { key: 'batchNo', label: 'Batch', mono: true },
    { key: 'wasteType', label: 'Waste type', render: (r) => <Badge value={r.wasteType} /> },
    { key: 'category', label: 'Category', render: (r) => <Badge value={r.category} /> },
    { key: 'inputQty', label: 'Input', num: true },
    { key: 'wasteQty', label: 'Waste', num: true },
    { key: 'unitCode', label: 'Unit', mono: true },
    { key: 'isAbnormal', label: 'Abnormal', render: (r) => (r.isAbnormal ? <Badge value="ABNORMAL" /> : <Badge value="NORMAL" />) },
    { key: 'reason', label: 'Reason' },
    { key: 'recordedAt', label: 'Recorded', mono: true, render: (r) => String(r.recordedAt ?? '').slice(0, 16) },
  ];
  return <DeskPage title="Production waste" sub="Standard and abnormal waste recorded on the shop floor." endpoint="/api/ops/manufacturing/waste" cols={cols} />;
}

export function MmsScrap() {
  const cols: Col[] = [
    { key: 'woNo', label: 'Work order', mono: true },
    { key: 'product', label: 'Product', render: productCell },
    { key: 'machineCode', label: 'Machine', mono: true, render: (r) => String(r.machineCode ?? '') + ' ' + String(r.machineName ?? '') },
    { key: 'batchNo', label: 'Batch', mono: true },
    { key: 'scrapType', label: 'Type', render: (r) => <Badge value={r.scrapType} /> },
    { key: 'quantity', label: 'Qty', num: true },
    { key: 'unitCost', label: 'Unit cost', num: true, render: (r) => fmtMoney(r.unitCost) },
    { key: 'reason', label: 'Reason' },
    { key: 'recordedAt', label: 'Recorded', mono: true, render: (r) => String(r.recordedAt ?? '').slice(0, 16) },
  ];
  return <DeskPage title="Scrap" sub="Scrap materials with value, cause and traceability." endpoint="/api/ops/manufacturing/scrap" cols={cols} />;
}

export function MmsDowntime() {
  const cols: Col[] = [
    { key: 'woNo', label: 'Work order', mono: true },
    { key: 'machineCode', label: 'Machine', mono: true, render: (r) => String(r.machineCode ?? '') + ' ' + String(r.machineName ?? '') },
    { key: 'workCentreName', label: 'Work centre' },
    { key: 'category', label: 'Category', render: (r) => <Badge value={r.category} /> },
    { key: 'reason', label: 'Reason' },
    { key: 'startedAt', label: 'Started', mono: true, render: (r) => String(r.startedAt ?? '').slice(0, 16) },
    { key: 'endedAt', label: 'Ended', mono: true, render: (r) => String(r.endedAt ?? '').slice(0, 16) },
    { key: 'durationMin', label: 'Duration (min)', num: true },
  ];
  return <DeskPage title="Machine downtime" sub="Breakdown, setup, maintenance and idle events." endpoint="/api/ops/manufacturing/downtime" cols={cols} />;
}

export function MmsNcr() {
  const cols: Col[] = [
    { key: 'ncrNo', label: 'NCR', mono: true },
    { key: 'product', label: 'Product', render: productCell },
    { key: 'description', label: 'Description' },
    { key: 'severity', label: 'Severity', render: (r) => <Badge value={r.severity} /> },
    { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
    { key: 'rootCause', label: 'Root cause' },
    { key: 'correctiveAction', label: 'Corrective action' },
    { key: 'openedAt', label: 'Opened', mono: true, render: (r) => String(r.openedAt ?? '').slice(0, 16) },
  ];
  return <DeskPage title="Non-conformance reports" sub="Quality failures, root cause and corrective actions." endpoint="/api/ops/manufacturing/ncr" cols={cols} />;
}

const SHIFT_OPTIONS = ['MORNING', 'AFTERNOON', 'NIGHT'];
const MACHINE_STATES = ['RUNNING', 'SETUP', 'IDLE', 'MAINTENANCE', 'BREAKDOWN', 'OFFLINE'];
const MATERIAL_STATES = ['OK', 'PARTIAL', 'SHORT', 'N/A'];
const QUALITY_STATES = ['OK', 'PENDING', 'HOLD', 'REWORK', 'N/A'];
const localToday = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
const dLocal = (v: unknown): string => {
  const s = String(v ?? '');
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

export function MmsShifts() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [openOnly, setOpenOnly] = useState(true);
  const [machines, setMachines] = useState<Rec[]>([]);
  const [workOrders, setWorkOrders] = useState<Rec[]>([]);

  const [fromShift, setFromShift] = useState('MORNING');
  const [toShift, setToShift] = useState('');
  const [shiftDate, setShiftDate] = useState(localToday());
  const [woId, setWoId] = useState('');
  const [machineId, setMachineId] = useState('');
  const [producedQty, setProducedQty] = useState('');
  const [outstandingQty, setOutstandingQty] = useState('');
  const [machineStatus, setMachineStatus] = useState('');
  const [materialStatus, setMaterialStatus] = useState('');
  const [qualityStatus, setQualityStatus] = useState('');
  const [issues, setIssues] = useState('');
  const [notes, setNotes] = useState('');

  const load = useCallback(() => {
    setError('');
    api<{ data: unknown }>('/api/ops/manufacturing/shifts/handovers' + (openOnly ? '?openOnly=true' : ''))
      .then((r) => setRows(Array.isArray(r.data) ? (r.data as Rec[]) : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Request failed'));
    api<{ data: unknown }>('/api/ops/manufacturing/machines/status')
      .then((r) => setMachines(Array.isArray(r.data) ? (r.data as Rec[]) : []))
      .catch(() => undefined);
    api<{ data: { rows?: unknown } }>('/api/ops/production/work-orders?pageSize=100')
      .then((r) =>
        setWorkOrders(
          Array.isArray(r.data?.rows)
            ? (r.data.rows as Rec[]).filter(
                (w) => !['DRAFT', 'CANCELLED', 'REJECTED', 'CLOSED'].includes(String(w.status ?? '').toUpperCase())
              )
            : []
        )
      )
      .catch(() => undefined);
  }, [openOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (!fromShift) {
      setError('Select the outgoing shift');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await api<{ data?: { handoverNo?: string } }>('/api/ops/manufacturing/shifts/handover', {
        method: 'POST',
        body: JSON.stringify({
          workOrderId: woId ? Number(woId) : undefined,
          machineId: machineId ? Number(machineId) : undefined,
          fromShiftCode: fromShift,
          toShiftCode: toShift || undefined,
          shiftDate: shiftDate || undefined,
          producedQty: producedQty ? Number(producedQty) : undefined,
          outstandingQty: outstandingQty ? Number(outstandingQty) : undefined,
          machineStatus: machineStatus || undefined,
          issues: issues || undefined,
          materialStatus: materialStatus || undefined,
          qualityStatus: qualityStatus || undefined,
          handoverNotes: notes || undefined,
        }),
      });
      setNotice('Handover ' + String(r.data?.handoverNo ?? '') + ' created — awaiting acknowledgement by the incoming shift.');
      setToShift('');
      setProducedQty('');
      setOutstandingQty('');
      setIssues('');
      setNotes('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ack = async (id: number) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api<{ data: unknown }>('/api/ops/manufacturing/shifts/handover/' + String(id) + '/ack', { method: 'POST' });
      setNotice('Handover acknowledged — shift taken over.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canUpdate = can(user, 'production.work_orders.update');
  const list = rows ?? [];
  const openCount = list.filter((r) => String(r.status ?? '').toUpperCase() === 'PENDING').length;
  const running = machines.filter((m) => String(m.machineState ?? m.status).toUpperCase() === 'RUNNING').length;
  const todayTotal = list
    .filter((r) => dLocal(r.shiftDate) === shiftDate)
    .reduce((s, r) => s + num(r.producedQty), 0);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Shift handover</h1>
          <p className="muted">Digital shift management — end-of-shift summary, handover and acknowledgement.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={load}>Refresh</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      <div className="kpi-grid">
        <Kpi label="Open handovers" value={openCount} sub={openOnly ? 'Awaiting acknowledgement' : 'All pending handovers'} />
        <Kpi label="Machines running" value={running} sub={String(machines.length) + ' machines configured'} />
        <Kpi label="Produced" value={fmtNum(todayTotal)} sub={shiftDate} />
        <Kpi label="Shifts" value={SHIFT_OPTIONS.length} sub="Morning · Afternoon · Night" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 460px) 1fr', gap: 14, alignItems: 'start' }}>
        <MmsSection title="Create handover" sub="Outgoing shift summary for the next shift">
          <div className="form-grid">
            <label className="field"><span>From shift *</span>
              <select value={fromShift} onChange={(e) => setFromShift(e.target.value)}>
                {SHIFT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="field"><span>To shift</span>
              <select value={toShift} onChange={(e) => setToShift(e.target.value)}>
                <option value="">- next shift -</option>
                {SHIFT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="field"><span>Shift date</span>
              <input type="date" value={shiftDate} onChange={(e) => setShiftDate(e.target.value)} />
            </label>
            <label className="field"><span>Production order</span>
              <select value={woId} onChange={(e) => setWoId(e.target.value)}>
                <option value="">- optional -</option>
                {workOrders.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(w.woNo ?? '')} · {String(w.productName ?? '')}</option>)}
              </select>
            </label>
            <label className="field"><span>Machine</span>
              <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                <option value="">- optional -</option>
                {machines.map((m) => <option key={String(m.id)} value={String(m.id)}>{String(m.code ?? '')} · {String(m.name ?? '')}</option>)}
              </select>
            </label>
            <label className="field"><span>Produced qty</span>
              <input inputMode="numeric" value={producedQty} onChange={(e) => setProducedQty(e.target.value)} placeholder="e.g. 7650" />
            </label>
            <label className="field"><span>Outstanding qty</span>
              <input inputMode="numeric" value={outstandingQty} onChange={(e) => setOutstandingQty(e.target.value)} placeholder="e.g. 2350" />
            </label>
            <label className="field"><span>Machine status</span>
              <select value={machineStatus} onChange={(e) => setMachineStatus(e.target.value)}>
                <option value="">- select -</option>
                {MACHINE_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="field"><span>Material status</span>
              <select value={materialStatus} onChange={(e) => setMaterialStatus(e.target.value)}>
                <option value="">- select -</option>
                {MATERIAL_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="field"><span>Quality status</span>
              <select value={qualityStatus} onChange={(e) => setQualityStatus(e.target.value)}>
                <option value="">- select -</option>
                {QUALITY_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="field" style={{ gridColumn: '1 / -1' }}><span>Issues to carry over</span>
              <textarea rows={2} value={issues} onChange={(e) => setIssues(e.target.value)} placeholder="Problems, delays, machine concerns…" />
            </label>
            <label className="field" style={{ gridColumn: '1 / -1' }}><span>Handover notes</span>
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the incoming shift must know." />
            </label>
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary" disabled={busy || !canUpdate} onClick={create}>
              {busy ? 'Saving…' : 'Create handover'}
            </button>
            {!canUpdate && <span className="muted" style={{ fontSize: 12 }}>Requires update permission</span>}
          </div>
        </MmsSection>
        <MmsSection
          title="Handovers"
          sub={openOnly ? 'Open handovers awaiting acknowledgement' : 'All handovers (latest 100)'}
          actions={
            <div className="head-actions">
              <button className={openOnly ? 'btn btn-sm btn-primary' : 'btn btn-sm'} onClick={() => setOpenOnly(true)}>Open</button>
              <button className={!openOnly ? 'btn btn-sm btn-primary' : 'btn btn-sm'} onClick={() => setOpenOnly(false)}>All</button>
            </div>
          }
        >
          {!rows && <PageLoader label="Loading handovers..." />}
          {rows && list.length === 0 && (
            <p className="muted">No handovers{openOnly ? ' awaiting acknowledgement' : ''}. Create one from the form.</p>
          )}
          {rows && list.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Handover</th>
                    <th>Shift</th>
                    <th>Date</th>
                    <th>Machine</th>
                    <th>Work order</th>
                    <th className="cell-num">Produced</th>
                    <th className="cell-num">Outstanding</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={String(r.id)}>
                      <td className="cell-mono">{String(r.handoverNo ?? '')}</td>
                      <td>
                        {String(r.fromShiftCode ?? '')}
                        {r.toShiftCode ? ' → ' + String(r.toShiftCode) : ''}
                      </td>
                      <td className="cell-mono">{dLocal(r.shiftDate)}</td>
                      <td className="cell-mono">{String(r.machineCode ?? '')}</td>
                      <td className="cell-mono">{String(r.woNo ?? '')}</td>
                      <td className="cell-num">{fmtNum(r.producedQty)}</td>
                      <td className="cell-num">{fmtNum(r.outstandingQty)}</td>
                      <td><Badge value={r.status} /></td>
                      <td>
                        {String(r.status ?? '').toUpperCase() === 'PENDING' && canUpdate && (
                          <button className="btn btn-sm" disabled={busy} onClick={() => ack(Number(r.id))}>Acknowledge</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </MmsSection>
      </div>
    </div>
  );
}

export function MmsBoms() {
  const { user } = useAuth();
  const [boms, setBoms] = useState<Rec[] | null>(null);
  const [routings, setRoutings] = useState<Rec[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [bomDetailId, setBomDetailId] = useState(0);
  const [bomDetail, setBomDetail] = useState<Rec | null>(null);
  const [routingDetailId, setRoutingDetailId] = useState(0);
  const [routingDetail, setRoutingDetail] = useState<Rec | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState<Rec>({
    productId: '',
    code: '',
    name: '',
    version: '1',
    quantity: '1000',
    status: 'DRAFT',
    isActive: true,
    effectiveFrom: '',
    effectiveTo: '',
  });
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));

  const [expProductId, setExpProductId] = useState('');
  const [expQty, setExpQty] = useState('1000');
  const [explosion, setExplosion] = useState<Rec | null>(null);
  const [explosionBusy, setExplosionBusy] = useState(false);

  const load = useCallback(() => {
    setError('');
    api<{ data: unknown }>('/api/ops/manufacturing/boms')
      .then((r) => setBoms(Array.isArray(r.data) ? (r.data as Rec[]) : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Request failed'));
    api<{ data: unknown }>('/api/ops/manufacturing/routings')
      .then((r) => setRoutings(Array.isArray(r.data) ? (r.data as Rec[]) : []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleBom = (r: Rec) => {
    const id = Number(r.id);
    if (bomDetailId === id && bomDetail) {
      setBomDetailId(0);
      setBomDetail(null);
      return;
    }
    setBomDetailId(id);
    setBomDetail(null);
    setDetailLoading(true);
    api<{ data: unknown }>('/api/ops/manufacturing/boms/' + String(id))
      .then((res) => setBomDetail(res.data && typeof res.data === 'object' ? (res.data as Rec) : null))
      .catch((e) => setError(e instanceof Error ? e.message : 'Request failed'))
      .finally(() => setDetailLoading(false));
  };

  const toggleRouting = (r: Rec) => {
    const id = Number(r.id);
    if (routingDetailId === id && routingDetail) {
      setRoutingDetailId(0);
      setRoutingDetail(null);
      return;
    }
    setRoutingDetailId(id);
    setRoutingDetail(null);
    setDetailLoading(true);
    api<{ data: unknown }>('/api/ops/manufacturing/routings/' + String(id))
      .then((res) => setRoutingDetail(res.data && typeof res.data === 'object' ? (res.data as Rec) : null))
      .catch((e) => setError(e instanceof Error ? e.message : 'Request failed'))
      .finally(() => setDetailLoading(false));
  };

  const pickBom = useCallback((): Rec | null => {
    const id = Number(expProductId);
    if (!id || !boms) return null;
    const matches = boms.filter((b) => Number(b.productId) === id);
    if (matches.length === 0) return null;
    const active = matches.filter((b) => b.isActive);
    const pool = active.length ? active : matches;
    return [...pool].sort((a, b) => Number(b.version) - Number(a.version))[0] ?? null;
  }, [boms, expProductId]);

  useEffect(() => {
    const qty = num(expQty);
    const bom = pickBom();
    if (!expProductId) {
      setExplosion(null);
      return;
    }
    if (!bom || qty <= 0) {
      setExplosion({ missing: true } as Rec);
      return;
    }
    let live = true;
    setExplosionBusy(true);
    api<{ data: unknown }>('/api/ops/manufacturing/boms/' + String(bom.id))
      .then((res) => {
        const d = res.data && typeof res.data === 'object' ? (res.data as Rec) : null;
        if (!live) return;
        if (!d || !Array.isArray(d.items)) {
          setExplosion({ missing: true } as Rec);
          return;
        }
        const basis = num(d.quantity) > 0 ? num(d.quantity) : 1;
        const factor = qty / basis;
        setExplosion({
          ...d,
          factor,
          plannedQty: qty,
          basis,
          items: (d.items as Rec[]).map((it) => ({
            ...it,
            required: factor * num(it.quantity),
            gross: factor * num(it.quantity) * (1 + num(it.scrapPercent) / 100),
          })),
        });
      })
      .catch(() => {
        if (live) setExplosion({ missing: true } as Rec);
      })
      .finally(() => {
        if (live) setExplosionBusy(false);
      });
    return () => {
      live = false;
    };
  }, [expProductId, expQty, pickBom]);

  const submit = () => {
    setError('');
    setNotice('');
    if (!f.productId) {
      setError('Select a product for the BOM.');
      return;
    }
    setSaving(true);
    api<{ data: unknown }>('/api/ops/manufacturing/boms', {
      method: 'POST',
      body: JSON.stringify({
        productId: f.productId,
        code: String(f.code ?? '').trim() || undefined,
        name: String(f.name ?? '').trim() || undefined,
        version: num(f.version) || 1,
        quantity: num(f.quantity) || 1,
        status: String(f.status ?? 'DRAFT'),
        isActive: !!f.isActive,
        effectiveFrom: f.effectiveFrom ? String(f.effectiveFrom) : undefined,
        effectiveTo: f.effectiveTo ? String(f.effectiveTo) : undefined,
      }),
    })
      .then(() => {
        setNotice('BOM ' + String(f.code ?? '') + ' created.');
        setOpen(false);
        setF((p) => ({ ...p, code: '', name: '', version: '1', status: 'DRAFT', effectiveFrom: '', effectiveTo: '' }));
        load();
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Save failed'))
      .finally(() => setSaving(false));
  };

  const canCreate = can(user, 'production.boms.create');
  const bomRows = boms ?? [];
  const routingRows = routings ?? [];
  const activeBoms = bomRows.filter((b) => b.isActive).length;
  const materialLines = bomRows.reduce((s, b) => s + num(b.itemCount), 0);
  const totalOps = routingRows.reduce((s, r) => s + num(r.opCount), 0);
  const expItems = Array.isArray(explosion?.items) ? (explosion.items as Rec[]) : [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Bills of Materials &amp; Routings</h1>
          <p className="muted">Engineering hub — material structures, routing operations and BOM explosion for production planning.</p>
        </div>
        <div className="head-actions">
          {canCreate && <button className="btn btn-primary" onClick={() => setOpen(true)}>New BOM</button>}
        </div>
      </header>

      {notice && <div className="alert alert-success">{notice}</div>}
      {error && !boms && <ErrorBanner error={error} />}

      <div className="kpi-grid">
        <Kpi label="BOMs" value={bomRows.length} sub={activeBoms + ' active'} />
        <Kpi label="Material lines" value={materialLines} sub="across all BOMs" />
        <Kpi label="Routings" value={routingRows.length} sub={totalOps + ' operations'} />
        <Kpi label="Explosion" value="Live" sub="plan quantities below" />
      </div>

      <MmsSection
        title="Bills of Materials"
        sub="Click a row to expand material lines. Basis quantity is the batch the BOM covers (e.g. 1000 reams)."
      >
        {!boms && <PageLoader label="Loading BOMs..." />}
        {boms && bomRows.length === 0 && (
          <p className="muted">No bills of materials yet. Create one to structure product inputs.</p>
        )}
        {boms && bomRows.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>BOM</th>
                  <th>Product</th>
                  <th className="cell-num">Version</th>
                  <th className="cell-num">Basis qty</th>
                  <th>Unit</th>
                  <th className="cell-num">Items</th>
                  <th>Effective</th>
                  <th>Status</th>
                  <th>Active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bomRows.map((r) => (
                  <BomRowFragments
                    key={String(r.id)}
                    r={r}
                    expanded={bomDetailId === Number(r.id) && !!bomDetail}
                    loading={detailLoading && bomDetailId === Number(r.id)}
                    detail={bomDetailId === Number(r.id) ? bomDetail : null}
                    onToggle={() => toggleBom(r)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </MmsSection>

      <MmsSection
        title="Routings"
        sub="Click a row to expand the operation sequence — work centre, machine and standard times."
      >
        {!routings && <PageLoader label="Loading routings..." />}
        {routings && routingRows.length === 0 && (
          <p className="muted">No routings yet. Create one to define the production operation sequence.</p>
        )}
        {routings && routingRows.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Routing</th>
                  <th>Product</th>
                  <th className="cell-num">Version</th>
                  <th className="cell-num">Operations</th>
                  <th className="cell-num">Setup + teardown (min)</th>
                  <th>Active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {routingRows.map((r) => (
                  <RoutingRowFragments
                    key={String(r.id)}
                    r={r}
                    expanded={routingDetailId === Number(r.id) && !!routingDetail}
                    loading={detailLoading && routingDetailId === Number(r.id)}
                    detail={routingDetailId === Number(r.id) ? routingDetail : null}
                    onToggle={() => toggleRouting(r)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </MmsSection>

      <MmsSection
        title="BOM Explosion"
        sub="Pick a product and a planned quantity — required materials and scrap load are computed live from the active BOM."
      >
        <div className="form-grid" style={{ marginBottom: 14 }}>
          <Field label="Product" required>
            <ProductSelect value={expProductId} onChange={setExpProductId} />
          </Field>
          <Field label="Planned quantity">
            <input inputMode="numeric" value={expQty} onChange={(e) => setExpQty(e.target.value)} />
          </Field>
        </div>
        {explosionBusy && <p className="muted">Computing requirements...</p>}
        {!explosionBusy && !!explosion && explosion.missing ? (
          <div className="alert alert-warn">
            No active BOM found for this product — create one first, then recalculate.
          </div>
        ) : null}
        {!explosionBusy && !!explosion && !explosion.missing && expItems.length > 0 ? (
          <>
            <div className="kpi-grid">
              <Kpi label="Product" value={String(explosion.productCode ?? '')} sub={String(explosion.productName ?? '')} />
              <Kpi label="Planned qty" value={fmtNum(explosion.plannedQty)} sub={String(explosion.unitCode ?? '')} />
              <Kpi label="BOM basis" value={fmtNum(explosion.basis)} sub={String(explosion.unitCode ?? '')} />
              <Kpi label="Factor" value={num(explosion.factor).toFixed(3)} sub="planned ÷ basis" />
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Material</th>
                    <th>Type</th>
                    <th>UoM</th>
                    <th className="cell-num">Required</th>
                    <th className="cell-num">Scrap %</th>
                    <th className="cell-num">Gross requirement</th>
                    <th>Consumable</th>
                  </tr>
                </thead>
                <tbody>
                  {expItems.map((it) => (
                    <tr key={String(it.id)}>
                      <td>
                        <div className="cell-mono">{String(it.materialCode ?? '')}</div>
                        <div>{String(it.materialName ?? '')}</div>
                      </td>
                      <td>{String(it.materialType ?? '-')}</td>
                      <td className="cell-mono">{String(it.unitCode ?? '-')}</td>
                      <td className="cell-num">{fmtNum(it.required)}</td>
                      <td className="cell-num">{pct(it.scrapPercent)}</td>
                      <td className="cell-num">{fmtNum(it.gross)}</td>
                      <td>
                        {it.isConsumable ? (
                          <span className="badge badge-blue">● Consumable</span>
                        ) : (
                          <span className="badge badge-neutral">● Direct</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {!explosionBusy && !!explosion && !explosion.missing && expItems.length === 0 ? (
          <p className="muted">This BOM has no material lines yet.</p>
        ) : null}
      </MmsSection>

      {open && (
        <Modal
          title="New bill of materials"
          onClose={() => setOpen(false)}
          wide
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving} onClick={submit}>
                {saving ? 'Saving...' : 'Create BOM'}
              </button>
            </>
          }
        >
          {error && open && <ErrorBanner error={error} />}
          <div className="form-grid">
            <Field label="Product" required>
              <ProductSelect value={String(f.productId)} onChange={(v) => set('productId', v)} />
            </Field>
            <Field label="BOM code">
              <input type="text" placeholder="e.g. BOM-A4-80-v2" value={String(f.code ?? '')} onChange={(e) => set('code', e.target.value)} />
            </Field>
            <Field label="Name">
              <input type="text" placeholder="e.g. NATEX A4 80gsm BOM" value={String(f.name ?? '')} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Version">
              <input type="number" min={1} value={String(f.version ?? '')} onChange={(e) => set('version', e.target.value)} />
            </Field>
            <Field label="Basis quantity">
              <input type="number" min={1} value={String(f.quantity ?? '')} onChange={(e) => set('quantity', e.target.value)} />
            </Field>
            <Field label="Status">
              <select value={String(f.status ?? 'DRAFT')} onChange={(e) => set('status', e.target.value)}>
                <option value="DRAFT">Draft</option>
                <option value="PENDING">Pending approval</option>
                <option value="APPROVED">Approved</option>
              </select>
            </Field>
            <Field label="Effective from">
              <input type="date" value={String(f.effectiveFrom ?? '')} onChange={(e) => set('effectiveFrom', e.target.value)} />
            </Field>
            <Field label="Effective to">
              <input type="date" value={String(f.effectiveTo ?? '')} onChange={(e) => set('effectiveTo', e.target.value)} />
            </Field>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13 }}>
            <input type="checkbox" checked={!!f.isActive} onChange={(e) => set('isActive', e.target.checked)} />
            Active BOM — available for planning and explosion
          </label>
        </Modal>
      )}
    </div>
  );
}

function BomRowFragments({
  r,
  expanded,
  loading,
  detail,
  onToggle,
}: {
  r: Rec;
  expanded: boolean;
  loading: boolean;
  detail: Rec | null;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="row-click" onClick={onToggle}>
        <td className="cell-mono">{String(r.code ?? '')}</td>
        <td>
          <div className="cell-mono">{String(r.productCode ?? '')}</div>
          <div>{String(r.productName ?? '')}</div>
        </td>
        <td className="cell-num">{String(r.version ?? '')}</td>
        <td className="cell-num">{fmtNum(r.quantity)}</td>
        <td className="cell-mono">{String(r.unitCode ?? '-')}</td>
        <td className="cell-num">{fmtNum(r.itemCount)}</td>
        <td className="cell-mono">
          {r.effectiveFrom ? d10(r.effectiveFrom) : '-'}
          {r.effectiveTo ? ' → ' + d10(r.effectiveTo) : ''}
        </td>
        <td><Badge value={r.status} /></td>
        <td>{r.isActive ? <Badge value="ACTIVE" /> : <Badge value="INACTIVE" />}</td>
        <td className="cell-num">{expanded ? '−' : '+'}</td>
      </tr>
      {expanded && (
        <tr className="row-detail">
          <td colSpan={10}>
            {loading ? (
              <p className="muted">Loading detail...</p>
            ) : detail ? (
              <div style={{ padding: '8px 2px' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <strong>{String(detail.name ?? '')}</strong>
                  <Badge value={detail.status} />
                  <span className="muted">Basis: {fmtNum(detail.quantity)} {String(detail.unitCode ?? '')}</span>
                </div>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Material</th>
                        <th>Type</th>
                        <th>UoM</th>
                        <th className="cell-num">Qty per basis</th>
                        <th className="cell-num">Scrap %</th>
                        <th>Consumable</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(Array.isArray(detail.items) ? (detail.items as Rec[]) : []).map((it) => (
                        <tr key={String(it.id)}>
                          <td>
                            <div className="cell-mono">{String(it.materialCode ?? '')}</div>
                            <div>{String(it.materialName ?? '')}</div>
                          </td>
                          <td>{String(it.materialType ?? '-')}</td>
                          <td className="cell-mono">{String(it.unitCode ?? '-')}</td>
                          <td className="cell-num">{fmtNum(it.quantity)}</td>
                          <td className="cell-num">{pct(it.scrapPercent)}</td>
                          <td>
                            {it.isConsumable ? (
                              <span className="badge badge-blue">● Consumable</span>
                            ) : (
                              <span className="badge badge-neutral">● Direct</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </td>
        </tr>
      )}
    </>
  );
}

function RoutingRowFragments({
  r,
  expanded,
  loading,
  detail,
  onToggle,
}: {
  r: Rec;
  expanded: boolean;
  loading: boolean;
  detail: Rec | null;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="row-click" onClick={onToggle}>
        <td className="cell-mono">{String(r.code ?? '')}</td>
        <td>
          <div className="cell-mono">{String(r.productCode ?? '')}</div>
          <div>{String(r.productName ?? '')}</div>
        </td>
        <td className="cell-num">{String(r.version ?? '')}</td>
        <td className="cell-num">{fmtNum(r.opCount)}</td>
        <td className="cell-num">{fmtNum(r.setupTeardownMin)}</td>
        <td>{r.isActive ? <Badge value="ACTIVE" /> : <Badge value="INACTIVE" />}</td>
        <td className="cell-num">{expanded ? '−' : '+'}</td>
      </tr>
      {expanded && (
        <tr className="row-detail">
          <td colSpan={7}>
            {loading ? (
              <p className="muted">Loading detail...</p>
            ) : detail ? (
              <div style={{ padding: '8px 2px' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <strong>{String(detail.name ?? '')}</strong>
                  <span className="muted">Version {String(detail.version ?? '')}</span>
                </div>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th className="cell-num">Seq</th>
                        <th>Operation</th>
                        <th>Work centre</th>
                        <th>Machine</th>
                        <th className="cell-num">Setup min</th>
                        <th className="cell-num">Run min/unit</th>
                        <th className="cell-num">Teardown min</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(Array.isArray(detail.operations) ? (detail.operations as Rec[]) : []).map((op) => (
                        <tr key={String(op.id)}>
                          <td className="cell-num">{String(op.seq ?? '')}</td>
                          <td><strong>{String(op.name ?? '')}</strong></td>
                          <td>
                            {op.workCentreCode ? <span className="cell-mono">{String(op.workCentreCode)}</span> : '-'}
                            {op.workCentreName ? <span className="muted"> · {String(op.workCentreName)}</span> : null}
                          </td>
                          <td>
                            {op.machineCode ? <span className="cell-mono">{String(op.machineCode)}</span> : '-'}
                            {op.machineName ? <span className="muted"> · {String(op.machineName)}</span> : null}
                          </td>
                          <td className="cell-num">{fmtNum(op.setupTimeMin)}</td>
                          <td className="cell-num">{fmtNum(op.runTimePerUnitMin)}</td>
                          <td className="cell-num">{fmtNum(op.teardownTimeMin)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </td>
        </tr>
      )}
    </>
  );
}

function CostRow({ r, expanded, onToggle }: { r: Rec; expanded: boolean; onToggle: () => void }) {
  const actual = num(r.actualCost);
  const std = num(r.standardCost);
  const variance = num(r.costVariance);
  const produced = num(r.producedQty);
  const pkg = (r.pkg && typeof r.pkg === 'object' ? r.pkg : null) as Rec | null;
  const hasPkg = !!pkg && produced > 0 && num(pkg.reamKg) > 0 && num(pkg.reamsPerCarton) > 0 && num(pkg.cartonsPerPallet) > 0;
  const perReam = produced > 0 ? actual / produced : 0;
  const perSheet = hasPkg && num(pkg.sheetsPerReam) > 0 ? perReam / num(pkg.sheetsPerReam) : 0;
  const perCarton = hasPkg ? perReam * num(pkg.reamsPerCarton) : 0;
  const perPallet = hasPkg ? perCarton * num(pkg.cartonsPerPallet) : 0;
  const totalKg = hasPkg ? produced * num(pkg.reamKg) : 0;
  const perKg = totalKg > 0 ? actual / totalKg : 0;
  const perMt = perKg * 1000;
  const stdPerUnit = produced > 0 ? std / produced : 0;
  const comps = [
    { label: 'Material', value: num(r.actualMaterialCost), color: 'var(--info)' },
    { label: 'Labour', value: num(r.actualLabourCost), color: 'var(--success)' },
    { label: 'Machine', value: num(r.actualMachineCost), color: 'var(--amber)' },
    { label: 'Overhead', value: num(r.actualOverheadCost), color: 'var(--teal)' },
    { label: 'Waste', value: num(r.actualWasteCost), color: 'var(--danger)' },
    { label: 'Other', value: num(r.actualOtherCost), color: 'var(--muted)' },
  ].filter((c) => c.value > 0);
  const compTotal = comps.reduce((s, c) => s + c.value, 0);
  const vLabel = variance <= 0 ? 'Favourable' : 'Adverse';
  const vClass = variance <= 0 ? 'badge-green' : 'badge-red';
  return (
    <>
      <tr className="row-click" onClick={onToggle}>
        <td className="cell-mono">{String(r.woNo ?? '')}</td>
        <td>
          <div className="cell-mono">{String(r.productCode ?? '')}</div>
          <div>{String(r.productName ?? '')}</div>
        </td>
        <td className="cell-num">{fmtNum(r.quantity)}</td>
        <td className="cell-num">{fmtNum(r.producedQty)}</td>
        <td className="cell-num">{fmtMoney(r.standardCost)}</td>
        <td className="cell-num"><strong>{fmtMoney(r.actualCost)}</strong></td>
        <td className="cell-num">
          <span className={'badge ' + vClass}><span className="badge-icon" aria-hidden>●</span>{fmtMoney(variance)}</span>
          <div className="muted" style={{ fontSize: 11 }}>{vLabel}</div>
        </td>
        <td className="cell-num">{num(r.yieldPercent).toFixed(1)}%</td>
        <td className="cell-num">{num(r.efficiencyPercent).toFixed(1)}%</td>
        <td>
          {r.machineCode ? <span className="cell-mono">{String(r.machineCode)}</span> : <span className="muted">-</span>}
          {r.machineName ? <span className="muted"> / {String(r.machineName)}</span> : null}
        </td>
        <td><Badge value={r.status} /></td>
        <td className="cell-num">{expanded ? '-' : '+'}</td>
      </tr>
      {expanded && (
        <tr className="row-detail">
          <td colSpan={12}>
            <div style={{ padding: '10px 2px' }}>
              <div className="kpi-grid" style={{ marginBottom: 12 }}>
                <Kpi label="Std cost / unit" value={fmtMoney(stdPerUnit)} sub={String(r.unitCode ?? 'unit') + ' recorded std'} />
                <Kpi label="Actual cost / unit" value={fmtMoney(perReam)} sub={String(r.unitCode ?? 'unit') + ' actual'} />
                <Kpi label="Order actual" value={fmtMoney(actual)} sub="total actual cost" />
                <Kpi label="Variance" value={fmtMoney(variance)} sub={vLabel} />
              </div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 320, flex: 1 }}>
                  <div className="muted" style={{ marginBottom: 6, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>Cost components</div>
                  {compTotal > 0 ? (
                    <>
                      <div className="cost-mix-bar">
                        {comps.map((c) => (
                          <span key={c.label} style={{ width: Math.max(1, (c.value / compTotal) * 100) + '%', background: c.color }} title={c.label} />
                        ))}
                      </div>
                      <div className="cost-mix-legend">
                        {comps.map((c) => (
                          <span key={c.label}>
                            <i style={{ background: c.color }} />
                            {c.label} {fmtMoney(c.value)}
                          </span>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="muted">No component breakdown recorded for this order.</p>
                  )}
                </div>
                {hasPkg && (
                  <div style={{ minWidth: 300, flex: 1 }}>
                    <div className="muted" style={{ marginBottom: 6, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>Unit economics</div>
                    <div className="table-wrap">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>Unit</th>
                            <th className="cell-num">Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr><td>Per sheet ({fmtNum(pkg.sheetsPerReam)} / ream)</td><td className="cell-num">{fmtMoney(perSheet)}</td></tr>
                          <tr><td>Per ream</td><td className="cell-num">{fmtMoney(perReam)}</td></tr>
                          <tr><td>Per carton ({fmtNum(pkg.reamsPerCarton)} reams)</td><td className="cell-num">{fmtMoney(perCarton)}</td></tr>
                          <tr><td>Per pallet ({fmtNum(pkg.cartonsPerPallet)} cartons)</td><td className="cell-num">{fmtMoney(perPallet)}</td></tr>
                          <tr><td>Per kg</td><td className="cell-num">{fmtMoney(perKg)}</td></tr>
                          <tr><td>Per metric ton</td><td className="cell-num">{fmtMoney(perMt)}</td></tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function MmsCosting() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [expanded, setExpanded] = useState(0);

  const load = useCallback(() => {
    setError('');
    api<{ data: unknown }>('/api/ops/manufacturing/costing')
      .then((r) => setData(r.data && typeof r.data === 'object' ? (r.data as Rec) : null))
      .catch((e) => setError(e instanceof Error ? e.message : 'Costing desk failed'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const summary = (data?.summary ?? {}) as Rec;
  const rows = (data?.rows as Rec[]) ?? [];
  const ql = q.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (status && String(r.status ?? '') !== status) return false;
    if (!ql) return true;
    return [r.woNo, r.productCode, r.productName, r.machineCode, r.machineName].some((v) =>
      String(v ?? '').toLowerCase().includes(ql));
  });
  const statuses = Array.from(new Set(rows.map((r) => String(r.status ?? '')))).sort();

  const exportCsv = () => {
    const esc = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const head = ['Work Order', 'Product', 'Quantity', 'Produced', 'Standard Cost', 'Actual Cost', 'Variance', 'Yield %', 'Efficiency %', 'Status'];
    const body = filtered.map((r) =>
      [r.woNo, r.productCode + ' ' + r.productName, r.quantity, r.producedQty, r.standardCost, r.actualCost, r.costVariance, r.yieldPercent, r.efficiencyPercent, r.status].map(esc).join(','));
    const blob = new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'production-costing.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const variance = num(summary.totalVariance);
  const vLabel = variance <= 0 ? 'Favourable' : 'Adverse';
  const mix = [
    { label: 'Material', value: num(summary.totalMaterial), color: 'var(--info)' },
    { label: 'Labour', value: num(summary.totalLabour), color: 'var(--success)' },
    { label: 'Machine', value: num(summary.totalMachine), color: 'var(--amber)' },
    { label: 'Overhead', value: num(summary.totalOverhead), color: 'var(--teal)' },
    { label: 'Waste', value: num(summary.totalWaste), color: 'var(--danger)' },
  ].filter((c) => c.value > 0);
  const mixTotal = mix.reduce((s, c) => s + c.value, 0);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Manufacturing Costing</h1>
          <p className="muted">Standard vs actual production cost per order, cost mix and unit economics per sheet, ream, carton and pallet.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/finance/costing')} disabled={!can(user, 'finance.production_costs.view')}>Finance view</button>
          <button className="btn btn-primary" onClick={exportCsv} disabled={filtered.length === 0}>Export CSV</button>
        </div>
      </header>

      {error && !data && <ErrorBanner error={error} />}
      {!data && <PageLoader label="Loading cost desk..." />}

      {data && (
        <>
          <div className="kpi-grid">
            <Kpi label="Total standard cost" value={fmtMoney(summary.totalStandard)} sub={summary.orders + ' production orders'} />
            <Kpi label="Total actual cost" value={fmtMoney(summary.totalActual)} sub={summary.completed + ' completed / ' + summary.open + ' open'} />
            <Kpi label="Variance (posted)" value={fmtMoney(variance)} sub={vLabel + ' / ' + num(summary.variancePct).toFixed(1) + '% vs standard'} />
            <Kpi label="Favourable / Adverse" value={summary.favourable + ' / ' + summary.adverse} sub={summary.posted + ' cost posted to finance'} />
          </div>

          <MmsSection title="Actual cost mix" sub="Share of actual cost by component across all recorded production orders.">
            {mixTotal > 0 ? (
              <>
                <div className="cost-mix-bar" style={{ marginBottom: 12 }}>
                  {mix.map((c) => (
                    <span key={c.label} style={{ width: Math.max(1, (c.value / mixTotal) * 100) + '%', background: c.color }} title={c.label} />
                  ))}
                </div>
                <div className="cost-mix-legend">
                  {mix.map((c) => (
                    <span key={c.label}>
                      <i style={{ background: c.color }} />
                      {c.label} {fmtMoney(c.value)}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="muted">No cost components recorded yet.</p>
            )}
          </MmsSection>

          <MmsSection
            title="Production orders"
            sub="Click a row to expand cost components and unit economics. Variance uses the posted production cost basis."
            actions={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input placeholder="Search order, product, machine..." value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
                <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 150 }}>
                  <option value="">All statuses</option>
                  {statuses.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            }
          >
            {rows.length === 0 && <p className="muted">No production orders with costing data yet. Run costing from Finance to populate posted costs.</p>}
            {rows.length > 0 && filtered.length === 0 && <p className="muted">No orders match the current filters.</p>}
            {filtered.length > 0 && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Work order</th>
                      <th>Product</th>
                      <th className="cell-num">Qty</th>
                      <th className="cell-num">Produced</th>
                      <th className="cell-num">Std cost</th>
                      <th className="cell-num">Actual cost</th>
                      <th className="cell-num">Variance</th>
                      <th className="cell-num">Yield</th>
                      <th className="cell-num">Efficiency</th>
                      <th>Machine</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <CostRow
                        key={String(r.id)}
                        r={r}
                        expanded={expanded === Number(r.id)}
                        onToggle={() => setExpanded(expanded === Number(r.id) ? 0 : Number(r.id))}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>{filtered.length} of {rows.length} orders shown.</p>
          </MmsSection>
        </>
      )}
    </div>
  );
}
