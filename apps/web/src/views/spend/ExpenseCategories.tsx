import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api';
import { useAuth, can } from '../../auth';
import { ErrorBanner, Modal, PageLoader } from '../../components/ui';
import { ExpenseChrome } from './MyExpenses';
import { num, s, type Rec } from './kit';
import { reinvoiceModeOf, type ReinvoiceMode } from './odooExpense';

const GROUPS = ['OPERATIONS', 'FACTORY', 'ADMINISTRATION', 'STAFF', 'SALES_MARKETING', 'LOGISTICS'];

const empty = {
  code: '',
  name: '',
  categoryGroup: 'OPERATIONS',
  accountId: '',
  unitPrice: '',
  uomId: '',
  taxId: '',
  salesTaxId: '',
  salesPrice: '',
  guideline: '',
  description: '',
  reinvoiceMode: 'none' as ReinvoiceMode,
  isActive: true,
};

function modeLabel(mode: ReinvoiceMode): string {
  if (mode === 'at_cost') return 'At cost';
  if (mode === 'sales_price') return 'Sales price';
  return 'No';
}

export default function ExpenseCategories() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [accounts, setAccounts] = useState<Rec[]>([]);
  const [taxes, setTaxes] = useState<Rec[]>([]);
  const [units, setUnits] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Rec | null>(null);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<{ data: Rec[] }>('/api/ops/expenditure/categories'),
      api<{ data: { accounts?: Rec[]; taxes?: Rec[]; units?: Rec[] } }>('/api/ops/expenditure/meta').catch(() => ({ data: { accounts: [], taxes: [], units: [] } })),
    ])
      .then(([cats, meta]) => {
        setRows(cats.data);
        setAccounts(meta.data.accounts ?? []);
        setTaxes(meta.data.taxes ?? []);
        setUnits(meta.data.units ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const openNew = () => { setForm(empty); setEditing({}); };
  const openRow = (row: Rec) => {
    setForm({
      code: s(row.code),
      name: s(row.name),
      categoryGroup: s(row.categoryGroup) || 'OPERATIONS',
      accountId: s(row.accountId),
      unitPrice: row.unitPrice == null ? '' : s(row.unitPrice),
      uomId: s(row.uomId),
      taxId: s(row.taxId),
      salesTaxId: s(row.salesTaxId),
      salesPrice: row.salesPrice == null ? '' : s(row.salesPrice),
      guideline: s(row.guideline) || s(row.description),
      description: s(row.description),
      reinvoiceMode: reinvoiceModeOf(row),
      isActive: row.isActive !== false,
    });
    setEditing(row);
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const payload = {
        ...form,
        accountId: num(form.accountId) || undefined,
        taxId: num(form.taxId) || undefined,
        salesTaxId: form.reinvoiceMode === 'none' ? null : num(form.salesTaxId) || null,
        uomId: num(form.uomId) || null,
        unitPrice: form.unitPrice === '' ? null : num(form.unitPrice),
        salesPrice: form.reinvoiceMode === 'sales_price' ? num(form.salesPrice) : null,
        reinvoice: form.reinvoiceMode !== 'none',
      };
      const id = num(editing?.id);
      if (id) await api(`/api/ops/expenditure/categories/${id}/update`, { method: 'POST', body: JSON.stringify(payload) });
      else await api('/api/ops/expenditure/categories', { method: 'POST', body: JSON.stringify(payload) });
      setEditing(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const mayEdit = can(user, 'expenditure.settings.update');
  const company = s(user?.company_name) || '—';

  return (
    <ExpenseChrome
      title="Expense Categories"
      actions={mayEdit ? <button type="button" className="btn btn-primary" onClick={openNew}>New</button> : null}
    >
      {error && <ErrorBanner error={error} />}
      {loading ? <PageLoader /> : (
        <section className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Reference</th>
                  <th>Cost</th>
                  <th>UoM</th>
                  <th>Expense Account</th>
                  <th>Purchase Tax</th>
                  <th>Re-invoice</th>
                  <th>Note</th>
                  <th>Company</th>
                  <th>Active</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={s(row.id)} className="row-click" onClick={() => mayEdit && openRow(row)}>
                    <td>{s(row.name)}</td>
                    <td className="cell-mono">{s(row.code)}</td>
                    <td>{row.unitPrice == null || num(row.unitPrice) === 0 ? '—' : fmtMoney(num(row.unitPrice))}</td>
                    <td>{s(row.uomName) || '—'}</td>
                    <td>{s(row.accountCode) ? `${s(row.accountCode)} ${s(row.accountName)}` : '—'}</td>
                    <td>{s(row.taxName) || '—'}</td>
                    <td>{modeLabel(reinvoiceModeOf(row))}</td>
                    <td>{s(row.guideline) || s(row.description) || '—'}</td>
                    <td>{company}</td>
                    <td>{row.isActive === false ? 'Archived' : 'Active'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <p className="empty-state">No expense categories yet.</p>}
          </div>
        </section>
      )}
      {editing && (
        <Modal title={editing.id ? 'Expense category' : 'New expense category'} onClose={() => setEditing(null)}
          footer={<>
            <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
          </>}>
          <label className="field field-required">Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field field-required">Reference
            <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="FOOD" />
          </label>
          <label className="field">Category
            <select value={form.categoryGroup} onChange={(e) => setForm({ ...form, categoryGroup: e.target.value })}>
              {GROUPS.map((g) => <option key={g} value={g}>{g.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <label className="field">Company
            <input readOnly value={company} />
          </label>
          <label className="field">Cost
            <input type="number" min="0" step="0.01" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} placeholder="0 means the actual expense amount" />
          </label>
          <label className="field">Unit of measure
            <select value={form.uomId} onChange={(e) => setForm({ ...form, uomId: e.target.value })}>
              <option value="">No unit</option>
              {units.map((u) => <option key={s(u.id)} value={s(u.id)}>{s(u.name)}</option>)}
            </select>
          </label>
          <label className="field">Expense account
            <select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
              <option value="">Default expense account</option>
              {accounts.map((a) => <option key={s(a.id)} value={s(a.id)}>{s(a.code)} {s(a.name)}</option>)}
            </select>
          </label>
          <label className="field">Purchase taxes
            <select value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })}>
              <option value="">No tax</option>
              {taxes.map((t) => <option key={s(t.id)} value={s(t.id)}>{s(t.name)} ({s(t.rate)}%)</option>)}
            </select>
          </label>
          <label className="field">Guideline
            <textarea rows={2} value={form.guideline} onChange={(e) => setForm({ ...form, guideline: e.target.value })} placeholder="Shown to employees in the Note column" />
          </label>
          <fieldset className="field">
            <legend>Re-invoice expenses</legend>
            {(['none', 'at_cost', 'sales_price'] as ReinvoiceMode[]).map((mode) => (
              <label className="check" key={mode}>
                <input type="radio" name="reinvoiceMode" checked={form.reinvoiceMode === mode} onChange={() => setForm({ ...form, reinvoiceMode: mode })} />
                {modeLabel(mode)}
              </label>
            ))}
          </fieldset>
          {form.reinvoiceMode === 'sales_price' && (
            <label className="field field-required">Sales price
              <input type="number" min="0" step="0.01" value={form.salesPrice} onChange={(e) => setForm({ ...form, salesPrice: e.target.value })} />
            </label>
          )}
          {form.reinvoiceMode !== 'none' && (
            <label className="field">Sales taxes
              <select value={form.salesTaxId} onChange={(e) => setForm({ ...form, salesTaxId: e.target.value })}>
                <option value="">No sales tax</option>
                {taxes.map((t) => <option key={s(t.id)} value={s(t.id)}>{s(t.name)} ({s(t.rate)}%)</option>)}
              </select>
            </label>
          )}
          <label className="check"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Active</label>
          <label className="field">Internal note
            <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
        </Modal>
      )}
    </ExpenseChrome>
  );
}
