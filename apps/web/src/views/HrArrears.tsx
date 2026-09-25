import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner } from '../components/ui';
import { type Rec } from './hrShared';

/**
 * Salary arrears: the register of retrospective pay corrections and the composer
 * that raises one. Lifted out of HrFlow so the flow file stops owning this
 * register and its correction form.
 */

export function ArrearsList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/hr/arrears')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Arrears failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const decide = async (id: number, status: 'approve' | 'reject') => {
    setBusyId(id); setError(''); setNotice('');
    try {
      await api(`/api/ops/hr/arrears/${id}/${status}`, { method: 'POST', body: '{}' });
      setNotice(status === 'approve' ? 'Arrears approved and ready for an ARREARS off-cycle run.' : 'Arrears rejected.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Payroll</p>
          <h1>Payroll arrears</h1>
          <p className="muted">Approved pay corrections. PAYE impact uses the statutory rules in force at the corrected period end.</p>
        </div>
        <div className="head-actions">
          {can(user, 'hr.payrolls.create') && <button className="btn" onClick={() => navigate('/people/arrears/new')}>New arrears</button>}
          {can(user, 'hr.payrolls.create') && <button className="btn btn-primary" onClick={() => navigate('/people/off-cycle/new', { query: { type: 'ARREARS' } })}>Run arrears payroll</button>}
        </div>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Employee</th><th>Period</th><th className="cell-num">Original</th><th className="cell-num">Correct</th><th className="cell-num">Diff</th><th className="cell-num">PAYE impact</th><th className="cell-num">Net arrears</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.firstName)} {String(r.lastName)} <span className="cell-mono">{String(r.employeeNo ?? '')}</span><div className="muted">{String(r.position ?? '')}</div></td>
                <td>{String(r.fromPeriodStart ?? '').slice(0, 10)} to {String(r.toPeriodEnd ?? '').slice(0, 10)}</td>
                <td className="cell-num">{fmtMoney(r.originalPay)}</td>
                <td className="cell-num">{fmtMoney(r.correctPay)}</td>
                <td className="cell-num">+{fmtMoney(r.difference)}</td>
                <td className="cell-num">{fmtMoney(r.taxImpact)}</td>
                <td className="cell-num"><strong>{fmtMoney(r.netArrears)}</strong></td>
                <td><Badge value={r.status} /></td>
                <td>
                  {String(r.status) === 'PENDING' && can(user, 'hr.payrolls.approve') && (
                    <span className="row-actions">
                      <button className="btn btn-sm btn-success" disabled={busyId === Number(r.id)} onClick={() => decide(Number(r.id), 'approve')}>Approve</button>
                      <button className="btn btn-sm" disabled={busyId === Number(r.id)} onClick={() => decide(Number(r.id), 'reject')}>Reject</button>
                    </span>
                  )}
                  {r.payrollId != null && <span className="muted">Paid in run {String(r.payrollId)}</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>No arrears records yet. Record a correction, approve it, then run an ARREARS off-cycle payroll to pay the net arrears.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ArrearsComposer() {
  const today = new Date();
  const prevStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevEnd = new Date(today.getFullYear(), today.getMonth(), 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const [employeeId, setEmployeeId] = useState('');
  const [originalPay, setOriginalPay] = useState('');
  const [correctPay, setCorrectPay] = useState('');
  const [fromPeriodStart, setFromPeriodStart] = useState(iso(prevStart));
  const [toPeriodEnd, setToPeriodEnd] = useState(iso(prevEnd));
  const [reason, setReason] = useState('');
  const [employees, setEmployees] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ data: { rows: Rec[] } }>('/api/ops/hr/employees?pageSize=100')
      .then((r) => setEmployees(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Employees failed'));
  }, []);
  const orig = Number(originalPay) || 0;
  const corr = Number(correctPay) || 0;
  const difference = Math.max(0, corr - orig);
  const valid = Boolean(employeeId) && corr > 0 && corr !== orig && Boolean(fromPeriodStart) && Boolean(toPeriodEnd) && toPeriodEnd >= fromPeriodStart;
  const save = async () => {
    setBusy(true); setError('');
    try {
      await api('/api/ops/hr/arrears', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: Number(employeeId),
          originalPay: orig,
          correctPay: corr,
          fromPeriodStart,
          toPeriodEnd,
          reason: reason.trim() || undefined,
        }),
      });
      navigate('/people/arrears');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const selectable = employees.filter((e) => {
    const s = String(e.status ?? '');
    return s === 'ACTIVE' || s === 'ON_LEAVE' || s === 'PROBATION' || s === 'TERMINATED';
  });
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/arrears')}>Back</button>
          <h1>New payroll arrears</h1>
          <p className="muted">Record original and corrected pay for a past period. Nothing posts until an ARREARS off-cycle run is approved.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="field field-required"><label>Employee</label>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Select employee</option>
            {selectable.map((e) => (
              <option key={String(e.id)} value={String(e.id)}>{String(e.firstName)} {String(e.lastName)} - {String(e.employeeNo ?? '')} ({String(e.position ?? '')})</option>
            ))}
          </select>
        </div>
        <div className="form-grid">
          <div className="field field-required"><label>Original pay (UGX)</label><input type="number" min="0" value={originalPay} onChange={(e) => setOriginalPay(e.target.value)} placeholder="e.g. 3000000" /></div>
          <div className="field field-required"><label>Correct pay (UGX)</label><input type="number" min="0" value={correctPay} onChange={(e) => setCorrectPay(e.target.value)} placeholder="e.g. 3500000" /></div>
          <div className="field field-required"><label>From period</label><input type="date" value={fromPeriodStart} onChange={(e) => setFromPeriodStart(e.target.value)} /></div>
          <div className="field field-required"><label>To period</label><input type="date" value={toPeriodEnd} onChange={(e) => setToPeriodEnd(e.target.value)} /></div>
        </div>
        <div className="field"><label>Reason</label><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Salary increment effective 01 Aug 2026 was entered late" /></div>
        <div className="alert" style={{ marginTop: 4 }}>
          <strong>Gross difference: +{fmtMoney(difference)}</strong>. PAYE impact and net arrears are calculated on save against the versioned statutory rules effective at the corrected period end.
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy || !valid} onClick={save}>Create arrears record</button>
      </section>
    </div>
  );
}