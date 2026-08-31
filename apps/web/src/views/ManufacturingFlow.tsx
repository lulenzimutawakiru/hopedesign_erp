import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { Meter } from '../components/os';
import {
  MmsDashboard,
  MmsGantt,
  MmsStandards,
  MmsPackaging,
  MmsInspections,
  MmsMachines,
  MmsWip,
  MmsOutputs,
  MmsReservations,
  MmsIssues,
  MmsWaste,
  MmsScrap,
  MmsDowntime,
  MmsNcr,
  MmsShifts,
  MmsBoms,
  MmsCosting,
  loadProductChoices,
} from './MmsViews';
import {
  FactoryDashboard,
  LiveFactory,
  OrderWorkspace,
  SmartProductionWizard,
  OperatorHub,
  QcChecklist,
  WasteRecorder,
  MaterialIssueFlow,
  AlertCenter,
  VisualSchedule,
} from './FactoryOs';

type Rec = Record<string, unknown>;

function parsePlant(path: string): { view: string; id: string | null } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'plant') return { view: 'board', id: null };
  return { view: parts[1] ?? 'board', id: parts[2] ?? null };
}

void loadProductChoices();

export default function ManufacturingFlow({ path }: { path: string }) {
  const { view, id } = parsePlant(path);
  if (view === 'live') return <LiveFactory />;
  if (view === 'alerts') return <AlertCenter />;
  if (view === 'wizard' || view === 'new-ux') return <SmartProductionWizard />;
  if (view === 'operator-ux') return <OperatorHub />;
  if (view === 'inspections-ux') return <QcChecklist />;
  if (view === 'waste-ux') return <WasteRecorder />;
  if (view === 'issue-ux') return <MaterialIssueFlow />;
  if (view === 'gantt-ux') return <VisualSchedule />;
  if (view === 'dashboard') return <MmsDashboard />;
  if (view === 'gantt' || view === 'schedule' || view === 'mps') return <MmsGantt />;
  if (view === 'standards') return <MmsStandards />;
  if (view === 'packaging') return <MmsPackaging />;
  if (view === 'inspections') return <MmsInspections />;
  if (view === 'machines') return <MmsMachines />;
  if (view === 'wip') return <MmsWip />;
  if (view === 'outputs') return <MmsOutputs />;
  if (view === 'reservations') return <MmsReservations />;
  if (view === 'issues') return <MmsIssues />;
  if (view === 'waste') return <MmsWaste />;
  if (view === 'scrap') return <MmsScrap />;
  if (view === 'downtime') return <MmsDowntime />;
  if (view === 'ncr') return <MmsNcr />;
  if (view === 'shifts') return <MmsShifts />;
  if (view === 'boms') return <MmsBoms />;
  if (view === 'costing') return <MmsCosting />;
  if (view === 'orders' && id) return <OrderWorkspace id={Number(id)} />;
  if (view === 'orders') return <WoList />;
  if (view === 'plans' && id === 'new') return <PlanComposer />;
  if (view === 'plans' && id) return <PlanDesk id={Number(id)} />;
  if (view === 'plans') return <PlanList />;
  if (view === 'demand') return <DemandDesk />;
  if (view === 'mrp') return <MrpDesk />;
  if (view === 'command') return <FactoryDashboard />;
  return <PlantBoard />;
}

