import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api';
import { useAuth, can } from '../../auth';
import { Badge, ErrorBanner, Modal } from '../../components/ui';
import { SpendShell, StatusFilter, num, s, type Rec } from './kit';

export function ExpenseProducts() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [meta, setMeta] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [active, setActive] = useState('');
  const [editing, setEditing] = useState<Rec | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (active === 'INACTIVE') params.set('includeInactive', 'true');
    api<{ data: Rec[] }>(`/api/ops/expenditure/products?${params.toString()}`)
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e.message));
  }, [q, active]);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/expenditure/products/meta')
      .then((r) => setMeta(r.data))
      .catch(() => undefined);
  }, []);

  const categories = (meta?.categories as Rec[] | undefined) ?? [];
  const accounts = (meta?.accounts as Rec[] | undefined) ?? [];
  const taxes = (meta?.taxes as Rec[] | undefined) ?? [];

  return (
    <SpendShell
      title="Expense Products"
      blurb="Frequently-expensed items (fuel, stationery, airtime) with a default price and account — so capturing spend is a single tap."
      active="products"
      actions={
        can(user, 'expenditure.expense_products.create') ? (
          <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Product</button>
        ) : null
      }
    >
      <div className="spend-toolbar">
        <input className="search-input" placeholder="Search code / name…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
        <StatusFilter value={active} onChange={setActive} options={['ACTIVE', 'INACTIVE']} />
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>{rows.length} product(s)</span>
      </div>
      {error && <ErrorBanner error={error} />}
      <section className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Code</th><th>Name</th><th>Category</th><th>Default price</th><th>Account</th><th>Unit</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={s(r.id)}>
                  <td className="cell-mono">{s(r.code)}</td>
                  <td style={{ maxWidth: 240 }}>{s(r.name)}</td>
                  <td>{s(r.categoryName) || '—'}</td>
                  <td className="cell-mono">{fmtMoney(num(r.defaultPrice))}</td>
                  <td>{s(r.accountName) || s(r.accountCode) || '—'}</td>
                  <td>{s(r.unitCode) || '—'}</td>
                  <td><Badge value={r.isActive === false ? 'INACTIVE' : 'ACTIVE'} /></td>
                  <td style={{ textAlign: 'right' }}>
                    {can(user, 'expenditure.expense_products.update') && (
                      <>
                        <button className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>{' '}
                        {r.isActive === false ? (
                          <button className="btn btn-sm" onClick={() => toggle(r, true)}>Activate</button>
                        ) : (
                          <button className="btn btn-sm btn-ghost-danger" onClick={() => toggle(r, false)}>Deactivate</button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="empty-state">No expense products yet. Add a few so expense capture becomes one tap.</p>}
        </div>
      </section>

      {(showNew || editing) && (
        <ProductForm
          initial={editing ?? {}}
          meta={{ categories, accounts, taxes }}
          onClose={() => { setShowNew(false); setEditing(null); }}
          onSaved={() => { setShowNew(false); setEditing(null); load(); }}
        />
      )}
    </SpendShell>
  );

  function toggle(r: Rec, active2: boolean) {
    api<{ data: Rec }>(`/api/ops/expenditure/products/${s(r.id)}/${active2 ? 'activate' : 'deactivate'}`, { method: 'POST', body: JSON.stringify({}) })
      .then(() => load())
      .catch((e) => setError(e.message));
  }
}

function ProductForm({ initial, meta, onClose, onSaved }: {
  initial: Rec;
  meta: { categories: Rec[]; accounts: Rec[]; taxes: Rec[] };
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial.id;
  const [code, setCode] = useState(s(initial.code));
  const [name, setName] = useState(s(initial.name));
  const [description, setDescription] = useState(s(initial.description));
  const [defaultPrice, setDefaultPrice] = useState(s(initial.defaultPrice));
  const [categoryId, setCategoryId] = useState(s(initial.categoryId));
  const [accountId, setAccountId] = useState(s(initial.accountId));
  const [taxId, setTaxId] = useState(s(initial.taxId));
  const [unitCode, setUnitCode] = useState(s(initial.unitCode));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const save = async () => {
    setBusy(true);
    setMsg('');
    try {
      await api<{ data: Rec }>(isEdit ? `/api/ops/expenditure/products/${s(initial.id)}/update` : '/api/ops/expenditure/products', {
        method: 'POST',
        body: JSON.stringify({
          code, name, description: description || undefined,
          defaultPrice: num(defaultPrice),
          categoryId: num(categoryId) || undefined,
          accountId: num(accountId) || undefined,
          taxId: num(taxId) || undefined,
          unitCode: unitCode || undefined,
        }),
      });
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isEdit ? `Edit ${s(initial.code)}` : 'New Expense Product'}
      onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !code || !name} onClick={() => void save()}>
          {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create product'}
        </button>
      </>}
    >
      {msg && <div className="notice-banner">{msg}</div>}
      <div className="form-grid">
        <label className="field field-required">Code
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. FUEL-PETROL" />
        </label>
        <label className="field field-required">Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Petrol" />
        </label>
        <label className="field">Default price (UGX)
          <input type="number" min="0" step="0.01" value={defaultPrice} onChange={(e) => setDefaultPrice(e.target.value)} placeholder="0" />
        </label>
        <label className="field">Unit
          <input value={unitCode} onChange={(e) => setUnitCode(e.target.value)} placeholder="e.g. L, ream, pcs" />
        </label>
        <label className="field">Category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">—</option>
            {meta.categories.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
          </select>
        </label>
        <label className="field">Account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">—</option>
            {meta.accounts.map((a) => <option key={s(a.id)} value={s(a.id)}>{s(a.code)} — {s(a.name)}</option>)}
          </select>
        </label>
        <label className="field">Tax
          <select value={taxId} onChange={(e) => setTaxId(e.target.value)}>
            <option value="">—</option>
            {meta.taxes.map((t) => <option key={s(t.id)} value={s(t.id)}>{s(t.name)}</option>)}
          </select>
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
        </label>
      </div>
    </Modal>
  );
}
