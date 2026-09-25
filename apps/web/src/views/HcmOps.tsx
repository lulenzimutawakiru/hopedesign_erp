import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, fmtDate, fmtMoney, fmtNum, openDocument } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';
import { ConfirmDialog } from '../components/os';
import { Avatar, CodeChip, HrKpi, HrKpiGrid, HrTableEmpty, HrToolbar } from '../components/hrUi';

type Rec = Record<string, unknown>;
const today = () => new Date().toISOString().slice(0, 10);

function nameOf(r: Rec) {
  return `${String(r.firstName ?? '')} ${String(r.lastName ?? '')}`.trim() || '—';
}

/** "HALF_YEAR" -> "Half Year". Shared by the performance and benefits desks. */
function pretty(v: unknown) {
  return String(v ?? '').replace(/_/g, ' ').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Inline progress bar, 0 to 100. */
function Meter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const tone = pct >= 100 ? '#168A5B' : pct >= 50 ? 'var(--mill)' : '#D97706';
  return (
    <div className="meter" style={{ margin: 0, minWidth: 120 }}>
      <div className="meter-head"><span>{fmtNum(Math.round(pct))}%</span></div>
      <div className="meter-track"><div className="meter-fill" style={{ width: `${pct}%`, background: tone }} /></div>
    </div>
  );
}

const GOAL_STATUSES: Array<[string, string]> = [['', 'All'], ['NOT_STARTED', 'Not started'], ['IN_PROGRESS', 'In progress'], ['ACHIEVED', 'Achieved'], ['ON_TRACK', 'On track'], ['AT_RISK', 'At risk'], ['PAST_DUE', 'Past due'], ['CANCELLED', 'Cancelled']];
const REVIEW_STATUSES: Array<[string, string]> = [['', 'All'], ['DRAFT', 'Draft'], ['IN_PROGRESS', 'In progress'], ['SUBMITTED', 'Submitted'], ['APPROVED', 'Approved'], ['COMPLETED', 'Completed'], ['CANCELLED', 'Cancelled']];
const PIP_STATUSES: Array<[string, string]> = [['', 'All'], ['OPEN', 'Open'], ['IN_PROGRESS', 'In progress'], ['IMPROVED', 'Improved'], ['CLOSED', 'Closed'], ['FAILED', 'Failed']];
/** Recorded on the PIP audit trail when the plan is closed. */
const PIP_OUTCOMES = ['IMPROVED', 'PARTIALLY_IMPROVED', 'NOT_IMPROVED', 'CLOSED'];

function useEmployees() {
  const [rows, setRows] = useState<Rec[]>([]);
  useEffect(() => {
    api<{ data: { rows: Rec[] } }>('/api/ops/hr/employees?pageSize=100')
      .then((r) => setRows(r.data.rows ?? []))
      .catch(() => undefined);
  }, []);
  return rows;
}

function EmpSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const employees = useEmployees();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select employee…</option>
      {employees.map((e) => (
        <option key={String(e.id)} value={String(e.id)}>{String(e.employeeNo)} · {nameOf(e)}</option>
      ))}
    </select>
  );
}

