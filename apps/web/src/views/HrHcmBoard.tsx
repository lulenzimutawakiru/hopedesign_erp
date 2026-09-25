import { useEffect, useState } from 'react';
import { api, fmtMoney, fmtNum } from '../api';
import { navigate } from '../router';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { HrEmptyState as EmptyState, tileStyle } from '../components/hrUi';
import { type Rec } from './hrShared';

/**
 * HCM overview board — headcount, attrition, recruitment pipeline and
 * offboarding signals as KPI tiles plus drill-down sections. Lifted verbatim
 * from HrFlow so the flow file stops owning unrelated HCM presentation.
 */
export function HcmBoard() {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/hcm/dashboard')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'HCM dashboard failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader variant="page" label="Opening HCM overview..." />;
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
