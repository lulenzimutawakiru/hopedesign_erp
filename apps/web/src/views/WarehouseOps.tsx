import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { pick } from '../helpers';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';

type Rec = Record<string, unknown>;

export function parseWarehouseOps(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'warehouse' && parts[1] === 'ops') return parts[2] ?? 'board';
  if (parts[0] === 'inventory') return parts[1] ?? 'ops';
  return 'ops';
}

export default function WarehouseOps({ path }: { path: string }) {
  const view = parseWarehouseOps(path);
  if (view === 'receive') return <InboundDesk />;
  if (view === 'pick') return <OutboundDesk />;
  if (view === 'issue') return <IssueDesk />;
  if (view === 'demand') return <DemandBoard />;
  if (view === 'putaway') return <PutawayDesk />;
  if (view === 'reservations') return <ReservationBoard />;
  return <OpsBoard />;
}

function OpsBoard() {
  const { user } = useAuth();
  const [work, setWork] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/inventory/work')
      .then((r) => setWork(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Work queue failed'));
  }, []);
  if (error && !work) return <ErrorBanner error={error} />;
  if (!work) return <PageLoader label="Loading warehouse work…" />;
  const inbound = (work.inbound ?? {}) as Rec;
  const outbound = (work.outbound ?? {}) as Rec;
  const production = (work.production ?? {}) as Rec;
  const reserved = (work.reserved ?? {}) as Rec;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="inv">Warehouse operations</p>
          <h1>Receive, put away, pick, issue</h1>
          <p className="muted">Procurement receipts, sales picks, and production issues — one floor, one stock ledger.</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-scan" onClick={() => navigate('/qr/scan')}>Scan QR</button>
          <button className="btn btn-ghost" onClick={() => navigate('/warehouse')}>Warehouse room</button>
          <button className="btn btn-ghost" onClick={() => navigate('/inventory/stock')}>Stock board</button>
          {can(user, 'inventory.transfers.create') && <button className="btn" onClick={() => navigate('/inventory/transfers/new')}>Transfer</button>}
          {can(user, 'inventory.adjustments.create') && <button className="btn" onClick={() => navigate('/inventory/adjustments/new')}>Count</button>}
        </div>
      </header>
      <div className="kpi-grid">
        <button className="kpi-card" onClick={() => navigate('/inventory/receive')}>
          <span className="kpi-label">Inbound (PO)</span>
          <span className="kpi-value">{fmtNum(pick(inbound, 'docs'))}</span>
          <span className="kpi-sub">{fmtNum(pick(inbound, 'units'))} units to receive</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/inventory/pick')}>
          <span className="kpi-label">Outbound (SO)</span>
          <span className="kpi-value">{fmtNum(pick(outbound, 'docs'))}</span>
          <span className="kpi-sub">{fmtNum(pick(outbound, 'units'))} units to pick</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/inventory/issue')}>
          <span className="kpi-label">Production issue</span>
          <span className="kpi-value">{fmtNum(pick(production, 'docs'))}</span>
          <span className="kpi-sub">{fmtNum(pick(production, 'units'))} materials remaining</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/inventory/reservations')}>
          <span className="kpi-label">Reserved</span>
          <span className="kpi-value">{fmtNum(pick(reserved, 'lines'))}</span>
          <span className="kpi-sub">{fmtNum(pick(reserved, 'units'))} units promised</span>
        </button>
        <button className={`kpi-card ${Number(work.lowStock) ? 'card-warn' : ''}`} onClick={() => navigate('/inventory/stock')}>
          <span className="kpi-label">Low stock</span>
          <span className="kpi-value">{fmtNum(work.lowStock)}</span>
          <span className="kpi-sub">At or below reorder</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/inventory/demand')}>
          <span className="kpi-label">Available to promise</span>
          <span className="kpi-value">ATP</span>
          <span className="kpi-sub">Sales + plant + incoming PO</span>
        </button>
      </div>
      <div className="do-now">
        <button onClick={() => navigate('/inventory/receive')}><strong>Receive PO</strong><span>Post a GRN into stock</span></button>
        <button onClick={() => navigate('/inventory/putaway')}><strong>Put away</strong><span>Move receipt to a bin</span></button>
        <button onClick={() => navigate('/inventory/pick')}><strong>Pick / dispatch</strong><span>Allocated sales orders</span></button>
        <button onClick={() => navigate('/inventory/issue')}><strong>Issue to plant</strong><span>Work-order materials</span></button>
        <button onClick={() => navigate('/inventory/demand')}><strong>Demand board</strong><span>ATP across modules</span></button>
        <button onClick={() => navigate('/qr/scan')}><strong>Scan</strong><span>Verify, move, count</span></button>
      </div>
    </div>
  );
}

