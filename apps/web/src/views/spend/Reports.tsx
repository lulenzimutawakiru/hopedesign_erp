import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney } from '../../api';
import { useAuth, can } from '../../auth';
import { navigate } from '../../router';
import { Badge, ErrorBanner, Modal, PageLoader, Pager } from '../../components/ui';
import {
  CopyButton,
  MetaCard,
  Pipeline,
  SpendShell,
  SpendTabs,
  StatusFilter,
  fmtDay,
  num,
  personName,
  s,
  type Rec,
} from './kit';

const REPORT_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REIMBURSED', 'REJECTED', 'VOID'];
const REPORT_MODES = ['DIRECT', 'PAYSLIP'];

export function ReportsList() {
  const { user } = useAuth();
  const [items, setItems] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (page > 1) params.set('page', String(page));
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/expenditure/expense-reports?${params.toString()}`)
      .then((r) => { setItems(r.data.rows); setTotal(r.data.total); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [q, status, page]);
  useEffect(load, [load]);

  return (
    <SpendShell
      title="Expense Reports"
      blurb="Group approved employee claims into one sheet, then reimburse them in one action — straight to the employee or through the next payslip."
      active="reports"
      actions={
        can(user, 'expenditure.expense_reports.create') ? (
          <button type="button" className="btn btn-primary" onClick={() => navigate('/spend/reports/new')}>+ New Report</button>
        ) : null
      }
    >
      <div className="spend-toolbar">
        <input className="search-input" placeholder="Search report no / title…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ maxWidth: 260 }} />
        <StatusFilter value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={REPORT_STATUSES} />
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>{total} in this view</span>
      </div>
      {error && <ErrorBanner error={error} />}
      {loading ? <PageLoader /> : (
        <section className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Report No</th><th>Title</th><th>Employee</th><th>Claims</th><th>Total</th><th>Reimburse via</th><th>Status</th></tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={s(r.id)} className="row-click" onClick={() => navigate(`/spend/reports/${s(r.id)}`)}>
                    <td className="cell-mono">{s(r.reportNo)}</td>
                    <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s(r.title)}</td>
                    <td>{s(r.employeeName) || '—'}</td>
                    <td>{num(r.claimCount)}</td>
                    <td>{fmtMoney(num(r.totalAmount))}</td>
                    <td>{s(r.reimbursementMode).replace(/_/g, ' ')}</td>
                    <td><Badge value={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!items.length && <p className="empty-state">No expense reports yet. Create one to batch-reimburse employee claims.</p>}
          </div>
          {total > 30 && <Pager page={page} pageSize={30} total={total} onPage={setPage} />}
        </section>
      )}
    </SpendShell>
  );
}

export function ReportComposer() {
  const [title, setTitle] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [mode, setMode] = useState('DIRECT');
  const [description, setDescription] = useState('');
  const [meta, setMeta] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ data: Rec }>('/api/ops/expenditure/expense-reports/meta')
      .then((r) => setMeta(r.data))
      .catch((e) => setError(e.message));
  }, []);

  const employees = (meta?.employees as Rec[] | undefined) ?? [];

  const save = async () => {
    if (!title.trim()) { setError('Report title is required.'); return; }
    setBusy(true);
    setError('');
    try {
      const r = await api<{ data: Rec }>('/api/ops/expenditure/expense-reports', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          employeeId: num(employeeId) || undefined,
          reimbursementMode: mode,
        }),
      });
      navigate(`/spend/reports/${s(r.data.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-ghost" onClick={() => navigate('/spend/reports')}>← Expense Reports</button>
        <h1 style={{ margin: 0, flex: 1 }}>New Expense Report</h1>
      </div>
      <SpendTabs active="reports" />
      {error && <ErrorBanner error={error} />}
      <section className="card">
        <div className="card-head"><h3>Report details</h3></div>
        <div className="form-grid">
          <label className="field field-required" style={{ gridColumn: '1 / -1' }}>Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Field trip — March 2026" />
          </label>
          <label className="field">Employee
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Assign later</option>
              {employees.map((e) => <option key={s(e.id)} value={s(e.id)}>{s(e.name) || personName(e)}</option>)}
            </select>
          </label>
          <label className="field">Reimburse via
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              {REPORT_MODES.map((m) => <option key={m} value={m}>{m === 'PAYSLIP' ? 'Payslip (next payroll run)' : 'Direct (cash / bank)'}</option>)}
            </select>
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>Description
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional notes for the approver" />
          </label>
          <p className="muted" style={{ gridColumn: '1 / -1' }}>
            {mode === 'PAYSLIP'
              ? 'The report is reimbursed as a tax-free net addition on the employee’s next payroll run.'
              : 'The report is reimbursed directly once approved, posting a cash/bank journal.'}
          </p>
        </div>
        <div style={{ padding: '0 16px 16px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-ghost" onClick={() => navigate('/spend/reports')}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Creating…' : 'Create report'}
          </button>
        </div>
      </section>
    </div>
  );
}

export function ReportDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [row, setRow] = useState<Rec | null>(null);
  const [meta, setMeta] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showReimburse, setShowReimburse] = useState(false);

  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/expenditure/expense-reports/${id}`)
      .then((r) => setRow(r.data))
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/expenditure/expense-reports/meta')
      .then((r) => setMeta(r.data))
      .catch(() => undefined);
  }, []);

  const act = (action: string, label: string, body?: Rec) => {
    setBusy(action);
    setMsg('');
    api<{ data: Rec }>(`/api/ops/expenditure/expense-reports/${id}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}) })
      .then(() => { setMsg(`${label} — saved.`); setShowAdd(false); setShowReimburse(false); load(); })
      .catch((e) => setMsg(e.message))
      .finally(() => setBusy(''));
  };

  if (!row && !error) return <PageLoader variant="page" />;
  if (error) return <ErrorBanner error={error} />;
  const r = row as Rec;
  const claims = (r.claims as Rec[] | undefined) ?? [];
  const openClaims = (meta?.openClaims as Rec[] | undefined) ?? [];
  const isDraft = r.status === 'DRAFT';
  const isApproved = r.status === 'APPROVED';
  const isPayslip = s(r.reimbursementMode) === 'PAYSLIP';
  const queued = isApproved && isPayslip;

  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-ghost" onClick={() => navigate('/spend/reports')}>← Expense Reports</button>
        <h1 style={{ margin: 0, flex: 1 }}><span className="cell-mono">{s(r.reportNo)}</span> <Badge value={r.status} /></h1>
        <CopyButton value={s(r.reportNo)} />
        {isDraft && can(user, 'expenditure.expense_reports.update') && (
          <button className="btn" disabled={busy !== ''} onClick={() => setShowAdd(true)}>+ Add claim</button>
        )}
        {isDraft && can(user, 'expenditure.expense_reports.submit') && (
          <button className="btn btn-primary" disabled={busy !== ''} onClick={() => act('submit', 'Submitted for approval')}>
            {busy === 'submit' ? 'Working…' : 'Submit for Approval'}
          </button>
        )}
        {isApproved && !isPayslip && can(user, 'expenditure.expense_reports.reimburse') && (
          <button className="btn btn-primary" disabled={busy !== ''} onClick={() => setShowReimburse(true)}>Reimburse</button>
        )}
      </div>
      <SpendTabs active="reports" />
      {error && <ErrorBanner error={error} />}
      {msg && <div className="notice-banner">{msg}</div>}
      {queued && (
        <div className="notice-banner">Queued for the next payroll run — it will settle automatically as a tax-free net addition.</div>
      )}
      <Pipeline steps={['DRAFT', 'SUBMITTED', 'APPROVED', 'REIMBURSED']} status={s(r.status)} />

      <div className="form-grid">
        <MetaCard title="Report" rows={[
          ['Title', s(r.title)],
          ['Employee', s(r.employeeName) || '—'],
          ['Reimburse via', s(r.reimbursementMode).replace(/_/g, ' ')],
          ['Total', `${fmtMoney(num(r.totalAmount))} ${s(r.currency) || 'UGX'}`],
          ['Claims', String(num(r.claimCount))],
          ['Submitted', r.submittedAt ? fmtDay(r.submittedAt) : '—'],
          ['Approved', r.approvedAt ? fmtDay(r.approvedAt) : '—'],
          ['Reimbursed', r.reimbursedAt ? fmtDay(r.reimbursedAt) : '—'],
        ]} />
        <MetaCard title="Details" rows={[
          ['Description', s(r.description) || '—'],
          ['Created by', s(r.createdByName) || '—'],
          ['Approved by', s(r.approvedByName) || '—'],
          ['Reimbursed by', s(r.reimbursedByName) || '—'],
        ]} />
      </div>

      <section className="card">
        <div className="card-head"><h3>Claims in this report</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Claim No</th><th>Employee</th><th>Date</th><th>Description</th><th>Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {claims.map((c) => (
                <tr key={s(c.id)}>
                  <td className="cell-mono">{s(c.claimNo)}</td>
                  <td>{personName(c)}</td>
                  <td>{fmtDay(c.expenseDate)}</td>
                  <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s(c.description) || s(c.trip) || '—'}</td>
                  <td>{fmtMoney(num(c.amount))}</td>
                  <td><Badge value={c.status} /></td>
                  <td style={{ textAlign: 'right' }}>
                    {isDraft && can(user, 'expenditure.expense_reports.update') && (
                      <button className="btn btn-sm btn-ghost-danger" disabled={busy !== ''} onClick={() => act('remove-claim', 'Claim removed', { claimId: num(c.id) })}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!claims.length && <p className="empty-state">No claims added yet. Use “Add claim” to pull in approved, unreported claims.</p>}
        </div>
      </section>

      {showAdd && (
        <Modal title={`Add a claim to ${s(r.reportNo)}`} onClose={() => setShowAdd(false)}>
          {openClaims.length === 0 && <p className="empty-state">No approved, unreported claims are available to add.</p>}
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Claim No</th><th>Employee</th><th>Date</th><th>Amount</th><th></th></tr></thead>
              <tbody>
                {openClaims.map((c) => (
                  <tr key={s(c.id)}>
                    <td className="cell-mono">{s(c.claimNo)}</td>
                    <td>{personName(c)}</td>
                    <td>{fmtDay(c.expenseDate)}</td>
                    <td>{fmtMoney(num(c.amount))}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-sm btn-primary" disabled={busy !== ''} onClick={() => act('add-claim', 'Claim added', { claimId: num(c.id) })}>Add</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {showReimburse && (
        <Modal
          title={`Reimburse ${s(r.reportNo)}?`}
          onClose={() => setShowReimburse(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setShowReimburse(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== ''} onClick={() => act('reimburse', 'Reimbursed')}>
              {busy === 'reimburse' ? 'Working…' : 'Confirm Reimbursement'}
            </button>
          </>}
        >
          <p className="empty-state">
            Reimburses {fmtMoney(num(r.totalAmount))} across {num(r.claimCount)} claim(s) and posts a cash/bank journal.
          </p>
        </Modal>
      )}
    </div>
  );
}
