import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney, fmtNum, openDocument } from '../api';
import { useAuth, can } from '../auth';
import { navigate, useHashQuery } from '../router';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { type Rec } from './hrShared';

/**
 * Off-cycle payroll runs: one-off bonus, commission, arrears, correction and
 * emergency payments that sit outside the monthly cycle. Lifted from HrFlow so
 * the flow file no longer owns the off-cycle register, composer or desk.
 */

export function OffCycleList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hr/off-cycle')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Off-cycle runs failed'));
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Payroll</p>
          <h1>Off-cycle runs</h1>
          <p className="muted">Bonus, commission, arrears, corrections and emergency payments for selected employees.</p>
        </div>
        {can(user, 'hr.payrolls.create') && <button className="btn btn-primary" onClick={() => navigate('/people/off-cycle/new')}>New off-cycle run</button>}
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Run</th><th>Type</th><th>Reason</th><th>Period</th><th className="cell-num">Employees</th><th>Status</th><th className="cell-num">Net</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/off-cycle/${r.id}`)}>
                <td className="cell-mono">{String(r.payrollNo)}</td>
                <td><Badge value={r.offCycleType} /></td>
                <td>{String(r.reason ?? '')}</td>
                <td>{String(r.periodStart ?? '').slice(0, 10)} to {String(r.periodEnd ?? '').slice(0, 10)}</td>
                <td className="cell-num">{fmtNum(r.employeeCount)}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{fmtMoney(r.netTotal)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No off-cycle runs.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function OffCycleComposer() {
  const q = useHashQuery();
  const today = new Date();
  const startDefault = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const [periodStart, setPeriodStart] = useState(startDefault);
  const [periodEnd, setPeriodEnd] = useState(startDefault);
  const [offCycleType, setOffCycleType] = useState(q.get('type') || 'BONUS');
  const [reason, setReason] = useState('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [extraEarnings, setExtraEarnings] = useState('');
  const [extraDeductions, setExtraDeductions] = useState('');
  const [deductLoans, setDeductLoans] = useState(!['BONUS', 'COMMISSION', 'NEW_HIRE', 'EMERGENCY'].includes(q.get('type') || 'BONUS'));
  const [paymentDate, setPaymentDate] = useState('');
  const [employees, setEmployees] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ data: { rows: Rec[] } }>('/api/ops/hr/employees?pageSize=100')
      .then((r) => setEmployees(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Employees failed'));
  }, []);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ data: { payrollId: number } }>('/api/ops/hr/off-cycle', {
        method: 'POST',
        body: JSON.stringify({
          periodStart, periodEnd, offCycleType, reason, employeeIds: selectedIds,
          extraEarnings: extraEarnings ? Number(extraEarnings) : undefined,
          extraDeductions: extraDeductions ? Number(extraDeductions) : undefined,
          deductLoans,
          paymentDate: paymentDate || undefined,
        }),
      });
      navigate(`/people/off-cycle/${r.data.payrollId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const toggle = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const selectable = employees.filter((e) => {
    const s = String(e.status ?? '');
    return s === 'ACTIVE' || s === 'ON_LEAVE' || s === 'PROBATION' || s === 'TERMINATED';
  });
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/off-cycle')}>Back</button>
          <h1>New off-cycle run</h1>
          <p className="muted">Pay a selected group outside the normal cycle. Requires a reason and is fully audited.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required"><label>Period start</label><input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></div>
          <div className="field field-required"><label>Period end</label><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></div>
          <div className="field field-required"><label>Type</label>
            <select value={offCycleType} onChange={(e) => { const v = e.target.value; setOffCycleType(v); setDeductLoans(!['BONUS', 'COMMISSION', 'NEW_HIRE', 'EMERGENCY'].includes(v)); }}>
              <option value="NEW_HIRE">New hire</option>
              <option value="TERMINATION">Termination</option>
              <option value="FINAL">Final settlement</option>
              <option value="BONUS">Bonus</option>
              <option value="COMMISSION">Commission</option>
              <option value="CORRECTION">Correction</option>
              <option value="ARREARS">Arrears</option>
              <option value="EMERGENCY">Emergency</option>
            </select>
          </div>
          <div className="field field-required"><label>Payment date</label><input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} /></div>
        </div>
        <div className="field field-required"><label>Reason</label><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Q3 sales bonus for the Kampala sales team" /></div>
        <div className="form-grid">
          <div className="field"><label>Extra earnings per employee (UGX)</label><input type="number" min="0" value={extraEarnings} onChange={(e) => setExtraEarnings(e.target.value)} /></div>
          <div className="field"><label>Extra deductions per employee (UGX)</label><input type="number" min="0" value={extraDeductions} onChange={(e) => setExtraDeductions(e.target.value)} /></div>
          <div className="field"><label><input type="checkbox" checked={deductLoans} onChange={(e) => setDeductLoans(e.target.checked)} /> Deduct loan installments</label></div>
        </div>
        <div className="field field-required"><label>Employees ({selectedIds.length} selected)</label>
          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border, #d5d9e0)', borderRadius: 8, padding: 8 }}>
            {selectable.map((e) => (
              <label key={String(e.id)} style={{ display: 'block', padding: '4px 0' }}>
                <input type="checkbox" checked={selectedIds.includes(Number(e.id))} onChange={() => toggle(Number(e.id))} />{' '}
                {String(e.firstName)} {String(e.lastName)} <span className="cell-mono">{String(e.employeeNo ?? '')}</span>{' '}
                <span className="muted">{String(e.position ?? '')}</span>
              </label>
            ))}
            {selectable.length === 0 && <span className="muted">No employees available.</span>}
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={save}>Create and calculate run</button>
      </section>
    </div>
  );
}

