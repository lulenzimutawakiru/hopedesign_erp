import { useEffect, useState } from 'react';
import { api, fmtMoney, fmtNum } from '../api';
import { Badge, ErrorBanner } from '../components/ui';
import { EmptyState, Meter, Skeleton } from '../components/os';
import { pick } from '../helpers';
import { navigate } from '../router';
import { useAuth, can } from '../auth';

type Rec = Record<string, unknown>;

export function PlantRoom() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/dashboard/rooms/plant').then((r) => setData(r.data)).catch((e) => setError(e instanceof Error ? e.message : 'Plant feed failed'));
  }, []);
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Skeleton rows={6} />;
  const machines = (data.machines as Rec[]) ?? [];
  const live = (data.live as Rec[]) ?? [];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="mfg">Plant control room</p>
          <h1>Production today</h1>
          <p className="muted">Planned versus actual, machine state, and the jobs that are live on the floor.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/operator')}>Operator floor</button>
          <button className="btn btn-primary" onClick={() => navigate('/plant/new')}>New work order</button>
          <button className="btn" onClick={() => navigate('/records/production/work_orders')}>All work orders</button>
        </div>
      </header>
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Planned</span><span className="kpi-value">{fmtNum(data.planned)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Produced</span><span className="kpi-value">{fmtNum(data.produced)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Remaining</span><span className="kpi-value">{fmtNum(data.remaining)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Efficiency</span><span className="kpi-value">{fmtNum(data.efficiency)}%</span><span className="kpi-sub">Waste {fmtNum(data.wastePct)}%</span></div>
      </div>
      <Meter label="Output versus plan" value={Number(data.efficiency ?? 0)} />
      <section className="card">
        <div className="card-head"><h3>Machine board</h3></div>
        <div className="wh-grid" style={{ padding: 14 }}>
          {machines.map((m) => (
            <button key={String(m.id)} className="wh-card" onClick={() => navigate(`/records/production/machines/${m.id}`)}>
              <div className="wh-card-top">
                <span className="cell-mono">{String(m.code)}</span>
                <Badge value={m.status} />
              </div>
              <strong>{String(m.name)}</strong>
              <div className="muted">{String(m.type)}</div>
            </button>
          ))}
          {machines.length === 0 && <EmptyState title="No machines" body="The plant register is empty for this company." />}
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Live work orders</h3></div>
        {live.length === 0 ? <EmptyState title="No live jobs" body="Nothing is released or in progress." action="Open work orders" onAction={() => navigate('/records/production/work_orders')} /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>WO</th><th>Product</th><th>Machine</th><th>Status</th><th className="cell-num">Progress</th></tr></thead>
              <tbody>
                {live.map((wo) => (
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
        )}
      </section>
    </div>
  );
}

export function WarehouseRoom({ handheld = false }: { handheld?: boolean }) {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/dashboard/rooms/warehouse').then((r) => setData(r.data)).catch((e) => setError(e instanceof Error ? e.message : 'Warehouse feed failed'));
  }, []);
  const acts = [
    { label: 'Receive', href: '/inventory/receive', perm: 'inventory.stock.view' },
    { label: 'Put away', href: '/inventory/putaway', perm: 'inventory.movements.create' },
    { label: 'Pick / dispatch', href: '/inventory/pick', perm: 'inventory.stock.view' },
    { label: 'Issue to plant', href: '/inventory/issue', perm: 'inventory.stock.view' },
    { label: 'Transfer', href: '/inventory/transfers/new', perm: 'inventory.transfers.create' },
    { label: 'Count', href: '/inventory/adjustments/new', perm: 'inventory.adjustments.create' },
    { label: 'Demand / ATP', href: '/inventory/demand', perm: 'inventory.stock.view' },
  ].filter((a) => !a.perm || can(user, a.perm));
  if (handheld) {
    return (
      <div className="page handheld-page">
        <header className="handheld-head">
          <p className="mod-kicker" data-mod="wh">Warehouse</p>
          <h1>Main floor</h1>
        </header>
        {error && <ErrorBanner error={error} />}
        <button className="handheld-scan" onClick={() => navigate('/qr/scan')}>◉ Scan</button>
        <div className="handheld-acts">
          {acts.map((a) => (
            <button key={a.label} className="btn btn-block handheld-act" onClick={() => navigate(a.href)}>{a.label}</button>
          ))}
        </div>
      </div>
    );
  }
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Skeleton rows={5} />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="wh">Warehouse control</p>
          <h1>Physical operations today</h1>
          <p className="muted">Receive, put away, pick, count, transfer, dispatch. Built for handhelds.</p>
        </div>
        <button className="btn" onClick={() => navigate('/warehouse/floor')}>Floor mode</button>
        <button className="btn btn-primary" onClick={() => navigate('/inventory/ops')}>Operations desk</button>
      </header>
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Received</span><span className="kpi-value">{fmtNum(data.received)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Moves</span><span className="kpi-value">{fmtNum(data.moves)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Transfers</span><span className="kpi-value">{fmtNum(data.transfers)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Dispatches</span><span className="kpi-value">{fmtNum(data.dispatched)}</span></div>
        <button className={`kpi-card ${Number(data.alerts) ? 'card-warn' : ''}`} onClick={() => navigate('/inventory/stock')}>
          <span className="kpi-label">Stock alerts</span><span className="kpi-value">{fmtNum(data.alerts)}</span>
        </button>
      </div>
      <div className="do-now">
        {acts.map((a) => (
          <button key={a.label} onClick={() => navigate(a.href)}><strong>{a.label}</strong><span>Permission-checked</span></button>
        ))}
      </div>
      <button className="btn btn-primary" onClick={() => navigate('/inventory/stock')}>Open stock board</button>
    </div>
  );
}

export function FinanceRoom() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/dashboard/rooms/finance').then((r) => setData(r.data)).catch((e) => setError(e instanceof Error ? e.message : 'Finance feed failed'));
  }, []);
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Skeleton rows={5} />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Finance cockpit</p>
          <h1>Cash, risk and books</h1>
          <p className="muted">Drill from a number to the document. Never a decorative chart.</p>
        </div>
        <button className="btn" onClick={() => navigate('/inbox')}>Approvals</button>
      </header>
      <div className="kpi-grid">
        <button className="kpi-card" onClick={() => navigate('/sales/invoices')}><span className="kpi-label">Month revenue</span><span className="kpi-value">{fmtMoney(data.revenue)}</span></button>
        <button className="kpi-card" onClick={() => navigate('/sales/invoices')}><span className="kpi-label">Receivables</span><span className="kpi-value">{fmtMoney(data.ar)}</span><span className="kpi-sub">{fmtNum(data.arOverdue)} overdue</span></button>
        <button className="kpi-card" onClick={() => navigate('/records/procurement/payments')}><span className="kpi-label">Payables</span><span className="kpi-value">{fmtMoney(data.ap)}</span></button>
        <button className="kpi-card" onClick={() => navigate('/records/finance/banks')}><span className="kpi-label">Cash position</span><span className="kpi-value">{fmtMoney(data.cash)}</span></button>
      </div>
      <section className="card card-pad">
        <h3 style={{ marginTop: 0 }}>Drill path</h3>
        <p className="muted">Profit → revenue → customer → invoice → payment. Or COGS → work order → material → supplier.</p>
        <div className="quick-actions">
          <button className="btn" onClick={() => navigate('/sales/invoices')}>Invoices</button>
          <button className="btn" onClick={() => navigate('/records/finance/journals')}>Journals</button>
          <button className="btn" onClick={() => navigate('/records/finance/budgets')}>Budgets</button>
        </div>
      </section>
    </div>
  );
}

