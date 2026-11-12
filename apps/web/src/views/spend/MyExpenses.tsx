import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, fmtMoney } from '../../api';
import { useAuth, can } from '../../auth';
import { navigate } from '../../router';
import { ErrorBanner, PageLoader, Pager } from '../../components/ui';
import { fmtDay, num, s, type Rec } from './kit';
import {
  analyticLabel,
  expenseEmployeeName,
  odooExpenseStatus,
  paidByLabel,
  stageReceipts,
} from './odooExpense';

export function ExpenseChrome({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page exp-app">
      <div className="crumbs">
        <button type="button" className="crumb-link" onClick={() => navigate('/spend/expenses')}>Expenses</button>
        <span className="crumb-sep">/</span>
        <span>{title}</span>
      </div>
      <header className="page-head">
        <div>
          <div className="mod-kicker" data-mod="fin">Expenses</div>
          <h1>{title}</h1>
        </div>
        {actions ? <div className="head-actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

const FILTERS: Array<{ id: string; label: string; status?: string; payment?: string }> = [
  { id: '', label: 'My Expenses' },
  { id: 'DRAFT', label: 'To Submit', status: 'DRAFT' },
  { id: 'SUBMITTED', label: 'Submitted', status: 'SUBMITTED' },
  { id: 'APPROVED', label: 'Approved', status: 'APPROVED' },
  { id: 'POSTED', label: 'Posted', status: 'POSTED' },
  { id: 'PAID', label: 'Paid', status: 'PAID' },
  { id: 'REJECTED', label: 'Refused', status: 'REJECTED' },
];

type GroupBy = '' | 'employee' | 'category' | 'status' | 'paidBy' | 'date';

function groupKey(row: Rec, groupBy: GroupBy): string {
  if (groupBy === 'employee') return expenseEmployeeName(row);
  if (groupBy === 'category') return s(row.categoryName) || 'No category';
  if (groupBy === 'status') return odooExpenseStatus(row);
  if (groupBy === 'paidBy') return paidByLabel(row.paymentMode);
  if (groupBy === 'date') return fmtDay(row.expDate) || 'No date';
  return '';
}

export default function MyExpenses() {
  const { user } = useAuth();
  const [items, setItems] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('');
  const [banner, setBanner] = useState<Rec>({});
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set('mine', '1');
    params.set('pageSize', '80');
    if (q) params.set('q', q);
    const chosen = FILTERS.find((f) => f.id === filter);
    if (chosen?.status) params.set('status', chosen.status);
    if (page > 1) params.set('page', String(page));
    api<{ data: { rows: Rec[]; total: number; banner?: Rec } }>(`/api/ops/expenditure/expenses?${params.toString()}`)
      .then((r) => {
        setItems(r.data.rows);
        setTotal(r.data.total);
        setBanner(r.data.banner ?? {});
        setSelected([]);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [q, filter, page]);
  useEffect(load, [load]);

  const groups = useMemo(() => {
    if (!groupBy) return [{ key: '', rows: items }];
    const map = new Map<string, Rec[]>();
    for (const row of items) {
      const key = groupKey(row, groupBy);
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return [...map.entries()].map(([key, rows]) => ({ key, rows }));
  }, [items, groupBy]);

  const selectedRows = items.filter((row) => selected.includes(num(row.id)));
  const canSubmitSelection = selectedRows.length > 0 && selectedRows.every((row) => s(row.status) === 'DRAFT') && can(user, 'expenditure.expenses.submit');

  const toggle = (id: number) => {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };
  const toggleAll = () => {
    const ids = items.map((row) => num(row.id));
    setSelected((cur) => (cur.length === ids.length ? [] : ids));
  };

  const submitSelected = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/ops/expenditure/expenses/submit-bulk', { method: 'POST', body: JSON.stringify({ ids: selected }) });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openWithFiles = (files: File[]) => {
    if (!files.length) return;
    stageReceipts(files);
    navigate('/spend/expenses/new');
  };

  const company = s(user?.company_name) || '—';

  return (
    <ExpenseChrome
      title="My Expenses"
      actions={
        <>
          {canSubmitSelection && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submitSelected()}>
              {busy ? 'Submitting…' : 'Submit'}
            </button>
          )}
          {can(user, 'expenditure.expenses.create') && (
            <label className="btn">
              Upload
              <input type="file" accept="image/*,.pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) openWithFiles([f]); }} />
            </label>
          )}
          {can(user, 'expenditure.expenses.create') && (
            <button type="button" className="btn btn-primary" onClick={() => navigate('/spend/expenses/new')}>New</button>
          )}
        </>
      }
    >
      {error && <ErrorBanner error={error} />}
      <div className="exp-banner" role="group" aria-label="Expense totals">
        <button type="button" className={filter === 'DRAFT' ? 'is-on' : ''} onClick={() => { setFilter(filter === 'DRAFT' ? '' : 'DRAFT'); setPage(1); }}>
          <span className="exp-banner-label">To Submit</span>
          <span className="exp-banner-value">{fmtMoney(num(banner.toSubmit))}</span>
        </button>
        <button type="button" className={filter === 'SUBMITTED' ? 'is-on' : ''} onClick={() => { setFilter(filter === 'SUBMITTED' ? '' : 'SUBMITTED'); setPage(1); }}>
          <span className="exp-banner-label">Waiting Approval</span>
          <span className="exp-banner-value">{fmtMoney(num(banner.waitingApproval))}</span>
        </button>
        <button type="button" className={filter === 'APPROVED' ? 'is-on' : ''} onClick={() => { setFilter(filter === 'APPROVED' ? '' : 'APPROVED'); setPage(1); }}>
          <span className="exp-banner-label">Waiting Reimbursement</span>
          <span className="exp-banner-value">{fmtMoney(num(banner.waitingReimbursement))}</span>
        </button>
      </div>

      <div className="exp-control">
        <input
          className="search-input"
          type="search"
          placeholder="Search description, employee, category…"
          aria-label="Search expenses"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
        />
        <select className="search-input" style={{ width: 'auto' }} aria-label="Filter" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }}>
          {FILTERS.map((f) => <option key={f.id || 'all'} value={f.id}>{f.label}</option>)}
        </select>
        <select className="search-input" style={{ width: 'auto' }} aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
          <option value="">Group by</option>
          <option value="employee">Employee</option>
          <option value="category">Category</option>
          <option value="status">Status</option>
          <option value="paidBy">Paid By</option>
          <option value="date">Expense Date</option>
        </select>
        <span className="muted" style={{ fontSize: 12 }}>{total} expenses</span>
      </div>

      <section
        className={dragging ? 'card exp-drop' : 'card'}
        onDragOver={(e) => { if (!can(user, 'expenditure.expenses.create')) return; e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!can(user, 'expenditure.expenses.create')) return;
          e.preventDefault();
          setDragging(false);
          openWithFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {loading ? <PageLoader /> : (
          <>
            {!items.length && (
              <div className="empty-state" style={{ padding: 28 }}>
                <strong>Create a new expense</strong>
                <p>Click New, or drop a receipt here to start one.</p>
                {can(user, 'expenditure.expenses.create') && (
                  <button type="button" className="btn btn-primary" onClick={() => navigate('/spend/expenses/new')}>New</button>
                )}
              </div>
            )}
            {items.length > 0 && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input type="checkbox" aria-label="Select all expenses" checked={selected.length === items.length && items.length > 0} onChange={toggleAll} />
                      </th>
                      <th>Employee</th>
                      <th>Description</th>
                      <th>Expense Date</th>
                      <th>Category</th>
                      <th>Paid By</th>
                      <th>Analytic Distribution</th>
                      <th>Company</th>
                      <th>Total</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => (
                      <Fragment key={group.key || 'all'}>
                        {group.key && (
                          <tr>
                            <td colSpan={10}><strong>{group.key}</strong></td>
                          </tr>
                        )}
                        {group.rows.map((row) => {
                          const id = num(row.id);
                          const draft = s(row.status) === 'DRAFT';
                          return (
                            <tr key={id} className="row-click" onClick={() => navigate(`/spend/expenses/${id}`)}>
                              <td onClick={(e) => e.stopPropagation()}>
                                <input type="checkbox" aria-label={`Select ${s(row.description)}`} checked={selected.includes(id)} onChange={() => toggle(id)} />
                              </td>
                              <td>{expenseEmployeeName(row)}</td>
                              <td className={draft ? 'exp-draft' : undefined}>{s(row.description)}</td>
                              <td>{fmtDay(row.expDate)}</td>
                              <td>{s(row.categoryName) || '—'}</td>
                              <td>{paidByLabel(row.paymentMode)}</td>
                              <td>{analyticLabel(row)}</td>
                              <td>{company}</td>
                              <td>{fmtMoney(num(row.amount))}</td>
                              <td>{odooExpenseStatus(row)}{row.payslipReimburse === true ? ' · Payslip' : ''}</td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {total > 80 && <Pager page={page} pageSize={80} total={total} onPage={setPage} />}
          </>
        )}
      </section>
    </ExpenseChrome>
  );
}