export function OffCycleDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ payroll: Rec; items: Rec[]; exceptions: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [docBusy, setDocBusy] = useState('');
  const load = useCallback(() => {
    api<{ data: { payroll: Rec; items: Rec[]; exceptions: Rec[] } }>(`/api/ops/hr/off-cycle/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Off-cycle run failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader variant="page" label="Opening run" />;
  const p = doc.payroll;
  const exceptions = (doc.exceptions as Rec[]) ?? [];
  const openErrors = exceptions.filter((x) => x.severity === 'ERROR' && x.status === 'OPEN').length;
  const act = async (path: string, ok: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(path, { method: 'POST', body: '{}' });
      setNotice(r.data.journalId ? `Posted journal #${r.data.journalId}` : ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const runValidate = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: { validationScore: number; errors: number; warnings: number; ready: boolean } }>(`/api/ops/hr/off-cycle/${id}/validate`, { method: 'POST', body: '{}' });
      setNotice(`Validation ${r.data.ready ? 'passed' : 'blocked'}: ${r.data.validationScore}/100 (${r.data.errors} errors, ${r.data.warnings} warnings)`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const openPayslipDoc = async (slip: Rec, format: 'pdf' | 'print') => {
    setDocBusy(String(slip.id) + format); setError('');
    try {
      await openDocument('payslip', slip.id, format, String(slip.payslipNo ?? 'payslip') + '.pdf');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setDocBusy(''); }
  };
  const canPrintSlips = can(user, 'hr.payslips.view');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/off-cycle')}>Back</button>
          <h1>Off-cycle run <span className="cell-mono">{String(p.payrollNo)}</span></h1>
          <p className="muted">{String(p.periodStart ?? '').slice(0, 10)} to {String(p.periodEnd ?? '').slice(0, 10)} - {String(p.reason ?? '')}</p>
        </div>
        <Badge value={p.status} />
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Type</span><span className="kpi-value">{String(p.offCycleType ?? '')}</span></div>
        <div className="kpi-card"><span className="kpi-label">Gross</span><span className="kpi-value">{fmtMoney(p.grossTotal)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Deductions</span><span className="kpi-value">{fmtMoney(p.deductionTotal)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Net</span><span className="kpi-value">{fmtMoney(p.netTotal)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Readiness</span><span className="kpi-value">{p.validationScore == null ? '-' : `${String(p.validationScore)}%`}</span></div>
      </div>
      <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {['DRAFT', 'SUBMITTED'].includes(String(p.status)) && can(user, 'hr.payrolls.update') && (
          <button className="btn" disabled={busy} onClick={() => act(`/api/ops/hr/off-cycle/${id}/calculate`, 'Recalculated')}>Recalculate</button>
        )}
        {['DRAFT', 'SUBMITTED'].includes(String(p.status)) && can(user, 'hr.payrolls.update') && (
          <button className="btn" disabled={busy} onClick={runValidate}>Validate</button>
        )}
        {String(p.status) === 'DRAFT' && can(user, 'hr.payrolls.submit') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(`/api/ops/hr/off-cycle/${id}/submit`, 'Submitted for approval')}>Submit</button>
        )}
        {['APPROVED', 'RELEASED', 'PAID'].includes(String(p.status)) && !p.glPosted && can(user, 'hr.payrolls.post') && (
          <button className="btn btn-success" disabled={busy} onClick={() => act(`/api/ops/hr/off-cycle/${id}/post`, 'Posted to the ledger')}>Post to ledger</button>
        )}
      </div>
      <section className="card">
        <div className="card-head"><h3>Employees</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Employee</th><th className="cell-num">Basic</th><th className="cell-num">Allowances</th><th className="cell-num">Gross</th><th className="cell-num">PAYE</th><th className="cell-num">NSSF</th><th className="cell-num">Loans</th><th className="cell-num">Other</th><th className="cell-num">Net</th>{canPrintSlips ? <th></th> : null}</tr></thead>
            <tbody>
              {doc.items.map((i) => (
                <tr key={String(i.id)}>
                  <td>{String(i.firstName)} {String(i.lastName)} <span className="cell-mono">{String(i.employeeNo ?? '')}</span></td>
                  <td className="cell-num">{fmtMoney(i.basicPay)}</td>
                  <td className="cell-num">{fmtMoney(i.allowances)}</td>
                  <td className="cell-num">{fmtMoney(i.grossPay)}</td>
                  <td className="cell-num">{fmtMoney(i.paye)}</td>
                  <td className="cell-num">{fmtMoney(i.nssf)}</td>
                  <td className="cell-num">{fmtMoney(i.loans)}</td>
                  <td className="cell-num">{fmtMoney(i.otherDeductions)}</td>
                  <td className="cell-num">{fmtMoney(i.netPay)}</td>
                  {canPrintSlips && (
                    <td>
                      <div className="action-group">
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openPayslipDoc(i, 'print')}>{docBusy === String(i.id) + 'print' ? 'Printing…' : 'Print'}</button>
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openPayslipDoc(i, 'pdf')}>{docBusy === String(i.id) + 'pdf' ? 'Saving…' : 'PDF'}</button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {doc.items.length === 0 && <tr><td colSpan={canPrintSlips ? 10 : 9} className="muted" style={{ padding: 16 }}>No employee lines.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Exceptions</h3>
          <span className="muted">{openErrors > 0 ? `${openErrors} open error${openErrors === 1 ? '' : 's'}` : 'No open errors'}</span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Employee</th><th>Type</th><th>Severity</th><th>Message</th></tr></thead>
            <tbody>
              {exceptions.map((x) => (
                <tr key={String(x.id)}>
                  <td>{x.firstName ? `${String(x.firstName)} ${String(x.lastName)}` : 'Run-level'} <span className="cell-mono">{String(x.employeeNo ?? '')}</span></td>
                  <td className="cell-mono">{String(x.exceptionType)}</td>
                  <td><span className={`badge ${x.severity === 'ERROR' ? 'badge-red' : x.severity === 'HIGH_RISK' ? 'badge-critical' : 'badge-amber'}`}>{String(x.severity).replace(/_/g, ' ')}</span></td>
                  <td>{String(x.message)}</td>
                </tr>
              ))}
              {exceptions.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No exceptions yet. Recalculate or validate this run to refresh.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
