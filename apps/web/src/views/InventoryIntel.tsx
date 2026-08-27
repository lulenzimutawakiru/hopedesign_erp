import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtDate, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';

type Rec = Record<string, unknown>;

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmtPct(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '-';
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function viewOf(path: string): { view: string; id: string | null } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'inventory-intel') return { view: 'command', id: null };
  return { view: parts[1] ?? 'command', id: parts[2] ?? null };
}

const TABS: { view: string; label: string; perm: string }[] = [
  { view: 'command', label: 'Command', perm: 'inventory.stock.view' },
  { view: 'positions', label: 'Stock', perm: 'inventory.stock.view' },
  { view: 'atp', label: 'ATP/CTP', perm: 'inventory.stock.view' },
  { view: 'fifo', label: 'FIFO/FEFO', perm: 'inventory.stock.view' },
  { view: 'putaway', label: 'Put-away', perm: 'inventory.stock.view' },
  { view: 'trace', label: 'Trace', perm: 'inventory.traceability.view' },
  { view: 'recalls', label: 'Recalls', perm: 'inventory.recalls.view' },
  { view: 'counts', label: 'Counts', perm: 'inventory.counts.view' },
  { view: 'reorder', label: 'Reorder', perm: 'inventory.reorder_recommendations.view' },
  { view: 'forecast', label: 'Forecast', perm: 'inventory.forecasts.view' },
  { view: 'valuation', label: 'Valuation', perm: 'inventory.valuations.view' },
  { view: 'abc', label: 'ABC/XYZ', perm: 'inventory.valuations.view' },
  { view: 'risk', label: 'Risk', perm: 'inventory.risk.view' },
  { view: 'quality', label: 'Data Q', perm: 'inventory.stock.view' },
  { view: 'alerts', label: 'Alerts', perm: 'inventory.alerts.view' },
  { view: 'map', label: 'Map', perm: 'inventory.warehouses.view' },
  { view: 'units', label: 'Units', perm: 'inventory.handling_units.view' },
  { view: 'kpis', label: 'KPIs', perm: 'inventory.stock.view' },
];

export default function InventoryIntel({ path }: { path: string }) {
  const { user } = useAuth();
  const { view, id } = viewOf(path);
  const visible = TABS.filter((t) => can(user, t.perm));
  const active = visible.some((t) => t.view === view) ? view : (visible[0]?.view ?? 'command');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="inv">Inventory intelligence</p>
          <h1>Inventory command center</h1>
          <p className="muted">
            Positions, batches, pallets and movements - traced, valued and controlled across every warehouse.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn btn-scan" onClick={() => navigate('/qr/scan')}>Scan</button>
          <button className="btn" onClick={() => navigate('/inventory/stock')}>Stock board</button>
          {can(user, 'inventory.transfers.create') && <button className="btn" onClick={() => navigate('/inventory/transfers/new')}>Transfer</button>}
          {can(user, 'inventory.adjustments.create') && <button className="btn" onClick={() => navigate('/inventory/adjustments/new')}>Count</button>}
        </div>
      </header>
      <div className="tabs" style={{ marginBottom: 16 }}>
        {visible.map((t) => (
          <button key={t.view} className={active === t.view ? 'tab active' : 'tab'} onClick={() => navigate(`/inventory-intel/${t.view}`)}>
            {t.label}
          </button>
        ))}
      </div>
      {active === 'command' && <CommandCenter />}
      {active === 'positions' && <StockPositions />}
      {active === 'atp' && <AtpCtp />}
      {active === 'fifo' && <FifoFefo />}
      {active === 'putaway' && <Putaway />}
      {active === 'trace' && <Traceability batchId={id ? Number(id) : null} />}
      {active === 'recalls' && <Recalls />}
      {active === 'counts' && <Counts />}
      {active === 'reorder' && <Reorder />}
      {active === 'forecast' && <Forecasts />}
      {active === 'valuation' && <Valuation />}
      {active === 'abc' && <AbcXyz />}
      {active === 'risk' && <Risk />}
      {active === 'quality' && <DataQuality />}
      {active === 'alerts' && <Alerts />}
      {active === 'map' && <MapView />}
      {active === 'units' && <HandlingUnits />}
      {active === 'kpis' && <Kpis />}
    </div>
  );
}

function useStockPositions() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/inventory-intel/stock-positions')
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Stock positions failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const products = useMemo(() => {
    const map = new Map<number, { productId: number; productCode: string; productName: string }>();
    for (const r of rows) {
      const pid = Number(r.productId);
      if (!pid || map.has(pid)) continue;
      map.set(pid, { productId: pid, productCode: str(r.productCode), productName: str(r.productName) });
    }
    return [...map.values()].sort((a, b) => a.productCode.localeCompare(b.productCode));
  }, [rows]);
  return { rows, products, error, reload: load };
}

function ProductSelect({ products, value, onChange, allLabel = 'All products' }: {
  products: { productId: number; productCode: string; productName: string }[];
  value: number | null;
  onChange: (v: number | null) => void;
  allLabel?: string;
}) {
  return (
    <select className="search-input" style={{ maxWidth: 280 }} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{allLabel}</option>
      {products.map((p) => (
        <option key={p.productId} value={p.productId}>{p.productCode} - {p.productName}</option>
      ))}
    </select>
  );
}

