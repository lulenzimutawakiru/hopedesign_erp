import { useCallback, useEffect, useState } from 'react';
import { api, EntityMeta, fmtDate, fmtMoney, fmtNum, ListResult } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { pick } from '../helpers';
import { Badge, ErrorBanner, Modal, PageLoader, Pager } from '../components/ui';
import { DataTable } from '../components/DataTable';
import { JsonForm } from '../components/JsonForm';
import WarehouseOps from './WarehouseOps';
import EntityDetail from './EntityDetail';

type Rec = Record<string, unknown>;

const TABS: { resource: string; label: string; perm: string }[] = [
  { resource: 'stock', label: 'Stock', perm: 'inventory.stock.view' },
  { resource: 'assets', label: 'Assets', perm: 'assets.register.view' },
  { resource: 'materials', label: 'Raw Materials', perm: 'inventory.items.view' },
  { resource: 'consumables', label: 'Consumables', perm: 'inventory.items.view' },
  { resource: 'warehouses', label: 'Warehouses', perm: 'inventory.warehouses.view' },
  { resource: 'movements', label: 'Movements', perm: 'inventory.movements.view' },
  { resource: 'transfers', label: 'Transfers', perm: 'inventory.transfers.view' },
  { resource: 'adjustments', label: 'Adjustments', perm: 'inventory.adjustments.view' },
  { resource: 'items', label: 'Products', perm: 'inventory.items.view' },
  { resource: 'batches', label: 'Batches', perm: 'inventory.batches.view' },
  { resource: 'reservations', label: 'Reservations', perm: 'inventory.reservations.view' },
];

interface CatalogSpec {
  resource: string;
  module?: string;
  label?: string;
  tagline?: string;
  createLabel?: string;
  createPerm?: string;
  detail?: (id: number) => string;
  /** Client-side type filter so the Products catalogue stays separated from raw materials. */
  types?: string[];
}

// Products catalogue = finished goods only. Raw materials, packaging and
// consumables belong to the Raw Materials catalogue (server-filtered).
const FG_TYPES = ['REAM', 'FINISHED_GOODS', 'SHEET', 'SECURITY_ITEM'];

const CATALOGS: Record<string, CatalogSpec> = {
  items: {
    resource: 'items', module: 'inventory', label: 'Products',
    tagline: 'Finished goods, reams and security items that flow through stock, sales and manufacturing.',
    createLabel: 'New product',
    createPerm: 'inventory.items.create',
    detail: (id) => `/inventory/items/${id}`,
    types: FG_TYPES,
  },
  materials: {
    resource: 'materials', module: 'inventory', label: 'Raw Materials',
    tagline: 'Jumbo rolls, paper bobbins and packaging consumed by production.',
    createLabel: 'New material',
    createPerm: 'inventory.items.create',
    detail: (id) => `/inventory/materials/${id}`,
  },
  consumables: {
    resource: 'consumables', module: 'inventory', label: 'Consumables',
    tagline: 'Consumables, spares and other production supplies — kept separate from raw materials.',
    createLabel: 'New consumable',
    createPerm: 'inventory.items.create',
    detail: (id) => `/inventory/consumables/${id}`,
  },
  assets: {
    resource: 'register', module: 'assets', label: 'Assets',
    tagline: 'Machines, tools, vehicles and equipment tracked in their own register with QR trace.',
    createLabel: 'Register asset',
    createPerm: 'assets.register.create',
    detail: (id) => `/records/assets/register/${id}`,
  },
};

