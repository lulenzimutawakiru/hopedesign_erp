import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { ConfirmDialog } from '../components/os';
import { Avatar, HrEmptyState as EmptyState, tileStyle } from '../components/hrUi';
import { type Rec, shortDate } from './hrShared';

/**
 * People-landing desks lifted out of HrFlow so the router file stops owning
 * presentation: the people board (KPI tiles, action tiles and drill-down
 * lists), the payroll exception centre, and the attendance clock.
 */
export function PeopleBoard() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/hr/board')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'People board failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader variant="page" label="Opening people…" />;
  const kpis = (data.kpis ?? {}) as Rec;
  const pending = (data.pendingLeave as Rec[]) ?? [];
  const runs = (data.payrolls as Rec[]) ?? [];
  const contracts = (data.contracts as Rec[]) ?? [];
  const tiles: Array<{ label: string; value: unknown; sub: string; href: string; icon: string; accent: string; tint: string }> = [
    { label: 'Headcount', value: kpis.headcount, sub: fmtNum(kpis.onLeave) + ' on leave', href: '/people/employees', icon: '👥', accent: '#8B5CF6', tint: 'rgba(139,92,246,0.12)' },
    { label: 'Pending leave', value: kpis.pendingLeave, sub: 'Waiting for approval', href: '/people/leave', icon: '⛱', accent: '#D99A00', tint: 'rgba(217,154,0,0.12)' },
    { label: 'Active contracts', value: kpis.activeContracts, sub: fmtNum(kpis.pendingSignature) + ' awaiting signature', href: '/people/contracts', icon: '📄', accent: '#1261A0', tint: 'rgba(18,97,160,0.12)' },
    { label: 'Expiring (30d)', value: kpis.expiringContracts, sub: 'Fixed-term ending soon', href: '/people/contracts/expiring', icon: '⏳', accent: '#D97706', tint: 'rgba(217,119,6,0.12)' },
    { label: 'Recent net pay', value: fmtMoney(kpis.lastNet), sub: 'Last 45 days released', href: '/people/payrolls', icon: '₴', accent: '#168A5B', tint: 'rgba(22,138,91,0.12)' },
    { label: 'Staff loans', value: fmtMoney(kpis.loanBook), sub: 'Outstanding book', href: '/people/loans', icon: '▣', accent: '#0891B2', tint: 'rgba(8,145,178,0.12)' },
  ];
  const actions: Array<{ href: string; title: string; hint: string; icon: string; show: boolean }> = [
    { href: '/people/employees', title: 'Employees', hint: 'Hire, file and terminate', icon: '👤', show: true },
    { href: '/people/hcm', title: 'HCM overview', hint: 'Workforce and ATS', icon: '🗺', show: can(user, 'hr.employees.view') },
    { href: '/people/contracts', title: 'Contracts', hint: 'Draft, print and sign', icon: '📄', show: can(user, 'hr.contracts.view') },
    { href: '/people/leave', title: 'Leave', hint: 'Approve requests', icon: '⛱', show: true },
    { href: '/people/attendance', title: 'Attendance', hint: "Today's clock", icon: '⏱', show: true },
    { href: '/people/payrolls', title: 'Payroll', hint: 'Calculate and post', icon: '₴', show: true },
    { href: '/people/exceptions', title: 'Exceptions', hint: 'Open payroll issues', icon: '⚠', show: can(user, 'hr.payrolls.view') },
    { href: '/people/final-settlements', title: 'Final settlements', hint: 'Pay terminated staff', icon: '☑', show: can(user, 'hr.final_settlements.view') },
    { href: '/people/off-cycle', title: 'Off-cycle', hint: 'Bonus, arrears, corrections', icon: '✦', show: can(user, 'hr.payrolls.create') },
    { href: '/people/arrears', title: 'Arrears', hint: 'Approve pay corrections', icon: '↺', show: can(user, 'hr.payrolls.view') },
    { href: '/people/loans', title: 'Staff loans', hint: 'Approve and recover', icon: '▣', show: can(user, 'hr.loans.view') },
    { href: '/people/advances', title: 'Salary advances', hint: 'Issue against payroll', icon: '→', show: can(user, 'hr.advances.view') },
    { href: '/people/payments', title: 'Pay batches', hint: 'Bank files and confirm', icon: '🏦', show: can(user, 'hr.payrolls.view') },
    { href: '/people/offboardings', title: 'Offboarding', hint: 'Exit clearance', icon: '↩', show: can(user, 'hr.offboardings.view') },
    { href: '/people/performance', title: 'Performance', hint: 'Goals, reviews, PIPs', icon: '◎', show: can(user, 'hr.performance_goals.view') },
    { href: '/people/training', title: 'Training', hint: 'Courses and enrollments', icon: '🎓', show: can(user, 'hr.training_catalog.view') },
    { href: '/people/benefits', title: 'Benefits', hint: 'Plans and enrollments', icon: '+', show: can(user, 'hr.benefit_plans.view') },
    { href: '/people/relations', title: 'Relations', hint: 'Grievances and warnings', icon: '⚖', show: can(user, 'hr.grievances.view') },
    { href: '/people/time', title: 'Time & shifts', hint: 'Roster and timesheets', icon: '⏱', show: can(user, 'hr.shifts.view') },
    { href: '/people/me', title: 'My HR', hint: 'Self-service file', icon: '☺', show: true },
  ];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">HR & payroll</p>
          <h1>People</h1>
          <p className="muted">Hire, contract, leave and payroll on one desk. PAYE and NSSF calculate on the slip; release posts the ledger.</p>
        </div>
        <div className="head-actions">
          {can(user, 'hr.contracts.create') && <button className="btn" onClick={() => navigate('/people/contracts/new')}>New contract</button>}
          {can(user, 'hr.employees.create') && <button className="btn" onClick={() => navigate('/people/employees/new')}>New employee</button>}
          {can(user, 'hr.payrolls.create') && <button className="btn btn-primary" onClick={() => navigate('/people/payrolls/new')}>New payroll</button>}
        </div>
      </header>
      <div className="kpi-grid--tiles">
        {tiles.map((t) => (
          <button key={t.label} className="kpi-tile" style={tileStyle(t.accent, t.tint)} onClick={() => navigate(t.href)}>
            <span className="kpi-tile-icon" aria-hidden>{t.icon}</span>
            <span className="kpi-tile-body">
              <span className="kpi-tile-label">{t.label}</span>
              <span className="kpi-tile-value">{typeof t.value === 'string' ? t.value : fmtNum(t.value)}</span>
              <span className="kpi-tile-sub">{t.sub}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="action-tile-grid">
        {actions.filter((a) => a.show).map((a) => (
          <button key={a.href} className="action-tile" onClick={() => navigate(a.href)}>
            <span className="action-tile-icon" aria-hidden>{a.icon}</span>
            <span><strong>{a.title}</strong><span>{a.hint}</span></span>
          </button>
        ))}
      </div>
      <div className="people-split">
        <section className="card">
          <div className="card-head">
            <h3>Leave waiting</h3>
            <button className="btn btn-sm" onClick={() => navigate('/people/leave')}>Open leave</button>
          </div>
          {pending.length === 0 ? (
            <div className="card-pad"><EmptyState icon="✓" title="Inbox clear" hint="No leave requests are waiting for approval." /></div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Type</th><th>From</th><th className="cell-num">Days</th></tr></thead>
                <tbody>
                  {pending.map((r) => (
                    <tr key={String(r.id)} className="row-click" onClick={() => navigate(r.employeeId ? `/people/employees/${r.employeeId}` : '/people/leave')}>
                      <td><Avatar name={String(r.firstName) + ' ' + String(r.lastName)} sub={String(r.employeeNo ?? '')} size="sm" /></td>
                      <td><Badge value={r.leaveType} /></td>
                      <td>{shortDate(r.startDate)}</td>
                      <td className="cell-num">{fmtNum(r.days)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card">
          <div className="card-head">
            <h3>Contracts</h3>
            <button className="btn btn-sm" onClick={() => navigate('/people/contracts')}>Register</button>
          </div>
          {contracts.length === 0 ? (
            <div className="card-pad"><EmptyState icon="📄" title="No contracts yet" hint="Create the first employment contract from an employee file or the contract builder." /></div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Contract</th><th>Employee</th><th>Status</th></tr></thead>
                <tbody>
                  {contracts.map((c) => (
                    <tr key={String(c.id)} className="row-click" onClick={() => navigate('/people/contracts/' + String(c.id))}>
                      <td className="cell-mono">{String(c.contractNo ?? '-')}</td>
                      <td><Avatar name={String(c.firstName ?? '') + ' ' + String(c.lastName ?? '')} sub={String(c.employeeNo ?? '')} size="sm" /></td>
                      <td><Badge value={c.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h3>Payroll runs</h3>
          <button className="btn btn-sm" onClick={() => navigate('/people/payrolls')}>All runs</button>
        </div>
        {runs.length === 0 ? (
          <div className="card-pad"><EmptyState icon="₴" title="No payrolls yet" hint="Start a run when attendance and contracts are in place." /></div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Run</th><th>Period</th><th>Status</th><th className="cell-num">Net</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/payrolls/${r.id}`)}>
                    <td className="cell-mono">{String(r.payrollNo)}</td>
                    <td>{shortDate(r.periodStart)} – {shortDate(r.periodEnd)}</td>
                    <td><Badge value={r.status} /></td>
                    <td className="cell-num td-strong">{fmtMoney(r.netTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function ExceptionsCentre() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ status: '', severity: '', q: '' });
  const [dialog, setDialog] = useState<{ row: Rec; action: 'RESOLVED' | 'IGNORED' } | null>(null);
  const load = useCallback(() => {
    const params = new URLSearchParams({ pageSize: '100' });
    if (filters.status) params.set('status', filters.status);
    if (filters.severity) params.set('severity', filters.severity);
    if (filters.q) params.set('q', filters.q);
    api<{ data: Rec }>(`/api/ops/hr/exceptions?${params.toString()}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Exception centre failed'));
  }, [filters]);
  useEffect(() => { load(); }, [load]);
  const apply = () => { setError(''); setFilters({ status, severity, q: q.trim() }); };
  const reset = () => { setStatus(''); setSeverity(''); setQ(''); setError(''); setFilters({ status: '', severity: '', q: '' }); };
  const act = async (row: Rec, action: 'RESOLVED' | 'IGNORED', note: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const payload: Rec = { status: action };
      if (action === 'RESOLVED' && note) payload.note = note;
      const r = await api<{ data: Rec }>(`/api/ops/hr/exceptions/${row.id}/resolve`, { method: 'POST', body: JSON.stringify(payload) });
      const score = (r.data.validation as Rec | undefined)?.validationScore ?? '?';
      setNotice(action === 'RESOLVED'
        ? `Exception resolved. Readiness refreshed to ${score}/100.`
        : `Exception ignored. Readiness refreshed to ${score}/100.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader variant="page" label="Opening exception centre" />;
  const summary = (data.summary ?? {}) as Rec;
  const rows = (data.rows as Rec[]) ?? [];
  const topTypes = (data.topTypes as Rec[]) ?? [];
  const openErrors = Number(summary.openErrors) || 0;
  const openWarnings = Number(summary.openWarnings) || 0;
  const open = Number(summary.open) || 0;
  const resolved = Number(summary.resolved) || 0;
  const ignored = Number(summary.ignored) || 0;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Payroll controls</p>
          <h1>Exception centre</h1>
          <p className="muted">Every payroll issue across runs, ready to resolve before release.</p>
        </div>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Open errors</span><span className="kpi-value" style={{ color: 'var(--clay)' }}>{fmtNum(openErrors)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Open warnings</span><span className="kpi-value" style={{ color: 'var(--amber)' }}>{fmtNum(openWarnings)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Total open</span><span className="kpi-value">{fmtNum(open)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Resolved</span><span className="kpi-value">{fmtNum(resolved)}</span><span className="kpi-sub">{fmtNum(ignored)} ignored</span></div>
      </div>
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="OPEN">Open</option>
          <option value="RESOLVED">Resolved</option>
          <option value="IGNORED">Ignored</option>
        </select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
          <option value="">All severities</option>
          <option value="ERROR">Error</option>
          <option value="WARNING">Warning</option>
          <option value="HIGH_RISK">High risk</option>
        </select>
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search employee, payroll no, message…" />
        <button className="btn btn-sm" onClick={apply}>Apply</button>
        <button className="btn btn-sm" onClick={reset}>Reset</button>
      </div>
      {topTypes.length > 0 && (
        <div className="chips" style={{ marginBottom: 14 }}>
          {topTypes.map((t) => (
            <span key={String(t.exceptionType)} className="chip">
              <span className="chip-k">{String(t.exceptionType).replace(/_/g, ' ')}</span> <b>{fmtNum(t.count)}</b> ({fmtNum(t.open)} open)
            </span>
          ))}
        </div>
      )}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Run</th><th>Period</th><th>Employee</th><th>Type</th><th>Severity</th><th>Message</th><th>Status</th><th>Resolved</th><th>Actions</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.id)}>
                <td className="cell-mono row-click" onClick={() => { if (row.payrollId) navigate(`/people/payrolls/${row.payrollId}`); }}>{String(row.payrollNo)}</td>
                <td>{String(row.periodStart).slice(0, 10)} – {String(row.periodEnd).slice(0, 10)}</td>
                <td>
                  {row.employeeId
                    ? <span className="row-click" onClick={() => navigate(`/people/employees/${row.employeeId}`)}>{String(row.firstName)} {String(row.lastName)} <span className="cell-mono">{String(row.employeeNo ?? '')}</span></span>
                    : <span className="muted">Run-level</span>}
                </td>
                <td className="cell-mono">{String(row.exceptionType).replace(/_/g, ' ')}</td>
                <td><Badge value={row.severity} /></td>
                <td>{String(row.message)}</td>
                <td><Badge value={row.status} /></td>
                <td>{String(row.status) === 'OPEN' ? <span className="muted">—</span> : <span className="muted">{String(row.resolutionNote ?? '').slice(0, 40) || '—'} · {fmtDate(row.resolvedAt)}</span>}</td>
                <td>
                  {String(row.status) === 'OPEN' && can(user, 'hr.payrolls.approve') ? (
                    <span className="row-actions">
                      <button className="btn btn-sm btn-success" disabled={busy} onClick={() => setDialog({ row, action: 'RESOLVED' })}>Resolve</button>
                      <button className="btn btn-sm" disabled={busy} onClick={() => setDialog({ row, action: 'IGNORED' })}>Ignore</button>
                    </span>
                  ) : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>No exceptions. Run a payroll and validate it to surface issues.</td></tr>}
          </tbody>
        </table>
      </div>
      {dialog && (
        <ConfirmDialog
          title={dialog.action === 'RESOLVED' ? 'Resolve exception' : 'Ignore exception'}
          body={dialog.action === 'RESOLVED'
            ? `Resolve ${String(dialog.row.exceptionType ?? 'this exception').replace(/_/g, ' ').toLowerCase()} for ${String(dialog.row.firstName ?? '')} ${String(dialog.row.lastName ?? '')}? Payroll readiness is recalculated immediately.`
            : 'Ignore this exception? It stays on record but no longer blocks this payroll.'}
          confirmLabel={dialog.action === 'RESOLVED' ? 'Resolve exception' : 'Ignore exception'}
          danger={dialog.action === 'IGNORED'}
          reasonLabel={dialog.action === 'RESOLVED' ? 'Resolution note (stored on the exception)' : null}
          onCancel={() => setDialog(null)}
          onConfirm={(reason) => { const d = dialog; setDialog(null); if (d) void act(d.row, d.action, reason); }}
        />
      )}
    </div>
  );
}

export function AttendanceDesk() {
  const [data, setData] = useState<{ workDate: string; rows: Rec[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: { workDate: string; rows: Rec[] } }>('/api/ops/hr/attendance')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Attendance failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader variant="page" label="Opening attendance…" />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">Attendance</p>
          <h1>Clock for {data.workDate}</h1>
        </div>
      </header>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Employee</th><th>In</th><th>Out</th><th className="cell-num">Hours</th><th>Status</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.firstName)} {String(r.lastName)}</td>
                <td>{r.clockIn ? String(r.clockIn).slice(11, 16) : '—'}</td>
                <td>{r.clockOut ? String(r.clockOut).slice(11, 16) : '—'}</td>
                <td className="cell-num">{r.hours != null ? fmtNum(r.hours) : '—'}</td>
                <td><Badge value={r.status} /></td>
              </tr>
            ))}
            {data.rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>Nobody clocked today.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
