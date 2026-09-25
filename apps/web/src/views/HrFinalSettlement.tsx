import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { ConfirmDialog } from '../components/os';
import { type Rec } from './hrShared';

/**
 * Final settlements: the register and the desk for salary due, leave payout and
 * offsets when an employee is terminated. Lifted out of HrFlow so the flow file
 * stops owning this register and its single-record approval desk.
 */

export function FinalSettlementList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: { rows: Rec[] } }>('/api/ops/hr/final-settlements')
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Final settlements failed'));
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Final settlement</p>
          <h1>Settlements</h1>
          <p className="muted">Salary due, leave payout and offsets for terminated employees.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>No</th><th>Employee</th><th>Termination</th><th>Status</th><th className="cell-num">Net payable</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/final-settlements/${r.id}`)}>
                <td className="cell-mono">{String(r.settlementNo)}</td>
                <td>{String(r.firstName)} {String(r.lastName)} <span className="cell-mono">{String(r.employeeNo)}</span></td>
                <td>{String(r.terminationDate ?? '').slice(0, 10)}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{fmtMoney(r.netPayable)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No final settlements.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function FinalSettlementDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [payMethod, setPayMethod] = useState('BANK_TRANSFER');
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; danger?: boolean; run: () => void } | null>(null);
  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/hr/final-settlements/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Final settlement failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader variant="page" label="Opening settlement" />;
  const s = doc;
  const components = (s.components as Rec[]) ?? [];
  const act = async (path: string, ok: string, body: Rec = {}) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(r.data.batchNo ? `Paid via batch #${String(r.data.batchNo)}` : ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/final-settlements')}>Back</button>
          <h1>Settlement <span className="cell-mono">{String(s.settlementNo)}</span></h1>
          <p className="muted">{String(s.firstName)} {String(s.lastName)} <span className="cell-mono">{String(s.employeeNo)}</span> - {String(s.position ?? 'No position')}</p>
        </div>
        <Badge value={s.status} />
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Salary due</span><span className="kpi-value">{fmtMoney(s.salaryDue)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Leave pay</span><span className="kpi-value">{fmtMoney(s.leavePayment)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Offsets</span><span className="kpi-value">{fmtMoney(Number(s.outstandingLoans) + Number(s.outstandingAdvances) + Number(s.otherDeductions))}</span></div>
        <div className="kpi-card"><span className="kpi-label">Net payable</span><span className="kpi-value">{fmtMoney(s.netPayable)}</span></div>
      </div>
      <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {String(s.status) === 'DRAFT' && can(user, 'hr.final_settlements.submit') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(`/api/ops/hr/final-settlements/${id}/submit`, 'Submitted for approval')}>Submit</button>
        )}
        {String(s.status) === 'PENDING' && can(user, 'hr.final_settlements.approve') && (
          <button className="btn btn-success" disabled={busy} onClick={() => {
            setConfirm({
              title: 'Approve final settlement',
              body: `Approve ${String(s.settlementNo)}? Net payable ${fmtMoney(s.netPayable)} becomes authorised for payment. Approval is recorded against your name.`,
              label: 'Approve settlement',
              run: () => act(`/api/ops/hr/final-settlements/${id}/approve`, 'Approved'),
            });
          }}>Approve</button>
        )}
        {String(s.status) === 'PENDING' && can(user, 'hr.final_settlements.reject') && (
          <button className="btn" disabled={busy} onClick={() => setConfirm({
            title: 'Return final settlement',
            body: `Return ${String(s.settlementNo)} to draft? The approver's decision is cleared and the preparer must resubmit.`,
            label: 'Return to draft',
            danger: true,
            run: () => act(`/api/ops/hr/final-settlements/${id}/reject`, 'Returned to draft'),
          })}>Reject</button>
        )}
        {String(s.status) === 'APPROVED' && can(user, 'hr.final_settlements.pay') && (
          <>
            <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="MOBILE_MONEY">Mobile money</option>
              <option value="CASH">Cash</option>
              <option value="OTHER">Other</option>
            </select>
            <button className="btn btn-primary" disabled={busy} onClick={() => {
              setConfirm({
                title: 'Pay final settlement',
                body: `Pay ${fmtMoney(s.netPayable)} for ${String(s.settlementNo)} by ${payMethod.replace(/_/g, ' ').toLowerCase()}? This posts the disbursement and cannot be reversed from here.`,
                label: 'Pay settlement',
                danger: true,
                run: () => act(`/api/ops/hr/final-settlements/${id}/pay`, 'Paid', { paymentMethod: payMethod }),
              });
            }}>Pay settlement</button>
          </>
        )}
      </div>
      <section className="card">
        <div className="card-head"><h3>Components</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Type</th><th>Code</th><th>Description</th><th className="cell-num">Amount</th></tr></thead>
            <tbody>
              {components.map((c, i) => (
                <tr key={i}>
                  <td>{String(c.kind)}</td>
                  <td className="cell-mono">{String(c.code)}</td>
                  <td>{String(c.description)}</td>
                  <td className="cell-num">{String(c.kind) === 'DEDUCTION' ? '-' : ''}{fmtMoney(c.amount)}</td>
                </tr>
              ))}
              {components.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No components.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          reasonLabel={null}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); if (c) c.run(); }}
        />
      )}
    </div>
  );
}