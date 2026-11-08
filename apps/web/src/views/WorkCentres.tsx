import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtNum, ListResult } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { Meter } from '../components/os';
import { toast } from '../components/toast';

type Rec = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

const TYPES = ['MACHINE', 'LABOUR', 'ASSEMBLY', 'QC', 'PACKAGING'];

interface WcForm {
  code: string;
  name: string;
  type: string;
  capacity: string;
  capacityUnit: string;
  hourlyCost: string;
  overheadRate: string;
  department: string;
  availableHours: string;
  efficiencyPct: string;
  utilisationPct: string;
  isActive: boolean;
}

const emptyWc = (): WcForm => ({
  code: '',
  name: '',
  type: 'MACHINE',
  capacity: '',
  capacityUnit: '',
  hourlyCost: '',
  overheadRate: '',
  department: '',
  availableHours: '8',
  efficiencyPct: '85',
  utilisationPct: '80',
  isActive: true,
});

interface OpRow {
  key: string;
  seq: number;
  name: string;
  workCentreId: string;
  machineId: string;
  setupTimeMin: string;
  runTimePerUnitMin: string;
  teardownTimeMin: string;
  alternativeWorkCentres: number[];
}

const newOp = (seq: number): OpRow => ({
  key: `${Date.now()}-${Math.random()}`,
  seq,
  name: '',
  workCentreId: '',
  machineId: '',
  setupTimeMin: '',
  runTimePerUnitMin: '',
  teardownTimeMin: '',
  alternativeWorkCentres: [],
});

export default function WorkCentres({ id }: { id: string | null }) {
  const { user } = useAuth();
  const [mode, setMode] = useState<'list' | 'detail' | 'operations'>(id && id !== 'new' ? 'detail' : id === 'new' ? 'detail' : 'list');
  const [centreId, setCentreId] = useState<number | null>(id && id !== 'new' ? Number(id) : null);

  const canCreate = can(user, 'production.work_centres.create');
  const canUpdate = can(user, 'production.work_centres.update');
  const canDelete = can(user, 'production.work_centres.delete');
  const canEditOps = can(user, 'production.boms.update');

  useEffect(() => {
    if (id && id !== 'new') { setMode('detail'); setCentreId(Number(id)); }
    else if (id === 'new') { setMode('detail'); setCentreId(null); }
  }, [id]);

  if (mode === 'operations' && canEditOps) {
    return <OperationsEditor onBack={() => setMode('list')} />;
  }
  if (mode === 'detail') {
    return (
      <WorkCentreDetail
        centreId={centreId}
        onBack={() => { setMode('list'); setCentreId(null); navigate('/plant/work-centres'); }}
        canUpdate={canUpdate}
        canDelete={canDelete}
      />
    );
  }
  return (
    <WorkCentreList
      canCreate={canCreate}
      canEditOps={canEditOps}
      onNew={() => { setCentreId(null); setMode('detail'); }}
      onOpen={(cid) => { setCentreId(cid); setMode('detail'); }}
      onOperations={() => setMode('operations')}
    />
  );
}

