// FactoryOS — premium Factory Operating System UX for HOPE DESIGN GROUP LTD.
// See -> Understand -> Decide -> Act -> Confirm.
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, fmtMoney, fmtNum, ListResult } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';
import { pick } from '../helpers';

type Rec = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const pct = (v: unknown): string => num(v).toFixed(1) + '%';
const clock = (v: unknown): string => String(v ?? '').slice(11, 16);
const dayLabel = (v: unknown): string => String(v ?? '').slice(0, 10);

const MACHINE_TONE: Record<string, string> = {
  RUNNING: 'var(--success)',
  SETUP: 'var(--info)',
  CHANGEOVER: 'var(--info)',
  IDLE: 'var(--muted)',
  MAINTENANCE: 'var(--amber)',
  BREAKDOWN: 'var(--danger)',
  OFFLINE: 'var(--muted)',
};

const DOWNTIME_CATS = ['MECHANICAL', 'ELECTRICAL', 'MATERIAL_SHORTAGE', 'QUALITY_ISSUE', 'SETUP', 'CHANGEOVER', 'CLEANING', 'OPERATOR', 'UTILITY_FAILURE', 'MAINTENANCE', 'OTHER'];

const WASTE_CATS = ['EDGE_TRIM', 'NORMAL_PROCESS_LOSS', 'CUTTING', 'MACHINE_DAMAGE', 'PAPER_BREAKAGE', 'INCORRECT_CUTTING', 'OPERATOR_ERROR', 'PACKAGING_DAMAGE', 'QUALITY_REJECTION'];

// Only active finished goods can be produced. Raw materials, packaging and
// consumables stay in inventory and are never production order products.
const MANUFACTURABLE_TYPES = ['REAM', 'FINISHED_GOODS', 'SHEET', 'SECURITY_ITEM'];

function StateDot({ state }: { state: unknown }) {
  const s = String(state ?? 'IDLE').toUpperCase();
  return <span className="machine-state-dot" style={{ background: MACHINE_TONE[s] ?? 'var(--muted)' }} title={s} />;
}

function Progress({ value, max = 100 }: { value: number; max?: number }) {
  const p = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : Math.max(0, Math.min(100, value));
  return (
    <div className="fos-progress" role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
      <div className="fos-progress-fill" style={{ width: p + '%' }} />
    </div>
  );
}

function KpiCard({ label, value, sub, delta, onClick }: { label: string; value: ReactNode; sub?: ReactNode; delta?: number; onClick?: () => void }) {
  const hasDelta = delta !== undefined && Number.isFinite(delta);
  return (
    <button className="kpi-card fos-kpi" disabled={!onClick} onClick={onClick}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
      {hasDelta && (
        <span className={'fos-delta ' + ((delta as number) >= 0 ? 'up' : 'down')}>
          {(delta as number) >= 0 ? '▲' : '▼'} {Math.abs(delta as number).toFixed(1)}%
        </span>
      )}
    </button>
  );
}

function PriorityTag({ severity }: { severity: unknown }) {
  const s = String(severity ?? 'NORMAL').toUpperCase();
  const cls = s === 'CRITICAL' || s === 'HIGH' ? 'prio-critical' : s === 'ATTENTION' || s === 'MEDIUM' ? 'prio-attention' : s === 'MONITOR' || s === 'LOW' ? 'prio-monitor' : 'prio-normal';
  return <span className={'fos-prio ' + cls}>{s}</span>;
}

