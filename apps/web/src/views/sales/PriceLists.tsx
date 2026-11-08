import { useCallback, useEffect, useMemo, useState } from 'react';
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
  productCode?: string;
  productName?: string;
  standardPrice?: number;
}

const emptyItem = (): ItemRow => ({ key: `${Date.now()}-${Math.random()}`, productId: '', unitPrice: 0, minQuantity: 0, effectiveFrom: '', effectiveTo: '' });

const CURRENCIES = ['UGX', 'USD', 'EUR', 'GBP', 'KES', 'TZS'];

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
  const [customerQuery, setCustomerQuery] = useState('');
  const [assignValue, setAssignValue] = useState('');
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

  // Load reference data up front so the editor is ready immediately (no race
  // between the item rows rendering and their product options loading).
  const loadReferenceData = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/sales/products')
      .then((r) => setAllProducts(Array.isArray(r.data) ? r.data : []))
      .catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/sales/customers/directory')
      .then((r) => setAllCustomers(Array.isArray(r.data) ? r.data : []))
      .catch(() => undefined);
  }, []);

  useEffect(() => { loadLists(); loadReferenceData(); }, [loadLists, loadReferenceData]);

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
      productCode: String(it.productCode ?? ''),
      productName: String(it.productName ?? ''),
      standardPrice: n(it.standardPrice),
    })));
    setCustomers(d.customers ?? []);
    setLoading(false);
  }, []);

  const openNew = () => {
    setEditingId(null);
    setForm({ name: '', code: '', currency: 'UGX', validFrom: '', validTo: '', isActive: true, notes: '' });
    setItems([emptyItem()]);
    setCustomers([]);
    setCustomerQuery('');
    setAssignValue('');
    setMode('edit');
  };

  const openExisting = async (id: number) => {
    setEditingId(id);
    setMode('edit');
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
      const wasNew = !editingId;
      const r = wasNew
        ? await api<{ data: Rec }>('/api/ops/sales/price-lists', { method: 'POST', body: JSON.stringify(payload) })
        : await api<{ data: Rec }>(`/api/ops/sales/price-lists/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      const row = r.data;
      setEditingId(n(row.id));
      setForm(row);
      toast.success(wasNew ? 'Price list created — now add items and assign customers' : 'Price list saved');
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
      const validItems = items.filter((it) => it.productId && it.unitPrice > 0);
      const skipped = items.length - validItems.length;
      await api(`/api/ops/sales/price-lists/${editingId}/items`, {
        method: 'PUT',
        body: JSON.stringify({ items: validItems.map((it) => ({
          productId: Number(it.productId),
          unitPrice: it.unitPrice,
          minQuantity: it.minQuantity,
          effectiveFrom: it.effectiveFrom || null,
          effectiveTo: it.effectiveTo || null,
        })) }),
      });
      toast.success(`Saved ${validItems.length} item${validItems.length === 1 ? '' : 's'}`);
      if (skipped > 0) toast.warning(`${skipped} incomplete row${skipped === 1 ? '' : 's'} skipped (needs a product and a price)`);
      loadLists();
      if (editingId) loadDetail(editingId);
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

  // Product options = reference products plus any product already on this list
  // (so a previously-added product still shows even if it left the sellable set).
  const productOptions = useMemo(() => {
    const map = new Map<number, Rec>();
    for (const p of allProducts) map.set(n(p.id), p);
    for (const it of items) {
      const pid = n(it.productId);
      if (pid > 0 && !map.has(pid)) {
        map.set(pid, { id: pid, code: it.productCode ?? '', name: it.productName ?? '', standardPrice: it.standardPrice ?? 0 });
      }
    }
    return Array.from(map.values());
  }, [allProducts, items]);

  const chosenProductIds = useMemo(() => {
    const set = new Set<number>();
    for (const it of items) { const pid = n(it.productId); if (pid > 0) set.add(pid); }
    return set;
  }, [items]);

  const assignedIds = useMemo(() => new Set(customers.map((c) => n(c.id))), [customers]);
  const unassigned = useMemo(() => allCustomers.filter((c) => !assignedIds.has(n(c.id))), [allCustomers, assignedIds]);
  const filteredUnassigned = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    if (!q) return unassigned;
    return unassigned.filter((c) => `${String(c.code ?? '')} ${String(c.name ?? '')}`.toLowerCase().includes(q));
  }, [unassigned, customerQuery]);

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
          <h1>{editingId ? String(form.name || form.code || 'Price list') : 'New price list'}</h1>
          <p className="muted">
            {editingId
              ? `${String(form.code ?? '')} · edit list, items and customer assignment.`
              : 'Create the list, then add items and assign customers.'}
          </p>
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
          <div className="field"><label>Name</label><input value={String(form.name ?? '')} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Wholesale 2026" /></div>
          <div className="field"><label>Code</label><input value={String(form.code ?? '')} placeholder="Auto (PL-0001)" onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
          <div className="field">
            <label>Currency</label>
            <select value={String(form.currency ?? 'UGX')} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
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
              <h3>Items <span className="muted" style={{ fontWeight: 500, fontSize: 12 }}>({items.length})</span></h3>
              <button className="btn btn-sm" onClick={() => setItems((p) => [...p, emptyItem()])}>Add item</button>
            </div>
            <table className="data">
              <thead><tr><th>Product</th><th className="cell-num">Unit price</th><th className="cell-num">Min qty</th><th>Effective from</th><th>Effective to</th><th /></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.key}>
                    <td>
                      <select value={String(it.productId)} onChange={(e) => {
                        const raw = e.target.value;
                        const pid = raw ? Number(raw) : '';
                        const prod = productOptions.find((p) => n(p.id) === pid);
                        const patch: Partial<ItemRow> = {
                          productId: pid,
                          productCode: prod ? String(prod.code ?? '') : '',
                          productName: prod ? String(prod.name ?? '') : '',
                          standardPrice: prod ? n(prod.standardPrice) : 0,
                        };
                        if (prod && (it.unitPrice ?? 0) <= 0) patch.unitPrice = n(prod.standardPrice);
                        setItem(it.key, patch);
                      }}>
                        <option value="">— choose product —</option>
                        {productOptions.map((p) => {
                          const pid = n(p.id);
                          const usedElsewhere = chosenProductIds.has(pid) && pid !== n(it.productId);
                          return <option key={String(p.id)} value={String(p.id)} disabled={usedElsewhere}>{String(p.code)} · {String(p.name)}</option>;
                        })}
                      </select>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <input className="cell-input" type="number" min={0} step="0.01" value={it.unitPrice} onChange={(e) => setItem(it.key, { unitPrice: n(e.target.value) })} />
                        {it.standardPrice != null && it.standardPrice > 0 && (
                          <span className="muted" style={{ fontSize: 11 }}>std {fmtNum(it.standardPrice)}</span>
                        )}
                      </div>
                    </td>
                    <td><input className="cell-input" type="number" min={0} value={it.minQuantity} onChange={(e) => setItem(it.key, { minQuantity: n(e.target.value) })} /></td>
                    <td><input className="cell-input" type="date" value={it.effectiveFrom} onChange={(e) => setItem(it.key, { effectiveFrom: e.target.value })} /></td>
                    <td><input className="cell-input" type="date" value={it.effectiveTo} onChange={(e) => setItem(it.key, { effectiveTo: e.target.value })} /></td>
                    <td><button className="btn btn-sm" onClick={() => setItems((p) => p.filter((x) => x.key !== it.key))}>Remove</button></td>
                  </tr>
                ))}
                {items.length === 0 && <tr><td className="muted" colSpan={6}>No items.</td></tr>}
              </tbody>
            </table>
            <div style={{ padding: '12px 16px', display: 'flex', gap: 8, alignItems: 'center' }}>
              {canEdit && <button className="btn" onClick={saveItems} disabled={busy}>{busy ? 'Saving…' : 'Save items'}</button>}
              <span className="muted" style={{ fontSize: 12 }}>Choose a product and the standard price pre-fills — adjust it to the list price.</span>
            </div>
          </section>

          <section className="table-wrap card" style={{ marginBottom: 14 }}>
            <div className="card-head"><h3>Assigned customers <span className="muted" style={{ fontWeight: 500, fontSize: 12 }}>({customers.length})</span></h3></div>
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
                {customers.length === 0 && <tr><td className="muted" colSpan={4}>No customers assigned yet.</td></tr>}
              </tbody>
            </table>
            {canEdit && (
              <div style={{ padding: '12px 16px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="search-input" style={{ maxWidth: 220 }} placeholder="Search customers…" value={customerQuery} onChange={(e) => setCustomerQuery(e.target.value)} />
                <select className="search-input" style={{ maxWidth: 320, minWidth: 240 }} value={assignValue} disabled={busy} onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  assignCustomer(Number(v));
                  setAssignValue('');
                }}>
                  <option value="">+ Assign a customer… ({filteredUnassigned.length})</option>
                  {filteredUnassigned.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.code)} · {String(c.name)}</option>)}
                </select>
                {unassigned.length === 0 && allCustomers.length > 0 && (
                  <span className="muted" style={{ fontSize: 12 }}>All {allCustomers.length} customers are already assigned to a price list.</span>
                )}
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