export function OperatorFloor({ woId }: { woId?: number }) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [selected, setSelected] = useState<Rec | null>(null);
  const [qty, setQty] = useState('1');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<{ data: Rec[] }>('/api/production/work_orders?pageSize=50')
      .then((r) => {
        const live = r.data.filter((w) => ['RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'APPROVED'].includes(String(w.status)));
        setRows(live);
        if (woId) setSelected(live.find((w) => Number(w.id) === woId) ?? live[0] ?? null);
        else if (!selected) setSelected(live[0] ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'No work orders'));
  };

  useEffect(() => { load(); }, [woId]);

  const act = async (path: string, body: Rec = {}) => {
    if (!selected) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice('Recorded');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const id = Number(selected?.id);
  return (
    <div className="page operator-page">
      <header className="page-head">
        <div>
          <p className="muted" style={{ margin: 0, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 11, fontWeight: 700 }}>Operator floor</p>
          <h1>My work order</h1>
        </div>
        <button className="btn" onClick={() => navigate('/plant')}>Control room</button>
      </header>
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      {!selected && <EmptyState title="No released jobs" body="Wait for a planner to release a work order, or open the plant board." action="Plant board" onAction={() => navigate('/plant')} />}
      {selected && (
        <>
          <section className="card card-pad operator-card">
            <div className="cell-mono">{String(pick(selected, 'woNo', 'wo_no'))}</div>
            <h2 style={{ fontFamily: 'var(--serif)', margin: '8px 0' }}>{String(pick(selected, 'productName', 'product_name') ?? 'Work order')}</h2>
            <Badge value={pick(selected, 'status')} />
            <p className="muted">Target {fmtNum(pick(selected, 'quantity'))} · Produced {fmtNum(pick(selected, 'producedQty', 'produced_qty'))}</p>
            <label className="field">
              <span>Switch job</span>
              <select value={String(selected.id)} onChange={(e) => setSelected(rows.find((r) => String(r.id) === e.target.value) ?? selected)}>
                {rows.map((r) => <option key={String(r.id)} value={String(r.id)}>{String(pick(r, 'woNo', 'wo_no'))} · {String(r.status)}</option>)}
              </select>
            </label>
            <div className="field">
              <span>Quantity</span>
              <input className="op-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div className="op-grid">
              <button className="btn btn-primary" disabled={busy} onClick={() => act(`/api/ops/production/work-orders/${id}/start`)}>Start</button>
              <button className="btn" disabled={busy} onClick={() => act(`/api/ops/production/work-orders/${id}/hold`, { reason: 'Paused on floor' })}>Pause</button>
              <button className="btn" disabled={busy} onClick={() => act(`/api/ops/production/work-orders/${id}/output`, { outputType: 'GOOD', quantity: Number(qty) })}>Output</button>
              <button className="btn btn-warning" disabled={busy} onClick={() => act(`/api/ops/production/work-orders/${id}/output`, { outputType: 'WASTE', quantity: Number(qty) })}>Waste</button>
              <button className="btn" disabled={busy} onClick={() => navigate('/records/quality/inspections')}>QC</button>
              <button className="btn btn-success" disabled={busy} onClick={() => {
                if (window.confirm(`Complete ${String(pick(selected, 'woNo', 'wo_no'))}? This cannot be undone from the floor.`)) {
                  void act(`/api/ops/production/work-orders/${id}/complete`);
                }
              }}>Complete</button>
            </div>
            <button className="btn btn-block" style={{ marginTop: 12 }} onClick={() => navigate('/qr/scan')}>Scan QR</button>
          </section>
        </>
      )}
    </div>
  );
}
