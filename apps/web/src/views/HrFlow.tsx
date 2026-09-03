import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api, DocFormat, fmtDate, fmtMoney, fmtNum, openDocument } from '../api';
import { useAuth, can } from '../auth';
import { useCompanyProfile } from '../company';
import { navigate, useHashQuery } from '../router';
import { Badge, ErrorBanner, PageLoader, StaffPhoto } from '../components/ui';
import RecruitmentFlow from './RecruitmentFlow';
import OnboardingFlow from './OnboardingFlow';
import WorkforcePlanning from './WorkforcePlanning';
import LeaveFlow from './LeaveFlow';
import ContractFlow from './ContractFlow';
import EmployeeIdentity from './EmployeeIdentity';
import HcmOps from './HcmOps';

type Rec = Record<string, unknown>;

function initials(name: string): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function avatarHue(name: string): number {
  let h = 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
const AVATAR_TONES = ['#8B5CF6', '#1261A0', '#0891B2', '#168A5B', '#D97706', '#C93636', '#4F46A5', '#2878D0'];
function Avatar({ name, sub, size = 'md', meta = true }: { name: string; sub?: string; size?: 'sm' | 'md' | 'lg'; meta?: boolean }) {
  const bg = AVATAR_TONES[Math.floor((avatarHue(name) / 360) * AVATAR_TONES.length)];
  return (
    <span className="avatar-row" style={{ minWidth: 0 }}>
      <span className={'avatar avatar-' + size} style={{ background: bg }} aria-hidden>{initials(name)}</span>
      {meta && (name || sub) && (
        <span className="avatar-meta">
          {name && <span className="avatar-name">{name}</span>}
          {sub && <span className="avatar-sub">{sub}</span>}
        </span>
      )}
    </span>
  );
}
function EmptyState({ icon = '•', title, hint, children }: { icon?: string; title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden>{icon}</div>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}
function tileStyle(accent: string, tint: string): CSSProperties {
  return { ['--tile-accent' as string]: accent, ['--tile-tint' as string]: tint };
}
function shortDate(v: unknown): string {
  if (!v) return '—';
  return String(v).slice(0, 10);
}

function parsePeople(path: string): { view: string; id: string | null; sub: string | null } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'people') return { view: 'board', id: null, sub: null };
  return { view: parts[1] ?? 'board', id: parts[2] ?? null, sub: parts[3] ?? null };
}

export default function HrFlow({ path }: { path: string }) {
  const { view, id, sub } = parsePeople(path);
  if (view === 'employees' && id === 'new') return <EmployeeComposer />;
  if (view === 'employees' && id && sub === 'edit') return <EmployeeEditor id={Number(id)} />;
  if (view === 'employees' && id) return <EmployeeDesk id={Number(id)} />;
  if (view === 'employees') return <EmployeeList />;
  if (view === 'employee-ids') return <EmployeeIdentity path={path} />;
  if (view === 'leave') return <LeaveDesk path={path} />;
  if (view === 'attendance') return <AttendanceDesk />;
  if (view === 'contracts') return <ContractFlow path={path} />;
  if (view === 'payrolls' && id === 'new') return <PayrollComposer />;
  if (view === 'payrolls' && id) return <PayrollDesk id={Number(id)} />;
  if (view === 'payrolls') return <PayrollList />;
  if (view === 'final-settlements' && id) return <FinalSettlementDesk id={Number(id)} />;
  if (view === 'final-settlements') return <FinalSettlementList />;
  if (view === 'off-cycle' && id === 'new') return <OffCycleComposer />;
  if (view === 'off-cycle' && id) return <OffCycleDesk id={Number(id)} />;
  if (view === 'off-cycle') return <OffCycleList />;
  if (view === 'arrears' && id === 'new') return <ArrearsComposer />;
  if (view === 'arrears') return <ArrearsList />;
  if (view === 'hcm') return <HcmBoard />;
  if (view === 'offboardings' && id === 'new') return <OffboardingComposer />;
  if (view === 'offboardings' && id) return <OffboardingDesk id={Number(id)} />;
  if (view === 'offboardings') return <OffboardingList />;
  if (view === 'exceptions') return <ExceptionsCentre />;
  if (view === 'requisitions' || view === 'vacancies' || view === 'recruitment' || view === 'candidates') return <RecruitmentFlow path={path} />;
  if (view === 'onboarding' || view === 'onboardings') return <OnboardingFlow path={path} />;
  if (view === 'org' || view === 'positions' || view === 'workforce' || view === 'workforce-plans' || view === 'scenarios') return <WorkforcePlanning path={path} />;
  if (['loans', 'advances', 'payments', 'performance', 'training', 'benefits', 'relations', 'time', 'me'].includes(view)) return <HcmOps path={path} />;
  return <PeopleBoard />;
}

function PeopleBoard() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/hr/board')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'People board failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening people…" />;
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

