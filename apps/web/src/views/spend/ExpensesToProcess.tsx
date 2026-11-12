import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api';
import { useAuth, can } from '../../auth';
import { navigate } from '../../router';
import { ErrorBanner, Modal, PageLoader } from '../../components/ui';
import { ExpenseChrome } from './MyExpenses';
import { fmtDay, num, s, todayIso, type Rec } from './kit';
import { analyticLabel, canReportOnPayslip, expenseEmployeeName, odooExpenseStatus, paidByLabel } from './odooExpense';

const STATUSES: Array<{ id: string; label: string; status?: string; payment?: string }> = [
  { id: 'SUBMITTED', label: 'Submitted', status: 'SUBMITTED' },
  { id: 'DRAFT', label: 'Draft', status: 'DRAFT' },
  { id: 'APPROVED', label: 'Approved', status: 'APPROVED' },
  { id: 'POSTED', label: 'Posted', status: 'POSTED' },
  { id: 'IN_PAYMENT', label: 'In Payment', payment: 'PENDING' },
  { id: 'PAID', label: 'Paid', status: 'PAID' },
  { id: 'REJECTED', label: 'Refused', status: 'REJECTED' },
];

export default function ExpensesToProcess() {
  const { user } = useAuth();
  const [statusId, setStatusId] = useState('SUBMITTED');
  const [items, setItems] = useState<Rec[]>([]);
  const [tasks, setTasks] = useState<Rec[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [payslipOn, setPayslipOn] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [postOpen, setPostOpen] = useState(false);
  const [accountingDate, setAccountingDate] = useState(todayIso());

  const load = useCallback(() => {
    setLoading(true);
    const chosen = STATUSES.find((st) => st.id === statusId) ?? STATUSES[0];
    const params = new URLSearchParams();
    params.set('pageSize', '80');
    if (chosen.status) params.set('status', chosen.status);
    if (chosen.payment) params.set('paymentStatus', chosen.payment);
    Promise.all([
      api<{ data: { rows: Rec[] } }>(`/api/ops/expenditure/expenses?${params.toString()}`),
      api<{ data: Rec[] }>('/api/approvals').catch(() => ({ data: [] as Rec[] })),
      api<{ data: { reimburseInPayslip?: boolean } }>('/api/ops/expenditure/meta').catch(() => ({ data: { reimburseInPayslip: false } })),
    ])
      .then(([list, queue, meta]) => {
        setItems(list.data.rows);
        setTasks(queue.data ?? []);
        setPayslipOn(meta.data.reimburseInPayslip === true);
        setSelected([]);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [statusId]);
  useEffect(load, [load]);

  const taskFor = (id: number) => tasks.find((t) => s(t.entity_type ?? t.entityType) === 'ops.expenses' && num(t.entity_id ?? t.entityId) === id && t.actionable !== false);
  const approvable = selected.filter((id) => taskFor(id));
  const chosen = items.filter((row) => selected.includes(num(row.id)));
  const mayPost = can(user, 'expenditure.expenses.post');
  const canPost = mayPost && chosen.length > 0 && chosen.every((row) => s(row.status) === 'APPROVED');
  const canPayslip = mayPost && payslipOn && chosen.length > 0 && chosen.every((row) => canReportOnPayslip(row, true));
  const canRemovePayslip = mayPost && chosen.length > 0 && chosen.every((row) => row.payslipReimburse === true && s(row.paymentStatus) !== 'PAID' && s(row.status) !== 'PAID');

  const run = async (path: string, payload: Rec, done: string) => {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(payload) });
      setMsg(done);
      setPostOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      for (const id of approvable) {
        const taskId = num(taskFor(id)?.task_id ?? taskFor(id)?.taskId);
        await api(`/api/approvals/${taskId}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'APPROVED' }) });
      }
      setMsg(`${approvable.length} expense${approvable.length === 1 ? '' : 's'} approved.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ExpenseChrome
      title="Expenses to Process"
      actions={
        <>
          {approvable.length > 0 && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void approve()}>
              {busy ? 'Working…' : 'Approve'}
            </button>
          )}
          {canPost && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { setAccountingDate(s(chosen[0]?.expDate).slice(0, 10) || todayIso()); setPostOpen(true); }}>
              Post Entries
            </button>
          )}
          {canPayslip && (
            <button type="button" className="btn" disabled={busy} onClick={() => void run('/api/ops/expenditure/expenses/payslip', { ids: selected }, 'Reported for the next payslip.')}>
              Report in Next Payslip
            </button>
          )}
          {canRemovePayslip && (
            <button type="button" className="btn" disabled={busy} onClick={() => void run('/api/ops/expenditure/expenses/payslip-remove', { ids: selected }, 'Removed from the next payslip.')}>
              Remove from Payslip
            </button>
          )}
        </>
      }
    >
      {error && <ErrorBanner error={error} />}
      {msg && <div className="notice-banner">{msg}</div>}
      <div className="exp-process">
        <aside className="card exp-side" aria-label="Status">
          {STATUSES.map((st) => (
            <button key={st.id} type="button" className={statusId === st.id ? 'exp-side-btn is-on' : 'exp-side-btn'} onClick={() => setStatusId(st.id)}>
              {st.label}
            </button>
          ))}
        </aside>
        <section className="card">
          {loading ? <PageLoader /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 36 }} />
                    <th>Employee</th>
                    <th>Description</th>
                    <th>Expense Date</th>
                    <th>Category</th>
                    <th>Paid By</th>
                    <th>Analytic Distribution</th>
                    <th>Total</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => {
                    const id = num(row.id);
                    return (
                      <tr key={id} className="row-click" onClick={() => navigate(`/spend/expenses/${id}`)}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" aria-label={`Select ${s(row.description)}`} checked={selected.includes(id)} onChange={() => setSelected((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])} />
                        </td>
                        <td>{expenseEmployeeName(row)}</td>
                        <td>{s(row.description)}</td>
                        <td>{fmtDay(row.expDate)}</td>
                        <td>{s(row.categoryName) || '—'}</td>
                        <td>{paidByLabel(row.paymentMode)}</td>
                        <td>{analyticLabel(row)}</td>
                        <td>{fmtMoney(num(row.amount))}</td>
                        <td>{odooExpenseStatus(row)}{row.payslipReimburse === true ? ' · Payslip' : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!items.length && <p className="empty-state">No expenses in this status.</p>}
            </div>
          )}
          <p className="muted" style={{ margin: '10px 16px 14px' }}>Refuse an expense from its form. A reason is required. Register a cash, cheque or bank payment from a posted expense.</p>
        </section>
      </div>
      {postOpen && (
        <Modal title="Post Journal Entries" onClose={() => setPostOpen(false)}
          footer={<>
            <button type="button" className="btn" onClick={() => setPostOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run('/api/ops/expenditure/expenses/post-bulk', { ids: selected, journalType: 'EXPENSE', accountingDate }, 'Journal entries posted.')}>Post</button>
          </>}>
          <label className="field">Journal
            <input readOnly value="Expense" />
          </label>
          <label className="field">Accounting date
            <input type="date" value={accountingDate} onChange={(e) => setAccountingDate(e.target.value)} />
          </label>
          <p className="muted">This date is used for every selected expense. Accounting verification is still required, and the person who created or verified an expense cannot post it.</p>
        </Modal>
      )}
    </ExpenseChrome>
  );
}