function WorkCentreList({ canCreate, canEditOps, onNew, onOpen, onOperations }: {
  canCreate: boolean;
  canEditOps: boolean;
  onNew: () => void;
  onOpen: (id: number) => void;
  onOperations: () => void;
}) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/manufacturing/work-centres')
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load work centres'))
      .finally(() => setLoading(false));
  }, []);

  const totals = useMemo(() => {
    const machines = rows.reduce((s, r) => s + n(r.machineCount), 0);
    const running = rows.reduce((s, r) => s + n(r.machinesRunning), 0);
    const down = rows.reduce((s, r) => s + n(r.machinesDown), 0);
    const ops = rows.reduce((s, r) => s + n(r.operationCount), 0);
    const oee = rows.length ? rows.reduce((s, r) => s + n(r.oeeAvg), 0) / rows.length : 0;
    return { machines, running, down, ops, oee };
  }, [rows]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Work Centres</h1>
          <p className="muted">Capacity and cost centres behind routings — machines, standard times, load and OEE.</p>
        </div>
        <div className="head-actions">
          {canEditOps && <button className="btn" onClick={onOperations}>Edit routing operations</button>}
          {canCreate && <button className="btn btn-primary" onClick={onNew}>New work centre</button>}
        </div>
      </header>

      {error && <ErrorBanner error={error} />}

      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Work centres</span><span className="kpi-value">{fmtNum(rows.length)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Machines</span><span className="kpi-value">{fmtNum(totals.machines)}</span><span className="kpi-sub">{fmtNum(totals.running)} running · {fmtNum(totals.down)} down</span></div>
        <div className="kpi-card"><span className="kpi-label">Routing operations</span><span className="kpi-value">{fmtNum(totals.ops)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Average OEE</span><span className="kpi-value">{totals.oee.toFixed(1)}%</span></div>
      </div>

      {loading ? <PageLoader variant="page" label="Loading work centres…" /> : (
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr>
                <th>Centre</th>
                <th>Type</th>
                <th className="cell-num">Machines</th>
                <th className="cell-num">Operations</th>
                <th className="cell-num">Scheduled</th>
                <th className="cell-num">OEE</th>
                <th className="cell-num">Efficiency</th>
                <th className="cell-num">Utilisation</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => onOpen(n(r.id))} style={{ cursor: 'pointer' }}>
                  <td>
                    <div className="cell-mono">{String(r.code)}</div>
                    <div>{String(r.name)}</div>
                    {r.department ? <div className="muted">{String(r.department)}</div> : null}
                  </td>
                  <td><Badge value={r.type} /></td>
                  <td className="cell-num">
                    {fmtNum(r.machineCount)}
                    {n(r.machinesDown) > 0 && <span className="muted"> · {fmtNum(r.machinesDown)} down</span>}
                  </td>
                  <td className="cell-num">{fmtNum(r.operationCount)}</td>
                  <td className="cell-num">{fmtNum(r.scheduledJobs)}</td>
                  <td className="cell-num">
                    <span style={{ color: n(r.oeeAvg) < 50 ? 'var(--danger)' : undefined }}>{n(r.oeeAvg).toFixed(1)}%</span>
                  </td>
                  <td className="cell-num">{fmtNum(r.efficiencyTargetPct)}%</td>
                  <td className="cell-num">{fmtNum(r.utilisationTargetPct)}%</td>
                  <td><Badge value={r.status} /></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 28 }}>No work centres yet. Create one to start routing operations and tracking capacity.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WorkCentreDetail({ centreId, onBack, canUpdate, canDelete }: {
  centreId: number | null;
  onBack: () => void;
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const [detail, setDetail] = useState<Rec | null>(null);
  const [machines, setMachines] = useState<Rec[]>([]);
  const [operations, setOperations] = useState<Rec[]>([]);
  const [form, setForm] = useState<WcForm>(emptyWc());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(centreId != null);

  const load = useCallback(() => {
    if (centreId == null) return;
    setLoading(true);
    api<{ data: Rec }>(`/api/ops/manufacturing/work-centres/${centreId}`)
      .then((r) => {
        const d = r.data;
        setDetail(d);
        setMachines(Array.isArray(d.machines) ? (d.machines as Rec[]) : []);
        setOperations(Array.isArray(d.operations) ? (d.operations as Rec[]) : []);
        setForm({
          code: String(d.code ?? ''),
          name: String(d.name ?? ''),
          type: String(d.type ?? 'MACHINE'),
          capacity: d.capacity != null ? String(d.capacity) : '',
          capacityUnit: String(d.capacityUnit ?? ''),
          hourlyCost: d.hourlyCost != null ? String(d.hourlyCost) : '',
          overheadRate: d.overheadRate != null ? String(d.overheadRate) : '',
          department: String(d.department ?? ''),
          availableHours: d.availableHours != null ? String(d.availableHours) : '8',
          efficiencyPct: String(Math.round(n(d.efficiencyTarget ?? 0.85) * 100)),
          utilisationPct: String(Math.round(n(d.utilisationTarget ?? 0.8) * 100)),
          isActive: String(d.status ?? '') !== 'INACTIVE',
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load work centre'))
      .finally(() => setLoading(false));
  }, [centreId]);

  useEffect(() => { load(); }, [load]);

  const set = (k: keyof WcForm, v: unknown) => setForm((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (!form.code.trim() || !form.name.trim()) { setError('Code and name are required'); return; }
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        type: form.type,
        capacity: form.capacity ? Number(form.capacity) : null,
        capacityUnit: form.capacityUnit || null,
        hourlyCost: form.hourlyCost ? Number(form.hourlyCost) : 0,
        overheadRate: form.overheadRate ? Number(form.overheadRate) : 0,
        department: form.department || null,
        availableHours: form.availableHours ? Number(form.availableHours) : 8,
        efficiencyTarget: form.efficiencyPct ? Number(form.efficiencyPct) / 100 : 0.85,
        utilisationTarget: form.utilisationPct ? Number(form.utilisationPct) / 100 : 0.8,
        isActive: form.isActive,
      };
      if (centreId != null) {
        await api(`/api/ops/manufacturing/work-centres/${centreId}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast.success('Work centre saved');
      } else {
        await api('/api/ops/manufacturing/work-centres', { method: 'POST', body: JSON.stringify(payload) });
        toast.success('Work centre created');
      }
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    if (centreId == null || !window.confirm('Deactivate this work centre? It will stop accepting new operations.')) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/manufacturing/work-centres/${centreId}`, { method: 'DELETE' });
      toast.success('Work centre deactivated');
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deactivate failed');
    } finally {
      setBusy(false);
    }
  };

  const isNew = centreId == null;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={onBack}>Back to work centres</button>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>{isNew ? 'New work centre' : <><span className="cell-mono">{String(detail?.code ?? form.code)}</span> {String(detail?.name ?? form.name)}</>}</h1>
          <p className="muted">{isNew ? 'Define a capacity and cost centre for routings.' : 'Machines, routing operations and OEE for this centre.'}</p>
        </div>
        <div className="head-actions">
          {canUpdate && <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save work centre'}</button>}
        </div>
      </header>

      {error && <ErrorBanner error={error} />}

      {!isNew && loading ? <PageLoader variant="page" label="Loading work centre…" /> : (
        <>
          <section className="table-wrap card" style={{ marginBottom: 14 }}>
            <div className="card-head"><h3>Details</h3></div>
            <div className="grid-2" style={{ padding: 16, gap: 14 }}>
              <div className="field field-required"><label>Code</label><input value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="e.g. CUT-01" /></div>
              <div className="field field-required"><label>Name</label><input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Cutting line" /></div>
              <div className="field"><label>Type</label><select value={form.type} onChange={(e) => set('type', e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></div>
              <div className="field"><label>Department</label><input value={form.department} onChange={(e) => set('department', e.target.value)} /></div>
              <div className="field"><label>Capacity</label><input type="number" step="any" min={0} value={form.capacity} onChange={(e) => set('capacity', e.target.value)} /></div>
              <div className="field"><label>Capacity unit</label><input value={form.capacityUnit} onChange={(e) => set('capacityUnit', e.target.value)} placeholder="e.g. reams/hr" /></div>
              <div className="field"><label>Hourly cost (UGX)</label><input type="number" step="any" min={0} value={form.hourlyCost} onChange={(e) => set('hourlyCost', e.target.value)} /></div>
              <div className="field"><label>Overhead rate (%)</label><input type="number" step="any" min={0} value={form.overheadRate} onChange={(e) => set('overheadRate', e.target.value)} /></div>
              <div className="field"><label>Available hours / day</label><input type="number" step="any" min={0} value={form.availableHours} onChange={(e) => set('availableHours', e.target.value)} /></div>
              <div className="field"><label>Efficiency target (%)</label><input type="number" step="any" min={0} max={100} value={form.efficiencyPct} onChange={(e) => set('efficiencyPct', e.target.value)} /></div>
              <div className="field"><label>Utilisation target (%)</label><input type="number" step="any" min={0} max={100} value={form.utilisationPct} onChange={(e) => set('utilisationPct', e.target.value)} /></div>
              <div className="field"><label>Status</label><select value={form.isActive ? 'active' : 'inactive'} onChange={(e) => set('isActive', e.target.value === 'active')}><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
            </div>
          </section>

          {!isNew && (
            <>
              <div className="kpi-grid">
                <div className="kpi-card"><span className="kpi-label">Machines</span><span className="kpi-value">{fmtNum(machines.length)}</span></div>
                <div className="kpi-card"><span className="kpi-label">Routing operations</span><span className="kpi-value">{fmtNum(operations.length)}</span></div>
                <div className="kpi-card"><span className="kpi-label">Facility</span><span className="kpi-value">{String(detail?.facilityName ?? '—')}</span></div>
              </div>

              <Meter label="Efficiency target" value={Number(form.efficiencyPct) || 0} />
              <Meter label="Utilisation target" value={Number(form.utilisationPct) || 0} />

              <section className="card" style={{ marginBottom: 14 }}>
                <div className="card-head"><h3>Machines</h3></div>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>State</th></tr></thead>
                    <tbody>
                      {machines.map((m) => (
                        <tr key={String(m.id)}>
                          <td className="cell-mono">{String(m.code)}</td>
                          <td>{String(m.name)}</td>
                          <td>{String(m.type ?? '—')}</td>
                          <td><Badge value={m.machineState ?? m.status} /></td>
                        </tr>
                      ))}
                      {machines.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No machines linked to this work centre.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="card">
                <div className="card-head"><h3>Routing operations on this centre</h3></div>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Routing</th><th>Product</th><th className="cell-num">Seq</th><th>Operation</th><th className="cell-num">Setup</th><th className="cell-num">Run / unit</th><th className="cell-num">Teardown</th></tr></thead>
                    <tbody>
                      {operations.map((o) => (
                        <tr key={String(o.id)}>
                          <td className="cell-mono">{String(o.routingCode ?? '')}</td>
                          <td>{String(o.productCode ?? '')} · {String(o.productName ?? '')}</td>
                          <td className="cell-num">{fmtNum(o.seq)}</td>
                          <td>{String(o.name)}</td>
                          <td className="cell-num">{fmtNum(o.setupTimeMin)}</td>
                          <td className="cell-num">{fmtNum(o.runTimePerUnitMin)}</td>
                          <td className="cell-num">{fmtNum(o.teardownTimeMin)}</td>
                        </tr>
                      ))}
                      {operations.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 16 }}>No routing operations reference this centre yet. Edit routing operations from the work centres list.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>

              {canDelete && (
                <div style={{ marginTop: 14 }}>
                  <button className="btn btn-danger" onClick={deactivate} disabled={busy}>Deactivate work centre</button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function OperationsEditor({ onBack }: { onBack: () => void }) {
  const [routings, setRoutings] = useState<Rec[]>([]);
  const [workCentres, setWorkCentres] = useState<Rec[]>([]);
  const [machines, setMachines] = useState<Rec[]>([]);
  const [routingId, setRoutingId] = useState('');
  const [ops, setOps] = useState<OpRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/manufacturing/routings').then((r) => setRoutings(Array.isArray(r.data) ? r.data : [])).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/manufacturing/work-centres').then((r) => setWorkCentres(Array.isArray(r.data) ? r.data : [])).catch(() => undefined);
    api<ListResult>('/api/production/machines?pageSize=200').then((r) => setMachines(r.data ?? [])).catch(() => undefined);
  }, []);

  const loadRouting = useCallback(async (rid: string) => {
    if (!rid) { setOps([]); return; }
    setLoading(true);
    setError('');
    try {
      const r = await api<{ data: Rec }>(`/api/ops/manufacturing/routings/${rid}`);
      const list = Array.isArray(r.data?.operations) ? (r.data.operations as Rec[]) : [];
      setOps(list.map((o, i) => ({
        key: `${o.id ?? i}-${Math.random()}`,
        seq: i + 1,
        name: String(o.name ?? ''),
        workCentreId: o.workCentreId != null ? String(o.workCentreId) : '',
        machineId: o.machineId != null ? String(o.machineId) : '',
        setupTimeMin: o.setupTimeMin != null ? String(o.setupTimeMin) : '',
        runTimePerUnitMin: o.runTimePerUnitMin != null ? String(o.runTimePerUnitMin) : '',
        teardownTimeMin: o.teardownTimeMin != null ? String(o.teardownTimeMin) : '',
        alternativeWorkCentres: Array.isArray(o.alternativeWorkCentres) ? (o.alternativeWorkCentres as number[]) : [],
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load routing operations');
    } finally {
      setLoading(false);
    }
  }, []);

  const setOp = (key: string, patch: Partial<OpRow>) => setOps((p) => p.map((o) => (o.key === key ? { ...o, ...patch } : o)));

  const save = async () => {
    if (!routingId) { setError('Choose a routing'); return; }
    const valid = ops.filter((o) => o.name.trim() && o.workCentreId);
    if (!valid.length) { setError('Add at least one operation with a name and work centre'); return; }
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/manufacturing/routings/${routingId}/operations`, {
        method: 'PUT',
        body: JSON.stringify({
          operations: valid.map((o, i) => ({
            seq: i + 1,
            name: o.name.trim(),
            workCentreId: Number(o.workCentreId),
            setupTimeMin: o.setupTimeMin ? Number(o.setupTimeMin) : 0,
            runTimePerUnitMin: o.runTimePerUnitMin ? Number(o.runTimePerUnitMin) : 0,
            teardownTimeMin: o.teardownTimeMin ? Number(o.teardownTimeMin) : 0,
            machineId: o.machineId ? Number(o.machineId) : null,
            alternativeWorkCentres: o.alternativeWorkCentres,
          })),
        }),
      });
      toast.success('Routing operations saved');
      await loadRouting(routingId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const machinesFor = (wcId: string) => machines.filter((m) => String(m.workCentreId) === wcId);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={onBack}>Back to work centres</button>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Routing operations</h1>
          <p className="muted">Edit the operation sequence for a routing — work centre, machine, standard times and alternative centres.</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={save} disabled={busy || !routingId}>{busy ? 'Saving…' : 'Save operations'}</button>
        </div>
      </header>

      {error && <ErrorBanner error={error} />}

      <div className="toolbar">
        <select className="search-input" style={{ maxWidth: 360 }} value={routingId} onChange={(e) => { setRoutingId(e.target.value); loadRouting(e.target.value); }}>
          <option value="">— choose routing —</option>
          {routings.map((r) => <option key={String(r.id)} value={String(r.id)}>{String(r.code)} · {String(r.productCode ?? r.productName)}</option>)}
        </select>
        <button className="btn btn-sm" onClick={() => setOps((p) => [...p, newOp(p.length + 1)])} disabled={!routingId}>+ Add operation</button>
      </div>

      {loading ? <PageLoader label="Loading operations…" /> : routingId ? (
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr>
                <th className="cell-num">Seq</th>
                <th>Operation</th>
                <th>Work centre</th>
                <th>Machine</th>
                <th className="cell-num">Setup (min)</th>
                <th className="cell-num">Run / unit (min)</th>
                <th className="cell-num">Teardown (min)</th>
                <th>Alternatives</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ops.map((o, i) => (
                <tr key={o.key}>
                  <td className="cell-num">{i + 1}</td>
                  <td><input className="cell-input" value={o.name} onChange={(e) => setOp(o.key, { name: e.target.value })} placeholder="Operation name" /></td>
                  <td>
                    <select className="cell-input" value={o.workCentreId} onChange={(e) => setOp(o.key, { workCentreId: e.target.value, machineId: '' })}>
                      <option value="">—</option>
                      {workCentres.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(w.code)} · {String(w.name)}</option>)}
                    </select>
                  </td>
                  <td>
                    <select className="cell-input" value={o.machineId} onChange={(e) => setOp(o.key, { machineId: e.target.value })}>
                      <option value="">—</option>
                      {machinesFor(o.workCentreId).map((m) => <option key={String(m.id)} value={String(m.id)}>{String(m.code)}</option>)}
                    </select>
                  </td>
                  <td><input className="cell-input" type="number" step="any" min={0} value={o.setupTimeMin} onChange={(e) => setOp(o.key, { setupTimeMin: e.target.value })} /></td>
                  <td><input className="cell-input" type="number" step="any" min={0} value={o.runTimePerUnitMin} onChange={(e) => setOp(o.key, { runTimePerUnitMin: e.target.value })} /></td>
                  <td><input className="cell-input" type="number" step="any" min={0} value={o.teardownTimeMin} onChange={(e) => setOp(o.key, { teardownTimeMin: e.target.value })} /></td>
                  <td>
                    <select
                      className="cell-input"
                      multiple
                      size={Math.min(4, Math.max(2, workCentres.length))}
                      value={o.alternativeWorkCentres.map(String)}
                      onChange={(e) => {
                        const vals = Array.from(e.target.selectedOptions).map((opt) => Number(opt.value));
                        setOp(o.key, { alternativeWorkCentres: vals });
                      }}
                    >
                      {workCentres.filter((w) => String(w.id) !== o.workCentreId).map((w) => (
                        <option key={String(w.id)} value={String(w.id)}>{String(w.code)}</option>
                      ))}
                    </select>
                  </td>
                  <td><button className="btn btn-sm" onClick={() => setOps((p) => p.filter((x) => x.key !== o.key))}>Remove</button></td>
                </tr>
              ))}
              {ops.length === 0 && <tr><td colSpan={9} className="muted" style={{ padding: 16 }}>No operations on this routing. Add one above.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">Choose a routing to edit its operation sequence.</p>}
    </div>
  );
}