function ExceptionsCentre() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ status: '', severity: '', q: '' });
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
  const act = async (row: Rec, action: 'RESOLVED' | 'IGNORED') => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'RESOLVED') {
        const note = window.prompt('Resolution note (optional)');
        if (note === null) return;
        const payload: Rec = { status: action };
        if (note) payload.note = note;
        const r = await api<{ data: Rec }>(`/api/ops/hr/exceptions/${row.id}/resolve`, { method: 'POST', body: JSON.stringify(payload) });
        setNotice(`Exception resolved. Readiness refreshed to ${(r.data.validation as Rec | undefined)?.validationScore ?? '?'}/100.`);
      } else {
        if (!window.confirm('Ignore this exception? It stays on record but no longer blocks this payroll.')) return;
        const r = await api<{ data: Rec }>(`/api/ops/hr/exceptions/${row.id}/resolve`, { method: 'POST', body: JSON.stringify({ status: action }) });
        setNotice(`Exception ignored. Readiness refreshed to ${(r.data.validation as Rec | undefined)?.validationScore ?? '?'}/100.`);
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening exception centre" />;
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
                      <button className="btn btn-sm btn-success" disabled={busy} onClick={() => act(row, 'RESOLVED')}>Resolve</button>
                      <button className="btn btn-sm" disabled={busy} onClick={() => act(row, 'IGNORED')}>Ignore</button>
                    </span>
                  ) : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>No exceptions. Run a payroll and validate it to surface issues.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HcmBoard() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/hcm/dashboard')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'HCM dashboard failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening HCM overview..." />;
  const kpis = (data.kpis ?? {}) as Rec;
  const pipeline = (data.pipeline as Rec[]) ?? [];
  const requisitions = (data.openRequisitions as Rec[]) ?? [];
  const vacancies = (data.publishedVacancies as Rec[]) ?? [];
  const onboarding = (data.recentOnboarding as Rec[]) ?? [];
  const expiring = (data.expiringContracts as Rec[]) ?? [];
  const payrolls = (data.recentPayrolls as Rec[]) ?? [];
  const alumni = (data.alumni as Rec[]) ?? [];
  const stageCount = (stage: string) => {
    const row = pipeline.find((s) => String(s.stage) === stage);
    return row ? Number(row.count) : 0;
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people')}>Back</button>
          <p className="mod-kicker" data-mod="hr">HCM</p>
          <h1>HCM overview</h1>
          <p className="muted">Workforce planning, recruitment pipeline and the employee lifecycle at a glance.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid--tiles">
        {[
          { label: 'Headcount', value: fmtNum(kpis.headcount), sub: fmtNum(kpis.onLeave) + ' on leave · ' + fmtNum(kpis.probation) + ' probation', href: '/people/employees', icon: '👥', accent: '#8B5CF6', tint: 'rgba(139,92,246,0.12)' },
          { label: 'Positions gap', value: fmtNum(kpis.headcountGap), sub: fmtNum(kpis.occupiedHeadcount) + ' of ' + fmtNum(kpis.approvedHeadcount) + ' filled', href: '/people/positions', icon: '⊞', accent: '#1261A0', tint: 'rgba(18,97,160,0.12)' },
          { label: 'Open requisitions', value: fmtNum(kpis.openRequisitions), sub: fmtNum(kpis.publishedVacancies) + ' published', href: '/people/requisitions', icon: '📋', accent: '#7C3AED', tint: 'rgba(124,58,237,0.12)' },
          { label: 'In pipeline', value: fmtNum(kpis.applicationsInPipeline), sub: 'candidate applications', href: '/people/recruitment', icon: '◎', accent: '#2878D0', tint: 'rgba(40,120,208,0.12)' },
          { label: 'Pending leave', value: fmtNum(kpis.pendingLeave), sub: fmtNum(kpis.pendingTraining) + ' training requests', href: '/people/leave', icon: '⛱', accent: '#D99A00', tint: 'rgba(217,154,0,0.12)' },
          { label: 'Onboarding', value: fmtNum(kpis.pendingOnboarding), sub: fmtNum(kpis.expiringContracts) + ' contracts ending', href: '/people/onboarding', icon: '➜', accent: '#0891B2', tint: 'rgba(8,145,178,0.12)' },
          { label: 'Exits (90d)', value: fmtNum(kpis.recentExits), sub: 'alumni on record', href: '/people/offboardings', icon: '↩', accent: '#C93636', tint: 'rgba(201,54,54,0.12)' },
          { label: 'Recent payroll net', value: fmtMoney(kpis.recentPayrollNet), sub: 'gross ' + fmtMoney(kpis.recentPayrollGross), href: '/people/payrolls', icon: '₴', accent: '#168A5B', tint: 'rgba(22,138,91,0.12)' },
        ].map((t) => (
          <button key={t.label} className="kpi-tile" style={tileStyle(t.accent, t.tint)} onClick={() => navigate(t.href)}>
            <span className="kpi-tile-icon" aria-hidden>{t.icon}</span>
            <span className="kpi-tile-body">
              <span className="kpi-tile-label">{t.label}</span>
              <span className="kpi-tile-value">{t.value}</span>
              <span className="kpi-tile-sub">{t.sub}</span>
            </span>
          </button>
        ))}
      </div>
      <section className="card card-pad">
        <div className="card-head" style={{ padding: 0, border: 0, marginBottom: 10 }}><h3>ATS pipeline</h3></div>
        {pipeline.length === 0 ? (
          <EmptyState icon="◎" title="No applications yet" hint="Published vacancies feed this pipeline." />
        ) : (
          <div className="pipe-strip">
            {pipeline.map((s) => (
              <button key={String(s.stage)} className="pipe-stage" onClick={() => navigate('/people/recruitment')}>
                <span className="k">{String(s.stage).replace(/_/g, ' ')}</span>
                <span className="v">{fmtNum(s.count)}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="card">
        <div className="card-head"><h3>Open requisitions</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Requisition</th><th>Department</th><th>Type</th><th className="cell-num">Headcount</th><th className="cell-num">Salary range</th><th>Status</th></tr></thead>
            <tbody>
              {requisitions.map((r) => (
                <tr key={String(r.id)}>
                  <td><span className="cell-mono">{String(r.requisitionNo)}</span> - {String(r.title)}</td>
                  <td>{String(r.departmentName ?? '')}</td>
                  <td><Badge value={r.employmentType} /></td>
                  <td className="cell-num">{fmtNum(r.headcount)}</td>
                  <td className="cell-num">{fmtMoney(r.salaryMin)} - {fmtMoney(r.salaryMax)}</td>
                  <td><Badge value={r.status} /></td>
                </tr>
              ))}
              {requisitions.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No open requisitions.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Published vacancies</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Vacancy</th><th>Department</th><th className="cell-num">Openings</th><th className="cell-num">Filled</th><th className="cell-num">Applications</th><th>Closes</th></tr></thead>
            <tbody>
              {vacancies.map((v) => (
                <tr key={String(v.id)}>
                  <td><span className="cell-mono">{String(v.vacancyNo)}</span> - {String(v.title)}</td>
                  <td>{String(v.departmentName ?? '')}</td>
                  <td className="cell-num">{fmtNum(v.openings)}</td>
                  <td className="cell-num">{fmtNum(v.filled)}</td>
                  <td className="cell-num">{fmtNum(v.totalApplications)}</td>
                  <td>{v.closesAt ? String(v.closesAt).slice(0, 10) : 'Open'}</td>
                </tr>
              ))}
              {vacancies.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No published vacancies.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Recent onboarding</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Employee</th><th>Instance</th><th>Status</th><th>Started</th><th>Completed</th></tr></thead>
            <tbody>
              {onboarding.map((o) => (
                <tr key={String(o.id)}>
                  <td>{String(o.firstName)} {String(o.lastName)} <span className="muted">({String(o.employeeNo)})</span></td>
                  <td className="cell-mono">{String(o.instanceNo)}</td>
                  <td><Badge value={o.status} /></td>
                  <td>{o.startedAt ? String(o.startedAt).slice(0, 10) : 'Pending'}</td>
                  <td>{o.completedAt ? String(o.completedAt).slice(0, 10) : '-'}</td>
                </tr>
              ))}
              {onboarding.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No onboarding activity yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Contracts ending (90 days)</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Employee</th><th>Type</th><th>End date</th><th className="cell-num">Salary</th></tr></thead>
            <tbody>
              {expiring.map((c) => (
                <tr key={String(c.id)} className="row-click" onClick={() => navigate('/people/contracts/' + String(c.id))}>
                  <td>{String(c.firstName)} {String(c.lastName)} <span className="muted">({String(c.employeeNo)})</span></td>
                  <td><Badge value={c.contractType} /></td>
                  <td>{String(c.endDate).slice(0, 10)}</td>
                  <td className="cell-num">{fmtMoney(c.salary)}</td>
                </tr>
              ))}
              {expiring.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24 }}>No contracts expiring soon.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Recent exits / alumni</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Employee</th><th>Exit date</th><th>Type</th><th>Reason</th><th>Rehire</th></tr></thead>
            <tbody>
              {alumni.map((a) => (
                <tr key={String(a.id)} className="row-click" onClick={() => navigate(`/people/employees/${a.id}`)}>
                  <td>{String(a.firstName)} {String(a.lastName)} <span className="muted">({String(a.employeeNo)})</span></td>
                  <td>{a.alumniDate ? String(a.alumniDate).slice(0, 10) : '—'}</td>
                  <td><Badge value={a.offboardingType} /></td>
                  <td>{String(a.exitReason ?? '—')}</td>
                  <td>{a.rehireEligible ? <Badge value="ELIGIBLE" /> : <Badge value="NO" />}</td>
                </tr>
              ))}
              {alumni.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No exits recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Recent payroll runs</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Run</th><th>Period</th><th>Status</th><th className="cell-num">Gross</th><th className="cell-num">Net</th></tr></thead>
            <tbody>
              {payrolls.map((r) => (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/payrolls/${r.id}`)}>
                  <td className="cell-mono">{String(r.payrollNo)}</td>
                  <td>{String(r.periodStart).slice(0, 10)} - {String(r.periodEnd).slice(0, 10)}</td>
                  <td><Badge value={r.status} /></td>
                  <td className="cell-num">{fmtMoney(r.grossTotal)}</td>
                  <td className="cell-num">{fmtMoney(r.netTotal)}</td>
                </tr>
              ))}
              {payrolls.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No payroll runs yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <p className="muted" style={{ padding: '0 4px 24px' }}>
        Pipeline totals: {stageCount('SUBMITTED')} applied, {stageCount('SCREENING')} screening, {stageCount('SHORTLISTED')} shortlisted, {stageCount('INTERVIEW')} interview, {stageCount('ASSESSMENT')} assessment, {stageCount('OFFER')} offer, {stageCount('ACCEPTED')} hired.
      </p>
    </div>
  );
}

function OffCycleList() {
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

function OffCycleComposer() {
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

function OffCycleDesk({ id }: { id: number }) {
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
  if (!doc) return <PageLoader label="Opening run" />;
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
        {['APPROVED', 'RELEASED'].includes(String(p.status)) && !p.glPosted && can(user, 'hr.payrolls.post') && (
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

function UserAccountLink({
  employeeId, account, matches, canEdit, onChanged,
}: { employeeId: number; account: Rec | null; matches: Rec[]; canEdit: boolean; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const search = async () => {
    if (!q.trim()) { setHits([]); return; }
    try {
      const r = await api<{ data: Rec[] }>(`/api/ops/hr/directory/users?unlinked=1&q=${encodeURIComponent(q.trim())}`);
      setHits(r.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    }
  };
  const link = async (userId: number) => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/hr/employees/${employeeId}/link-user`, { method: 'POST', body: JSON.stringify({ userId }) });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not link');
    } finally { setBusy(false); }
  };
  const unlink = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/hr/employees/${employeeId}/unlink-user`, { method: 'POST', body: '{}' });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not unlink');
    } finally { setBusy(false); }
  };
  if (account && account.id) {
    return (
      <div>
        {error && <ErrorBanner error={error} />}
        <dl className="def-list">
          <div><dt>Username</dt><dd className="cell-mono">{String(account.username || '—')}</dd></div>
          <div><dt>Email</dt><dd>{String(account.email || '—')}</dd></div>
          <div><dt>Status</dt><dd><Badge value={account.status} /></dd></div>
        </dl>
        <div className="action-group" style={{ marginTop: 12 }}>
          <button className="btn btn-sm" onClick={() => navigate('/admin/users')}>Open user accounts</button>
          {canEdit && <button className="btn btn-sm" disabled={busy} onClick={() => void unlink()}>Unlink</button>}
        </div>
      </div>
    );
  }
  const options = hits.length ? hits : matches;
  return (
    <div>
      {error && <ErrorBanner error={error} />}
      <p className="muted">No ERP login is linked. Search an existing user account to connect payroll, leave and this file.</p>
      {canEdit && (
        <div className="toolbar">
          <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search username or email" onKeyDown={(ev) => { if (ev.key === 'Enter') void search(); }} />
          <button className="btn btn-sm" onClick={() => void search()}>Search</button>
        </div>
      )}
      {options.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="data">
            <tbody>
              {options.map((row) => (
                <tr key={String(row.id)}>
                  <td className="cell-mono">{String(row.username ?? '')}</td>
                  <td>{String(row.email ?? '')}</td>
                  <td>{String(row.firstName ?? '')} {String(row.lastName ?? '')}</td>
                  <td>{canEdit && <button className="btn btn-sm" disabled={busy || row.employeeId != null} onClick={() => void link(Number(row.id))}>{row.employeeId != null ? 'Linked' : 'Link'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EmployeeList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ pageSize: '50' });
    if (q.trim()) p.set('q', q.trim());
    api<{ data: { rows: Rec[] } }>(`/api/ops/hr/employees?${p}`)
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Employees failed'));
  }, [q]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">Employees</p>
          <h1>Headcount</h1>
          <p className="muted">Open a file to print contracts, book leave, or start payroll movements.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => navigate('/people')}>Board</button>
          <button className="btn btn-primary" onClick={() => navigate('/people/employees/new')}>New employee</button>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or number…" />
        <span className="muted">{fmtNum(rows.length)} on this page</span>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>No</th><th>Name</th><th>Dept</th><th>Position</th><th>ERP login</th><th>Status</th><th className="cell-num">Basic</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/employees/${r.id}`)}>
                <td className="cell-mono">{String(r.employeeNo)}</td>
                <td><Avatar name={String(r.firstName) + ' ' + String(r.lastName)} size="sm" /></td>
                <td>{String(r.departmentName ?? '—')}</td>
                <td>{String(r.position ?? '—')}</td>
                <td>{r.userId ? <span className="cell-mono">{String(r.userUsername ?? 'Linked')}</span> : <span className="muted">None</span>}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num td-strong">{fmtMoney(r.baseSalary)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7}><EmptyState icon="👤" title="No employees match" hint="Try a different search, or hire the first person on the file."><button className="btn btn-primary btn-sm" onClick={() => navigate('/people/employees/new')}>New employee</button></EmptyState></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmployeeDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loanAmt, setLoanAmt] = useState('500000');
  const [loanDed, setLoanDed] = useState('50000');
  const [leaveStart, setLeaveStart] = useState('');
  const [leaveEnd, setLeaveEnd] = useState('');
  const [timeline, setTimeline] = useState<Rec[]>([]);
  const [positions, setPositions] = useState<Rec[]>([]);
  const [movementType, setMovementType] = useState('TRANSFER');
  const [movementPositionId, setMovementPositionId] = useState('');
  const [movementEffective, setMovementEffective] = useState('');
  const [movementSalary, setMovementSalary] = useState('');
  const [movementReason, setMovementReason] = useState('');
  const [tab, setTab] = useState('overview');
  const [docBusy, setDocBusy] = useState('');
  const [photoRev, setPhotoRev] = useState(0);
  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/hr/employees/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Employee failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const loadTimeline = useCallback(() => {
    api<{ data: { events: Rec[] } }>(`/api/ops/hcm/employees/${id}/timeline`)
      .then((r) => setTimeline(r.data.events ?? []))
      .catch(() => undefined);
  }, [id]);
  useEffect(() => {
    loadTimeline();
    api<{ data: Rec[] }>('/api/hr/positions')
      .then((r) => setPositions(r.data ?? []))
      .catch(() => undefined);
  }, [loadTimeline]);
  const recordMovement = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/ops/hcm/movements', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: id,
          positionId: Number(movementPositionId),
          movementType,
          effectiveFrom: movementEffective,
          salary: movementSalary ? Number(movementSalary) : null,
          reason: movementReason.trim() || undefined,
        }),
      });
      setNotice('Movement recorded');
      setMovementPositionId('');
      setMovementEffective('');
      setMovementSalary('');
      setMovementReason('');
      load();
      loadTimeline();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening employee…" />;
  const e = doc.employee as Rec;
  const act = async (path: string, body: Rec = {}, ok = 'Done') => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(ok);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  const prepareSettlement = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: { finalSettlementId: number } }>(`/api/ops/hr/employees/${id}/final-settlement`, { method: 'POST', body: '{}' });
      navigate(`/people/final-settlements/${r.data.finalSettlementId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  const openContractDoc = async (contract: Rec, format: 'pdf' | 'print') => {
    setDocBusy(String(contract.id) + format); setError('');
    try {
      await openDocument('employment-contract', contract.id, format, String(contract.contractNo ?? 'contract') + '.pdf');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setDocBusy(''); }
  };
  const openPayslipDoc = async (slip: Rec, format: 'pdf' | 'print') => {
    setDocBusy('slip-' + String(slip.id) + format); setError('');
    try {
      await openDocument('payslip', slip.id, format, String(slip.payslipNo ?? 'payslip') + '.pdf');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setDocBusy(''); }
  };
  const contracts = (doc.contracts as Rec[]) ?? [];
  const leaveRows = (doc.leave as Rec[]) ?? [];
  const slips = (doc.payslips as Rec[]) ?? [];
  const currentContract = contracts.find((c) => ['EXECUTED', 'ACTIVE', 'VARIED', 'RENEWED'].includes(String(c.status ?? ''))) ?? contracts[0] ?? null;
  const fullName = String(e.firstName ?? '') + ' ' + String(e.lastName ?? '');
  const terminated = String(e.status) === 'TERMINATED';
  const hasPhoto = Boolean(doc.hasPhoto || e.photoPath);
  const attachPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', 'PASSPORT');
      await api(`/api/ops/hr/employees/${id}/photo`, { method: 'POST', body: fd });
      setNotice('Passport photograph attached. It will print on the employment contract.');
      setPhotoRev((n) => n + 1);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  const tabs: Array<[string, string]> = [
    ['overview', 'Overview'],
    ['contracts', 'Contracts (' + contracts.length + ')'],
    ['leave', 'Leave'],
    ['pay', 'Pay'],
    ['career', 'Career'],
  ];
  return (
    <div className="page">
      <div className="emp-hero">
        <div className="photo-attach">
          <StaffPhoto path={'/api/ops/hr/employees/' + id + '/photo?r=' + photoRev} hasPhoto={hasPhoto} name={fullName} size={86} />
          {can(user, 'hr.employees.update') && (
            <label className="btn btn-sm">
              {hasPhoto ? 'Change photo' : 'Attach passport photo'}
              <input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" hidden disabled={busy} onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; void attachPhoto(f); }} />
            </label>
          )}
        </div>
        <div className="emp-hero-copy">
          <p className="mod-kicker" data-mod="hr" style={{ marginBottom: 6 }}>Employee file</p>
          <h1>{fullName}</h1>
          <p>{String(e.position ?? 'No position')} · {String(e.departmentName ?? 'No department')}</p>
          <div className="emp-hero-facts">
            <div><span className="emp-hero-k">Employee no</span><span className="emp-hero-v cell-mono">{String(e.employeeNo)}</span></div>
            <div><span className="emp-hero-k">Status</span><span className="emp-hero-v"><Badge value={e.status} /></span></div>
            <div><span className="emp-hero-k">Basic salary</span><span className="emp-hero-v">{fmtMoney(e.baseSalary)}</span></div>
            <div><span className="emp-hero-k">Hire date</span><span className="emp-hero-v">{shortDate(e.hireDate)}</span></div>
            <div><span className="emp-hero-k">Current contract</span><span className="emp-hero-v">{currentContract ? String(currentContract.contractNo) : 'None on file'}</span></div>
            <div><span className="emp-hero-k">ERP login</span><span className="emp-hero-v">{doc.account ? String((doc.account as Rec).username || (doc.account as Rec).email) : 'Not linked'}</span></div>
          </div>
        </div>
        <div className="emp-hero-actions">
          <button className="btn btn-sm" onClick={() => navigate('/people/employees')}>All employees</button>
          {can(user, 'hr.attendance.create') && !terminated && (
            <>
              <button className="btn" disabled={busy} onClick={() => act(`/api/ops/hr/employees/${id}/clock-in`, {}, 'Clocked in')}>Clock in</button>
              <button className="btn" disabled={busy} onClick={() => act(`/api/ops/hr/employees/${id}/clock-out`, {}, 'Clocked out')}>Clock out</button>
            </>
          )}
          {can(user, 'hr.contracts.create') && !terminated && (
            <button className="btn btn-primary" onClick={() => navigate('/people/contracts/new', { query: { employee: id } })}>New contract</button>
          )}
          {can(user, 'hr.employees.update') && (
            <button className="btn" onClick={() => navigate(`/people/employees/${id}/edit`)}>Edit details</button>
          )}
          {can(user, 'hr.employees.terminate') && !terminated && (
            <button className="btn btn-warning" disabled={busy} onClick={() => {
              if (window.confirm('Terminate ' + fullName + '?')) act(`/api/ops/hr/employees/${id}/terminate`, {}, 'Terminated');
            }}>Terminate</button>
          )}
          {can(user, 'hr.final_settlements.create') && terminated && (
            <button className="btn btn-primary" disabled={busy} onClick={() => {
              if (window.confirm('Prepare final settlement for ' + fullName + '?')) prepareSettlement();
            }}>Final settlement</button>
          )}
        </div>
      </div>
      {notice && <div className="callout callout-success"><span className="callout-icon" aria-hidden>✓</span><div className="callout-body"><p>{notice}</p></div></div>}
      {error && <ErrorBanner error={error} />}
      <div className="tabs" style={{ marginBottom: 12 }}>
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'overview' && (
        <div className="desk-panel people-split">
          <section className="card card-pad">
            <div className="def-sec-head"><span className="def-sec-icon" aria-hidden>📄</span><div><h3>Employment</h3><p>Active terms at a glance.</p></div></div>
            {currentContract ? (
              <dl className="def-list">
                <div><dt>Contract</dt><dd className="cell-mono">{String(currentContract.contractNo)}</dd></div>
                <div><dt>Type</dt><dd><Badge value={currentContract.contractType} /></dd></div>
                <div><dt>Status</dt><dd><Badge value={currentContract.status} /></dd></div>
                <div><dt>Start</dt><dd>{shortDate(currentContract.startDate)}</dd></div>
                <div><dt>End</dt><dd>{currentContract.endDate ? shortDate(currentContract.endDate) : 'Open'}</dd></div>
              </dl>
            ) : (
              <EmptyState icon="📄" title="No contract on file" hint="Draft one so leave, payroll and print have a legal base.">
                {can(user, 'hr.contracts.create') && !terminated && <button className="btn btn-primary btn-sm" onClick={() => navigate('/people/contracts/new', { query: { employee: id } })}>New contract</button>}
              </EmptyState>
            )}
            {currentContract && (
              <div className="action-group" style={{ marginTop: 12 }}>
                <button className="btn btn-sm" onClick={() => navigate('/people/contracts/' + String(currentContract.id))}>Open</button>
                {can(user, 'hr.contracts.view') && (
                  <>
                    <button className="btn btn-sm" disabled={Boolean(docBusy)} onClick={() => openContractDoc(currentContract, 'print')}>Print</button>
                    <button className="btn btn-sm" disabled={Boolean(docBusy)} onClick={() => openContractDoc(currentContract, 'pdf')}>PDF</button>
                  </>
                )}
              </div>
            )}
          </section>
          <section className="card card-pad">
            <div className="def-sec-head"><span className="def-sec-icon" aria-hidden>🔐</span><div><h3>ERP user account</h3><p>Login used for approvals, self-service and the desk.</p></div></div>
            <UserAccountLink employeeId={id} account={(doc.account ?? null) as Rec | null} matches={(doc.accountMatches as Rec[]) ?? []} canEdit={can(user, 'hr.employees.update')} onChanged={load} />
          </section>
          <section className="card card-pad">
            <div className="def-sec-head"><span className="def-sec-icon" aria-hidden>⚡</span><div><h3>Now</h3><p>What needs a decision on this file.</p></div></div>
            <dl className="def-list">
              <div><dt>Leave waiting</dt><dd>{fmtNum(leaveRows.filter((r) => String(r.status) === 'SUBMITTED').length)}</dd></div>
              <div><dt>Contracts</dt><dd>{fmtNum(contracts.length)}</dd></div>
              <div><dt>Payslips</dt><dd>{fmtNum(slips.length)}</dd></div>
              <div><dt>Timeline</dt><dd>{fmtNum(timeline.length)} events</dd></div>
            </dl>
          </section>
        </div>
      )}
      {tab === 'contracts' && (
        <section className="card desk-panel">
          <div className="card-head">
            <h3>Employment contracts</h3>
            {can(user, 'hr.contracts.create') && !terminated && (
              <button className="btn btn-sm btn-primary" onClick={() => navigate('/people/contracts/new', { query: { employee: id } })}>New contract</button>
            )}
          </div>
          {contracts.length === 0 ? (
            <div className="card-pad"><EmptyState icon="📄" title="No contracts on file" hint="Attach a written contract so print includes every clause." /></div>
          ) : (
            <div className="doc-card-list">
              {contracts.map((r) => (
                <article key={String(r.id)} className="doc-card">
                  <div className="doc-card-main">
                    <div className="doc-card-top">
                      <span className="cell-mono">{String(r.contractNo ?? '-')}</span>
                      <Badge value={r.contractType} />
                      <Badge value={r.status} />
                    </div>
                    <p className="doc-card-meta">
                      {shortDate(r.startDate)} → {r.endDate ? shortDate(r.endDate) : 'Open'}
                      {r.jobTitle ? ' · ' + String(r.jobTitle) : ''}
                      {r.version ? ' · v' + String(r.version) : ''}
                    </p>
                  </div>
                  <div className="action-group">
                    <button className="btn btn-sm" onClick={() => navigate('/people/contracts/' + String(r.id))}>Open</button>
                    {can(user, 'hr.contracts.view') && (
                      <>
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openContractDoc(r, 'print')}>{docBusy === String(r.id) + 'print' ? 'Printing…' : 'Print'}</button>
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openContractDoc(r, 'pdf')}>{docBusy === String(r.id) + 'pdf' ? 'Saving…' : 'PDF'}</button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      {tab === 'leave' && (
        <div className="desk-panel stack">
          {can(user, 'hr.leave.create') && !terminated && (
            <section className="card card-pad">
              <div className="def-sec-head"><span className="def-sec-icon" aria-hidden>⛱</span><div><h3>Request leave</h3><p>Annual leave posts to the approval queue.</p></div></div>
              <div className="form-grid" style={{ marginTop: 4 }}>
                <div className="field"><label>From</label><input type="date" value={leaveStart} onChange={(ev) => setLeaveStart(ev.target.value)} /></div>
                <div className="field"><label>To</label><input type="date" value={leaveEnd} onChange={(ev) => setLeaveEnd(ev.target.value)} /></div>
              </div>
              <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy || !leaveStart || !leaveEnd} onClick={() => act('/api/ops/hr/leave', { employeeId: id, startDate: leaveStart, endDate: leaveEnd, leaveType: 'ANNUAL' }, 'Leave submitted')}>Submit leave</button>
            </section>
          )}
          <section className="card">
            <div className="card-head"><h3>Leave history</h3></div>
            {leaveRows.length === 0 ? (
              <div className="card-pad"><EmptyState icon="⛱" title="No leave recorded" hint="Approved and pending requests appear here." /></div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Type</th><th>From</th><th>To</th><th>Status</th></tr></thead>
                  <tbody>
                    {leaveRows.map((r) => (
                      <tr key={String(r.id)}>
                        <td><Badge value={r.leaveType} /></td>
                        <td>{shortDate(r.startDate)}</td>
                        <td>{shortDate(r.endDate)}</td>
                        <td><Badge value={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
      {tab === 'pay' && (
        <div className="desk-panel stack">
          {can(user, 'hr.loans.create') && !terminated && (
            <section className="card card-pad">
              <div className="def-sec-head"><span className="def-sec-icon" aria-hidden>▣</span><div><h3>Staff loan</h3><p>Monthly deduction on the next payroll.</p></div></div>
              <div className="form-grid" style={{ marginTop: 4 }}>
                <div className="field"><label>Amount</label><input inputMode="decimal" value={loanAmt} onChange={(ev) => setLoanAmt(ev.target.value)} /></div>
                <div className="field"><label>Monthly deduction</label><input inputMode="decimal" value={loanDed} onChange={(ev) => setLoanDed(ev.target.value)} /></div>
              </div>
              <button className="btn" style={{ marginTop: 10 }} disabled={busy} onClick={() => act(`/api/ops/hr/employees/${id}/loans`, { amount: Number(loanAmt), monthlyDeduction: Number(loanDed) }, 'Loan booked')}>Book loan</button>
            </section>
          )}
          <section className="card">
            <div className="card-head"><h3>Payslips</h3></div>
            {slips.length === 0 ? (
              <div className="card-pad"><EmptyState icon="₴" title="No slips yet" hint="Slips appear after a payroll run is calculated. Print or save PDF from each slip." /></div>
            ) : (
              <div className="doc-card-list">
                {slips.map((r) => (
                  <article key={String(r.id)} className="doc-card">
                    <div className="doc-card-main">
                      <div className="doc-card-top">
                        <span className="cell-mono">{String(r.payslipNo ?? '-')}</span>
                        {r.status ? <Badge value={r.status} /> : null}
                      </div>
                      <p className="doc-card-meta">
                        {String(r.payrollNo ?? 'Payroll')}
                        {r.periodStart ? ' · ' + shortDate(r.periodStart) + ' to ' + shortDate(r.periodEnd) : ''}
                        {' · Gross ' + fmtMoney(r.grossPay) + ' · Net ' + fmtMoney(r.netPay)}
                      </p>
                    </div>
                    {can(user, 'hr.payslips.view') && (
                      <div className="action-group">
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openPayslipDoc(r, 'print')}>{docBusy === 'slip-' + String(r.id) + 'print' ? 'Printing…' : 'Print'}</button>
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openPayslipDoc(r, 'pdf')}>{docBusy === 'slip-' + String(r.id) + 'pdf' ? 'Saving…' : 'PDF'}</button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      {tab === 'career' && (
        <div className="desk-panel stack">
          {can(user, 'hr.employees.update') && !terminated && (
            <section className="card card-pad">
              <div className="def-sec-head"><span className="def-sec-icon" aria-hidden>↕</span><div><h3>Record movement</h3><p>Transfer, promotion or secondment from an effective date.</p></div></div>
              <div className="form-grid" style={{ marginTop: 4 }}>
                <div className="field field-required"><label>Movement type</label>
                  <select value={movementType} onChange={(ev) => setMovementType(ev.target.value)}>
                    <option value="TRANSFER">Transfer</option>
                    <option value="PROMOTION">Promotion</option>
                    <option value="DEMOTION">Demotion</option>
                    <option value="ROTATION">Rotation</option>
                    <option value="SECONDMENT">Secondment</option>
                  </select>
                </div>
                <div className="field field-required"><label>New position</label>
                  <select value={movementPositionId} onChange={(ev) => setMovementPositionId(ev.target.value)}>
                    <option value="">Select position</option>
                    {positions.map((p) => (
                      <option key={String(p.id)} value={String(p.id)}>{String(p.code)} · {String(p.title)}</option>
                    ))}
                  </select>
                </div>
                <div className="field field-required"><label>Effective date</label><input type="date" value={movementEffective} onChange={(ev) => setMovementEffective(ev.target.value)} /></div>
                <div className="field"><label>New salary (UGX)</label><input inputMode="decimal" value={movementSalary} onChange={(ev) => setMovementSalary(ev.target.value)} placeholder="Blank keeps current salary" /></div>
                <div className="field"><label>Reason</label><input value={movementReason} onChange={(ev) => setMovementReason(ev.target.value)} placeholder="e.g. Promoted to Production Supervisor" /></div>
              </div>
              <button className="btn" style={{ marginTop: 10 }} disabled={busy || !movementPositionId || !movementEffective} onClick={recordMovement}>Record movement</button>
            </section>
          )}
          <section className="card">
            <div className="card-head"><h3>Lifecycle</h3><span className="muted">{fmtNum(timeline.length)} events</span></div>
            {timeline.length === 0 ? (
              <div className="card-pad"><EmptyState icon="●" title="No events yet" hint="Hire, contract, leave and payroll events collect here." /></div>
            ) : (
              <ul className="time-rail">
                {timeline.slice().sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1)).map((ev) => (
                  <li key={`${String(ev.eventType)}-${String(ev.entityId)}-${String(ev.date)}`}>
                    <span className="time-dot" aria-hidden />
                    <span className="time-date">{shortDate(ev.date)}</span>
                    <div className="time-body">
                      <strong>{String(ev.title)}</strong>
                      <span>{String(ev.entityType).replace(/_/g, ' ')}{ev.entityCode ? ' · ' + String(ev.entityCode) : ''}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function EmployeeEditor({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [depts, setDepts] = useState<Rec[]>([]);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [position, setPosition] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [baseSalary, setBaseSalary] = useState('');
  const [salaryType, setSalaryType] = useState('MONTHLY');
  const [hireDate, setHireDate] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [tin, setTin] = useState('');
  const [nssfNo, setNssfNo] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAccountNo, setBankAccountNo] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([
      api<{ data: Rec[] }>('/api/ops/hr/departments'),
      api<{ data: Rec }>(`/api/ops/hr/employees/${id}`),
    ])
      .then(([deptRes, empRes]) => {
        setDepts(deptRes.data ?? []);
        const e = empRes.data.employee as Rec;
        setDoc(empRes.data);
        setFirstName(String(e.firstName ?? ''));
        setLastName(String(e.lastName ?? ''));
        setPosition(String(e.position ?? ''));
        setDepartmentId(e.departmentId != null ? String(e.departmentId) : '');
        setBaseSalary(e.baseSalary != null ? String(e.baseSalary) : '');
        setSalaryType(String(e.salaryType ?? 'MONTHLY'));
        setHireDate(String(e.hireDate ?? '').slice(0, 10));
        setEmail(String(e.email ?? ''));
        setPhone(String(e.phone ?? ''));
        setTin(String(e.tin ?? ''));
        setNssfNo(String(e.nssfNo ?? ''));
        setBankName(String(e.bankName ?? ''));
        setBankAccountNo(String(e.bankAccountNo ?? ''));
        setStatus(String(e.status ?? 'ACTIVE'));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Employee failed'));
  }, [id]);
  const canEdit = can(user, 'hr.employees.update');
  const save = async () => {
    if (!firstName.trim() || !lastName.trim()) { setError('First and last name are required'); return; }
    setBusy(true); setError('');
    try {
      await api(`/api/ops/hr/employees/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName, lastName,
          position: position.trim() || null,
          departmentId: departmentId ? Number(departmentId) : null,
          baseSalary: baseSalary ? Number(baseSalary) : 0,
          salaryType,
          hireDate: hireDate || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          tin: tin.trim() || null,
          nssfNo: nssfNo.trim() || null,
          bankName: bankName.trim() || null,
          bankAccountNo: bankAccountNo.trim() || null,
          status,
        }),
      });
      navigate(`/people/employees/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening employee..." />;
  const e = doc.employee as Rec;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate(`/people/employees/${id}`)}>Back</button>
          <p className="mod-kicker" data-mod="hr">Employee file</p>
          <h1>Edit {String(e.firstName)} {String(e.lastName)}</h1>
        </div>
      </header>
      {!canEdit && <ErrorBanner error={new Error('You need the HR employee update permission to edit this record.')} />}
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required"><label>First name</label><input value={firstName} onChange={(ev) => setFirstName(ev.target.value)} /></div>
          <div className="field field-required"><label>Last name</label><input value={lastName} onChange={(ev) => setLastName(ev.target.value)} /></div>
          <div className="field"><label>Position</label><input value={position} onChange={(ev) => setPosition(ev.target.value)} /></div>
          <div className="field">
            <label>Department</label>
            <select value={departmentId} onChange={(ev) => setDepartmentId(ev.target.value)}>
              <option value="">-</option>
              {depts.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.code)} - {String(d.name)}</option>)}
            </select>
          </div>
          <div className="field"><label>Hire date</label><input type="date" value={hireDate} onChange={(ev) => setHireDate(ev.target.value)} /></div>
          <div className="field">
            <label>Salary type</label>
            <select value={salaryType} onChange={(ev) => setSalaryType(ev.target.value)}>
              <option value="MONTHLY">Monthly</option>
              <option value="HOURLY">Hourly</option>
              <option value="COMMISSION">Commission</option>
            </select>
          </div>
          <div className="field"><label>Basic pay</label><input inputMode="decimal" value={baseSalary} onChange={(ev) => setBaseSalary(ev.target.value)} /></div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(ev) => setStatus(ev.target.value)}>
              <option value="ACTIVE">Active</option>
              <option value="PROBATION">Probation</option>
              <option value="ON_LEAVE">On leave</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>
          <div className="field"><label>Work email</label><input type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} /></div>
          <div className="field"><label>Phone</label><input value={phone} onChange={(ev) => setPhone(ev.target.value)} /></div>
          <div className="field"><label>TIN</label><input value={tin} onChange={(ev) => setTin(ev.target.value)} /></div>
          <div className="field"><label>NSSF no</label><input value={nssfNo} onChange={(ev) => setNssfNo(ev.target.value)} /></div>
          <div className="field"><label>Bank</label><input value={bankName} onChange={(ev) => setBankName(ev.target.value)} /></div>
          <div className="field"><label>Account no</label><input value={bankAccountNo} onChange={(ev) => setBankAccountNo(ev.target.value)} /></div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy || !canEdit} onClick={save}>Save changes</button>
      </section>
    </div>
  );
}

function EmployeeComposer() {
  const [depts, setDepts] = useState<Rec[]>([]);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [position, setPosition] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [baseSalary, setBaseSalary] = useState('1500000');
  const [email, setEmail] = useState('');
  const [userId, setUserId] = useState('');
  const [userQ, setUserQ] = useState('');
  const [userHits, setUserHits] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hr/departments').then((r) => setDepts(r.data ?? [])).catch(() => undefined);
  }, []);
  const searchUsers = async () => {
    if (!userQ.trim()) { setUserHits([]); return; }
    try {
      const r = await api<{ data: Rec[] }>(`/api/ops/hr/directory/users?unlinked=1&q=${encodeURIComponent(userQ.trim())}`);
      setUserHits(r.data ?? []);
    } catch {
      setUserHits([]);
    }
  };
  const save = async () => {
    if (!firstName.trim() || !lastName.trim()) { setError('Name is required'); return; }
    setBusy(true); setError('');
    try {
      const r = await api<{ data: { employeeId: number } }>('/api/ops/hr/employees', {
        method: 'POST',
        body: JSON.stringify({
          firstName, lastName, position, departmentId: departmentId ? Number(departmentId) : null,
          baseSalary: Number(baseSalary) || 0,
          email: email.trim() || null,
          userId: userId ? Number(userId) : null,
        }),
      });
      navigate(`/people/employees/${r.data.employeeId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const picked = userHits.find((u) => String(u.id) === userId);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/employees')}>Back</button>
          <h1>New employee</h1>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required"><label>First name</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></div>
          <div className="field field-required"><label>Last name</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} /></div>
          <div className="field"><label>Position</label><input value={position} onChange={(e) => setPosition(e.target.value)} /></div>
          <div className="field">
            <label>Department</label>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">—</option>
              {depts.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.code)} · {String(d.name)}</option>)}
            </select>
          </div>
          <div className="field field-required"><label>Monthly basic</label><input inputMode="decimal" value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} /></div>
          <div className="field"><label>Work email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Used to match an existing ERP login" /></div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>ERP user account</label>
          <p className="muted">Optional. Link an existing login now, or match later by the same email.</p>
          {userId && picked ? (
            <p>
              <span className="cell-mono">{String(picked.username || picked.email)}</span>
              {' '}<button type="button" className="btn btn-sm" onClick={() => { setUserId(''); setUserHits([]); setUserQ(''); }}>Clear</button>
            </p>
          ) : (
            <div className="toolbar">
              <input className="search-input" value={userQ} onChange={(e) => setUserQ(e.target.value)} placeholder="Search username or email" onKeyDown={(ev) => { if (ev.key === 'Enter') void searchUsers(); }} />
              <button type="button" className="btn btn-sm" onClick={() => void searchUsers()}>Search</button>
            </div>
          )}
          {!userId && userHits.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="data">
                <tbody>
                  {userHits.map((row) => (
                    <tr key={String(row.id)}>
                      <td className="cell-mono">{String(row.username ?? '')}</td>
                      <td>{String(row.email ?? '')}</td>
                      <td><button type="button" className="btn btn-sm" onClick={() => setUserId(String(row.id))}>Link</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={save}>Save employee</button>
      </section>
    </div>
  );
}

function LeaveDesk({ path }: { path: string }) {
  return <LeaveFlow path={path} />;
}

function AttendanceDesk() {
  const [data, setData] = useState<{ workDate: string; rows: Rec[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: { workDate: string; rows: Rec[] } }>('/api/ops/hr/attendance')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Attendance failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening attendance…" />;
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

function PayrollList() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hr/payrolls').then((r) => setRows(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'Payrolls failed'));
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="hr">Payroll</p>
          <h1>Runs</h1>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/people/payrolls/new')}>New payroll</button>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Run</th><th>Period</th><th>Status</th><th className="cell-num">Ready</th><th className="cell-num">Gross</th><th className="cell-num">Deductions</th><th className="cell-num">Net</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/payrolls/${r.id}`)}>
                <td className="cell-mono">{String(r.payrollNo)}</td>
                <td>{String(r.periodStart).slice(0, 10)} – {String(r.periodEnd).slice(0, 10)}</td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{r.validationScore == null ? '-' : `${String(r.validationScore)}%`}</td>
                <td className="cell-num">{fmtMoney(r.grossTotal)}</td>
                <td className="cell-num">{fmtMoney(r.deductionTotal)}</td>
                <td className="cell-num">{fmtMoney(r.netTotal)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No payrolls.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PayrollDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ payroll: Rec; items: Rec[]; exceptions: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [docBusy, setDocBusy] = useState('');
  const load = useCallback(() => {
    api<{ data: { payroll: Rec; items: Rec[]; exceptions: Rec[] } }>(`/api/ops/hr/payrolls/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Payroll failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening payroll…" />;
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
      const r = await api<{ data: { validationScore: number; errors: number; warnings: number; ready: boolean } }>(`/api/ops/hr/payrolls/${id}/validate`, { method: 'POST', body: '{}' });
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
  const openRegisterDoc = async (format: DocFormat) => {
    setDocBusy('register' + format); setError('');
    try {
      await openDocument('payroll-register', id, format, `payroll_${String(p.payrollNo ?? id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setDocBusy(''); }
  };
  const canPrintSlips = can(user, 'hr.payslips.view');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/payrolls')}>Back</button>
          <h1>Payroll <span className="cell-mono">{String(p.payrollNo)}</span></h1>
          <p className="muted">{String(p.periodStart).slice(0, 10)} – {String(p.periodEnd).slice(0, 10)}</p>
        </div>
        <Badge value={p.status} />
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Gross</span><span className="kpi-value">{fmtMoney(p.grossTotal)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Deductions</span><span className="kpi-value">{fmtMoney(p.deductionTotal)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Net</span><span className="kpi-value">{fmtMoney(p.netTotal)}</span></div>
        <div className="kpi-card"><span className="kpi-label">GL</span><span className="kpi-value">{p.glPosted ? 'Posted' : 'Open'}</span></div>
        <div className="kpi-card"><span className="kpi-label">Readiness</span><span className="kpi-value">{p.validationScore == null ? '-' : `${String(p.validationScore)}%`}</span></div>
      </div>
      <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {['DRAFT', 'SUBMITTED'].includes(String(p.status)) && can(user, 'hr.payrolls.update') && (
          <button className="btn" disabled={busy} onClick={() => act(`/api/ops/hr/payrolls/${id}/calculate`, 'Recalculated')}>Recalculate</button>
        )}
        {['DRAFT', 'SUBMITTED'].includes(String(p.status)) && can(user, 'hr.payrolls.update') && (
          <button className="btn" disabled={busy} onClick={runValidate}>Validate</button>
        )}
        {String(p.status) === 'DRAFT' && can(user, 'hr.payrolls.submit') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(`/api/ops/hr/payrolls/${id}/submit`, 'Submitted for approval')}>Submit</button>
        )}
        {['APPROVED', 'RELEASED'].includes(String(p.status)) && !p.glPosted && can(user, 'hr.payrolls.post') && (
          <button className="btn btn-success" disabled={busy} onClick={() => act(`/api/ops/hr/payrolls/${id}/post`, 'Posted to the ledger')}>Post to ledger</button>
        )}
        {['APPROVED', 'RELEASED'].includes(String(p.status)) && can(user, 'hr.payrolls.update') && (
          <button className="btn" disabled={busy} onClick={() => act(`/api/ops/hr/payrolls/${id}/payment-batch`, 'Payment batch created')}>Create pay batch</button>
        )}
        {['APPROVED', 'RELEASED', 'PAID'].includes(String(p.status)) && can(user, 'hr.payrolls.post') && (
          <button className="btn" disabled={busy} onClick={() => act(`/api/ops/hr/payrolls/${id}/publish-payslips`, 'Payslips published')}>Publish slips</button>
        )}
        <button className="btn" onClick={() => navigate('/people/payments')}>Pay batches</button>
        <button className="btn" onClick={() => navigate('/inbox')}>Approvals inbox</button>
        <button className="btn" onClick={() => navigate('/finance/journals')}>Journals</button>
      </div>
      <section className="card">
        <div className="card-head">
  <h3>Slips</h3>
  <div className="action-group">
    <span className="muted">Export register:</span>
    <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openRegisterDoc('pdf')}>{docBusy === 'registerpdf' ? 'Saving…' : 'PDF'}</button>
    <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openRegisterDoc('xlsx')}>{docBusy === 'registerxlsx' ? 'Saving…' : 'Excel'}</button>
    <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openRegisterDoc('csv')}>{docBusy === 'registercsv' ? 'Saving…' : 'CSV'}</button>
    <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openRegisterDoc('json')}>{docBusy === 'registerjson' ? 'Saving…' : 'JSON'}</button>
    <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openRegisterDoc('print')}>{docBusy === 'registerprint' ? 'Opening…' : 'Print'}</button>
  </div>
</div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Employee</th><th className="cell-num">Basic</th><th className="cell-num">Allow.</th><th className="cell-num">Gross</th><th className="cell-num">PAYE</th><th className="cell-num">NSSF</th><th className="cell-num">Loans</th><th className="cell-num">Net</th>{canPrintSlips ? <th></th> : null}</tr></thead>
            <tbody>
              {doc.items.map((i) => (
                <tr key={String(i.id)}>
                  <td>{String(i.firstName)} {String(i.lastName)} <span className="cell-mono">{String(i.employeeNo)}</span></td>
                  <td className="cell-num">{fmtMoney(i.basicPay)}</td>
                  <td className="cell-num">{fmtMoney(i.allowances)}</td>
                  <td className="cell-num">{fmtMoney(i.grossPay)}</td>
                  <td className="cell-num">{fmtMoney(i.paye)}</td>
                  <td className="cell-num">{fmtMoney(i.nssf)}</td>
                  <td className="cell-num">{fmtMoney(i.loans)}</td>
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
      {Number(p.id) === AUG2026_REFERENCE_RUN_ID && <PayrollAugustReference />}
    </div>
  );
}

const AUG2026_REFERENCE_RUN_ID = 632;

const AUG2026_NSSF = [
  { label: 'Employee NSSF', rate: '5%' },
  { label: 'Employer NSSF', rate: '10%' },
];

const AUG2026_PAYE = [
  { band: 'UGX 0 to 335,000', tax: '0' },
  { band: 'UGX 335,001 to 410,000', tax: '10% of the amount exceeding UGX 335,000' },
  { band: 'UGX 410,001 to 485,000', tax: 'UGX 7,500 + 25% of the amount exceeding UGX 410,000' },
  { band: 'UGX 485,001 to 10,000,000', tax: 'UGX 26,250 + 30% of the amount exceeding UGX 485,000' },
  { band: 'Above UGX 10,000,000', tax: 'UGX 2,880,750 + 10% of the amount exceeding UGX 10,000,000' },
];

const AUG2026_LST = [
  { band: '100,001 - 200,000', annual: 5000 },
  { band: '200,001 - 300,000', annual: 10000 },
  { band: '300,001 - 400,000', annual: 20000 },
  { band: '400,001 - 500,000', annual: 30000 },
  { band: '500,001 - 600,000', annual: 40000 },
  { band: '600,001 - 700,000', annual: 60000 },
  { band: '700,001 - 800,000', annual: 70000 },
  { band: '800,001 - 900,000', annual: 80000 },
  { band: '900,001 - 1,000,000', annual: 90000 },
  { band: 'Above 1,000,000', annual: 100000 },
];

const AUG2026_SUSPENSIONS = [
  { employee: 'Guillaume Niyonzima', reason: '10-day suspension (Sundays excluded)', salary: 1081923, workingDays: 26, dailyRate: 41612.42, daysAbsent: 10, deduction: 416124, adjusted: 665799 },
  { employee: 'Tabu Derrick', reason: '12 days absent (prorated on calendar-day basis, consistent with new starters)', salary: 369616, workingDays: 31, dailyRate: 11923.1, daysAbsent: 12, deduction: 143077, adjusted: 226539 },
];

const AUG2026_STARTERS = ['Emile Niyungeko', 'Gloria Nakakawa', 'Racheal Tagulwa', 'Lorraine Ninihazwe', 'Shamirah Nantume', 'Viola Akatikwasa'].map((name) => ({
  employee: name,
  reason: 'Started 12 Aug 2026 (pro-rated first month)',
  salary: 368846,
  calendarDays: 31,
  dailyRate: 11898.25806,
  daysWorked: 20,
  prorated: 237965,
}));

const refRate = (v: number) => v.toLocaleString('en-UG', { minimumFractionDigits: 2, maximumFractionDigits: 5 });

function PayrollAugustReference() {
  const company = useCompanyProfile();
  return (
    <>
      <section className="card">
        <div className="card-head"><h3>Statutory rates &amp; deductions - August 2026 reference</h3></div>
        <div className="card-pad">
          <p className="muted" style={{ marginTop: 0 }}>Rates and schedules applied to the August 2026 payroll for {company.name}.</p>
          <p className="kpi-label">NSSF</p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Contribution</th><th>Rate</th></tr></thead>
              <tbody>
                {AUG2026_NSSF.map((r) => (
                  <tr key={r.label}><td>{r.label}</td><td>{r.rate}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="kpi-label">Income tax (PAYE) - UGX</p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Monthly taxable income (UGX)</th><th>Tax</th></tr></thead>
              <tbody>
                {AUG2026_PAYE.map((r) => (
                  <tr key={r.band}><td>{r.band}</td><td>{r.tax}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="kpi-label">Local service tax (LST)</p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Monthly gross income (UGX)</th><th className="cell-num">Annual LST (UGX)</th></tr></thead>
              <tbody>
                {AUG2026_LST.map((r) => (
                  <tr key={r.band}><td>{r.band}</td><td className="cell-num">{fmtMoney(r.annual)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>Source: KCCA Local Service Tax (Assessment &amp; Payment) schedule, Local Governments Act Cap 243.</p>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Unpaid leave / suspension deductions - August</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>Employee</th>
              <th>Reason</th>
              <th className="cell-num">Full monthly basic</th>
              <th className="cell-num">Working days (Aug 2026, excl. Sundays)</th>
              <th className="cell-num">Daily rate</th>
              <th className="cell-num">Days absent</th>
              <th className="cell-num">Deduction</th>
              <th className="cell-num">Adjusted basic</th>
            </tr></thead>
            <tbody>
              {AUG2026_SUSPENSIONS.map((r) => (
                <tr key={r.employee}>
                  <td>{r.employee}</td>
                  <td className="muted">{r.reason}</td>
                  <td className="cell-num">{fmtMoney(r.salary)}</td>
                  <td className="cell-num">{fmtNum(r.workingDays)}</td>
                  <td className="cell-num">{refRate(r.dailyRate)}</td>
                  <td className="cell-num">{fmtNum(r.daysAbsent)}</td>
                  <td className="cell-num">{fmtMoney(r.deduction)}</td>
                  <td className="cell-num"><strong>{fmtMoney(r.adjusted)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-pad" style={{ paddingTop: 12 }}>
          <p className="muted" style={{ margin: 0 }}>Daily rate = full monthly Basic Salary &divide; 26 working days in August 2026 (31 calendar days less 5 Sundays: Aug 2, 9, 16, 23, 30). Transport allowance is not prorated. The deduction reduces Basic Salary only, so Gross Pay, NSSF, PAYEE and LST recalculate automatically from the lower base.</p>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>New starters - pro-rated pay - August</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>Employee</th>
              <th>Reason</th>
              <th className="cell-num">Full monthly basic</th>
              <th className="cell-num">Calendar days (Aug 2026)</th>
              <th className="cell-num">Daily rate</th>
              <th className="cell-num">Days worked (from 12 Aug)</th>
              <th className="cell-num">Prorated basic</th>
            </tr></thead>
            <tbody>
              {AUG2026_STARTERS.map((r) => (
                <tr key={r.employee}>
                  <td>{r.employee}</td>
                  <td className="muted">{r.reason}</td>
                  <td className="cell-num">{fmtMoney(r.salary)}</td>
                  <td className="cell-num">{fmtNum(r.calendarDays)}</td>
                  <td className="cell-num">{refRate(r.dailyRate)}</td>
                  <td className="cell-num">{fmtNum(r.daysWorked)}</td>
                  <td className="cell-num"><strong>{fmtMoney(r.prorated)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-pad" style={{ paddingTop: 12 }}>
          <p className="muted" style={{ margin: 0 }}>Daily rate = full monthly Basic Salary &divide; 31 calendar days in August 2026 (pro-rated on a calendar-day basis, not working days, since these employees started mid-month). Days worked = 12 Aug to 31 Aug inclusive = 20 days. Transport allowance is not prorated, consistent with the unpaid-leave deductions above.</p>
        </div>
      </section>
    </>
  );
}

function PayrollComposer() {
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
        body: JSON.stringify({ periodStart, periodEnd }),
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
          <p className="muted">Calculates PAYE (Uganda bands) and 5% NSSF for every active employee.</p>
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

function FinalSettlementList() {
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

function FinalSettlementDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [payMethod, setPayMethod] = useState('BANK_TRANSFER');
  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/hr/final-settlements/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Final settlement failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening settlement" />;
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
            if (window.confirm(`Approve ${String(s.settlementNo)}?`)) act(`/api/ops/hr/final-settlements/${id}/approve`, 'Approved');
          }}>Approve</button>
        )}
        {String(s.status) === 'PENDING' && can(user, 'hr.final_settlements.reject') && (
          <button className="btn" disabled={busy} onClick={() => act(`/api/ops/hr/final-settlements/${id}/reject`, 'Returned to draft')}>Reject</button>
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
              if (window.confirm(`Pay ${String(s.settlementNo)} ${fmtMoney(s.netPayable)}?`)) act(`/api/ops/hr/final-settlements/${id}/pay`, 'Paid', { paymentMethod: payMethod });
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
    </div>
  );
}

function ArrearsList() {
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

function ArrearsComposer() {
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

const OFFBOARDING_TYPES = ['RESIGNATION', 'TERMINATION', 'RETIREMENT', 'REDUNDANCY', 'END_OF_CONTRACT', 'TRANSFER', 'OTHER'];

function OffboardingList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: { rows: Rec[] } }>('/api/ops/hcm/offboardings?pageSize=100')
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Offboarding cases failed'));
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/hcm')}>Back</button>
          <p className="mod-kicker" data-mod="hr">HCM</p>
          <h1>Offboarding &amp; exits</h1>
          <p className="muted">Exit cases, clearance checklists and alumni records across the company.</p>
        </div>
        <div className="head-actions">
          {can(user, 'hr.offboardings.create') && <button className="btn btn-primary" onClick={() => navigate('/people/offboardings/new')}>New offboarding</button>}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Case</th><th>Employee</th><th>Type</th><th>Effective</th><th>Last working day</th><th>Employee status</th><th>Case status</th><th className="cell-num">Pending tasks</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/offboardings/${r.id}`)}>
                <td className="cell-mono">{String(r.instanceNo)}</td>
                <td>{String(r.firstName)} {String(r.lastName)} <span className="cell-mono">{String(r.employeeNo ?? '')}</span></td>
                <td><Badge value={r.offboardingType} /></td>
                <td>{String(r.effectiveDate ?? '').slice(0, 10) || '-'}</td>
                <td>{String(r.lastWorkingDate ?? '').slice(0, 10) || '-'}</td>
                <td><Badge value={r.employeeStatus} /></td>
                <td><Badge value={r.status} /></td>
                <td className="cell-num">{fmtNum(r.pendingTasks)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No offboarding cases yet. Start one for a resignation, termination, retirement or end of contract.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OffboardingComposer() {
  const today = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const [employeeId, setEmployeeId] = useState('');
  const [offboardingType, setOffboardingType] = useState('RESIGNATION');
  const [effectiveDate, setEffectiveDate] = useState(iso(today));
  const [lastWorkingDate, setLastWorkingDate] = useState('');
  const [reason, setReason] = useState('');
  const [finalSettlementRequired, setFinalSettlementRequired] = useState(true);
  const [notes, setNotes] = useState('');
  const [employees, setEmployees] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ data: { rows: Rec[] } }>('/api/ops/hr/employees?pageSize=100')
      .then((r) => setEmployees(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Employees failed'));
  }, []);
  const selectable = employees.filter((e) => ['ACTIVE', 'PROBATION', 'ON_LEAVE'].includes(String(e.status ?? '')));
  const valid = Boolean(employeeId) && Boolean(effectiveDate);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ data: Rec }>('/api/ops/hcm/offboardings', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: Number(employeeId),
          offboardingType,
          effectiveDate,
          lastWorkingDate: lastWorkingDate.trim() || undefined,
          reason: reason.trim() || undefined,
          finalSettlementRequired,
          notes: notes.trim() || undefined,
        }),
      });
      navigate(`/people/offboardings/${r.data.instanceId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/offboardings')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Offboarding</p>
          <h1>New offboarding case</h1>
          <p className="muted">Open an exit case with a clearance checklist. Nothing changes on the employee record until the case is completed.</p>
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
          {selectable.length === 0 && <p className="muted">No active employees available to offboard.</p>}
        </div>
        <div className="form-grid">
          <div className="field field-required"><label>Offboarding type</label>
            <select value={offboardingType} onChange={(e) => setOffboardingType(e.target.value)}>
              {OFFBOARDING_TYPES.map((t) => <option key={t} value={t}>{t.toLowerCase().replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div className="field field-required"><label>Effective date</label><input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} /></div>
          <div className="field"><label>Last working day</label><input type="date" value={lastWorkingDate} onChange={(e) => setLastWorkingDate(e.target.value)} /></div>
        </div>
        <div className="field"><label>Reason</label><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Voluntary resignation with one month notice" /></div>
        <div className="field"><label>Notes</label><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Handover notes, exit interview expectations" /></div>
        <div className="field"><label><input type="checkbox" checked={finalSettlementRequired} onChange={(e) => setFinalSettlementRequired(e.target.checked)} /> Final settlement required</label></div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy || !valid} onClick={save}>Create offboarding case</button>
      </section>
    </div>
  );
}

function OffboardingDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ instance: Rec; tasks: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState<number | null>(null);
  const [taskNotes, setTaskNotes] = useState<Rec>({});
  const [exitNotes, setExitNotes] = useState('');
  const [alumniDate, setAlumniDate] = useState('');
  const [rehireEligible, setRehireEligible] = useState(true);
  const load = useCallback(() => {
    api<{ data: { instance: Rec; tasks: Rec[] } }>(`/api/ops/hcm/offboardings/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Offboarding case failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening offboarding case" />;
  const s = doc.instance;
  const tasks = doc.tasks ?? [];
  const status = String(s.status);
  const pendingTasks = tasks.filter((t) => !['COMPLETED', 'WAIVED'].includes(String(t.status))).length;
  const act = async (path: string, ok: string, body: Rec = {}) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const completeTask = async (t: Rec, taskStatus: string) => {
    const taskId = Number(t.taskId);
    setTaskBusy(taskId); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(`/api/ops/hcm/offboardings/${id}/tasks/${taskId}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          status: taskStatus,
          notes: String(taskNotes[String(taskId)] ?? '').trim() || undefined,
        }),
      });
      setNotice(`${String(t.title)} ${r.data.status === 'WAIVED' ? 'waived' : 'completed'} - ${fmtNum(r.data.remaining)} task(s) pending.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setTaskBusy(null); }
  };
  const cancel = () => {
    const reason = window.prompt('Reason for cancelling this offboarding case?');
    if (reason === null) return;
    act(`/api/ops/hcm/offboardings/${id}/cancel`, 'Offboarding case cancelled.', { reason: reason.trim() || undefined });
  };
  const complete = () => {
    act(`/api/ops/hcm/offboardings/${id}/complete`, 'Offboarding completed - employee marked as exited.', {
      exitInterviewNotes: exitNotes.trim() || undefined,
      alumniDate: alumniDate || undefined,
      rehireEligible,
    });
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/people/offboardings')}>Back</button>
          <p className="mod-kicker" data-mod="hr">Offboarding</p>
          <h1>Case <span className="cell-mono">{String(s.instanceNo)}</span></h1>
          <p className="muted">{String(s.firstName)} {String(s.lastName)} <span className="cell-mono">{String(s.employeeNo)}</span> - {String(s.offboardingType ?? '').toLowerCase().replace(/_/g, ' ')}</p>
        </div>
        <Badge value={s.status} />
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Effective date</span><span className="kpi-value">{String(s.effectiveDate ?? '').slice(0, 10) || '-'}</span></div>
        <div className="kpi-card"><span className="kpi-label">Last working day</span><span className="kpi-value">{String(s.lastWorkingDate ?? '').slice(0, 10) || '-'}</span></div>
        <div className="kpi-card"><span className="kpi-label">Final settlement</span><span className="kpi-value">{s.finalSettlementRequired ? 'Yes' : 'No'}</span></div>
        <div className="kpi-card"><span className="kpi-label">Employee status</span><span className="kpi-value">{String(s.employeeStatus ?? '-')}</span></div>
      </div>
      <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {status === 'DRAFT' && can(user, 'hr.offboardings.start') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(`/api/ops/hcm/offboardings/${id}/start`, 'Offboarding started - clearance tasks are now open.')}>Start offboarding</button>
        )}
        {(status === 'DRAFT' || status === 'IN_PROGRESS') && can(user, 'hr.offboardings.cancel') && (
          <button className="btn" disabled={busy} onClick={cancel}>Cancel case</button>
        )}
      </div>
      <section className="card card-pad">
        <div className="card-head"><h3>Exit details</h3></div>
        <p><strong>Type:</strong> <Badge value={s.offboardingType} /></p>
        <p><strong>Reason:</strong> {String(s.reason ?? '-')}</p>
        <p><strong>Notes:</strong> {String(s.notes ?? '-')}</p>
        <p><strong>Checklist:</strong> {String(s.checklistName ?? '-')}</p>
      </section>
      <section className="card">
        <div className="card-head"><h3>Clearance checklist</h3><span className="muted">{fmtNum(pendingTasks)} pending</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Task</th><th>Category</th><th>Due</th><th>Required</th><th>Status</th><th>Completed</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={String(t.taskId)}>
                  <td><div className="cell-mono">{String(t.taskNo)}</div><strong>{String(t.title)}</strong>{t.description ? <div className="muted">{String(t.description)}</div> : null}</td>
                  <td>{String(t.category ?? '-')}</td>
                  <td className="cell-num">{t.dueDays != null ? `${fmtNum(t.dueDays)}d` : '-'}</td>
                  <td>{t.isRequired ? 'Yes' : 'No'}</td>
                  <td><Badge value={t.status} /></td>
                  <td>{t.completedAt ? `${String(t.completedBy ?? '')} ${String(t.completedAt).slice(0, 10)}` : '-'}</td>
                  <td>
                    {status === 'IN_PROGRESS' && !['COMPLETED', 'WAIVED'].includes(String(t.status)) && can(user, 'hr.offboardings.waive') ? (
                      <input type="text" style={{ minWidth: 150 }} placeholder="Notes (optional)" value={String(taskNotes[String(t.taskId)] ?? '')} onChange={(e) => setTaskNotes((prev) => ({ ...prev, [String(t.taskId)]: e.target.value }))} />
                    ) : (
                      <span className="muted">{String(t.notes ?? '-')}</span>
                    )}
                  </td>
                  <td>
                    {status === 'IN_PROGRESS' && !['COMPLETED', 'WAIVED'].includes(String(t.status)) && can(user, 'hr.offboardings.waive') ? (
                      <span className="row-actions">
                        <button className="btn btn-sm btn-success" disabled={taskBusy === Number(t.taskId)} onClick={() => completeTask(t, 'COMPLETED')}>Complete</button>
                        <button className="btn btn-sm" disabled={taskBusy === Number(t.taskId)} onClick={() => completeTask(t, 'WAIVED')}>Waive</button>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
              {tasks.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No clearance tasks on this checklist.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {status === 'IN_PROGRESS' && can(user, 'hr.offboardings.complete') && (
        <section className="card card-pad">
          <div className="card-head"><h3>Complete offboarding</h3></div>
          <p className="muted" style={{ marginBottom: 12 }}>{pendingTasks === 0 ? 'All clearance tasks are resolved. Complete the case to mark the employee as exited and update payroll-relevant status.' : `${pendingTasks} clearance task(s) still pending - complete or waive them before closing the case.`}</p>
          <div className="form-grid">
            <div className="field"><label>Alumni / exit date</label><input type="date" value={alumniDate || String(s.effectiveDate ?? '').slice(0, 10)} onChange={(e) => setAlumniDate(e.target.value)} /></div>
            <div className="field"><label><input type="checkbox" checked={rehireEligible} onChange={(e) => setRehireEligible(e.target.checked)} /> Rehire eligible</label></div>
          </div>
          <div className="field"><label>Exit interview notes</label><textarea rows={4} value={exitNotes} onChange={(e) => setExitNotes(e.target.value)} placeholder="Reason for leaving, feedback, recommendations (kept confidential)" /></div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={busy || pendingTasks > 0} onClick={complete}>Complete offboarding</button>
        </section>
      )}
    </div>
  );
}
