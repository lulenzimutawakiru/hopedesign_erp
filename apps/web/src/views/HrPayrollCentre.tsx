import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney, fmtNum } from '../api';
import { navigate, useHashQuery } from '../router';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { HrEmptyState as EmptyState, HrKpi, HrKpiGrid, HrPageHeader, HrTableEmpty, HrToolbar } from '../components/hrUi';
import { type Rec } from './hrShared';

/**
 * Payroll command centre, run register and run composer. Lifted out of HrFlow so
 * the flow file keeps only routing plus the board and exception views; the two
 * tone helpers stay private to the command centre that reads them.
 */

type PayrollCentrePayload = {
  companyId?: number;
  asOf?: string;
  current: Rec | null;
  totals: Rec;
  exceptions: Rec;
  pendingApprovals: number;
  payment: Rec | null;
  statutory: { expected: Rec; filings: Rec[] };
  workflow: Rec[];
  periods: Rec[];
  recentRuns: Rec[];
};

function wfTone(state: unknown): { fg: string; bg: string; bd: string } {
  const s = String(state ?? 'PENDING');
  if (s === 'DONE') return { fg: '#0F4A32', bg: '#E3F3EB', bd: '#B8DCCB' };
  if (s === 'CURRENT') return { fg: '#1261A0', bg: '#E4F0FA', bd: '#B8D5EA' };
  return { fg: 'var(--muted)', bg: 'var(--paper-2)', bd: 'var(--line)' };
}

function periodStatusTone(status: unknown): string {
  const s = String(status ?? '');
  if (s === 'OPEN') return 'badge-green';
  if (s === 'LOCKED') return 'badge-amber';
  if (s === 'CLOSED') return 'badge-neutral';
  if (s === 'CANCELLED') return 'badge-red';
  return 'badge-neutral';
}

