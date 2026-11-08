import { useEffect, useMemo, useState } from 'react';
import { api, fmtMoney } from '../../api';
import { useAuth } from '../../auth';
import { navigate } from '../../router';
import { ErrorBanner } from '../../components/ui';
import { toast } from '../../components/toast';
import { useApi } from '../../lib/useApi';
import { SpendShell, num, s, todayIso, uploadReceiptInput, type Rec } from './kit';

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024; // matches the API multer limit

interface Meta {
  categories?: Rec[];
  paymentMethods?: Rec[];
  departments?: Rec[];
  costCentres?: Rec[];
  projects?: Rec[];
  employees?: Rec[];
  suppliers?: Rec[];
  budgets?: Rec[];
}

/**
 * Single-screen expense capture, optimised for a user with no accounting
 * background: three required fields, a photo/attachment box, and everything
 * advanced tucked behind "More options". The receipt is attached to the draft
 * automatically the moment it is saved, so capture + evidence is one action.
 */
export default function RecordExpense() {
  const { user } = useAuth();

  // Essentials — kept to the minimum the API requires.
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [expDate, setExpDate] = useState(todayIso());

  // Receipts captured but not yet uploaded (uploaded against the new draft).
  const [files, setFiles] = useState<File[]>([]);

  // Advanced, collapsed by default.
  const [showMore, setShowMore] = useState(false);
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [payee, setPayee] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [departmentId, setDepartmentId] = useState(s(user?.department_id));
  const [costCentreId, setCostCentreId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [budgetId, setBudgetId] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [reference, setReference] = useState('');
  const [isPlanned, setIsPlanned] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [productId, setProductId] = useState('');

  const metaQuery = useApi<{ data: Meta }>('/api/ops/expenditure/meta');
  const meta = metaQuery.data?.data ?? ({} as Meta);
  const productsQuery = useApi<{ data: Rec[] }>('/api/ops/expenditure/products');
  const products = productsQuery.data?.data ?? [];
  const cats = meta.categories ?? [];
  const methods = meta.paymentMethods ?? [];
  const depts = meta.departments ?? [];
  const centres = meta.costCentres ?? [];
  const projs = meta.projects ?? [];
  const emps = meta.employees ?? [];
  const sups = meta.suppliers ?? [];
  const bdgs = meta.budgets ?? [];

  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next: File[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_RECEIPT_BYTES) {
        toast.error('Receipt too large', { body: `${f.name} is over 10 MB.` });
        continue;
      }
      next.push(f);
    }
    if (next.length) setFiles((cur) => [...cur, ...next]);
  };

  const removeFile = (idx: number) => setFiles((cur) => cur.filter((_, i) => i !== idx));

  const canSubmit = !busy && amount !== '' && description.trim() !== '' && categoryId !== '';

  const save = async (submitNow: boolean) => {
    if (!canSubmit) {
      setError('Fill in the amount, description and category, then attach a receipt if you have one.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body: Rec = {
        description,
        amount: num(amount),
        categoryId: num(categoryId),
        expDate,
        departmentId: num(departmentId) || undefined,
        costCentreId: num(costCentreId) || undefined,
        paymentMethodId: num(paymentMethodId) || undefined,
        payee: payee || undefined,
        supplierId: num(supplierId) || undefined,
        employeeId: num(employeeId) || undefined,
        projectId: num(projectId) || undefined,
        budgetId: num(budgetId) || undefined,
        taxAmount: taxAmount ? num(taxAmount) : undefined,
        vehicle: vehicle || undefined,
        reference: reference || undefined,
        isPlanned,
      };
      const created = await api<{ data: Rec }>('/api/ops/expenditure/expenses', { method: 'POST', body: JSON.stringify(body) });
      const expenseId = Number(created.data.id);

      // Attach any captured receipts to the freshly-created draft, then submit.
      let receiptFailures = 0;
      for (const f of files) {
        try {
          await uploadReceiptInput(f, 'EXPENSE', expenseId);
        } catch {
          receiptFailures += 1;
        }
      }
      if (submitNow) {
        await api(`/api/ops/expenditure/expenses/${expenseId}/submit`, { method: 'POST', body: '{}' });
      }
      if (receiptFailures > 0) toast.warning('Some receipts could not be attached', { body: 'You can add them again from the expense page.' });
      navigate(`/spend/expenses/${expenseId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <SpendShell title="Record Expense" blurb="Three things: how much, what for, and the receipt." active="expenses">
      {error && <ErrorBanner error={error} />}

      <section className="card card-accent">
        <div className="card-head"><h3>1 · How much did you spend?</h3></div>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
          <label className="field field-required" style={{ fontSize: '1.05rem' }}>
            Amount (UGX)
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              style={{ fontSize: '1.6rem', fontWeight: 700, padding: '14px 12px' }}
            />
          </label>
        </div>
      </section>

      <section className="card card-accent">
        <div className="card-head"><h3>2 · What was it for?</h3></div>
        <div className="form-grid">
          {products.length > 0 && (
            <label className="field" style={{ gridColumn: '1 / -1' }}>Quick pick (prefills everything below)
              <select value={productId} onChange={(e) => {
                setProductId(e.target.value);
                const p = products.find((x) => s(x.id) === e.target.value);
                if (p) {
                  if (num(p.defaultPrice) > 0) setAmount(String(num(p.defaultPrice)));
                  setDescription(s(p.name));
                  if (s(p.categoryId)) setCategoryId(s(p.categoryId));
                }
              }}>
                <option value="">Type it yourself…</option>
                {products.map((p) => <option key={s(p.id)} value={s(p.id)}>{s(p.name)} {num(p.defaultPrice) > 0 ? `· ${fmtMoney(num(p.defaultPrice))}` : ''}</option>)}
              </select>
            </label>
          )}
          <label className="field field-required">Date
            <input type="date" value={expDate} onChange={(e) => setExpDate(e.target.value)} />
          </label>
          <label className="field field-required">Category
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Pick a category…</option>
              {cats.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.categoryGroup)} · {s(c.name)}</option>)}
            </select>
          </label>
          <label className="field field-required" style={{ gridColumn: '1 / -1' }}>Description
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Fuel for the delivery truck, or lunch for the team" />
          </label>
        </div>
      </section>

      <section className="card card-accent">
        <div className="card-head"><h3>3 · Attach the receipt</h3></div>
        <p className="muted" style={{ margin: '0 0 12px' }}>Take a photo or attach the paper. You can add more than one.</p>
        <div className="receipt-drop">
          <label className="btn btn-primary">
            📷 Take photo
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </label>
          <label className="btn">
            Attach file
            <input type="file" accept="image/*,.pdf" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </label>
        </div>
        {files.length > 0 && (
          <ul className="receipt-thumbs">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="receipt-thumb">
                <img src={previews[i]} alt="" />
                <span className="receipt-thumb-name" title={f.name}>{f.name}</span>
                <button type="button" className="btn btn-sm btn-ghost-danger" onClick={() => removeFile(i)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <button type="button" className="btn btn-ghost" onClick={() => setShowMore((v) => !v)} aria-expanded={showMore}>
          {showMore ? 'Hide' : 'More options'} ▾
        </button>
        {showMore && (
          <div className="form-grid" style={{ marginTop: 12 }}>
            <label className="field">Payment method
              <select value={paymentMethodId} onChange={(e) => setPaymentMethodId(e.target.value)}>
                <option value="">Select method…</option>
                {methods.map((m) => <option key={s(m.id)} value={s(m.id)}>{s(m.name)} ({s(m.methodType).replace(/_/g, ' ')})</option>)}
              </select>
            </label>
            <label className="field">Payee
              <input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="Who received the money?" />
            </label>
            <label className="field">Supplier
              <select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); const sup = sups.find((x) => s(x.id) === e.target.value); if (sup) setPayee(s(sup.name)); }}>
                <option value="">Not supplier-related</option>
                {sups.map((x) => <option key={s(x.id)} value={s(x.id)}>{s(x.name)}</option>)}
              </select>
            </label>
            <label className="field">Employee (reimbursement)
              <select value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); const emp = emps.find((x) => s(x.id) === e.target.value); if (emp) setPayee(s(emp.name)); }}>
                <option value="">Not employee-related</option>
                {emps.map((x) => <option key={s(x.id)} value={s(x.id)}>{s(x.name)}</option>)}
              </select>
            </label>
            <label className="field">Department
              <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">Select department…</option>
                {depts.map((d) => <option key={s(d.id)} value={s(d.id)}>{s(d.name)}</option>)}
              </select>
            </label>
            <label className="field">Cost centre
              <select value={costCentreId} onChange={(e) => setCostCentreId(e.target.value)}>
                <option value="">Select cost centre…</option>
                {centres.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
              </select>
            </label>
            <label className="field">Project
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">No project</option>
                {projs.map((p) => <option key={s(p.id)} value={s(p.id)}>{s(p.name)}</option>)}
              </select>
            </label>
            <label className="field">Budget
              <select value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>
                <option value="">No budget</option>
                {bdgs.map((b) => <option key={s(b.id)} value={s(b.id)}>{s(b.budgetNo)} · {s(b.name)}</option>)}
              </select>
            </label>
            <label className="field">Tax amount
              <input type="number" min="0" step="0.01" value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} placeholder="0.00" />
            </label>
            <label className="field">Vehicle
              <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="e.g. UAX 123A" />
            </label>
            <label className="field">Reference / invoice no
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="INV-…" />
            </label>
            <label className="field checkbox-field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={isPlanned} onChange={(e) => setIsPlanned(e.target.checked)} />
              Planned expenditure (not emergency)
            </label>
          </div>
        )}
      </section>

      <div className="spend-dock">
        <div className="spend-dock-meta">
          Amount <strong>{fmtMoney(num(amount))}</strong>
          {files.length > 0 && <span className="muted" style={{ marginLeft: 8 }}>· {files.length} receipt{files.length === 1 ? '' : 's'}</span>}
        </div>
        <div className="head-actions">
          <button type="button" className="btn" onClick={() => navigate('/spend/expenses')}>Cancel</button>
          <button type="button" className="btn" disabled={busy} onClick={() => void save(false)}>{busy ? 'Saving…' : 'Save draft'}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !canSubmit} onClick={() => void save(true)}>
            {busy ? 'Saving…' : 'Save & Submit'}
          </button>
        </div>
      </div>
    </SpendShell>
  );
}
