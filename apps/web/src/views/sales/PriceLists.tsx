import { useCallback, useEffect, useState } from 'react';
import { api, fmtNum } from '../../api';
import { useAuth, can } from '../../auth';
import { Badge, ErrorBanner, PageLoader } from '../../components/ui';
import { toast } from '../../components/toast';

type Rec = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

interface ItemRow {
  key: string;
  productId: number | '';
  unitPrice: number;
  minQuantity: number;
  effectiveFrom: string;
  effectiveTo: string;
}

const emptyItem = (): ItemRow => ({ key: `${Date.now()}-${Math.random()}`, productId: '', unitPrice: 0, minQuantity: 0, effectiveFrom: '', effectiveTo: '' });

export default function PriceLists() {
  const { user } = useAuth();
  const [mode, setMode] = useState<'list' | 'edit'>('list');
  const [lists, setLists] = useState<Rec[]>([]);
  const [allProducts, setAllProducts] = useState<Rec[]>([]);
  const [allCustomers, setAllCustomers] = useState<Rec[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<Rec>({});
  const [items, setItems] = useState<ItemRow[]>([]);
  const [customers, setCustomers] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const canEdit = can(user, 'sales.price_lists.update');
  const canDelete = can(user, 'sales.price_lists.delete');

  const loadLists = useCallback(() => {
    setLoading(true);
    api<{ data: Rec[] }>('/api/ops/sales/price-lists')
      .then((r) => setLists(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Price lists failed'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadLists(); }, [loadLists]);

  const loadDetail = useCallback(async (id: number) => {
    setLoading(true); setError('');
    const r = await api<{ data: { priceList: Rec; items: Rec[]; customers: Rec[] } }>(`/api/ops/sales/price-lists/${id}`);
    const d = r.data;
    setForm(d.priceList);
    setItems((d.items ?? []).map((it) => ({
      key: `${id}-${String(it.id ?? Math.random())}`,
      productId: n(it.productId),
      unitPrice: n(it.unitPrice),
      minQuantity: n(it.minQuantity),
      effectiveFrom: String(it.effectiveFrom ?? '').slice(0, 10),
      effectiveTo: String(it.effectiveTo ?? '').slice(0, 10),
    })));
    setCustomers(d.customers ?? []);
    setLoading(false);
  }, []);

  const openNew = () => {
    setEditingId(null);
    setForm({ name: '', code: '', currency: 'UGX', validFrom: '', validTo: '', isActive: true, notes: '' });
    setItems([emptyItem()]);
    setCustomers([]);
    setMode('edit');
  };

  const openExisting = async (id: number) => {
    setEditingId(id);
    setMode('edit');
    if (!allProducts.length) {
      api<{ data: Rec[] }>('/api/ops/sales/products').then((r) => setAllProducts(r.data ?? [])).catch(() => undefined);
    }
    if (!allCustomers.length) {
      api<{ data: Rec[] }>('/api/ops/sales/customers/directory').then((r) => setAllCustomers(r.data ?? [])).catch(() => undefined);
    }
    await loadDetail(id);
  };

  const saveList = async () => {
    setBusy(true); setError('');
    try {
      const payload = {
        name: String(form.name ?? '').trim(),
        code: String(form.code ?? '').trim() || undefined,
        currency: String(form.currency ?? 'UGX'),
        validFrom: form.validFrom ? String(form.validFrom) : null,
        validTo: form.validTo ? String(form.validTo) : null,
        isActive: form.isActive !== false,
        notes: form.notes ? String(form.notes) : null,
      };
      if (!payload.name) { setError('Name is required'); return; }
      const r = editingId
        ? await api<{ data: Rec }>(`/api/ops/sales/price-lists/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await api<{ data: Rec }>('/api/ops/sales/price-lists', { method: 'POST', body: JSON.stringify(payload) });
      const row = r.data;
      setEditingId(n(row.id));
      setForm(row);
      toast.success(editingId ? 'Price list saved' : 'Price list created');
      if (!editingId) {
        if (!allProducts.length) api<{ data: Rec[] }>('/api/ops/sales/products').then((x) => setAllProducts(x.data ?? [])).catch(() => undefined);
        if (!allCustomers.length) api<{ data: Rec[] }>('/api/ops/sales/customers/directory').then((x) => setAllCustomers(x.data ?? [])).catch(() => undefined);
      }
      loadLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const saveItems = async () => {
    if (!editingId) return;
    setBusy(true); setError('');
    try {
      const payloadItems = items.filter((it) => it.productId && it.unitPrice > 0).map((it) => ({
        productId: Number(it.productId),
        unitPrice: it.unitPrice,
        minQuantity: it.minQuantity,
        effectiveFrom: it.effectiveFrom || null,
        effectiveTo: it.effectiveTo || null,
      }));
      await api(`/api/ops/sales/price-lists/${editingId}/items`, { method: 'PUT', body: JSON.stringify({ items: payloadItems }) });
      toast.success('Price list items saved');
      loadLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    if (!editingId || !window.confirm('Deactivate this price list? Customers on it revert to standard pricing.')) return;
    setBusy(true);
    try {
      await api(`/api/ops/sales/price-lists/${editingId}`, { method: 'DELETE' });
      toast.success('Price list deactivated');
      setMode('list');
      loadLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deactivate failed');
    } finally {
      setBusy(false);
    }
  };

  const assignCustomer = async (customerId: number) => {
    if (!editingId) return;
    setBusy(true);
    try {
      await api(`/api/ops/sales/customers/${customerId}/price-list`, { method: 'PUT', body: JSON.stringify({ priceListId: editingId }) });
      toast.success('Customer assigned');
      loadDetail(editingId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Assign failed');
    } finally {
      setBusy(false);
    }
  };

  const removeCustomer = async (customerId: number) => {
    setBusy(true);
    try {
      await api(`/api/ops/sales/customers/${customerId}/price-list`, { method: 'PUT', body: JSON.stringify({ priceListId: null }) });
      toast.success('Customer removed from price list');
      if (editingId) loadDetail(editingId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  };

  const setItem = (key: string, patch: Partial<ItemRow>) => setItems((p) => p.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  // --- list view ---
  if (mode === 'list') {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <p className="mod-kicker" data-mod="sales">Sales</p>
            <h1>Price Lists</h1>
            <p className="muted">Named, reusable price sets assigned to customers — quotation prices auto-fill from the customer's list.</p>
          </div>
          <div className="head-actions">
            {can(user, 'sales.price_lists.create') && <button className="btn btn-primary" onClick={openNew}>New price list</button>}
          </div>
        </header>
        {error && <ErrorBanner error={error} />}
        {loading ? <PageLoader variant="page" label="Loading price lists…" /> : (
          <div className="table-wrap card">
            <table className="data">
              <thead>
                <tr><th>Code</th><th>Name</th><th>Currency</th><th>Valid</th><th className="cell-num">Items</th><th className="cell-num">Customers</th><th>Status</th></tr>
              </thead>
              <tbody>
                {lists.map((l) => (
                  <tr key={String(l.id)} className="row-click" onClick={() => openExisting(n(l.id))} style={{ cursor: 'pointer' }}>
                    <td className="cell-mono">{String(l.code)}</td>
                    <td>{String(l.name)}</td>
                    <td>{String(l.currency ?? 'UGX')}</td>
                    <td>{l.validFrom || l.validTo ? `${String(l.validFrom ?? '…').slice(0, 10)} → ${String(l.validTo ?? '…').slice(0, 10)}` : 'Open'}</td>
                    <td className="cell-num">{fmtNum(l.itemCount)}</td>
                    <td className="cell-num">{fmtNum(l.customerCount)}</td>
                    <td><Badge value={l.isActive === false ? 'INACTIVE' : 'ACTIVE'} /></td>
                  </tr>
                ))}
                {lists.length === 0 && <tr><td className="muted" colSpan={7}>No price lists yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // --- editor view ---
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>{editingId ? String(form.code ?? 'Price list') : 'New price list'}</h1>
          <p className="muted">{editingId ? 'Edit list, items and customer assignment.' : 'Create the list, then add items and assign customers.'}</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => setMode('list')} disabled={busy}>Back</button>
          {canEdit && <button className="btn btn-primary" onClick={saveList} disabled={busy}>{busy ? 'Saving…' : 'Save list'}</button>}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}

      <section className="table-wrap card" style={{ marginBottom: 14 }}>
        <div className="card-head"><h3>Details</h3></div>
        <div className="grid-2" style={{ padding: 16, gap: 14 }}>
          <div className="field"><label>Name</label><input value={String(form.name ?? '')} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field"><label>Code</label><input value={String(form.code ?? '')} placeholder="Auto (PL-0001)" onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
          <div className="field"><label>Currency</label><input value={String(form.currency ?? 'UGX')} onChange={(e) => setForm({ ...form, currency: e.target.value })} /></div>
          <div className="field"><label>Active</label><select value={form.isActive === false ? 'false' : 'true'} onChange={(e) => setForm({ ...form, isActive: e.target.value === 'true' })}><option value="true">Active</option><option value="false">Inactive</option></select></div>
          <div className="field"><label>Valid from</label><input type="date" value={String(form.validFrom ?? '').slice(0, 10)} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} /></div>
          <div className="field"><label>Valid to</label><input type="date" value={String(form.validTo ?? '').slice(0, 10)} onChange={(e) => setForm({ ...form, validTo: e.target.value })} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Notes</label><textarea value={String(form.notes ?? '')} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        </div>
      </section>

      {editingId ? (
        <>
          <section className="table-wrap card" style={{ marginBottom: 14 }}>
            <div className="card-head" style={{ justifyContent: 'space-between' }}>
              <h3>Items</h3>
              <button className="btn btn-sm" onClick={() => setItems((p) => [...p, emptyItem()])}>Add item</button>
            </div>
            <table className="data">
              <thead><tr><th>Product</th><th className="cell-num">Unit price</th><th className="cell-num">Min qty</th><th>Effective from</th><th>Effective to</th><th /></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.key}>
                    <td>
                      <select value={String(it.productId)} onChange={(e) => setItem(it.key, { productId: e.target.value ? Number(e.target.value) : '' })}>
                        <option value="">— choose product —</option>
                        {allProducts.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.code)} · {String(p.name)}</option>)}
                      </select>
                    </td>
                    <td><input className="cell-input" type="number" min={0} value={it.unitPrice} onChange={(e) => setItem(it.key, { unitPrice: n(e.target.value) })} /></td>
                    <td><input className="cell-input" type="number" min={0} value={it.minQuantity} onChange={(e) => setItem(it.key, { minQuantity: n(e.target.value) })} /></td>
                    <td><input className="cell-input" type="date" value={it.effectiveFrom} onChange={(e) => setItem(it.key, { effectiveFrom: e.target.value })} /></td>
                    <td><input className="cell-input" type="date" value={it.effectiveTo} onChange={(e) => setItem(it.key, { effectiveTo: e.target.value })} /></td>
                    <td><button className="btn btn-sm" onClick={() => setItems((p) => p.filter((x) => x.key !== it.key))}>Remove</button></td>
                  </tr>
                ))}
                {items.length === 0 && <tr><td className="muted" colSpan={6}>No items.</td></tr>}
              </tbody>
            </table>
            <div style={{ padding: '12px 16px' }}>{canEdit && <button className="btn" onClick={saveItems} disabled={busy}>Save items</button>}</div>
          </section>

          <section className="table-wrap card" style={{ marginBottom: 14 }}>
            <div className="card-head"><h3>Assigned customers</h3></div>
            <table className="data">
              <thead><tr><th>Code</th><th>Name</th><th>Status</th><th /></tr></thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={String(c.id)}>
                    <td className="cell-mono">{String(c.code)}</td>
                    <td>{String(c.name)}</td>
                    <td><Badge value={c.status} /></td>
                    <td>{canEdit && <button className="btn btn-sm" onClick={() => removeCustomer(n(c.id))}>Remove</button>}</td>
                  </tr>
                ))}
                {customers.length === 0 && <tr><td className="muted" colSpan={4}>No customers assigned.</td></tr>}
              </tbody>
            </table>
            {canEdit && (
              <div style={{ padding: '12px 16px', display: 'flex', gap: 8, alignItems: 'center' }}>
                <select className="search-input" style={{ maxWidth: 320 }} defaultValue="" onChange={(e) => { if (e.target.value) { assignCustomer(Number(e.target.value)); e.target.value = ''; } }}>
                  <option value="">+ Assign a customer…</option>
                  {allCustomers.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.code)} · {String(c.name)}</option>)}
                </select>
              </div>
            )}
          </section>

          {canDelete && (
            <div style={{ marginTop: 4 }}>
              <button className="btn btn-danger" onClick={deactivate} disabled={busy}>Deactivate price list</button>
            </div>
          )}
        </>
      ) : (
        <p className="muted">Save the list to add items and assign customers.</p>
      )}
    </div>
  );
}