export function parseInventoryPath(path: string): { resource: string; id: string | null } {
  const parts = path.split('/').filter(Boolean);
  const start = parts[0] === 'records' ? 1 : 0;
  return { resource: parts[start + 1] ?? 'stock', id: parts[start + 2] ?? null };
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isLow(row: Rec): boolean {
  return num(pick(row, 'quantity')) <= num(pick(row, 'reorderPoint', 'reorder_point'));
}

function daysUntil(dateStr: unknown): number {
  const s = String(dateStr ?? '');
  if (!s) return Infinity;
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return Infinity;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

function expiryBadge(expiry: unknown) {
  const days = daysUntil(expiry);
  if (!Number.isFinite(days)) return null;
  if (days < 0) return <span className="badge badge-danger"><span className="badge-icon" aria-hidden>!</span>EXPIRED</span>;
  if (days <= 30) return <span className="badge badge-amber"><span className="badge-icon" aria-hidden>~</span>{days} day{days === 1 ? '' : 's'} left</span>;
  return <span className="muted">{String(expiry)}</span>;
}

const RAW_TYPES = ['JUMBO_ROLL', 'PAPER_BOBBIN', 'PACKAGING'];
const CONSUMABLE_TYPES = ['CONSUMABLE', 'SPARE_PART'];

const TYPE_CHIPS: { label: string; value: string }[] = [
  { label: 'All types', value: '' },
  { label: 'Ream', value: 'REAM' },
  { label: 'Raw materials', value: RAW_TYPES.join(',') },
  { label: 'Consumables', value: CONSUMABLE_TYPES.join(',') },
  { label: 'Finished goods', value: 'FINISHED_GOODS,SHEET' },
  { label: 'Security', value: 'SECURITY_ITEM' },
];

function isRawType(t: unknown): boolean {
  return typeof t === 'string' && RAW_TYPES.includes(t);
}

function isConsumableType(t: unknown): boolean {
  return typeof t === 'string' && CONSUMABLE_TYPES.includes(t);
}

function productDetailPath(t: unknown, id: number): string {
  if (isRawType(t)) return `/inventory/materials/${id}`;
  if (isConsumableType(t)) return `/inventory/consumables/${id}`;
  return `/inventory/items/${id}`;
}

const OPS = new Set(['ops', 'receive', 'pick', 'issue', 'demand', 'putaway', 'reservations']);

export default function InventoryFlow({ path }: { path: string }) {
  const { resource, id } = parseInventoryPath(path);
  if (OPS.has(resource)) return <WarehouseOps path={path} />;
  if (id === 'new') {
    if (resource === 'transfers') return <TransferComposer />;
    if (resource === 'adjustments') return <AdjustmentComposer />;
  }
  if (id && Number(id) > 0) {
    if (resource === 'transfers') return <TransferDetail id={Number(id)} />;
    if (resource === 'adjustments') return <AdjustmentDetail id={Number(id)} />;
    if (resource === 'items') return <ProductStock id={Number(id)} />;
    if (resource === 'materials') return <EntityDetail route={{ segments: ['records', 'inventory', 'materials', String(id)] }} />;
    if (resource === 'consumables') return <EntityDetail route={{ segments: ['records', 'inventory', 'consumables', String(id)] }} />;
    if (resource === 'warehouses') return <StockBoard warehouseId={Number(id)} />;
  }
  if (resource === 'stock' || resource === 'warehouses' && !id) {
    return resource === 'warehouses' ? <WarehouseBoard /> : <StockBoard />;
  }
  if (resource === 'movements') return <MovementLedger />;
  if (resource === 'transfers' || resource === 'adjustments') return <DocumentList resource={resource} />;
  const catalog = CATALOGS[resource];
  if (catalog) return <CatalogList {...catalog} />;
  return <CatalogList resource={resource} module="inventory" label={resource} detail={(id) => `/records/inventory/${resource}/${id}`} />;
}

function Tabs({ resource }: { resource: string }) {
  void resource;
  return null;
}

function StockBoard({ warehouseId }: { warehouseId?: number }) {
  const { user } = useAuth();
  const [summary, setSummary] = useState<Rec | null>(null);
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [wh, setWh] = useState<string>(warehouseId ? String(warehouseId) : '');
  const [lowOnly, setLowOnly] = useState(false);
  const [expOnly, setExpOnly] = useState(false);
  const [type, setType] = useState('');
  const [warehouses, setWarehouses] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (warehouseId) setWh(String(warehouseId));
  }, [warehouseId]);

  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/warehouses')
      .then((r) => setWarehouses(Array.isArray(r.data) ? r.data : []))
      .catch(() => undefined);
    api<{ data: Rec }>('/api/ops/inventory/stock/summary')
      .then((r) => setSummary(r.data))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: '40' });
    if (q.trim()) params.set('q', q.trim());
    if (wh) params.set('warehouseId', wh);
    if (lowOnly) params.set('lowStock', '1');
    if (expOnly) params.set('expiring', '1');
    if (type) params.set('productType', type);
    const r = await api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/inventory/stock?${params.toString()}`);
    setRows(r.data.rows ?? []);
    setTotal(r.data.total ?? 0);
  }, [expOnly, lowOnly, page, q, type, wh]);

  useEffect(() => {
    setBusy(true);
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load stock')).finally(() => setBusy(false));
  }, [load]);

  const selectedWh = warehouses.find((w) => String(w.id) === wh);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{selectedWh ? String(pick(selectedWh, 'name')) : 'Floor stock'}</h1>
          <p className="muted">What is here, what is promised, what you can pick. Low stock is an exception, not a report.</p>
        </div>
        <div className="head-actions">
          {can(user, 'inventory.transfers.create') && <button className="btn" onClick={() => navigate('/inventory/transfers/new')}>New transfer</button>}
          {can(user, 'inventory.adjustments.create') && <button className="btn btn-primary" onClick={() => navigate('/inventory/adjustments/new')}>New adjustment</button>}
        </div>
      </header>
      <Tabs resource={warehouseId ? 'warehouses' : 'stock'} />

      {summary && (
        <div className="kpi-grid">
          <div className="kpi-card"><span className="kpi-label">Stock value</span><span className="kpi-value">{fmtMoney(summary.stockValue)}</span><span className="kpi-sub">{fmtNum(summary.products)} products · {fmtNum(summary.lines)} lines</span></div>
          <div className={`kpi-card ${num(summary.lowStock) ? 'card-warn' : ''}`}><span className="kpi-label">Low stock</span><span className="kpi-value">{fmtNum(summary.lowStock)}</span><span className="kpi-sub">at or below reorder point</span></div>
          <div className="kpi-card"><span className="kpi-label">Reserved</span><span className="kpi-value">{fmtNum(summary.reservedQty)}</span><span className="kpi-sub">{fmtNum(summary.reservedLines)} lines held for orders</span></div>
          <button className={`kpi-card ${num(summary.expiring) ? 'card-warn' : ''}`} onClick={() => { setExpOnly(true); setPage(1); }}>
            <span className="kpi-label">Expiring 30d</span><span className="kpi-value">{fmtNum(summary.expiring)}</span><span className="kpi-sub">expired or expiring soon - click to filter</span>
          </button>
          <button className="kpi-card" onClick={() => navigate('/inventory/assets')}>
            <span className="kpi-label">Assets</span><span className="kpi-value">{fmtNum(summary.assets)}</span><span className="kpi-sub">Open the asset register</span>
          </button>
          <button className="kpi-card" onClick={() => navigate('/inventory/materials')}>
            <span className="kpi-label">Raw materials</span><span className="kpi-value">{fmtNum(summary.catalogMaterials)}</span><span className="kpi-sub">{fmtNum(summary.materialLines)} stocked · consumed by production</span>
          </button>
          <button className="kpi-card" onClick={() => navigate('/inventory/consumables')}>
            <span className="kpi-label">Consumables</span><span className="kpi-value">{fmtNum(summary.catalogConsumables)}</span><span className="kpi-sub">{fmtNum(summary.consumableLines)} stocked · spares & supplies</span>
          </button>
          <button className="kpi-card" onClick={() => navigate('/inventory/items')}>
            <span className="kpi-label">Products</span><span className="kpi-value">{fmtNum(summary.catalogProducts)}</span><span className="kpi-sub">{fmtNum(summary.productLines)} stocked · reams and finished goods</span>
          </button>
        </div>
      )}

      <div className="toolbar">
        <input className="search-input" placeholder="Search product code or name…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select className="search-input" style={{ maxWidth: 220 }} value={wh} onChange={(e) => { setWh(e.target.value); setPage(1); }}>
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={String(w.id)} value={String(w.id)}>{String(pick(w, 'code'))} · {String(pick(w, 'name'))}</option>
          ))}
        </select>
        <label className="filter-check">
          <input type="checkbox" checked={lowOnly} onChange={(e) => { setLowOnly(e.target.checked); setPage(1); }} />
          Low stock only
        </label>
        <label className="filter-check">
          <input type="checkbox" checked={expOnly} onChange={(e) => { setExpOnly(e.target.checked); setPage(1); }} />
          Expiring soon
        </label>
      </div>
      <div className="chips" style={{ marginBottom: 12 }}>
        {TYPE_CHIPS.map((c) => (
          <button key={c.value || 'all'} className={`chip ${type === c.value ? 'chip-on' : ''}`} onClick={() => { setType(c.value); setPage(1); }}>
            {c.label}
          </button>
        ))}
      </div>
      {error && <ErrorBanner error={error} />}
      {busy ? <PageLoader label="Loading stock…" /> : (
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th>Warehouse</th>
                <th>Bin / batch</th>
                <th className="cell-num">On hand</th>
                <th className="cell-num">Reserved</th>
                <th className="cell-num">Available</th>
                <th className="cell-num">Avg cost</th>
                <th className="cell-num">Value</th>
                <th>Status</th>
                <th className="cell-num">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const low = isLow(row);
                const onHand = num(pick(row, 'quantity'));
                const available = num(pick(row, 'availableQty'));
                const availPct = onHand > 0 ? Math.max(0, Math.min(100, (available / onHand) * 100)) : 0;
                const productId = Number(pick(row, 'productId'));
                return (
                  <tr key={String(row.id)} className={`row-click ${low ? 'row-warn' : ''}`} onClick={() => navigate(productDetailPath(pick(row, 'productType'), productId))}>
                    <td>
                      <div className="cell-mono">{String(pick(row, 'productCode') ?? '')}</div>
                      <div>{String(pick(row, 'productName') ?? '')}</div>
                      <div className="row-sub"><Badge value={pick(row, 'productType')} /></div>
                    </td>
                    <td>
                      <div className="cell-mono">{String(pick(row, 'warehouseCode') ?? '')}</div>
                      <div className="muted">{String(pick(row, 'warehouseName') ?? '')}</div>
                    </td>
                    <td>
                      {pick(row, 'binCode') ? <div className="cell-mono">{String(pick(row, 'binCode'))}</div> : null}
                      {pick(row, 'batchNo') ? (
                        <div className="row-sub">
                          <span className="cell-mono">{String(pick(row, 'batchNo'))}</span>
                          {expiryBadge(pick(row, 'batchExpiry'))}
                        </div>
                      ) : <div className="muted">-</div>}
                    </td>
                    <td className="cell-num">{fmtNum(onHand)}</td>
                    <td className="cell-num">{fmtNum(pick(row, 'reservedQty'))}</td>
                    <td className="cell-num">
                      <div>{fmtNum(available)}</div>
                      <div className="progress" style={{ height: 5, width: 64, marginLeft: 'auto', marginTop: 4 }}>
                        <div className="progress-fill" style={{ width: `${availPct}%`, background: low ? 'linear-gradient(90deg, #E0A63A, #F0C070)' : undefined }} />
                      </div>
                    </td>
                    <td className="cell-num">{fmtMoney(pick(row, 'avgCost'))}</td>
                    <td className="cell-num">{fmtMoney(pick(row, 'stockValue'))}</td>
                    <td>
                      <div className="row-status">
                        {low ? <Badge value="LOW" /> : <Badge value="OK" />}
                        {num(pick(row, 'reservedQty')) > 0 && <Badge value="RESERVED" />}
                      </div>
                    </td>
                    <td>
                      <div className="row-actions">
                        {can(user, 'inventory.transfers.create') && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate('/inventory/transfers/new'); }}>Transfer</button>}
                        {can(user, 'inventory.adjustments.create') && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate('/inventory/adjustments/new'); }}>Adjust</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--muted)', padding: 28 }}>No stock lines match these filters. Try clearing filters or receiving a purchase order.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-foot">
        <span className="muted">{total} stock line{total === 1 ? '' : 's'}</span>
        {(q || wh || lowOnly || type) && (
          <button className="btn btn-sm" onClick={() => { setQ(''); setWh(warehouseId ? String(warehouseId) : ''); setLowOnly(false); setType(''); setPage(1); }}>Clear filters</button>
        )}
      </div>
      <Pager page={page} pageSize={40} total={total} onPage={setPage} />
    </div>
  );
}

function WarehouseBoard() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(true);
    api<{ data: Rec[] }>('/api/ops/inventory/warehouses')
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load warehouses'))
      .finally(() => setBusy(false));
  }, []);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Warehouses</h1>
          <p className="muted">Finished goods, raw materials, secure store, quarantine and returns.</p>
        </div>
      </header>
      <Tabs resource="warehouses" />
      {error && <ErrorBanner error={error} />}
      {busy ? <PageLoader label="Loading warehouses…" /> : (
        <div className="wh-grid">
          {rows.map((w) => (
            <button key={String(w.id)} className="wh-card" onClick={() => navigate(`/inventory/warehouses/${w.id}`)}>
              <div className="wh-card-top">
                <span className="cell-mono">{String(pick(w, 'code'))}</span>
                <Badge value={pick(w, 'type')} />
              </div>
              <strong>{String(pick(w, 'name'))}</strong>
              <div className="kpi-value" style={{ fontSize: 20, marginTop: 10 }}>{fmtMoney(pick(w, 'stockValue'))}</div>
              <div className="muted">{fmtNum(pick(w, 'products'))} products · {fmtNum(pick(w, 'lines'))} lines</div>
              {Boolean(pick(w, 'isSecure')) && <span className="badge badge-purple" style={{ marginTop: 8 }}><span className="badge-icon" aria-hidden>●</span>Secure</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProductStock({ id }: { id: number }) {
  const { user } = useAuth();
  const [data, setData] = useState<{ product: Rec; locations: Rec[]; movements: Rec[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ data: { product: Rec; locations: Rec[]; movements: Rec[] } }>(`/api/ops/inventory/products/${id}/stock`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load product stock'));
  }, [id]);

  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Loading product…" />;
  const p = data.product;
  const onHand = data.locations.reduce((s, r) => s + num(pick(r, 'quantity')), 0);
  const reserved = data.locations.reduce((s, r) => s + num(pick(r, 'reservedQty')), 0);
  const value = data.locations.reduce((s, r) => s + num(pick(r, 'stockValue')), 0);
  const reorder = num(pick(p, 'reorderPoint'));
  const low = reorder > 0 && onHand <= reorder;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/inventory/stock')}>Back to stock</button>
          <h1><span className="cell-mono">{String(pick(p, 'code'))}</span> {String(pick(p, 'name'))}</h1>
          <p className="muted">{String(pick(p, 'type') ?? '')} · {String(pick(p, 'unitCode') ?? pick(p, 'unitName') ?? '')}</p>
        </div>
        <div className="head-actions">
          <Badge value={pick(p, 'status')} />
          {can(user, 'inventory.transfers.create') && <button className="btn" onClick={() => navigate('/inventory/transfers/new')}>Transfer</button>}
          {can(user, 'inventory.adjustments.create') && <button className="btn" onClick={() => navigate('/inventory/adjustments/new')}>Adjust</button>}
        </div>
      </header>
      {low && (
        <div className="alert alert-warn">
          <strong>Low stock</strong> — {fmtNum(onHand)} {String(pick(p, 'unitCode') ?? pick(p, 'unitName') ?? 'units')} on hand, at or below the reorder point of {fmtNum(reorder)}. Replenish before stock runs out.
        </div>
      )}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">On hand</span><span className="kpi-value">{fmtNum(onHand)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Reserved</span><span className="kpi-value">{fmtNum(reserved)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Available</span><span className="kpi-value">{fmtNum(onHand - reserved)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Value</span><span className="kpi-value">{fmtMoney(value)}</span></div>
        <div className={`kpi-card ${low ? 'card-warn' : ''}`}><span className="kpi-label">Reorder point</span><span className="kpi-value">{fmtNum(reorder)}</span><span className="kpi-sub">{low ? 'on hand is below this level' : 'replenish when on hand falls to this level'}</span></div>
      </div>
      <section className="card">
        <div className="card-head"><h3>Locations</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Warehouse</th>
                <th>Bin / batch</th>
                <th className="cell-num">On hand</th>
                <th className="cell-num">Reserved</th>
                <th className="cell-num">Available</th>
                <th className="cell-num">Value</th>
              </tr>
            </thead>
            <tbody>
              {data.locations.map((row) => (
                <tr key={String(row.id)} className="row-click" onClick={() => navigate(`/inventory/warehouses/${pick(row, 'warehouseId')}`)}>
                  <td>{String(pick(row, 'warehouseCode'))} · {String(pick(row, 'warehouseName'))}</td>
                  <td className="muted">{String(pick(row, 'binCode') ?? pick(row, 'batchNo') ?? '—')}</td>
                  <td className="cell-num">{fmtNum(pick(row, 'quantity'))}</td>
                  <td className="cell-num">{fmtNum(pick(row, 'reservedQty'))}</td>
                  <td className="cell-num">{fmtNum(pick(row, 'availableQty'))}</td>
                  <td className="cell-num">{fmtMoney(pick(row, 'stockValue'))}</td>
                </tr>
              ))}
              {data.locations.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 20 }}>No stock for this product yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Recent movements</h3></div>
        <MovementTable rows={data.movements} compact />
      </section>
    </div>
  );
}

function MovementTable({ rows, compact }: { rows: Rec[]; compact?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>When</th>
            <th>Type</th>
            {!compact && <th>Product</th>}
            <th>Warehouse</th>
            <th className="cell-num">Qty</th>
            <th>Reference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              <td className="muted">{fmtDate(pick(row, 'createdAt'))}</td>
              <td><Badge value={pick(row, 'movementType')} /></td>
              {!compact && (
                <td>
                  <div className="cell-mono">{String(pick(row, 'productCode') ?? '')}</div>
                  <div>{String(pick(row, 'productName') ?? '')}</div>
                </td>
              )}
              <td className="cell-mono">{String(pick(row, 'warehouseCode') ?? pick(row, 'fromWarehouseCode') ?? '—')}</td>
              <td className="cell-num">{fmtNum(pick(row, 'quantity'))}</td>
              <td className="muted">{String(pick(row, 'referenceCode') ?? pick(row, 'reason') ?? '—')}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={compact ? 5 : 6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No movements yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function MovementLedger() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: '40' });
    if (q.trim()) params.set('q', q.trim());
    const r = await api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/inventory/movements?${params.toString()}`);
    setRows(r.data.rows ?? []);
    setTotal(r.data.total ?? 0);
  }, [page, q]);

  useEffect(() => {
    setBusy(true);
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load movements')).finally(() => setBusy(false));
  }, [load]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Stock movements</h1>
          <p className="muted">Every receipt, issue, transfer, dispatch and adjustment that changed on-hand quantity.</p>
        </div>
      </header>
      <Tabs resource="movements" />
      <div className="toolbar">
        <input className="search-input" placeholder="Search movement, product or reason…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      </div>
      {error && <ErrorBanner error={error} />}
      {busy ? <PageLoader label="Loading movements…" /> : <div className="card"><MovementTable rows={rows} /></div>}
      <Pager page={page} pageSize={40} total={total} onPage={setPage} />
    </div>
  );
}

