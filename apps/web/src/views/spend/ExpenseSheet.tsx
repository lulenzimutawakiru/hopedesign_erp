import { useEffect, useMemo, useState } from 'react';
import { api, fmtDate, fmtMoney } from '../../api';
import { useAuth, can } from '../../auth';
import { navigate } from '../../router';
import { Badge, ErrorBanner, Modal, PageLoader } from '../../components/ui';
import { ExpenseChrome } from './MyExpenses';
import { Pipeline, ReceiptChips, num, s, todayIso, uploadReceiptInput, type Rec } from './kit';
import { billableUnitPrice, canReportOnPayslip, includedTax, odooExpenseStatus, paidByLabel, reinvoiceModeOf, takePendingReceipts } from './odooExpense';

interface Meta {
  categories?: Rec[];
  departments?: Rec[];
  projects?: Rec[];
  employees?: Rec[];
  accounts?: Rec[];
  customers?: Rec[];
  salesOrders?: Rec[];
  paymentMethods?: Rec[];
  reimburseInPayslip?: boolean;
}

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export default function ExpenseSheet({ id }: { id?: number }) {
  const { user } = useAuth();
  const [meta, setMeta] = useState<Meta>({});
  const [row, setRow] = useState<Rec | null>(id ? null : {});
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [tasks, setTasks] = useState<Rec[]>([]);
  const [showSplit, setShowSplit] = useState(false);
  const [splitAmounts, setSplitAmounts] = useState<string[]>(['', '']);
  const [showRefuse, setShowRefuse] = useState(false);
  const [refuseReason, setRefuseReason] = useState('');
  const [showPay, setShowPay] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('');
  const [methods, setMethods] = useState<Rec[]>([]);
  const [bankAccounts, setBankAccounts] = useState<Rec[]>([]);
  const [payBankAccount, setPayBankAccount] = useState('');
  const [showPost, setShowPost] = useState(false);
  const [accountingDate, setAccountingDate] = useState(todayIso());
  const [salesPrice, setSalesPrice] = useState('');

  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [total, setTotal] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [employeeId, setEmployeeId] = useState(s(user?.employee_id));
  const [paymentMode, setPaymentMode] = useState<'employee' | 'company'>('employee');
  const [expDate, setExpDate] = useState(todayIso());
  const [accountId, setAccountId] = useState('');
  const [salesOrderId, setSalesOrderId] = useState('');
  const [departmentId, setDepartmentId] = useState(s(user?.department_id));
  const [projectId, setProjectId] = useState(s(user?.project_id));
  const [notes, setNotes] = useState('');

  useEffect(() => {
    setFiles(takePendingReceipts());
    api<{ data: Meta }>('/api/ops/expenditure/meta').then((r) => setMeta(r.data)).catch((e) => setError(e.message));
    api<{ data: Rec[] }>('/api/approvals')
      .then((r) => setTasks(r.data ?? []))
      .catch(() => setTasks([]));
    if (can(user, 'expenditure.payments.create')) {
      api<{ data: Rec }>('/api/ops/expenditure/payments/meta')
        .then((r) => {
          setMethods((r.data.paymentMethods as Rec[] | undefined) ?? []);
          setBankAccounts((r.data.bankAccounts as Rec[] | undefined) ?? []);
        })
        .catch(() => undefined);
    }
  }, [user]);

  const load = () => {
    if (!id) return;
    api<{ data: Rec }>(`/api/ops/expenditure/expenses/${id}`)
      .then((r) => {
        const e = r.data;
        setRow(e);
        setDescription(s(e.description));
        setCategoryId(s(e.categoryId));
        setTotal(s(e.amount));
        setQuantity(s(e.quantity) || '1');
        setEmployeeId(s(e.employeeId) || s(user?.employee_id));
        setPaymentMode(s(e.paymentMode) === 'company' ? 'company' : 'employee');
        setExpDate(s(e.expDate).slice(0, 10) || todayIso());
        setAccountId(s(e.accountId));
        setSalesOrderId(s(e.salesOrderId));
        setDepartmentId(s(e.departmentId));
        setProjectId(s(e.projectId));
        setNotes(s(e.notes));
        setSalesPrice(s(e.salesPrice));
      })
      .catch((e) => setError(e.message));
  };
  useEffect(load, [id]);

  const category = (meta.categories ?? []).find((c) => s(c.id) === categoryId);
  const reinvoiceMode = category ? reinvoiceModeOf(category) : reinvoiceModeOf(row ?? {});
  const unitPrice = num(category?.unitPrice);
  const quantityMode = unitPrice > 0;
  const amount = quantityMode ? Math.round(num(quantity) * unitPrice * 100) / 100 : num(total);
  const taxRate = num(category?.taxRate);
  const tax = includedTax(amount, taxRate);
  const order = (meta.salesOrders ?? []).find((o) => s(o.id) === salesOrderId);
  const draft = !id || s(row?.status) === 'DRAFT';
  const statusLabel = row && id ? odooExpenseStatus(row) : 'Draft';
  const task = tasks.find((t) => s(t.entity_type ?? t.entityType) === 'ops.expenses' && num(t.entity_id ?? t.entityId) === id && t.actionable !== false);

  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const applyCategory = (nextId: string) => {
    setCategoryId(nextId);
    const cat = (meta.categories ?? []).find((c) => s(c.id) === nextId);
    if (cat?.accountId) setAccountId(s(cat.accountId));
    const price = num(cat?.unitPrice);
    if (price > 0) {
      const base = num(total) || amount;
      if (base > 0) setQuantity(String(Math.round((base / price) * 100) / 100));
    } else if (amount > 0) {
      setTotal(String(amount));
    }
    setSalesPrice(reinvoiceModeOf(cat ?? {}) === 'sales_price' ? s(cat?.salesPrice) : '');
  };

  const body = (): Rec => ({
    description: description.trim(),
    amount,
    categoryId: num(categoryId),
    expDate,
    employeeId: num(employeeId) || undefined,
    paymentMode,
    accountId: num(accountId) || undefined,
    departmentId: num(departmentId) || undefined,
    projectId: num(projectId) || undefined,
    salesOrderId: num(salesOrderId) || null,
    customerId: num(order?.customerId) || null,
    quantity: quantityMode ? num(quantity) : 1,
    unitPrice: quantityMode ? unitPrice : undefined,
    salesPrice: reinvoiceMode === 'sales_price' ? num(salesPrice) || null : null,
    taxId: num(category?.taxId) || undefined,
    taxAmount: tax || undefined,
    notes: notes || undefined,
  });

  const attachNew = async (expenseId: number) => {
    for (const file of files) await uploadReceiptInput(file, 'EXPENSE', expenseId);
    setFiles([]);
  };

  const save = async (submitNow: boolean) => {
    if (!description.trim() || !categoryId || !(amount > 0)) {
      setError('Enter a description, category and total.');
      return;
    }
    setBusy(submitNow ? 'submit' : 'save');
    setError('');
    setMsg('');
    try {
      let expenseId = id;
      if (!expenseId) {
        const created = await api<{ data: Rec }>('/api/ops/expenditure/expenses', { method: 'POST', body: JSON.stringify(body()) });
        expenseId = num(created.data.id);
      } else if (draft) {
        await api(`/api/ops/expenditure/expenses/${expenseId}/update`, { method: 'POST', body: JSON.stringify(body()) });
      }
      if (files.length && expenseId) await attachNew(expenseId);
      if (submitNow && expenseId) {
        await api(`/api/ops/expenditure/expenses/${expenseId}/submit`, { method: 'POST', body: '{}' });
      }
      if (!id && expenseId) navigate(`/spend/expenses/${expenseId}`);
      else {
        setMsg(submitNow ? 'Expense submitted.' : 'Expense saved.');
        load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const act = async (action: string, label: string, payload?: Rec) => {
    if (!id) return;
    setBusy(action);
    setError('');
    setMsg('');
    try {
      await api(`/api/ops/expenditure/expenses/${id}/${action}`, { method: 'POST', body: JSON.stringify(payload ?? {}) });
      setMsg(label);
      setShowSplit(false);
      setShowPay(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const decide = async (decision: 'APPROVED' | 'REJECTED', comment?: string) => {
    const taskId = num(task?.task_id ?? task?.taskId);
    if (!taskId) return;
    setBusy(decision);
    setError('');
    try {
      await api(`/api/approvals/${taskId}/decide`, { method: 'POST', body: JSON.stringify({ decision, comment }) });
      setMsg(decision === 'APPROVED' ? 'Expense approved.' : 'Expense refused.');
      setShowRefuse(false);
      setRefuseReason('');
      load();
      const queue = await api<{ data: Rec[] }>('/api/approvals').catch(() => ({ data: [] as Rec[] }));
      setTasks(queue.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  if (id && !row && !error) return <PageLoader variant="page" />;
  const receipts = (row?.receipts as Rec[] | undefined) ?? [];
  const payments = (row?.payments as Rec[] | undefined) ?? [];
  const timeline = (row?.timeline as Rec[] | undefined) ?? [];
  const reserved = payments.filter((p) => ['SUBMITTED', 'APPROVED', 'PAID'].includes(s(p.status))).reduce((sum, p) => sum + num(p.amount), 0);
  const outstanding = Math.max(0, Math.round((num(row?.amount) - reserved) * 100) / 100);
  const canPost = !!id && (row?.status === 'APPROVED' || row?.status === 'PAID') && row?.accountingVerified === true && s(row?.accountingStatus) !== 'POSTED' && can(user, 'expenditure.expenses.post');
  const canVerify = !!id && row?.status === 'APPROVED' && row?.accountingVerified !== true && can(user, 'expenditure.expenses.verify');
  const canPay = !!id && s(row?.accountingStatus) === 'POSTED' && outstanding > 0 && row?.payslipReimburse !== true && can(user, 'expenditure.payments.create');
  const canReset = !!id && (row?.status === 'REJECTED' || row?.status === 'SUBMITTED') && num(row?.createdBy) === num(user?.id) && can(user, 'expenditure.expenses.update');
  const payslipRow = row ?? {};
  const canPayslip = !!id && can(user, 'expenditure.expenses.post') && canReportOnPayslip(payslipRow, meta.reimburseInPayslip === true);
  const canRemovePayslip = !!id && can(user, 'expenditure.expenses.post') && row?.payslipReimburse === true && s(row?.paymentStatus) !== 'PAID';
  const posted = s(row?.accountingStatus) === 'POSTED' || s(row?.status) === 'POSTED' || s(row?.status) === 'PAID';
  const canReinvoice = !!id && posted && reinvoiceMode !== 'none' && num(row?.customerId) > 0 && !row?.customerInvoiceId && can(user, 'sales.invoices.create');
  const reinvoiceOpen = draft || s(row?.status) === 'SUBMITTED';
  const billable = billableUnitPrice({
    mode: reinvoiceMode,
    cost: unitPrice,
    salesPrice: num(salesPrice) || num(category?.salesPrice),
    amount,
    quantity: quantityMode ? num(quantity) : 1,
  });

  return (
    <ExpenseChrome
      title={id ? (description || 'Expense') : 'New'}
      actions={
        <>
          <button type="button" className="btn" onClick={() => navigate('/spend/expenses')}>Discard</button>
          {draft && can(user, 'expenditure.expenses.create') && (
            <button type="button" className="btn" disabled={busy !== ''} onClick={() => void save(false)}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          )}
          {draft && can(user, 'expenditure.expenses.submit') && (
            <button type="button" className="btn btn-primary" disabled={busy !== ''} onClick={() => void save(true)}>{busy === 'submit' ? 'Submitting…' : 'Submit'}</button>
          )}
          {!!id && draft && (
            <button type="button" className="btn" onClick={() => { const first = Math.round(amount / 2); setSplitAmounts([String(first), String(Math.round((amount - first) * 100) / 100)]); setShowSplit(true); }}>Split Expense</button>
          )}
          {!!task && <button type="button" className="btn btn-primary" disabled={busy !== ''} onClick={() => void decide('APPROVED')}>Approve</button>}
          {!!task && <button type="button" className="btn btn-ghost-danger" disabled={busy !== ''} onClick={() => setShowRefuse(true)}>Refuse</button>}
          {canReset && <button type="button" className="btn" disabled={busy !== ''} onClick={() => void act('reset', 'Reset to draft')}>Reset to Draft</button>}
          {canVerify && (
            <button type="button" className="btn" disabled={busy !== ''} onClick={() => {
              const comment = window.prompt('Accounting verification notes:');
              if (comment?.trim()) void act('verify', 'Accounting verified', { comment });
            }}>Verify Accounting</button>
          )}
          {canPost && <button type="button" className="btn btn-primary" disabled={busy !== ''} onClick={() => { setAccountingDate(expDate || todayIso()); setShowPost(true); }}>Post Journal Entries</button>}
          {canPayslip && <button type="button" className="btn" disabled={busy !== ''} onClick={() => void act('payslip', 'Reported for the next payslip', { ids: [id] })}>Report in Next Payslip</button>}
          {canRemovePayslip && <button type="button" className="btn" disabled={busy !== ''} onClick={() => void act('payslip-remove', 'Removed from the next payslip', { ids: [id] })}>Remove from Payslip</button>}
          {canReinvoice && <button type="button" className="btn" disabled={busy !== ''} onClick={() => void act('reinvoice', 'Customer invoice created')}>Create Invoice</button>}
          {canPay && <button type="button" className="btn btn-primary" onClick={() => setShowPay(true)}>Register Payment</button>}
          {!!id && (can(user, 'expenditure.expenses.create') || can(user, 'expenditure.receipts.upload')) && (
            <label className="btn">
              Attach Receipt
              <input type="file" accept="image/*,.pdf" hidden onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                if (file.size > MAX_RECEIPT_BYTES) { setError('Receipt is over 10 MB.'); return; }
                setBusy('receipt');
                void uploadReceiptInput(file, 'EXPENSE', id).then(() => { setMsg('Receipt attached.'); load(); }).catch((err) => setError(err.message)).finally(() => setBusy(''));
              }} />
            </label>
          )}
        </>
      }
    >
      {error && <ErrorBanner error={error} />}
      {msg && <div className="notice-banner">{msg}</div>}
      <div className="exp-statusline">
        <span className="muted">Status</span>
        <strong>{statusLabel}</strong>
        {id && <span className="cell-mono muted">{s(row?.expNo)}</span>}
        {row?.accountingVerified === true && <Badge value="VERIFIED" />}
        {row?.payslipReimburse === true && <span className="muted">On next payslip</span>}
        {num(row?.salesOrderId) > 0 && can(user, 'sales.orders.view') && (
          <button type="button" className="btn btn-sm" onClick={() => navigate(`/sales/orders/${num(row?.salesOrderId)}`)}>Sales order {s(row?.salesOrderNo)}</button>
        )}
        {num(row?.customerInvoiceId) > 0 && can(user, 'sales.invoices.view') && (
          <button type="button" className="btn btn-sm" onClick={() => navigate(`/sales/invoices/${num(row?.customerInvoiceId)}`)}>Invoice {s(row?.customerInvoiceNo)}</button>
        )}
      </div>
      <Pipeline steps={['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'PAID']} status={s(row?.status) || 'DRAFT'} />

      <section className="card">
        <div className="exp-sheet">
          <label className="field field-required">Description
            <input value={description} disabled={!draft} onChange={(e) => setDescription(e.target.value)} placeholder="Lunch with client" />
          </label>
          <label className="field field-required">Employee
            <select value={employeeId} disabled={!draft} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Select an employee…</option>
              {(meta.employees ?? []).map((emp) => <option key={s(emp.id)} value={s(emp.id)}>{s(emp.name) || `${s(emp.firstName)} ${s(emp.lastName)}`}</option>)}
            </select>
          </label>
          <label className="field field-required">Category
            <select value={categoryId} disabled={!draft} onChange={(e) => applyCategory(e.target.value)}>
              <option value="">Select a category…</option>
              {(meta.categories ?? []).map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.code) ? `[${s(c.code)}] ` : ''}{s(c.name)}</option>)}
            </select>
            {(s(category?.guideline) || s(row?.categoryGuideline)) && <span className="muted">{s(category?.guideline) || s(row?.categoryGuideline)}</span>}
          </label>
          <fieldset className="field" disabled={!draft}>
            <legend>Paid By</legend>
            <label className="check"><input type="radio" name="paidBy" checked={paymentMode === 'employee'} onChange={() => setPaymentMode('employee')} /> Employee (to reimburse)</label>
            <label className="check"><input type="radio" name="paidBy" checked={paymentMode === 'company'} onChange={() => setPaymentMode('company')} /> Company</label>
          </fieldset>
          {quantityMode ? (
            <label className="field field-required">Quantity
              <input type="number" min="0" step="0.01" value={quantity} disabled={!draft} onChange={(e) => setQuantity(e.target.value)} />
              <span className="muted">{s(category?.uomName) || s(row?.categoryUomName) ? `${s(category?.uomName) || s(row?.categoryUomName)} · ` : ''}Unit price {fmtMoney(unitPrice)} · Total {fmtMoney(amount)}</span>
            </label>
          ) : (
            <label className="field field-required">Total
              <input type="number" min="0" step="0.01" value={total} disabled={!draft} onChange={(e) => setTotal(e.target.value)} />
            </label>
          )}
          <label className="field">Expense Date
            <input type="date" value={expDate} disabled={!draft} onChange={(e) => setExpDate(e.target.value)} />
          </label>
          <label className="field">Included Taxes
            <input readOnly value={tax > 0 ? `${s(category?.taxName) || 'Tax'} ${fmtMoney(tax)}` : '—'} />
          </label>
          <label className="field">Account
            <select value={accountId} disabled={!draft} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Default expense account</option>
              {(meta.accounts ?? []).map((a) => <option key={s(a.id)} value={s(a.id)}>{s(a.code)} {s(a.name)}</option>)}
            </select>
          </label>
          {reinvoiceMode !== 'none' && (
            <label className="field">Customer to Reinvoice
              <select value={salesOrderId} disabled={!reinvoiceOpen} onChange={(e) => setSalesOrderId(e.target.value)}>
                <option value="">No sales order</option>
                {(meta.salesOrders ?? []).map((o) => <option key={s(o.id)} value={s(o.id)}>{s(o.orderNo)} — {s(o.customerName)}</option>)}
              </select>
              {billable != null && <span className="muted">Billable {fmtMoney(billable)}{quantityMode ? ` × ${quantity}` : ''}{num(category?.salesTaxRate) > 0 ? `. Sales tax ${s(category?.salesTaxName)} is added on the customer invoice.` : ''}</span>}
            </label>
          )}
          {reinvoiceMode === 'sales_price' && (
            <label className="field field-required">Sales price
              <input type="number" min="0" step="0.01" value={salesPrice} disabled={!reinvoiceOpen} onChange={(e) => setSalesPrice(e.target.value)} />
            </label>
          )}
          {!!id && s(row?.status) === 'SUBMITTED' && reinvoiceMode !== 'none' && (
            <div>
              <button type="button" className="btn btn-sm" disabled={busy !== ''} onClick={() => {
                setBusy('reinvoice-link');
                setError('');
                void api(`/api/ops/expenditure/expenses/${id}/update`, {
                  method: 'POST',
                  body: JSON.stringify({
                    salesOrderId: num(salesOrderId) || null,
                    customerId: num(order?.customerId) || null,
                    salesPrice: reinvoiceMode === 'sales_price' ? num(salesPrice) || null : null,
                  }),
                }).then(() => { setMsg('Customer to reinvoice saved.'); load(); })
                  .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(''));
              }}>Save reinvoice</button>
            </div>
          )}
          <label className="field">Analytic — Department
            <select value={departmentId} disabled={!draft} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">No department</option>
              {(meta.departments ?? []).map((d) => <option key={s(d.id)} value={s(d.id)}>{s(d.name)}</option>)}
            </select>
          </label>
          <label className="field">Analytic — Project
            <select value={projectId} disabled={!draft} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">No project</option>
              {(meta.projects ?? []).map((p) => <option key={s(p.id)} value={s(p.id)}>{s(p.name)}</option>)}
            </select>
          </label>
          <label className="field">Company
            <input readOnly value={s(user?.company_name) || '—'} />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>Notes…
            <textarea rows={3} value={notes} disabled={!draft} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        {!id && (
          <div style={{ marginTop: 16 }}>
            <label className="btn">
              Attach Receipt
              <input type="file" accept="image/*,.pdf" multiple hidden onChange={(e) => {
                const next = Array.from(e.target.files ?? []).filter((f) => f.size <= MAX_RECEIPT_BYTES);
                e.target.value = '';
                setFiles((cur) => [...cur, ...next]);
              }} />
            </label>
            {files.length > 0 && <ul className="receipt-thumbs">{files.map((f, i) => <li key={`${f.name}-${i}`}>{f.name}</li>)}</ul>}
          </div>
        )}
      </section>

      {!!id && (
        <section className="card">
          <div className="card-head">
            <h3>Receipts</h3>
            {receipts.length > 0 && can(user, 'expenditure.receipts.verify') && (
              <button type="button" className="btn btn-sm" disabled={busy !== ''} onClick={() => {
                const receiptId = num(receipts[0]?.id);
                setBusy('ocr');
                void api(`/api/ops/expenditure/receipts/${receiptId}/ocr`, { method: 'POST', body: '{}' })
                  .then(() => { setMsg('Receipt digitized.'); load(); })
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(''));
              }}>Digitize document</button>
            )}
          </div>
          <ReceiptChips receipts={receipts} />
        </section>
      )}

      {payments.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Payments</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Voucher</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={s(p.id)}>
                    <td className="cell-mono">{s(p.payNo)}</td>
                    <td>{fmtMoney(num(p.amount))}</td>
                    <td><Badge value={p.status} /></td>
                    <td>{p.paymentDate ? fmtDate(p.paymentDate) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {timeline.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>History</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Action</th><th>By</th><th>Comment</th><th>At</th></tr></thead>
              <tbody>
                {timeline.map((a) => (
                  <tr key={s(a.id)}><td>{s(a.action)}</td><td>{s(a.actorName) || '—'}</td><td>{s(a.comment) || '—'}</td><td>{fmtDate(a.createdAt)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {showSplit && (
        <Modal title="Split Expense" onClose={() => setShowSplit(false)}
          footer={<>
            <button type="button" className="btn" onClick={() => setShowSplit(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy !== ''} onClick={() => void act('split', 'Expense split', { parts: splitAmounts.map((amount) => ({ amount: num(amount), description })) })}>Split</button>
          </>}>
          <p className="muted">The amounts must add up to {fmtMoney(amount)}.</p>
          {splitAmounts.map((value, index) => (
            <label key={index} className="field">Amount {index + 1}
              <input type="number" min="0" step="0.01" value={value} onChange={(e) => setSplitAmounts((cur) => cur.map((v, i) => i === index ? e.target.value : v))} />
            </label>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setSplitAmounts((cur) => [...cur, ''])}>Add a line</button>
        </Modal>
      )}

      {showRefuse && (
        <Modal title="Refuse Expense" onClose={() => setShowRefuse(false)}
          footer={<>
            <button type="button" className="btn" onClick={() => setShowRefuse(false)}>Cancel</button>
            <button type="button" className="btn btn-ghost-danger" disabled={!refuseReason.trim() || busy !== ''} onClick={() => void decide('REJECTED', refuseReason.trim())}>Refuse</button>
          </>}>
          <label className="field field-required">Reason
            <textarea rows={3} value={refuseReason} onChange={(e) => setRefuseReason(e.target.value)} />
          </label>
        </Modal>
      )}

      {showPost && (
        <Modal title="Post Journal Entries" onClose={() => setShowPost(false)}
          footer={<>
            <button type="button" className="btn" onClick={() => setShowPost(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy !== ''} onClick={() => { setShowPost(false); void act('post', 'Journal entries posted', { journalType: 'EXPENSE', accountingDate }); }}>Post</button>
          </>}>
          <label className="field">Journal
            <input readOnly value="Expense" />
          </label>
          <label className="field">Accounting date
            <input type="date" value={accountingDate} onChange={(e) => setAccountingDate(e.target.value)} />
          </label>
          <p className="muted">Defaults to the expense date. The expense journal is the one this register posts to.</p>
        </Modal>
      )}

      {showPay && (
        <Modal title="Register Payment" onClose={() => setShowPay(false)}
          footer={<>
            <button type="button" className="btn" onClick={() => setShowPay(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy !== ''} onClick={() => void act('pay', 'Payment request submitted', { amount: num(payAmount) || undefined, paymentMethodId: num(payMethod) || undefined, bankAccountId: num(payBankAccount) || undefined })}>Register</button>
          </>}>
          <p className="muted">Outstanding {fmtMoney(outstanding)}. {paidByLabel(row?.paymentMode) === 'Employee' ? 'This reimburses the employee.' : 'This settles the company payment.'}</p>
          <label className="field">Amount
            <input type="number" min="0" step="0.01" value={payAmount} placeholder={String(outstanding)} onChange={(e) => setPayAmount(e.target.value)} />
          </label>
          <label className="field">Payment method
            <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
              <option value="">Default</option>
              {methods.map((m) => <option key={s(m.id)} value={s(m.id)}>{s(m.name)}</option>)}
            </select>
          </label>
          <label className="field">Bank account
            <select value={payBankAccount} onChange={(e) => setPayBankAccount(e.target.value)}>
              <option value="">Not applicable</option>
              {bankAccounts.map((b) => <option key={s(b.id)} value={s(b.id)}>{s(b.name)}</option>)}
            </select>
          </label>
        </Modal>
      )}
    </ExpenseChrome>
  );
}