function CommandCenter() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/inventory-intel/command-center')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Command center failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Reading the warehouse..." />;
  const alerts = Array.isArray(data.alerts) ? (data.alerts as Rec[]) : [];
  const health: { label: string; value: number; view: string; tone: string }[] = [
    { label: 'Stockouts', value: num(data.stockoutLines ?? data.stockouts), view: 'positions', tone: 'card-warn' },
    { label: 'Low stock', value: num(data.lowStockLines ?? data.lowStock), view: 'reorder', tone: 'card-warn' },
    { label: 'Quality holds', value: num(data.qualityHolds), view: 'alerts', tone: 'card-warn' },
    { label: 'Large variances', value: num(data.largeVariances), view: 'counts', tone: '' },
    { label: 'Expiring batches', value: num(data.expiringBatches), view: 'trace', tone: 'card-warn' },
    { label: 'High risk items', value: num(data.highRiskItems), view: 'risk', tone: 'card-warn' },
  ];
  return (
    <>
      <div className="kpi-grid">
        <button className="kpi-card" onClick={() => navigate('/inventory-intel/valuation')}>
          <span className="kpi-label">On hand value</span>
          <span className="kpi-value">{fmtMoney(data.onHandValue)}</span>
          <span className="kpi-sub">{fmtNum(data.stockLines)} stock lines</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/inventory-intel/atp')}>
          <span className="kpi-label">Available value</span>
          <span className="kpi-value">{fmtMoney(data.availableValue)}</span>
          <span className="kpi-sub">Net of reservations, holds &amp; blocks</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/inventory-intel/positions')}>
          <span className="kpi-label">Reserved value</span>
          <span className="kpi-value">{fmtMoney(data.reservedValue)}</span>
          <span className="kpi-sub">Promised to orders &amp; production</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/inventory-intel/positions')}>
          <span className="kpi-label">In transit value</span>
          <span className="kpi-value">{fmtMoney(data.inTransitValue)}</span>
          <span className="kpi-sub">Moving between locations</span>
        </button>
      </div>
      <div className="kpi-grid">
        {health.map((h) => (
          <button key={h.label} className={`kpi-card ${h.tone}`} onClick={() => navigate(`/inventory-intel/${h.view}`)}>
            <span className="kpi-label">{h.label}</span>
            <span className="kpi-value">{fmtNum(h.value)}</span>
            <span className="kpi-sub">Click to drill down</span>
          </button>
        ))}
      </div>
      <div className="card card-pad">
        <div className="card-head" style={{ marginBottom: 8 }}><h3>Live alerts</h3></div>
        {alerts.length === 0 ? (
          <p className="muted">No open alerts. Stock health is stable.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Severity</th><th>Type</th><th>Title</th><th>Message</th><th>Status</th><th>Raised</th><th /></tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={String(a.id)}>
                    <td><Badge value={a.severity} /></td>
                    <td>{str(a.alertType).replace(/_/g, ' ')}</td>
                    <td>{str(a.title)}</td>
                    <td>{str(a.message)}</td>
                    <td><Badge value={a.status} /></td>
                    <td>{fmtDate(a.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn btn-sm" onClick={() => navigate('/inventory-intel/alerts')}>View</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function StockPositions() {
  const { rows, products, error, reload } = useStockPositions();
  const [productId, setProductId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (productId && Number(r.productId) !== productId) return false;
      if (!needle) return true;
      return [r.productCode, r.productName, r.warehouseCode, r.binCode, r.batchNo]
        .some((v) => str(v).toLowerCase().includes(needle));
    });
  }, [rows, productId, q]);
  const totals = useMemo(() => {
    let onHand = 0, available = 0, value = 0;
    for (const r of filtered) {
      onHand += num(r.onHandQty); available += num(r.availableQty); value += num(r.stockValue);
    }
    return { onHand, available, value };
  }, [filtered]);
  if (error && rows.length === 0) return <ErrorBanner error={error} />;
  return (
    <>
      <div className="toolbar">
        <input className="search-input" placeholder="Search product, warehouse, bin or batch..." value={q} onChange={(e) => setQ(e.target.value)} />
        <ProductSelect products={products} value={productId} onChange={setProductId} />
        <button className="btn btn-ghost" onClick={reload}>Refresh</button>
      </div>
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Lines</span><span className="kpi-value">{fmtNum(filtered.length)}</span><span className="kpi-sub">{fmtNum(totals.onHand)} units on hand</span></div>
        <div className="kpi-card"><span className="kpi-label">Available</span><span className="kpi-value">{fmtNum(totals.available)}</span><span className="kpi-sub">Net of reservations &amp; holds</span></div>
        <div className="kpi-card"><span className="kpi-label">Stock value</span><span className="kpi-value">{fmtMoney(totals.value)}</span><span className="kpi-sub">Weighted average cost</span></div>
      </div>
      {rows.length === 0 && !error ? <PageLoader label="Loading stock positions..." /> : (
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th><th>Warehouse</th><th>Bin</th><th>Batch</th>
                <th className="num">On hand</th><th className="num">Reserved</th><th className="num">Allocated</th>
                <th className="num">Available</th><th className="num">Q. hold</th><th className="num">Damaged</th>
                <th className="num">Blocked</th><th className="num">Avg cost</th><th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={String(r.id)}>
                  <td>
                    <div>{str(r.productName)}</div>
                    <div className="cell-mono">{str(r.productCode)}</div>
                  </td>
                  <td>{str(r.warehouseCode)}</td>
                  <td className="cell-mono">{str(r.binCode)}</td>
                  <td className="cell-mono">{str(r.batchNo)}</td>
                  <td className="num">{fmtNum(r.onHandQty)}</td>
                  <td className="num">{fmtNum(r.reservedQty)}</td>
                  <td className="num">{fmtNum(r.allocatedQty)}</td>
                  <td className="num"><strong>{fmtNum(r.availableQty)}</strong></td>
                  <td className="num">{fmtNum(r.qualityHoldQty)}</td>
                  <td className="num">{fmtNum(r.damagedQty)}</td>
                  <td className="num">{fmtNum(r.blockedQty)}</td>
                  <td className="num">{fmtMoney(r.avgCost)}</td>
                  <td className="num">{fmtMoney(r.stockValue)}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={13} className="muted">No stock positions match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
function AtpCtp() {
  const { products } = useStockPositions();
  const [productId, setProductId] = useState<number | null>(null);
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback((pid: number) => {
    setBusy(true);
    api<{ data: Rec }>(`/api/ops/inventory-intel/atp-ctp/${pid}`)
      .then((r) => { setData(r.data); setError(''); })
      .catch((e) => setError(e instanceof Error ? e.message : 'ATP/CTP failed'))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => {
    if (productId) load(productId);
  }, [productId, load]);
  const breakdown = (arr: unknown): Rec[] => (Array.isArray(arr) ? arr as Rec[] : []);
  return (
    <>
      <div className="toolbar">
        <ProductSelect products={products} value={productId} onChange={setProductId} allLabel="Select a product..." />
        {busy && <span className="muted">Calculating...</span>}
      </div>
      {error && <ErrorBanner error={error} />}
      {!productId && !error && <p className="muted">Pick a product to see what can be promised today and what production can still cover.</p>}
      {data && (
        <>
          <div className="kpi-grid">
            <div className="kpi-card"><span className="kpi-label">Available stock</span><span className="kpi-value">{fmtNum(data.available)}</span><span className="kpi-sub">{str((data.product as Rec | null)?.name)}</span></div>
            <div className="kpi-card"><span className="kpi-label">Incoming PO</span><span className="kpi-value">{fmtNum(data.incomingPurchaseOrders)}</span><span className="kpi-sub">{fmtNum(data.openPurchaseOrderCount)} open orders</span></div>
            <div className="kpi-card"><span className="kpi-label">Open sales demand</span><span className="kpi-value">{fmtNum(data.openSalesDemand)}</span><span className="kpi-sub">Unfilled customer demand</span></div>
            <div className="kpi-card"><span className="kpi-label">Planned production</span><span className="kpi-value">{fmtNum(data.plannedProduction)}</span><span className="kpi-sub">Open work orders</span></div>
          </div>
          <div className="kpi-grid">
            <button className={`kpi-card ${data.canFulfillCurrentDemand ? '' : 'card-warn'}`} onClick={() => navigate('/inventory-intel/atp')}>
              <span className="kpi-label">ATP - Available to promise</span>
              <span className="kpi-value">{fmtNum(data.atp)}</span>
              <span className="kpi-sub">{data.canFulfillCurrentDemand ? 'Current demand can be fulfilled' : 'Stock alone cannot cover demand'}</span>
            </button>
            <div className="kpi-card">
              <span className="kpi-label">CTP - Capable to promise</span>
              <span className="kpi-value">{fmtNum(data.ctp)}</span>
              <span className="kpi-sub">With planned production</span>
            </div>
          </div>
          <div className="kpi-grid">
            <div className="card card-pad">
              <div className="card-head" style={{ marginBottom: 8 }}><h3>ATP build-up</h3></div>
              <table className="data">
                <tbody>
                  {breakdown(data.atpBreakdown).map((b, i) => (
                    <tr key={i}><td>{str(b.label)}</td><td className="num">{fmtNum(b.qty)}</td></tr>
                  ))}
                  <tr><td><strong>ATP</strong></td><td className="num"><strong>{fmtNum(data.atp)}</strong></td></tr>
                </tbody>
              </table>
            </div>
            <div className="card card-pad">
              <div className="card-head" style={{ marginBottom: 8 }}><h3>CTP build-up</h3></div>
              <table className="data">
                <tbody>
                  {breakdown(data.ctpBreakdown).map((b, i) => (
                    <tr key={i}><td>{str(b.label)}</td><td className="num">{fmtNum(b.qty)}</td></tr>
                  ))}
                  <tr><td><strong>CTP</strong></td><td className="num"><strong>{fmtNum(data.ctp)}</strong></td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function FifoFefo() {
  const { products } = useStockPositions();
  const [productId, setProductId] = useState<number | null>(null);
  const [qty, setQty] = useState('');
  const [method, setMethod] = useState<'FIFO' | 'FEFO'>('FIFO');
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const run = () => {
    if (!productId || !num(qty)) return;
    setError('');
    api<{ data: Rec }>(`/api/ops/inventory-intel/fifo-suggestions?productId=${productId}&qty=${num(qty)}&method=${method}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Stock rotation failed'));
  };
  const lines = Array.isArray(data?.lines) ? (data.lines as Rec[]) : [];
  const plan = Array.isArray(data?.suggestedPlan) ? (data.suggestedPlan as Rec[]) : [];
  return (
    <>
      <div className="toolbar">
        <ProductSelect products={products} value={productId} onChange={setProductId} allLabel="Select a product..." />
        <input className="search-input" style={{ maxWidth: 140 }} placeholder="Qty" type="number" value={qty} onChange={(e) => setQty(e.target.value)} />
        <select className="search-input" style={{ maxWidth: 140 }} value={method} onChange={(e) => setMethod(e.target.value === 'FEFO' ? 'FEFO' : 'FIFO')}>
          <option value="FIFO">FIFO</option>
          <option value="FEFO">FEFO</option>
        </select>
        <button className="btn btn-primary" disabled={!productId || !num(qty)} onClick={run}>{method} suggest</button>
      </div>
      {error && <ErrorBanner error={error} />}
      {data && (
        <>
          <div className="kpi-grid">
            <div className="kpi-card"><span className="kpi-label">Rotation method</span><span className="kpi-value">{str(data.method)}</span><span className="kpi-sub">Requested {fmtNum(data.requestedQty)} units</span></div>
            <div className={data.fullyCovered ? 'kpi-card' : 'kpi-card card-warn'}>
              <span className="kpi-label">Coverage</span>
              <span className="kpi-value">{data.fullyCovered ? 'Fully covered' : 'Shortfall'}</span>
              <span className="kpi-sub">{fmtNum(data.shortfall)} units short</span>
            </div>
          </div>
          <div className="table-wrap card">
            <table className="data">
              <thead>
                <tr><th>Warehouse</th><th>Bin</th><th>Batch</th><th>Received</th><th>Expiry</th><th className="num">Available</th><th className="num">Suggested qty</th></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td>{str(l.warehouseCode)}</td>
                    <td className="cell-mono">{str(l.binCode)}</td>
                    <td className="cell-mono">{str(l.batchNo)}</td>
                    <td>{fmtDate(l.receivedAt)}</td>
                    <td>{l.expiryDate ? fmtDate(l.expiryDate) : '-'}</td>
                    <td className="num">{fmtNum(l.availableQty)}</td>
                    <td className="num"><strong>{fmtNum(l.suggestedQty)}</strong></td>
                  </tr>
                ))}
                {lines.length === 0 && <tr><td colSpan={7} className="muted">No batch candidates.</td></tr>}
              </tbody>
            </table>
          </div>
          {plan.length > 0 && (
            <div className="card card-pad">
              <div className="card-head" style={{ marginBottom: 8 }}><h3>Suggested picking plan</h3></div>
              {plan.map((p, i) => (
                <div key={i} className="muted" style={{ marginBottom: 4 }}>
                  {i + 1}. {str(p.warehouseCode)}-{str(p.binCode)} · {str(p.batchNo)} · {fmtNum(p.suggestedQty)}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

function Putaway() {
  const { products } = useStockPositions();
  const [productId, setProductId] = useState<number | null>(null);
  const [qty, setQty] = useState('');
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const run = () => {
    if (!productId) return;
    setError('');
    api<{ data: Rec }>(`/api/ops/inventory-intel/putaway-recommendations?productId=${productId}&qty=${num(qty) || ''}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Put-away planning failed'));
  };
  const recommended = Array.isArray(data?.recommended) ? (data.recommended as Rec[]) : [];
  const warehouses = Array.isArray(data?.warehouses) ? (data.warehouses as Rec[]) : [];
  const reasons = (r: Rec): unknown[] => (Array.isArray(r.reasons) ? r.reasons as unknown[] : []);
  return (
    <>
      <div className="toolbar">
        <ProductSelect products={products} value={productId} onChange={setProductId} allLabel="Select a product..." />
        <input className="search-input" style={{ maxWidth: 140 }} placeholder="Incoming qty" type="number" value={qty} onChange={(e) => setQty(e.target.value)} />
        <button className="btn btn-primary" disabled={!productId} onClick={run}>Recommend</button>
      </div>
      {error && <ErrorBanner error={error} />}
      {data && (
        <>
          <div className="kpi-grid">
            <div className="kpi-card"><span className="kpi-label">Product</span><span className="kpi-value">{str(data.product)}</span><span className="kpi-sub">Incoming {fmtNum(data.incomingQty)} units</span></div>
            <div className="kpi-card"><span className="kpi-label">Candidate locations</span><span className="kpi-value">{fmtNum(recommended.length)}</span><span className="kpi-sub">Ranked by score</span></div>
          </div>
          <div className="table-wrap card">
            <table className="data">
              <thead>
                <tr><th>Location</th><th className="num">Capacity</th><th className="num">Used</th><th className="num">Free</th><th className="num">Priority</th><th className="num">Score</th><th>Why</th></tr>
              </thead>
              <tbody>
                {recommended.map((r, i) => (
                  <tr key={i}>
                    <td className="cell-mono"><strong>{str(r.warehouseCode)}-{str(r.zoneCode)}-{str(r.rackCode)}-{str(r.binCode)}</strong></td>
                    <td className="num">{fmtNum(r.capacity)}</td>
                    <td className="num">{fmtNum(r.usedQty)}</td>
                    <td className="num">{fmtNum(r.availableQty)}</td>
                    <td className="num">{fmtNum(r.pickingPriority)}</td>
                    <td className="num"><strong>{fmtNum(r.score)}</strong></td>
                    <td>{reasons(r).map((reason) => (
                      <div key={str(reason)} className="muted" style={{ fontSize: 12 }}>✓ {str(reason)}</div>
                    ))}</td>
                  </tr>
                ))}
                {recommended.length === 0 && <tr><td colSpan={7} className="muted">No recommended locations.</td></tr>}
              </tbody>
            </table>
          </div>
          {warehouses.length > 0 && (
            <div className="table-wrap card">
              <table className="data">
                <thead>
                  <tr><th>Warehouse</th><th className="num">Capacity</th><th className="num">Used</th><th className="num">Utilization</th></tr>
                </thead>
                <tbody>
                  {warehouses.map((w, i) => (
                    <tr key={i}>
                      <td>{str(w.name)} <span className="cell-mono">({str(w.code)})</span></td>
                      <td className="num">{fmtNum(w.capacity)}</td>
                      <td className="num">{fmtNum(w.usedQty)}</td>
                      <td className="num">{fmtPct(w.utilizationPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
function Traceability({ batchId }: { batchId: number | null }) {
  const { rows } = useStockPositions();
  const [selected, setSelected] = useState<number | null>(batchId);
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const batches = useMemo(() => {
    const map = new Map<number, { batchId: number; batchNo: string; productCode: string }>();
    for (const r of rows) {
      const bid = Number(r.batchId);
      if (!bid || map.has(bid)) continue;
      map.set(bid, { batchId: bid, batchNo: str(r.batchNo), productCode: str(r.productCode) });
    }
    return [...map.values()].sort((a, b) => a.batchNo.localeCompare(b.batchNo));
  }, [rows]);
  const load = useCallback((id: number | null) => {
    if (!id) { setData(null); setError(''); return; }
    setError('');
    api<{ data: Rec }>(`/api/ops/inventory-intel/traceability/batch/${id}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Traceability graph failed'));
  }, []);
  useEffect(() => { load(selected); }, [selected, load]);
  const upstream = Array.isArray(data?.upstream) ? (data.upstream as Rec[]) : [];
  const downstream = Array.isArray(data?.downstream) ? (data.downstream as Rec[]) : [];
  const workOrders = Array.isArray(data?.workOrders) ? (data.workOrders as Rec[]) : [];
  const customers = Array.isArray(data?.customers) ? (data.customers as Rec[]) : [];
  const events = Array.isArray(data?.events) ? (data.events as Rec[]) : [];
  const batch = (data?.batch ?? null) as Rec | null;
  const mv = (m: Rec) => (
    <tr key={String(m.id)}>
      <td>{str(m.movementType).replace(/_/g, ' ')}</td>
      <td className="num">{fmtNum(m.quantity)}</td>
      <td className="cell-mono">{str(m.referenceCode) || '-'}</td>
      <td className="cell-mono">{str(m.warehouseCode)}{str(m.binCode) ? ` - ${str(m.binCode)}` : ''}</td>
      <td>{fmtDate(m.createdAt)}</td>
    </tr>
  );
  return (
    <>
      <div className="toolbar">
        <select className="search-input" style={{ maxWidth: 340 }} value={selected ?? ''} onChange={(e) => setSelected(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Select a batch to trace...</option>
          {batches.map((b) => (<option key={b.batchId} value={b.batchId}>{b.batchNo} - {b.productCode}</option>))}
        </select>
        <button className="btn btn-primary" disabled={!selected} onClick={() => load(selected)}>Trace</button>
      </div>
      {error && <ErrorBanner error={error} />}
      {!data && !error && <div className="card card-pad muted">Pick a batch to see its full lifecycle - supplier to customer.</div>}
      {data && batch && (
        <>
          <div className="kpi-grid">
            <div className="kpi-card"><span className="kpi-label">Batch</span><span className="kpi-value">{str(batch.batchNo)}</span><span className="kpi-sub">{str(batch.lotNo) || 'No lot'}</span></div>
            <div className="kpi-card"><span className="kpi-label">Supplier</span><span className="kpi-value">{str(batch.supplierName) || '-'}</span><span className="kpi-sub">Received {batch.receivedAt ? fmtDate(batch.receivedAt) : '-'}</span></div>
            <div className="kpi-card"><span className="kpi-label">Quantity</span><span className="kpi-value">{fmtNum(batch.quantity)}</span><span className="kpi-sub">Expiry {batch.expiryDate ? fmtDate(batch.expiryDate) : '-'}</span></div>
            <div className="kpi-card"><span className="kpi-label">Status</span><span className="kpi-value"><Badge value={batch.status} /></span><span className="kpi-sub">{str(batch.productName)}</span></div>
          </div>
          <div className="kpi-grid">
            <div className="card card-pad">
              <div className="card-head" style={{ marginBottom: 8 }}><h3>Origin &amp; receipts</h3></div>
              <table className="data">
                <thead><tr><th>Movement</th><th className="num">Qty</th><th>Reference</th><th>Location</th><th>Date</th></tr></thead>
                <tbody>{upstream.map(mv)}{upstream.length === 0 && <tr><td colSpan={5} className="muted">No inbound movements.</td></tr>}</tbody>
              </table>
            </div>
            <div className="card card-pad">
              <div className="card-head" style={{ marginBottom: 8 }}><h3>Consumption &amp; shipments</h3></div>
              <table className="data">
                <thead><tr><th>Movement</th><th className="num">Qty</th><th>Reference</th><th>Location</th><th>Date</th></tr></thead>
                <tbody>{downstream.map(mv)}{downstream.length === 0 && <tr><td colSpan={5} className="muted">No outbound movements.</td></tr>}</tbody>
              </table>
            </div>
          </div>
          <div className="card card-pad">
            <div className="card-head" style={{ marginBottom: 8 }}><h3>Work orders using this batch</h3></div>
            <table className="data">
              <thead><tr><th>Order</th><th>Output</th><th className="num">Qty</th><th className="num">Produced</th><th>Machine</th><th>Status</th><th>Completed</th></tr></thead>
              <tbody>
                {workOrders.map((w) => (
                  <tr key={String(w.id)}>
                    <td className="cell-mono">{str(w.woNo)}</td>
                    <td>{str(w.outputName)} <span className="cell-mono">({str(w.outputCode)})</span></td>
                    <td className="num">{fmtNum(w.quantity)}</td>
                    <td className="num">{fmtNum(w.producedQty)}</td>
                    <td className="cell-mono">{str(w.machineCode) || '-'}</td>
                    <td><Badge value={w.status} /></td>
                    <td>{w.completedAt ? fmtDate(w.completedAt) : '-'}</td>
                  </tr>
                ))}
                {workOrders.length === 0 && <tr><td colSpan={7} className="muted">Not used by any work order.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card card-pad">
            <div className="card-head" style={{ marginBottom: 8 }}><h3>Customers reached</h3></div>
            <table className="data">
              <thead><tr><th>Order</th><th>Customer</th><th>Delivery</th><th>Status</th></tr></thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={String(c.salesOrderId)}>
                    <td className="cell-mono">{str(c.orderNo)}</td>
                    <td>{str(c.customerName)}</td>
                    <td>{c.deliveryDate ? fmtDate(c.deliveryDate) : '-'}</td>
                    <td><Badge value={c.status} /></td>
                  </tr>
                ))}
                {customers.length === 0 && <tr><td colSpan={4} className="muted">No customer deliveries from this batch.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card card-pad">
            <div className="card-head" style={{ marginBottom: 8 }}><h3>EPCIS traceability events</h3></div>
            <table className="data">
              <thead><tr><th>Event</th><th>Action</th><th>Biz step</th><th>Disposition</th><th>Device</th><th>Recorded by</th><th>Time</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={String(e.id)}>
                    <td className="cell-mono">{str(e.eventType)}</td>
                    <td>{str(e.action)}</td>
                    <td>{str(e.bizStep) || '-'}</td>
                    <td>{str(e.disposition) || '-'}</td>
                    <td className="cell-mono">{str(e.device) || '-'}</td>
                    <td>{str(e.recordedByEmail) || '-'}</td>
                    <td>{fmtDate(e.eventTime)}</td>
                  </tr>
                ))}
                {events.length === 0 && <tr><td colSpan={7} className="muted">No EPCIS-style events recorded.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
function Recalls() {
  const { products } = useStockPositions();
  const [productId, setProductId] = useState<number | null>(null);
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [severity, setSeverity] = useState('MAJOR');
  const [quarantineAll, setQuarantineAll] = useState(true);
  const [created, setCreated] = useState<Rec | null>(null);
  const load = useCallback(() => {
    setError('');
    api<{ data: Rec }>(`/api/ops/inventory-intel/recalls/engine${productId ? `?productId=${productId}` : ''}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Recall engine failed'));
  }, [productId]);
  useEffect(() => { load(); }, [load]);
  const batches = Array.isArray(data?.batches) ? (data.batches as Rec[]) : [];
  const movements = (b: Rec): unknown[] => (Array.isArray(b.recentMovements) ? b.recentMovements as unknown[] : []);
  const create = () => {
    if (!reason.trim()) return;
    setError('');
    api<{ data: Rec }>('/api/ops/inventory-intel/recalls', {
      method: 'POST',
      body: JSON.stringify({ reason: reason.trim(), productId, severity, quarantineAll }),
    })
      .then((r) => setCreated(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Recall creation failed'));
  };
  return (
    <>
      <div className="toolbar">
        <ProductSelect products={products} value={productId} onChange={setProductId} allLabel="All products" />
        <button className="btn btn-primary" onClick={load}>Find affected batches</button>
      </div>
      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <div className="card-head" style={{ marginBottom: 8 }}><h3>Launch recall</h3></div>
        <div className="toolbar">
          <input className="search-input" style={{ flex: 1, maxWidth: 420 }} placeholder="Recall reason (required) - e.g. defective raw material batch" value={reason} onChange={(e) => setReason(e.target.value)} />
          <select className="search-input" style={{ maxWidth: 130 }} value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="MINOR">Minor</option>
            <option value="MAJOR">Major</option>
            <option value="CRITICAL">Critical</option>
          </select>
          <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={quarantineAll} onChange={(e) => setQuarantineAll(e.target.checked)} />
            Quarantine all affected
          </label>
          <button className="btn btn-primary" disabled={!reason.trim()} onClick={create}>Issue recall</button>
        </div>
        {created && (
          <div className="kpi-grid" style={{ marginTop: 10 }}>
            <div className="kpi-card"><span className="kpi-label">Recall</span><span className="kpi-value">{str(created.recallNo)}</span><span className="kpi-sub">{str(created.status)}</span></div>
            <div className="kpi-card"><span className="kpi-label">Linked batches</span><span className="kpi-value">{fmtNum(created.linkedBatches)}</span><span className="kpi-sub">Quarantine {created.quarantineAll ? 'enabled' : 'manual'}</span></div>
          </div>
        )}
      </div>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr><th>Batch</th><th>Product</th><th>Supplier</th><th>Received</th><th className="num">On hand</th><th className="num">In transit</th><th className="num">WIP</th><th className="num">Q. hold</th><th className="num">With customers</th><th>Recent movements</th></tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={String(b.batchId)}>
                <td className="cell-mono"><strong>{str(b.batchNo)}</strong></td>
                <td>{str(b.productName)} <span className="cell-mono">({str(b.productCode)})</span></td>
                <td>{str(b.supplierName) || '-'}</td>
                <td>{b.receivedAt ? fmtDate(b.receivedAt) : '-'}</td>
                <td className="num">{fmtNum(b.onHandQty)}</td>
                <td className="num">{fmtNum(b.inTransitQty)}</td>
                <td className="num">{fmtNum(b.wipQty)}</td>
                <td className="num">{fmtNum(b.qualityHoldQty)}</td>
                <td className="num"><strong>{fmtNum(b.withCustomersQty)}</strong></td>
                <td>
                  {movements(b).slice(0, 3).map((m, i) => {
                    const r = m as Rec;
                    return <div key={i} className="muted" style={{ fontSize: 12 }}>{str(r.movementType).replace(/_/g, ' ')} {fmtNum(r.quantity)} {str(r.referenceCode) ? `- ${str(r.referenceCode)}` : ''}</div>;
                  })}
                  {movements(b).length === 0 && <span className="muted">-</span>}
                </td>
              </tr>
            ))}
            {batches.length === 0 && <tr><td colSpan={10} className="muted">No affected batches found.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
function Counts() {
  const [warehouses, setWarehouses] = useState<Rec[]>([]);
  const [whId, setWhId] = useState<number | null>(null);
  const [countId, setCountId] = useState<number | null>(null);
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inputs, setInputs] = useState<Record<number, string>>({});
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/warehouses')
      .then((r) => setWarehouses(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Warehouses failed'));
  }, []);
  const loadDetail = useCallback((id: number) => {
    setError('');
    api<{ data: Rec }>(`/api/ops/inventory-intel/counts/${id}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Count detail failed'));
  }, []);
  const schedule = () => {
    if (!whId) return;
    setBusy(true); setError('');
    api<{ data: Rec }>('/api/ops/inventory-intel/counts', { method: 'POST', body: JSON.stringify({ warehouseId: whId }) })
      .then((r) => { const cid = Number(r.data.countId); setCountId(cid); if (cid) loadDetail(cid); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Scheduling count failed'))
      .finally(() => setBusy(false));
  };
  const act = (path: string, body?: unknown) => {
    if (!countId) return;
    setBusy(true); setError('');
    api<{ data: Rec }>(`/api/ops/inventory-intel/counts/${countId}/${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
      .then(() => loadDetail(countId))
      .catch((e) => setError(e instanceof Error ? e.message : 'Count action failed'))
      .finally(() => setBusy(false));
  };
  const count = (data?.count ?? null) as Rec | null;
  const lines = Array.isArray(data?.lines) ? (data.lines as Rec[]) : [];
  const blind = count ? Boolean(count.isBlind) : true;
  const matched = lines.filter((l) => l.status === 'MATCH').length;
  const variance = lines.filter((l) => l.status === 'VARIANCE' || l.status === 'REVIEWED').length;
  return (
    <>
      <div className="toolbar">
        <select className="search-input" style={{ maxWidth: 300 }} value={whId ?? ''} onChange={(e) => setWhId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Select warehouse...</option>
          {warehouses.map((w) => (<option key={String(w.id)} value={String(w.id)}>{str(w.name)} ({str(w.code)})</option>))}
        </select>
        <button className="btn btn-primary" disabled={!whId || busy} onClick={schedule}>Schedule blind count</button>
        {data && count && (
          <>
            <span className="muted">Count <strong className="cell-mono">{str(count.countNo)}</strong></span>
            <Badge value={count.status} />
          </>
        )}
      </div>
      {error && <ErrorBanner error={error} />}
      {!data && !error && <div className="card card-pad muted">Schedule a count to generate blind count tasks for a warehouse.</div>}
      {data && count && (
        <>
          <div className="kpi-grid">
            <div className="kpi-card"><span className="kpi-label">Lines</span><span className="kpi-value">{fmtNum(lines.length)}</span><span className="kpi-sub">Warehouse {str(count.warehouseCode)}</span></div>
            <div className="kpi-card"><span className="kpi-label">Matched</span><span className="kpi-value">{fmtNum(matched)}</span><span className="kpi-sub">No variance</span></div>
            <div className="kpi-card card-warn"><span className="kpi-label">Variance</span><span className="kpi-value">{fmtNum(variance)}</span><span className="kpi-sub">Need second count / review</span></div>
            <div className="kpi-card"><span className="kpi-label">Blind count</span><span className="kpi-value">{count.isBlind ? 'Yes' : 'No'}</span><span className="kpi-sub">System qty hidden until entered</span></div>
          </div>
          <div className="table-wrap card">
            <table className="data">
              <thead>
                <tr><th>Product</th><th>Batch</th><th>Bin</th><th className="num">System</th><th className="num">1st count</th><th className="num">2nd count</th><th className="num">Variance</th><th>Status</th><th>Action</th></tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={String(l.id)}>
                    <td>{str(l.productName)} <span className="cell-mono">({str(l.productCode)})</span></td>
                    <td className="cell-mono">{str(l.batchNo) || '-'}</td>
                    <td className="cell-mono">{str(l.binCode) || '-'}</td>
                    <td className="num">{blind && l.status === 'PENDING' ? '•••' : fmtNum(l.systemQty)}</td>
                    <td className="num">{l.countedQty != null ? fmtNum(l.countedQty) : '-'}</td>
                    <td className="num">{l.secondCountQty != null ? fmtNum(l.secondCountQty) : '-'}</td>
                    <td className="num">{l.varianceQty != null ? fmtNum(l.varianceQty) : '-'}</td>
                    <td><Badge value={l.status} /></td>
                    <td>
                      {l.status === 'PENDING' && (
                        <span className="toolbar" style={{ gap: 4 }}>
                          <input className="search-input" style={{ maxWidth: 90 }} type="number" placeholder="Counted" value={inputs[Number(l.id)] ?? ''} onChange={(e) => setInputs((p) => ({ ...p, [Number(l.id)]: e.target.value }))} />
                          <button className="btn btn-sm" disabled={busy || !(inputs[Number(l.id)] ?? '').trim()} onClick={() => act('enter', { lineId: Number(l.id), countedQty: num(inputs[Number(l.id)]) })}>Enter</button>
                        </span>
                      )}
                      {l.status === 'VARIANCE' && (
                        <span className="toolbar" style={{ gap: 4 }}>
                          <input className="search-input" style={{ maxWidth: 90 }} type="number" placeholder="2nd count" value={inputs[Number(l.id)] ?? ''} onChange={(e) => setInputs((p) => ({ ...p, [Number(l.id)]: e.target.value }))} />
                          <button className="btn btn-sm" disabled={busy || !(inputs[Number(l.id)] ?? '').trim()} onClick={() => act('review', { lineId: Number(l.id), secondCountQty: num(inputs[Number(l.id)]) })}>Review</button>
                        </span>
                      )}
                      {(l.status === 'MATCH' || l.status === 'REVIEWED' || l.status === 'ADJUSTED') && <span className="muted">-</span>}
                    </td>
                  </tr>
                ))}
                {lines.length === 0 && <tr><td colSpan={9} className="muted">No count lines for this warehouse.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="toolbar" style={{ marginTop: 10 }}>
            {count.status !== 'APPROVED' && count.status !== 'POSTED' && (
              <button className="btn" disabled={busy} onClick={() => act('approve')}>Approve count</button>
            )}
            {count.status === 'APPROVED' && (
              <button className="btn btn-primary" disabled={busy} onClick={() => act('post')}>Post adjustments</button>
            )}
            {count.status === 'POSTED' && <span className="muted">Count posted - variance adjustments applied.</span>}
          </div>
        </>
      )}
    </>
  );
}
function Reorder() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    api<{ data: Rec }>('/api/ops/inventory-intel/reorder')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Reorder recommendations failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Calculating reorder points..." />;
  const rows = Array.isArray(data.recommendations) ? (data.recommendations as Rec[]) : [];
  const warn = (r: Rec) => num(r.available) < num(r.reorderPoint);
  return (
    <>
      <div className="toolbar">
        <span className="muted">Smart replenishment - {fmtNum(data.count)} recommendations generated</span>
        <button className="btn btn-ghost" onClick={load}>Refresh</button>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr><th>Product</th><th className="num">Available</th><th className="num">Reorder point</th><th className="num">Safety stock</th><th className="num">Lead time</th><th className="num">Forecast demand</th><th className="num">Monthly issues</th><th className="num">Recommend</th><th>Order type</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.productId)} className={warn(r) ? 'row-warn' : undefined}>
                <td>{str(r.productName)} <span className="cell-mono">({str(r.productCode)})</span></td>
                <td className="num">{fmtNum(r.available)}</td>
                <td className="num">{fmtNum(r.reorderPoint)}</td>
                <td className="num">{fmtNum(r.safetyStock)}</td>
                <td className="num">{fmtNum(r.leadTimeDays)} d</td>
                <td className="num">{fmtNum(r.demandForecast)}</td>
                <td className="num">{fmtNum(r.monthlyIssues)}</td>
                <td className="num"><strong>{fmtNum(r.recommendedQty)}</strong></td>
                <td><Badge value={r.suggestedOrderType} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted">No reorder recommendations right now.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Forecasts() {
  const [horizon, setHorizon] = useState('30');
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const load = useCallback((days: string) => {
    setError('');
    api<{ data: Rec }>(`/api/ops/inventory-intel/forecasts?horizonDays=${days || ''}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Forecast failed'));
  }, []);
  useEffect(() => { load(horizon); }, [horizon, load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Projecting demand..." />;
  const rows = Array.isArray(data.forecasts) ? (data.forecasts as Rec[]) : [];
  return (
    <>
      <div className="toolbar">
        <span className="muted">Horizon:</span>
        <select className="search-input" style={{ maxWidth: 120 }} value={horizon} onChange={(e) => setHorizon(e.target.value)}>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
          <option value="60">60 days</option>
          <option value="90">90 days</option>
        </select>
        <span className="muted">{fmtNum(data.count)} products projected</span>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr><th>Product</th><th className="num">Forecast qty</th><th className="num">Avg daily issue</th><th className="num">Available</th><th className="num">Stockout in</th><th className="num">Confidence</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const days = r.stockoutInDays != null ? Number(r.stockoutInDays) : null;
              return (
                <tr key={String(r.productId)} className={days != null && days <= 30 ? 'row-warn' : undefined}>
                  <td>{str(r.productName)} <span className="cell-mono">({str(r.productCode)})</span></td>
                  <td className="num">{fmtNum(r.forecastQty)}</td>
                  <td className="num">{fmtNum(r.avgDailyIssue)}</td>
                  <td className="num">{fmtNum(r.available)}</td>
                  <td className="num">{days != null ? `${days} days` : '-'}</td>
                  <td className="num">{r.confidence != null ? fmtPct(num(r.confidence) * 100) : '-'}</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No forecast data yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card card-pad muted" style={{ fontSize: 13 }}>
        Forecasts are demand-driven estimates from historical issues. Underlying assumptions can be overridden by planners in the planning cycle.
      </div>
    </>
  );
}
function Valuation() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [lcId, setLcId] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError('');
    api<{ data: Rec }>('/api/ops/inventory-intel/valuations')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Valuation failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const allocate = () => {
    if (!lcId.trim()) return;
    setBusy(true); setError('');
    api<{ data: Rec }>(`/api/ops/inventory-intel/landed-costs/${num(lcId)}/allocate`, { method: 'POST' })
      .then(() => { setLcId(''); load(); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Landed cost allocation failed'))
      .finally(() => setBusy(false));
  };
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Valuing inventory..." />;
  const snapshot = Array.isArray(data.snapshot) ? (data.snapshot as Rec[]) : [];
  return (
    <>
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Total inventory value</span><span className="kpi-value">{fmtMoney(data.totalValue)}</span><span className="kpi-sub">{str(data.valuationNo)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Total quantity</span><span className="kpi-value">{fmtNum(data.totalQty)}</span><span className="kpi-sub">{str(data.currency)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Method</span><span className="kpi-value">{str(data.valuationMethod).replace(/_/g, ' ')}</span><span className="kpi-sub">Valued {data.valuationDate ? fmtDate(data.valuationDate) : '-'}</span></div>
      </div>
      <div className="toolbar" style={{ marginBottom: 10 }}>
        <span className="muted">Allocate approved landed cost by ID:</span>
        <input className="search-input" style={{ maxWidth: 160 }} type="number" placeholder="Landed cost ID" value={lcId} onChange={(e) => setLcId(e.target.value)} />
        <button className="btn btn-sm" disabled={busy || !lcId.trim()} onClick={allocate}>Allocate</button>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr><th>Product</th><th className="num">Qty</th><th className="num">Avg cost</th><th className="num">Value</th></tr>
          </thead>
          <tbody>
            {snapshot.map((s) => (
              <tr key={String(s.productId)}>
                <td>{str(s.productName)} <span className="cell-mono">({str(s.productCode)})</span></td>
                <td className="num">{fmtNum(s.qty)}</td>
                <td className="num">{fmtMoney(s.avgCost)}</td>
                <td className="num"><strong>{fmtMoney(s.value)}</strong></td>
              </tr>
            ))}
            {snapshot.length === 0 && <tr><td colSpan={4} className="muted">No stock to value.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AbcXyz() {
  const { products } = useStockPositions();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    api<{ data: Rec }>('/api/ops/inventory-intel/abc-xyz')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'ABC/XYZ analysis failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Classifying inventory..." />;
  const rows = Array.isArray(data.classifications) ? (data.classifications as Rec[]) : [];
  const names = new Map<number, { code: string; name: string }>();
  for (const p of products) names.set(p.productId, { code: p.productCode, name: p.productName });
  return (
    <>
      <div className="toolbar">
        <span className="muted">ABC by annual usage value / XYZ by demand variability - {fmtNum(data.products)} products, {fmtMoney(data.totalValue)} annual usage</span>
        <button className="btn btn-ghost" onClick={load}>Refresh</button>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr><th>Product</th><th>ABC</th><th>XYZ</th><th>Class</th><th className="num">Annual usage value</th><th className="num">Demand CV</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const meta = names.get(Number(r.productId));
              const abc = str(r.abcClass);
              const xyz = str(r.xyzClass);
              return (
                <tr key={String(r.productId)}>
                  <td>{meta ? meta.name : `Product #${str(r.productId)}`} <span className="cell-mono">{meta ? `(${meta.code})` : ''}</span></td>
                  <td><Badge value={abc} /></td>
                  <td><Badge value={xyz} /></td>
                  <td><Badge value={`${abc}${xyz}`} /></td>
                  <td className="num">{fmtMoney(r.annualUsageValue)}</td>
                  <td className="num">{fmtPct(num(r.cv) * 100)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No usage history to classify yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
function Risk() {
  const { products } = useStockPositions();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    api<{ data: Rec }>('/api/ops/inventory-intel/risk')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Risk scoring failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Scoring inventory risk..." />;
  const scores = Array.isArray(data.scores) ? (data.scores as Rec[]) : [];
  const summary = Array.isArray(data.summary) ? (data.summary as Rec[]) : [];
  const names = new Map<number, { code: string; name: string }>();
  for (const p of products) names.set(p.productId, { code: p.productCode, name: p.productName });
  const factors = (r: Rec): Rec => (r.factors && typeof r.factors === 'object' ? r.factors as Rec : {});
  return (
    <>
      <div className="kpi-grid">
        {(['HIGH', 'MEDIUM', 'LOW'] as const).map((lvl) => {
          const row = summary.find((s) => str(s.riskLevel) === lvl);
          return (
            <div key={lvl} className={lvl === 'HIGH' ? 'kpi-card card-warn' : 'kpi-card'}>
              <span className="kpi-label">{lvl} risk items</span>
              <span className="kpi-value">{fmtNum(row?.n ?? 0)}</span>
              <span className="kpi-sub">Scored {fmtDate(data.scoredAt)}</span>
            </div>
          );
        })}
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr><th>Product</th><th>Risk</th><th className="num">Score</th><th className="num">Manual adjustments</th><th className="num">After-hours</th><th className="num">Negative variances</th></tr>
          </thead>
          <tbody>
            {scores.map((r) => {
              const meta = names.get(Number(r.productId));
              const f = factors(r);
              return (
                <tr key={String(r.productId)}>
                  <td>{meta ? meta.name : `Product #${str(r.productId)}`} <span className="cell-mono">{meta ? `(${meta.code})` : ''}</span></td>
                  <td><Badge value={r.riskLevel} /></td>
                  <td className="num"><strong>{fmtNum(r.score)}</strong></td>
                  <td className="num">{fmtNum(f.manualAdjustments)}</td>
                  <td className="num">{fmtNum(f.afterHoursAdjustments)}</td>
                  <td className="num">{fmtNum(f.negativeVarianceEvents)}</td>
                </tr>
              );
            })}
            {scores.length === 0 && <tr><td colSpan={6} className="muted">No risk events in the last 30 days.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DataQuality() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    api<{ data: Rec }>('/api/ops/inventory-intel/data-quality')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Data quality scan failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Scanning master data..." />;
  const issues = Array.isArray(data.issues) ? (data.issues as Rec[]) : [];
  const population = (data.population && typeof data.population === 'object' ? data.population as Rec : {});
  return (
    <>
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Master data quality</span><span className="kpi-value">{fmtPct(data.score)}</span><span className="kpi-sub">{fmtNum(data.totalChecked)} checks run</span></div>
        <div className="kpi-card card-warn"><span className="kpi-label">Violations</span><span className="kpi-value">{fmtNum(data.violations)}</span><span className="kpi-sub">Across {issues.length} rule families</span></div>
        <div className="kpi-card"><span className="kpi-label">Population</span><span className="kpi-value">{fmtNum(population.products)}</span><span className="kpi-sub">{fmtNum(population.inventoryLines)} stock lines</span></div>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr><th>Rule</th><th>Issue</th><th className="num">Count</th><th className="num">Population</th><th className="num">Error rate</th></tr>
          </thead>
          <tbody>
            {issues.map((i) => (
              <tr key={str(i.code)}>
                <td className="cell-mono">{str(i.code)}</td>
                <td>{str(i.label)}</td>
                <td className="num">{fmtNum(i.count)}</td>
                <td className="num">{fmtNum(i.population)}</td>
                <td className="num">{num(i.population) > 0 ? fmtPct((num(i.count) / num(i.population)) * 100) : '-'}</td>
              </tr>
            ))}
            {issues.length === 0 && <tr><td colSpan={5} className="muted">No data quality violations found.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
const ALERT_TYPES = ['STOCKOUT', 'LOW_STOCK', 'OVERSTOCK', 'EXPIRY', 'QUALITY_HOLD', 'VARIANCE', 'SYNC_FAILED',
  'PENDING_APPROVAL', 'DELAYED_RECEIVING', 'DELAYED_PUTAWAY', 'DELAYED_PICKING', 'CAPACITY',
  'SUSPICIOUS_ADJUSTMENT', 'DATA_QUALITY'];

function Alerts() {
  const { products } = useStockPositions();
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [warehouses, setWarehouses] = useState<Rec[]>([]);
  const [form, setForm] = useState({ alertType: 'LOW_STOCK', severity: 'WARNING', title: '', message: '', productId: '', warehouseId: '' });
  const load = useCallback((st: string) => {
    setError('');
    api<{ data: Rec[] }>(`/api/ops/inventory-intel/alerts${st ? `?status=${st}` : ''}`)
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Alerts failed'));
  }, []);
  useEffect(() => { load(status); }, [status, load]);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/warehouses')
      .then((r) => setWarehouses(Array.isArray(r.data) ? r.data : []))
      .catch(() => undefined);
  }, []);
  const post = (id: number, action: 'acknowledge' | 'resolve') => {
    api<{ data: Rec }>(`/api/ops/inventory-intel/alerts/${id}/${action}`, { method: 'POST' })
      .then(() => load(status))
      .catch((e) => setError(e instanceof Error ? e.message : 'Alert action failed'));
  };
  const create = () => {
    if (!form.title.trim()) return;
    setError('');
    api<{ data: Rec }>('/api/ops/inventory-intel/alerts', {
      method: 'POST',
      body: JSON.stringify({
        alertType: form.alertType, severity: form.severity, title: form.title.trim(),
        message: form.message.trim() || undefined,
        productId: form.productId ? Number(form.productId) : null,
        warehouseId: form.warehouseId ? Number(form.warehouseId) : null,
      }),
    })
      .then(() => { setForm((f) => ({ ...f, title: '', message: '' })); load(''); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Alert creation failed'));
  };
  return (
    <>
      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <div className="card-head" style={{ marginBottom: 8 }}><h3>Raise alert</h3></div>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 6 }}>
          <select className="search-input" style={{ maxWidth: 190 }} value={form.alertType} onChange={(e) => setForm((f) => ({ ...f, alertType: e.target.value }))}>
            {ALERT_TYPES.map((t) => (<option key={t} value={t}>{t.replace(/_/g, ' ')}</option>))}
          </select>
          <select className="search-input" style={{ maxWidth: 120 }} value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}>
            <option value="INFO">Info</option>
            <option value="WARNING">Warning</option>
            <option value="CRITICAL">Critical</option>
          </select>
          <ProductSelect products={products} value={form.productId ? Number(form.productId) : null} onChange={(v) => setForm((f) => ({ ...f, productId: v ? String(v) : '' }))} allLabel="Product (optional)" />
          <select className="search-input" style={{ maxWidth: 200 }} value={form.warehouseId} onChange={(e) => setForm((f) => ({ ...f, warehouseId: e.target.value }))}>
            <option value="">Warehouse (optional)</option>
            {warehouses.map((w) => (<option key={String(w.id)} value={String(w.id)}>{str(w.name)}</option>))}
          </select>
          <input className="search-input" style={{ maxWidth: 240 }} placeholder="Title (required)" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          <input className="search-input" style={{ maxWidth: 300 }} placeholder="Message" value={form.message} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} />
          <button className="btn btn-primary" disabled={!form.title.trim()} onClick={create}>Raise</button>
        </div>
      </div>
      <div className="toolbar">
        <select className="search-input" style={{ maxWidth: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="OPEN">Open</option>
          <option value="ACKNOWLEDGED">Acknowledged</option>
          <option value="RESOLVED">Resolved</option>
        </select>
        <span className="muted">{fmtNum(rows.length)} alerts</span>
        <button className="btn btn-ghost" onClick={() => load(status)}>Refresh</button>
      </div>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr><th>Severity</th><th>Type</th><th>Product</th><th>Warehouse</th><th>Batch</th><th>Title / message</th><th>Status</th><th>Created</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={String(a.id)}>
                <td><Badge value={a.severity} /></td>
                <td>{str(a.alertType).replace(/_/g, ' ')}</td>
                <td>{str(a.productCode) || '-'}</td>
                <td>{str(a.warehouseCode) || '-'}</td>
                <td className="cell-mono">{str(a.batchNo) || '-'}</td>
                <td>
                  <div>{str(a.title)}</div>
                  {str(a.message) && <div className="muted" style={{ fontSize: 12 }}>{str(a.message)}</div>}
                </td>
                <td><Badge value={a.status} /></td>
                <td>{fmtDate(a.createdAt)}</td>
                <td>
                  <div className="row-actions">
                    {a.status === 'OPEN' && <button className="btn btn-sm" onClick={() => post(Number(a.id), 'acknowledge')}>Ack</button>}
                    {a.status !== 'RESOLVED' && <button className="btn btn-sm" onClick={() => post(Number(a.id), 'resolve')}>Resolve</button>}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted">No alerts match.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
function MapView() {
  const [warehouses, setWarehouses] = useState<Rec[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [map, setMap] = useState<Rec | null>(null);
  const [selected, setSelected] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/warehouses')
      .then((r) => {
        const list = Array.isArray(r.data) ? r.data : [];
        setWarehouses(list);
        if (list.length && !warehouseId) setWarehouseId(String(list[0].id));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Warehouse list failed'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const loadMap = useCallback((id: string) => {
    if (!id) return;
    setSelected(null);
    setError('');
    api<{ data: Rec }>(`/api/ops/inventory-intel/warehouse-map/${id}`)
      .then((r) => setMap(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Warehouse map failed'));
  }, []);
  useEffect(() => { if (warehouseId) loadMap(warehouseId); }, [warehouseId, loadMap]);
  const zones = map && Array.isArray(map.zones) ? (map.zones as Rec[]) : [];
  const binTone = (b: Rec): string => {
    if (num(b.isBlocked)) return '#7f1d1d';
    if (str(b.temperatureAlert)) return '#92400e';
    const cap = num(b.capacityQty);
    const qty = num(b.qty);
    if (!cap) return '#d1d5db';
    const util = qty / cap;
    if (util >= 0.9) return '#b91c1c';
    if (util >= 0.7) return '#d97706';
    return '#15803d';
  };
  return (
    <>
      <div className="toolbar">
        <select className="search-input" style={{ maxWidth: 280 }} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
          <option value="">Select warehouse</option>
          {warehouses.map((w) => (<option key={String(w.id)} value={String(w.id)}>{str(w.code)} - {str(w.name)}</option>))}
        </select>
        {map && (
          <span className="muted">
            {str((map.warehouse as Rec | null)?.name ?? '')} - {fmtPct(map.utilizationPct)} utilized
          </span>
        )}
        <button className="btn btn-ghost" onClick={() => loadMap(warehouseId)}>Refresh</button>
      </div>
      {error && <ErrorBanner error={error} />}
      {!map && !error && <PageLoader label="Loading warehouse map..." />}
      {map && (
        <div className="warehouse-map">
          {zones.map((z) => (
            <div key={String(z.id)} className="card card-pad" style={{ marginBottom: 12 }}>
              <div className="card-head">
                <div>
                  <strong>{str(z.code)} - {str(z.name)}</strong>
                  <span className="muted" style={{ marginLeft: 8 }}>
                    {str(z.type)}
                    {z.tempMinC !== undefined && z.tempMaxC !== undefined && ` - ${num(z.tempMinC)}..${num(z.tempMaxC)}°C`}
                    {str(z.hazardClass) && ` - hazard ${str(z.hazardClass)}`}
                  </span>
                </div>
                {num(z.isBlocked) > 0 && <Badge value="Blocked" />}
              </div>
              {Array.isArray(z.racks) && (z.racks as Rec[]).map((rack) => (
                <div key={String(rack.id)} style={{ marginBottom: 8 }}>
                  <div className="muted" style={{ fontSize: 12 }}>{str(rack.code)}{str(rack.aisleCode) && ` / aisle ${str(rack.aisleCode)}`}</div>
                  {Array.isArray(rack.shelves) && (rack.shelves as Rec[]).map((shelf) => (
                    <div key={String(shelf.id)} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                      <span className="muted" style={{ fontSize: 11, width: 40, lineHeight: '28px' }}>{str(shelf.code)}</span>
                      {Array.isArray(shelf.bins) && (shelf.bins as Rec[]).map((bin) => (
                        <button
                          key={String(bin.id)}
                          onClick={() => setSelected(bin)}
                          style={{
                            minWidth: 64, padding: '6px 8px', borderRadius: 6, border: selected && num(selected.id) === num(bin.id) ? '2px solid #0f172a' : '1px solid #e2e8f0',
                            background: binTone(bin), color: num(bin.isBlocked) ? '#fff' : '#fff', cursor: 'pointer', fontSize: 11,
                          }}
                          title={str(bin.code)}
                        >
                          <div>{str(bin.code)}</div>
                          <div>{fmtNum(num(bin.qty))}</div>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
          {zones.length === 0 && <div className="muted">No zones in this warehouse.</div>}
        </div>
      )}
      {selected && (
        <div className="card card-pad" style={{ marginTop: 12 }}>
          <div className="card-head">
            <div><strong>{str(selected.code)}</strong> <span className="muted">{str(selected.name)}</span></div>
            {num(selected.isBlocked) > 0 && <Badge value="Blocked" />}
          </div>
          <div className="kpi-grid" style={{ marginTop: 8 }}>
            <div className="kpi-card"><div className="kpi-label">Qty</div><div className="kpi-value">{fmtNum(num(selected.qty))}</div></div>
            <div className="kpi-card"><div className="kpi-label">Value</div><div className="kpi-value">{fmtMoney(num(selected.value))}</div></div>
            <div className="kpi-card"><div className="kpi-label">Products</div><div className="kpi-value">{fmtNum(num(selected.productCount))}</div></div>
            <div className="kpi-card"><div className="kpi-label">Capacity</div><div className="kpi-value">{fmtNum(num(selected.capacityQty))}</div></div>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {num(selected.pickingPriority) > 0 && <>Picking priority: {num(selected.pickingPriority)} · </>}
            {str(selected.barcode) && <>Barcode: {str(selected.barcode)} · </>}
            {num(selected.isSecure) > 0 && <>Secure location · </>}
            {str(selected.blockedReason) && <>Blocked: {str(selected.blockedReason)} · </>}
            {str(selected.temperatureAlert) && <>Temp alert: {str(selected.temperatureAlert)} · </>}
            {str(selected.lastCountedAt) && <>Last counted: {fmtDate(selected.lastCountedAt)}</>}
          </p>
        </div>
      )}
    </>
  );
}
function HandlingUnits() {
  const [ref, setRef] = useState('');
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const load = useCallback((value: string) => {
    const q = value.trim();
    if (!q) { setData(null); return; }
    setError('');
    api<{ data: Rec }>(`/api/ops/inventory-intel/handling-units/${encodeURIComponent(q)}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Handling unit lookup failed'));
  }, []);
  const hu = data && typeof data.handlingUnit === 'object' && data.handlingUnit ? (data.handlingUnit as Rec) : null;
  const location = data && typeof data.location === 'object' && data.location ? (data.location as Rec) : null;
  const parentChain = data && Array.isArray(data.parentChain) ? (data.parentChain as Rec[]) : [];
  const children = data && Array.isArray(data.children) ? (data.children as Rec[]) : [];
  const items = data && Array.isArray(data.items) ? (data.items as Rec[]) : [];
  const events = data && Array.isArray(data.traceabilityEvents) ? (data.traceabilityEvents as Rec[]) : [];
  return (
    <>
      <div className="toolbar">
        <input
          className="search-input"
          style={{ maxWidth: 360 }}
          placeholder="Scan or enter HU no / barcode / SSCC / id"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(ref); }}
        />
        <button className="btn btn-primary" disabled={!ref.trim()} onClick={() => load(ref)}>Look up</button>
        {hu && <span className="muted">{str(hu.huNo || hu.handlingUnitNo || hu.code || '')}</span>}
      </div>
      {error && <ErrorBanner error={error} />}
      {!data && !error && <div className="muted">Scan or enter a handling unit to see its contents, parent chain and traceability events.</div>}
      {data && hu && (
        <>
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-label">Handling unit</div>
              <div className="kpi-value" style={{ fontSize: 18 }}>{str(hu.huNo || hu.handlingUnitNo || hu.code || '-')}</div>
              <div className="kpi-sub">{str(hu.type || hu.unitType || '')} {str(hu.barcode) && `· ${str(hu.barcode)}`}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Location</div>
              <div className="kpi-value" style={{ fontSize: 18 }}>
                {location ? `${str(location.binCode || '-')}` : 'Not located'}
              </div>
              <div className="kpi-sub">{location ? `${str(location.warehouseCode)} - ${str(location.warehouseName)}` : ''}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Status</div>
              <div className="kpi-value" style={{ fontSize: 18 }}>{str(hu.status || '-')}</div>
              <div className="kpi-sub">{fmtDate(hu.createdAt)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Items inside</div>
              <div className="kpi-value" style={{ fontSize: 18 }}>{fmtNum(items.length)}</div>
              <div className="kpi-sub">{fmtNum(children.length)} child units</div>
            </div>
          </div>
          <div className="card card-pad" style={{ marginTop: 12 }}>
            <div className="card-head"><strong>Contents</strong></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Product</th><th>Batch</th><th>Serial</th><th className="num">Qty</th></tr></thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={String(it.id)}>
                      <td>{str(it.productCode)} - {str(it.productName)}</td>
                      <td className="cell-mono">{str(it.batchNo) || '-'}</td>
                      <td className="cell-mono">{str(it.serialNo) || '-'}</td>
                      <td className="num">{fmtNum(num(it.quantity))}</td>
                    </tr>
                  ))}
                  {items.length === 0 && <tr><td colSpan={4} className="muted">No items recorded in this unit.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          {(parentChain.length > 0 || children.length > 0) && (
            <div className="card card-pad" style={{ marginTop: 12 }}>
              <div className="card-head"><strong>Hierarchy</strong></div>
              {parentChain.length > 0 && (
                <p className="muted" style={{ fontSize: 12 }}>
                  Parent chain: {parentChain.map((p) => str(p.huNo || p.code || p.name)).join(' -> ')}
                </p>
              )}
              {children.length > 0 && (
                <p className="muted" style={{ fontSize: 12 }}>
                  Children: {children.map((c) => str(c.huNo || c.code || c.name)).join(', ')}
                </p>
              )}
            </div>
          )}
          {events.length > 0 && (
            <div className="card card-pad" style={{ marginTop: 12 }}>
              <div className="card-head"><strong>Traceability events</strong></div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Event</th><th>Biz step</th><th>Action</th><th>Source</th><th>Device</th><th>Time</th></tr></thead>
                  <tbody>
                    {events.map((ev) => (
                      <tr key={String(ev.id)}>
                        <td>{str(ev.eventType)}</td>
                        <td>{str(ev.bizStep)}</td>
                        <td>{str(ev.action)}</td>
                        <td>{str(ev.sourceCode)}</td>
                        <td>{str(ev.device) || '-'}</td>
                        <td>{fmtDate(ev.eventTime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
function Kpis() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    api<{ data: Rec }>('/api/ops/inventory-intel/kpis')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'KPIs failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Crunching inventory KPIs..." />;
  const k = (data.kpis && typeof data.kpis === 'object' ? data.kpis : {}) as Rec;
  const raw = (data.raw && typeof data.raw === 'object' ? data.raw : {}) as Rec;
  const items: { label: string; value: string; pct?: boolean }[] = [
    { label: 'Inventory accuracy', value: fmtPct(k.inventoryAccuracyPct) },
    { label: 'Cycle count accuracy', value: fmtPct(k.cycleCountAccuracyPct) },
    { label: 'Inventory turnover', value: fmtNum(num(k.inventoryTurnover)) },
    { label: 'Days inventory outstanding', value: fmtNum(num(k.daysInventoryOutstanding)) },
    { label: 'Stockout rate', value: fmtPct(k.stockoutRatePct) },
    { label: 'Fill rate', value: fmtPct(k.fillRatePct) },
    { label: 'Receiving accuracy', value: fmtPct(k.receivingAccuracyPct) },
    { label: 'Picking accuracy', value: fmtPct(k.pickingAccuracyPct) },
    { label: 'Put-away accuracy', value: fmtPct(k.putawayAccuracyPct) },
    { label: 'Shrinkage', value: fmtPct(k.shrinkagePct) },
    { label: 'Dead stock', value: fmtPct(k.deadStockPct) },
    { label: 'Warehouse utilization', value: fmtPct(k.warehouseUtilizationPct) },
    { label: 'Slow-moving', value: fmtPct(k.slowMovingPct) },
    { label: 'Excess stock', value: fmtPct(k.excessStockPct) },
  ];
  return (
    <>
      <div className="toolbar">
        <span className="muted">Generated {fmtDate(data.generatedAt)}</span>
        <button className="btn btn-ghost" onClick={load}>Refresh</button>
      </div>
      <div className="kpi-grid">
        {items.map((it) => (
          <div key={it.label} className="kpi-card">
            <div className="kpi-label">{it.label}</div>
            <div className="kpi-value">{it.value}</div>
          </div>
        ))}
      </div>
      <div className="card card-pad" style={{ marginTop: 12 }}>
        <div className="card-head"><strong>Raw metrics</strong></div>
        <div className="chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[
            ['Stock lines', fmtNum(num(raw.stockLines))],
            ['Stockout lines', fmtNum(num(raw.stockoutLines))],
            ['Inventory value', fmtMoney(num(raw.inventoryValue))],
            ['COGS (30d)', fmtMoney(num(raw.cogs30d))],
            ['Adjustment value', fmtMoney(num(raw.adjustmentValue))],
            ['Adjustments', fmtNum(num(raw.adjustments))],
            ['Pick movements', fmtNum(num(raw.pickMovements))],
            ['Counted lines', fmtNum(num(raw.countedLines))],
            ['Exact lines', fmtNum(num(raw.exactLines))],
            ['Bins used', `${fmtNum(num(raw.usedBins))}/${fmtNum(num(raw.totalBins))}`],
            ['Dead stock items', fmtNum(num(raw.deadStockItems))],
            ['Products with stock', fmtNum(num(raw.productsWithStock))],
          ].map(([label, value]) => (
            <span key={String(label)} className="badge" style={{ padding: '6px 10px' }}>
              {String(label)}: <strong>{String(value)}</strong>
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
