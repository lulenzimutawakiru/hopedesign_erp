import { useCallback, useEffect, useState } from 'react';
import { api, fmtNum, ListResult } from '../api';
import { useAuth, can } from '../auth';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';
import { toast } from '../components/toast';

type Rec = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

const RULE_TYPES = ['MIN_MAX', 'ROP', 'EOQ', 'FORECAST_DRIVEN'];

interface RuleForm {
  productId: string;
  warehouseId: string;
  ruleType: string;
  minQty: string;
  maxQty: string;
  reorderPoint: string;
  eoqQty: string;
  safetyStock: string;
  leadTimeDays: string;
  multipleQty: string;
  preferredSupplierId: string;
  isActive: boolean;
}

const emptyForm = (): RuleForm => ({
  productId: '',
  warehouseId: '',
  ruleType: 'MIN_MAX',
  minQty: '',
  maxQty: '',
  reorderPoint: '',
  eoqQty: '',
  safetyStock: '',
  leadTimeDays: '',
  multipleQty: '1',
  preferredSupplierId: '',
  isActive: true,
});

const toNum = (v: string) => (v.trim() === '' ? null : Number(v));

export default function ReorderingRules() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [products, setProducts] = useState<Rec[]>([]);
  const [warehouses, setWarehouses] = useState<Rec[]>([]);
  const [suppliers, setSuppliers] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<RuleForm>(emptyForm());

  const canCreate = can(user, 'inventory.reorder_rules.create');
  const canEdit = can(user, 'inventory.reorder_rules.update');
  const canDelete = can(user, 'inventory.reorder_rules.delete');
  const canOrder = can(user, 'procurement.requisitions.create');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api<{ data: Rec[] }>('/api/ops/inventory/reorder-rules')
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load reordering rules'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api<ListResult>('/api/inventory/items?pageSize=200').then((r) => setProducts(r.data ?? [])).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/inventory/warehouses').then((r) => setWarehouses(Array.isArray(r.data) ? r.data : [])).catch(() => undefined);
    api<ListResult>('/api/procurement/suppliers?pageSize=200').then((r) => setSuppliers(r.data ?? [])).catch(() => undefined);
  }, []);

  const openNew = () => {
    setEditingId(null);
    setForm(emptyForm());
    setOpen(true);
  };

  const openEdit = (r: Rec) => {
    setEditingId(n(r.id));
    setForm({
      productId: String(r.productId ?? ''),
      warehouseId: r.warehouseId != null ? String(r.warehouseId) : '',
      ruleType: String(r.ruleType ?? 'MIN_MAX'),
      minQty: r.minQty != null ? String(r.minQty) : '',
      maxQty: r.maxQty != null ? String(r.maxQty) : '',
      reorderPoint: r.reorderPoint != null ? String(r.reorderPoint) : '',
      eoqQty: r.eoqQty != null ? String(r.eoqQty) : '',
      safetyStock: r.safetyStock != null ? String(r.safetyStock) : '',
      leadTimeDays: r.leadTimeDays != null ? String(r.leadTimeDays) : '',
      multipleQty: r.multipleQty != null ? String(r.multipleQty) : '1',
      preferredSupplierId: r.preferredSupplierId != null ? String(r.preferredSupplierId) : '',
      isActive: r.isActive !== false,
    });
    setOpen(true);
  };

  const set = (k: keyof RuleForm, v: unknown) => setForm((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (!form.productId) { setError('Choose a product'); return; }
      const payload = {
        productId: Number(form.productId),
        warehouseId: form.warehouseId ? Number(form.warehouseId) : null,
        ruleType: form.ruleType || 'MIN_MAX',
        minQty: toNum(form.minQty),
        maxQty: toNum(form.maxQty),
        reorderPoint: toNum(form.reorderPoint),
        eoqQty: toNum(form.eoqQty),
        safetyStock: toNum(form.safetyStock),
        leadTimeDays: toNum(form.leadTimeDays),
        multipleQty: form.multipleQty ? Number(form.multipleQty) : 1,
        preferredSupplierId: form.preferredSupplierId ? Number(form.preferredSupplierId) : null,
        isActive: form.isActive,
      };
      if (editingId != null) {
        await api(`/api/ops/inventory/reorder-rules/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast.success('Reordering rule saved');
      } else {
        await api('/api/ops/inventory/reorder-rules', { method: 'POST', body: JSON.stringify(payload) });
        toast.success('Reordering rule created');
      }
      setOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: Rec) => {
    if (!window.confirm(`Delete the reordering rule for ${String(r.productCode ?? r.productName ?? 'this product')}?`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/inventory/reorder-rules/${r.id}`, { method: 'DELETE' });
      toast.success('Reordering rule deleted');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const order = async (r: Rec) => {
    const qty = r.recommendedQty != null ? n(r.recommendedQty) : 0;
    if (qty <= 0) return;
    setBusy(true);
    setError('');
    try {
      const res = await api<{ data: Rec }>('/api/ops/inventory/reorder-rules/order', {
        method: 'POST',
        body: JSON.stringify({
          productId: Number(r.productId),
          quantity: qty,
          warehouseId: r.warehouseId != null ? Number(r.warehouseId) : null,
          supplierId: r.preferredSupplierId != null ? Number(r.preferredSupplierId) : null,
        }),
      });
      const ref = String(res.data?.prNo ?? res.data?.requisitionNo ?? 'purchase requisition');
      toast.success(`Created ${ref} for ${fmtNum(qty)} ${String(r.unitCode ?? 'units')}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Order failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="inv">Inventory</p>
          <h1>Reordering Rules</h1>
          <p className="muted">Per-product replenishment: min/max, reorder point and order multiples. One click turns a rule into a purchase requisition.</p>
        </div>
        <div className="head-actions">
          {canCreate && <button className="btn btn-primary" onClick={openNew}>New rule</button>}
        </div>
      </header>

      {error && <ErrorBanner error={error} />}

      {loading ? <PageLoader variant="page" label="Loading reordering rules…" /> : (
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th>Rule</th>
                <th className="cell-num">Min</th>
                <th className="cell-num">Max</th>
                <th className="cell-num">On hand</th>
                <th className="cell-num">Order</th>
                <th>Warehouse</th>
                <th>Supplier</th>
                <th>Status</th>
                <th className="cell-num">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const qty = r.recommendedQty != null ? n(r.recommendedQty) : 0;
                return (
                  <tr key={String(r.id)}>
                    <td>
                      <div className="cell-mono">{String(r.productCode ?? '')}</div>
                      <div>{String(r.productName ?? '')}</div>
                      <div className="row-sub"><Badge value={r.productType} /></div>
                    </td>
                    <td>
                      <div><Badge value={r.ruleType} /></div>
                      <div className="muted">order multiple × {fmtNum(r.multipleQty ?? 1)}</div>
                    </td>
                    <td className="cell-num">{r.minQty != null ? fmtNum(r.minQty) : '—'}</td>
                    <td className="cell-num">{r.maxQty != null ? fmtNum(r.maxQty) : '—'}</td>
                    <td className="cell-num">{fmtNum(r.onHand)}</td>
                    <td className="cell-num">{qty > 0 ? fmtNum(qty) : <span className="muted">—</span>}</td>
                    <td>{r.warehouseCode ? <><div className="cell-mono">{String(r.warehouseCode)}</div><div className="muted">{String(r.warehouseName ?? '')}</div></> : <span className="muted">All</span>}</td>
                    <td>{String(r.supplierName ?? '—')}</td>
                    <td><Badge value={r.isActive === false ? 'INACTIVE' : 'ACTIVE'} /></td>
                    <td>
                      <div className="row-actions">
                        {qty > 0 && canOrder && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => order(r)}>Order</button>}
                        {canEdit && <button className="btn btn-sm" onClick={() => openEdit(r)}>Edit</button>}
                        {canDelete && <button className="btn btn-sm" onClick={() => remove(r)}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 28 }}>No reordering rules yet. Create one to automate replenishment.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <Modal title={editingId != null ? 'Edit reordering rule' : 'New reordering rule'} onClose={() => setOpen(false)} wide footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save rule'}</button>
          </>
        }>
          <div className="form-grid">
            <div className="field field-required">
              <label>Product</label>
              <select value={form.productId} onChange={(e) => set('productId', e.target.value)}>
                <option value="">— choose product —</option>
                {products.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.code)} · {String(p.name)}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Warehouse</label>
              <select value={form.warehouseId} onChange={(e) => set('warehouseId', e.target.value)}>
                <option value="">All warehouses</option>
                {warehouses.map((w) => <option key={String(w.id)} value={String(w.id)}>{String(w.code)} · {String(w.name)}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Rule type</label>
              <select value={form.ruleType} onChange={(e) => set('ruleType', e.target.value)}>
                {RULE_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Preferred supplier</label>
              <select value={form.preferredSupplierId} onChange={(e) => set('preferredSupplierId', e.target.value)}>
                <option value="">— none —</option>
                {suppliers.map((s) => <option key={String(s.id)} value={String(s.id)}>{String(s.code)} · {String(s.name)}</option>)}
              </select>
            </div>
            <NumField k="minQty" label="Minimum qty" form={form} set={set} />
            <NumField k="maxQty" label="Maximum qty" form={form} set={set} />
            <NumField k="reorderPoint" label="Reorder point" form={form} set={set} />
            <NumField k="eoqQty" label="EOQ qty" form={form} set={set} />
            <NumField k="safetyStock" label="Safety stock" form={form} set={set} />
            <NumField k="leadTimeDays" label="Lead time (days)" form={form} set={set} />
            <NumField k="multipleQty" label="Order multiple" form={form} set={set} />
            <div className="field">
              <label>Active</label>
              <select value={form.isActive ? 'true' : 'false'} onChange={(e) => set('isActive', e.target.value === 'true')}>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NumField({ k, label, form, set }: { k: keyof RuleForm; label: string; form: RuleForm; set: (k: keyof RuleForm, v: unknown) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="number" step="any" min={0} value={String(form[k] ?? '')} onChange={(e) => set(k, e.target.value)} />
    </div>
  );
}