function Page({ kicker, title, sub, back, actions, children }: {
  kicker: string; title: string; sub?: string; back?: string; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          {back && <button className="btn btn-sm" onClick={() => navigate(back)}>Back</button>}
          <p className="mod-kicker" data-mod="hr">{kicker}</p>
          <h1>{title}</h1>
          {sub && <p className="muted">{sub}</p>}
        </div>
        {actions && <div className="head-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export default function HcmOps({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean);
  const view = parts[1] ?? 'me';
  const id = parts[2] ? Number(parts[2]) : null;
  if (view === 'loans' && id) return <LoanDesk id={id} />;
  if (view === 'loans') return <LoansList />;
  if (view === 'advances' && id) return <AdvanceDesk id={id} />;
  if (view === 'advances') return <AdvancesList />;
  if (view === 'payments' && id) return <PaymentDesk id={id} />;
  if (view === 'payments') return <PaymentsList />;
  if (view === 'performance') return <PerformanceDesk />;
  if (view === 'training') return <TrainingDesk />;
  if (view === 'benefits') return <BenefitsDesk />;
  if (view === 'relations') return <RelationsDesk />;
  if (view === 'time') return <TimeDesk />;
  return <MyHr />;
}

function useList(path: string, deps: unknown[] = []) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ data: Rec[] | { items?: Rec[]; rows?: Rec[] } }>(path)
      .then((r) => {
        const d = r.data;
        setRows(Array.isArray(d) ? d : (d.items ?? d.rows ?? []));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Load failed'));
  }, [path, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { rows, error, setError, load };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field"><label>{label}</label>{children}</div>;
}

// ============================================================
// MY HR
// ============================================================

function MyHr() {
  const { user } = useAuth();
  const [tab, setTab] = useState('profile');
  const [error, setError] = useState('');
  const [profile, setProfile] = useState<Rec | null>(null);
  const [leave, setLeave] = useState<Rec | null>(null);
  const [attendance, setAttendance] = useState<Rec[]>([]);
  const [payslips, setPayslips] = useState<Rec[]>([]);
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/hcm/me')
      .then((r) => setProfile(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Self-service requires a linked employee file'));
    api<{ data: Rec }>('/api/ops/hcm/me/leave').then((r) => setLeave(r.data)).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/hcm/me/attendance').then((r) => setAttendance(r.data ?? [])).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/hcm/me/payslips').then((r) => setPayslips(r.data ?? [])).catch(() => undefined);
  }, []);
  const clockFromDevice = (path: string) => {
    if (!navigator.geolocation) {
      setError('This device cannot share its location. A clock-in is only recorded at the factory.');
      return;
    }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        await api(path, {
          method: 'POST',
          body: JSON.stringify({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          }),
        });
        const r = await api<{ data: Rec[] }>('/api/ops/hcm/me/attendance');
        setAttendance(r.data ?? []);
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Clock-in was not recorded');
      }
    }, () => {
      setError('Allow location so the clock-in can be checked against the factory premises.');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  };
  const emp = (profile?.employee ?? null) as Rec | null;
  return (
    <Page kicker="Self-service" title="My HR" sub="Your file, leave, attendance and payslips. Link an ERP login to the employee record if this page is empty.">
      {error && <ErrorBanner error={error} />}
      {!emp && !error && <PageLoader label="Opening your HR file…" />}
      {emp && (
        <>
          <div className="tabs" style={{ marginBottom: 12 }}>
            {[['profile', 'Profile'], ['leave', 'Leave'], ['attendance', 'Attendance'], ['pay', 'Payslips']].map(([k, l]) => (
              <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          {tab === 'profile' && (
            <section className="card card-pad">
              <dl className="def-list">
                <div><dt>Employee no</dt><dd className="cell-mono">{String(emp.employeeNo)}</dd></div>
                <div><dt>Name</dt><dd>{nameOf(emp)}</dd></div>
                <div><dt>Position</dt><dd>{String(emp.position ?? '—')}</dd></div>
                <div><dt>Status</dt><dd><Badge value={emp.status} /></dd></div>
                <div><dt>Email</dt><dd>{String(emp.email ?? user?.email ?? '—')}</dd></div>
                <div><dt>Phone</dt><dd>{String(emp.phone ?? '—')}</dd></div>
              </dl>
              <div className="action-group" style={{ marginTop: 12 }}>
                <button className="btn btn-sm" onClick={() => navigate(`/people/employees/${emp.id}`)}>Open full file</button>
              </div>
            </section>
          )}
          {tab === 'leave' && (
            <div className="stack">
              <section className="card">
                <div className="card-head"><h3>Balances</h3></div>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Type</th><th className="cell-num">Year</th><th className="cell-num">Available</th></tr></thead>
                    <tbody>
                      {((leave?.balances as Rec[]) ?? []).map((b) => (
                        <tr key={String(b.id)}><td>{String(b.leaveTypeName ?? b.leaveTypeCode)}</td><td className="cell-num">{fmtNum(b.year)}</td><td className="cell-num">{fmtNum(b.available)}</td></tr>
                      ))}
                      {((leave?.balances as Rec[]) ?? []).length === 0 && <tr><td colSpan={3} className="muted">No balances yet.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="card">
                <div className="card-head"><h3>Requests</h3></div>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Type</th><th>From</th><th>To</th><th>Status</th></tr></thead>
                    <tbody>
                      {((leave?.leave as Rec[]) ?? []).map((r) => (
                        <tr key={String(r.id)}><td><Badge value={r.leaveType} /></td><td>{fmtDate(r.startDate)}</td><td>{fmtDate(r.endDate)}</td><td><Badge value={r.status} /></td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}
          {tab === 'attendance' && (
            <section className="card">
              <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <h3>Clock</h3>
                <div className="action-group">
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => clockFromDevice('/api/ops/hcm/me/clock-in')}>Clock in</button>
                  <button className="btn btn-sm" type="button" onClick={() => clockFromDevice('/api/ops/hcm/me/clock-out')}>Clock out</button>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Date</th><th>In</th><th>Out</th><th>Status</th></tr></thead>
                  <tbody>
                    {attendance.map((r) => (
                      <tr key={String(r.id)}><td>{fmtDate(r.workDate)}</td><td>{r.clockIn ? String(r.clockIn).slice(11, 16) : '—'}</td><td>{r.clockOut ? String(r.clockOut).slice(11, 16) : '—'}</td><td><Badge value={r.status} /></td></tr>
                    ))}
                    {attendance.length === 0 && <tr><td colSpan={4} className="muted">No clock records.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {tab === 'pay' && (
            <section className="card">
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Slip</th><th>Period</th><th className="cell-num">Net</th><th></th></tr></thead>
                  <tbody>
                    {payslips.map((r) => (
                      <tr key={String(r.id)}>
                        <td className="cell-mono">{String(r.payslipNo ?? r.payrollNo)}</td>
                        <td>{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}</td>
                        <td className="cell-num">{fmtMoney(r.netPay)}</td>
                        <td><button className="btn btn-sm" onClick={() => openDocument('payslip', r.id, 'pdf', String(r.payslipNo ?? 'payslip') + '.pdf')}>PDF</button></td>
                      </tr>
                    ))}
                    {payslips.length === 0 && <tr><td colSpan={4} className="muted">No published slips yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </Page>
  );
}

// ============================================================
// LOANS / ADVANCES / PAYMENTS
// ============================================================

function LoansList() {
  const { user } = useAuth();
  const { rows, error, setError, load } = useList('/api/ops/hr/loans?pageSize=50');
  const [open, setOpen] = useState(false);
  return (
    <Page kicker="Payroll deductions" title="Staff loans" sub="Book, approve and recover loans on the next payroll." back="/people"
      actions={can(user, 'hr.loans.create') ? <button className="btn btn-primary" onClick={() => setOpen(true)}>New loan</button> : undefined}>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>No</th><th>Employee</th><th className="cell-num">Amount</th><th className="cell-num">Outstanding</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/loans/${r.id}`)}>
                <td className="cell-mono">{String(r.loanNo)}</td>
                <td>{nameOf(r)} <span className="cell-mono">{String(r.employeeNo)}</span></td>
                <td className="cell-num">{fmtMoney(r.amount)}</td>
                <td className="cell-num">{fmtMoney(r.outstandingBalance ?? r.balance)}</td>
                <td><Badge value={r.status} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted">No loans on file.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && <LoanComposer onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); }} onError={setError} />}
    </Page>
  );
}

function LoanComposer({ onClose, onSaved, onError }: { onClose: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const [employeeId, setEmployeeId] = useState('');
  const [amount, setAmount] = useState('500000');
  const [monthly, setMonthly] = useState('50000');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/ops/hr/employees/${employeeId}/loans`, { method: 'POST', body: JSON.stringify({ amount: Number(amount), monthlyDeduction: Number(monthly) }) });
      onSaved();
    } catch (e) { onError(e instanceof Error ? e.message : 'Could not book loan'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="New staff loan" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !employeeId} onClick={save}>Book</button></>}>
      <div className="form-grid">
        <Field label="Employee"><EmpSelect value={employeeId} onChange={setEmployeeId} /></Field>
        <Field label="Amount"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Monthly deduction"><input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function LoanDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => { api<{ data: Rec }>(`/api/ops/hr/loans/${id}`).then((r) => setDoc(r.data)).catch((e) => setError(e instanceof Error ? e.message : 'Loan failed')); };
  useEffect(() => { load(); }, [id]);
  const act = async (path: string, ok: string) => {
    try { await api(path, { method: 'POST', body: '{}' }); setNotice(ok); load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  if (!doc && !error) return <PageLoader variant="page" label="Opening loan…" />;
  const loan = ((doc?.loan ?? doc) ?? {}) as Rec;
  return (
    <Page kicker="Staff loan" title={String(loan.loanNo ?? 'Loan')} back="/people/loans">
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      <dl className="def-list card card-pad">
        <div><dt>Employee</dt><dd>{nameOf(loan)} · {String(loan.employeeNo)}</dd></div>
        <div><dt>Amount</dt><dd>{fmtMoney(loan.amount)}</dd></div>
        <div><dt>Outstanding</dt><dd>{fmtMoney(loan.outstandingBalance ?? loan.balance)}</dd></div>
        <div><dt>Status</dt><dd><Badge value={loan.status} /></dd></div>
      </dl>
      <div className="action-group" style={{ marginTop: 12 }}>
        {String(loan.status) === 'PENDING' && can(user, 'hr.loans.approve') && (
          <>
            <button className="btn btn-primary" onClick={() => act(`/api/ops/hr/loans/${id}/approve`, 'Approved')}>Approve</button>
            <button className="btn" onClick={() => act(`/api/ops/hr/loans/${id}/reject`, 'Rejected')}>Reject</button>
          </>
        )}
        {String(loan.status) === 'ACTIVE' && can(user, 'hr.loans.update') && <button className="btn" onClick={() => act(`/api/ops/hr/loans/${id}/pause`, 'Paused')}>Pause</button>}
        {['ACTIVE', 'PAUSED'].includes(String(loan.status)) && can(user, 'hr.loans.write_off') && <button className="btn btn-warning" onClick={() => act(`/api/ops/hr/loans/${id}/write-off`, 'Written off')}>Write off</button>}
      </div>
    </Page>
  );
}

function AdvancesList() {
  const { user } = useAuth();
  const { rows, error, setError, load } = useList('/api/ops/hr/advances?pageSize=50');
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [amount, setAmount] = useState('300000');
  return (
    <Page kicker="Payroll deductions" title="Salary advances" sub="Recovered on the next payroll, subject to the advance ceiling." back="/people"
      actions={can(user, 'hr.advances.create') ? <button className="btn btn-primary" onClick={() => setOpen(true)}>New advance</button> : undefined}>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>No</th><th>Employee</th><th className="cell-num">Amount</th><th className="cell-num">Outstanding</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/advances/${r.id}`)}>
                <td className="cell-mono">{String(r.advanceNo)}</td>
                <td>{nameOf(r)} <span className="cell-mono">{String(r.employeeNo)}</span></td>
                <td className="cell-num">{fmtMoney(r.amount)}</td>
                <td className="cell-num">{fmtMoney(r.outstandingBalance)}</td>
                <td><Badge value={r.status} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted">No salary advances.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && (
        <Modal title="New salary advance" onClose={() => setOpen(false)} footer={<>
          <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn btn-primary" disabled={!employeeId} onClick={async () => {
            try {
              await api(`/api/ops/hr/employees/${employeeId}/advances`, { method: 'POST', body: JSON.stringify({ amount: Number(amount) }) });
              setOpen(false); load();
            } catch (e) { setError(e instanceof Error ? e.message : 'Advance failed'); }
          }}>Issue</button>
        </>}>
          <div className="form-grid">
            <Field label="Employee"><EmpSelect value={employeeId} onChange={setEmployeeId} /></Field>
            <Field label="Amount"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          </div>
        </Modal>
      )}
    </Page>
  );
}

function AdvanceDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => { api<{ data: Rec }>(`/api/ops/hr/advances/${id}`).then((r) => setDoc(r.data)).catch((e) => setError(e instanceof Error ? e.message : 'Advance failed')); };
  useEffect(() => { load(); }, [id]);
  const act = async (path: string, ok: string) => {
    try { await api(path, { method: 'POST', body: '{}' }); setNotice(ok); load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  if (!doc && !error) return <PageLoader variant="page" label="Opening advance…" />;
  const a = ((doc?.advance ?? doc) ?? {}) as Rec;
  return (
    <Page kicker="Salary advance" title={String(a.advanceNo ?? 'Advance')} back="/people/advances">
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      <dl className="def-list card card-pad">
        <div><dt>Employee</dt><dd>{nameOf(a)} · {String(a.employeeNo)}</dd></div>
        <div><dt>Amount</dt><dd>{fmtMoney(a.amount)}</dd></div>
        <div><dt>Outstanding</dt><dd>{fmtMoney(a.outstandingBalance)}</dd></div>
        <div><dt>Status</dt><dd><Badge value={a.status} /></dd></div>
      </dl>
      <div className="action-group" style={{ marginTop: 12 }}>
        {String(a.status) === 'PENDING' && can(user, 'hr.advances.approve') && (
          <>
            <button className="btn btn-primary" onClick={() => act(`/api/ops/hr/advances/${id}/approve`, 'Approved')}>Approve</button>
            <button className="btn" onClick={() => act(`/api/ops/hr/advances/${id}/reject`, 'Rejected')}>Reject</button>
          </>
        )}
        {String(a.status) === 'ACTIVE' && can(user, 'hr.advances.update') && <button className="btn" onClick={() => act(`/api/ops/hr/advances/${id}/close`, 'Closed')}>Close</button>}
      </div>
    </Page>
  );
}

function PaymentsList() {
  const { rows, error } = useList('/api/ops/hr/payment-batches?pageSize=50');
  return (
    <Page kicker="Payroll payments" title="Pay batches" sub="Bank files and confirmation after a payroll is approved or released." back="/people">
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Batch</th><th>Payroll</th><th className="cell-num">Amount</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/payments/${r.id}`)}>
                <td className="cell-mono">{String(r.batchNo)}</td>
                <td className="cell-mono">{String(r.payrollNo ?? r.payrollId ?? '—')}</td>
                <td className="cell-num">{fmtMoney(r.totalAmount)}</td>
                <td><Badge value={r.status} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} className="muted">No payment batches. Create one from an approved payroll run.</td></tr>}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

function PaymentDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => { api<{ data: Rec }>(`/api/ops/hr/payment-batches/${id}`).then((r) => setDoc(r.data)).catch((e) => setError(e instanceof Error ? e.message : 'Batch failed')); };
  useEffect(() => { load(); }, [id]);
  const act = async (path: string, ok: string) => {
    try { const r = await api<{ data: Rec }>(path, { method: 'POST', body: '{}' }); setNotice(ok); load(); return r.data; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return null; }
  };
  if (!doc && !error) return <PageLoader variant="page" label="Opening payment batch…" />;
  const items = (doc?.items as Rec[]) ?? [];
  return (
    <Page kicker="Pay batch" title={String(doc?.batchNo ?? 'Batch')} back="/people/payments">
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      <dl className="def-list card card-pad">
        <div><dt>Status</dt><dd><Badge value={doc?.status} /></dd></div>
        <div><dt>Amount</dt><dd>{fmtMoney(doc?.totalAmount)}</dd></div>
        <div><dt>Items</dt><dd>{fmtNum(doc?.itemCount ?? items.length)}</dd></div>
      </dl>
      <div className="action-group" style={{ margin: '12px 0' }}>
        {String(doc?.status) === 'DRAFT' && can(user, 'hr.payrolls.update') && <button className="btn" onClick={() => act(`/api/ops/hr/payment-batches/${id}/validate`, 'Validated')}>Validate</button>}
        {['DRAFT', 'VALIDATED'].includes(String(doc?.status)) && can(user, 'hr.payrolls.approve') && <button className="btn btn-primary" onClick={() => act(`/api/ops/hr/payment-batches/${id}/approve`, 'Approved')}>Approve</button>}
        {['APPROVED', 'EXPORTED'].includes(String(doc?.status)) && can(user, 'hr.payrolls.post') && (
          <>
            <button className="btn" onClick={() => act(`/api/ops/hr/payment-batches/${id}/export`, 'Export marked')}>Export</button>
            <button className="btn btn-success" onClick={() => act(`/api/ops/hr/payment-batches/${id}/confirm`, 'Payments confirmed')}>Confirm paid</button>
          </>
        )}
      </div>
      <section className="card">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Employee</th><th>Bank</th><th className="cell-num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={String(i.id)}>
                  <td>{nameOf(i)} <span className="cell-mono">{String(i.employeeNo)}</span></td>
                  <td>{String(i.bankName ?? '—')} {String(i.maskedAccountNo ?? '')}</td>
                  <td className="cell-num">{fmtMoney(i.amount)}</td>
                  <td><Badge value={i.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Page>
  );
}

// ============================================================
// PERFORMANCE / TRAINING / BENEFITS / RELATIONS / TIME
// ============================================================

function PerformanceDesk() {
  const { user } = useAuth();
  const [tab, setTab] = useState('goals');
  const goals = useList('/api/ops/hcm/performance/goals');
  const reviews = useList('/api/ops/hcm/performance/reviews');
  const pips = useList('/api/ops/hcm/performance/pips');
  const [meta, setMeta] = useState<{ goalCategories: string[]; reviewTypes: string[]; ratingMin: number; ratingMax: number }>({
    goalCategories: [], reviewTypes: [], ratingMin: 1, ratingMax: 5,
  });
  const [q, setQ] = useState('');
  const [goalStatus, setGoalStatus] = useState('');
  const [reviewStatus, setReviewStatus] = useState('');
  const [pipStatus, setPipStatus] = useState('');
  const [open, setOpen] = useState('');
  const [detail, setDetail] = useState<Rec | null>(null);
  const [form, setForm] = useState<Rec>({});
  const [kpis, setKpis] = useState<Rec[]>([]);
  const [pipGoals, setPipGoals] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const err = goals.error || reviews.error || pips.error;
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  // Goal categories, review types and the rating scale are configuration, not code.
  useEffect(() => {
    api<{ data: { goalCategories?: string[]; reviewTypes?: string[]; ratingScale?: { min?: number; max?: number } } }>('/api/ops/hcm/performance/meta')
      .then((r) => setMeta({
        goalCategories: r.data.goalCategories ?? [],
        reviewTypes: r.data.reviewTypes ?? [],
        ratingMin: Number(r.data.ratingScale?.min ?? 1),
        ratingMax: Number(r.data.ratingScale?.max ?? 5),
      }))
      .catch(() => undefined);
  }, []);

  const post = async (path: string, body: Rec) => {
    setBusy(true);
    goals.setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setOpen('');
      goals.load();
      reviews.load();
      pips.load();
    } catch (e) {
      goals.setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const goalTypes = meta.goalCategories.length ? meta.goalCategories : ['PERFORMANCE'];
  const reviewTypes = meta.reviewTypes.length ? meta.reviewTypes : ['ANNUAL'];
  const ratings = Array.from({ length: Math.max(1, meta.ratingMax - meta.ratingMin + 1) }, (_, i) => meta.ratingMin + i);

  const openGoal = () => {
    setForm({ category: goalTypes[0], startDate: today(), weight: '1' });
    setKpis([{ name: '', unit: '', targetValue: '', weight: '1' }]);
    setOpen('goal');
  };
  const openReview = () => {
    setForm({ reviewType: reviewTypes[0], periodStart: today().slice(0, 8) + '01', periodEnd: today() });
    setOpen('review');
  };
  const openPip = () => {
    setForm({ startDate: today() });
    setPipGoals([{ title: '', target: '' }]);
    setOpen('pip');
  };
  const openComplete = (r: Rec) => { setDetail(r); setForm({ overallRating: '', summary: '' }); setOpen('complete'); };
  const openClose = (r: Rec) => { setDetail(r); setForm({ outcome: PIP_OUTCOMES[0] }); setOpen('close'); };
  const setKpi = (i: number, k: string, v: unknown) => setKpis((rows) => rows.map((row, j) => (j === i ? { ...row, [k]: v } : row)));
  const setPipGoal = (i: number, k: string, v: unknown) => setPipGoals((rows) => rows.map((row, j) => (j === i ? { ...row, [k]: v } : row)));

  const kpiBody = () => kpis
    .filter((k) => String(k.name ?? '').trim())
    .map((k) => ({
      name: String(k.name).trim(),
      unit: k.unit ? String(k.unit) : undefined,
      targetValue: k.targetValue !== '' && k.targetValue !== undefined ? Number(k.targetValue) : undefined,
      weight: k.weight !== '' && k.weight !== undefined ? Number(k.weight) : undefined,
    }));
  const pipGoalBody = () => pipGoals
    .filter((g) => String(g.title ?? '').trim())
    .map((g) => ({ title: String(g.title).trim(), target: g.target ? String(g.target) : undefined }));

  const openGoals = goals.rows.filter((r) => !['ACHIEVED', 'CANCELLED'].includes(String(r.status)));
  const avgProgress = goals.rows.length
    ? Math.round(goals.rows.reduce((s, r) => s + Number(r.progress ?? 0), 0) / goals.rows.length)
    : 0;
  const reviewsRunning = reviews.rows.filter((r) => String(r.status) === 'IN_PROGRESS').length;
  const pipsOpen = pips.rows.filter((r) => ['OPEN', 'IN_PROGRESS'].includes(String(r.status))).length;

  const needle = q.trim().toLowerCase();
  const goalRows = goals.rows.filter((r) => {
    const byStatus = !goalStatus || String(r.status) === goalStatus;
    const byText = !needle || `${nameOf(r)} ${String(r.employeeNo ?? '')} ${String(r.title ?? '')} ${String(r.category ?? '')}`.toLowerCase().includes(needle);
    return byStatus && byText;
  });
  const reviewRows = reviews.rows.filter((r) => {
    const byStatus = !reviewStatus || String(r.status) === reviewStatus;
    const byText = !needle || `${nameOf(r)} ${String(r.employeeNo ?? '')} ${String(r.reviewType ?? '')}`.toLowerCase().includes(needle);
    return byStatus && byText;
  });
  const pipRows = pips.rows.filter((r) => {
    const byStatus = !pipStatus || String(r.status) === pipStatus;
    const byText = !needle || `${nameOf(r)} ${String(r.employeeNo ?? '')} ${String(r.reason ?? '')}`.toLowerCase().includes(needle);
    return byStatus && byText;
  });

  return (
    <Page kicker="Performance" title="Goals, reviews and PIPs" back="/people"
      actions={<>
        {can(user, 'hr.performance_goals.create') && <button className="btn" onClick={openGoal}>New goal</button>}
        {can(user, 'hr.performance_reviews.create') && <button className="btn" onClick={openReview}>Start review</button>}
        {can(user, 'hr.pips.create') && <button className="btn btn-primary" onClick={openPip}>Open PIP</button>}
      </>}>
      {err && <ErrorBanner error={err} />}

      <HrKpiGrid>
        <HrKpi label="Open goals" value={fmtNum(openGoals.length)} sub={`${fmtNum(goals.rows.length)} tracked`} />
        <HrKpi label="Average progress" value={`${fmtNum(avgProgress)}%`} sub="across all goals" accent="#1261A0" tint="rgba(18, 97, 160, 0.12)" />
        <HrKpi label="Reviews running" value={fmtNum(reviewsRunning)} sub={`${fmtNum(reviews.rows.length)} total`} accent="#D97706" tint="rgba(217, 119, 6, 0.12)" />
        <HrKpi label="Open PIPs" value={fmtNum(pipsOpen)} sub={`${fmtNum(pips.rows.length)} on record`} accent="#C93636" tint="rgba(201, 54, 54, 0.12)" />
      </HrKpiGrid>

      <div className="tabs" style={{ margin: '16px 0 12px' }}>
        {[['goals', 'Goals'], ['reviews', 'Reviews'], ['pips', 'PIPs']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'goals' && (
        <section className="card">
          <div className="card-head"><h3>Goals</h3><span className="muted">{fmtNum(goalRows.length)} shown</span></div>
          <HrToolbar>
            <input className="search-input" placeholder="Search employee, goal or category..." value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="chips">
              {GOAL_STATUSES.map(([k, l]) => (
                <button key={k || 'all'} className={goalStatus === k ? 'chip chip-on' : 'chip'} onClick={() => setGoalStatus(k)}>{l}</button>
              ))}
            </div>
          </HrToolbar>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Employee</th><th>Goal</th><th>Category</th><th>Timeline</th><th className="cell-num">Progress</th><th>Status</th></tr></thead>
            <tbody>
              {goalRows.map((r) => (
                <tr key={String(r.id)}>
                  <td><Avatar name={nameOf(r)} sub={String(r.employeeNo ?? '')} size="sm" /></td>
                  <td>{String(r.title ?? '')}{Number(r.weight ?? 1) !== 1 && <span className="muted">{' \u00b7 weight '}{fmtNum(r.weight)}</span>}</td>
                  <td><Badge value={r.category} /></td>
                  <td>{fmtDate(r.startDate)}{r.dueDate ? ` to ${fmtDate(r.dueDate)}` : ''}</td>
                  <td className="cell-num"><Meter value={Number(r.progress ?? 0)} /></td>
                  <td><Badge value={r.status} /></td>
                </tr>
              ))}
              {goalRows.length === 0 && (
                <HrTableEmpty colSpan={6}
                  title={goals.rows.length === 0 ? 'No goals yet' : 'No matches'}
                  hint={goals.rows.length === 0
                    ? 'Set a goal to start tracking performance, and add KPIs so progress updates itself.'
                    : 'Try a different search or status filter.'}>
                  {goals.rows.length === 0 && can(user, 'hr.performance_goals.create') && (
                    <button className="btn btn-primary" onClick={openGoal}>New goal</button>
                  )}
                </HrTableEmpty>
              )}
            </tbody>
          </table></div>
        </section>
      )}

      {tab === 'reviews' && (
        <section className="card">
          <div className="card-head"><h3>Reviews</h3><span className="muted">{fmtNum(reviewRows.length)} shown</span></div>
          <HrToolbar>
            <input className="search-input" placeholder="Search employee or review type..." value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="chips">
              {REVIEW_STATUSES.map(([k, l]) => (
                <button key={k || 'all'} className={reviewStatus === k ? 'chip chip-on' : 'chip'} onClick={() => setReviewStatus(k)}>{l}</button>
              ))}
            </div>
          </HrToolbar>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Employee</th><th>Type</th><th>Period</th><th>Due</th><th className="cell-num">Rating</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {reviewRows.map((r) => (
                <tr key={String(r.id)}>
                  <td><Avatar name={nameOf(r)} sub={String(r.employeeNo ?? '')} size="sm" /></td>
                  <td><Badge value={r.reviewType} /></td>
                  <td>{fmtDate(r.periodStart)} to {fmtDate(r.periodEnd)}</td>
                  <td>{r.dueDate ? fmtDate(r.dueDate) : <span className="muted">{'\u2014'}</span>}</td>
                  <td className="cell-num">{Number(r.overallRating) > 0 ? fmtNum(r.overallRating) : <span className="muted">{'\u2014'}</span>}</td>
                  <td><Badge value={r.status} /></td>
                  <td>{String(r.status) === 'IN_PROGRESS' && can(user, 'hr.performance_reviews.complete') && (
                    <button className="btn btn-sm" onClick={() => openComplete(r)}>Complete</button>
                  )}</td>
                </tr>
              ))}
              {reviewRows.length === 0 && (
                <HrTableEmpty colSpan={7}
                  title={reviews.rows.length === 0 ? 'No reviews yet' : 'No matches'}
                  hint={reviews.rows.length === 0
                    ? 'Start a review to record a rating and summary against an employee.'
                    : 'Try a different search or status filter.'}>
                  {reviews.rows.length === 0 && can(user, 'hr.performance_reviews.create') && (
                    <button className="btn btn-primary" onClick={openReview}>Start review</button>
                  )}
                </HrTableEmpty>
              )}
            </tbody>
          </table></div>
        </section>
      )}

      {tab === 'pips' && (
        <section className="card">
          <div className="card-head"><h3>Improvement plans</h3><span className="muted">{fmtNum(pipRows.length)} shown</span></div>
          <HrToolbar>
            <input className="search-input" placeholder="Search employee or reason..." value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="chips">
              {PIP_STATUSES.map(([k, l]) => (
                <button key={k || 'all'} className={pipStatus === k ? 'chip chip-on' : 'chip'} onClick={() => setPipStatus(k)}>{l}</button>
              ))}
            </div>
          </HrToolbar>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Employee</th><th>Reason</th><th>Window</th><th className="cell-num">Progress</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {pipRows.map((r) => (
                <tr key={String(r.id)}>
                  <td><Avatar name={nameOf(r)} sub={String(r.employeeNo ?? '')} size="sm" /></td>
                  <td>{String(r.reason ?? '')}</td>
                  <td>{fmtDate(r.startDate)}{r.endDate ? ` to ${fmtDate(r.endDate)}` : ''}</td>
                  <td className="cell-num"><Meter value={Number(r.progress ?? 0)} /></td>
                  <td><Badge value={r.status} /></td>
                  <td>{String(r.status) === 'OPEN' && can(user, 'hr.pips.close') && (
                    <button className="btn btn-sm" onClick={() => openClose(r)}>Close</button>
                  )}</td>
                </tr>
              ))}
              {pipRows.length === 0 && (
                <HrTableEmpty colSpan={6}
                  title={pips.rows.length === 0 ? 'No improvement plans yet' : 'No matches'}
                  hint={pips.rows.length === 0
                    ? 'Open a plan to document the support an employee needs, and what good looks like.'
                    : 'Try a different search or status filter.'}>
                  {pips.rows.length === 0 && can(user, 'hr.pips.create') && (
                    <button className="btn btn-primary" onClick={openPip}>Open PIP</button>
                  )}
                </HrTableEmpty>
              )}
            </tbody>
          </table></div>
        </section>
      )}

      {open === 'goal' && (
        <Modal title="New performance goal" wide onClose={() => setOpen('')}
          footer={<><button className="btn" onClick={() => setOpen('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !form.employeeId || !String(form.title ?? '').trim()}
              onClick={() => post('/api/ops/hcm/performance/goals', {
                employeeId: Number(form.employeeId),
                title: String(form.title).trim(),
                description: form.description ? String(form.description) : undefined,
                category: form.category ? String(form.category) : undefined,
                startDate: form.startDate ? String(form.startDate) : undefined,
                dueDate: form.dueDate ? String(form.dueDate) : undefined,
                weight: form.weight !== '' && form.weight !== undefined ? Number(form.weight) : undefined,
                kpis: kpiBody(),
              })}>Save goal</button></>}>
          <div className="form-grid">
            <Field label="Employee"><EmpSelect value={String(form.employeeId ?? '')} onChange={(v) => set('employeeId', v)} /></Field>
            <Field label="Category">
              <select value={String(form.category ?? '')} onChange={(e) => set('category', e.target.value)}>
                {goalTypes.map((c) => <option key={c} value={c}>{pretty(c)}</option>)}
              </select>
            </Field>
            <Field label="Goal"><input value={String(form.title ?? '')} placeholder="e.g. Grow regional revenue" onChange={(e) => set('title', e.target.value)} /></Field>
            <Field label="Weight"><input type="number" value={String(form.weight ?? '')} onChange={(e) => set('weight', e.target.value)} /></Field>
            <Field label="Start date"><input type="date" value={String(form.startDate ?? '')} onChange={(e) => set('startDate', e.target.value)} /></Field>
            <Field label="Due date"><input type="date" value={String(form.dueDate ?? '')} onChange={(e) => set('dueDate', e.target.value)} /></Field>
          </div>
          <Field label="Description"><textarea value={String(form.description ?? '')} placeholder="What does success look like?" onChange={(e) => set('description', e.target.value)} /></Field>
          <div style={{ marginTop: 14 }}>
            <div className="ke-row ke-row-head"><span>KPI</span><span>Unit</span><span>Target</span><span>Weight</span><span /></div>
            {kpis.map((k, i) => (
              <div className="ke-row" key={i}>
                <input value={String(k.name ?? '')} placeholder="e.g. Deals closed" onChange={(e) => setKpi(i, 'name', e.target.value)} />
                <input value={String(k.unit ?? '')} placeholder="Unit" onChange={(e) => setKpi(i, 'unit', e.target.value)} />
                <input type="number" value={String(k.targetValue ?? '')} placeholder="100" onChange={(e) => setKpi(i, 'targetValue', e.target.value)} />
                <input type="number" value={String(k.weight ?? '')} placeholder="1" onChange={(e) => setKpi(i, 'weight', e.target.value)} />
                <button type="button" className="ke-row-del" title="Remove KPI" onClick={() => setKpis((rows) => rows.filter((_, j) => j !== i))}>{'\u00d7'}</button>
              </div>
            ))}
            <button type="button" className="btn btn-sm ke-add" onClick={() => setKpis((rows) => [...rows, { name: '', unit: '', targetValue: '', weight: '1' }])}>Add KPI</button>
            <p className="muted" style={{ marginTop: 8 }}>Progress tracks the weighted share of KPIs that reach their target.</p>
          </div>
          <p className="muted" style={{ marginTop: 10 }}>Categories come from Organisation Settings - HR, so they can change without a deploy.</p>
        </Modal>
      )}

      {open === 'review' && (
        <Modal title="Start performance review" onClose={() => setOpen('')}
          footer={<><button className="btn" onClick={() => setOpen('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !form.employeeId}
              onClick={() => post('/api/ops/hcm/performance/reviews', {
                employeeId: Number(form.employeeId),
                reviewType: form.reviewType ? String(form.reviewType) : undefined,
                periodStart: form.periodStart ? String(form.periodStart) : undefined,
                periodEnd: form.periodEnd ? String(form.periodEnd) : undefined,
                dueDate: form.dueDate ? String(form.dueDate) : undefined,
              })}>Start review</button></>}>
          <div className="form-grid">
            <Field label="Employee"><EmpSelect value={String(form.employeeId ?? '')} onChange={(v) => set('employeeId', v)} /></Field>
            <Field label="Review type">
              <select value={String(form.reviewType ?? '')} onChange={(e) => set('reviewType', e.target.value)}>
                {reviewTypes.map((t) => <option key={t} value={t}>{pretty(t)}</option>)}
              </select>
            </Field>
            <Field label="Period start"><input type="date" value={String(form.periodStart ?? '')} onChange={(e) => set('periodStart', e.target.value)} /></Field>
            <Field label="Period end"><input type="date" value={String(form.periodEnd ?? '')} onChange={(e) => set('periodEnd', e.target.value)} /></Field>
            <Field label="Due date"><input type="date" value={String(form.dueDate ?? '')} onChange={(e) => set('dueDate', e.target.value)} /></Field>
          </div>
          <p className="muted" style={{ marginTop: 10 }}>Review types come from Organisation Settings - HR, so they can change without a deploy.</p>
        </Modal>
      )}

      {open === 'pip' && (
        <Modal title="Open improvement plan" wide onClose={() => setOpen('')}
          footer={<><button className="btn" onClick={() => setOpen('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !form.employeeId || !String(form.reason ?? '').trim()}
              onClick={() => post('/api/ops/hcm/performance/pips', {
                employeeId: Number(form.employeeId),
                reason: String(form.reason).trim(),
                startDate: form.startDate ? String(form.startDate) : undefined,
                endDate: form.endDate ? String(form.endDate) : undefined,
                goals: pipGoalBody(),
              })}>Open plan</button></>}>
          <div className="form-grid">
            <Field label="Employee"><EmpSelect value={String(form.employeeId ?? '')} onChange={(v) => set('employeeId', v)} /></Field>
            <Field label="Start date"><input type="date" value={String(form.startDate ?? '')} onChange={(e) => set('startDate', e.target.value)} /></Field>
            <Field label="End date"><input type="date" value={String(form.endDate ?? '')} onChange={(e) => set('endDate', e.target.value)} /></Field>
          </div>
          <Field label="Reason"><textarea value={String(form.reason ?? '')} placeholder="Why is this plan being opened?" onChange={(e) => set('reason', e.target.value)} /></Field>
          <div style={{ marginTop: 14 }}>
            <div className="ke-row ke-row-head" style={{ gridTemplateColumns: '1fr 1fr 30px' }}><span>Improvement goal</span><span>Target</span><span /></div>
            {pipGoals.map((g, i) => (
              <div className="ke-row" style={{ gridTemplateColumns: '1fr 1fr 30px' }} key={i}>
                <input value={String(g.title ?? '')} placeholder="e.g. Close 10 tickets a week" onChange={(e) => setPipGoal(i, 'title', e.target.value)} />
                <input value={String(g.target ?? '')} placeholder="Target" onChange={(e) => setPipGoal(i, 'target', e.target.value)} />
                <button type="button" className="ke-row-del" title="Remove goal" onClick={() => setPipGoals((rows) => rows.filter((_, j) => j !== i))}>{'\u00d7'}</button>
              </div>
            ))}
            <button type="button" className="btn btn-sm ke-add" onClick={() => setPipGoals((rows) => [...rows, { title: '', target: '' }])}>Add goal</button>
          </div>
        </Modal>
      )}

      {open === 'complete' && detail && (
        <Modal title="Complete review" onClose={() => setOpen('')}
          footer={<><button className="btn" onClick={() => setOpen('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !form.overallRating}
              onClick={() => post(`/api/ops/hcm/performance/reviews/${String(detail.id)}/complete`, {
                overallRating: form.overallRating !== '' ? Number(form.overallRating) : undefined,
                summary: form.summary ? String(form.summary) : undefined,
              })}>Complete review</button></>}>
          <dl className="def-list" style={{ marginBottom: 12 }}>
            <div><dt>Employee</dt><dd>{nameOf(detail)}</dd></div>
            <div><dt>Type</dt><dd><Badge value={detail.reviewType} /></dd></div>
            <div><dt>Period</dt><dd>{fmtDate(detail.periodStart)} to {fmtDate(detail.periodEnd)}</dd></div>
          </dl>
          <Field label={`Overall rating (${meta.ratingMin}-${meta.ratingMax})`}>
            <div className="chips">
              {ratings.map((n) => (
                <button key={n} type="button" className={Number(form.overallRating) === n ? 'chip chip-on' : 'chip'} onClick={() => set('overallRating', n)}>{'\u2605'.repeat(n)}</button>
              ))}
            </div>
          </Field>
          <Field label="Summary"><textarea value={String(form.summary ?? '')} onChange={(e) => set('summary', e.target.value)} /></Field>
        </Modal>
      )}

      {open === 'close' && detail && (
        <Modal title="Close improvement plan" onClose={() => setOpen('')}
          footer={<><button className="btn" onClick={() => setOpen('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !form.outcome}
              onClick={() => post(`/api/ops/hcm/performance/pips/${String(detail.id)}/close`, {
                outcome: String(form.outcome),
              })}>Close plan</button></>}>
          <dl className="def-list" style={{ marginBottom: 12 }}>
            <div><dt>Employee</dt><dd>{nameOf(detail)}</dd></div>
            <div><dt>Reason</dt><dd>{String(detail.reason ?? '')}</dd></div>
          </dl>
          <Field label="Outcome">
            <div className="chips">
              {PIP_OUTCOMES.map((o) => (
                <button key={o} type="button" className={form.outcome === o ? 'chip chip-on' : 'chip'} onClick={() => set('outcome', o)}>{pretty(o)}</button>
              ))}
            </div>
          </Field>
          <p className="muted" style={{ marginTop: 10 }}>The outcome is written to the plan audit trail when it is closed.</p>
        </Modal>
      )}
    </Page>
  );
}

function TrainingDesk() {
  const { user } = useAuth();
  const catalog = useList('/api/ops/hcm/training/catalog');
  const sessions = useList('/api/ops/hcm/training/sessions');
  const requests = useList('/api/ops/hcm/training/requests');
  const enrollments = useList('/api/ops/hcm/training/enrollments');
  const [tab, setTab] = useState('requests');
  const [open, setOpen] = useState('');
  const [title, setTitle] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [trainingId, setTrainingId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [startDate, setStartDate] = useState(today());
  const err = catalog.error || requests.error;
  const post = async (path: string, body: Rec, reload: () => void) => {
    try { await api(path, { method: 'POST', body: JSON.stringify(body) }); setOpen(''); reload(); catalog.load(); sessions.load(); requests.load(); enrollments.load(); }
    catch (e) { catalog.setError(e instanceof Error ? e.message : 'Action failed'); }
  };
  return (
    <Page kicker="Learning" title="Training" back="/people"
      actions={<>
        {can(user, 'hr.training_catalog.create') && <button className="btn" onClick={() => setOpen('course')}>New course</button>}
        {can(user, 'hr.training_sessions.create') && <button className="btn" onClick={() => setOpen('session')}>Schedule session</button>}
        {can(user, 'hr.training_requests.create') && <button className="btn btn-primary" onClick={() => setOpen('request')}>Request training</button>}
      </>}>
      {err && <ErrorBanner error={err} />}
      <div className="tabs" style={{ marginBottom: 12 }}>
        {[['requests', 'Requests'], ['sessions', 'Sessions'], ['enrollments', 'Enrollments'], ['catalog', 'Catalog']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'requests' && <section className="card"><div className="table-wrap"><table className="data">
        <thead><tr><th>Employee</th><th>Course</th><th>Status</th><th></th></tr></thead>
        <tbody>{requests.rows.map((r) => (
          <tr key={String(r.id)}>
            <td>{nameOf(r)}</td><td>{String(r.trainingTitle ?? r.trainingCode)}</td><td><Badge value={r.status} /></td>
            <td>{String(r.status) === 'SUBMITTED' && can(user, 'hr.training_requests.approve') && (
              <button className="btn btn-sm" onClick={() => post(`/api/ops/hcm/training/requests/${r.id}/approve`, {}, requests.load)}>Approve</button>
            )}</td>
          </tr>
        ))}</tbody>
      </table></div></section>}
      {tab === 'sessions' && <section className="card"><div className="table-wrap"><table className="data">
        <thead><tr><th>Session</th><th>Course</th><th>Start</th><th>Status</th></tr></thead>
        <tbody>{sessions.rows.map((r) => (
          <tr key={String(r.id)}><td className="cell-mono">{String(r.code)}</td><td>{String(r.trainingTitle)}</td><td>{fmtDate(r.startDate)}</td><td><Badge value={r.status} /></td></tr>
        ))}</tbody>
      </table></div></section>}
      {tab === 'enrollments' && <section className="card"><div className="table-wrap"><table className="data">
        <thead><tr><th>Employee</th><th>Course</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {enrollments.rows.map((r) => (
            <tr key={String(r.id)}>
              <td>{nameOf(r)}</td><td>{String(r.trainingTitle)}</td><td><Badge value={r.status} /></td>
              <td>{String(r.status) === 'ENROLLED' && can(user, 'hr.training_sessions.complete') && (
                <button className="btn btn-sm" onClick={() => post(`/api/ops/hcm/training/enrollments/${r.id}/complete`, {}, enrollments.load)}>Complete</button>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {can(user, 'hr.training_enrollments.create') && (
        <div className="card-pad"><button className="btn btn-sm" onClick={() => setOpen('enroll')}>Enroll employee</button></div>
      )}
      </section>}
      {tab === 'catalog' && <section className="card"><div className="table-wrap"><table className="data">
        <thead><tr><th>Code</th><th>Title</th><th>Category</th><th>Status</th></tr></thead>
        <tbody>{catalog.rows.map((r) => (
          <tr key={String(r.id)}><td className="cell-mono">{String(r.code)}</td><td>{String(r.title)}</td><td>{String(r.category ?? '—')}</td><td><Badge value={r.status} /></td></tr>
        ))}</tbody>
      </table></div></section>}
      {open && (
        <Modal title="Training" onClose={() => setOpen('')}
          footer={<><button className="btn" onClick={() => setOpen('')}>Cancel</button>
            <button className="btn btn-primary" onClick={() => {
              if (open === 'course') post('/api/ops/hcm/training/catalog', { title }, catalog.load);
              else if (open === 'session') post('/api/ops/hcm/training/sessions', { trainingId: Number(trainingId), startDate }, sessions.load);
              else if (open === 'request') post('/api/ops/hcm/training/requests', { employeeId: Number(employeeId), trainingId: Number(trainingId) }, requests.load);
              else post('/api/ops/hcm/training/enrollments', { employeeId: Number(employeeId), sessionId: Number(sessionId) }, enrollments.load);
            }}>Save</button></>}>
          <div className="form-grid">
            {open === 'course' && <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>}
            {(open === 'session' || open === 'request') && (
              <Field label="Course"><select value={trainingId} onChange={(e) => setTrainingId(e.target.value)}><option value="">Select…</option>{catalog.rows.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.title)}</option>)}</select></Field>
            )}
            {open === 'session' && <Field label="Start"><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>}
            {(open === 'request' || open === 'enroll') && <Field label="Employee"><EmpSelect value={employeeId} onChange={setEmployeeId} /></Field>}
            {open === 'enroll' && (
              <Field label="Session"><select value={sessionId} onChange={(e) => setSessionId(e.target.value)}><option value="">Select…</option>{sessions.rows.map((s) => <option key={String(s.id)} value={String(s.id)}>{String(s.code)} · {String(s.trainingTitle)}</option>)}</select></Field>
            )}
          </div>
        </Modal>
      )}
    </Page>
  );
}

function BenefitsDesk() {
  const { user } = useAuth();
  const [tab, setTab] = useState('enrollments');
  const plans = useList('/api/ops/hcm/benefits/plans');
  const enrollments = useList('/api/ops/hcm/benefits/enrollments');
  const [meta, setMeta] = useState<{ categories: string[]; expiryDays: number }>({ categories: [], expiryDays: 30 });
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [open, setOpen] = useState('');
  const [detail, setDetail] = useState<Rec | null>(null);
  const [form, setForm] = useState<Rec>({});
  const [busy, setBusy] = useState(false);
  const err = plans.error || enrollments.error;
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  // Category vocabulary and the expiry window are configuration, not code.
  useEffect(() => {
    api<{ data: { benefitCategories?: string[]; expiryWarningDays?: number } }>('/api/ops/hcm/benefits/meta')
      .then((r) => setMeta({
        categories: r.data.benefitCategories ?? [],
        expiryDays: r.data.expiryWarningDays ?? 30,
      }))
      .catch(() => undefined);
  }, []);

  const post = async (path: string, body: Rec) => {
    setBusy(true);
    plans.setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setOpen('');
      plans.load();
      enrollments.load();
    } catch (e) {
      plans.setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };
  const openPlan = () => { setForm({ category: meta.categories[0] ?? '' }); setOpen('plan'); };
  const openEnroll = () => { setForm({ effectiveFrom: today() }); setOpen('enroll'); };
  const openResign = (r: Rec) => { setDetail(r); setForm({ effectiveTo: today() }); setOpen('resign'); };

  const activePlans = plans.rows.filter((p) => String(p.status ?? 'ACTIVE') === 'ACTIVE');
  const activeEnroll = enrollments.rows.filter((r) => String(r.status) === 'ACTIVE');
  const monthly = activeEnroll.reduce((s, r) => s + Number(r.monthlyCost ?? 0), 0);
  const now = Date.now();
  const expiring = activeEnroll.filter((r) => {
    const t = r.effectiveTo ? new Date(String(r.effectiveTo)).getTime() : NaN;
    return Number.isFinite(t) && t >= now && t <= now + meta.expiryDays * 86400000;
  });
  const enrolledCount = (planId: unknown) => enrollments.rows.filter((r) => String(r.planId) === String(planId)).length;

  const needle = q.trim().toLowerCase();
  const planRows = plans.rows.filter((p) => {
    const byCat = !category || String(p.category) === category;
    const byText = !needle || `${String(p.code ?? '')} ${String(p.name ?? '')} ${String(p.provider ?? '')} ${String(p.category ?? '')}`.toLowerCase().includes(needle);
    return byCat && byText;
  });
  const enrollRows = enrollments.rows.filter((r) => {
    const byStatus = !status || String(r.status) === status;
    const byText = !needle || `${nameOf(r)} ${String(r.employeeNo ?? '')} ${String(r.planName ?? '')} ${String(r.planCode ?? '')}`.toLowerCase().includes(needle);
    return byStatus && byText;
  });
  const selectedPlan = plans.rows.find((p) => String(p.id) === String(form.planId));

  return (
    <Page kicker="Benefits" title="Benefit plans and enrolments" back="/people"
      actions={<>
        {can(user, 'hr.benefit_plans.create') && <button className="btn" onClick={openPlan}>New plan</button>}
        {can(user, 'hr.benefit_enrollments.enroll') && <button className="btn btn-primary" onClick={openEnroll}>Enrol employee</button>}
      </>}>
      {err && <ErrorBanner error={err} />}

      <HrKpiGrid>
        <HrKpi label="Active plans" value={fmtNum(activePlans.length)} sub={`${fmtNum(plans.rows.length)} in catalogue`} />
        <HrKpi label="Enrolled" value={fmtNum(activeEnroll.length)} sub="active enrolments" accent="#1261A0" tint="rgba(18, 97, 160, 0.12)" />
        <HrKpi label="Monthly cost" value={fmtMoney(monthly)} sub="active enrolments" accent="#168A5B" tint="rgba(22, 138, 91, 0.12)" />
        <HrKpi label="Expiring" value={fmtNum(expiring.length)} sub={`next ${meta.expiryDays} days`} accent="#D97706" tint="rgba(217, 119, 6, 0.12)" />
      </HrKpiGrid>

      <div className="tabs" style={{ margin: '16px 0 12px' }}>
        {[['enrollments', 'Enrolments'], ['plans', 'Plans']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'enrollments' && (
        <section className="card">
          <div className="card-head"><h3>Enrolments</h3><span className="muted">{fmtNum(enrollRows.length)} shown</span></div>
          <HrToolbar>
            <input className="search-input" placeholder="Search employee, plan or code..." value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="chips">
              {[['', 'All'], ['ACTIVE', 'Active'], ['CANCELLED', 'Cancelled']].map(([k, l]) => (
                <button key={k || 'all'} className={status === k ? 'chip chip-on' : 'chip'} onClick={() => setStatus(k)}>{l}</button>
              ))}
            </div>
          </HrToolbar>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Employee</th><th>Plan</th><th>Category</th><th>Effective</th><th className="cell-num">Monthly cost</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {enrollRows.map((r) => (
                <tr key={String(r.id)}>
                  <td><Avatar name={nameOf(r)} sub={String(r.employeeNo ?? '')} size="sm" /></td>
                  <td>{String(r.planName ?? '')} <CodeChip>{String(r.planCode ?? '')}</CodeChip></td>
                  <td><Badge value={r.category} /></td>
                  <td>{fmtDate(r.effectiveFrom)}{r.effectiveTo ? ` to ${fmtDate(r.effectiveTo)}` : ''}</td>
                  <td className="cell-num">{fmtMoney(r.monthlyCost)}</td>
                  <td><Badge value={r.status} /></td>
                  <td>{String(r.status) === 'ACTIVE' && can(user, 'hr.benefit_enrollments.update') && (
                    <button className="btn btn-sm" onClick={() => openResign(r)}>Resign</button>
                  )}</td>
                </tr>
              ))}
              {enrollRows.length === 0 && (
                <HrTableEmpty colSpan={7}
                  title={enrollments.rows.length === 0 ? 'No enrolments yet' : 'No matches'}
                  hint={enrollments.rows.length === 0
                    ? 'Enrol an employee onto a benefit plan to see them here.'
                    : 'Try a different search or status filter.'}>
                  {enrollments.rows.length === 0 && can(user, 'hr.benefit_enrollments.enroll') && (
                    <button className="btn btn-primary" onClick={openEnroll}>Enrol employee</button>
                  )}
                </HrTableEmpty>
              )}
            </tbody>
          </table></div>
        </section>
      )}

      {tab === 'plans' && (
        <section className="card">
          <div className="card-head"><h3>Plans</h3><span className="muted">{fmtNum(planRows.length)} shown</span></div>
          <HrToolbar>
            <input className="search-input" placeholder="Search plan, provider or code..." value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="chips">
              {[['', 'All'], ...meta.categories.map((c) => [c, pretty(c)])].map(([k, l]) => (
                <button key={k || 'all'} className={category === k ? 'chip chip-on' : 'chip'} onClick={() => setCategory(k)}>{l}</button>
              ))}
            </div>
          </HrToolbar>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Plan</th><th>Category</th><th>Provider</th><th className="cell-num">Cost</th><th className="cell-num">Employee</th><th className="cell-num">Employer</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {planRows.map((p) => (
                <tr key={String(p.id)}>
                  <td><CodeChip>{String(p.code ?? '')}</CodeChip> {String(p.name ?? '')}</td>
                  <td><Badge value={p.category} /></td>
                  <td>{String(p.provider ?? '-')}</td>
                  <td className="cell-num">{fmtMoney(p.cost)}</td>
                  <td className="cell-num">{fmtMoney(p.employeeContribution)}</td>
                  <td className="cell-num">{fmtMoney(p.employerContribution)}</td>
                  <td><Badge value={p.status} /></td>
                  <td><button className="btn btn-sm" onClick={() => { setDetail(p); setOpen('detail'); }}>Details</button></td>
                </tr>
              ))}
              {planRows.length === 0 && (
                <HrTableEmpty colSpan={8}
                  title={plans.rows.length === 0 ? 'No plans yet' : 'No matches'}
                  hint={plans.rows.length === 0
                    ? 'Create a benefit plan to start enrolling employees.'
                    : 'Try a different search or category.'}>
                  {plans.rows.length === 0 && can(user, 'hr.benefit_plans.create') && (
                    <button className="btn btn-primary" onClick={openPlan}>New plan</button>
                  )}
                </HrTableEmpty>
              )}
            </tbody>
          </table></div>
        </section>
      )}

      {open === 'detail' && detail && (
        <Modal title="Benefit plan" onClose={() => setOpen('')}
          footer={<button className="btn" onClick={() => setOpen('')}>Close</button>}>
          <dl className="def-list">
            <div><dt>Code</dt><dd><CodeChip>{String(detail.code ?? '')}</CodeChip></dd></div>
            <div><dt>Name</dt><dd>{String(detail.name ?? '')}</dd></div>
            <div><dt>Category</dt><dd><Badge value={detail.category} /></dd></div>
            <div><dt>Provider</dt><dd>{String(detail.provider ?? '-')}</dd></div>
            <div><dt>Monthly cost</dt><dd>{fmtMoney(detail.cost)}</dd></div>
            <div><dt>Employee share</dt><dd>{fmtMoney(detail.employeeContribution)}</dd></div>
            <div><dt>Employer share</dt><dd>{fmtMoney(detail.employerContribution)}</dd></div>
            <div><dt>Status</dt><dd><Badge value={detail.status} /></dd></div>
            <div><dt>Enrolments</dt><dd>{fmtNum(enrolledCount(detail.id))}</dd></div>
          </dl>
        </Modal>
      )}

      {open === 'plan' && (
        <Modal title="New benefit plan" wide onClose={() => setOpen('')}
          footer={<><button className="btn" onClick={() => setOpen('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !String(form.name ?? '').trim()}
              onClick={() => post('/api/ops/hcm/benefits/plans', {
                name: String(form.name),
                code: form.code ? String(form.code) : undefined,
                category: form.category ? String(form.category) : undefined,
                provider: form.provider ? String(form.provider) : undefined,
                cost: form.cost !== undefined && form.cost !== '' ? Number(form.cost) : undefined,
                employeeContribution: form.employeeContribution !== undefined && form.employeeContribution !== '' ? Number(form.employeeContribution) : undefined,
                employerContribution: form.employerContribution !== undefined && form.employerContribution !== '' ? Number(form.employerContribution) : undefined,
              })}>Save plan</button></>}>
          <div className="form-grid">
            <Field label="Name"><input value={String(form.name ?? '')} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Code"><input value={String(form.code ?? '')} placeholder="Auto" onChange={(e) => set('code', e.target.value)} /></Field>
            <Field label="Category">
              <select value={String(form.category ?? '')} onChange={(e) => set('category', e.target.value)}>
                <option value="">Default</option>
                {meta.categories.map((c) => <option key={c} value={c}>{pretty(c)}</option>)}
              </select>
            </Field>
            <Field label="Provider"><input value={String(form.provider ?? '')} onChange={(e) => set('provider', e.target.value)} /></Field>
            <Field label="Monthly cost"><input type="number" value={String(form.cost ?? '')} onChange={(e) => set('cost', e.target.value)} /></Field>
            <Field label="Employee contribution"><input type="number" value={String(form.employeeContribution ?? '')} onChange={(e) => set('employeeContribution', e.target.value)} /></Field>
            <Field label="Employer contribution"><input type="number" value={String(form.employerContribution ?? '')} onChange={(e) => set('employerContribution', e.target.value)} /></Field>
          </div>
          <p className="muted" style={{ marginTop: 10 }}>Categories come from Organisation Settings - HR, so they can change without a deploy.</p>
        </Modal>
      )}

      {open === 'enroll' && (
        <Modal title="Enrol employee" onClose={() => setOpen('')}
          footer={<><button className="btn" onClick={() => setOpen('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !form.employeeId || !form.planId}
              onClick={() => post('/api/ops/hcm/benefits/enrollments', {
                employeeId: Number(form.employeeId),
                planId: Number(form.planId),
                effectiveFrom: form.effectiveFrom ? String(form.effectiveFrom) : today(),
                effectiveTo: form.effectiveTo ? String(form.effectiveTo) : null,
                monthlyCost: form.monthlyCost !== undefined && form.monthlyCost !== '' ? Number(form.monthlyCost) : null,
              })}>Enrol</button></>}>
          <div className="form-grid">
            <Field label="Employee"><EmpSelect value={String(form.employeeId ?? '')} onChange={(v) => set('employeeId', v)} /></Field>
            <Field label="Plan">
              <select value={String(form.planId ?? '')} onChange={(e) => {
                const p = activePlans.find((x) => String(x.id) === e.target.value);
                setForm((f) => ({ ...f, planId: e.target.value, monthlyCost: p && Number(p.cost) > 0 ? String(p.cost) : f.monthlyCost }));
              }}>
                <option value="">Select plan...</option>
                {activePlans.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.name)} - {fmtMoney(p.cost)}</option>)}
              </select>
            </Field>
            <Field label="Effective from"><input type="date" value={String(form.effectiveFrom ?? '')} onChange={(e) => set('effectiveFrom', e.target.value)} /></Field>
            <Field label="Effective to"><input type="date" value={String(form.effectiveTo ?? '')} onChange={(e) => set('effectiveTo', e.target.value)} /></Field>
            <Field label="Monthly cost"><input type="number" placeholder={selectedPlan ? String(selectedPlan.cost ?? '') : ''} value={String(form.monthlyCost ?? '')} onChange={(e) => set('monthlyCost', e.target.value)} /></Field>
          </div>
        </Modal>
      )}

      {open === 'resign' && detail && (
        <Modal title="Resign from benefit" onClose={() => setOpen('')}
          footer={<><button className="btn" onClick={() => setOpen('')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}
              onClick={() => post(`/api/ops/hcm/benefits/enrollments/${String(detail.id)}/resign`, {
                effectiveTo: form.effectiveTo ? String(form.effectiveTo) : null,
              })}>Resign</button></>}>
          <dl className="def-list" style={{ marginBottom: 12 }}>
            <div><dt>Employee</dt><dd>{nameOf(detail)}</dd></div>
            <div><dt>Plan</dt><dd>{String(detail.planName ?? '')}</dd></div>
          </dl>
          <div className="form-grid">
            <Field label="Effective to"><input type="date" value={String(form.effectiveTo ?? '')} onChange={(e) => set('effectiveTo', e.target.value)} /></Field>
          </div>
        </Modal>
      )}
    </Page>
  );
}

function RelationsDesk() {
  const { user } = useAuth();
  const grievances = useList('/api/ops/hcm/relations/grievances');
  const cases = useList('/api/ops/hcm/relations/disciplinary-cases');
  const warnings = useList('/api/ops/hcm/relations/warnings');
  const [tab, setTab] = useState('grievances');
  const [open, setOpen] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [subject, setSubject] = useState('');
  const [reason, setReason] = useState('');
  const [resolve, setResolve] = useState<Rec | null>(null);
  const post = async (path: string, body: Rec, reload: () => void) => {
    try { await api(path, { method: 'POST', body: JSON.stringify(body) }); setOpen(''); reload(); grievances.load(); cases.load(); warnings.load(); }
    catch (e) { grievances.setError(e instanceof Error ? e.message : 'Action failed'); }
  };
  return (
    <Page kicker="Employee relations" title="Grievances, cases and warnings" back="/people"
      actions={<>
        {can(user, 'hr.grievances.create') && <button className="btn" onClick={() => setOpen('grievance')}>Register grievance</button>}
        {can(user, 'hr.disciplinary.create') && <button className="btn" onClick={() => setOpen('case')}>Open case</button>}
        {can(user, 'hr.warnings.issue') && <button className="btn btn-primary" onClick={() => setOpen('warning')}>Issue warning</button>}
      </>}>
      {grievances.error && <ErrorBanner error={grievances.error} />}
      <div className="tabs" style={{ marginBottom: 12 }}>
        {[['grievances', 'Grievances'], ['cases', 'Disciplinary'], ['warnings', 'Warnings']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'grievances' && <section className="card"><div className="table-wrap"><table className="data">
        <thead><tr><th>Employee</th><th>Subject</th><th>Priority</th><th>Status</th><th></th></tr></thead>
        <tbody>{grievances.rows.map((r) => (
          <tr key={String(r.id)}>
            <td>{nameOf(r)}</td><td>{String(r.subject)}</td><td><Badge value={r.priority} /></td><td><Badge value={r.status} /></td>
            <td>{String(r.status) === 'OPEN' && can(user, 'hr.grievances.resolve') && (
              <button className="btn btn-sm" onClick={() => setResolve(r)}>Resolve</button>
            )}</td>
          </tr>
        ))}</tbody>
      </table></div></section>}
      {tab === 'cases' && <section className="card"><div className="table-wrap"><table className="data">
        <thead><tr><th>Case</th><th>Employee</th><th>Category</th><th>Status</th></tr></thead>
        <tbody>{cases.rows.map((r) => (
          <tr key={String(r.id)}><td className="cell-mono">{String(r.caseNo)}</td><td>{nameOf(r)}</td><td><Badge value={r.category} /></td><td><Badge value={r.status} /></td></tr>
        ))}</tbody>
      </table></div></section>}
      {tab === 'warnings' && <section className="card"><div className="table-wrap"><table className="data">
        <thead><tr><th>Employee</th><th>Type</th><th>Reason</th><th>Status</th></tr></thead>
        <tbody>{warnings.rows.map((r) => (
          <tr key={String(r.id)}><td>{nameOf(r)}</td><td><Badge value={r.warningType} /></td><td>{String(r.reason)}</td><td><Badge value={r.status} /></td></tr>
        ))}</tbody>
      </table></div></section>}
      {open && (
        <Modal title="Employee relations" onClose={() => setOpen('')}
          footer={<><button className="btn" onClick={() => setOpen('')}>Cancel</button>
            <button className="btn btn-primary" disabled={!employeeId} onClick={() => {
              if (open === 'grievance') post('/api/ops/hcm/relations/grievances', { employeeId: Number(employeeId), category: 'WORKPLACE', subject }, grievances.load);
              else if (open === 'case') post('/api/ops/hcm/relations/disciplinary-cases', { employeeId: Number(employeeId), category: 'MISCONDUCT', description: subject || reason, incidentDate: today() }, cases.load);
              else post('/api/ops/hcm/relations/warnings', { employeeId: Number(employeeId), warningType: 'WRITTEN', reason }, warnings.load);
            }}>Save</button></>}>
          <div className="form-grid">
            <Field label="Employee"><EmpSelect value={employeeId} onChange={setEmployeeId} /></Field>
            {(open === 'grievance' || open === 'case') && <Field label={open === 'case' ? 'Description' : 'Subject'}><input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>}
            {open === 'warning' && <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
          </div>
        </Modal>
      )}
      {resolve && (
        <ConfirmDialog
          title="Resolve grievance"
          confirmLabel="Resolve grievance"
          reasonLabel="Resolution"
          reasonRequired
          body={`Record the resolution for ${nameOf(resolve)} — "${String(resolve.subject)}". The grievance moves to resolved.`}
          onCancel={() => setResolve(null)}
          onConfirm={(resolution) => {
            const g = resolve;
            setResolve(null);
            post(`/api/ops/hcm/relations/grievances/${String(g.id)}/resolve`, { resolution }, grievances.load);
          }}
        />
      )}
    </Page>
  );
}

function TimeDesk() {
  const { user } = useAuth();
  const shifts = useList('/api/ops/hcm/shifts');
  const assignments = useList('/api/ops/hcm/shifts/assignments');
  const timesheets = useList('/api/ops/hcm/timesheets');
  const [tab, setTab] = useState('shifts');
  const [open, setOpen] = useState('');
  const [code, setCode] = useState('DAY');
  const [name, setName] = useState('Day shift');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('17:00');
  const [employeeId, setEmployeeId] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [periodStart, setPeriodStart] = useState(today().slice(0, 8) + '01');
  const [periodEnd, setPeriodEnd] = useState(today());
  const [hours, setHours] = useState('160');
  const post = async (path: string, body: Rec) => {
    try { await api(path, { method: 'POST', body: JSON.stringify(body) }); setOpen(''); shifts.load(); assignments.load(); timesheets.load(); }
    catch (e) { shifts.setError(e instanceof Error ? e.message : 'Action failed'); }
  };
  return (
    <Page kicker="Time" title="Shifts and timesheets" sub="Today's clock stays on Attendance. This desk covers roster and timesheet approval." back="/people"
      actions={<>
        <button className="btn" onClick={() => navigate('/people/attendance')}>Today's clock</button>
        {can(user, 'hr.shifts.create') && <button className="btn" onClick={() => setOpen('shift')}>New shift</button>}
        {can(user, 'hr.timesheets.create') && <button className="btn btn-primary" onClick={() => setOpen('sheet')}>New timesheet</button>}
      </>}>
      {shifts.error && <ErrorBanner error={shifts.error} />}
      <div className="tabs" style={{ marginBottom: 12 }}>
        {[['shifts', 'Shifts'], ['assignments', 'Assignments'], ['sheets', 'Timesheets']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'shifts' && <section className="card"><div className="table-wrap"><table className="data">
        <thead><tr><th>Code</th><th>Name</th><th>Hours</th><th>Status</th></tr></thead>
        <tbody>{shifts.rows.map((r) => (
          <tr key={String(r.id)}><td className="cell-mono">{String(r.code)}</td><td>{String(r.name)}</td><td>{String(r.startTime)} – {String(r.endTime)}</td><td><Badge value={r.status} /></td></tr>
        ))}</tbody>
      </table></div>
      {can(user, 'hr.shift_assignments.create') && <div className="card-pad"><button className="btn btn-sm" onClick={() => setOpen('assign')}>Assign shift</button></div>}
      </section>}
      {tab === 'assignments' && <section className="card"><div className="table-wrap"><table className="data">
        <thead><tr><th>Employee</th><th>Shift</th><th>From</th><th>Status</th></tr></thead>
        <tbody>{assignments.rows.map((r) => (
          <tr key={String(r.id)}><td>{nameOf(r)}</td><td>{String(r.shiftName ?? r.shiftCode)}</td><td>{fmtDate(r.effectiveFrom)}</td><td><Badge value={r.status} /></td></tr>
        ))}</tbody>
      </table></div></section>}
      {tab === 'sheets' && <section className="card"><div className="table-wrap"><table className="data">
        <thead><tr><th>Employee</th><th>Period</th><th className="cell-num">Hours</th><th>Status</th><th></th></tr></thead>
        <tbody>{timesheets.rows.map((r) => (
          <tr key={String(r.id)}>
            <td>{nameOf(r)}</td><td>{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}</td><td className="cell-num">{fmtNum(r.totalHours)}</td><td><Badge value={r.status} /></td>
            <td>
              {String(r.status) === 'DRAFT' && can(user, 'hr.timesheets.submit') && <button className="btn btn-sm" onClick={() => post(`/api/ops/hcm/timesheets/${r.id}/submit`, {})}>Submit</button>}
              {String(r.status) === 'SUBMITTED' && can(user, 'hr.timesheets.approve') && <button className="btn btn-sm" onClick={() => post(`/api/ops/hcm/timesheets/${r.id}/approve`, {})}>Approve</button>}
            </td>
          </tr>
        ))}</tbody>
      </table></div></section>}
      {open && (
        <Modal title="Time" onClose={() => setOpen('')}
          footer={<><button className="btn" onClick={() => setOpen('')}>Cancel</button>
            <button className="btn btn-primary" onClick={() => {
              if (open === 'shift') post('/api/ops/hcm/shifts', { code, name, startTime, endTime });
              else if (open === 'assign') post('/api/ops/hcm/shifts/assignments', { employeeId: Number(employeeId), shiftId: Number(shiftId), effectiveFrom: today() });
              else post('/api/ops/hcm/timesheets', { employeeId: Number(employeeId), periodStart, periodEnd, totalHours: Number(hours) });
            }}>Save</button></>}>
          <div className="form-grid">
            {open === 'shift' && <>
              <Field label="Code"><input value={code} onChange={(e) => setCode(e.target.value)} /></Field>
              <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Start"><input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></Field>
              <Field label="End"><input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></Field>
            </>}
            {(open === 'assign' || open === 'sheet') && <Field label="Employee"><EmpSelect value={employeeId} onChange={setEmployeeId} /></Field>}
            {open === 'assign' && <Field label="Shift"><select value={shiftId} onChange={(e) => setShiftId(e.target.value)}><option value="">Select…</option>{shifts.rows.map((s) => <option key={String(s.id)} value={String(s.id)}>{String(s.code)} · {String(s.name)}</option>)}</select></Field>}
            {open === 'sheet' && <>
              <Field label="Period start"><input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></Field>
              <Field label="Period end"><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field>
              <Field label="Hours"><input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
            </>}
          </div>
        </Modal>
      )}
    </Page>
  );
}
