import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { Badge, ErrorBanner, Modal, Pager } from '../components/ui';
import { ConfirmDialog, Drawer, EmptyState, Skeleton } from '../components/os';
import { AssetModuleTabs, ModuleHeader, labelize, s } from './assetsShared';

type Rec = Record<string, unknown>;

const MAINT_TYPES = ['PREVENTIVE', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION', 'CALIBRATION', 'SERVICE', 'REPAIR'];
const MAINT_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const AUDIT_TYPES = ['ANNUAL', 'QUARTERLY', 'MONTHLY', 'DEPARTMENT', 'BRANCH', 'SPOT', 'HIGH_VALUE'];
const AUDIT_ITEM_RESULTS = ['VERIFIED', 'NOT_FOUND', 'WRONG_LOCATION', 'WRONG_CUSTODIAN', 'DAMAGED', 'TAG_MISSING', 'TAG_DAMAGED', 'UNEXPECTED'];
const DISPOSAL_REASONS = ['OBSOLETE', 'DAMAGED', 'BEYOND_REPAIR', 'SOLD', 'LOST', 'STOLEN', 'REPLACEMENT', 'END_OF_USEFUL_LIFE', 'OTHER'];
const DISPOSAL_METHODS = ['SALE', 'SCRAP', 'DONATION', 'RETURN_TO_SUPPLIER', 'WRITE_OFF', 'TRADE_IN'];
const IMPAIRMENT_TYPES = ['IMPAIRMENT', 'REVERSAL', 'REVALUATION'];
const DEP_METHODS = ['STRAIGHT_LINE', 'REDUCING_BALANCE', 'UNITS_OF_PRODUCTION', 'CUSTOM', 'NONE'];
const DEP_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'ANNUAL'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const CONDITIONS = ['NEW', 'EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'CRITICAL', 'UNDER_REPAIR', 'BEYOND_ECONOMIC_REPAIR'];
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function showVal(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function fetchRows(path: string): Promise<Rec[]> {
  const r = await api<{ data: unknown }>(path);
  const d = r.data;
  if (Array.isArray(d)) return d as Rec[];
  const rr = (d as Rec | null)?.rows;
  return Array.isArray(rr) ? (rr as Rec[]) : [];
}

export function MaintenanceFlow() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Rec | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; danger?: boolean; onConfirm: (reason: string) => Promise<void> } | null>(null);

  const load = useCallback(() => {
    setLoading(true); setError('');
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (search) p.set('search', search);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/assets/maintenance?${p.toString()}`)
      .then((r) => { setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Maintenance work orders failed'))
      .finally(() => setLoading(false));
  }, [status, search, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!detailId) { setDetail(null); return; }
    setBusy(true);
    api<{ data: Rec }>(`/api/ops/assets/maintenance/${detailId}`)
      .then((r) => setDetail(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Work order detail failed'))
      .finally(() => setBusy(false));
  }, [detailId]);

  const post = async (path: string, body: unknown) => {
    setBusy(true); setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      setDetailId(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
      setBusy(false);
    }
  };

  const st = s(detail?.status);

  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Asset maintenance"
        sub="Preventive, corrective, emergency and inspection work orders with parts issued from inventory, downtime and cost tracking."
        actions={can(user, 'assets.maintenance.create') ? <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>New work order</button> : undefined}
      />
      <AssetModuleTabs active="maintenance" />
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="mt-search">Search</label>
            <input id="mt-search" placeholder="WO number, asset, technician" value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setPage(1); }} />
          </div>
          <div className="field">
            <label htmlFor="mt-status">Status</label>
            <select id="mt-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">Any status</option>
              {['DRAFT', 'SUBMITTED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'CANCELLED'].map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <label>&nbsp;</label>
            <button className="btn" onClick={() => { setPage(1); load(); }}>Apply</button>
          </div>
        </div>
      </div>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="card-head"><h3>Maintenance work orders</h3></div>
        {loading && rows.length === 0 ? <Skeleton rows={6} /> : rows.length === 0 ? (
          <EmptyState title="No work orders" body="Work orders created here or raised from the asset record appear in this register." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>WO</th><th>Asset</th><th>Type</th><th>Priority</th><th>Status</th><th>Scheduled</th><th>Cost</th><th>Downtime</th><th>Technician</th><th></th></tr></thead>
              <tbody>
                {rows.map((wo) => (
                  <tr key={s(wo.id)}>
                    <td className="td-cell-mono">{s(wo.wo_no ?? wo.id)}</td>
                    <td><strong>{s(wo.asset_no)}</strong><br /><span className="muted">{s(wo.asset_name)}</span></td>
                    <td>{labelize(wo.maintenance_type)}</td>
                    <td>{labelize(wo.priority)}</td>
                    <td><Badge value={wo.status} /></td>
                    <td>{wo.scheduled_date ? fmtDate(wo.scheduled_date) : '-'}</td>
                    <td>{fmtMoney(wo.cost)}</td>
                    <td>{fmtNum(num(wo.downtime_hours))} h</td>
                    <td>{s(wo.technician_name) || '-'}</td>
                    <td className="td-actions">
                      {can(user, 'assets.maintenance.view') && <button className="btn btn-sm" onClick={() => setDetailId(num(wo.id))}>Open</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager" style={{ marginTop: 12 }}><Pager page={page} pageSize={pageSize} total={total} onPage={setPage} /></div>
      </section>
      {createOpen && <MaintenanceModal onClose={() => setCreateOpen(false)} onDone={() => { setCreateOpen(false); load(); }} />}
      {detail && (
        <Drawer title={`Work order ${s(detail.wo_no ?? detail.id)}`} onClose={() => setDetailId(null)} footer={
          <div className="quick-actions">
            {['DRAFT', 'SUBMITTED'].includes(st) && can(user, 'assets.maintenance.update') && <button className="btn" onClick={() => setEditTarget(detail)}>Edit</button>}
            {['DRAFT', 'SUBMITTED'].includes(st) && can(user, 'assets.maintenance.submit') && <button className="btn btn-primary" onClick={() => void post(`/api/ops/assets/maintenance/${detailId}/submit`, {})}>Submit</button>}
            {st === 'SUBMITTED' && can(user, 'assets.maintenance.approve') && <button className="btn btn-primary" onClick={() => void post(`/api/ops/assets/maintenance/${detailId}/approve`, {})}>Approve</button>}
            {['APPROVED', 'IN_PROGRESS'].includes(st) && can(user, 'assets.maintenance.complete') && <button className="btn btn-primary" onClick={() => setCompleteOpen(true)}>Complete</button>}
            {['DRAFT', 'SUBMITTED', 'APPROVED'].includes(st) && can(user, 'assets.maintenance.cancel') && <button className="btn btn-danger" onClick={() => setConfirm({
              title: 'Cancel work order',
              body: 'Cancel this work order? The reason is written to the audit trail.',
              label: 'Cancel work order',
              danger: true,
              onConfirm: (reason) => post(`/api/ops/assets/maintenance/${detailId}/cancel`, { reason: reason || undefined }),
            })}>Cancel</button>}
            <button className="btn" onClick={() => setDetailId(null)}>Close</button>
          </div>
        }>
          <div className="stack">
            <div className="callout callout-info">
              <strong>{labelize(detail.maintenance_type)}</strong> - <Badge value={detail.status} /> - priority {labelize(detail.priority)}
            </div>
            <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
              <div className="field"><label>Asset</label><strong>{s(detail.asset_no)} - {s(detail.asset_name)}</strong></div>
              <div className="field"><label>Location</label><span>{s(detail.location_name) || '-'}</span></div>
              <div className="field"><label>Scheduled</label><span>{detail.scheduled_date ? fmtDate(detail.scheduled_date) : '-'}</span></div>
              <div className="field"><label>Cost</label><strong>{fmtMoney(detail.cost)}</strong></div>
              <div className="field"><label>Downtime</label><span>{fmtNum(num(detail.downtime_hours))} hours</span></div>
              <div className="field"><label>Technician</label><span>{s(detail.technician_name) || '-'}</span></div>
              <div className="field"><label>Supplier</label><span>{s(detail.supplier_name) || '-'}</span></div>
              <div className="field"><label>Next maintenance</label><span>{detail.next_maintenance_date ? fmtDate(detail.next_maintenance_date) : '-'}</span></div>
            </div>
            {s(detail.description) && <p className="muted">{s(detail.description)}</p>}
            {busy ? <Skeleton rows={3} /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Part</th><th>Code</th><th>SKU</th><th>Qty</th><th>Unit cost</th><th>Total</th></tr></thead>
                  <tbody>
                    {(((detail.parts as Rec[]) ?? []).map((p) => (
                      <tr key={s(p.id)}>
                        <td>{s(p.product_name)}</td>
                        <td>{s(p.product_code)}</td>
                        <td>{s(p.product_sku)}</td>
                        <td>{fmtNum(num(p.qty))}</td>
                        <td>{fmtMoney(p.unit_cost)}</td>
                        <td>{fmtMoney(num(p.qty) * num(p.unit_cost))}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            )}
            {completeOpen && <CompleteModal wo={detail} onClose={() => setCompleteOpen(false)} onDone={() => { setCompleteOpen(false); setDetailId(null); load(); }} />}
            {editTarget && <MaintenanceModal wo={editTarget} onClose={() => setEditTarget(null)} onDone={() => { setEditTarget(null); setDetailId(null); load(); }} />}
          </div>
        </Drawer>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => void confirm.onConfirm(reason).finally(() => setConfirm(null))}
        />
      )}
    </div>
  );
}
/* ================= Maintenance work order create / edit ================= */

type PartRow = { productId: number | string; qty: number | string; unitCost: number | string };

function MaintenanceModal({ wo, onClose, onDone }: { wo?: Rec | null; onClose: () => void; onDone: () => void }) {
  const [assets, setAssets] = useState<Rec[]>([]);
  const [suppliers, setSuppliers] = useState<Rec[]>([]);
  const [products, setProducts] = useState<Rec[]>([]);
  const [assetId, setAssetId] = useState<string>(s(wo?.asset_id));
  const [maintenanceType, setMaintenanceType] = useState(s(wo?.maintenance_type) || 'PREVENTIVE');
  const [priority, setPriority] = useState(s(wo?.priority) || 'MEDIUM');
  const [scheduledDate, setScheduledDate] = useState(s(wo?.scheduled_date).slice(0, 10));
  const [cost, setCost] = useState(s(wo?.cost));
  const [downtimeHours, setDowntimeHours] = useState(s(wo?.downtime_hours));
  const [description, setDescription] = useState(s(wo?.description));
  const [nextMaintenanceDate, setNextMaintenanceDate] = useState(s(wo?.next_maintenance_date).slice(0, 10));
  const [supplierId, setSupplierId] = useState(s(wo?.supplier_id));
  const [parts, setParts] = useState<PartRow[]>(() =>
    Array.isArray((wo as Rec | null)?.parts)
      ? ((wo as Rec | null)?.parts as Rec[]).map((p) => ({
          productId: s(p.product_id),
          qty: s(p.qty),
          unitCost: s(p.unit_cost),
        }))
      : []
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (wo) return;
    fetchRows('/api/ops/assets?pageSize=200').then(setAssets).catch(() => undefined);
    fetchRows('/api/ops/inventory/stock?pageSize=200').then(setProducts).catch(() => undefined);
    api<{ data: unknown }>('/api/ops/procurement/suppliers')
      .then((r) => setSuppliers(Array.isArray(r.data) ? (r.data as Rec[]) : []))
      .catch(() => undefined);
  }, [wo]);

  const save = async () => {
    if (!wo && !Number(assetId)) {
      setError('Select the asset this work order is for.');
      return;
    }
    setBusy(true);
    setError('');
    const body: Rec = {
      maintenanceType,
      priority,
      scheduledDate: scheduledDate || undefined,
      cost: Number(cost) || 0,
      downtimeHours: Number(downtimeHours) || 0,
      description: description || undefined,
      nextMaintenanceDate: nextMaintenanceDate || undefined,
      supplierId: Number(supplierId) || undefined,
    };
    const cleanParts = parts
      .filter((p) => s(p.productId) !== '' && Number(p.qty) > 0)
      .map((p) => ({ productId: Number(p.productId), qty: Number(p.qty), unitCost: Number(p.unitCost) || undefined }));
    body.parts = cleanParts;
    if (!wo) body.assetId = Number(assetId);
    try {
      if (wo) {
        await api(`/api/ops/assets/maintenance/${s(wo.id)}/update`, { method: 'POST', body: JSON.stringify(body) });
      } else {
        await api('/api/ops/assets/maintenance', { method: 'POST', body: JSON.stringify(body) });
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setBusy(false);
    }
  };

  const updPart = (i: number, key: keyof PartRow, v: string) => {
    setParts((prev) => prev.map((p, idx) => {
      if (idx !== i) return p;
      const next = { ...p, [key]: v };
      if (key === 'productId') {
        const prod = products.find((pr) => s(pr.product_id) === v);
        if (prod && s(p.unitCost) === '') next.unitCost = s(prod.avg_cost);
      }
      return next;
    }));
  };

  return (
    <Modal
      title={wo ? `Edit work order ${s(wo.wo_no)}` : 'New maintenance work order'}
      onClose={onClose}
      wide
      footer={
        <div className="quick-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving...' : 'Save work order'}
          </button>
        </div>
      }
    >
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="form-grid">
          {!wo && (
            <div className="field">
              <label htmlFor="mm-asset">Asset</label>
              <select id="mm-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value="">Select asset...</option>
                {assets.map((a) => (
                  <option key={s(a.id)} value={s(a.id)}>{s(a.asset_no)} - {s(a.name)}</option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="mm-type">Maintenance type</label>
            <select id="mm-type" value={maintenanceType} onChange={(e) => setMaintenanceType(e.target.value)}>
              {MAINT_TYPES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="mm-prio">Priority</label>
            <select id="mm-prio" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {MAINT_PRIORITIES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="mm-sched">Scheduled date</label>
            <input id="mm-sched" type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="mm-cost">Cost (service)</label>
            <input id="mm-cost" type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="mm-dt">Downtime (hours)</label>
            <input id="mm-dt" type="number" min="0" step="0.5" value={downtimeHours} onChange={(e) => setDowntimeHours(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="mm-next">Next maintenance</label>
            <input id="mm-next" type="date" value={nextMaintenanceDate} onChange={(e) => setNextMaintenanceDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="mm-sup">Supplier</label>
            <select id="mm-sup" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">None</option>
              {suppliers.map((sp) => (
                <option key={s(sp.id)} value={s(sp.id)}>{s(sp.name)}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="mm-desc">Description</label>
          <textarea
            id="mm-desc"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Symptoms, scope of work, safety notes..."
          />
        </div>
        <div>
          <div className="card-head"><h4>Spare parts issued from inventory</h4></div>
          {products.length === 0 && <p className="muted">Parts can be added here when inventory stock is visible to your role.</p>}
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Part / product</th><th>Qty</th><th>Unit cost</th><th></th></tr></thead>
              <tbody>
                {parts.map((p, i) => (
                  <tr key={i}>
                    <td>
                      <select value={s(p.productId)} onChange={(e) => updPart(i, 'productId', e.target.value)}>
                        <option value="">Select product...</option>
                        {products.map((pr) => (
                          <option key={s(pr.product_id)} value={s(pr.product_id)}>
                            {s(pr.product_code)} - {s(pr.product_name)} ({fmtNum(num(pr.available_qty))} avail)
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number" min="0" step="1" value={s(p.qty)}
                        onChange={(e) => updPart(i, 'qty', e.target.value)} style={{ width: 90 }}
                      />
                    </td>
                    <td>
                      <input
                        type="number" min="0" step="0.01" value={s(p.unitCost)}
                        onChange={(e) => updPart(i, 'unitCost', e.target.value)} style={{ width: 120 }}
                        placeholder="stock avg cost"
                      />
                    </td>
                    <td>
                      <button className="btn btn-danger" onClick={() => setParts((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setParts((prev) => [...prev, { productId: '', qty: '1', unitCost: '' }])}>
            Add part row
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ================= Maintenance complete modal ================= */

function CompleteModal({ wo, onClose, onDone }: { wo: Rec; onClose: () => void; onDone: () => void }) {
  const [completedDate, setCompletedDate] = useState(new Date().toISOString().slice(0, 10));
  const [completedNote, setCompletedNote] = useState('');
  const [actualCost, setActualCost] = useState(s(wo.cost));
  const [downtimeHours, setDowntimeHours] = useState(s(wo.downtime_hours));
  const [nextMaintenanceDate, setNextMaintenanceDate] = useState('');
  const [condition, setCondition] = useState('GOOD');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/assets/maintenance/${s(wo.id)}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          completedDate: completedDate || undefined,
          completedNote: completedNote || undefined,
          actualCost: Number(actualCost) || 0,
          downtimeHours: Number(downtimeHours) || 0,
          nextMaintenanceDate: nextMaintenanceDate || undefined,
          condition,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Complete failed');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Complete work order ${s(wo.wo_no)}`}
      onClose={onClose}
      footer={
        <div className="quick-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Completing...' : 'Complete work order'}
          </button>
        </div>
      }
    >
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="callout callout-info">
          Completing this work order records the final cost (service + issued parts), restores the asset to service,
          and posts the finance journal entry for the maintenance spend.
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="cm-date">Completed date</label>
            <input id="cm-date" type="date" value={completedDate} onChange={(e) => setCompletedDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cm-cost">Actual cost</label>
            <input id="cm-cost" type="number" min="0" step="0.01" value={actualCost} onChange={(e) => setActualCost(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cm-dt">Downtime (hours)</label>
            <input id="cm-dt" type="number" min="0" step="0.5" value={downtimeHours} onChange={(e) => setDowntimeHours(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cm-next">Next maintenance</label>
            <input id="cm-next" type="date" value={nextMaintenanceDate} onChange={(e) => setNextMaintenanceDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cm-cond">Post-maintenance condition</label>
            <select id="cm-cond" value={condition} onChange={(e) => setCondition(e.target.value)}>
              {CONDITIONS.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="cm-note">Completion note</label>
          <textarea
            id="cm-note"
            rows={3}
            value={completedNote}
            onChange={(e) => setCompletedNote(e.target.value)}
            placeholder="Work performed, findings, follow-up required..."
          />
        </div>
      </div>
    </Modal>
  );
}
/* ================= Periodic asset audits ================= */

const AUDIT_EXCEPTION_TYPES = ['ASSET_NOT_FOUND', 'ASSET_DAMAGED', 'WRONG_LOCATION', 'WRONG_CUSTODIAN', 'TAG_MISSING', 'TAG_DAMAGED', 'UNEXPECTED_ASSET', 'SECURITY', 'OTHER'];

function scopeText(scope: unknown): string {
  if (!scope || typeof scope !== 'object') return '-';
  const sc = scope as Rec;
  const bits: string[] = [];
  if (s(sc.locationId)) bits.push(`location ${s(sc.locationId)}`);
  if (s(sc.departmentId)) bits.push(`dept ${s(sc.departmentId)}`);
  if (s(sc.branchId)) bits.push(`branch ${s(sc.branchId)}`);
  if (Array.isArray(sc.categoryIds) && sc.categoryIds.length) bits.push(`${sc.categoryIds.length} categor${(sc.categoryIds as unknown[]).length === 1 ? 'y' : 'ies'}`);
  if (sc.highValueOnly === true) bits.push('high value only');
  if (sc.includeRetired !== true) bits.push('excludes retired');
  return bits.length ? bits.join(', ') : 'All assets';
}

function AuditCreateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [departments, setDepartments] = useState<Rec[]>([]);
  const [locations, setLocations] = useState<Rec[]>([]);
  const [categories, setCategories] = useState<Rec[]>([]);
  const [auditType, setAuditType] = useState('ANNUAL');
  const [departmentId, setDepartmentId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [highValueOnly, setHighValueOnly] = useState(false);
  const [includeRetired, setIncludeRetired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchRows('/api/ops/hr/departments').then(setDepartments).catch(() => undefined);
    fetchRows('/api/assets/locations?pageSize=500').then(setLocations).catch(() => undefined);
    fetchRows('/api/assets/categories?pageSize=500').then(setCategories).catch(() => undefined);
  }, []);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/ops/assets/audits', {
        method: 'POST',
        body: JSON.stringify({
          auditType,
          departmentId: Number(departmentId) || undefined,
          locationId: Number(locationId) || undefined,
          categoryIds,
          highValueOnly,
          includeRetired,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
      setBusy(false);
    }
  };

  return (
    <Modal title="Create asset audit" onClose={onClose} wide footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
          {busy ? 'Creating...' : 'Create audit'}
        </button>
      </div>
    }>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="callout callout-info">
          The audit is created as a draft. Starting it generates the expected asset list from the scope below;
          auditors then scan assets and record exceptions before review and close.
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="au-type">Audit type</label>
            <select id="au-type" value={auditType} onChange={(e) => setAuditType(e.target.value)}>
              {AUDIT_TYPES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="au-dept">Department scope</label>
            <select id="au-dept" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">All departments</option>
              {departments.map((d) => <option key={s(d.id)} value={s(d.id)}>{s(d.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="au-loc">Location scope</label>
            <select id="au-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">All locations</option>
              {locations.map((l) => <option key={s(l.id)} value={s(l.id)}>{s(l.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="au-cats">Category scope (multi-select)</label>
            <select
              id="au-cats"
              multiple
              value={categoryIds.map(String)}
              onChange={(e) => setCategoryIds(Array.from(e.target.selectedOptions).map((o) => Number(o.value)))}
              style={{ minHeight: 110 }}
            >
              {categories.map((cat) => <option key={s(cat.id)} value={s(cat.id)}>{s(cat.name)}</option>)}
            </select>
          </div>
        </div>
        <div className="form-grid">
          <label className="check-line">
            <input type="checkbox" checked={highValueOnly} onChange={(e) => setHighValueOnly(e.target.checked)} />
            High-value assets only
          </label>
          <label className="check-line">
            <input type="checkbox" checked={includeRetired} onChange={(e) => setIncludeRetired(e.target.checked)} />
            Include disposed / retired assets
          </label>
        </div>
      </div>
    </Modal>
  );
}

function ExceptionModal({ auditId, items, onClose, onDone }: { auditId: number; items: Rec[]; onClose: () => void; onDone: () => void }) {
  const [exceptionType, setExceptionType] = useState('ASSET_NOT_FOUND');
  const [severity, setSeverity] = useState('MEDIUM');
  const [assetId, setAssetId] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!exceptionType) {
      setError('Exception type is required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/assets/audits/${auditId}/exceptions`, {
        method: 'POST',
        body: JSON.stringify({
          exceptionType,
          severity,
          assetId: Number(assetId) || undefined,
          description: description || undefined,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add exception failed');
      setBusy(false);
    }
  };

  return (
    <Modal title="Add audit exception" onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving...' : 'Add exception'}</button>
      </div>
    }>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ex-type">Exception type</label>
            <select id="ex-type" value={exceptionType} onChange={(e) => setExceptionType(e.target.value)}>
              {AUDIT_EXCEPTION_TYPES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ex-sev">Severity</label>
            <select id="ex-sev" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {SEVERITIES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ex-asset">Asset (optional)</label>
            <select id="ex-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">No asset</option>
              {items.map((it) => <option key={s(it.id)} value={s(it.asset_id)}>{s(it.asset_no)} - {s(it.asset_name)}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="ex-desc">Description</label>
          <textarea id="ex-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was found..." />
        </div>
      </div>
    </Modal>
  );
}

function ResolveExceptionModal({ exception, onClose, onDone }: { exception: Rec; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState('RESOLVED');
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (status === 'RESOLVED' && !resolution.trim()) {
      setError('A resolution note is required when resolving an exception.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/assets/exceptions/${s(exception.id)}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ status, resolution: resolution || undefined }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resolve failed');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Exception: ${s(exception.exception_type)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
      </div>
    }>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="rx-status">Outcome</label>
            <select id="rx-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="RESOLVED">Resolved</option>
              <option value="DISMISSED">Dismissed</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="rx-note">Resolution note</label>
          <textarea id="rx-note" rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="Required when resolving..." />
        </div>
      </div>
    </Modal>
  );
}

export function AuditsFlow() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Rec | null>(null);
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [auditType, setAuditType] = useState('');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const [itemBusy, setItemBusy] = useState<number | null>(null);
  const [itemNote, setItemNote] = useState<Rec>({});
  const [excOpen, setExcOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<Rec | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; danger?: boolean; onConfirm: (reason: string) => Promise<void> } | null>(null);

  const loadStats = useCallback(() => {
    api<{ data: Rec }>('/api/ops/assets/audits/dashboard')
      .then((r) => setStats(r.data))
      .catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (auditType) p.set('auditType', auditType);
    if (search) p.set('search', search);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/assets/audits?${p.toString()}`)
      .then((r) => { setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Audits failed'))
      .finally(() => setLoading(false));
  }, [status, auditType, search, page, pageSize]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!detailId) { setDetail(null); return; }
    setBusy(true);
    api<{ data: Rec }>(`/api/ops/assets/audits/${detailId}`)
      .then((r) => setDetail(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Audit detail failed'))
      .finally(() => setBusy(false));
  }, [detailId]);

  const post = async (path: string, body?: unknown) => {
    setBusy(true);
    setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      if (detailId) {
        const r = await api<{ data: Rec }>(`/api/ops/assets/audits/${detailId}`);
        setDetail(r.data);
      }
      load();
      loadStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const onItemResult = async (itemId: number, result: string) => {
    setItemBusy(itemId);
    setError('');
    try {
      await api(`/api/ops/assets/audits/${detailId}/items/${itemId}`, {
        method: 'POST',
        body: JSON.stringify({ result, note: s(itemNote[itemId]) || undefined }),
      });
      if (detailId) {
        const r = await api<{ data: Rec }>(`/api/ops/assets/audits/${detailId}`);
        setDetail(r.data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Item update failed');
    } finally {
      setItemBusy(null);
    }
  };

  const st = s(detail?.status);
  const items = ((detail?.items as Rec[]) ?? []);
  const exceptions = ((detail?.exceptions as Rec[]) ?? []);
  const summary = (detail?.summary as Rec | null) ?? null;
  const tile = (label: string, key: string) => (
    <div className="card card-pad" key={key}>
      <div className="stat-num">{fmtNum(num(stats?.[key]))}</div>
      <div className="muted">{label}</div>
    </div>
  );

  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Asset audits"
        sub="Annual, quarterly, department, branch and spot audits with mobile scanning, exceptions, review, approval and close."
        actions={can(user, 'assets.audits.create') ? <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>New audit</button> : undefined}
      />
      <AssetModuleTabs active="audits" />
      {stats && (
        <div className="grid-3" style={{ marginBottom: 14 }}>
          {tile('Assets expected', 'total_expected')}
          {tile('Verified', 'total_verified')}
          {tile('Not found', 'not_found')}
          {tile('Wrong location', 'wrong_location')}
          {tile('Wrong custodian', 'wrong_custodian')}
          {tile('Damaged', 'damaged')}
          {tile('Tag missing', 'tag_missing')}
          {tile('Unexpected', 'unexpected')}
          {tile('Pending review', 'pending_review')}
        </div>
      )}
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ad-search">Search</label>
            <input id="ad-search" placeholder="Audit no or scope" value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setPage(1); }} />
          </div>
          <div className="field">
            <label htmlFor="ad-status">Status</label>
            <select id="ad-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">Any status</option>
              {['DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'PENDING_REVIEW', 'APPROVED', 'CLOSED', 'CANCELLED'].map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ad-type">Audit type</label>
            <select id="ad-type" value={auditType} onChange={(e) => { setAuditType(e.target.value); setPage(1); }}>
              <option value="">Any type</option>
              {AUDIT_TYPES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <label>&nbsp;</label>
            <button className="btn" onClick={() => { setPage(1); load(); }}>Apply</button>
          </div>
        </div>
      </div>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="card-head"><h3>Audits</h3></div>
        {loading && rows.length === 0 ? <Skeleton rows={6} /> : rows.length === 0 ? (
          <EmptyState title="No audits" body="Create an audit to start tracking physical asset verification." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Audit no</th><th>Type</th><th>Status</th><th>Scope</th><th>Expected</th><th>Not found</th><th>Open exc.</th><th>Created by</th><th></th></tr></thead>
              <tbody>
                {rows.map((au) => (
                  <tr key={s(au.id)}>
                    <td className="td-cell-mono">{s(au.audit_no)}</td>
                    <td>{labelize(au.audit_type)}</td>
                    <td><Badge value={au.status} /></td>
                    <td className="muted">{scopeText(au.scope)}</td>
                    <td>{fmtNum(num(au.item_count))}</td>
                    <td>{fmtNum(num(au.not_found_count))}</td>
                    <td>{fmtNum(num(au.open_exceptions))}</td>
                    <td>{s(au.created_by_name)}</td>
                    <td><button className="link-btn" onClick={() => setDetailId(Number(au.id))}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager" style={{ marginTop: 12 }}><Pager page={page} pageSize={pageSize} total={total} onPage={setPage} /></div>
      </section>
      {createOpen && <AuditCreateModal onClose={() => setCreateOpen(false)} onDone={() => { setCreateOpen(false); load(); loadStats(); }} />}
      {detail && (
        <Drawer
          title={`Audit ${s(detail.audit_no)}`}
          onClose={() => setDetailId(null)}
          footer={
            <div className="quick-actions">
              {['DRAFT', 'SCHEDULED'].includes(st) && can(user, 'assets.audits.update') && <button className="btn btn-primary" onClick={() => void post(`/api/ops/assets/audits/${detailId}/start`)}>Start audit</button>}
              {st === 'IN_PROGRESS' && can(user, 'assets.audits.submit') && <button className="btn btn-primary" onClick={() => void post(`/api/ops/assets/audits/${detailId}/submit`)}>Submit for review</button>}
              {st === 'PENDING_REVIEW' && can(user, 'assets.audits.approve') && <button className="btn btn-primary" onClick={() => void post(`/api/ops/assets/audits/${detailId}/approve`)}>Approve</button>}
              {st === 'APPROVED' && can(user, 'assets.audits.close') && <button className="btn btn-primary" onClick={() => void post(`/api/ops/assets/audits/${detailId}/close`)}>Close audit</button>}
              {['DRAFT', 'SCHEDULED', 'IN_PROGRESS'].includes(st) && can(user, 'assets.audits.cancel') && <button className="btn btn-danger" onClick={() => setConfirm({
                title: 'Cancel audit',
                body: 'Cancel this audit? The reason is written to the audit trail.',
                label: 'Cancel audit',
                danger: true,
                onConfirm: (reason) => post(`/api/ops/assets/audits/${detailId}/cancel`, { reason: reason || undefined }),
              })}>Cancel</button>}
              {st === 'IN_PROGRESS' && can(user, 'assets.audits.update') && <button className="btn" onClick={() => setExcOpen(true)}>Add exception</button>}
              <button className="btn" onClick={() => setDetailId(null)}>Close</button>
            </div>
          }
        >
          <div className="stack">
            {busy ? <Skeleton rows={4} /> : (
              <div className="stack">
                <div className="callout callout-info">
                  <strong>{labelize(detail.audit_type)}</strong> - <Badge value={detail.status} /> - {scopeText(detail.scope)}
                </div>
                {summary && (
                  <div className="grid-3">
                    <div className="card card-pad"><div className="stat-num">{fmtNum(num(summary.pending))}</div><div className="muted">Pending</div></div>
                    <div className="card card-pad"><div className="stat-num">{fmtNum(num(summary.verified))}</div><div className="muted">Verified</div></div>
                    <div className="card card-pad"><div className="stat-num">{fmtNum(num(summary.not_found))}</div><div className="muted">Not found</div></div>
                    <div className="card card-pad"><div className="stat-num">{fmtNum(num(summary.wrong_location))}</div><div className="muted">Wrong location</div></div>
                    <div className="card card-pad"><div className="stat-num">{fmtNum(num(summary.wrong_custodian))}</div><div className="muted">Wrong custodian</div></div>
                    <div className="card card-pad"><div className="stat-num">{fmtNum(num(summary.damaged))}</div><div className="muted">Damaged</div></div>
                    <div className="card card-pad"><div className="stat-num">{fmtNum(num(summary.tag_issues))}</div><div className="muted">Tag issues</div></div>
                    <div className="card card-pad"><div className="stat-num">{fmtNum(num(summary.unexpected))}</div><div className="muted">Unexpected</div></div>
                  </div>
                )}
                <div>
                  <div className="card-head"><h4>Audit items ({items.length})</h4></div>
                  <div className="table-wrap">
                    <table className="data">
                      <thead><tr><th>Asset</th><th>Expected location</th><th>Actual location</th><th>Result</th><th>Note</th><th>Scanned by</th></tr></thead>
                      <tbody>
                        {items.map((it) => (
                          <tr key={s(it.id)}>
                            <td><span className="td-cell-mono">{s(it.asset_no)}</span> {s(it.asset_name)}</td>
                            <td>{s(it.expected_location_name) || '-'}</td>
                            <td>{s(it.actual_location_name) || '-'}</td>
                            <td>
                              {['IN_PROGRESS', 'PENDING_REVIEW'].includes(st) && can(user, 'assets.audit_items.update') ? (
                                <select
                                  value={s(it.result)}
                                  disabled={itemBusy === Number(it.id)}
                                  onChange={(e) => void onItemResult(Number(it.id), e.target.value)}
                                >
                                  {AUDIT_ITEM_RESULTS.map((r) => <option key={r} value={r}>{labelize(r)}</option>)}
                                </select>
                              ) : (
                                <Badge value={it.result} />
                              )}
                            </td>
                            <td>
                              {['IN_PROGRESS', 'PENDING_REVIEW'].includes(st) && can(user, 'assets.audit_items.update') ? (
                                <input
                                  value={s(itemNote[String(it.id)])}
                                  onChange={(e) => setItemNote((prev) => ({ ...prev, [String(it.id)]: e.target.value }))}
                                  onBlur={() => { if (s(it.result) && s(it.result) !== 'PENDING') void onItemResult(Number(it.id), s(it.result)); }}
                                  placeholder="Note..."
                                  style={{ minWidth: 140 }}
                                />
                              ) : (
                                <span className="muted">{s(it.note) || '-'}</span>
                              )}
                            </td>
                            <td>{s(it.scanned_by_name) || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div>
                  <div className="card-head"><h4>Exceptions ({exceptions.length})</h4></div>
                  <div className="table-wrap">
                    <table className="data">
                      <thead><tr><th>Type</th><th>Severity</th><th>Status</th><th>Asset</th><th>Description</th><th>Resolution</th><th>Resolved by</th><th></th></tr></thead>
                      <tbody>
                        {exceptions.map((ex) => (
                          <tr key={s(ex.id)}>
                            <td>{labelize(ex.exception_type)}</td>
                            <td><Badge value={ex.severity} /></td>
                            <td><Badge value={ex.status} /></td>
                            <td>{s(ex.asset_no) ? `${s(ex.asset_no)} - ${s(ex.asset_name)}` : '-'}</td>
                            <td className="muted">{s(ex.description) || '-'}</td>
                            <td className="muted">{s(ex.resolution) || '-'}</td>
                            <td>{s(ex.resolved_by_name) || '-'}</td>
                            <td>
                              {s(ex.status) === 'OPEN' && can(user, 'assets.audits.update') && (
                                <button className="link-btn" onClick={() => setResolveTarget(ex)}>Resolve</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
            {excOpen && <ExceptionModal auditId={Number(detailId)} items={items} onClose={() => setExcOpen(false)} onDone={() => { setExcOpen(false); if (detailId) void post(`/api/ops/assets/audits/${detailId}/exceptions`, undefined).then(() => setDetail(null)).catch(() => undefined); }} />}
            {resolveTarget && <ResolveExceptionModal exception={resolveTarget} onClose={() => setResolveTarget(null)} onDone={() => { setResolveTarget(null); if (detailId) { void post(`/api/ops/assets/audits/${detailId}/exceptions`, undefined).then(() => setDetail(null)).catch(() => undefined); } }} />}
          </div>
        </Drawer>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => void confirm.onConfirm(reason).finally(() => setConfirm(null))}
        />
      )}
    </div>
  );
}
// ---------------------------------------------------------------
// Depreciation: configuration, schedules, posting and period runs.
// ---------------------------------------------------------------
function DepSetupModal({ asset, onClose, onDone }: { asset: Rec | null; onClose: () => void; onDone: () => void }) {
  const [assets, setAssets] = useState<Rec[]>([]);
  const [assetId, setAssetId] = useState<string>(asset ? String(asset.id) : '');
  const [method, setMethod] = useState(s(asset?.method) || 'STRAIGHT_LINE');
  const [frequency, setFrequency] = useState(s(asset?.frequency) || 'MONTHLY');
  const [usefulLifeMonths, setUsefulLifeMonths] = useState(s(asset?.useful_life_months));
  const [residualValue, setResidualValue] = useState(s(asset?.residual_value));
  const [startDate, setStartDate] = useState(s(asset?.start_date).slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (asset) return;
    fetchRows('/api/ops/assets?pageSize=200').then(setAssets).catch(() => undefined);
  }, [asset]);

  const save = async () => {
    if (!Number(assetId)) { setError('Select the asset to configure.'); return; }
    if (method !== 'NONE' && !Number(usefulLifeMonths)) { setError('Useful life (months) is required unless method is NONE.'); return; }
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/${assetId}/depreciation/setup`, {
        method: 'POST',
        body: JSON.stringify({
          method,
          frequency,
          usefulLifeMonths: method === 'NONE' ? null : Number(usefulLifeMonths),
          residualValue: residualValue === '' ? undefined : Number(residualValue),
          startDate: startDate || undefined,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Depreciation setup failed');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={asset ? `Configure depreciation - ${s(asset.asset_no)}` : 'Configure depreciation'}
      onClose={onClose}
      footer={
        <div className="quick-actions">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving...' : 'Save configuration'}</button>
        </div>
      }
    >
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="form-grid">
          {!asset && (
            <div className="field">
              <label htmlFor="dp-asset">Asset</label>
              <select id="dp-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value="">Select asset...</option>
                {assets.map((a) => (
                  <option key={s(a.id)} value={s(a.id)}>{s(a.asset_no)} - {s(a.name)}</option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="dp-method">Method</label>
            <select id="dp-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              {DEP_METHODS.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="dp-freq">Frequency</label>
            <select id="dp-freq" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
              {DEP_FREQUENCIES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="dp-life">Useful life (months)</label>
            <input id="dp-life" type="number" min="1" value={usefulLifeMonths} onChange={(e) => setUsefulLifeMonths(e.target.value)} placeholder={method === 'NONE' ? 'Not required' : 'e.g. 60'} />
          </div>
          <div className="field">
            <label htmlFor="dp-res">Residual value</label>
            <input id="dp-res" type="number" min="0" step="0.01" value={residualValue} onChange={(e) => setResidualValue(e.target.value)} placeholder="0" />
          </div>
          <div className="field">
            <label htmlFor="dp-start">Depreciation start date</label>
            <input id="dp-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function DepPostModal({ assetId, assetNo, onClose, onDone }: { assetId: number; assetNo: string; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState('STRAIGHT_LINE');
  const [periodStart, setPeriodStart] = useState('');
  const [amount, setAmount] = useState('');
  const [unitsProduced, setUnitsProduced] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ data: Rec }>(`/api/ops/assets/depreciation/schedule/${assetId}`)
      .then((r) => {
        const cfg = r.data?.config as Rec | null;
        if (cfg) {
          setMethod(s(cfg.method));
          const last = s(cfg.last_posted_period).slice(0, 10);
          if (last) {
            const d = new Date(`${last}T00:00:00`);
            d.setUTCMonth(d.getUTCMonth() + 1);
            setPeriodStart(d.toISOString().slice(0, 10));
          }
        }
      })
      .catch(() => undefined);
  }, [assetId]);

  const save = async () => {
    setBusy(true); setError('');
    const body: Rec = { periodStart: periodStart || undefined };
    if (amount !== '') body.amount = Number(amount);
    if (unitsProduced !== '') body.unitsProduced = Number(unitsProduced);
    try {
      await api(`/api/ops/assets/${assetId}/depreciation/post`, { method: 'POST', body: JSON.stringify(body) });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Posting depreciation failed');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Post depreciation - ${assetNo}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Posting...' : 'Post entry'}</button>
      </div>
    }>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="callout callout-info">Method: <strong>{labelize(method)}</strong>. Leave amount blank to compute from the schedule.</div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="dpp-start">Period start</label>
            <input id="dpp-start" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="dpp-amt">Amount (override)</label>
            <input id="dpp-amt" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Auto" />
          </div>
          {method === 'UNITS_OF_PRODUCTION' && (
            <div className="field">
              <label htmlFor="dpp-units">Units produced</label>
              <input id="dpp-units" type="number" min="0" value={unitsProduced} onChange={(e) => setUnitsProduced(e.target.value)} />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function DepRunModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [periodStart, setPeriodStart] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Rec | null>(null);

  const run = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      const r = await api<{ data: Rec }>('/api/ops/assets/depreciation/run', {
        method: 'POST',
        body: JSON.stringify({ periodStart: periodStart || undefined }),
      });
      setResult(r.data ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Depreciation run failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Run depreciation" onClose={onClose} wide footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Close</button>
        {!result && <button className="btn btn-primary" onClick={() => void run()} disabled={busy}>{busy ? 'Running...' : 'Run for period'}</button>}
        {result && <button className="btn btn-primary" onClick={() => { onDone(); onClose(); }}>Done</button>}
      </div>
    }>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        {!result && (
          <div className="field">
            <label htmlFor="dpr-start">Period start</label>
            <input id="dpr-start" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            <p className="muted">Posts depreciation for every active configuration whose last posted period is before this date.</p>
          </div>
        )}
        {result && (
          <div className="stack">
            <div className="callout callout-info">
              Period <strong>{s(result.periodStart) || '-'}</strong> - <strong>{num(result.processed)}</strong> configuration(s) processed, <strong>{Array.isArray(result.posted) ? result.posted.length : 0}</strong> posted.
            </div>
            {Array.isArray(result.posted) && result.posted.length > 0 && (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Asset</th><th>Amount</th><th>Period</th></tr></thead>
                  <tbody>
                    {result.posted.map((p, i) => (
                      <tr key={i}>
                        <td>{s(p.assetNo)}</td>
                        <td>{fmtMoney(p.amount)}</td>
                        <td>{s(p.periodStart)} - {s(p.periodEnd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {Array.isArray(result.errors) && result.errors.length > 0 && (
              <div className="callout callout-info">
                <strong>{result.errors.length} error(s)</strong>
                <ul>
                  {result.errors.map((e2, i) => (
                    <li key={i}>{s(e2.assetNo)}: {s(e2.error)}</li>
                  ))}
                </ul>
              </div>
            )}
            {(!Array.isArray(result.posted) || result.posted.length === 0) && Array.isArray(result.errors) && result.errors.length === 0 && (
              <p className="muted">Nothing was posted for this period.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function DepScheduleDrawer({ assetId, onClose }: { assetId: number; onClose: () => void }) {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ data: Rec }>(`/api/ops/assets/depreciation/schedule/${assetId}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Schedule failed'))
  }, [assetId]);

  const cfg = (data?.config as Rec | null) ?? null;

  return (
    <Drawer title={`Depreciation schedule - ${s(data?.assetNo)}`} onClose={onClose}>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        {!data && !error && <Skeleton rows={6} />}
        {data && (
          <div className="stack">
            <div className="callout callout-info">
              {cfg ? (
                <span>{labelize(s(cfg.method))} - {labelize(s(cfg.frequency))} - life {fmtNum(num(cfg.useful_life_months))} months - residual {fmtMoney(cfg.residual_value)}</span>
              ) : <span>No depreciation configuration for this asset.</span>}
            </div>
            <h4>Posted entries</h4>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Period</th><th>Amount</th><th>Book value</th><th>Journal</th></tr></thead>
                <tbody>
                  {((data.posted as Rec[]) ?? []).map((p) => (
                    <tr key={s(p.id)}>
                      <td>{fmtDate(p.period_start)} - {fmtDate(p.period_end)}</td>
                      <td>{fmtMoney(p.amount)}</td>
                      <td>{fmtMoney(p.book_value)}</td>
                      <td>{s(p.gl_journal_id) || '-'}</td>
                    </tr>
                  ))}
                  {!Array.isArray(data.posted) || (data.posted as Rec[]).length === 0 ? (
                    <tr><td colSpan={4} className="muted">No entries posted yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <h4>Projected schedule</h4>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Period</th><th>Amount</th><th>Book value</th></tr></thead>
                <tbody>
                  {((data.projected as Rec[]) ?? []).map((p, i) => (
                    <tr key={i}>
                      <td>{fmtDate(p.periodStart)} - {fmtDate(p.periodEnd)}</td>
                      <td>{fmtMoney(p.amount)}</td>
                      <td>{fmtMoney(p.bookValue)}</td>
                    </tr>
                  ))}
                  {!Array.isArray(data.projected) || (data.projected as Rec[]).length === 0 ? (
                    <tr><td colSpan={3} className="muted">No projected entries.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
}

export function DepreciationFlow() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [method, setMethod] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupAsset, setSetupAsset] = useState<Rec | null>(null);
  const [postTarget, setPostTarget] = useState<Rec | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [scheduleId, setScheduleId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true); setError('');
    const p = new URLSearchParams();
    if (method) p.set('method', method);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/assets/depreciation?${p.toString()}`)
      .then((r) => { setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Depreciation list failed'))
      .finally(() => setLoading(false));
  }, [method, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Depreciation"
        sub="Configure depreciation methods, review schedules, post entries and run period batches. All entries post to Finance as source-of-truth journals."
        actions={
          <div className="quick-actions">
            {can(user, 'assets.depreciation.post') && <button className="btn" onClick={() => setRunOpen(true)}>Run depreciation</button>}
            {can(user, 'assets.depreciation.create') && <button className="btn btn-primary" onClick={() => setSetupOpen(true)}>Configure asset</button>}
          </div>
        }
      />
      <AssetModuleTabs active="depreciation" />
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="dp-method-filter">Method</label>
            <select id="dp-method-filter" value={method} onChange={(e) => { setMethod(e.target.value); setPage(1); }}>
              <option value="">All methods</option>
              {DEP_METHODS.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
        </div>
      </div>
      <section className="card">
        <div className="card-head">
          <strong>Depreciation configurations</strong>
          <span className="muted">{fmtNum(total)} asset(s)</span>
        </div>
        {error && <div style={{ padding: '0 16px' }}><ErrorBanner error={error} /></div>}
        {loading ? <Skeleton rows={8} /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Asset</th><th>Method</th><th>Frequency</th><th>Life</th><th>Residual</th><th>Cost</th><th>Accum. dep.</th><th>Book value</th><th>Capitalized</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={s(r.id)}>
                    <td className="td-cell-mono">{s(r.asset_no)}<div className="muted">{s(r.asset_name)}</div></td>
                    <td>{labelize(s(r.method))}</td>
                    <td>{labelize(s(r.frequency))}</td>
                    <td>{fmtNum(num(r.useful_life_months))} mo</td>
                    <td>{fmtMoney(r.residual_value)}</td>
                    <td>{fmtMoney(r.purchase_cost)}</td>
                    <td>{fmtMoney(r.accumulated_depreciation)}</td>
                    <td><strong>{fmtMoney(r.current_book_value)}</strong></td>
                    <td>{r.capitalization_date ? fmtDate(r.capitalization_date) : '-'}</td>
                    <td>
                      <div className="quick-actions">
                        <button className="link-btn" onClick={() => setScheduleId(num(r.asset_id))}>Schedule</button>
                        {can(user, 'assets.depreciation.create') && <button className="link-btn" onClick={() => setSetupAsset(r)}>Configure</button>}
                        {can(user, 'assets.depreciation.post') && <button className="link-btn" onClick={() => setPostTarget(r)}>Post entry</button>}
                      </div>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={10} className="muted">No depreciation configurations found.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager" style={{ marginTop: 12 }}><Pager page={page} pageSize={pageSize} total={total} onPage={setPage} /></div>
      </section>
      {setupOpen && <DepSetupModal asset={null} onClose={() => setSetupOpen(false)} onDone={() => { setSetupOpen(false); load(); }} />}
      {setupAsset && <DepSetupModal asset={setupAsset} onClose={() => setSetupAsset(null)} onDone={() => { setSetupAsset(null); load(); }} />}
      {postTarget && <DepPostModal assetId={num(postTarget.asset_id)} assetNo={s(postTarget.asset_no)} onClose={() => setPostTarget(null)} onDone={() => { setPostTarget(null); load(); }} />}
      {runOpen && <DepRunModal onClose={() => setRunOpen(false)} onDone={load} />}
      {scheduleId != null && <DepScheduleDrawer assetId={scheduleId} onClose={() => setScheduleId(null)} />}
    </div>
  );
}
// ---------------------------------------------------------------
// Disposal: controlled workflow with valuation, inspection,
// dual control for high-value assets and Finance review.
// ---------------------------------------------------------------
const DISPOSAL_STATUSES = ['DRAFT', 'SUBMITTED', 'VALUATION', 'INSPECTION', 'APPROVED', 'FINANCE_REVIEW', 'COMPLETED', 'REJECTED', 'CANCELLED'];
const STAGE_ORDER = ['SUBMITTED', 'VALUATION', 'INSPECTION', 'APPROVED', 'FINANCE_REVIEW'];

function DisposalModal({ d, onClose, onDone }: { d: Rec | null; onClose: () => void; onDone: () => void }) {
  const [assets, setAssets] = useState<Rec[]>([]);
  const [assetId, setAssetId] = useState<string>(d ? s(d.asset_id) : '');
  const [reason, setReason] = useState(s(d?.reason) || 'END_OF_USEFUL_LIFE');
  const [method, setMethod] = useState(s(d?.method) || 'SCRAP');
  const [valuation, setValuation] = useState(s(d?.valuation));
  const [disposalDate, setDisposalDate] = useState(s(d?.disposal_date).slice(0, 10));
  const [notes, setNotes] = useState(s(d?.notes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (d) return;
    fetchRows('/api/ops/assets?pageSize=200').then(setAssets).catch(() => undefined);
  }, [d]);

  const save = async () => {
    if (!d && !Number(assetId)) { setError('Select the asset to dispose.'); return; }
    setBusy(true); setError('');
    const body: Rec = {
      reason,
      method,
      valuation: valuation === '' ? undefined : Number(valuation),
      disposalDate: disposalDate || undefined,
      notes: notes || undefined,
    };
    if (!d) body.assetId = Number(assetId);
    try {
      if (d) {
        await api(`/api/ops/assets/disposals/${s(d.id)}/update`, { method: 'POST', body: JSON.stringify(body) });
      } else {
        await api('/api/ops/assets/disposals', { method: 'POST', body: JSON.stringify(body) });
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disposal save failed');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={d ? `Edit disposal ${s(d.disposal_no)}` : 'New disposal request'}
      onClose={onClose}
      footer={
        <div className="quick-actions">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving...' : 'Save disposal'}</button>
        </div>
      }
    >
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="form-grid">
          {!d && (
            <div className="field">
              <label htmlFor="dp-asset2">Asset</label>
              <select id="dp-asset2" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value="">Select asset...</option>
                {assets.map((a) => (
                  <option key={s(a.id)} value={s(a.id)}>{s(a.asset_no)} - {s(a.name)}</option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="dp-reason">Reason</label>
            <select id="dp-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              {DISPOSAL_REASONS.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="dp-method2">Method</label>
            <select id="dp-method2" value={method} onChange={(e) => setMethod(e.target.value)}>
              {DISPOSAL_METHODS.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="dp-valuation">Valuation / expected proceeds</label>
            <input id="dp-valuation" type="number" min="0" step="0.01" value={valuation} onChange={(e) => setValuation(e.target.value)} placeholder="0" />
          </div>
          <div className="field">
            <label htmlFor="dp-date2">Disposal date</label>
            <input id="dp-date2" type="date" value={disposalDate} onChange={(e) => setDisposalDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="dp-notes">Notes</label>
            <textarea id="dp-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reason context, approvals, buyer details..." />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function DisposalStageModal({ stage, disposal, onClose, onDone }: { stage: string; disposal: Rec; onClose: () => void; onDone: () => void }) {
  const [valuation, setValuation] = useState(s(disposal.valuation));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/disposals/${s(disposal.id)}/set-stage`, {
        method: 'POST',
        body: JSON.stringify({
          stage,
          valuation: ['VALUATION', 'INSPECTION'].includes(stage) && valuation !== '' ? Number(valuation) : undefined,
          notes: notes || undefined,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stage update failed');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Advance to ${labelize(stage)} - ${s(disposal.disposal_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving...' : 'Advance'}</button>
      </div>
    }>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="form-grid">
          {['VALUATION', 'INSPECTION'].includes(stage) && (
            <div className="field">
              <label htmlFor="ds-valuation">Valuation</label>
              <input id="ds-valuation" type="number" min="0" step="0.01" value={valuation} onChange={(e) => setValuation(e.target.value)} placeholder="0" />
            </div>
          )}
          <div className="field">
            <label htmlFor="ds-notes">Notes</label>
            <textarea id="ds-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Inspector, findings, supporting details..." />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function DisposalDrawer({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const [d, setD] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [stageTarget, setStageTarget] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; danger?: boolean; onConfirm: (reason: string) => Promise<void> } | null>(null);

  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/assets/disposals/${id}`)
      .then((r) => setD(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Disposal detail failed'));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const post = async (path: string, body: unknown) => {
    setBusy(true); setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      load(); onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  if (!d) {
    return (
      <Drawer title="Disposal" onClose={onClose}>
        {error ? <ErrorBanner error={error} /> : <Skeleton rows={8} />}
      </Drawer>
    );
  }

  const st = s(d.status);
  const stageIdx = STAGE_ORDER.indexOf(st);
  const nextStages = stageIdx >= 0 ? STAGE_ORDER.slice(stageIdx + 1) : [];
  const approvals = (d.approvals as Rec[]) ?? [];

  return (
    <Drawer
      title={`Disposal ${s(d.disposal_no)}`}
      onClose={onClose}
      footer={
        <div className="quick-actions">
          {st === 'DRAFT' && can(user, 'assets.disposals.update') && <button className="btn" onClick={() => setEditOpen(true)}>Edit</button>}
          {st === 'DRAFT' && can(user, 'assets.disposals.submit') && <button className="btn btn-primary" disabled={busy} onClick={() => void post(`/api/ops/assets/disposals/${id}/submit`, {})}>Submit</button>}
          {nextStages.map((stg) => (
            can(user, 'assets.disposals.update') ? (
              ['VALUATION', 'INSPECTION'].includes(stg) ? (
                <button key={stg} className="btn" disabled={busy} onClick={() => setStageTarget(stg)}>Stage: {labelize(stg)}</button>
              ) : (
                <button key={stg} className="btn" disabled={busy} onClick={() => void post(`/api/ops/assets/disposals/${id}/set-stage`, { stage: stg })}>Stage: {labelize(stg)}</button>
              )
            ) : null
          ))}
          {['SUBMITTED', 'VALUATION', 'INSPECTION', 'APPROVED', 'FINANCE_REVIEW'].includes(st) && can(user, 'assets.disposals.approve') && (
            <button className="btn btn-primary" disabled={busy} onClick={() => setConfirm({
              title: 'Process disposal',
              body: `Complete disposal ${s(d.disposal_no)}? This records the Finance entry, voids the asset QR tag and retires the asset.`,
              label: 'Process disposal',
              danger: true,
              onConfirm: (reason) => post(`/api/ops/assets/disposals/${id}/approve`, { reason: reason || undefined }),
            })}>Process disposal</button>
          )}
          {!['COMPLETED', 'REJECTED', 'CANCELLED'].includes(st) && can(user, 'assets.disposals.cancel') && (
            <button className="btn btn-danger" disabled={busy} onClick={() => setConfirm({
              title: 'Cancel disposal',
              body: 'Cancel this disposal request? The reason is recorded in the audit trail.',
              label: 'Cancel disposal',
              danger: true,
              onConfirm: (reason) => post(`/api/ops/assets/disposals/${id}/cancel`, { reason: reason || undefined }),
            })}>Cancel</button>
          )}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      }
    >
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="callout callout-info">
          <Badge value={d.status} /> - <strong>{labelize(s(d.reason))}</strong> via {labelize(s(d.method))}
        </div>
        {Boolean(d.requires_dual_control) && (
          <div className="notice-banner">This is a high-value asset and requires dual control. The approval workflow records every approver.</div>
        )}
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
          <div className="field"><label>Asset</label><strong>{s(d.asset_no)} - {s(d.asset_name)}</strong></div>
          <div className="field"><label>Book value</label><strong>{fmtMoney(d.book_value)}</strong></div>
          <div className="field"><label>Valuation</label><span>{fmtMoney(d.valuation)}</span></div>
          <div className="field"><label>Sale price</label><span>{fmtMoney(d.sale_price)}</span></div>
          <div className="field"><label>Disposal date</label><span>{d.disposal_date ? fmtDate(d.disposal_date) : '-'}</span></div>
          <div className="field"><label>Gain / loss</label><span>{d.gain_loss != null ? fmtMoney(d.gain_loss) : '-'}</span></div>
          <div className="field"><label>GL journal</label><span>{s(d.gl_journal_id) || '-'}</span></div>
          <div className="field"><label>Approved by</label><span>{s(d.approved_by_name) || '-'}</span></div>
        </div>
        {s(d.notes) && <p className="muted">{s(d.notes)}</p>}
        <h4>Approvals</h4>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Level</th><th>Decision</th><th>Approver</th><th>Date</th><th>Comment</th></tr></thead>
            <tbody>
              {approvals.map((a, i) => (
                <tr key={i}>
                  <td>{showVal(a.approval_level)}</td>
                  <td><Badge value={a.decision} /></td>
                  <td>{s(a.approver_name) || '-'}</td>
                  <td>{a.approved_at ? fmtDate(a.approved_at) : '-'}</td>
                  <td>{showVal(a.comment)}</td>
                </tr>
              ))}
              {approvals.length === 0 && <tr><td colSpan={5} className="muted">No approvals recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {editOpen && <DisposalModal d={d} onClose={() => setEditOpen(false)} onDone={() => { setEditOpen(false); load(); onChanged(); }} />}
        {stageTarget && <DisposalStageModal stage={stageTarget} disposal={d} onClose={() => setStageTarget(null)} onDone={() => { setStageTarget(null); load(); onChanged(); }} />}
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => void confirm.onConfirm(reason).finally(() => setConfirm(null))}
        />
      )}
    </Drawer>
  );
}

export function DisposalsFlow() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true); setError('');
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/assets/disposals?${p.toString()}`)
      .then((r) => { setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Disposal list failed'))
      .finally(() => setLoading(false));
  }, [status, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  const q = search.trim().toLowerCase();
  const shown = q
    ? rows.filter((r) => [s(r.disposal_no), s(r.asset_no), s(r.asset_name), s(r.reason)].some((v) => v.toLowerCase().includes(q)))
    : rows;

  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Asset disposal"
        sub="Controlled disposal workflow: request, valuation, inspection, approval, Finance review, accounting entry and asset retirement."
        actions={can(user, 'assets.disposals.create') ? <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>New disposal</button> : undefined}
      />
      <AssetModuleTabs active="disposal" />
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="disp-status">Status</label>
            <select id="disp-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All statuses</option>
              {DISPOSAL_STATUSES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="disp-search">Search current page</label>
            <input id="disp-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Disposal no, asset, reason" />
          </div>
        </div>
      </div>
      <section className="card">
        <div className="card-head">
          <strong>Disposal requests</strong>
          <span className="muted">{fmtNum(total)} total</span>
        </div>
        {error && <div style={{ padding: '0 16px' }}><ErrorBanner error={error} /></div>}
        {loading ? <Skeleton rows={8} /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Disposal no</th><th>Asset</th><th>Reason</th><th>Method</th><th>Valuation</th><th>Book value</th><th>Status</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={s(r.id)}>
                    <td className="td-cell-mono">{s(r.disposal_no)}</td>
                    <td>{s(r.asset_no)}<div className="muted">{s(r.asset_name)}</div></td>
                    <td>{labelize(s(r.reason))}</td>
                    <td>{labelize(s(r.method))}</td>
                    <td>{fmtMoney(r.valuation)}</td>
                    <td>{fmtMoney(r.book_value)}</td>
                    <td><Badge value={r.status} />{Boolean(r.requires_dual_control) && <span className="muted"> dual</span>}</td>
                    <td>{r.created_at ? fmtDate(r.created_at) : '-'}</td>
                    <td><button className="link-btn" onClick={() => setDetailId(num(r.id))}>Open</button></td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={9} className="muted">No disposal requests found.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager" style={{ marginTop: 12 }}><Pager page={page} pageSize={pageSize} total={total} onPage={setPage} /></div>
      </section>
      {createOpen && <DisposalModal d={null} onClose={() => setCreateOpen(false)} onDone={() => { setCreateOpen(false); load(); }} />}
      {detailId != null && <DisposalDrawer id={detailId} onClose={() => setDetailId(null)} onChanged={load} />}
    </div>
  );
}
// ---------------------------------------------------------------
// Impairment / reversal / revaluation and scan-anomaly queue.
// ---------------------------------------------------------------
const IMP_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REJECTED'];
const ANOMALY_STATUSES = ['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED'];

function ImpairmentModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [assets, setAssets] = useState<Rec[]>([]);
  const [assetId, setAssetId] = useState('');
  const [impairmentType, setImpairmentType] = useState('IMPAIRMENT');
  const [oldBookValue, setOldBookValue] = useState('');
  const [newBookValue, setNewBookValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchRows('/api/ops/assets?pageSize=200').then(setAssets).catch(() => undefined);
  }, []);

  const save = async () => {
    if (!Number(assetId)) { setError('Select the asset.'); return; }
    if (newBookValue === '') { setError('New book value is required.'); return; }
    setBusy(true); setError('');
    try {
      await api('/api/ops/assets/impairments', {
        method: 'POST',
        body: JSON.stringify({
          assetId: Number(assetId),
          impairmentType,
          oldBookValue: oldBookValue === '' ? undefined : Number(oldBookValue),
          newBookValue: Number(newBookValue),
          reason: reason || undefined,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Impairment creation failed');
      setBusy(false);
    }
  };

  return (
    <Modal title="New impairment / reversal / revaluation" onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving...' : 'Create record'}</button>
      </div>
    }>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="imp-asset">Asset</label>
            <select id="imp-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">Select asset...</option>
              {assets.map((a) => (
                <option key={s(a.id)} value={s(a.id)}>{s(a.asset_no)} - {s(a.name)}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="imp-type">Type</label>
            <select id="imp-type" value={impairmentType} onChange={(e) => setImpairmentType(e.target.value)}>
              {IMPAIRMENT_TYPES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="imp-old">Old book value (optional)</label>
            <input id="imp-old" type="number" min="0" step="0.01" value={oldBookValue} onChange={(e) => setOldBookValue(e.target.value)} placeholder="Defaults to current" />
          </div>
          <div className="field">
            <label htmlFor="imp-new">New book value</label>
            <input id="imp-new" type="number" min="0" step="0.01" value={newBookValue} onChange={(e) => setNewBookValue(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="imp-reason">Reason</label>
            <textarea id="imp-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Valuation basis, evidence, reference..." />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ImpairmentDrawer({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const [d, setD] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; danger?: boolean; onConfirm: (reason: string) => Promise<void> } | null>(null);

  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/assets/impairments/${id}`)
      .then((r) => setD(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Impairment detail failed'));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const post = async (path: string, body: unknown) => {
    setBusy(true); setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      load(); onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  if (!d) {
    return (
      <Drawer title="Impairment" onClose={onClose}>
        {error ? <ErrorBanner error={error} /> : <Skeleton rows={8} />}
      </Drawer>
    );
  }

  const st = s(d.status);
  const oldV = num(d.old_book_value);
  const newV = num(d.new_book_value);

  return (
    <Drawer
      title={`${labelize(s(d.impairment_type))} ${s(d.impairment_no)}`}
      onClose={onClose}
      footer={
        <div className="quick-actions">
          {st === 'DRAFT' && can(user, 'assets.impairments.submit') && <button className="btn btn-primary" disabled={busy} onClick={() => void post(`/api/ops/assets/impairments/${id}/submit`, {})}>Submit</button>}
          {['DRAFT', 'SUBMITTED', 'APPROVED'].includes(st) && can(user, 'assets.impairments.approve') && (
            <button className="btn btn-primary" disabled={busy} onClick={() => setConfirm({
              title: 'Approve and post impairment',
              body: `Apply ${labelize(s(d.impairment_type))} ${s(d.impairment_no)}? The book value changes and the Finance journal is posted.`,
              label: 'Approve and post',
              danger: true,
              onConfirm: (reason) => post(`/api/ops/assets/impairments/${id}/approve`, { reason: reason || undefined }),
            })}>Approve</button>
          )}
          {!['POSTED', 'REJECTED'].includes(st) && can(user, 'assets.impairments.cancel') && (
            <button className="btn btn-danger" disabled={busy} onClick={() => setConfirm({
              title: 'Cancel impairment',
              body: 'Reject this impairment record? The reason is recorded in the audit trail.',
              label: 'Cancel impairment',
              danger: true,
              onConfirm: (reason) => post(`/api/ops/assets/impairments/${id}/cancel`, { reason: reason || undefined }),
            })}>Cancel</button>
          )}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      }
    >
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="callout callout-info"><Badge value={d.status} /> - {labelize(s(d.impairment_type))}</div>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
          <div className="field"><label>Asset</label><strong>{s(d.asset_no)} - {s(d.asset_name)}</strong></div>
          <div className="field"><label>Old book value</label><span>{fmtMoney(d.old_book_value)}</span></div>
          <div className="field"><label>New book value</label><strong>{fmtMoney(d.new_book_value)}</strong></div>
          <div className="field"><label>Delta</label><span>{fmtMoney(newV - oldV)}</span></div>
          <div className="field"><label>GL journal</label><span>{showVal(d.gl_journal_id)}</span></div>
          <div className="field"><label>Created</label><span>{d.created_at ? fmtDate(d.created_at) : '-'}</span></div>
        </div>
        {s(d.reason) && <p className="muted">{s(d.reason)}</p>}
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => void confirm.onConfirm(reason).finally(() => setConfirm(null))}
        />
      )}
    </Drawer>
  );
}

export function ImpairmentsFlow() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true); setError('');
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (type) p.set('type', type);
    if (search) p.set('search', search);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/assets/impairments?${p.toString()}`)
      .then((r) => { setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Impairment list failed'))
      .finally(() => setLoading(false));
  }, [status, type, search, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Impairment, reversal and revaluation"
        sub="Adjust asset book values through an approved workflow. Approvals post the Finance journal and update the register."
        actions={can(user, 'assets.impairments.create') ? <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>New impairment</button> : undefined}
      />
      <AssetModuleTabs active="impairment" />
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="imp-status">Status</label>
            <select id="imp-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All statuses</option>
              {IMP_STATUSES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="imp-type2">Type</label>
            <select id="imp-type2" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
              <option value="">All types</option>
              {IMPAIRMENT_TYPES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="imp-search">Search</label>
            <input id="imp-search" type="search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Impairment no, asset no or name" />
          </div>
        </div>
      </div>
      <section className="card">
        <div className="card-head"><strong>Impairment records</strong><span className="muted">{fmtNum(total)} total</span></div>
        {error && <div style={{ padding: '0 16px' }}><ErrorBanner error={error} /></div>}
        {loading ? <Skeleton rows={8} /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Impairment no</th><th>Asset</th><th>Type</th><th>Old value</th><th>New value</th><th>Status</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={s(r.id)}>
                    <td className="td-cell-mono">{s(r.impairment_no)}</td>
                    <td>{s(r.asset_no)}<div className="muted">{s(r.asset_name)}</div></td>
                    <td>{labelize(s(r.impairment_type))}</td>
                    <td>{fmtMoney(r.old_book_value)}</td>
                    <td><strong>{fmtMoney(r.new_book_value)}</strong></td>
                    <td><Badge value={r.status} /></td>
                    <td>{r.created_at ? fmtDate(r.created_at) : '-'}</td>
                    <td><button className="link-btn" onClick={() => setDetailId(num(r.id))}>Open</button></td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={8} className="muted">No impairment records found.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager" style={{ marginTop: 12 }}><Pager page={page} pageSize={pageSize} total={total} onPage={setPage} /></div>
      </section>
      {createOpen && <ImpairmentModal onClose={() => setCreateOpen(false)} onDone={() => { setCreateOpen(false); load(); }} />}
      {detailId != null && <ImpairmentDrawer id={detailId} onClose={() => setDetailId(null)} onChanged={load} />}
    </div>
  );
}

function AnomalyResolveModal({ a, onClose, onDone }: { a: Rec; onClose: () => void; onDone: () => void }) {
  const [resolutionNote, setResolutionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!resolutionNote.trim()) { setError('A resolution note is required so the decision is auditable.'); return; }
    setBusy(true); setError('');
    try {
      await api(`/api/ops/assets/anomalies/${s(a.id)}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolutionNote }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resolution failed');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Resolve anomaly - ${s(a.asset_no)}`} onClose={onClose} footer={
      <div className="quick-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving...' : 'Resolve anomaly'}</button>
      </div>
    }>
      <div className="stack">
        {error && <ErrorBanner error={error} />}
        <div className="callout callout-info"><Badge value={a.anomaly_type} /> - severity {labelize(s(a.severity))}</div>
        {s(a.description) && <p className="muted">{s(a.description)}</p>}
        <div className="field">
          <label htmlFor="an-res">Resolution note</label>
          <textarea id="an-res" rows={4} value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} placeholder="What happened, what was verified and what corrective action was taken..." />
        </div>
      </div>
    </Modal>
  );
}

export function AnomaliesFlow() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [resolveTarget, setResolveTarget] = useState<Rec | null>(null);

  const load = useCallback(() => {
    setLoading(true); setError('');
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    p.set('pageSize', '200');
    api<{ data: unknown }>(`/api/ops/assets/anomalies?${p.toString()}`)
      .then((r) => setRows(Array.isArray(r.data) ? (r.data as Rec[]) : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Anomaly list failed'))
      .finally(() => setLoading(false));
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const shown = severity
    ? rows.filter((r) => s(r.severity) === severity)
    : rows;
  const openCount = rows.filter((r) => ['OPEN', 'REVIEWING'].includes(s(r.status))).length;

  return (
    <div className="page">
      <ModuleHeader
        kicker="Asset management"
        title="Scan anomaly queue"
        sub="Suspicious scan activity detected by the tracking engine: incompatible locations, voided tags, unexecuted transfers and high-value movement."
      />
      <AssetModuleTabs active="anomalies" />
      <div className="grid-3" style={{ marginBottom: 14 }}>
        <div className="card card-pad"><div className="stat-num">{fmtNum(rows.length)}</div><div className="muted">Total anomalies (last 200)</div></div>
        <div className="card card-pad"><div className="stat-num">{fmtNum(openCount)}</div><div className="muted">Open or under review</div></div>
        <div className="card card-pad"><div className="stat-num">{fmtNum(rows.filter((r) => s(r.status) === 'RESOLVED').length)}</div><div className="muted">Resolved</div></div>
      </div>
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="an-status">Status</label>
            <select id="an-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {ANOMALY_STATUSES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="an-sev">Severity</label>
            <select id="an-sev" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">All severities</option>
              {SEVERITIES.map((x) => <option key={x} value={x}>{labelize(x)}</option>)}
            </select>
          </div>
        </div>
      </div>
      <section className="card">
        <div className="card-head"><strong>Anomalies</strong><span className="muted">{fmtNum(shown.length)} shown</span></div>
        {error && <div style={{ padding: '0 16px' }}><ErrorBanner error={error} /></div>}
        {loading ? <Skeleton rows={8} /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Type</th><th>Severity</th><th>Asset</th><th>Description</th><th>Status</th><th>Detected</th><th>Resolved by</th><th>Resolution note</th><th></th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={s(r.id)}>
                    <td>{labelize(s(r.anomaly_type))}</td>
                    <td><Badge value={r.severity} /></td>
                    <td>{s(r.asset_no)}<div className="muted">{s(r.asset_name)}</div></td>
                    <td className="muted">{s(r.description) || '-'}</td>
                    <td><Badge value={r.status} /></td>
                    <td>{r.created_at ? fmtDate(r.created_at) : '-'}</td>
                    <td>{s(r.resolved_by_name) || '-'}</td>
                    <td className="muted">{s(r.resolution_note) || '-'}</td>
                    <td>{['OPEN', 'REVIEWING'].includes(s(r.status)) && can(user, 'assets.anomalies.resolve') ? <button className="link-btn" onClick={() => setResolveTarget(r)}>Resolve</button> : null}</td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={9} className="muted">No anomalies found.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {resolveTarget && <AnomalyResolveModal a={resolveTarget} onClose={() => setResolveTarget(null)} onDone={() => { setResolveTarget(null); load(); }} />}
    </div>
  );
}
