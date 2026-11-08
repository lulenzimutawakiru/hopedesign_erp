import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';

type Rec = Record<string, unknown>;

/**
 * Odoo "Purchase" parity — the sourcing records that exist in the schema but
 * were never surfaced: vendor price lists, supplier contracts (purchase
 * agreements), supplier evaluations, and the purchase analysis report.
 */

const str = (v: unknown) => (v == null ? '' : String(v));
const day = (v: unknown) => (v ? String(v).slice(0, 10) : '-');

const TABS: [string, string][] = [
  ['vendor-pricelists', 'Vendor Pricelists'],
  ['supplier-contracts', 'Contracts'],
  ['supplier-evaluations', 'Evaluations'],
  ['purchase-analysis', 'Analysis'],
];

function SourcingTabs({ active }: { active: string }) {
  return (
    <div className="otc-tabs">
      {TABS.map(([key, label]) => (
        <button key={key} className={`tab ${active === key ? 'active' : ''}`} onClick={() => navigate('/buy/' + key)}>{label}</button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field"><label>{label}</label>{children}</div>;
}

// ---------------------------------------------------------------------------
// Vendor price lists
// ---------------------------------------------------------------------------

interface PricelistForm { supplierId: string; productId: string; unitPrice: string; currency: string; effectiveFrom: string; effectiveTo: string; leadTimeDays: string; minimumOrderQty: string; notes: string }

function PricelistForm({ meta, initial, onSave, onClose }: { meta: Rec; initial: Rec | null; onSave: (b: Rec) => Promise<void>; onClose: () => void }) {
  const [f, setF] = useState<PricelistForm>(() => ({
    supplierId: initial ? String(initial.supplierId ?? '') : '',
    productId: initial ? String(initial.productId ?? '') : '',
    unitPrice: initial ? String(initial.unitPrice ?? '') : '',
    currency: initial ? String(initial.currency ?? 'UGX') : 'UGX',
    effectiveFrom: initial ? day(initial.effectiveFrom) : '',
    effectiveTo: initial ? day(initial.effectiveTo) : '',
    leadTimeDays: initial ? String(initial.leadTimeDays ?? '') : '',
    minimumOrderQty: initial ? String(initial.minimumOrderQty ?? '') : '',
    notes: initial ? String(initial.notes ?? '') : '',
  }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof PricelistForm, v: string) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setErr('');
    if (!f.supplierId || !f.productId || !f.unitPrice.trim()) { setErr('Supplier, product and unit price are required.'); return; }
    const body: Rec = {
      supplierId: Number(f.supplierId), productId: Number(f.productId), unitPrice: Number(f.unitPrice),
      currency: f.currency.trim() || 'UGX',
      effectiveFrom: f.effectiveFrom || null, effectiveTo: f.effectiveTo || null,
      leadTimeDays: f.leadTimeDays.trim() === '' ? null : Number(f.leadTimeDays),
      minimumOrderQty: f.minimumOrderQty.trim() === '' ? 0 : Number(f.minimumOrderQty),
      notes: f.notes.trim() || null,
    };
    setBusy(true);
    try { await onSave(body); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const suppliers = (meta.suppliers as Rec[]) ?? [];
  const products = (meta.products as Rec[]) ?? [];
  return (
    <Modal title={initial ? 'Edit vendor price' : 'New vendor price'} onClose={onClose}
      footer={<div className="action-group">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>}>
      {err && <ErrorBanner error={err} />}
      <div className="form-grid">
        <Field label="Supplier">
          <select value={f.supplierId} onChange={(e) => set('supplierId', e.target.value)}>
            <option value="">Select supplier…</option>
            {suppliers.map((s) => <option key={String(s.id)} value={String(s.id)}>{str(s.name)}</option>)}
          </select>
        </Field>
        <Field label="Product">
          <select value={f.productId} onChange={(e) => set('productId', e.target.value)}>
            <option value="">Select product…</option>
            {products.map((p) => <option key={String(p.id)} value={String(p.id)}>{str(p.code)} — {str(p.name)}</option>)}
          </select>
        </Field>
        <Field label="Unit price"><input type="number" step="any" value={f.unitPrice} onChange={(e) => set('unitPrice', e.target.value)} /></Field>
        <Field label="Currency"><input value={f.currency} onChange={(e) => set('currency', e.target.value)} /></Field>
        <Field label="Effective from"><input type="date" value={f.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} /></Field>
        <Field label="Effective to"><input type="date" value={f.effectiveTo} onChange={(e) => set('effectiveTo', e.target.value)} /></Field>
        <Field label="Lead time (days)"><input type="number" step="any" value={f.leadTimeDays} onChange={(e) => set('leadTimeDays', e.target.value)} /></Field>
        <Field label="Minimum order qty"><input type="number" step="any" value={f.minimumOrderQty} onChange={(e) => set('minimumOrderQty', e.target.value)} /></Field>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Notes</label><input value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      </div>
    </Modal>
  );
}

function VendorPricelists({ meta }: { meta: Rec }) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Rec | null>(null);
  const [creating, setCreating] = useState(false);
  const canEdit = can(user, 'procurement.suppliers.update');
  const load = useCallback(() => {
    api<{ data: { rows: Rec[]; totalCount: number } }>('/api/ops/procurement/vendor-pricelists?pageSize=500')
      .then((r) => { setRows(r.data.rows ?? []); setTotal(r.data.totalCount ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const save = async (b: Rec) => {
    if (editing) await api(`/api/ops/procurement/vendor-pricelists/${editing.id}`, { method: 'PATCH', body: JSON.stringify(b) });
    else await api('/api/ops/procurement/vendor-pricelists', { method: 'POST', body: JSON.stringify(b) });
    setEditing(null); setCreating(false); load();
  };
  return (
    <div>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <span className="muted">{fmtNum(total)} prices</span>
        {canEdit && <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => { setEditing(null); setCreating(true); }}>New price</button>}
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Supplier</th><th>Product</th><th className="cell-num">Unit price</th><th>Currency</th><th>Effective</th><th className="cell-num">Lead (d)</th><th className="cell-num">MOQ</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className={canEdit ? 'row-click' : ''} onClick={() => canEdit && setEditing(r)}>
                <td className="td-strong">{str(r.supplierName)}</td>
                <td><span className="cell-mono">{str(r.productCode)}</span> <span className="cell-sub">{str(r.productName)}</span></td>
                <td className="cell-num">{fmtMoney(r.unitPrice)}</td>
                <td>{str(r.currency)}</td>
                <td>{day(r.effectiveFrom)}{r.effectiveTo ? ` → ${day(r.effectiveTo)}` : ''}</td>
                <td className="cell-num">{r.leadTimeDays == null ? '-' : fmtNum(r.leadTimeDays)}</td>
                <td className="cell-num">{r.minimumOrderQty == null ? '-' : fmtNum(r.minimumOrderQty)}</td>
                <td>{canEdit && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>Edit</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No vendor prices recorded.</td></tr>}
          </tbody>
        </table>
      </div>
      {(creating || editing) && <PricelistForm meta={meta} initial={editing} onSave={save} onClose={() => { setCreating(false); setEditing(null); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplier contracts
// ---------------------------------------------------------------------------

interface ContractForm { supplierId: string; contractNo: string; title: string; startDate: string; endDate: string; value: string; terms: string; status: string }

function ContractForm({ meta, initial, onSave, onClose }: { meta: Rec; initial: Rec | null; onSave: (b: Rec) => Promise<void>; onClose: () => void }) {
  const [f, setF] = useState<ContractForm>(() => ({
    supplierId: initial ? String(initial.supplierId ?? '') : '',
    contractNo: initial ? String(initial.contractNo ?? '') : '',
    title: initial ? String(initial.title ?? '') : '',
    startDate: initial ? day(initial.startDate) : '',
    endDate: initial ? day(initial.endDate) : '',
    value: initial ? String(initial.value ?? '') : '',
    terms: initial ? String(initial.terms ?? '') : '',
    status: initial ? String(initial.status ?? 'DRAFT') : 'DRAFT',
  }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof ContractForm, v: string) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setErr('');
    if (!f.supplierId || !f.contractNo.trim() || !f.title.trim() || !f.startDate) { setErr('Supplier, number, title and start date are required.'); return; }
    const body: Rec = {
      supplierId: Number(f.supplierId), contractNo: f.contractNo.trim(), title: f.title.trim(),
      startDate: f.startDate, endDate: f.endDate || null,
      value: f.value.trim() === '' ? 0 : Number(f.value), terms: f.terms.trim() || null, status: f.status,
    };
    setBusy(true);
    try { await onSave(body); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const suppliers = (meta.suppliers as Rec[]) ?? [];
  return (
    <Modal title={initial ? 'Edit contract' : 'New supplier contract'} onClose={onClose}
      footer={<div className="action-group">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>}>
      {err && <ErrorBanner error={err} />}
      <div className="form-grid">
        <Field label="Supplier">
          <select value={f.supplierId} onChange={(e) => set('supplierId', e.target.value)}>
            <option value="">Select supplier…</option>
            {suppliers.map((s) => <option key={String(s.id)} value={String(s.id)}>{str(s.name)}</option>)}
          </select>
        </Field>
        <Field label="Contract number"><input value={f.contractNo} onChange={(e) => set('contractNo', e.target.value)} /></Field>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Title</label><input value={f.title} onChange={(e) => set('title', e.target.value)} /></div>
        <Field label="Start date"><input type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></Field>
        <Field label="End date"><input type="date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} /></Field>
        <Field label="Value"><input type="number" step="any" value={f.value} onChange={(e) => set('value', e.target.value)} /></Field>
        <Field label="Status">
          <select value={f.status} onChange={(e) => set('status', e.target.value)}>
            {['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Terms</label><textarea rows={3} value={f.terms} onChange={(e) => set('terms', e.target.value)} /></div>
      </div>
    </Modal>
  );
}

function SupplierContracts({ meta }: { meta: Rec }) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Rec | null>(null);
  const [creating, setCreating] = useState(false);
  const canCreate = can(user, 'procurement.contracts.create');
  const canEdit = can(user, 'procurement.contracts.update');
  const load = useCallback(() => {
    api<{ data: { rows: Rec[]; totalCount: number } }>('/api/ops/procurement/supplier-contracts?pageSize=500')
      .then((r) => { setRows(r.data.rows ?? []); setTotal(r.data.totalCount ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const save = async (b: Rec) => {
    if (editing) await api(`/api/ops/procurement/supplier-contracts/${editing.id}`, { method: 'PATCH', body: JSON.stringify(b) });
    else await api('/api/ops/procurement/supplier-contracts', { method: 'POST', body: JSON.stringify(b) });
    setEditing(null); setCreating(false); load();
  };
  return (
    <div>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <span className="muted">{fmtNum(total)} contracts</span>
        {canCreate && <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => { setEditing(null); setCreating(true); }}>New contract</button>}
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Contract</th><th>Supplier</th><th>Period</th><th className="cell-num">Value</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className={canEdit ? 'row-click' : ''} onClick={() => canEdit && setEditing(r)}>
                <td><span className="cell-mono">{str(r.contractNo)}</span><span className="cell-sub">{str(r.title)}</span></td>
                <td className="td-strong">{str(r.supplierName)}</td>
                <td>{day(r.startDate)}{r.endDate ? ` → ${day(r.endDate)}` : ''}</td>
                <td className="cell-num">{fmtMoney(r.value)}</td>
                <td><Badge value={r.status} /></td>
                <td>{canEdit && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>Edit</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No supplier contracts.</td></tr>}
          </tbody>
        </table>
      </div>
      {(creating || editing) && <ContractForm meta={meta} initial={editing} onSave={save} onClose={() => { setCreating(false); setEditing(null); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplier evaluations
// ---------------------------------------------------------------------------

function Evaluations({ meta }: { meta: Rec }) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const canEval = can(user, 'procurement.suppliers.evaluate');
  const [form, setForm] = useState({ supplierId: '', quality: '', delivery: '', price: '', compliance: '', overall: '', comments: '' });
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');
  const load = useCallback(() => {
    api<{ data: { rows: Rec[]; totalCount: number } }>('/api/ops/procurement/supplier-evaluations?pageSize=500')
      .then((r) => { setRows(r.data.rows ?? []); setTotal(r.data.totalCount ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const submit = async () => {
    setFormErr('');
    if (!form.supplierId) { setFormErr('Select a supplier.'); return; }
    const score = (v: string) => (v.trim() === '' ? null : Number(v));
    const body: Rec = {
      supplierId: Number(form.supplierId),
      qualityScore: score(form.quality), deliveryScore: score(form.delivery),
      priceScore: score(form.price), complianceScore: score(form.compliance), overallScore: score(form.overall),
      comments: form.comments.trim() || null,
    };
    setBusy(true);
    try {
      await api('/api/ops/procurement/supplier-evaluations', { method: 'POST', body: JSON.stringify(body) });
      setCreating(false);
      setForm({ supplierId: '', quality: '', delivery: '', price: '', compliance: '', overall: '', comments: '' });
      load();
    } catch (e) { setFormErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const suppliers = (meta.suppliers as Rec[]) ?? [];
  const scoreCell = (v: unknown) => (v == null ? <span className="muted">-</span> : fmtNum(v));
  return (
    <div>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <span className="muted">{fmtNum(total)} evaluations</span>
        {canEval && <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>New evaluation</button>}
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Supplier</th><th className="cell-num">Quality</th><th className="cell-num">Delivery</th><th className="cell-num">Price</th><th className="cell-num">Compliance</th><th className="cell-num">Overall</th><th>Evaluated by</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="td-strong">{str(r.supplierName)}</td>
                <td className="cell-num">{scoreCell(r.qualityScore)}</td>
                <td className="cell-num">{scoreCell(r.deliveryScore)}</td>
                <td className="cell-num">{scoreCell(r.priceScore)}</td>
                <td className="cell-num">{scoreCell(r.complianceScore)}</td>
                <td className="cell-num"><span className="td-strong">{scoreCell(r.overallScore)}</span></td>
                <td>{str(r.evaluatedByName)}<span className="cell-sub">{day(r.evaluatedAt)}</span></td>
                <td>{r.comments ? <span className="cell-sub">{str(r.comments)}</span> : null}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No evaluations yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && (
        <Modal title="New supplier evaluation" onClose={() => setCreating(false)}
          footer={<div className="action-group">
            <button className="btn" onClick={() => setCreating(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>}>
          {formErr && <ErrorBanner error={formErr} />}
          <div className="form-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>Supplier</label>
              <select value={form.supplierId} onChange={(e) => setForm((p) => ({ ...p, supplierId: e.target.value }))}>
                <option value="">Select supplier…</option>
                {suppliers.map((s) => <option key={String(s.id)} value={String(s.id)}>{str(s.name)}</option>)}
              </select>
            </div>
            {([['quality', 'Quality'], ['delivery', 'Delivery'], ['price', 'Price'], ['compliance', 'Compliance'], ['overall', 'Overall']] as const).map(([k, label]) => (
              <Field key={k} label={label + ' score'}><input type="number" step="0.01" value={form[k]} onChange={(e) => setForm((p) => ({ ...p, [k]: e.target.value }))} /></Field>
            ))}
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>Comments</label><textarea rows={3} value={form.comments} onChange={(e) => setForm((p) => ({ ...p, comments: e.target.value }))} /></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Purchase analysis
// ---------------------------------------------------------------------------

function Analysis() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const qs = [fromDate && 'fromDate=' + fromDate, toDate && 'toDate=' + toDate].filter(Boolean).join('&');
  const load = useCallback(() => {
    api<{ data: Rec }>('/api/ops/procurement/purchase-analysis' + (qs ? '?' + qs : ''))
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed'));
  }, [qs]);
  useEffect(() => { load(); }, [load]);
  const totals = (data?.totals ?? {}) as Rec;
  const bySupplier = (data?.bySupplier ?? []) as Rec[];
  const byProduct = (data?.byProduct ?? []) as Rec[];
  const render = (rows: Rec[], cols: [string, string][]) => (
    <div className="table-wrap card">
      <table className="data">
        <thead><tr>{cols.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={String(r.id ?? i)}>
              {cols.map(([k]) => (
                <td key={k} className={k === 'amount' || k === 'quantity' || k === 'orderCount' ? 'cell-num' : ''}>
                  {k === 'amount' ? <strong>{fmtMoney(r.amount)}</strong> : k === 'quantity' ? fmtNum(r.quantity) : k === 'orderCount' ? fmtNum(r.orderCount) : str(r[k])}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={cols.length} className="muted" style={{ textAlign: 'center', padding: 24 }}>No orders in range.</td></tr>}
        </tbody>
      </table>
    </div>
  );
  return (
    <div>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="muted">From</span><input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="muted">To</span><input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
        <span className="muted" style={{ marginLeft: 'auto' }}>{fmtNum(totals.orders)} orders · {fmtNum(totals.quantity)} units · <strong>{fmtMoney(totals.amount)}</strong></span>
      </div>
      <div className="detail-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div>
          <div className="card-head" style={{ padding: '12px 16px 0' }}><h3>By supplier</h3></div>
          {render(bySupplier, [['name', 'Supplier'], ['orderCount', 'Orders'], ['quantity', 'Qty'], ['amount', 'Amount']])}
        </div>
        <div>
          <div className="card-head" style={{ padding: '12px 16px 0' }}><h3>By product</h3></div>
          {render(byProduct, [['name', 'Product'], ['orderCount', 'Orders'], ['quantity', 'Qty'], ['amount', 'Amount']])}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function SupplierSourcing({ tab }: { tab: string }) {
  const [meta, setMeta] = useState<Rec | null>(null);
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/procurement/sourcing-meta').then((r) => setMeta(r.data)).catch(() => undefined);
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="proc">Procurement</p>
          <h1>{TABS.find(([k]) => k === tab)?.[1] ?? 'Sourcing'}</h1>
          <p className="muted">Vendor prices, supplier agreements, performance scores, and ordered spend — all from one place.</p>
        </div>
      </header>
      <SourcingTabs active={tab} />
      {!meta ? <PageLoader variant="page" label="Loading sourcing…" /> : tab === 'vendor-pricelists' ? <VendorPricelists meta={meta} /> : tab === 'supplier-contracts' ? <SupplierContracts meta={meta} /> : tab === 'supplier-evaluations' ? <Evaluations meta={meta} /> : <Analysis />}
    </div>
  );
}