function FosEmpty({ title, body, actions }: { title: string; body: string; actions: { label: string; onClick: () => void; primary?: boolean }[] }) {
  return (
    <div className="fos-empty">
      <div className="fos-empty-icon">◈</div>
      <h3>{title}</h3>
      <p className="muted">{body}</p>
      {actions.length > 0 && (
        <div className="fos-empty-actions">
          {actions.map((a) => (
            <button key={a.label} className={'btn ' + (a.primary ? 'btn-primary' : '')} onClick={a.onClick}>{a.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusTile({ label, state, text }: { label: string; state: 'ok' | 'warn' | 'bad' | 'info'; text: string }) {
  const icon = state === 'ok' ? '✓' : state === 'warn' ? '⚠' : state === 'bad' ? '✕' : '●';
  return (
    <div className={'fos-tile fos-tile-' + state}>
      <span className="fos-tile-icon">{icon}</span>
      <span className="fos-tile-label">{label}</span>
      <span className="fos-tile-text">{text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Factory command center (dashboard)
// ---------------------------------------------------------------------------
export function FactoryDashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ data: Rec }>('/api/ops/manufacturing/dashboard')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Dashboard failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening the factory command center…" />;
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
  const yesterday = trend.length > 1 ? num(trend[trend.length - 2].actual) : 0;
  const todayOut = num(p.outputToday);
  const delta = yesterday > 0 ? ((todayOut - yesterday) / yesterday) * 100 : undefined;
  const firstName = user?.first_name ?? 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const prioRank = (a: Rec) => {
    const s = String(a.severity ?? 'NORMAL').toUpperCase();
    return s === 'CRITICAL' || s === 'HIGH' ? 0 : s === 'ATTENTION' || s === 'MEDIUM' ? 1 : s === 'MONITOR' || s === 'LOW' ? 2 : 3;
  };
  const openAlerts = alerts.filter((a) => String(a.status ?? 'OPEN').toUpperCase() === 'OPEN').sort((a, b) => prioRank(a) - prioRank(b));
  const ackAlert = (id: unknown) => {
    api('/api/ops/manufacturing/alerts/' + String(id) + '/ack', { method: 'POST' }).then(load).catch(() => undefined);
  };
  const todayStr = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing · Command Center</p>
          <h1>{greeting}, {firstName}</h1>
          <p className="muted">{todayStr} · HOPE DESIGN FACTORY</p>
        </div>
        <div className="head-actions fos-pills">
          <span className="fos-pill">Factory · Main</span>
          <span className="fos-pill">Shift · Morning</span>
          <button className="btn btn-primary" onClick={() => navigate('/plant/new-ux')}>+ New order</button>
        </div>
      </header>
      {openAlerts.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h3>Priority alerts</h3>
            <span className="muted">{openAlerts.length} open</span>
          </div>
          <div className="fos-alert-list">
            {openAlerts.slice(0, 6).map((a) => (
              <div key={String(a.id)} className="fos-alert">
                <PriorityTag severity={a.severity} />
                <div className="fos-alert-body">
                  <strong>{String(a.title ?? 'Alert')}</strong>
                  <span className="muted">{String(a.message ?? '')}</span>
                </div>
                <div className="fos-alert-actions">
                  <button className="btn btn-sm" onClick={() => ackAlert(a.id)}>Ack</button>
                  <button className="btn btn-sm" onClick={() => navigate('/plant/alerts')}>View</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="kpi-grid">
        <KpiCard label="Today's output" value={fmtNum(todayOut)} sub={'Target ' + fmtNum(p.plannedToday)} delta={delta} onClick={() => navigate('/plant/outputs')} />
        <KpiCard label="Target achievement" value={pct(p.achievementTodayPct)} sub={fmtNum(todayOut) + ' / ' + fmtNum(p.plannedToday)} onClick={() => navigate('/plant/outputs')} />
        <KpiCard label="Machines running" value={fmtNum(m.running) + ' / ' + fmtNum(m.total)} sub={'Utilisation ' + pct(m.utilizationPct)} onClick={() => navigate('/plant/live')} />
        <KpiCard label="Waste" value={pct(w.wastePct)} sub={'Cost ' + fmtMoney(w.cost) + ' · scrap ' + fmtNum(w.scrapQty)} onClick={() => navigate('/plant/waste')} />
      </div>
      <div className="fos-stat-strip">
        <span>Efficiency <strong>{pct(p.efficiencyPct)}</strong></span>
        <span>Week <strong>{fmtNum(p.outputWeek)}</strong></span>
        <span>Month <strong>{fmtNum(p.outputMonth)}</strong></span>
        <span>QC pass <strong>{pct(q.passRatePct)}</strong></span>
        <span>Materials <strong>{fmtNum(mat.available)}</strong> avail</span>
        <span>WIP <strong>{fmtNum(mat.wipQty)}</strong></span>
      </div>
      <section className="card">
        <div className="card-head">
          <h3>Machines</h3>
          <button className="btn btn-sm" onClick={() => navigate('/plant/live')}>Live factory</button>
        </div>
        <div className="fos-machine-grid">
          {machines.map((mc) => {
            const woId = mc.currentWoId;
            return (
              <button key={String(mc.id)} className="fos-machine" onClick={() => navigate(woId ? '/plant/orders/' + String(woId) : '/plant/live')}>
                <div className="fos-machine-top">
                  <span className="cell-mono">{String(mc.code)}</span>
                  <span className="fos-machine-state"><StateDot state={mc.machineState ?? mc.status} /><Badge value={mc.machineState ?? mc.status} /></span>
                </div>
                <strong>{String(mc.name)}</strong>
                <div className="muted">{woId ? 'WO ' + String(mc.currentWo ?? '') : String(mc.type ?? '')}</div>
                <div className="fos-machine-meta"><span>{fmtNum(mc.productionHours)}h run</span><span>{fmtNum(mc.downtimeHours)}h down</span></div>
              </button>
            );
          })}
        </div>
      </section>
      <div className="wh-grid">
        <section className="card">
          <div className="card-head"><h3>Production trend</h3><span className="muted">last 14 days</span></div>
          <div className="card-pad">
            <div className="trend-chart">
              {trend.map((t) => {
                const plan = num(t.planned);
                const act = num(t.actual);
                return (
                  <div className="trend-col" key={String(t.day)} title={dayLabel(t.day) + ' · plan ' + plan + ' · actual ' + act}>
                    <div className="trend-bars">
                      <div className="trend-bar plan" style={{ height: (plan / maxTrend) * 100 + '%' }} />
                      <div className="trend-bar actual" style={{ height: (act / maxTrend) * 100 + '%' }} />
                    </div>
                    <div className="trend-day">{dayLabel(t.day).slice(5)}</div>
                  </div>
                );
              })}
              {trend.length === 0 && <p className="muted">No trend data yet.</p>}
            </div>
            <div className="trend-legend">
              <span><i className="trend-swatch plan" /> Planned</span>
              <span><i className="trend-swatch actual" /> Actual</span>
            </div>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h3>Recent activity</h3><button className="btn btn-sm" onClick={() => navigate('/plant/alerts')}>Alerts</button></div>
          <div className="activity-list">
            {activity.slice(0, 8).map((a, i) => (
              <div className="activity-item" key={String(a.id ?? i)}>
                <span className="activity-time cell-mono">{clock(a.createdAt)}</span>
                <span className="activity-text">
                  <Badge value={a.eventType} />
                  <span>{String(a.entityCode ?? a.entityType ?? '')}</span>
                </span>
              </div>
            ))}
            {activity.length === 0 && <p className="muted">No recent activity.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live factory (machine control board)
// ---------------------------------------------------------------------------
export function LiveFactory() {
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/manufacturing/machines/status')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Machine status failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error && !rows) return <ErrorBanner error={error} />;
  if (!rows) return <PageLoader label="Loading live factory…" />;
  const running = rows.filter((r) => String(r.machineState ?? r.status ?? '').toUpperCase() === 'RUNNING').length;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Shop floor · Live</p>
          <h1>Live factory</h1>
          <p className="muted">{running} of {rows.length} machines running right now.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/plant/machines')}>Machine register</button>
          <button className="btn" onClick={() => navigate('/plant/command')}>Command center</button>
        </div>
      </header>
      {rows.length === 0 ? (
        <FosEmpty title="No machines yet" body="Add machines to the register and they will appear here as live cards." actions={[{ label: 'Machine register', onClick: () => navigate('/plant/machines') }]} />
      ) : (
        <div className="fos-machine-grid fos-machine-grid-lg">
          {rows.map((mc) => {
            const state = String(mc.machineState ?? mc.status ?? 'IDLE').toUpperCase();
            const woId = mc.currentWoId;
            return (
              <div key={String(mc.id)} className={'fos-machine fos-machine-' + state.toLowerCase()}>
                <div className="fos-machine-top">
                  <span className="cell-mono">{String(mc.code)}</span>
                  <span className="fos-machine-state"><StateDot state={state} /><Badge value={state} /></span>
                </div>
                <strong>{String(mc.name)}</strong>
                <div className="muted">{String(mc.workCentreName ?? mc.type ?? '')}</div>
                <div className="fos-machine-job">
                  {woId ? (
                    <>
                      <span className="cell-mono">WO {String(mc.currentWo ?? '')}</span>
                      <span>{String(mc.operatorName ?? '—')}</span>
                    </>
                  ) : (
                    <span className="muted">No production order</span>
                  )}
                </div>
                <div className="fos-machine-meta">
                  <span>{fmtNum(mc.productionHours)}h run</span>
                  <span>{fmtNum(mc.downtimeHours)}h down</span>
                </div>
                <div className="fos-machine-actions">
                  {woId ? (
                    <button className="btn btn-sm btn-primary" onClick={() => navigate('/plant/orders/' + String(woId))}>View</button>
                  ) : (
                    <button className="btn btn-sm" onClick={() => navigate('/plant/gantt')}>Assign work</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Production order workspace — one screen for the whole order
// ---------------------------------------------------------------------------
const WO_TABS = ['overview', 'materials', 'operations', 'output', 'quality', 'waste', 'cost', 'activity'];

export function OrderWorkspace({ id }: { id: number }) {
  const { user } = useAuth();
  const [data, setData] = useState<{ workOrder: Rec; materials: Rec[]; operations: Rec[]; outputs: Rec[] } | null>(null);
  const [cost, setCost] = useState<Rec | null>(null);
  const [tab, setTab] = useState('overview');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [outOpen, setOutOpen] = useState(false);
  const [outType, setOutType] = useState('GOOD');
  const [outQty, setOutQty] = useState('100');

  const load = useCallback(() => {
    setError('');
    api<{ data: { workOrder: Rec; materials: Rec[]; operations: Rec[]; outputs: Rec[] } }>(`/api/ops/production/work-orders/${id}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Order failed'));
    api<{ data: Rec }>(`/api/ops/manufacturing/costing/${id}`)
      .then((r) => setCost(r.data))
      .catch(() => setCost(null));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening production order…" />;
  const wo = data.workOrder;
  const materials = data.materials ?? [];
  const operations = data.operations ?? [];
  const outputs = data.outputs ?? [];
  const status = String(wo.status ?? '').toUpperCase();
  const planned = num(wo.quantity ?? wo.plannedQty);
  const produced = num(wo.producedQty);
  const waste = num(wo.wasteQty);
  const canStart = ['APPROVED', 'RELEASED', 'MATERIALS_RESERVED', 'MATERIALS_ISSUED'].includes(status);
  const inProgress = status === 'IN_PROGRESS';
  const completed = ['COMPLETED', 'CLOSED'].includes(status);
  const matOk = materials.length > 0 && materials.every((m) => num(m.issuedQty) >= num(m.requiredQty));
  const matShort = materials.some((m) => num(m.availableQty) < num(m.requiredQty) - num(m.issuedQty));
  const rejected = outputs.some((o) => String(o.outputType ?? '').toUpperCase() === 'REJECT');

  const act = async (path: string, body: Rec = {}) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice('Saved');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitOutput = () => {
    const q = Number(outQty);
    if (!(q > 0)) { setError('Enter a positive quantity'); return; }
    setOutOpen(false);
    void act(`/api/ops/production/work-orders/${id}/output`, { outputType: outType, quantity: q });
  };

  const flow = [
    { label: 'Materials', state: matShort ? 'warn' : matOk ? 'ok' : 'info', text: matShort ? 'Shortage' : matOk ? 'Complete' : 'Pending' },
    { label: 'Machine', state: inProgress ? 'ok' : completed ? 'info' : 'warn', text: inProgress ? 'Running' : completed ? 'Finished' : status === 'QC_INSPECTION' ? 'QC hold' : 'Ready' },
    { label: 'Quality', state: rejected ? 'bad' : 'ok', text: rejected ? 'Rejects recorded' : 'Passed' },
    { label: 'Production', state: inProgress ? 'ok' : completed ? 'ok' : 'info', text: produced + ' / ' + planned },
  ] as const;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Production · Order workspace</p>
          <h1>{String(wo.woNo ?? 'Production order')}</h1>
          <p className="muted">{String(wo.productName ?? '')} · <span className="cell-mono">{String(wo.productCode ?? '')}</span></p>
        </div>
        <div className="head-actions">
          {can(user, 'production.work_orders.start') && canStart && !inProgress && (
            <button className="btn btn-primary" disabled={busy} onClick={() => act(`/api/ops/production/work-orders/${id}/start`)}>Start</button>
          )}
          {inProgress && (
            <button className="btn" disabled={busy} onClick={() => {
              const r = window.prompt('Hold reason', 'Paused from workspace');
              if (r !== null) void act(`/api/ops/production/work-orders/${id}/hold`, { reason: r || 'Paused' });
            }}>Pause</button>
          )}
          <button className="btn btn-success" disabled={busy || completed} onClick={() => {
            if (window.confirm(`Complete ${String(wo.woNo ?? '')}?`)) void act(`/api/ops/production/work-orders/${id}/complete`);
          }}>Complete</button>
          {completed && (
            <button className="btn" disabled={busy} onClick={() => act(`/api/ops/production/work-orders/${id}/close`)}>Close</button>
          )}
          <button className="btn" disabled={busy || completed} onClick={() => setOutOpen(true)}>Record output</button>
          <button className="btn" onClick={() => navigate('/plant/orders')}>All orders</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}

      <section className="card card-pad">
        <div className="fos-order-progress">
          <div>
            <span className="muted">Progress</span>
            <strong>{produced} / {planned}</strong>
            <span className="muted">· {fmtNum(planned - produced)} remaining</span>
          </div>
          <Progress value={produced} max={planned} />
        </div>
        <div className="fos-tile-row">
          {flow.map((f) => <StatusTile key={f.label} label={f.label} state={f.state} text={f.text} />)}
        </div>
        <div className="fos-tabs" role="tablist">
          {WO_TABS.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={'fos-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="fos-tab-panel">
          {tab === 'overview' && (
            <div className="form-grid">
              {[
                ['Planned quantity', fmtNum(planned)],
                ['Actual quantity', fmtNum(produced)],
                ['Waste', fmtNum(waste)],
                ['Machine', String(wo.machineName ?? wo.machineCode ?? '—')],
                ['Operator', String(wo.assignedOperator ?? wo.operatorName ?? '—')],
                ['Shift', String(wo.shiftCode ?? '—')],
                ['Priority', String(wo.priority ?? '—')],
                ['Start', clock(wo.startedAt ?? wo.startDate ?? '') || '—'],
                ['Est. completion', clock(wo.dueDate ?? '') || dayLabel(wo.dueDate ?? '') || '—'],
                ['Status', status],
              ].map(([k, v]) => (
                <div className="fos-detail" key={k}>
                  <span>{k}</span>
                  <strong>{v}</strong>
                </div>
              ))}
            </div>
          )}
          {tab === 'materials' && (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Material</th><th className="cell-num">Required</th><th className="cell-num">Issued</th><th className="cell-num">On hand</th><th>Status</th></tr></thead>
                <tbody>
                  {materials.map((m) => {
                    const req = num(m.requiredQty); const iss = num(m.issuedQty); const av = num(m.availableQty);
                    return (
                      <tr key={String(m.id)}>
                        <td><span className="cell-mono">{String(m.productCode)}</span> {String(m.productName)}</td>
                        <td className="cell-num">{fmtNum(req)}</td>
                        <td className="cell-num">{fmtNum(iss)}</td>
                        <td className="cell-num">{fmtNum(av)}</td>
                        <td>{iss >= req ? <Badge value="COMPLETE" /> : av >= req - iss ? <Badge value="AVAILABLE" /> : <Badge value="SHORT" />}</td>
                      </tr>
                    );
                  })}
                  {materials.length === 0 && <tr><td colSpan={5} className="muted">No materials linked to this order.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {tab === 'operations' && (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>#</th><th>Operation</th><th className="cell-num">Setup (min)</th><th className="cell-num">Run (min/unit)</th></tr></thead>
                <tbody>
                  {operations.map((o) => (
                    <tr key={String(o.id)}>
                      <td className="cell-mono">{String(o.seq)}</td>
                      <td>{String(o.name ?? '')}</td>
                      <td className="cell-num">{fmtNum(o.plannedSetupMin)}</td>
                      <td className="cell-num">{fmtNum(o.plannedRunMin)}</td>
                    </tr>
                  ))}
                  {operations.length === 0 && <tr><td colSpan={4} className="muted">No routing operations for this order.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {tab === 'output' && (
            <>
              <div className="toolbar">
                <button className="btn btn-primary btn-sm" onClick={() => setOutOpen(true)}>Record output</button>
              </div>
              <OutputTable outputs={outputs} />
            </>
          )}
          {tab === 'quality' && (
            <div className="fos-empty-actions">
              <StatusTile label="Overall" state={rejected ? 'bad' : 'ok'} text={rejected ? 'Rejects recorded' : 'No rejects'} />
              <button className="btn" onClick={() => navigate('/plant/inspections-ux')}>Open QC checklist</button>
            </div>
          )}
          {tab === 'waste' && (
            <>
              <p className="muted">Total waste recorded on this order: <strong>{fmtNum(waste)}</strong></p>
              <OutputTable outputs={outputs.filter((o) => String(o.outputType ?? '').toUpperCase() === 'WASTE')} />
            </>
          )}
          {tab === 'cost' && cost && (
            <div className="form-grid">
              {[
                ['Standard cost', fmtMoney(cost.standardCost)],
                ['Actual cost', fmtMoney(cost.actualCost)],
                ['Variance', fmtMoney(cost.variance)],
                ['Cost / unit (std)', fmtMoney(cost.costPerUnitStandard)],
                ['Cost / unit (actual)', fmtMoney(cost.costPerUnitActual)],
              ].map(([k, v]) => (
                <div className="fos-detail" key={k}>
                  <span>{k}</span>
                  <strong>{v}</strong>
                </div>
              ))}
              {(cost.components as Rec[] ?? []).length > 0 && (
                <div className="table-wrap" style={{ gridColumn: '1 / -1' }}>
                  <table className="data">
                    <thead><tr><th>Component</th><th className="cell-num">Amount</th></tr></thead>
                    <tbody>
                      {(cost.components as Rec[]).map((c, i) => (
                        <tr key={String(c.component ?? i)}><td>{String(c.component)}</td><td className="cell-num">{fmtMoney(c.amount)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {tab === 'cost' && !cost && <FosEmpty title="Costing not posted yet" body="Production costs appear here once costing is run for this order." actions={[{ label: 'Costing', onClick: () => navigate('/plant/costing') }]} />}
          {tab === 'activity' && (
            <div className="activity-list">
              {[
                ['Created', wo.createdAt],
                ['Released', wo.releasedAt],
                ['Started', wo.startedAt],
                ['Completed', wo.completedAt],
              ].filter((x) => x[1]).map(([k, v]) => (
                <div className="activity-item" key={String(k)}>
                  <span className="activity-time cell-mono">{clock(v)}</span>
                  <span className="activity-text"><Badge value={String(k)} /><span>{dayLabel(v)}</span></span>
                </div>
              ))}
              {outputs.slice(0, 10).map((o, i) => (
                <div className="activity-item" key={String(o.id ?? i)}>
                  <span className="activity-time cell-mono">{clock(o.createdAt)}</span>
                  <span className="activity-text"><Badge value={o.outputType} /><span>{fmtNum(o.quantity)} units</span></span>
                </div>
              ))}
              {outputs.length === 0 && <p className="muted">No activity yet.</p>}
            </div>
          )}
        </div>
      </section>

      {outOpen && (
        <Modal title="Record output" onClose={() => setOutOpen(false)} footer={
          <div className="head-actions">
            <button className="btn" onClick={() => setOutOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={submitOutput}>Save output</button>
          </div>
        }>
          <div className="field">
            <span>Type</span>
            <select value={outType} onChange={(e) => setOutType(e.target.value)}>
              <option value="GOOD">Good production</option>
              <option value="WASTE">Waste</option>
              <option value="REWORK">Rework</option>
              <option value="REJECT">Reject</option>
            </select>
          </div>
          <div className="field">
            <span>Quantity</span>
            <input inputMode="numeric" className="op-qty" value={outQty} onChange={(e) => setOutQty(e.target.value)} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function OutputTable({ outputs }: { outputs: Rec[] }) {
  if (outputs.length === 0) return <p className="muted">No outputs recorded.</p>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Type</th><th className="cell-num">Quantity</th><th className="cell-num">Unit cost</th><th>When</th></tr></thead>
        <tbody>
          {outputs.map((o) => (
            <tr key={String(o.id)}>
              <td><Badge value={o.outputType} /></td>
              <td className="cell-num">{fmtNum(o.quantity)}</td>
              <td className="cell-num">{o.unitCost != null ? fmtMoney(o.unitCost) : '—'}</td>
              <td>{clock(o.createdAt)} · {dayLabel(o.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Smart production creation wizard — 6 guided steps, live summary aside
// ---------------------------------------------------------------------------
const WIZ_STEPS = ['Product', 'Quantity', 'When', 'Machine & line', 'Materials', 'Review & release'];

export function SmartProductionWizard() {
  const [step, setStep] = useState(0);
  const [products, setProducts] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [product, setProduct] = useState<Rec | null>(null);
  const [qty, setQty] = useState('1000');
  const [bomId, setBomId] = useState('');
  const [routingId, setRoutingId] = useState('');
  const [machineId, setMachineId] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [setup, setSetup] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ pageSize: '30' });
    if (q.trim()) params.set('q', q.trim());
    api<ListResult>(`/api/ops/production/products?${params}`)
      .then((r) => setProducts(r.data.filter((p) => MANUFACTURABLE_TYPES.includes(String(p.type ?? '')) && String(p.status ?? 'ACTIVE') === 'ACTIVE')))
      .catch(() => setProducts([]));
  }, [q]);

  const loadSetup = async (pid: number, quantity: number, b?: string, rt?: string) => {
    const params = new URLSearchParams({ quantity: String(quantity || 1) });
    if (b) params.set('bomId', b);
    if (rt) params.set('routingId', rt);
    const r = await api<{ data: Rec }>(`/api/ops/production/products/${pid}/setup?${params}`);
    setSetup(r.data);
    if (!b && r.data.selectedBomId) setBomId(String(r.data.selectedBomId));
    if (!rt && r.data.selectedRoutingId) setRoutingId(String(r.data.selectedRoutingId));
  };

  const next = async () => {
    setError('');
    if (step === 0 && !product) { setError('Pick a product to produce'); return; }
    if (step === 1) {
      if (!(Number(qty) > 0)) { setError('Quantity must be positive'); return; }
      if (product) {
        try { await loadSetup(Number(product.id), Number(qty)); }
        catch (e) { setError(e instanceof Error ? e.message : 'Could not load BOM'); return; }
      }
    }
    if (step === 2 && product) {
      try { await loadSetup(Number(product.id), Number(qty), bomId, routingId); } catch { /* keep */ }
    }
    if (step === 3 && product) {
      try { await loadSetup(Number(product.id), Number(qty), bomId, routingId); } catch { /* keep */ }
    }
    if (step < WIZ_STEPS.length - 1) setStep((s) => s + 1);
  };

  const submit = async (release: boolean) => {
    if (!product) return;
    setBusy(true); setError('');
    try {
      const created = await api<{ data: { workOrderId: number; woNo: string } }>('/api/ops/production/work-orders', {
        method: 'POST',
        body: JSON.stringify({
          productId: Number(product.id),
          quantity: Number(qty),
          bomId: bomId || null,
          routingId: routingId || null,
          machineId: machineId || null,
          priority,
          startDate: startDate || null,
          dueDate: dueDate || null,
          notes: notes || null,
        }),
      });
      if (release) {
        await api(`/api/ops/production/work-orders/${created.data.workOrderId}/submit`, { method: 'POST', body: '{}' });
      }
      navigate(`/plant/orders/${created.data.workOrderId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const machines = (setup?.machines as Rec[]) ?? [];
  const mats = (setup?.materials as Rec[]) ?? [];
  const ops = (setup?.operations as Rec[]) ?? [];
  const estMin = ops.reduce((s, o) => s + num(o.setupTimeMin) + num(o.runTimePerUnitMin) * Number(qty || 0), 0);
  const matCost = mats.reduce((s, m) => s + num(m.requiredQty) * num(m.unitCost), 0);
  const machine = machines.find((m) => String(m.id) === machineId);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Planning · New production order</p>
          <h1>Create production order</h1>
          <p className="muted">Six short steps — a live summary is on the right.</p>
        </div>
        <button className="btn" onClick={() => navigate('/plant/orders')}>Cancel</button>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="fos-wizard">
        <div className="fos-wizard-main">
          <ol className="fos-stepper">
            {WIZ_STEPS.map((s, i) => (
              <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''}>
                <span className="fos-step-dot">{i < step ? '✓' : i + 1}</span>
                {s}
              </li>
            ))}
          </ol>

          {step === 0 && (
            <section className="card card-pad">
              <h3>What do you want to produce?</h3>
              <div className="field">
                <span>Search product</span>
                <input className="search-input" placeholder="NATEX A4, jumbo roll, ream wrapper…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <div className="fos-pick-list">
                {products.map((p) => (
                  <button key={String(p.id)} className={'fos-pick' + (product && Number(product.id) === Number(p.id) ? ' active' : '')} onClick={() => setProduct(p)}>
                    <strong>{String(p.name)}</strong>
                    <span className="muted cell-mono">{String(p.code)} · {String(p.type ?? '')} · {String(p.uom ?? '')}</span>
                  </button>
                ))}
                {products.length === 0 && <p className="muted">No products found.</p>}
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="card card-pad">
              <h3>How much?</h3>
              <div className="fos-qty-row">
                <button className="fos-qty-btn" onClick={() => setQty((v) => String(Math.max(0, Number(v || 0) - 100)))}>−</button>
                <input className="op-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
                <button className="fos-qty-btn" onClick={() => setQty((v) => String(Number(v || 0) + 100))}>+</button>
              </div>
              <p className="muted">{String(product?.name ?? '')} — reams</p>
            </section>
          )}

          {step === 2 && (
            <section className="card card-pad">
              <h3>When should production happen?</h3>
              <div className="form-grid">
                <label className="field"><span>Start date</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
                <label className="field"><span>Due date</span><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
                <label className="field">
                  <span>Priority</span>
                  <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                    <option value="URGENT">Urgent</option>
                  </select>
                </label>
              </div>
            </section>
          )}

          {step === 3 && (
            <section className="card card-pad">
              <h3>Select machine and production line</h3>
              <div className="fos-machine-grid">
                {machines.map((m) => (
                  <button key={String(m.id)} className={'fos-pick fos-machine-pick' + (String(m.id) === machineId ? ' active' : '')} onClick={() => setMachineId(String(m.id))}>
                    <strong>{String(m.name)}</strong>
                    <span className="muted cell-mono">{String(m.code)} · {String(m.status ?? '')}</span>
                  </button>
                ))}
                {machines.length === 0 && <p className="muted">No machines in the selected routing.</p>}
              </div>
              <button className="btn btn-sm" onClick={() => setMachineId('')}>No machine yet</button>
            </section>
          )}

          {step === 4 && (
            <section className="card card-pad">
              <h3>Review materials</h3>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Material</th><th className="cell-num">Required</th><th className="cell-num">Scrap %</th><th className="cell-num">Unit cost</th></tr></thead>
                  <tbody>
                    {mats.map((m, i) => (
                      <tr key={String(m.productId ?? i)}>
                        <td><span className="cell-mono">{String(m.productCode)}</span> {String(m.productName)}</td>
                        <td className="cell-num">{fmtNum(m.requiredQty)}</td>
                        <td className="cell-num">{fmtNum(m.scrapPercent)}</td>
                        <td className="cell-num">{fmtMoney(m.unitCost)}</td>
                      </tr>
                    ))}
                    {mats.length === 0 && <tr><td colSpan={4} className="muted">No BOM materials — this product may not have a BOM yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {step === 5 && (
            <section className="card card-pad">
              <h3>Review and release</h3>
              <div className="form-grid">
                {[
                  ['Product', String(product?.name ?? '')],
                  ['Quantity', fmtNum(qty) + ' reams'],
                  ['Machine', machine ? String(machine.name) + ' (' + String(machine.code) + ')' : 'Not assigned'],
                  ['Start', startDate || '—'],
                  ['Due', dueDate || '—'],
                  ['Priority', priority],
                ].map(([k, v]) => (
                  <div className="fos-detail" key={k}><span>{k}</span><strong>{v}</strong></div>
                ))}
              </div>
              <label className="field"><span>Notes</span><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            </section>
          )}

          <div className="fos-wizard-actions">
            <button className="btn" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>Back</button>
            {step < WIZ_STEPS.length - 1 ? (
              <button className="btn btn-primary" onClick={() => void next()}>Next</button>
            ) : (
              <>
                <button className="btn" disabled={busy} onClick={() => void submit(false)}>Save as draft</button>
                <button className="btn btn-primary" disabled={busy} onClick={() => void submit(true)}>Release to production</button>
              </>
            )}
          </div>
        </div>

        <aside className="card card-pad fos-wizard-summary">
          <div className="card-head"><h3>Production summary</h3></div>
          <div className="fos-detail"><span>Product</span><strong>{String(product?.name ?? '—')}</strong></div>
          <div className="fos-detail"><span>Quantity</span><strong>{fmtNum(qty)} reams</strong></div>
          <div className="fos-detail"><span>Materials required</span><strong>{mats.length} lines · {fmtMoney(matCost)}</strong></div>
          <div className="fos-detail"><span>Estimated time</span><strong>{(estMin / 60).toFixed(1)} hours</strong></div>
          <div className="fos-detail"><span>Machine</span><strong>{machine ? String(machine.name) : '—'}</strong></div>
          <div className="fos-detail"><span>Estimated material cost</span><strong>{fmtMoney(matCost)}</strong></div>
        </aside>
      </div>
    </div>
  );
}
// [end wizard]
// ---------------------------------------------------------------------------
// Operator hub — one screen, big buttons, minimal typing
// ---------------------------------------------------------------------------
const OP_STATUS = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'APPROVED', 'MATERIALS_RESERVED', 'MATERIALS_ISSUED'];
const BIG_BTN = { fontSize: 15, padding: '14px 10px', minHeight: 52 };

const plannedPct = (planned: number, produced: number) => (planned > 0 ? Math.min(100, Math.round((produced / planned) * 100)) : 0);

export function OperatorHub() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [sel, setSel] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [fab, setFab] = useState(false);
  const [modal, setModal] = useState('');
  const [outType, setOutType] = useState('GOOD');
  const [qty, setQty] = useState('100');
  const [wasteType, setWasteType] = useState('NORMAL');
  const [wasteCat, setWasteCat] = useState(WASTE_CATS[0]);
  const [inputQty, setInputQty] = useState('');
  const [downCat, setDownCat] = useState(DOWNTIME_CATS[0]);
  const [minutes, setMinutes] = useState('15');
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    setError('');
    api<{ data: { rows: Rec[] } }>('/api/ops/production/work-orders?pageSize=50')
      .then((r) => {
        const live = (r.data.rows ?? []).filter((w) => OP_STATUS.includes(String(w.status ?? '').toUpperCase()));
        setRows(live);
        setSel((s) => (s && live.some((w) => Number(w.id) === Number(s.id)) ? s : live[0] ?? null));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'No work orders'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const id = Number(sel?.id);
  const act = async (path: string, body: Rec = {}) => {
    if (!sel) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice('Recorded');
      setModal('');
      setFab(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const stepQty = (d: number) => setQty(String(Math.max(1, (Number(qty) || 0) + d)));
  const wo = sel;
  const planned = num(wo?.quantity);
  const produced = num(wo?.producedQty);
  const waste = num(wo?.wasteQty);
  const prog = plannedPct(planned, produced);
  const status = String(wo?.status ?? '').toUpperCase();
  const saveOutput = () => act(`/api/ops/production/work-orders/${id}/output`, { outputType: outType, quantity: Number(qty) || 0 });
  const saveWaste = () => act('/api/ops/manufacturing/waste', { workOrderId: id, wasteType, category: wasteCat, inputQty: Number(inputQty) || undefined, wasteQty: Number(qty) || 0, reason: reason || undefined });
  const saveDown = () => act(`/api/ops/production/work-orders/${id}/downtime`, { downtimeType: downCat, minutes: Number(minutes) || 0, reason: reason || undefined });
  const nowClock = clock(new Date().toISOString());
  const greet = 'Good ' + (nowClock < '12:00' ? 'morning' : nowClock < '17:00' ? 'afternoon' : 'evening');

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Shop floor</p>
          <h1>Operator work queue</h1>
          <p className="muted">{greet}, {String(user?.first_name ?? 'operator')} — tap a job to begin</p>
        </div>
        <div className="toolbar">
          <button className="btn btn-sm" onClick={() => navigate('/plant/live')}>Live factory</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      {rows.length === 0 && !error && (
        <FosEmpty
          title="No live production jobs"
          body="Orders released to the floor appear here. Ask the planner to release work, or open the order board."
          actions={[{ label: 'View production orders', onClick: () => navigate('/plant/orders') }]}
        />
      )}
      {rows.length > 0 && (
        <div className="fos-operator-grid">
          <section className="card card-pad">
            <div className="card-head"><h3>My jobs</h3></div>
            {rows.map((r) => {
              const p = plannedPct(num(r.quantity), num(r.producedQty));
              return (
                <button key={String(r.id)} className={'fos-job ' + (Number(r.id) === id ? 'active' : '')} onClick={() => setSel(r)}>
                  <span className="cell-mono">{String(pick(r, 'woNo', 'wo_no'))}</span>
                  <span className="fos-job-name">{String(pick(r, 'productName', 'product_name'))}</span>
                  <span className="muted">{fmtNum(p)}%</span>
                  <Progress value={p} />
                </button>
              );
            })}
          </section>
          {wo && (
            <section className="card card-pad fos-current-job">
              <div className="fos-operator-top">
                <div>
                  <span className="cell-mono">{String(pick(wo, 'woNo', 'wo_no'))}</span>
                  <h2 style={{ fontFamily: 'var(--serif)', margin: '6px 0' }}>{String(pick(wo, 'productName', 'product_name'))}</h2>
                  <Badge value={pick(wo, 'status')} />
                </div>
                <span className="fos-prog-label">{fmtNum(prog)}%</span>
              </div>
              <Progress value={prog} />
              <div className="fos-job-meta">
                <span>Target <strong>{fmtNum(planned)}</strong></span>
                <span>Produced <strong>{fmtNum(produced)}</strong></span>
                <span>Waste <strong>{fmtNum(waste)}</strong></span>
              </div>
              <div className="op-grid">
                {status === 'IN_PROGRESS' ? (
                  <button className="btn" style={BIG_BTN} disabled={busy} onClick={() => act(`/api/ops/production/work-orders/${id}/hold`, { reason: 'Paused on floor' })}>⏸ Pause</button>
                ) : (
                  <button className="btn btn-primary" style={BIG_BTN} disabled={busy} onClick={() => act(`/api/ops/production/work-orders/${id}/start`)}>▶ Start</button>
                )}
                <button className="btn btn-success" style={BIG_BTN} disabled={busy} onClick={() => { setOutType('GOOD'); setQty(String(Math.max(1, Math.round(planned * 0.05)))); setModal('output'); }}>＋ Output</button>
                <button className="btn btn-warning" style={BIG_BTN} disabled={busy} onClick={() => { setWasteType('NORMAL'); setWasteCat(WASTE_CATS[0]); setQty('1'); setReason(''); setModal('waste'); }}>Waste</button>
                <button className="btn" style={BIG_BTN} disabled={busy} onClick={() => { setDownCat(DOWNTIME_CATS[0]); setMinutes('15'); setReason(''); setModal('down'); }}>⚠ Problem</button>
                {can(user, 'production.work_orders.update') && (
                  <button className="btn btn-danger" style={BIG_BTN} disabled={busy} onClick={() => { if (window.confirm('Complete ' + String(pick(wo, 'woNo', 'wo_no')) + '? QC will verify before close.')) void act(`/api/ops/production/work-orders/${id}/complete`); }}>✓ Complete</button>
                )}
                <button className="btn" style={BIG_BTN} onClick={() => navigate('/plant/inspections-ux')}>QC sample</button>
              </div>
              <button className="btn btn-block" style={{ marginTop: 12 }} onClick={() => navigate('/plant/orders/' + id)}>Open full order →</button>
            </section>
          )}
        </div>
      )}

      <div className="fos-fab">
        <button className="fos-fab-btn" onClick={() => setFab(!fab)} aria-label="Quick actions">+</button>
        {fab && (
          <div className="fos-fab-menu">
            <button onClick={() => { setOutType('GOOD'); setQty('100'); setModal('output'); setFab(false); }}>Record output</button>
            <button onClick={() => { setModal('waste'); setFab(false); }}>Record waste</button>
            <button onClick={() => { setModal('down'); setFab(false); }}>Report downtime</button>
            <button onClick={() => { navigate('/plant/issue-ux'); setFab(false); }}>Issue material</button>
            <button onClick={() => { navigate('/plant/inspections-ux'); setFab(false); }}>QC check</button>
          </div>
        )}
      </div>

      {modal === 'output' && (
        <Modal title="Record output" onClose={() => setModal('')} footer={<>
          <button className="btn" onClick={() => setModal('')}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void saveOutput()}>Save output</button>
        </>}>
          <label className="field"><span>Type</span>
            <select value={outType} onChange={(e) => setOutType(e.target.value)}>
              <option value="GOOD">Good output</option>
              <option value="REWORK">Rework</option>
              <option value="WASTE">Waste</option>
              <option value="REJECT">Rejected</option>
            </select>
          </label>
          <div className="fos-qty-row">
            <button className="fos-qty-btn" onClick={() => stepQty(-10)}>−</button>
            <input className="op-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
            <button className="fos-qty-btn" onClick={() => stepQty(10)}>+</button>
          </div>
          <p className="muted" style={{ textAlign: 'center' }}>units</p>
        </Modal>
      )}
      {modal === 'waste' && (
        <Modal title="Record waste" onClose={() => setModal('')} footer={<>
          <button className="btn" onClick={() => setModal('')}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void saveWaste()}>Save waste</button>
        </>}>
          <label className="field"><span>Waste type</span>
            <select value={wasteType} onChange={(e) => setWasteType(e.target.value)}>
              <option value="NORMAL">Standard / normal</option>
              <option value="ABNORMAL">Unplanned / abnormal</option>
            </select>
          </label>
          <label className="field"><span>Category</span>
            <select value={wasteCat} onChange={(e) => setWasteCat(e.target.value)}>
              {WASTE_CATS.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <label className="field"><span>Input quantity (optional)</span>
            <input inputMode="numeric" value={inputQty} onChange={(e) => setInputQty(e.target.value)} placeholder="e.g. 10 rolls" />
          </label>
          <div className="fos-qty-row">
            <button className="fos-qty-btn" onClick={() => stepQty(-1)}>−</button>
            <input className="op-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
            <button className="fos-qty-btn" onClick={() => stepQty(1)}>+</button>
          </div>
          <label className="field"><span>Reason / cause</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. normal edge trim" />
          </label>
        </Modal>
      )}
      {modal === 'down' && (
        <Modal title="Report downtime" onClose={() => setModal('')} footer={<>
          <button className="btn" onClick={() => setModal('')}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void saveDown()}>Save downtime</button>
        </>}>
          <label className="field"><span>Downtime type</span>
            <select value={downCat} onChange={(e) => setDownCat(e.target.value)}>
              {DOWNTIME_CATS.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <div className="fos-qty-row">
            <button className="fos-qty-btn" onClick={() => setMinutes(String(Math.max(0, (Number(minutes) || 0) - 5)))}>−</button>
            <input className="op-qty" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            <button className="fos-qty-btn" onClick={() => setMinutes(String((Number(minutes) || 0) + 5))}>+</button>
          </div>
          <p className="muted" style={{ textAlign: 'center' }}>minutes</p>
          <label className="field"><span>Details</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What happened?" />
          </label>
        </Modal>
      )}
    </div>
  );
}
// ---------------------------------------------------------------------------
// QC inspection checklist — pass, fail or rework in one screen
// ---------------------------------------------------------------------------
const QC_CHECKS = ['Sheet count', 'Dimensions', 'Weight', 'GSM', 'Cutting accuracy', 'Appearance', 'Packaging quality'];

export function QcChecklist() {
  const { user } = useAuth();
  const [insp, setInsp] = useState<Rec[]>([]);
  const [wos, setWos] = useState<Rec[]>([]);
  const [woId, setWoId] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Rec | null>(null);
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  const [actuals, setActuals] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError('');
    api<{ data: Rec[] }>('/api/ops/manufacturing/inspections')
      .then((r) => setInsp(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Inspections failed'));
    api<{ data: { rows: Rec[] } }>('/api/ops/production/work-orders?pageSize=50')
      .then((r) => setWos((r.data.rows ?? []).filter((w) => ['RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED'].includes(String(w.status ?? '').toUpperCase()))))
      .catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    const wo = wos.find((w) => String(w.id) === woId);
    if (!wo) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const q = num(wo.quantity);
      const r = await api<{ data: { id: number; inspectionNo: string } }>('/api/ops/manufacturing/inspections', {
        method: 'POST',
        body: JSON.stringify({
          productId: num(wo.productId),
          kind: 'FINAL',
          workOrderId: num(wo.id),
          quantity: q || undefined,
          sampledQty: q ? Math.max(1, Math.round(q * 0.05)) : undefined,
          notes: 'Created from Factory OS QC checklist',
        }),
      });
      setNotice('Inspection ' + String(r.data.inspectionNo ?? r.data.id) + ' created');
      setCreating(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (kind: 'PASS' | 'FAIL' | 'REWORK') => {
    if (!selected) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const results = QC_CHECKS.map((c) => ({ parameter: c, actualValue: (actuals[c] || '').trim() || undefined, passed: marks[c] !== false }));
      const result: 'PASSED' | 'FAILED' = kind === 'PASS' ? 'PASSED' : 'FAILED';
      if (kind === 'REWORK') {
        try {
          const rw = await api<{ data: { reworkNo: string } }>('/api/ops/manufacturing/rework', {
            method: 'POST',
            body: JSON.stringify({
              sourceWorkOrderId: num(selected.workOrderId) || undefined,
              productId: num(selected.productId),
              quantity: num(selected.quantity) || 0,
              notes: 'Rework from QC ' + String(selected.inspectionNo ?? ''),
            }),
          });
          setNotice('Rework ' + String(rw.data.reworkNo ?? '') + ' created — batch held for reinspection');
        } catch {
          setNotice('Batch held — rework creation failed, check the order manually');
        }
      }
      const r = await api<{ data: { result: string } }>('/api/ops/manufacturing/inspections/' + String(selected.id) + '/submit', {
        method: 'POST',
        body: JSON.stringify({ id: Number(selected.id), results, result, notes: notes || undefined }),
      });
      setNotice((kind === 'PASS' ? 'Inspection passed — batch cleared for warehouse' : 'Inspection failed — batch placed on hold') + ' · ' + String(r.data.result ?? result));
      setSelected(null); setMarks({}); setActuals({}); setNotes('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canCreate = can(user, 'quality.inspections.execute');
  const canApprove = can(user, 'quality.inspections.approve');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Quality</p>
          <h1>QC inspection checklist</h1>
          <p className="muted">Inspect batches fast — pass, fail or send to rework in seconds</p>
        </div>
        <div className="toolbar">
          <button className="btn btn-sm btn-primary" disabled={!canCreate} onClick={() => setCreating(!creating)}>{creating ? 'Cancel' : '＋ New inspection'}</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      {creating && (
        <section className="card card-pad" style={{ marginBottom: 16 }}>
          <div className="card-head"><h3>New final inspection</h3></div>
          <div className="form-grid">
            <label className="field"><span>Production order</span>
              <select value={woId} onChange={(e) => setWoId(e.target.value)}>
                <option value="">Select order…</option>
                {wos.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(pick(w, 'woNo', 'wo_no'))} · {String(pick(w, 'productName', 'product_name'))}</option>)}
              </select>
            </label>
          </div>
          <button className="btn btn-primary" disabled={busy || !woId} onClick={() => void create()}>Create inspection</button>
        </section>
      )}
      <div className="fos-machine-grid fos-machine-grid-lg" style={{ alignItems: 'start' }}>
        <section className="card card-pad">
          <div className="card-head"><h3>Inspections</h3></div>
          {insp.length === 0 && <p className="muted">No inspections yet — create one above.</p>}
          <div className="fos-check-list">
            {insp.map((i) => (
              <button key={String(i.id)} className={'fos-check-row ' + (selected && Number(selected.id) === Number(i.id) ? 'active' : '')} onClick={() => { setSelected(i); setMarks({}); setActuals({}); setNotes(''); }}>
                <span className="cell-mono">{String(i.inspectionNo ?? '')}</span>
                <span>{String(i.productName ?? i.productCode ?? '')}</span>
                <Badge value={i.result ?? 'PENDING'} />
              </button>
            ))}
          </div>
        </section>
        <section className="card card-pad">
          {!selected ? (
            <FosEmpty title="Select an inspection" body="Choose an inspection from the list to record check results, then pass, fail or send to rework." actions={[]} />
          ) : (
            <>
              <div className="card-head"><h3>{String(selected.inspectionNo ?? '')} · {String(selected.productName ?? selected.productCode ?? '')}</h3></div>
              <p className="muted">Sampled {fmtNum(selected.sampledQty)} of {fmtNum(selected.quantity)} · order {String(selected.woNo ?? '—')}</p>
              <div className="fos-checkline">
                {QC_CHECKS.map((c) => (
                  <div key={c} className="fos-checkline-row">
                    <label className="fos-check-toggle">
                      <input type="checkbox" checked={marks[c] !== false} onChange={(e) => setMarks((m) => ({ ...m, [c]: e.target.checked }))} />
                      <span>{c}</span>
                    </label>
                    <input className="search-input" style={{ maxWidth: 120 }} placeholder="actual" value={actuals[c] ?? ''} onChange={(e) => setActuals((a) => ({ ...a, [c]: e.target.value }))} />
                  </div>
                ))}
              </div>
              <label className="field"><span>Notes</span><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
              <div className="fos-decision-row">
                <button className="btn btn-success" disabled={busy || !canApprove} onClick={() => void decide('PASS')}>✓ Pass</button>
                <button className="btn btn-warning" disabled={busy || !canApprove} onClick={() => void decide('REWORK')}>↻ Rework</button>
                <button className="btn btn-danger" disabled={busy || !canApprove} onClick={() => void decide('FAIL')}>✕ Fail</button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Waste & scrap — fast entry with standard-vs-actual comparison
// ---------------------------------------------------------------------------
const WASTE_TARGET = 4.5;

export function WasteRecorder() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [woId, setWoId] = useState('');
  const [wasteType, setWasteType] = useState('NORMAL');
  const [category, setCategory] = useState(WASTE_CATS[0]);
  const [inputQty, setInputQty] = useState('');
  const [wasteQty, setWasteQty] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<Rec[]>([]);

  const load = useCallback(() => {
    api<{ data: { rows: Rec[] } }>('/api/ops/production/work-orders?pageSize=50')
      .then((r) => setRows((r.data.rows ?? []).filter((w) => ['IN_PROGRESS', 'ON_HOLD', 'RELEASED', 'COMPLETED'].includes(String(w.status ?? '').toUpperCase()))))
      .catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/manufacturing/waste')
      .then((r) => setRecent(r.data.slice(0, 8)))
      .catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const q = Number(wasteQty) || 0;
    if (!woId || q <= 0) { setError('Select an order and enter a waste quantity'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: { wasteNo: string } }>('/api/ops/manufacturing/waste', {
        method: 'POST',
        body: JSON.stringify({
          workOrderId: Number(woId),
          wasteType,
          category,
          inputQty: Number(inputQty) || undefined,
          wasteQty: q,
          reason: reason || undefined,
        }),
      });
      setNotice('Waste ' + String(r.data.wasteNo ?? '') + ' recorded');
      setWasteQty(''); setReason('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const inQty = Number(inputQty) || 0;
  const pct = inQty > 0 ? ((Number(wasteQty) || 0) / inQty) * 100 : 0;
  const canRecord = can(user, 'production.outputs.create');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Waste</p>
          <h1>Record waste & scrap</h1>
          <p className="muted">Fast entry — abnormal waste raises an alert automatically</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      <div className="fos-machine-grid fos-machine-grid-lg" style={{ alignItems: 'start' }}>
        <section className="card card-pad">
          <div className="card-head"><h3>Record</h3></div>
          <div className="form-grid">
            <label className="field"><span>Production order</span>
              <select value={woId} onChange={(e) => setWoId(e.target.value)}>
                <option value="">Select order…</option>
                {rows.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(pick(w, 'woNo', 'wo_no'))} · {String(pick(w, 'productName', 'product_name'))}</option>)}
              </select>
            </label>
            <label className="field"><span>Waste type</span>
              <select value={wasteType} onChange={(e) => setWasteType(e.target.value)}>
                <option value="NORMAL">Standard waste</option>
                <option value="ABNORMAL">Unplanned / abnormal</option>
              </select>
            </label>
            <label className="field"><span>Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {WASTE_CATS.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
              </select>
            </label>
            <label className="field"><span>Input quantity</span>
              <input inputMode="numeric" value={inputQty} onChange={(e) => setInputQty(e.target.value)} placeholder="e.g. 10 rolls" />
            </label>
            <label className="field"><span>Waste quantity</span>
              <input inputMode="numeric" value={wasteQty} onChange={(e) => setWasteQty(e.target.value)} placeholder="e.g. 25.5" />
            </label>
            <label className="field"><span>Cause / reason</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. edge trim on slit line" />
            </label>
          </div>
          <div className="fos-waste-tiles">
            <StatusTile state="info" label="Standard waste" text={WASTE_TARGET + '%'} />
            <StatusTile state="info" label="Actual waste" text={inQty > 0 ? pct.toFixed(2) + '%' : '—'} />
            <StatusTile state={inQty > 0 ? (pct <= WASTE_TARGET ? 'ok' : 'bad') : 'info'} label="Status" text={inQty > 0 ? (pct <= WASTE_TARGET ? 'Within target' : 'Above target') : 'Awaiting entry'} />
          </div>
          <button className="btn btn-primary" disabled={busy || !canRecord} onClick={() => void save()} style={{ marginTop: 12 }}>Save waste</button>
        </section>
        <section className="card card-pad">
          <div className="card-head"><h3>Recent waste</h3></div>
          {recent.length === 0 ? <p className="muted">No waste recorded yet.</p> : (
            <table className="table data">
              <thead><tr><th>No</th><th>Order</th><th>Type</th><th>Qty</th><th>Flag</th></tr></thead>
              <tbody>
                {recent.map((w) => (
                  <tr key={String(w.id)}>
                    <td className="cell-mono">{String(w.wasteNo ?? '')}</td>
                    <td>{String(w.woNo ?? '')}</td>
                    <td>{String(w.category ?? w.wasteType ?? '')}</td>
                    <td className="cell-num">{fmtNum(w.wasteQty)}</td>
                    <td><Badge value={w.isAbnormal ? 'ABNORMAL' : 'NORMAL'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Material issue — check availability, reserve, pick, issue
// ---------------------------------------------------------------------------
export function MaterialIssueFlow() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [woId, setWoId] = useState('');
  const [check, setCheck] = useState<Rec | null>(null);
  const [reservation, setReservation] = useState<Rec | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ data: { rows: Rec[] } }>('/api/ops/production/work-orders?pageSize=50')
      .then((r) => setRows((r.data.rows ?? []).filter((w) => ['APPROVED', 'RELEASED', 'MATERIALS_RESERVED', 'MATERIALS_ISSUED', 'IN_PROGRESS'].includes(String(w.status ?? '').toUpperCase()))))
      .catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);

  const reset = () => { setCheck(null); setReservation(null); setPicked({}); setOverride(false); setReason(''); };

  const runCheck = async (withOverride?: boolean) => {
    if (!woId) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (withOverride) {
        await api(`/api/ops/manufacturing/material/check/${woId}/override`, { method: 'POST', body: JSON.stringify({ reason: reason || 'Supervisor override' }) });
      }
      const r = await api<{ data: Rec }>(`/api/ops/manufacturing/material/check/${woId}`, { method: 'POST', body: JSON.stringify({}) });
      setCheck(r.data);
      setReservation(null);
      setPicked({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reserve = async () => {
    if (!woId) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(`/api/ops/manufacturing/material/reserve/${woId}`, { method: 'POST', body: JSON.stringify({ override: override || undefined, reason: reason || undefined }) });
      setReservation(r.data);
      setNotice('Materials reserved');
      setCheck(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const issueAll = async () => {
    const lines = (reservation?.lines as Rec[]) ?? [];
    const targets = lines.filter((l) => picked[String(l.productId)]);
    if (targets.length === 0) { setError('Tick at least one line to issue'); return; }
    setBusy(true); setError(''); setNotice('');
    let done = 0;
    try {
      for (const l of targets) {
        const qty = num(l.reservedQty) || num(l.requiredQty) || 1;
        if (qty <= 0) continue;
        await api(`/api/ops/manufacturing/material/issue/${woId}`, {
          method: 'POST',
          body: JSON.stringify({ reservationId: num(l.reservationId) || undefined, productId: num(l.productId), quantity: qty, overrideReason: reason || undefined }),
        });
        done++;
      }
      setNotice('Issued ' + done + ' material line' + (done === 1 ? '' : 's') + ' to production');
      reset();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const lines = (check?.lines as Rec[]) ?? [];
  const resvLines = (reservation?.lines as Rec[]) ?? [];
  const allowed = can(user, 'production.work_orders.issue');
  const sel = rows.find((w) => String(w.id) === woId);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Production</p>
          <h1>Material issue</h1>
          <p className="muted">Check availability → reserve → pick → issue to the floor</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      <div className="fos-machine-grid fos-machine-grid-lg" style={{ alignItems: 'start' }}>
        <section className="card card-pad">
          <div className="card-head"><h3>1 · Select order</h3></div>
          <label className="field"><span>Production order</span>
            <select value={woId} onChange={(e) => { setWoId(e.target.value); reset(); }}>
              <option value="">Select order…</option>
              {rows.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(pick(w, 'woNo', 'wo_no'))} · {String(pick(w, 'productName', 'product_name'))}</option>)}
            </select>
          </label>
          {sel && <p className="muted" style={{ marginTop: 6 }}>{String(pick(sel, 'productName', 'product_name'))} · {String(pick(sel, 'status'))}</p>}
          <button className="btn btn-primary" disabled={busy || !woId || !allowed} onClick={() => void runCheck()}>Check material availability</button>
        </section>

        <section className="card card-pad">
          <div className="card-head"><h3>2 · Availability</h3></div>
          {!check ? (
            <p className="muted">Run a check to compare required vs on-hand material.</p>
          ) : (
            <>
              <p><Badge value={pick(check, 'status')} /> <span className="muted">{String(check.message ?? '')}</span></p>
              <table className="table data">
                <thead><tr><th>Material</th><th>Required</th><th>On hand</th><th>Status</th></tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={String(l.productId)}>
                      <td>{String(l.productName ?? l.productCode)} <span className="muted">{String(l.productCode ?? '')}</span></td>
                      <td className="cell-num">{fmtNum(l.required)}</td>
                      <td className="cell-num">{fmtNum(l.onHand)}</td>
                      <td>{l.available ? <Badge value="OK" /> : <Badge value={l.critical ? 'SHORT' : 'LOW'} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {String(check.status ?? '') !== 'PASS' && (
                <div className="fos-issue-actions">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                    <span>Authorize override</span>
                  </label>
                  {override && <input className="search-input" style={{ width: '100%' }} placeholder="Override reason" value={reason} onChange={(e) => setReason(e.target.value)} />}
                  <button className="btn btn-warning" disabled={busy || !override} onClick={() => void runCheck(true)}>Re-check with override</button>
                </div>
              )}
              <div className="fos-issue-actions">
                <button className="btn btn-primary" disabled={busy} onClick={() => void reserve()}>Reserve materials</button>
              </div>
            </>
          )}
        </section>

        {reservation && (
          <section className="card card-pad">
            <div className="card-head"><h3>3 · Picking list</h3></div>
            <p className="muted">{String(reservation.reservationNo ?? '')} — tick lines to issue to the floor</p>
            <div className="fos-pick-list">
              {resvLines.map((l) => {
                const pid = String(l.productId);
                return (
                  <label key={pid} className={'fos-pick ' + (picked[pid] ? 'active' : '')}>
                    <input type="checkbox" checked={picked[pid] === true} onChange={(e) => setPicked((p) => ({ ...p, [pid]: e.target.checked }))} />
                    <span className="cell-mono">{String(l.productCode ?? '')}</span>
                    <span>{String(l.productName ?? '')}</span>
                    <strong className="cell-num">{fmtNum(l.reservedQty ?? l.requiredQty)}</strong>
                  </label>
                );
              })}
            </div>
            <div className="fos-issue-actions">
              <button className="btn btn-primary" disabled={busy} onClick={() => void issueAll()}>Issue selected to production</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Factory alert center — every alert has a direct action
// ---------------------------------------------------------------------------
export function AlertCenter() {
  const [alerts, setAlerts] = useState<Rec[]>([]);
  const [openOnly, setOpenOnly] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError('');
    api<{ data: Rec[] }>('/api/ops/manufacturing/alerts?openOnly=' + (openOnly ? 'true' : 'false'))
      .then((r) => setAlerts(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Alerts failed'));
  }, [openOnly]);
  useEffect(() => { load(); }, [load]);

  const act = async (id: number, path: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/ops/manufacturing/alerts/${id}/${path}`, { method: 'POST', body: JSON.stringify({}) });
      setNotice(path === 'ack' ? 'Alert acknowledged' : 'Alert resolved');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const view = (a: Rec) => {
    const ref = String(a.refType ?? '');
    const refId = num(a.refId);
    if ((ref.includes('work_order') || ref.includes('production')) && refId > 0) navigate('/plant/orders/' + refId);
    else navigate('/plant');
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Alerts</p>
          <h1>Factory alerts</h1>
          <p className="muted">Everything that needs attention — with a direct action</p>
        </div>
        <div className="toolbar">
          <button className={'btn btn-sm ' + (openOnly ? 'btn-primary' : '')} onClick={() => setOpenOnly(true)}>Open</button>
          <button className={'btn btn-sm ' + (!openOnly ? 'btn-primary' : '')} onClick={() => setOpenOnly(false)}>All</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      {alerts.length === 0 && (
        <FosEmpty
          title={openOnly ? 'All clear' : 'No alerts recorded'}
          body={openOnly ? 'No open alerts — the factory is running smoothly.' : 'Nothing to show yet.'}
          actions={[{ label: 'Open dashboard', onClick: () => navigate('/plant'), primary: true }]}
        />
      )}
      <div className="fos-alert-list">
        {alerts.map((a) => (
          <div key={String(a.id)} className="fos-alert">
            <div className="fos-alert-body">
              <div className="fos-alert-top">
                <PriorityTag severity={pick(a, 'severity')} />
                <span className="cell-mono">{String(a.alertType ?? '').replace(/_/g, ' ')}</span>
                <Badge value={pick(a, 'status')} />
              </div>
              <h3>{String(a.title ?? '')}</h3>
              <p className="muted">{String(a.message ?? '')}</p>
            </div>
            <div className="fos-alert-actions">
              <button className="btn btn-sm" disabled={busy} onClick={() => view(a)}>View</button>
              <button className="btn btn-sm" disabled={busy} onClick={() => void act(Number(a.id), 'ack')}>Ack</button>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(Number(a.id), 'resolve')}>Resolve</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Visual production schedule — machine-level Gantt
// ---------------------------------------------------------------------------
const WO_COLORS: Record<string, string> = {
  DRAFT: '#94a3b8',
  PLANNED: '#38bdf8',
  APPROVED: '#818cf8',
  MATERIAL_RESERVED: '#a78bfa',
  MATERIALS_RESERVED: '#a78bfa',
  RELEASED: '#f59e0b',
  IN_PRODUCTION: '#10b981',
  IN_PROGRESS: '#10b981',
  QC_INSPECTION: '#f43f5e',
  COMPLETED: '#6366f1',
  CLOSED: '#475569',
};

export function VisualSchedule() {
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
  useEffect(() => { load(); }, [load]);
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
    return Math.max(0, Math.min(100, ((d - startDay) / total) * 100));
  };
  const barW = (v1: unknown, v2: unknown) => Math.max(2.5, col(v2) - col(v1));
  const barColor = (b: Rec) => WO_COLORS[String(b.status ?? '').toUpperCase()] ?? '#38bdf8';
  const nowPct = col(new Date().toISOString());
  const fmtDay = (d: number) => new Date(d * dayMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Visual schedule</h1>
          <p className="muted">Machine-level production Gantt — see every order on the timeline at a glance</p>
        </div>
        <div className="toolbar">
          <input type="date" className="search-input" value={from} onChange={(e) => setFrom(e.target.value)} title="From" />
          <input type="date" className="search-input" value={to} onChange={(e) => setTo(e.target.value)} title="To" />
          <button className="btn btn-sm btn-primary" onClick={() => setQ({ from, to })}>Apply</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {loading && !data && <PageLoader label="Loading schedule..." />}
      {data && machines.length === 0 && (
        <div className="card">
          <div className="card-pad">
            <FosEmpty
              title="No production scheduled"
              body="Create a production order or widen the date range to see machines on the timeline."
              actions={[{ label: 'Create production order', onClick: () => navigate('/plant/wizard'), primary: true }]}
            />
          </div>
        </div>
      )}
      {data && machines.length > 0 && (
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
                      <span className="gantt-mname"><StateDot state={m.machineState} /> {String(m.name ?? m.code)}</span>
                      <span className="muted gantt-mcode">{String(m.code)}</span>
                    </div>
                    <div className="gantt-lane">
                      <div
                        className="gantt-line"
                        style={{ backgroundImage: `repeating-linear-gradient(to right, var(--line) 0 1px, transparent 1px ${100 / total}%)` }}
                      />
                      <div className="gantt-now" style={{ left: nowPct + '%' }} title="Today" />
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
          </div>
        </div>
      )}
    </div>
  );
}