function groupBy<T extends Rec>(rows: T[], key: string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = String(r[key] ?? '');
    const list = m.get(k) ?? [];
    list.push(r);
    m.set(k, list);
  }
  return m;
}

function InboundDesk() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [batch, setBatch] = useState<Record<string, string>>({});
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [ref, setRef] = useState('');

  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/inbound')
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Inbound failed'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const byPo = useMemo(() => groupBy(rows, 'poId'), [rows]);

  const receive = async (poId: number, lines: Rec[]) => {
    const today = new Date().toISOString().slice(0, 10);
    const items = lines.map((l) => {
      const key = String(l.poItemId);
      const expiryDate = expiry[key] || null;
      if (expiryDate && expiryDate < today) return null;
      return {
        poItemId: Number(l.poItemId),
        productId: Number(l.productId),
        quantityReceived: Number(qty[key] ?? l.remainingQty ?? 0),
        unitCost: Number(l.unitPrice ?? 0),
        batchNo: batch[key]?.trim() || null,
        expiryDate,
      };
    }).filter((i) => i !== null && i.quantityReceived > 0) as {
      poItemId: number; productId: number; quantityReceived: number; unitCost: number;
      batchNo: string | null; expiryDate: string | null;
    }[];
    if (!items.length) { setError('Enter a received quantity (expiry, if given, must be in the future)'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: { grnNo: string } }>('/api/ops/inventory/inbound/receive', {
        method: 'POST',
        body: JSON.stringify({ poId, deliveryRef: ref || null, items }),
      });
      setNotice(`Received ${r.data.grnNo} - ${items.length} line${items.length === 1 ? '' : 's'} posted to stock`);
      setQty({}); setBatch({}); setExpiry({});
      load();
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
          <p className="mod-kicker" data-mod="inv">Inbound</p>
          <h1>Receive purchase orders</h1>
          <p className="muted">Approved supplier POs. Receipt posts stock, a batch, and the inventory valuation.</p>
        </div>
        <button className="btn" onClick={() => navigate('/inventory/ops')}>Operations</button>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="field" style={{ maxWidth: 320, marginBottom: 12 }}>
        <label>Delivery / packing ref</label>
        <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Supplier DN / waybill" />
      </div>
      {rows.length === 0 && <p className="muted">No open purchase orders to receive.</p>}
      {[...byPo.entries()].map(([poId, lines]) => (
        <section className="card" key={poId}>
          <div className="card-head">
            <h3>
              <span className="cell-mono">{String(lines[0].poNo)}</span>
              {' - '}{String(lines[0].supplierName)}
            </h3>
            <Badge value={lines[0].status} />
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Product</th><th className="cell-num">Ordered</th><th className="cell-num">Received</th><th className="cell-num">Open</th><th className="cell-num">Receive now</th><th>Batch / lot</th><th>Expiry</th></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={String(l.poItemId)}>
                    <td><div className="cell-mono">{String(l.productCode)}</div>{String(l.productName)}</td>
                    <td className="cell-num">{fmtNum(l.quantity)}</td>
                    <td className="cell-num">{fmtNum(l.receivedQty)}</td>
                    <td className="cell-num">{fmtNum(l.remainingQty)}</td>
                    <td>
                      <input className="cell-input op-qty" style={{ fontSize: 16 }} inputMode="decimal" value={qty[String(l.poItemId)] ?? String(l.remainingQty ?? '')} onChange={(e) => setQty((p) => ({ ...p, [String(l.poItemId)]: e.target.value }))} />
                    </td>
                    <td>
                      <input className="cell-input" style={{ minWidth: 110 }} value={batch[String(l.poItemId)] ?? ''} onChange={(e) => setBatch((p) => ({ ...p, [String(l.poItemId)]: e.target.value }))} placeholder="Auto BT-..." />
                    </td>
                    <td>
                      <input type="date" className="cell-input" style={{ minWidth: 140 }} value={expiry[String(l.poItemId)] ?? ''} onChange={(e) => setExpiry((p) => ({ ...p, [String(l.poItemId)]: e.target.value }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {(() => {
                  const ordered = lines.reduce((s, l) => s + Number(l.quantity ?? 0), 0);
                  const received = lines.reduce((s, l) => s + Number(l.receivedQty ?? 0), 0);
                  const open = lines.reduce((s, l) => s + Number(l.remainingQty ?? 0), 0);
                  const receiving = lines.reduce((s, l) => s + (Number(qty[String(l.poItemId)] ?? l.remainingQty ?? 0) || 0), 0);
                  return (
                    <tr>
                      <td>PO total</td>
                      <td className="cell-num">{fmtNum(ordered)}</td>
                      <td className="cell-num">{fmtNum(received)}</td>
                      <td className="cell-num">{fmtNum(open)}</td>
                      <td className="cell-num"><strong>{fmtNum(receiving)}</strong></td>
                      <td colSpan={2} className="muted">Blank batch = auto-generated</td>
                    </tr>
                  );
                })()}
              </tfoot>
            </table>
          </div>
          {can(user, 'inventory.movements.create') && (
            <div className="flow-actions">
              <button className="btn btn-primary" disabled={busy} onClick={() => receive(Number(poId), lines)}>Post goods receipt</button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function OutboundDesk() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/outbound')
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Outbound failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const bySo = useMemo(() => groupBy(rows, 'orderId'), [rows]);

  const act = async (orderId: number, mode: 'allocate' | 'dispatch', lines: Rec[]) => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (mode === 'allocate') {
        await api(`/api/ops/inventory/outbound/allocate/${orderId}`, { method: 'POST', body: '{}' });
        setNotice('Allocated — stock reserved');
      } else {
        const items = lines.map((l) => ({
          orderItemId: Number(l.orderItemId),
          quantity: Number(qty[String(l.orderItemId)] ?? l.remainingQty ?? 0),
        })).filter((i) => i.quantity > 0);
        if (!items.length) throw new Error('Enter a pick quantity');
        const r = await api<{ data: { deliveryNo?: string } }>('/api/ops/inventory/outbound/dispatch', {
          method: 'POST',
          body: JSON.stringify({ orderId, items }),
        });
        setNotice(`Dispatched ${r.data.deliveryNo ?? 'delivery note'}`);
      }
      load();
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
          <p className="mod-kicker" data-mod="inv">Outbound</p>
          <h1>Pick and dispatch sales orders</h1>
          <p className="muted">Allocate reserved finished goods, then pick. Dispatch consumes the reservation and writes the delivery note.</p>
        </div>
        <button className="btn" onClick={() => navigate('/inventory/ops')}>Operations</button>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      {rows.length === 0 && <p className="muted">No open sales orders to pick.</p>}
      {[...bySo.entries()].map(([orderId, lines]) => (
        <section className="card" key={orderId}>
          <div className="card-head">
            <h3>
              <span className="cell-mono">{String(lines[0].orderNo)}</span>
              {' · '}{String(lines[0].customerName)}
            </h3>
            <Badge value={lines[0].status} />
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Product</th><th className="cell-num">Ordered</th><th className="cell-num">Allocated</th><th className="cell-num">Dispatched</th><th className="cell-num">Available</th><th className="cell-num">Pick</th></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={String(l.orderItemId)}>
                    <td><div className="cell-mono">{String(l.productCode)}</div>{String(l.productName)}</td>
                    <td className="cell-num">{fmtNum(l.quantity)}</td>
                    <td className="cell-num">{fmtNum(l.allocatedQty)}</td>
                    <td className="cell-num">{fmtNum(l.dispatchedQty)}</td>
                    <td className="cell-num">{fmtNum(l.availableQty)}</td>
                    <td>
                      <input className="cell-input" inputMode="decimal" value={qty[String(l.orderItemId)] ?? String(l.remainingQty ?? '')} onChange={(e) => setQty((p) => ({ ...p, [String(l.orderItemId)]: e.target.value }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flow-actions" style={{ flexDirection: 'row' }}>
            {can(user, 'inventory.reservations.create') && String(lines[0].status) === 'APPROVED' && (
              <button className="btn" disabled={busy} onClick={() => act(Number(orderId), 'allocate', lines)}>Allocate</button>
            )}
            {can(user, 'inventory.movements.create') && (
              <button className="btn btn-primary" disabled={busy} onClick={() => act(Number(orderId), 'dispatch', lines)}>Pick & dispatch</button>
            )}
            <button className="btn" onClick={() => navigate(`/sales/orders/${orderId}`)}>Open order</button>
          </div>
        </section>
      ))}
    </div>
  );
}

function IssueDesk() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [stock, setStock] = useState<Rec[]>([]);
  const [stockLine, setStockLine] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/production-issue')
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Production queue failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ data: { rows: Rec[] } }>('/api/ops/inventory/stock?pageSize=200')
      .then((r) => setStock(r.data.rows ?? []))
      .catch(() => setStock([]));
  }, []);
  const byWo = useMemo(() => groupBy(rows, 'workOrderId'), [rows]);
  const lineStock = (line: Rec) =>
    stock.filter((s) => Number(pick(s, 'productId')) === Number(pick(line, 'productId')) && Number(pick(s, 'availableQty')) > 0);

  const issue = async (workOrderId: number, line: Rec) => {
    const remaining = Number(line.remainingQty ?? 0);
    const available = Number(line.availableQty ?? 0);
    const quantity = Number(qty[String(line.materialId)] ?? Math.max(0, Math.min(remaining, available)));
    if (!(quantity > 0)) { setError('Enter an issue quantity'); return; }
    const chosen = lineStock(line).find((s) => String(pick(s, 'id')) === stockLine[String(line.materialId)]);
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/ops/inventory/production-issue', {
        method: 'POST',
        body: JSON.stringify({
          workOrderId,
          materialId: Number(line.materialId),
          quantity,
          warehouseId: chosen ? Number(pick(chosen, 'warehouseId')) : null,
          batchId: chosen ? Number(pick(chosen, 'batchId')) : null,
          binId: chosen ? Number(pick(chosen, 'binId')) : null,
        }),
      });
      setNotice(`Issued ${quantity} of ${String(line.productCode)} to ${String(line.woNo)}`);
      setStockLine((p) => ({ ...p, [String(line.materialId)]: '' }));
      load();
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
          <p className="mod-kicker" data-mod="mfg">Store issue</p>
          <h1>Issue materials to work orders</h1>
          <p className="muted">Pick the exact bin and batch, or leave on auto. Posts PRODUCTION_ISSUE and updates stock, batch and the work-order BOM.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/inventory/ops')}>Operations</button>
          <button className="btn btn-ghost" onClick={() => navigate('/warehouse')}>Warehouse room</button>
          <button className="btn btn-ghost" onClick={() => navigate('/inventory/stock')}>Stock board</button>
        </div>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      {rows.length === 0 && <p className="muted">No work orders waiting for material.</p>}
      {[...byWo.entries()].map(([woId, lines]) => (
        <section className="card" key={woId}>
          <div className="card-head">
            <h3>
              <span className="cell-mono">{String(lines[0].woNo)}</span>
              {' · '}{String(lines[0].fgCode)} {String(lines[0].fgName)}
            </h3>
            <Badge value={lines[0].status} />
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="cell-num">Required</th>
                  <th className="cell-num">Issued</th>
                  <th className="cell-num">On hand</th>
                  <th>From stock</th>
                  <th className="cell-num">Issue now</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const required = Number(l.requiredQty ?? 0);
                  const issued = Number(l.issuedQty ?? 0);
                  const remaining = Number(l.remainingQty ?? 0);
                  const available = Number(l.availableQty ?? 0);
                  const short = available < remaining;
                  const opts = lineStock(l);
                  const qtyDefault = Math.max(0, Math.min(remaining, available));
                  return (
                    <tr key={String(l.materialId)} className={short ? 'row-warn' : undefined}>
                      <td>
                        <div className="cell-mono">{String(l.productCode)}</div>
                        {String(l.productName)}
                        <div className="progress" style={{ marginTop: 8 }}>
                          <div
                            className="progress-fill"
                            style={{ width: `${required > 0 ? Math.min(100, (issued / required) * 100) : 0}%` }}
                          />
                        </div>
                        <div className="progress-hint">{fmtNum(issued)} of {fmtNum(required)} issued</div>
                      </td>
                      <td className="cell-num">{fmtNum(required)}</td>
                      <td className="cell-num">{fmtNum(issued)}</td>
                      <td className="cell-num">
                        {fmtNum(available)}
                        {short && <span className="badge badge-danger" style={{ marginLeft: 6 }}>short {fmtNum(Math.max(0, remaining - available))}</span>}
                      </td>
                      <td>
                        <select
                          className="cell-input"
                          value={stockLine[String(l.materialId)] ?? ''}
                          onChange={(e) => setStockLine((p) => ({ ...p, [String(l.materialId)]: e.target.value }))}
                        >
                          <option value="">Auto / any stock</option>
                          {opts.map((s) => (
                            <option key={String(pick(s, 'id'))} value={String(pick(s, 'id'))}>
                              {String(pick(s, 'warehouseCode'))} - {String(pick(s, 'binCode') ?? 'no bin')} - {String(pick(s, 'batchNo') ?? 'no batch')} - avail {fmtNum(pick(s, 'availableQty'))}
                            </option>
                          ))}
                        </select>
                        {opts.length === 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>No stock on hand</div>}
                      </td>
                      <td>
                        <input className="cell-input" inputMode="decimal" value={qty[String(l.materialId)] ?? String(qtyDefault)} onChange={(e) => setQty((p) => ({ ...p, [String(l.materialId)]: e.target.value }))} />
                      </td>
                      <td>
                        {can(user, 'inventory.movements.create') && (
                          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => issue(Number(woId), l)}>Issue</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function DemandBoard() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/demand')
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Demand board failed'));
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="inv">Planning</p>
          <h1>Available to promise</h1>
          <p className="muted">On hand − reserved + incoming PO + planned output − sales demand − plant demand.</p>
        </div>
        <button className="btn" onClick={() => navigate('/inventory/ops')}>Operations</button>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr>
              <th>Product</th>
              <th className="cell-num">On hand</th>
              <th className="cell-num">Reserved</th>
              <th className="cell-num">Available</th>
              <th className="cell-num">Sales</th>
              <th className="cell-num">Plant</th>
              <th className="cell-num">Incoming PO</th>
              <th className="cell-num">Planned</th>
              <th className="cell-num">ATP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const atp = Number(r.atp ?? 0);
              return (
                <tr key={String(r.productId)} className={atp < 0 ? 'row-warn' : undefined} onClick={() => navigate(`/inventory/items/${r.productId}`)}>
                  <td><div className="cell-mono">{String(r.code)}</div>{String(r.name)}</td>
                  <td className="cell-num">{fmtNum(r.onHand)}</td>
                  <td className="cell-num">{fmtNum(r.reserved)}</td>
                  <td className="cell-num">{fmtNum(r.available)}</td>
                  <td className="cell-num">{fmtNum(r.salesDemand)}</td>
                  <td className="cell-num">{fmtNum(r.productionDemand)}</td>
                  <td className="cell-num">{fmtNum(r.incomingPo)}</td>
                  <td className="cell-num">{fmtNum(r.plannedOutput)}</td>
                  <td className="cell-num"><strong>{fmtNum(r.atp)}</strong></td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>No demand or stock to net.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PutawayDesk() {
  const [warehouses, setWarehouses] = useState<Rec[]>([]);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [fromBins, setFromBins] = useState<Rec[]>([]);
  const [toBins, setToBins] = useState<Rec[]>([]);
  const [fromBinId, setFromBinId] = useState('');
  const [toBinId, setToBinId] = useState('');
  const [stockLine, setStockLine] = useState('');
  const [productLabel, setProductLabel] = useState('');
  const [qty, setQty] = useState('1');
  const [stock, setStock] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/warehouses').then((r) => setWarehouses(Array.isArray(r.data) ? r.data : [])).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!fromId) { setStock([]); setFromBins([]); return; }
    api<{ data: { rows: Rec[] } }>(`/api/ops/inventory/stock?warehouseId=${fromId}&pageSize=80`)
      .then((r) => setStock(r.data.rows ?? []))
      .catch(() => setStock([]));
    api<{ data: Rec[] }>(`/api/ops/inventory/bins?warehouseId=${fromId}`)
      .then((r) => setFromBins(Array.isArray(r.data) ? r.data : []))
      .catch(() => setFromBins([]));
  }, [fromId]);
  useEffect(() => {
    if (!toId) { setToBins([]); return; }
    api<{ data: Rec[] }>(`/api/ops/inventory/bins?warehouseId=${toId}`)
      .then((r) => setToBins(Array.isArray(r.data) ? r.data : []))
      .catch(() => setToBins([]));
  }, [toId]);

  const save = async () => {
    if (!fromId || !toId || !stockLine) { setError('Choose source, destination and the stock line to move'); return; }
    const row = stock.find((s) => String(s.id) === stockLine);
    if (!row) { setError('Stock line not found - reload the desk'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/ops/inventory/putaway', {
        method: 'POST',
        body: JSON.stringify({
          productId: Number(row.productId),
          quantity: Number(qty),
          fromWarehouseId: Number(fromId),
          toWarehouseId: Number(toId),
          fromBinId: fromBinId ? Number(fromBinId) : null,
          toBinId: toBinId ? Number(toBinId) : null,
          batchId: pick(row, 'batchId') != null ? Number(pick(row, 'batchId')) : null,
          reason: 'Put away',
        }),
      });
      setNotice('Put away posted');
      setStockLine(''); setProductLabel(''); setQty('1'); setFromBinId(''); setToBinId('');
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
          <p className="mod-kicker" data-mod="inv">Put away</p>
          <h1>Move receipt to storage</h1>
          <p className="muted">Two-leg transfer on the same ledger. Destination can be a finished-goods or secure store.</p>
        </div>
        <button className="btn" onClick={() => navigate('/inventory/ops')}>Operations</button>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required">
            <label>From warehouse</label>
            <select value={fromId} onChange={(e) => { setFromId(e.target.value); setStockLine(''); setProductLabel(''); setFromBinId(''); }}>
              <option value="">Select...</option>
              {warehouses.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(w.code)} - {String(w.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Source bin</label>
            <select value={fromBinId} onChange={(e) => setFromBinId(e.target.value)} disabled={!fromId}>
              <option value="">Auto / any bin</option>
              {fromBins.map((b) => <option key={String(b.id)} value={String(b.id)}>{String(b.code)}</option>)}
            </select>
          </div>
          <div className="field field-required">
            <label>To warehouse</label>
            <select value={toId} onChange={(e) => { setToId(e.target.value); setToBinId(''); }}>
              <option value="">Select...</option>
              {warehouses.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(w.code)} - {String(w.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Destination bin</label>
            <select value={toBinId} onChange={(e) => setToBinId(e.target.value)} disabled={!toId}>
              <option value="">Auto / default bin</option>
              {toBins.map((b) => <option key={String(b.id)} value={String(b.id)}>{String(b.code)}</option>)}
            </select>
          </div>
          <div className="field field-required">
            <label>Quantity</label>
            <input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
        </div>
        <div className="field field-required" style={{ marginTop: 12 }}>
          <label>Stock line at source</label>
          <select value={stockLine} onChange={(e) => {
            const row = stock.find((s) => String(s.id) === e.target.value);
            setStockLine(e.target.value);
            setProductLabel(row ? `${String(row.productCode)} - ${String(row.productName)}` : '');
            setFromBinId(row && pick(row, 'binId') != null ? String(pick(row, 'binId')) : '');
          }}>
            <option value="">{productLabel || 'Select stock line...'}</option>
            {stock.map((s) => (
              <option key={`${s.id}`} value={String(s.id)}>
                {String(s.productCode)} - {String(s.batchNo ?? s.binCode ?? 'no bin')} - avail {fmtNum(s.availableQty)}
              </option>
            ))}
          </select>
        </div>
        <div className="head-actions" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Posting...' : 'Post putaway'}</button>
        </div>
      </section>
    </div>
  );
}

function ReservationBoard() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/inventory/reservations')
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Reservations failed'));
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="inv">Reservations</p>
          <h1>Promised stock</h1>
          <p className="muted">Active sales allocations. Dispatch consumes them; they are not decoration.</p>
        </div>
        <button className="btn" onClick={() => navigate('/inventory/pick')}>Pick desk</button>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Product</th><th>Warehouse</th><th className="cell-num">Qty</th><th>Reference</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td><div className="cell-mono">{String(r.productCode)}</div>{String(r.productName)}</td>
                <td className="cell-mono">{String(r.warehouseCode ?? '—')}</td>
                <td className="cell-num">{fmtNum(r.quantity)}</td>
                <td className="cell-mono">{String(r.referenceType)} #{String(r.referenceId)}</td>
                <td><Badge value={r.status} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>Nothing reserved.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