function PlantBoard() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/production/board')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Plant board failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Loading the millâ€¦" />;
  const kpis = (data.kpis ?? {}) as Rec;
  const live = (data.live as Rec[]) ?? [];
  const machines = (data.machines as Rec[]) ?? [];
  const shortages = (data.shortages as Rec[]) ?? [];
  const planned = Number(kpis.planned ?? 0);
  const produced = Number(kpis.produced ?? 0);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>Plant board</h1>
          <p className="muted">Plan, release, issue, output, complete. Stock and the ledger move with the job.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/operator')}>Operator floor</button>
          {can(user, 'production.work_orders.create') && <button className="btn btn-primary" onClick={() => navigate('/plant/new')}>New work order</button>}
        </div>
      </header>
      <div className="kpi-grid">
        <button className="kpi-card" onClick={() => navigate('/plant/orders')}>
          <span className="kpi-label">Live jobs</span>
          <span className="kpi-value">{fmtNum(kpis.live)}</span>
          <span className="kpi-sub">{fmtNum(kpis.drafts)} drafts</span>
        </button>
        <div className="kpi-card">
          <span className="kpi-label">Planned</span>
          <span className="kpi-value">{fmtNum(planned)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Produced</span>
          <span className="kpi-value">{fmtNum(produced)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Waste</span>
          <span className="kpi-value">{fmtNum(kpis.waste)}</span>
        </div>
      </div>
      <Meter label="Output versus plan" value={planned > 0 ? (produced / planned) * 100 : 0} />
      <div className="do-now">
        <button onClick={() => navigate('/plant/demand')}><strong>Sales demand</strong><span>Make to order</span></button>
        <button onClick={() => navigate('/plant/plans')}><strong>Plans</strong><span>Explode to work orders</span></button>
        <button onClick={() => navigate('/plant/mrp')}><strong>MRP &amp; requisitions</strong><span>Shortages and purchase requests</span></button>
        <button onClick={() => navigate('/plant/orders')}><strong>Work orders</strong><span>Release and run</span></button>
        <button onClick={() => navigate('/inventory/issue')}><strong>Issue materials</strong><span>Warehouse to mill</span></button>
      </div>
      <section className="card">
        <div className="card-head"><h3>Jobs on the board</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>WO</th><th>Product</th><th>Machine</th><th>Status</th><th className="cell-num">Progress</th></tr></thead>
            <tbody>
              {live.map((wo) => (
                <tr key={String(wo.id)} className="row-click" onClick={() => navigate(`/plant/orders/${wo.id}`)}>
                  <td className="cell-mono">{String(wo.woNo)}</td>
                  <td><div className="cell-mono">{String(wo.productCode)}</div>{String(wo.productName)}</td>
                  <td className="cell-mono">{String(wo.machineCode ?? 'â€”')}</td>
                  <td><Badge value={wo.status} /></td>
                  <td className="cell-num">{fmtNum(wo.producedQty)} / {fmtNum(wo.quantity)}</td>
                </tr>
              ))}
              {live.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No open jobs.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Machines</h3></div>
        <div className="wh-grid" style={{ padding: 14 }}>
          {machines.map((m) => (
            <div key={String(m.id)} className="wh-card">
              <div className="wh-card-top">
                <span className="cell-mono">{String(m.code)}</span>
                <Badge value={m.status} />
              </div>
              <strong>{String(m.name)}</strong>
              <div className="muted">{m.currentWo ? `Running ${m.currentWo}` : String(m.type)}</div>
            </div>
          ))}
        </div>
      </section>
      {shortages.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Material shortages</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Material</th><th className="cell-num">Still needed</th><th className="cell-num">Available</th></tr></thead>
              <tbody>
                {shortages.map((s) => (
                  <tr key={String(s.code)}>
                    <td><div className="cell-mono">{String(s.code)}</div>{String(s.name)}</td>
                    <td className="cell-num">{fmtNum(s.shortQty)}</td>
                    <td className="cell-num">{fmtNum(s.available)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function WoList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ pageSize: '50' });
    if (q.trim()) p.set('q', q.trim());
    api<{ data: { rows: Rec[] } }>(`/api/ops/production/work-orders?${p}`)
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Work orders failed'));
  }, [q]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Work orders</p>
          <h1>Shop orders</h1>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/plant/new')}>New work order</button>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search WO or productâ€¦" />
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>WO</th><th>Product</th><th>Status</th><th className="cell-num">Qty</th><th className="cell-num">Produced</th><th className="cell-num">Std cost</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/plant/orders/${r.id}`)}>
                <td className="cell-mono">{String(r.woNo)}</td>
                <td><div className="cell-mono">{String(r.productCode)}</div>{String(r.productName)}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{fmtNum(r.quantity)}</td>
                <td className="cell-num">{fmtNum(r.producedQty)}</td>
                <td className="cell-num">{fmtMoney(r.standardCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlanList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/production/plans').then((r) => setRows(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'Plans failed'));
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Planning</p>
          <h1>Production plans</h1>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/plant/plans/new')}>New plan</button>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Plan</th><th>Date</th><th>Status</th><th className="cell-num">Items</th><th className="cell-num">WOs</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/plant/plans/${r.id}`)}>
                <td className="cell-mono">{String(r.planNo)}</td>
                <td>{String(r.planDate).slice(0, 10)}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{fmtNum(r.itemCount)}</td>
                <td className="cell-num">{fmtNum(r.woCount)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No plans yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlanDesk({ id }: { id: number }) {
  const [doc, setDoc] = useState<{ plan: Rec; items: Rec[]; workOrders: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: { plan: Rec; items: Rec[]; workOrders: Rec[] } }>(`/api/ops/production/plans/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Plan failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening planâ€¦" />;
  const explode = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: { created: Rec[] } }>(`/api/ops/production/plans/${id}/explode`, { method: 'POST', body: '{}' });
      setNotice(`Created ${r.data.created.length} work order(s)`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/plant/plans')}>Back</button>
          <h1>Plan <span className="cell-mono">{String(doc.plan.planNo)}</span></h1>
        </div>
        <Badge value={doc.plan.status} />
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <section className="card">
        <div className="card-head">
          <h3>Items</h3>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={explode}>Explode to work orders</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Product</th><th className="cell-num">Qty</th><th>Due</th></tr></thead>
            <tbody>
              {doc.items.map((i) => (
                <tr key={String(i.id)}>
                  <td><div className="cell-mono">{String(i.productCode)}</div>{String(i.productName)}</td>
                  <td className="cell-num">{fmtNum(i.quantity)}</td>
                  <td>{i.dueDate ? String(i.dueDate).slice(0, 10) : 'â€”'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {doc.workOrders.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Work orders</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>WO</th><th>Status</th><th className="cell-num">Qty</th></tr></thead>
              <tbody>
                {doc.workOrders.map((w) => (
                  <tr key={String(w.id)} className="row-click" onClick={() => navigate(`/plant/orders/${w.id}`)}>
                    <td className="cell-mono">{String(w.woNo)}</td>
                    <td><Badge value={w.status} /></td>
                    <td className="cell-num">{fmtNum(w.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function PlanComposer() {
  const [productId, setProductId] = useState('');
  const [productLabel, setProductLabel] = useState('');
  const [products, setProducts] = useState<Rec[]>([]);
  const [qty, setQty] = useState('1000');
  const [due, setDue] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/inventory/items?pageSize=40').then((r) => setProducts(r.data ?? [])).catch(() => undefined);
  }, []);
  const save = async () => {
    if (!productId) { setError('Pick a product'); return; }
    setBusy(true); setError('');
    try {
      const r = await api<{ data: { planId: number } }>('/api/ops/production/plans', {
        method: 'POST',
        body: JSON.stringify({ notes, items: [{ productId: Number(productId), quantity: Number(qty), dueDate: due || null }] }),
      });
      navigate(`/plant/plans/${r.data.planId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/plant/plans')}>Back</button>
          <h1>New production plan</h1>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required" style={{ gridColumn: '1 / -1' }}>
            <label>Product</label>
            <select value={productId} onChange={(e) => {
              const p = products.find((x) => String(x.id) === e.target.value);
              setProductId(e.target.value);
              setProductLabel(p ? `${p.code} Â· ${p.name}` : '');
            }}>
              <option value="">{productLabel || 'Selectâ€¦'}</option>
              {products.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.code)} Â· {String(p.name)}</option>)}
            </select>
          </div>
          <div className="field field-required"><label>Quantity</label><input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
          <div className="field"><label>Due</label><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Notes</label><input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={save}>Save plan</button>
      </section>
    </div>
  );
}

function DemandDesk() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/production/demand').then((r) => setRows(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'Demand failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const make = async (salesOrderItemId: number) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: { woNo: string } }>('/api/ops/production/demand/make', {
        method: 'POST',
        body: JSON.stringify({ salesOrderItemId }),
      });
      setNotice(`Created ${r.data.woNo}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Make to order</p>
          <h1>Sales demand</h1>
          <p className="muted">Approved sales lines not yet dispatched. Create a work order to cover the remainder.</p>
        </div>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>SO</th><th>Product</th><th className="cell-num">Open</th><th className="cell-num">Already planned</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.salesOrderItemId)}>
                <td className="cell-mono">{String(r.orderNo)}</td>
                <td><div className="cell-mono">{String(r.productCode)}</div>{String(r.productName)}</td>
                <td className="cell-num">{fmtNum(r.remainingQty)}</td>
                <td className="cell-num">{fmtNum(r.plannedQty)}</td>
                <td>
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => make(Number(r.salesOrderItemId))}>Make</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No open sales demand.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}


const OPEN_PR_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_ORDERED', 'ON_HOLD'];

function MrpDesk() {
  const { user } = useAuth();
  const [data, setData] = useState<{ shortages: Rec[]; mrp: Rec[] } | null>(null);
  const [prs, setPrs] = useState<Rec[]>([]);
  const [docs, setDocs] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: { shortages: Rec[]; mrp: Rec[] } }>('/api/ops/procurement/demand')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Demand failed'));
    api<{ data: { rows: Rec[] } }>('/api/ops/procurement/requisitions?page=1&pageSize=25')
      .then((r) => setPrs((r.data.rows ?? []).filter((x) => OPEN_PR_STATUSES.includes(String(x.status)))))
      .catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);
  const canViewDocs = can(user, 'production.work_orders.print');
  useEffect(() => {
    if (!canViewDocs) return;
    api<{ data: Rec[] }>('/api/ops/manufacturing/documents')
      .then((r) => setDocs((r.data ?? []).filter((d) => String(d.docType) === 'MATERIAL_REQUISITION')))
      .catch(() => undefined);
  }, [canViewDocs]);
  const raise = async (productId: number, quantity: number) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: { prNo: string } }>('/api/ops/procurement/demand/make', {
        method: 'POST',
        body: JSON.stringify({ productId, quantity }),
      });
      setNotice('Raised ' + r.data.prNo);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Loading MRP and requisitions..." />;
  const canRaise = can(user, 'procurement.requisitions.create');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Manufacturing</p>
          <h1>MRP &amp; requisitions</h1>
          <p className="muted">Plant shortages and MRP purchase suggestions. Raising a PR routes it through approval - nothing is purchased automatically.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/buy/demand')}>Buy demand</button>
          <button className="btn" onClick={() => navigate('/buy/requisitions')}>All requisitions</button>
        </div>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <section className="card">
        <div className="card-head"><h3>Plant shortages</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Material</th><th className="cell-num">Short</th><th className="cell-num">Available</th><th /></tr></thead>
            <tbody>
              {data.shortages.map((s) => (
                <tr key={String(s.productId)}>
                  <td><div className="cell-mono">{String(s.code)}</div>{String(s.name)}</td>
                  <td className="cell-num">{fmtNum(s.shortQty)}</td>
                  <td className="cell-num">{fmtNum(s.available)}</td>
                  <td>{canRaise && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => raise(Number(s.productId), Number(s.shortQty))}>Raise PR</button>}</td>
                </tr>
              ))}
              {data.shortages.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No live material shortages.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>MRP purchase suggestions</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Material</th><th className="cell-num">Suggested</th><th /></tr></thead>
            <tbody>
              {data.mrp.map((s) => (
                <tr key={String(s.productId)}>
                  <td><div className="cell-mono">{String(s.code)}</div>{String(s.name)}</td>
                  <td className="cell-num">{fmtNum(s.suggestedQuantity)}</td>
                  <td>{canRaise && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => raise(Number(s.productId), Number(s.suggestedQuantity))}>Raise PR</button>}</td>
                </tr>
              ))}
              {data.mrp.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 16 }}>No open purchase suggestions. Run MRP from production plans to populate this list.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Open purchase requisitions</h3>
          <button className="btn btn-sm" onClick={() => navigate('/buy/requisitions')}>View all</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>PR</th><th>Requester</th><th className="cell-num">Items</th><th>Status</th><th /></tr></thead>
            <tbody>
              {prs.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/buy/requisitions/${r.id}`)}>
                  <td className="cell-mono">{String(r.prNo)}</td>
                  <td>{String(r.requestedByName ?? '-')}</td>
                  <td className="cell-num">{fmtNum(r.itemCount)}</td>
                  <td><Badge value={r.status} /></td>
                  <td><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/buy/requisitions/${r.id}`); }}>Open</button></td>
                </tr>
              ))}
              {prs.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 16 }}>No open purchase requisitions.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Material requisitions</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Doc</th><th>Work order</th><th>Status</th><th>Generated</th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={String(d.id)} className={d.workOrderId ? 'row-click' : ''} onClick={() => d.workOrderId && navigate(`/plant/orders/${d.workOrderId}`)}>
                  <td className="cell-mono">{String(d.docNo)}</td>
                  <td className="cell-mono">{String(d.woNo ?? '-')}</td>
                  <td><Badge value={d.status} /></td>
                  <td>{String(d.generatedAt ?? '-').slice(0, 10)}</td>
                </tr>
              ))}
              {docs.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No MES material requisition documents. Generate documents from a work order.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
