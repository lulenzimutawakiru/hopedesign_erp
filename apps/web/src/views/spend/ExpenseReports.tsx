import { useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api';
import { useAuth, can } from '../../auth';
import { DatePresets, ReportExportMenu } from '../../components/report';
import { ErrorBanner } from '../../components/ui';
import { SpendShell, num, s, type Rec } from './kit';

/**
 * Branded export/print surface for the twelve employee-expense reports. Each
 * report re-runs the same spend-module service functions that power the
 * interactive screens, so a report is never derived or invented — it is emitted
 * with the company letterhead, a tamper-evident fingerprint and an audit trail.
 */
export default function ExpenseReports() {
  const { user } = useAuth();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [groupBy, setGroupBy] = useState<'employee' | 'category'>('employee');
  const [grouped, setGrouped] = useState<Rec[]>([]);
  const [analysisError, setAnalysisError] = useState('');

  useEffect(() => {
    if (!can(user, 'expenditure.reports.view')) return;
    const params = new URLSearchParams();
    params.set('groupBy', groupBy);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    api<{ data: { grouped?: Rec[] } }>(`/api/ops/expenditure/reports?${params.toString()}`)
      .then((r) => { setGrouped(r.data.grouped ?? []); setAnalysisError(''); })
      .catch((e) => setAnalysisError(e instanceof Error ? e.message : String(e)));
  }, [user, groupBy, from, to]);

  const reports: Array<{ key: string; label: string; hint: string; ranged?: boolean; statusFiltered?: boolean }> = [
    { key: 'expense-register', label: 'Expense Register', hint: 'Every expense with employee, department, category and payment state', ranged: true, statusFiltered: true },
    { key: 'expense-by-category', label: 'Expenses by Category', hint: 'Spend grouped by expense category', ranged: true },
    { key: 'expense-by-department', label: 'Expenses by Department', hint: 'Spend grouped by department', ranged: true },
    { key: 'expense-by-cost-centre', label: 'Expenses by Cost Centre', hint: 'Spend grouped by cost centre', ranged: true },
    { key: 'expense-by-project', label: 'Expenses by Project', hint: 'Spend grouped by project', ranged: true },
    { key: 'expense-by-supplier', label: 'Expenses by Supplier', hint: 'Spend grouped by supplier', ranged: true },
    { key: 'expense-by-employee', label: 'Expenses by Employee', hint: 'Spend grouped by employee', ranged: true },
    { key: 'expense-cash-bank', label: 'Expenses by Payment Method', hint: 'Cash, bank, mobile and other settlement channels', ranged: true },
    { key: 'expense-trend', label: 'Expense Trend', hint: 'Daily and monthly spend trend', ranged: true },
    { key: 'expense-planned-vs-unplanned', label: 'Planned vs Unplanned', hint: 'Budgeted spend versus emergency expenditure', ranged: true },
    { key: 'expense-budget-vs-actual', label: 'Budget vs Actual', hint: 'Approved, committed, actual and available per GL account', ranged: true },
    { key: 'expense-claims', label: 'Expense Claims Register', hint: 'Employee reimbursement claims by status' },
  ];

  const paramsFor = (r: { ranged?: boolean; statusFiltered?: boolean }) => () => {
    const p = new URLSearchParams();
    if (r.ranged && from) p.set('from', from);
    if (r.ranged && to) p.set('to', to);
    if (r.statusFiltered && status) p.set('status', status);
    return p;
  };

  return (
    <SpendShell
      title="Expenses Analysis"
      blurb="Expenses by employee and by category, with the same branded exports as the register."
      active="reports"
    >
      {!can(user, 'expenditure.reports.view') ? (
        <p className="empty-state">You don&apos;t have permission to view expense analysis.</p>
      ) : (
        <>
        <section className="card">
          <div className="card-head">
            <h3>{groupBy === 'employee' ? 'Expenses by Employee' : 'Expenses by Category'}</h3>
            <div>
              <button type="button" className={groupBy === 'employee' ? 'btn btn-sm btn-primary' : 'btn btn-sm'} onClick={() => setGroupBy('employee')}>By Employee</button>{' '}
              <button type="button" className={groupBy === 'category' ? 'btn btn-sm btn-primary' : 'btn btn-sm'} onClick={() => setGroupBy('category')}>By Category</button>
            </div>
          </div>
          {analysisError && <ErrorBanner error={analysisError} />}
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{groupBy === 'employee' ? 'Employee' : 'Category'}</th><th>Count</th><th>Total</th></tr></thead>
              <tbody>
                {grouped.map((row) => (
                  <tr key={s(row.label) || 'blank'}>
                    <td>{s(row.label) || 'Unassigned'}</td>
                    <td>{num(row.count)}</td>
                    <td>{fmtMoney(num(row.total))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!grouped.length && <p className="empty-state">No expenses in this period.</p>}
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h3>Branded report exports</h3></div>
          <p className="muted" style={{ margin: '0 0 12px' }}>
            Date presets apply to the date-filtered reports below. The register can also be narrowed to a single status.
          </p>
          <div className="toolbar" style={{ flexWrap: 'wrap', gap: 10, margin: '4px 0 12px' }}>
            <DatePresets onApply={(f, t) => { setFrom(f); setTo(t); }} />
            <select
              className="search-input"
              style={{ width: 'auto', maxWidth: 200 }}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Register status filter"
            >
              <option value="">All statuses</option>
              {['DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'POSTED', 'VOID', 'REJECTED'].map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Report</th><th>Description</th><th style={{ textAlign: 'right' }}>Export / print</th></tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <b>{r.label}</b>
                      {r.ranged ? <span className="muted"> · date-filtered</span> : null}
                    </td>
                    <td className="muted">{r.hint}</td>
                    <td style={{ textAlign: 'right' }}>
                      <ReportExportMenu reportKey={r.key} filename={r.key} params={paramsFor(r)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        </>
      )}
    </SpendShell>
  );
}