export function PayrollCommandCentre() {
  const [centre, setCentre] = useState<PayrollCentrePayload | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ data: PayrollCentrePayload }>('/api/ops/hr/payrolls/command-centre')
      .then((r) => setCentre(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Payroll command centre failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error && !centre) return <ErrorBanner error={error} />;
  if (!centre) return <PageLoader variant="page" label="Opening payroll command centre..." />;
  const current = centre.current;
  const totals = centre.totals ?? {};
  const exceptions = centre.exceptions ?? {};
  const statutory = centre.statutory ?? { expected: {}, filings: [] };
  const expected = statutory.expected ?? {};
  const filings = statutory.filings ?? [];
  const workflow = centre.workflow ?? [];
  const periods = centre.periods ?? [];
  const recentRuns = centre.recentRuns ?? [];
  const currentStep = workflow.find((s) => s.state === 'CURRENT');
  const payment = centre.payment;
  const openExceptions = Number(exceptions.open ?? 0);
  const blocking = Number(exceptions.blocking ?? 0);
  const highRisk = Number(exceptions.highRisk ?? 0);
  const warnings = Number(exceptions.warnings ?? 0);
  const nssfTotal = Number(totals.employeeNssf ?? 0) + Number(totals.employerNssf ?? 0);
  const pendingApprovals = Number(centre.pendingApprovals ?? 0);  return (
    <div className="page">
      <HrPageHeader
        kicker="Payroll"
        title="Command centre"
        subtitle={current
          ? `Run ${String(current.payrollNo ?? '')} - ${String(current.periodStart ?? '').slice(0, 10)} to ${String(current.periodEnd ?? '').slice(0, 10)}`
          : 'No payroll run is open. Create a payroll to begin the period.'}
        actions={
          <>
            <button className="btn" onClick={() => navigate('/people/payrolls/runs')}>All runs</button>
            <button className="btn" onClick={() => navigate('/people/payroll-calendar')}>Payroll calendar</button>
            <button className="btn btn-primary" onClick={() => navigate('/people/payrolls/new')}>New payroll</button>
          </>
        }
      />
      {error && <ErrorBanner error={error} />}
      <HrKpiGrid>
        <HrKpi label="Headcount" value={fmtNum(totals.headcount)} sub={current ? String(current.status ?? '') : 'No open run'} />
        <HrKpi label="Gross payroll" value={fmtMoney(totals.gross)} sub={'Taxable ' + fmtMoney(totals.taxable)} accent="#1261A0" tint="rgba(18, 97, 160, 0.12)" />
        <HrKpi label="Net payroll" value={fmtMoney(totals.net)} sub={'Deductions ' + fmtMoney(totals.deductions)} accent="#168A5B" tint="rgba(22, 138, 91, 0.12)" />
        <HrKpi label="PAYE" value={fmtMoney(totals.paye)} sub={'LST ' + fmtMoney(totals.lst)} />
        <HrKpi label="NSSF" value={fmtMoney(nssfTotal)} sub={'Employee ' + fmtMoney(totals.employeeNssf) + ' - Employer ' + fmtMoney(totals.employerNssf)} />
        <HrKpi label="Employer cost" value={fmtMoney(totals.employerCost)} sub="Gross + employer NSSF + LST" accent="#B45309" tint="rgba(180, 83, 9, 0.12)" />
      </HrKpiGrid>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
        <section className="card">
          <div className="card-head">
            <h3>Workflow</h3>
            {current && <span className="muted">{String(currentStep?.label ?? current.status ?? '')}</span>}
          </div>
          {workflow.length === 0 ? (
            <EmptyState icon="◇" title="No workflow yet" hint="Create a payroll run to start the validation, approval and payment workflow.">
              <button className="btn btn-primary" onClick={() => navigate('/people/payrolls/new')}>New payroll</button>
            </EmptyState>
          ) : (
            <div className="timeline">
              {workflow.map((s) => {
                const tone = wfTone(s.state);
                return (
                  <div className="timeline-item" key={String(s.status)}>
                    <span className="timeline-dot" style={{ background: tone.fg }} />
                    <div className="timeline-title">
                      <span>{String(s.label ?? s.status)}</span>
                      <span className="chip" style={{ gap: 6, padding: '2px 8px', fontSize: 11, fontWeight: 700, color: tone.fg, background: tone.bg, borderColor: tone.bd }}>{String(s.state ?? 'PENDING')}</span>
                    </div>
                    <div className="timeline-meta">{String(s.status ?? '')}</div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <section className="card">
          <div className="card-head">
            <h3>Control panel</h3>
            {current && <Badge value={String(current.status ?? '')} />}
          </div>
          <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            <div className="kpi-card"><span className="kpi-label">Exceptions open</span><span className="kpi-value">{fmtNum(openExceptions)}</span></div>
            <div className="kpi-card"><span className="kpi-label">Blocking</span><span className="kpi-value">{fmtNum(blocking)}</span></div>
            <div className="kpi-card"><span className="kpi-label">High risk</span><span className="kpi-value">{fmtNum(highRisk)}</span></div>
            <div className="kpi-card"><span className="kpi-label">Warnings</span><span className="kpi-value">{fmtNum(warnings)}</span></div>
            <div className="kpi-card"><span className="kpi-label">Pending approvals</span><span className="kpi-value">{fmtNum(pendingApprovals)}</span></div>
            <div className="kpi-card"><span className="kpi-label">Pay date</span><span className="kpi-value" style={{ fontSize: 16 }}>{current ? String(current.payDate ?? '').slice(0, 10) || '-' : '-'}</span></div>
          </div>
          <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <button className="btn btn-sm" onClick={() => navigate('/people/exceptions')}>Exceptions centre</button>
            <button className="btn btn-sm" onClick={() => navigate('/inbox')}>Approvals inbox</button>
            {current && <button className="btn btn-sm" onClick={() => navigate('/people/payrolls/' + String(current.payrollId))}>Open run</button>}
            {payment && <button className="btn btn-sm" onClick={() => navigate('/people/payments')}>Payment {String(payment.status ?? '')}</button>}
          </div>
        </section>
      </div>      <section className="card">
        <div className="card-head">
          <h3>Statutory</h3>
          <span className="muted">Expected liability and filing status</span>
        </div>
        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          <div className="kpi-card"><span className="kpi-label">PAYE liability</span><span className="kpi-value">{fmtMoney(expected.paye)}</span></div>
          <div className="kpi-card"><span className="kpi-label">Employee NSSF</span><span className="kpi-value">{fmtMoney(expected.employeeNssf)}</span></div>
          <div className="kpi-card"><span className="kpi-label">Employer NSSF</span><span className="kpi-value">{fmtMoney(expected.employerNssf)}</span></div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Filing</th><th>Period</th><th className="cell-num">Gross</th><th className="cell-num">Employee</th><th className="cell-num">Employer</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>
              {filings.map((f, i) => (
                <tr key={String(f.filingNo ?? i)}>
                  <td className="cell-mono">{String(f.filingNo ?? '-')}</td>
                  <td>{String(f.periodStart ?? '').slice(0, 10)} - {String(f.periodEnd ?? '').slice(0, 10)}</td>
                  <td className="cell-num">{fmtMoney(f.grossAmount)}</td>
                  <td className="cell-num">{fmtMoney(f.employeeContribution)}</td>
                  <td className="cell-num">{fmtMoney(f.employerContribution)}</td>
                  <td>{String(f.dueDate ?? '').slice(0, 10) || '-'}</td>
                  <td><Badge value={String(f.status ?? '')} /></td>
                </tr>
              ))}
              {filings.length === 0 && (
                <HrTableEmpty colSpan={7} title="No statutory filings" hint="Filings appear once a payroll run reaches the statutory stage." />
              )}
            </tbody>
          </table>
        </div>
        <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          <button className="btn btn-sm" onClick={() => navigate('/people/statutory-configs')}>Statutory configuration</button>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Payroll calendar</h3>
          <button className="btn btn-sm" onClick={() => navigate('/people/payroll-calendar')}>Open calendar</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Period</th><th>Type</th><th>Pay date</th><th className="cell-num">Runs</th><th>Status</th></tr></thead>
            <tbody>
              {periods.map((per) => (
                <tr key={String(per.id)} className="row-click" onClick={() => navigate('/people/payroll-calendar?period=' + String(per.id))}>
                  <td>
                    <span className="td-strong">{String(per.code ?? '-')}</span>
                    <span className="cell-sub">{String(per.periodStart ?? '').slice(0, 10)} - {String(per.periodEnd ?? '').slice(0, 10)}</span>
                  </td>
                  <td>{String(per.periodType ?? 'NORMAL')} / {String(per.frequency ?? '')}</td>
                  <td>{String(per.paymentDate ?? '').slice(0, 10) || '-'}</td>
                  <td className="cell-num">{fmtNum(per.runCount)}</td>
                  <td><span className={'badge ' + periodStatusTone(per.status)}>{String(per.status ?? '')}</span></td>
                </tr>
              ))}
              {periods.length === 0 && (
                <HrTableEmpty colSpan={5} title="No payroll periods" hint="Create a period on the payroll calendar to schedule a run." />
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Recent runs</h3>
          <button className="btn btn-sm" onClick={() => navigate('/people/payrolls/runs')}>All runs</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Run</th><th>Period</th><th>Type</th><th className="cell-num">Gross</th><th className="cell-num">Net</th><th>GL</th><th>Status</th></tr></thead>
            <tbody>
              {recentRuns.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate('/people/payrolls/' + String(r.id))}>
                  <td className="cell-mono">{String(r.payrollNo ?? '-')}</td>
                  <td>{String(r.periodStart ?? '').slice(0, 10)} - {String(r.periodEnd ?? '').slice(0, 10)}</td>
                  <td>{String(r.runType ?? 'NORMAL')}</td>
                  <td className="cell-num">{fmtMoney(r.grossTotal)}</td>
                  <td className="cell-num">{fmtMoney(r.netTotal)}</td>
                  <td>{r.glPosted ? 'Posted' : 'Open'}</td>
                  <td><Badge value={String(r.status ?? '')} /></td>
                </tr>
              ))}
              {recentRuns.length === 0 && (
                <HrTableEmpty colSpan={7} title="No payroll runs yet" hint="Create a payroll to calculate statutory deductions and release net pay." />
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
export function PayrollList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hr/payrolls')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Payrolls failed'));
  }, []);

  const money = (v: unknown) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const monthPrefix = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
  const runTypeLabel = (v: unknown) => {
    const labels: Record<string, string> = {
      NORMAL: 'Normal',
      OFF_CYCLE: 'Off-cycle',
      FINAL: 'Final',
      ADJUSTMENT: 'Adjustment',
      REVERSAL: 'Reversal',
      ARREARS: 'Arrears',
    };
    const s = String(v ?? 'NORMAL');
    return labels[s] ?? s.replace(/_/g, ' ');
  };
  const runTypeTone = (v: unknown) => {
    const s = String(v ?? 'NORMAL');
    const tones: Record<string, { fg: string; bg: string; bd: string }> = {
      NORMAL: { fg: '#0F4A32', bg: '#E3F3EB', bd: '#B8DCCB' },
      OFF_CYCLE: { fg: '#1261A0', bg: '#E4F0FA', bd: '#B8D5EA' },
      FINAL: { fg: '#6D28D9', bg: '#EDE9FE', bd: '#C7B8EF' },
      ADJUSTMENT: { fg: '#B45309', bg: '#FDF3E0', bd: '#EFD9AE' },
      REVERSAL: { fg: '#8B1E1E', bg: '#FDECEC', bd: '#F1C2C2' },
      ARREARS: { fg: '#0F766E', bg: '#E3F4F2', bd: '#B4DCD7' },
    };
    return tones[s] ?? { fg: 'var(--muted)', bg: 'var(--paper-2)', bd: 'var(--line)' };
  };
  const isOpenStatus = (s: string) => ['DRAFT', 'SUBMITTED', 'APPROVED', 'RELEASED'].includes(s);

  const visible = rows.filter((r) => {
    const status = String(r.status ?? '');
    if (openOnly && !isOpenStatus(status)) return false;
    if (type && String(r.runType ?? 'NORMAL') !== type) return false;
    if (!q.trim()) return true;
    const hay = [r.payrollNo, r.reason, r.offCycleType, r.periodStart, r.periodEnd, r.paymentDate, status, runTypeLabel(r.runType)]
      .map((x) => String(x ?? ''))
      .join(' ')
      .toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  const openCount = rows.filter((r) => isOpenStatus(String(r.status ?? ''))).length;
  const paidCount = rows.filter((r) => String(r.status ?? '') === 'PAID').length;
  const queueCount = rows.filter((r) => ['SUBMITTED', 'APPROVED'].includes(String(r.status ?? ''))).length;
  const netThisMonth = rows
    .filter((r) => String(r.periodStart ?? '').startsWith(monthPrefix) && ['APPROVED', 'RELEASED', 'PAID', 'POSTED', 'CLOSED'].includes(String(r.status ?? '')))
    .reduce((sum, r) => sum + money(r.netTotal), 0);
  const latestScored = rows.find((r) => r.validationScore !== null && r.validationScore !== undefined);

  return (
    <div className="page">
      <HrPageHeader
        kicker="Payroll"
        title="Runs"
        subtitle="Payroll runs by period - calculate, validate, approve, post and release net pay."
        actions={
          <>
            <button className="btn" onClick={() => navigate('/people/payments')}>Pay batches</button>
            <button className="btn btn-primary" onClick={() => navigate('/people/payrolls/new')}>New payroll</button>
          </>
        }
      />
      {error && <ErrorBanner error={error} />}
      <HrKpiGrid>
        <HrKpi label="Payroll runs" value={fmtNum(rows.length)} sub={fmtNum(openCount) + ' open - ' + fmtNum(paidCount) + ' paid'} />
        <HrKpi label="Net this month" value={fmtMoney(netThisMonth)} sub="Approved, released or paid this period" accent="#168A5B" tint="rgba(22, 138, 91, 0.12)" />
        <HrKpi label="Approval queue" value={fmtNum(queueCount)} sub="Submitted or approved, not yet released" accent="#D99A00" tint="rgba(217, 154, 0, 0.12)" />
        <HrKpi label="Latest validation" value={latestScored ? String(latestScored.validationScore) + '%' : '-'} sub={latestScored ? 'Run ' + String(latestScored.payrollNo ?? '') : 'Validate a run to score readiness'} accent="#1261A0" tint="rgba(18, 97, 160, 0.12)" />
      </HrKpiGrid>
      <HrToolbar>
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search run number, reason, period..." aria-label="Search payroll runs" />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by run type">
          <option value="">All run types</option>
          <option value="NORMAL">Normal</option>
          <option value="OFF_CYCLE">Off-cycle</option>
          <option value="FINAL">Final</option>
          <option value="ADJUSTMENT">Adjustment</option>
          <option value="REVERSAL">Reversal</option>
          <option value="ARREARS">Arrears</option>
        </select>
        <button type="button" className={'btn btn-sm' + (openOnly ? ' btn-primary' : '')} onClick={() => setOpenOnly((v) => !v)} title="Only show runs that have not been paid or voided">
          {openOnly ? 'All runs' : 'Open runs only'}
        </button>
        {rows.length > 0 && <span className="muted" style={{ marginLeft: 'auto' }}>{fmtNum(visible.length)} of {fmtNum(rows.length)} runs</span>}
      </HrToolbar>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Run</th><th>Period</th><th>Type</th><th className="cell-num">People</th><th className="cell-num">Net</th><th>Status</th></tr></thead>
          <tbody>
            {visible.map((r) => {
              const tone = runTypeTone(r.runType);
              const status = String(r.status ?? '');
              const glLabel = r.glPosted ? 'Posted to GL' : 'GL open';
              const scoreLabel = r.validationScore === null || r.validationScore === undefined ? '' : ' - ' + String(r.validationScore) + '% ready';
              return (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate('/people/payrolls/' + String(r.id))}>
                  <td>
                    <span className="cell-mono" style={{ fontSize: 13, fontWeight: 650, color: 'var(--ink)' }}>{String(r.payrollNo ?? '-')}</span>
                    {r.payrollGroupId !== null && r.payrollGroupId !== undefined && <span className="cell-sub">Group {String(r.payrollGroupId)}</span>}
                  </td>
                  <td>
                    {String(r.periodStart ?? '').slice(0, 10) || '-'} - {String(r.periodEnd ?? '').slice(0, 10) || '-'}
                    {r.paymentDate ? <span className="cell-sub">Pays {String(r.paymentDate).slice(0, 10)}</span> : <span className="cell-sub">No pay date</span>}
                  </td>
                  <td>
                    <span className="chip" style={{ gap: 6, padding: '3px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '0.02em', color: tone.fg, background: tone.bg, borderColor: tone.bd }}>{runTypeLabel(r.runType)}</span>
                    {r.offCycleType ? <span className="cell-sub">{String(r.offCycleType).replace(/_/g, ' ')}</span> : r.reason ? <span className="cell-sub">{String(r.reason)}</span> : null}
                  </td>
                  <td className="cell-num">
                    {r.employeeCount !== null && r.employeeCount !== undefined ? fmtNum(r.employeeCount) : '-'}
                    <span className="cell-sub" style={{ textAlign: 'right' }}>employees</span>
                  </td>
                  <td className="cell-num">
                    <span className="td-strong">{fmtMoney(r.netTotal)}</span>
                    <span className="cell-sub" style={{ textAlign: 'right' }}>gross {fmtMoney(r.grossTotal)} - ded {fmtMoney(r.deductionTotal)}</span>
                  </td>
                  <td>
                    <Badge value={status} />
                    <span className="cell-sub">{glLabel}{scoreLabel}</span>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <HrTableEmpty
                colSpan={6}
                title={rows.length === 0 ? 'No payroll runs yet' : 'No runs match your filters'}
                hint={rows.length === 0 ? 'Create a payroll to calculate statutory deductions and release net pay.' : 'Try a different search, run type or clear the open-only toggle.'}
              />
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PayrollComposer() {
  const query = useHashQuery();
  const periodId = Number(query.get('periodId') ?? 0) || 0;
  const today = new Date();
  const startDefault = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const endDefault = end.toISOString().slice(0, 10);
  const [periodStart, setPeriodStart] = useState(startDefault);
  const [periodEnd, setPeriodEnd] = useState(endDefault);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ data: { payrollId: number } }>('/api/ops/hr/payrolls', {
        method: 'POST',
        body: JSON.stringify(periodId ? { periodStart, periodEnd, payrollPeriodId: periodId } : { periodStart, periodEnd }),
      });
      navigate(`/people/payrolls/${r.data.payrollId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/payrolls')}>Back</button>
          <h1>New payroll</h1>
          <p className="muted">Using statutory rules in force for the period.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required"><label>Period start</label><input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></div>
          <div className="field field-required"><label>Period end</label><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={save}>Calculate run</button>
      </section>
    </div>
  );
}