function DocumentList({ resource }: { resource: string }) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isXfer = resource === 'transfers';

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (q.trim()) params.set('q', q.trim());
    const r = await api<ListResult>(`/api/inventory/${resource}?${params.toString()}`);
    setRows(r.data);
    setTotal(r.pagination?.total ?? r.data.length);
  }, [page, q, resource]);

  useEffect(() => {
    setBusy(true);
    load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load')).finally(() => setBusy(false));
  }, [load]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{isXfer ? 'Stock transfers' : 'Stock adjustments'}</h1>
          <p className="muted">{isXfer ? 'Move stock between warehouses. Completing a transfer posts the issue and receipt.' : 'Count or correct on-hand. Posting writes an adjustment movement.'}</p>
        </div>
        <div className="head-actions">
          {can(user, `inventory.${resource}.create`) && (
            <button className="btn btn-primary" onClick={() => navigate(`/inventory/${resource}/new`)}>+ New {isXfer ? 'transfer' : 'adjustment'}</button>
          )}
        </div>
      </header>
      <Tabs resource={resource} />
      <div className="toolbar">
        <input className="search-input" placeholder="Search document number…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      </div>
      {error && <ErrorBanner error={error} />}
      {busy ? <PageLoader label="Loading…" /> : (
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr>
                <th>Number</th>
                <th>Status</th>
                <th>{isXfer ? 'Route' : 'Type'}</th>
                <th>Date</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={String(row.id)} className="row-click" onClick={() => navigate(`/inventory/${resource}/${row.id}`)}>
                  <td className="cell-mono">{String(pick(row, isXfer ? 'transferNo' : 'adjustmentNo', 'transfer_no', 'adjustment_no'))}</td>
                  <td><Badge value={pick(row, 'status')} /></td>
                  <td>{isXfer ? `${pick(row, 'fromWarehouseId') ?? ''} → ${pick(row, 'toWarehouseId') ?? ''}` : String(pick(row, 'adjustmentType', 'adjustment_type') ?? '')}</td>
                  <td className="muted">{fmtDate(pick(row, 'createdAt', 'created_at'))}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/inventory/${resource}/${row.id}`); }}>Open</button></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 28 }}>No documents yet</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} pageSize={25} total={total} onPage={setPage} />
    </div>
  );
}

function CatalogList({ resource, module = 'inventory', label, tagline, createLabel, createPerm, detail, types }: CatalogSpec) {
  const { user } = useAuth();
  const [meta, setMeta] = useState<EntityMeta | null>(null);
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    api<{ data: EntityMeta }>(`/api/meta/entities/${module}/${resource}`)
      .then((r) => setMeta(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  }, [module, resource]);

  const load = useCallback(async (p: number, query: string) => {
    if (!meta) return;
    const params = new URLSearchParams({ page: String(p), pageSize: '25' });
    if (query.trim()) params.set('q', query.trim());
    api<ListResult>(`/api/${module}/${resource}?${params}`)
      .then((r) => {
        const rows2 = types ? r.data.filter((x) => types.includes(String(pick(x, 'type') ?? ''))) : r.data;
        setRows(rows2);
        setTotal(types ? rows2.length : (r.pagination?.total ?? r.data.length));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  }, [meta, module, resource]);

  useEffect(() => { void load(page, q); }, [load, page, q]);

  const create = async (values: Record<string, unknown>) => {
    await api(`/api/${module}/${resource}`, { method: 'POST', body: JSON.stringify(values) });
    setShowCreate(false);
    setQ('');
    setPage(1);
    await load(1, '');
  };

  const title = label ?? TABS.find((t) => t.resource === resource)?.label ?? resource;
  const canCreate = Boolean(createPerm) && can(user, createPerm ?? '');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted">{tagline ?? 'Master data used by stock, transfers and manufacturing.'}</p>
        </div>
        <div className="head-actions">
          {canCreate && meta && (
            <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ {createLabel ?? 'New'}</button>
          )}
        </div>
      </header>
      <Tabs resource={resource} />
      <div className="toolbar">
        <input className="search-input" placeholder={`Search ${meta?.searchable.join(', ') || 'records'}…`} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      </div>
      {error && <ErrorBanner error={error} />}
      {meta && (
        <DataTable
          meta={meta}
          rows={rows}
          onOpen={(id) => navigate(detail ? detail(id) : `/records/${module}/${resource}/${id}`)}
          onCreate={canCreate ? () => setShowCreate(true) : undefined}
          emptyTitle={`No ${label?.toLowerCase() ?? resource} yet`}
          emptyBody={`Create the first ${label?.toLowerCase() ?? resource} to start tracking it in stock.`}
        />
      )}
      <Pager page={page} pageSize={25} total={total} onPage={setPage} />
      {showCreate && meta && (
        <Modal title={createLabel ?? `New ${label ?? resource}`} onClose={() => setShowCreate(false)} wide>
          <JsonForm meta={meta} onSubmit={create} onCancel={() => setShowCreate(false)} submitLabel="Create" />
        </Modal>
      )}
    </div>
  );
}

function LookupField({
  label, endpoint, display, valueLabel, onPick, compact,
}: {
  label?: string;
  endpoint: string;
  display: (row: Rec) => string;
  valueLabel: string;
  onPick: (row: Rec) => void;
  compact?: boolean;
}) {
  const [q, setQ] = useState(valueLabel);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Rec[]>([]);
  useEffect(() => { setQ(valueLabel); }, [valueLabel]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const params = new URLSearchParams({ pageSize: '12' });
      if (q.trim() && q !== valueLabel) params.set('q', q.trim());
      api<ListResult>(`${endpoint}?${params}`).then((r) => setRows(r.data)).catch(() => setRows([]));
    }, 160);
    return () => clearTimeout(t);
  }, [endpoint, open, q, valueLabel]);
  const body = (
    <div className="lookup">
      <input value={q} placeholder="Search…" onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onBlur={() => setTimeout(() => setOpen(false), 160)} />
      {open && (
        <div className="lookup-menu">
          {rows.map((r) => (
            <button key={String(r.id)} type="button" className="lookup-item" onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(r); setOpen(false); }}>
              {display(r)}
            </button>
          ))}
          {rows.length === 0 && <div className="search-hint">No matches</div>}
        </div>
      )}
    </div>
  );
  if (compact) return body;
  return <div className="field field-required"><label>{label}</label>{body}</div>;
}

function TransferComposer() {
  const [warehouses, setWarehouses] = useState<Rec[]>([]);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<{ key: string; productId: number | ''; label: string; quantity: number }[]>([
    { key: '1', productId: '', label: '', quantity: 1 },
  ]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/warehouses').then((r) => setWarehouses(Array.isArray(r.data) ? r.data : [])).catch(() => undefined);
  }, []);

  const save = async () => {
    setError('');
    if (!fromId || !toId) { setError('Choose from and to warehouses'); return; }
    const items = lines.filter((l) => l.productId && l.quantity > 0).map((l) => ({ productId: Number(l.productId), quantity: l.quantity }));
    if (!items.length) { setError('Add at least one product line'); return; }
    setBusy(true);
    try {
      const r = await api<{ data: { transferId: number } }>('/api/ops/inventory/transfers', {
        method: 'POST',
        body: JSON.stringify({ fromWarehouseId: Number(fromId), toWarehouseId: Number(toId), notes: notes || null, items }),
      });
      navigate(`/inventory/transfers/${r.data.transferId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/inventory/transfers')}>Back</button>
          <h1>New stock transfer</h1>
          <p className="muted">Draft a warehouse-to-warehouse move. Submit for approval, then complete to post stock.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/inventory/transfers')}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save draft'}</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required">
            <label>From warehouse</label>
            <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
              <option value="">Select…</option>
              {warehouses.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(pick(w, 'code'))} · {String(pick(w, 'name'))}</option>)}
            </select>
          </div>
          <div className="field field-required">
            <label>To warehouse</label>
            <select value={toId} onChange={(e) => setToId(e.target.value)}>
              <option value="">Select…</option>
              {warehouses.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(pick(w, 'code'))} · {String(pick(w, 'name'))}</option>)}
            </select>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Lines</h3>
          <button className="btn btn-sm" onClick={() => setLines((p) => [...p, { key: `${Date.now()}`, productId: '', label: '', quantity: 1 }])}>+ Line</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Product</th><th className="cell-num">Qty</th><th /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <LookupField compact endpoint="/api/inventory/items" display={(r) => `${pick(r, 'code')} · ${pick(r, 'name')}`} valueLabel={l.label} onPick={(r) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, productId: num(r.id), label: `${pick(r, 'code')} · ${pick(r, 'name')}` } : x))} />
                  </td>
                  <td><input className="cell-input" type="number" min={0} value={l.quantity} onChange={(e) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, quantity: num(e.target.value) } : x))} /></td>
                  <td><button className="btn btn-sm" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function AdjustmentComposer() {
  const [warehouses, setWarehouses] = useState<Rec[]>([]);
  const [type, setType] = useState('CORRECTION');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<{ key: string; productId: number | ''; warehouseId: string; label: string; counted: number }[]>([
    { key: '1', productId: '', warehouseId: '', label: '', counted: 0 },
  ]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/warehouses').then((r) => setWarehouses(Array.isArray(r.data) ? r.data : [])).catch(() => undefined);
  }, []);

  const save = async () => {
    setError('');
    if (!reason.trim()) { setError('Reason is required'); return; }
    const items = lines.filter((l) => l.productId && l.warehouseId).map((l) => ({
      productId: Number(l.productId),
      warehouseId: Number(l.warehouseId),
      countedQty: l.counted,
    }));
    if (!items.length) { setError('Add at least one counted line'); return; }
    setBusy(true);
    try {
      const r = await api<{ data: { adjustmentId: number } }>('/api/ops/inventory/adjustments', {
        method: 'POST',
        body: JSON.stringify({ adjustmentType: type, reason: reason.trim(), items }),
      });
      navigate(`/inventory/adjustments/${r.data.adjustmentId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/inventory/adjustments')}>Back</button>
          <h1>New stock adjustment</h1>
          <p className="muted">Enter counted quantity. The system stores expected vs variance and posts the difference after approval.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/inventory/adjustments')}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save draft'}</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field">
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="CORRECTION">Correction</option>
              <option value="STOCKTAKE">Stocktake</option>
              <option value="CYCLE_COUNT">Cycle count</option>
              <option value="DAMAGE">Damage</option>
              <option value="SCRAP">Scrap</option>
              <option value="QUARANTINE">Quarantine</option>
              <option value="RELEASE">Release</option>
            </select>
          </div>
          <div className="field field-required" style={{ gridColumn: 'span 2' }}>
            <label>Reason</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is stock being adjusted?" />
          </div>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Count lines</h3>
          <button className="btn btn-sm" onClick={() => setLines((p) => [...p, { key: `${Date.now()}`, productId: '', warehouseId: lines[0]?.warehouseId ?? '', label: '', counted: 0 }])}>+ Line</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Product</th><th>Warehouse</th><th className="cell-num">Counted qty</th><th /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <LookupField compact endpoint="/api/inventory/items" display={(r) => `${pick(r, 'code')} · ${pick(r, 'name')}`} valueLabel={l.label} onPick={(r) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, productId: num(r.id), label: `${pick(r, 'code')} · ${pick(r, 'name')}` } : x))} />
                  </td>
                  <td>
                    <select className="cell-input" value={l.warehouseId} onChange={(e) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, warehouseId: e.target.value } : x))}>
                      <option value="">Select…</option>
                      {warehouses.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(pick(w, 'code'))}</option>)}
                    </select>
                  </td>
                  <td><input className="cell-input" type="number" value={l.counted} onChange={(e) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, counted: num(e.target.value) } : x))} /></td>
                  <td><button className="btn btn-sm" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function TransferDetail({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [items, setItems] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ data: { transfer: Rec; items: Rec[] } }>(`/api/ops/inventory/transfers/${id}`);
    setDoc(r.data.transfer);
    setItems(r.data.items);
  }, [id]);

  useEffect(() => { load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load transfer')); }, [load]);

  const act = async (label: string, path: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: '{}' });
      setNotice(label);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Loading transfer…" />;
  const status = String(pick(doc, 'status') ?? '');

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/inventory/transfers')}>Back</button>
          <h1>Transfer <span className="cell-mono">{String(pick(doc, 'transferNo'))}</span></h1>
          <p className="muted">{String(pick(doc, 'fromWarehouseCode'))} → {String(pick(doc, 'toWarehouseCode'))}</p>
        </div>
        <Badge value={status} />
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="detail-grid">
        <section className="card">
          <div className="card-head"><h3>Lines</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Product</th><th className="cell-num">Qty</th><th className="cell-num">Unit cost</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={String(i.id)}>
                    <td><div className="cell-mono">{String(pick(i, 'productCode'))}</div>{String(pick(i, 'productName'))}</td>
                    <td className="cell-num">{fmtNum(pick(i, 'quantity'))}</td>
                    <td className="cell-num">{fmtMoney(pick(i, 'unitCost'))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h3>Next step</h3></div>
          <div className="flow-actions">
            {status === 'DRAFT' && can(user, 'inventory.transfers.submit') && (
              <button className="btn btn-primary btn-block" disabled={busy} onClick={() => act('Submitted', `/api/ops/inventory/transfers/${id}/submit`)}>Submit for approval</button>
            )}
            {status === 'APPROVED' && can(user, 'inventory.transfers.complete') && (
              <button className="btn btn-success btn-block" disabled={busy} onClick={() => act('Completed — stock moved', `/api/ops/inventory/transfers/${id}/complete`)}>Complete transfer</button>
            )}
            {status === 'SUBMITTED' && <button className="btn btn-block" onClick={() => navigate('/approvals')}>Open approvals</button>}
            {['COMPLETED', 'CANCELLED'].includes(status) && <p className="muted">No further warehouse action.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

function AdjustmentDetail({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [items, setItems] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ data: { adjustment: Rec; items: Rec[] } }>(`/api/ops/inventory/adjustments/${id}`);
    setDoc(r.data.adjustment);
    setItems(r.data.items);
  }, [id]);

  useEffect(() => { load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load adjustment')); }, [load]);

  const act = async (label: string, path: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: '{}' });
      setNotice(label);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Loading adjustment…" />;
  const status = String(pick(doc, 'status') ?? '');

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/inventory/adjustments')}>Back</button>
          <h1>Adjustment <span className="cell-mono">{String(pick(doc, 'adjustmentNo'))}</span></h1>
          <p className="muted">{String(pick(doc, 'adjustmentType'))} · {String(pick(doc, 'reason') ?? '')}</p>
        </div>
        <Badge value={status} />
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="detail-grid">
        <section className="card">
          <div className="card-head"><h3>Count vs book</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Product</th><th>Warehouse</th><th className="cell-num">Expected</th><th className="cell-num">Counted</th><th className="cell-num">Variance</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={String(i.id)}>
                    <td><div className="cell-mono">{String(pick(i, 'productCode'))}</div>{String(pick(i, 'productName'))}</td>
                    <td className="cell-mono">{String(pick(i, 'warehouseCode'))}</td>
                    <td className="cell-num">{fmtNum(pick(i, 'expectedQty'))}</td>
                    <td className="cell-num">{fmtNum(pick(i, 'countedQty'))}</td>
                    <td className="cell-num">{fmtNum(pick(i, 'varianceQty'))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h3>Next step</h3></div>
          <div className="flow-actions">
            {status === 'DRAFT' && can(user, 'inventory.adjustments.submit') && (
              <button className="btn btn-primary btn-block" disabled={busy} onClick={() => act('Submitted', `/api/ops/inventory/adjustments/${id}/submit`)}>Submit for approval</button>
            )}
            {status === 'APPROVED' && can(user, 'inventory.adjustments.post') && (
              <button className="btn btn-success btn-block" disabled={busy} onClick={() => act('Posted to stock', `/api/ops/inventory/adjustments/${id}/post`)}>Post adjustment</button>
            )}
            {status === 'SUBMITTED' && <button className="btn btn-block" onClick={() => navigate('/approvals')}>Open approvals</button>}
            {status === 'POSTED' && <p className="muted">Posted. On-hand has been updated.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
